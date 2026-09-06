// Tests for the multi-lane broadcaster's pure parts: tip planning and
// tip injection into an unsigned VersionedTransaction (no-ALT path — the
// ALT path needs a live RPC and falls back safely when it can't fetch).
import assert from 'node:assert/strict';
import { planTips, injectTips, injectTransfersFit, compileKeepingTransfersStatic, transferDestinationsStatic, broadcastAndConfirm, HELIUS_SWQOS_TIP_LAMPORTS, MAX_TX_BYTES } from './.broadcast.mjs';
import {
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from './.web3.mjs';

const floor = { p50Lamports: 10_000, p75Lamports: 120_000, p95Lamports: 900_000 };
const ok = (name) => console.log(`ok  ${name}`);

{
  const plan = planTips({ useJito: false, jitoTipPercentile: 75, useHeliusSender: true }, 'buy', floor, 1);
  assert.deepEqual(plan.lanes, ['rpc', 'helius-sender']);
  assert.equal(plan.tips.length, 1);
  assert.equal(plan.tips[0].lamports, HELIUS_SWQOS_TIP_LAMPORTS);
  ok('helius-only plan: rpc + sender lanes, 5000-lamport tip');
}

{
  const plan = planTips({ useJito: true, jitoTipPercentile: 75, useHeliusSender: true }, 'buy', floor, 2);
  assert.deepEqual(plan.lanes, ['rpc', 'helius-sender', 'jito']);
  assert.equal(plan.tips[1].lamports, 120_000); // buy uses the configured percentile
  assert.equal(plan.totalLamports, 120_000 + HELIUS_SWQOS_TIP_LAMPORTS);
  ok('jito buy plan uses configured percentile');
}

{
  const plan = planTips({ useJito: true, jitoTipPercentile: 50, useHeliusSender: false }, 'sell', floor, 3);
  assert.equal(plan.tips[0].lamports, 900_000); // sells always escalate to p95
  ok('sell escalates jito tip to p95');
}

{
  const spiked = { ...floor, p95Lamports: 50_000_000 }; // 0.05 SOL spike
  const plan = planTips({ useJito: true, jitoTipPercentile: 95, useHeliusSender: false }, 'sell', spiked, 4);
  assert.equal(plan.tips[0].lamports, 5_000_000); // capped at 0.005 SOL
  ok('jito tip capped so a p95 spike cannot eat the sell loss-bound');
}

{
  // Build a minimal unsigned v0 tx (no lookup tables), inject two tips, and
  // verify the rebuilt tx: same payer + blockhash, tips appended verbatim.
  const payer = Keypair.generate();
  const dest = Keypair.generate();
  const blockhash = '9zNcRnnvHoHZrHhTDVvXhhVMDgXBjjJzMPGfCHVoxxu6';
  const msg = MessageV0.compile({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest.publicKey, lamports: 42 }),
    ],
  });
  const unsigned = new VersionedTransaction(msg).serialize();
  const tips = [
    { to: '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', lamports: 5_000 },
    { to: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', lamports: 120_000 },
  ];
  const tipped = await injectTips(unsigned, payer.publicKey.toBase58(), tips, 'http://unused.invalid');
  assert.notEqual(tipped, null);
  const tx = VersionedTransaction.deserialize(tipped);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), payer.publicKey.toBase58());
  assert.equal(tx.message.recentBlockhash, blockhash);
  assert.equal(tx.message.compiledInstructions.length, 3);
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  // Both tip destinations present with correct lamports (u64 LE at offset 4
  // of a SystemProgram transfer's data).
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  for (const t of tips) {
    const idx = keys.indexOf(t.to);
    assert.ok(idx >= 0, `tip account ${t.to} missing`);
    const ix = tx.message.compiledInstructions.find((i) => i.accountKeyIndexes[1] === idx);
    assert.ok(ix, 'tip transfer instruction missing');
    assert.equal(new DataView(ix.data.buffer, ix.data.byteOffset + 4, 8).getBigUint64(0, true), BigInt(t.lamports));
  }
  ok('injectTips appends tip transfers, preserves payer/blockhash/signature count');
}

{
  const unsigned = new Uint8Array([1, 2, 3]); // garbage — must not throw
  const r = await injectTips(unsigned, 'not-a-key', [{ to: 'x', lamports: 1 }], 'http://unused.invalid');
  assert.equal(r, null);
  ok('injectTips returns null (not throw) on an undecodable tx');
}

// ── broadcastAndConfirm: expiry is decided by BLOCK HEIGHT, not a clock ──
//
// 2026-08: a fixed 55s clock declared buys "expired" while their blockhash
// (cached up to 20s + relayer backoff) was still valid, and they landed after
// the app had given up — lost to bookkeeping, and rebought. The RPC is a fake
// fetch here: sends are accepted, the signature never confirms, and the chain
// height advances per call. `expired` may only be true once the height has
// PASSED lastValidBlockHeight; stopping earlier (the absolute cap) is pending.

function fakeRpc({ startHeight, stepPerPoll, confirmAfterHeight = Infinity }) {
  let height = startHeight;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    calls.push(method);
    let result;
    if (method === 'sendTransaction') result = 'sig';
    else if (method === 'getBlockHeight') {
      height += stepPerPoll;
      result = height;
    } else if (method === 'getSignatureStatuses') {
      result = { value: [height > confirmAfterHeight ? { confirmationStatus: 'confirmed', err: null } : null] };
    } else result = null;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  return calls;
}
const realFetch = globalThis.fetch;
const common = { httpUrl: 'http://fake.invalid', base64: 'AA==', signature: 'sig', lanes: ['rpc'], heightPollMs: 0 };

{
  fakeRpc({ startHeight: 100, stepPerPoll: 30 });
  const r = await broadcastAndConfirm({ ...common, lastValidBlockHeight: 150, timeoutMs: 10_000 });
  assert.equal(r.landed, false);
  assert.equal(r.chainErr, false);
  assert.equal(r.expired, true, 'height 160 > 150 → the tx can never land → expired');
  ok('expired only once the chain height passes lastValidBlockHeight');
}

{
  const calls = fakeRpc({ startHeight: 100, stepPerPoll: 1 });
  const r = await broadcastAndConfirm({ ...common, lastValidBlockHeight: 10_000, timeoutMs: 1_500 });
  assert.equal(r.landed, false);
  assert.equal(r.expired, false, 'the cap hit first: the blockhash is still valid → PENDING, not expired');
  assert.ok(calls.includes('getBlockHeight'), 'the height must actually be polled');
  ok('absolute cap before expiry height → not expired (caller treats as pending)');
}

{
  // No expiry height known (legacy caller): the clock alone can only say
  // "stopped waiting", never "dead".
  const calls = fakeRpc({ startHeight: 100, stepPerPoll: 1000 });
  const r = await broadcastAndConfirm({ ...common, timeoutMs: 800 });
  assert.equal(r.expired, false);
  assert.ok(!calls.includes('getBlockHeight'), 'no height to compare against → no height polls');
  ok('without lastValidBlockHeight a timeout is never reported as expired');
}

{
  // Confirms in the same slot the height crosses — the final status read
  // must see it, or a landed trade would be booked as expired.
  fakeRpc({ startHeight: 100, stepPerPoll: 60, confirmAfterHeight: 150 });
  const r = await broadcastAndConfirm({ ...common, lastValidBlockHeight: 150, timeoutMs: 10_000 });
  assert.equal(r.landed, true);
  assert.equal(r.expired, false);
  ok('a tx that lands as the height crosses is reported landed, not expired');
}

globalThis.fetch = realFetch;

console.log('broadcast: all tests passed');

// ── Size-fitting injection (2026-08-29) ─────────────────────────────────
// A graduated-token relayer build is ~1140 bytes with 28 static accounts;
// appending our tips + fee overflowed the 1232-byte packet cap live. The
// injector must drop the least valuable transfers first and never fail the
// trade over size alone. No network: the bogus RPC makes the public-ALT
// fetch fail fast, which is the same as "no compression available".
{
  const { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const payer = Keypair.generate();
  // 27 distinct writable accounts in one instruction ≈ the pump-amm route.
  const keys = Array.from({ length: 27 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  const big = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys, data: Buffer.alloc(40, 7) });
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [big] }).compileToV0Message();
  const base = new VersionedTransaction(msg).serialize();
  assert.ok(base.length > 1000 && base.length <= MAX_TX_BYTES, `fixture must be near the cap, got ${base.length}`);
  const dest = () => Keypair.generate().publicKey.toBase58();
  const transfers = [
    { to: dest(), lamports: 250_000, priority: 0 }, // treasury
    { to: dest(), lamports: 100_000, priority: 1 }, // jito
    { to: dest(), lamports: 50_000, priority: 2 }, // referrer
    { to: dest(), lamports: 200_000, priority: 3 }, // helius
  ];
  const NO_RPC = 'http://127.0.0.1:9';
  const fit = await injectTransfersFit(base, payer.publicKey.toBase58(), transfers, NO_RPC);
  assert.ok(fit, 'must not fail over size');
  assert.ok(fit.tx.length <= MAX_TX_BYTES, `result ${fit.tx.length} over cap`);
  assert.ok(fit.dropped.length > 0, 'fixture should force at least one drop');
  // Drops go highest priority number first, and the treasury is last to go.
  const droppedPri = fit.dropped.map((t) => t.priority);
  assert.deepEqual(droppedPri, [...droppedPri].sort((a, b) => b - a));
  assert.ok(fit.kept.some((t) => t.priority === 0), 'the treasury fee survives while anything else can be dropped');
  ok(`over-cap tx keeps the treasury fee and drops ${droppedPri.join('+')} first (${base.length}B -> ${fit.tx.length}B)`);

  // The strict form (used by the legacy injectTips/injectTransfers) refuses instead.
  const strict = await injectTransfersFit(base, payer.publicKey.toBase58(), transfers, NO_RPC, false);
  assert.equal(strict, null);
  ok('allowDrop=false returns null instead of silently dropping');

  // Plenty of room: nothing is dropped and all four land.
  const small = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(dest()), lamports: 1 })] }).compileToV0Message()).serialize();
  const roomy = await injectTransfersFit(small, payer.publicKey.toBase58(), transfers, NO_RPC);
  assert.equal(roomy.dropped.length, 0);
  assert.equal(VersionedTransaction.deserialize(roomy.tx).message.compiledInstructions.length, 5);
  ok('a small tx takes every transfer, nothing dropped');
}

// ── Compression must never hide a transfer destination (2026-08-29) ─────
// PumpPortal's public lookup table contains their own fee wallet. Compiling
// against it compressed the AMM route's fee transfer into a table index, and
// the signer refused every graduated token. Size is worth less than a
// destination the signer can read.
{
  const { Keypair, SystemProgram, TransactionInstruction, TransactionMessage, AddressLookupTableAccount, VersionedTransaction } = await import('@solana/web3.js');
  const payer = Keypair.generate();
  const feeWallet = Keypair.generate().publicKey;
  const filler = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  const altKey = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: altKey,
    state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [feeWallet, ...filler] },
  });
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: feeWallet, lamports: 50_000 }),
      // Non-signer writable accounts: the only kind a lookup table can carry.
      new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: filler.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })), data: Buffer.alloc(1) }),
    ],
  });
  const naive = msg.compileToV0Message([table]);
  assert.equal(transferDestinationsStatic(naive), false, 'fixture: naive compile must hide the destination');
  const safe = compileKeepingTransfersStatic(msg, [], [table]);
  assert.equal(transferDestinationsStatic(safe), true);
  // The destination is masked out of the table; the table is still used for
  // everything else it covers.
  assert.equal(safe.addressTableLookups.length, 1, 'table still used for the other accounts');
  assert.equal(safe.addressTableLookups[0].writableIndexes.length + safe.addressTableLookups[0].readonlyIndexes.length, filler.length);
  new VersionedTransaction(safe).serialize();
  ok('a table containing a transfer destination is used with that entry masked static');

  // Same when it is the transaction's OWN table (the relayer's router builds
  // reference PumpPortal's table, which holds a Jito tip account).
  const ownOnly = compileKeepingTransfersStatic(msg, [table], []);
  assert.equal(transferDestinationsStatic(ownOnly), true);
  assert.equal(ownOnly.addressTableLookups.length, 1);
  ok('an OWN table that holds a transfer destination leaves it static too');

  // A table that only covers non-destination accounts is still used.
  const harmless = new AddressLookupTableAccount({ key: altKey, state: { ...table.state, addresses: filler } });
  const compressed = compileKeepingTransfersStatic(msg, [], [harmless]);
  assert.equal(transferDestinationsStatic(compressed), true);
  assert.equal(compressed.addressTableLookups.length, 1, 'harmless table is used for size');
  ok('a public table that leaves destinations static is used for compression');
}
