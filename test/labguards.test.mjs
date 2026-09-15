// Wallet Lab guards: the signer's 'fund' intent, and what the wallet-file
// parser does with settings from a build that had more features.
import assert from 'node:assert';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { checkOutflowForTest } from './.signpolicy.mjs';
import { parseFile } from './.walletstore.mjs';
import { planFanout } from './.fanout.mjs';

const me = Keypair.generate();
const a = Keypair.generate().publicKey.toBase58();
const b = Keypair.generate().publicKey.toBase58();
const stranger = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = '11111111111111111111111111111111';

function tx(instructions) {
  const msg = new TransactionMessage({ payerKey: me.publicKey, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}
const transfer = (to, lamports) => SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: new PublicKey(to), lamports });
const ME = me.publicKey.toBase58();

{
  const bytes = tx([transfer(a, 1_000_000), transfer(b, 1_000_000)]);
  const ok = checkOutflowForTest(bytes, ME, null, { intent: 'fund', maxTransferLamports: 2_000_000, fundTargets: [a, b] });
  assert.equal(ok.ok, true, ok.message);
  console.log('ok  fund: transfers to listed own wallets are accepted');
}
{
  const bytes = tx([transfer(a, 1_000_000), transfer(stranger, 1_000_000)]);
  const r = checkOutflowForTest(bytes, ME, null, { intent: 'fund', maxTransferLamports: 2_000_000, fundTargets: [a, b] });
  assert.equal(r.ok, false);
  assert.match(r.message, /neither your withdrawal address nor a known tip account|refusing/);
  console.log('ok  fund: a destination outside the allowlist is refused');
}
{
  const bytes = tx([transfer(a, 1_000_000)]);
  const r = checkOutflowForTest(bytes, ME, null, { intent: 'fund', maxTransferLamports: 1_000_000, fundTargets: [] });
  assert.equal(r.ok, false);
  assert.match(r.message, /explicit list/);
  console.log('ok  fund: an empty allowlist signs nothing');
}
{
  const bogus = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('hi') });
  const bytes = tx([transfer(a, 1_000_000), bogus]);
  const r = checkOutflowForTest(bytes, ME, null, { intent: 'fund', maxTransferLamports: 1_000_000, fundTargets: [a] });
  assert.equal(r.ok, false);
  assert.match(r.message, /only contain SystemProgram transfers/);
  console.log('ok  fund: any non-transfer instruction is refused');
}
{
  // The SPL Token branch used to run BEFORE the fund gate and could wave an
  // instruction through; the gate now decides first.
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const sync = new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: me.publicKey, isSigner: false, isWritable: true }], data: Buffer.from([17]) }); // SyncNative
  const bytes = tx([transfer(a, 1_000_000), sync]);
  const r = checkOutflowForTest(bytes, ME, null, { intent: 'fund', maxTransferLamports: 1_000_000, fundTargets: [a] });
  assert.equal(r.ok, false);
  assert.match(r.message, /only contain SystemProgram transfers/);
  console.log('ok  fund: a Token-program instruction is refused too');
}
{
  const bytes = tx([transfer(a, 3_000_000)]);
  const r = checkOutflowForTest(bytes, ME, null, { intent: 'fund', maxTransferLamports: 2_000_000, fundTargets: [a] });
  assert.equal(r.ok, false);
  assert.match(r.message, /over the/);
  console.log('ok  fund: the cap still applies');
}
{
  // A trade must not inherit fund permissions.
  const bytes = tx([transfer(a, 1_000_000)]);
  const r = checkOutflowForTest(bytes, ME, null, { intent: 'trade', maxTransferLamports: 2_000_000, fundTargets: [a] });
  assert.equal(r.ok, false, 'fundTargets means nothing outside intent fund');
  console.log('ok  fund: the allowlist is inert for other intents');
}

// ── parseFile drops a `lab` block written by an older build ──────────
{
  const now = Date.now();
  const raw = {
    version: 2,
    activeId: 'w1',
    wallets: [
      { id: 'w1', label: 'main', publicKey: ME, secretEnc: 'x', createdAt: now, maxBalanceSol: 1, homeAddress: null },
      { id: 'w2', label: 'two', publicKey: a, secretEnc: 'x', createdAt: now, maxBalanceSol: 1, homeAddress: null },
    ],
    groups: [
      { id: 'g1', name: 'Fleet', walletIds: ['w2'], lab: { follow: { enabled: true, ratio: 0.25 }, random: { maxLossSol: 0.02 } } },
    ],
  };
  const f = parseFile(raw, now, () => 'id');
  assert.ok(f, 'file parses');
  const g1 = f.groups.find((g) => g.id === 'g1');
  assert.ok(g1, 'the group itself survives — only its dead settings go');
  assert.equal(g1.name, 'Fleet');
  assert.deepEqual(g1.walletIds, ['w2']);
  assert.equal(g1.lab, undefined, 'follow and random trading are gone; their saved config is not carried forward');
  console.log('ok  parseFile drops a legacy lab block and keeps the group');
}

// ── a non-finite jitter or floor never yields a plan of NaN shares ────
{
  const ws = ['A', 'B', 'C'];
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'wide']) {
    const p = planFanout(ws, { mode: 'total', amountSol: 0.3, jitter: bad, minSol: 0.05 });
    assert.equal(p.ok, true, `jitter ${String(bad)}: ${p.message}`);
    assert.equal(p.shares.length, 3);
    assert.ok(p.shares.every((s) => Number.isFinite(s.lamports) && s.lamports > 0), `jitter ${String(bad)} produced a NaN share`);
    assert.equal(p.shares.reduce((a, s) => a + s.lamports, 0), p.totalLamports, 'and the split still sums to the total');
  }
  // The floor is the same class of bug: a NaN minimum silently means no floor.
  const nan = planFanout(ws, { mode: 'same', amountSol: 0.01, minSol: NaN });
  assert.ok(nan.shares.every((s) => Number.isFinite(s.lamports)));
  console.log('ok  fan-out: a non-finite jitter or minimum is treated as 0, never as NaN shares');
}
console.log('labguards: all tests passed');
