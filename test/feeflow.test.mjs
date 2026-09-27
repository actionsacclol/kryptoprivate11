// Fee flow, end to end across three modules.
//
// splitFee(), injectTransfers() and checkOutflow() each pass their own tests.
// This asserts the COMPOSITION that liveSigner actually performs — split the
// fee, append the transfers to the unsigned tx, then hand the signer an
// allowance describing exactly what was appended. A mismatch anywhere in that
// chain means either a refused trade or an unbounded transfer, and neither
// shows up in the unit tests.

import assert from 'node:assert/strict';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { splitFee } from './.fees.mjs';
import { injectTransfers } from './.broadcast.mjs';
import { checkOutflowForTest as check } from './.signpolicy.mjs';

const BLOCKHASH = '11111111111111111111111111111111';
const me = Keypair.generate();
const OWNER = me.publicKey.toBase58();
const HOME = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const REFERRER = Keypair.generate().publicKey.toBase58();
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SOL = 1_000_000_000;

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log('ok  ' + name);
      passed += 1;
    })
    .catch((err) => {
      console.error('FAIL ' + name);
      console.error(err);
      process.exit(1);
    });
}

/** A stand-in for a built pump trade: compute budget + one program call. */
function tradeTx() {
  const msg = new TransactionMessage({
    payerKey: me.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
      new TransactionInstruction({
        programId: PUMP,
        keys: [{ pubkey: me.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([1, 2, 3]),
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}

/** Exactly what liveSigner builds after splitting the fee. */
function allowanceFor(fee) {
  return fee.totalLamports > 0
    ? [
        { address: TREASURY, maxLamports: fee.treasuryLamports },
        ...(fee.referrerLamports > 0 ? [{ address: REFERRER, maxLamports: fee.referrerLamports }] : []),
      ]
    : undefined;
}

function transfersFor(fee) {
  const out = [{ to: TREASURY, lamports: fee.treasuryLamports }];
  if (fee.referrerLamports > 0) out.push({ to: REFERRER, lamports: fee.referrerLamports });
  return out;
}

const TRADE = (fee) => ({ intent: 'trade', maxTransferLamports: 0, feeAllowance: allowanceFor(fee) });

await ok('a referred trade: fee is injected and the signer accepts exactly it', async () => {
  const fee = splitFee(SOL, true);
  assert.equal(fee.totalLamports, 5_000_000);
  const withFee = await injectTransfers(tradeTx(), OWNER, transfersFor(fee), 'http://unused');
  assert.ok(withFee, 'injection should succeed on a tx with no lookup tables');
  const r = check(withFee, OWNER, HOME, TRADE(fee));
  assert.equal(r.ok, true, r.message);
});

await ok('an unreferred trade injects one transfer and still passes', async () => {
  const fee = splitFee(SOL, false);
  assert.equal(fee.referrerLamports, 0);
  const withFee = await injectTransfers(tradeTx(), OWNER, transfersFor(fee), 'http://unused');
  const r = check(withFee, OWNER, HOME, TRADE(fee));
  assert.equal(r.ok, true, r.message);
});

await ok('the injected lamports are really in the transaction, not just allowed', async () => {
  const fee = splitFee(SOL, true);
  const withFee = await injectTransfers(tradeTx(), OWNER, transfersFor(fee), 'http://unused');
  const tx = VersionedTransaction.deserialize(withFee);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const sys = '11111111111111111111111111111111';
  const moved = new Map();
  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== sys) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    const dest = keys[ix.accountKeyIndexes[1]];
    moved.set(dest, Number(view.getBigUint64(4, true)));
  }
  assert.equal(moved.get(TREASURY), 4_000_000, 'treasury gets 80% of the fee');
  assert.equal(moved.get(REFERRER), 1_000_000, 'referrer gets 20% of the fee');
});

await ok('the original trade instructions survive injection untouched', async () => {
  const fee = splitFee(SOL, true);
  const before = VersionedTransaction.deserialize(tradeTx()).message.compiledInstructions.length;
  const withFee = await injectTransfers(tradeTx(), OWNER, transfersFor(fee), 'http://unused');
  const after = VersionedTransaction.deserialize(withFee).message.compiledInstructions;
  assert.equal(after.length, before + 2, 'exactly two transfers added');
  const keys = VersionedTransaction.deserialize(withFee).message.staticAccountKeys.map((k) => k.toBase58());
  assert.ok(keys.includes(PUMP.toBase58()), 'the trade program is still there');
});

// The attack this whole allowance design exists to stop.
await ok('a tampered fee — more lamports than the allowance — is REFUSED', async () => {
  const fee = splitFee(SOL, true);
  const tampered = transfersFor(fee).map((t) =>
    t.to === TREASURY ? { ...t, lamports: t.lamports + 1 } : t,
  );
  const withFee = await injectTransfers(tradeTx(), OWNER, tampered, 'http://unused');
  const r = check(withFee, OWNER, HOME, TRADE(fee));
  assert.equal(r.ok, false, 'signer must refuse more than the split allowed');
  assert.match(r.message, /over the/i);
});

await ok('a fee redirected to a stranger is REFUSED', async () => {
  const fee = splitFee(SOL, true);
  const evil = Keypair.generate().publicKey.toBase58();
  const withFee = await injectTransfers(
    tradeTx(),
    OWNER,
    [{ to: evil, lamports: fee.totalLamports }],
    'http://unused',
  );
  const r = check(withFee, OWNER, HOME, TRADE(fee));
  assert.equal(r.ok, false);
  assert.match(r.message, /neither your withdrawal address nor a known tip account/i);
});

// A trade too small to bill must not produce an empty-allowance mismatch.
await ok('a dust trade injects nothing and still signs', async () => {
  const fee = splitFee(1_000, true);
  assert.equal(fee.totalLamports, 0);
  const withFee = await injectTransfers(tradeTx(), OWNER, transfersFor(fee).filter((t) => t.lamports > 0), 'http://unused');
  const r = check(withFee, OWNER, HOME, { intent: 'trade', maxTransferLamports: 0 });
  assert.equal(r.ok, true, r.message);
});

console.log(`feeflow: ${passed}/${passed} tests passed`);

// Relayer-built sells are billed on the ESTIMATED proceeds (2026-08-30):
// the liveSigner source must derive solValueLamports from estProceedsLamports
// for sells, and leave a sell unbilled only when no estimate exists.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../electron/engine/liveSigner.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /estProceedsLamports\?: number \| Promise<number \| undefined>/, 'param takes the value or a promise');
  // The estimate is resolved INSIDE the relayer branch. Callers hand over a
  // promise so the read does not block the build (2026-09-05); billing is
  // unchanged, and a failed estimate bills nothing rather than guessing.
  const i = src.indexOf("p.action === 'sell'\n            ? Math.floor((await resolveEstProceeds(p.estProceedsLamports))");
  assert.ok(i > 0, 'relayer sell billing branch exists and resolves the estimate');
  assert.match(src, /async function resolveEstProceeds[\s\S]*catch \{\s*return 0;/, 'an unusable estimate bills zero');
  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(eng, /estProceedsLamports: estProceeds/, 'manualSell passes the estimate');
  assert.match(
    eng,
    /estProceedsLamports: this\.estSellProceedsLamports\(tkn\.mint, 100\)\.catch/,
    'sell-all passes the estimate without blocking on it',
  );
  // And the arithmetic the estimate feeds: 0.5% of 2 SOL proceeds.
  const fee = splitFee(2_000_000_000, false);
  assert.equal(fee.totalLamports, 10_000_000);
  console.log('ok  relayer sells are billed on estimated proceeds; unbilled only without a price');

  // ── a referrer who is not paid must be TOLD, not silently skipped ──
  //
  // There are exactly two ways the transfer disappears after the split has
  // already allotted it, and until 2026-09-21 both were silent: the recipient
  // sits below rent-exemption (paying it would revert the trade), or the
  // transaction is at the 1232-byte limit and the size fit drops the least
  // important transfer, which is deliberately the referrer. Onboarding tells
  // a referrer they earn on every trade, so the cases where they do not are
  // the ones that have to speak.
  assert.match(src, /referrer not paid \(their wallet is below rent-exemption/, 'a referrer dropped for rent-exemption is reported, not just omitted');
  assert.match(src, /!safe\.some\(\(t\) => t\.to === referrer\)/, 'and the check that finds that case is the recipient list itself');
  assert.match(src, /fit\.dropped\.filter/, 'the size fit is asked what it dropped');
  assert.match(src, /dropped \$\{names\.join\('\+'\)\} \(transaction at the/, 'and a fee transfer lost to the size limit is named in the result');
  // The note has to OUTLIVE the success summary, which reassigns feeNote from
  // scratch — writing an unpaid-referral note into feeNote before that line
  // threw it away, which is how the first version of this fix failed.
  assert.match(src, /let referralNote = ''/, 'an unpaid referral is noted separately from feeNote');
  assert.match(src, /feeNote \+= referralNote;/, 'and appended after the summary that rewrites feeNote');
  assert.ok(
    src.indexOf("feeNote = `, fee ") < src.indexOf('feeNote += referralNote;'),
    'the append really is after the line that reassigns feeNote, or the note is lost again',
  );
  // And the ordering that decides WHO gets dropped: the referrer goes after
  // the treasury and after the tip that makes the trade land at all.
  assert.match(src, /const PRIORITY = \{ treasury: 0, jito: 1, referrer: 2, helius: 3 \}/, 'the drop order is explicit and puts the referrer after the treasury');
  console.log('ok  a referrer who cannot be paid is reported in both cases, and the drop order is pinned');

  // ── a referrer who is REFUSED outright must be told too ──
  //
  // Three settings mistakes make the signer ignore a named referrer: it is
  // not an address, it is the treasury, or it is the wallet doing the
  // trading. All three used to pass in silence with the whole fee going to
  // the treasury, which looks identical to a working referral.
  assert.match(src, /if \(referrer && !hasReferrer\)/, 'a named referrer the signer refuses is noticed');
  assert.match(src, /no referrer credited/, 'and the refusal is reported, not swallowed');
  assert.match(src, /you cannot refer yourself/, 'self-referral is named as such');

  // ── the swap path attaches a fee too, and needed the same two guards ──
  //
  // swap.ts builds its own transfers. Until 2026-09-21 it never called
  // rentSafeTransfers, so a referral cut to a brand-new referrer wallet
  // could revert the SWAP with InsufficientFundsForRent — a fee failing a
  // trade is the one outcome this whole layer exists to prevent.
  const swap = fs.readFileSync(new URL('../electron/engine/swap.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(swap, /rentSafeTransfers/, 'the swap path runs its fee transfers through the rent guard');
  // Compared on the CALL sites, not the first mention: both names appear in
  // the import block at the top, where the order means nothing.
  assert.ok(
    swap.indexOf('await rentSafeTransfers(') < swap.indexOf('await injectTransfersFit('),
    'and it runs rent BEFORE the size fit, so a reverting transfer never reaches it',
  );
  assert.match(swap, /referrer ignored/, 'the swap path reports a referrer it refuses');
  assert.match(swap, /below rent-exemption, paying it would revert the swap/, 'and one it cannot pay');
  assert.match(swap, /fit\.dropped\.length/, 'and one lost to the size limit');
  console.log('ok  a refused referrer is reported, and the swap path has the rent guard too');
}

// ── fee audit 2026-09-26 ────────────────────────────────────────────────
//
// 1. Every Solana SELL funnel hands the signer an estimate. Only a relayer-
//    built sell reads it, but without it that sell went out UNBILLED — and
//    the autonomous exit (autoLiveSell) and the per-wallet exit (labSell:
//    copy configs on their own wallet, script named-wallet sells, Krypto
//    Mode, Krypto Trader, Wallet Lab) passed none.
// 2. A sell billed on a price the proceeds did not reach can fail AT our fee
//    transfer. That exit is re-sent without the fee — never blocked by it —
//    and ONLY when the failing instruction is a fee transfer.
{
  const fs = await import('node:fs');
  const { revertedAtFee } = await import('./.fees.mjs');
  assert.equal(revertedAtFee('{"InstructionError":[4,{"Custom":1}]}', [4, 5]), true, 'the treasury transfer failed');
  assert.equal(revertedAtFee('{"InstructionError":[5,{"Custom":1}]}', [4, 5]), true, 'the referrer transfer failed');
  assert.equal(revertedAtFee('{"InstructionError":[2,{"Custom":6004}]}', [4, 5]), false, 'a slippage revert in the swap keeps its fee');
  assert.equal(revertedAtFee('{"InstructionError":[4,{"Custom":1}]}', []), false, 'no fee attached, nothing to strip');
  assert.equal(revertedAtFee('"InsufficientFundsForFee"', [4]), false, 'a transaction-level error is not a fee revert');
  assert.equal(revertedAtFee(undefined, [4]), false, 'an unreadable error is not a fee revert');
  console.log('ok  revertedAtFee names a fee-transfer revert and nothing else');

  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = (name) => {
    const i = eng.indexOf(`  private ${name}(`) >= 0 ? eng.indexOf(`  private ${name}(`) : eng.indexOf(`  private async ${name}(`);
    assert.ok(i > 0, `${name} exists`);
    return eng.slice(i, eng.indexOf('\n  }\n', i));
  };
  assert.match(body('autoLiveSell'), /estProceedsLamports: this\.estSellProceedsLamports\(mint, 100\)\.catch/, 'the autonomous exit passes an estimate');
  assert.match(body('labSell'), /estProceedsLamports: this\.estSellProceedsLamports\(mint, share, owner\)\.catch/, 'the per-wallet exit passes one, for THAT wallet');
  assert.match(body('estSellProceedsLamports'), /const owner = ownerOverride \?\? wallet\.publicKey\(\)/, 'the estimate reads the named wallet when one is given');
  // Every executeTrade sell in the engine goes through sellWithRetry, and every
  // sellWithRetry call site carries an estimate.
  const sells = eng.split('this.sellWithRetry({').slice(1).map((s) => s.slice(0, s.indexOf('});')));
  assert.ok(sells.length >= 4, 'the sell funnels are all found');
  for (const s of sells) assert.match(s, /estProceedsLamports:/, 'a sell funnel without an estimate bills nothing on the relayer route');
  console.log(`ok  all ${sells.length} Solana sell funnels hand the signer a proceeds estimate`);

  const src = fs.readFileSync(new URL('../electron/engine/liveSigner.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /feeReverted: p\.action === 'sell' && revertedAtFee\(raw, feeIxIndexes\)/, 'only a SELL is flagged');
  assert.match(src, /if \(!res\.ok && res\.feeReverted && p\.action === 'sell'\) \{[\s\S]*?runPipeline\([^)]*lastValidBlockHeight, true\)/, 'and it is re-run once without the fee');
  assert.match(src, /const billFee = !\(skipFee && p\.action === 'sell'\)/, 'a buy can never be sent fee-free through that door');
  console.log('ok  a sell that would revert at the fee transfer goes out without it; buys never do');
}

// ── every swap is billed (2026-09-26) ──────────────────────────────────
//
// The Swap card used to charge nothing on a token-to-token pair it could not
// price in SOL. Now: the input priced in SOL, else the OUTPUT priced in SOL,
// else the fee is taken in the output token itself, inside the same
// transaction — a classic-Token TransferChecked from our own account into the
// treasury's (and referrer's) EXISTING token account, which the signer permits
// through its own named, capped allowance and nothing wider.
{
  const fs = await import('node:fs');
  const { splitTokenFee, FEE_BPS } = await import('./.fees.mjs');
  const { injectTokenTransfersFit, compileKeepingTransfersStatic } = await import('./.broadcast.mjs');
  const { AddressLookupTableAccount } = await import('@solana/web3.js');

  // The arithmetic: same rate, same referrer share, in base units, as bigint.
  let s = splitTokenFee(1_000_000n, true);
  assert.deepEqual([s.totalRaw, s.treasuryRaw, s.referrerRaw], [5_000n, 4_000n, 1_000n], '0.5 %, 20 % of it to the referrer');
  s = splitTokenFee(1_000_000n, false, 25);
  assert.deepEqual([s.totalRaw, s.treasuryRaw, s.referrerRaw], [2_500n, 2_500n, 0n], 'a $KRYPTO holder pays half');
  s = splitTokenFee(1_000_000n, false, 500);
  assert.equal(s.totalRaw, 5_000n, 'a rate above FEE_BPS is clamped to it, never charged');
  assert.equal(splitTokenFee(199n, true).totalRaw, 0n, 'a fee that rounds to zero is zero');
  assert.equal(splitTokenFee(0n, true).totalRaw, 0n);
  assert.equal(splitTokenFee(-5n, true).totalRaw, 0n);
  const big = 2n ** 60n;
  assert.equal(splitTokenFee(big, false).totalRaw, (big * BigInt(FEE_BPS)) / 10_000n, 'u64 amounts past 2^53 are exact');
  console.log('ok  splitTokenFee: the token-unit split matches the SOL split');

  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ata = (owner, mint) =>
    PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROG)[0].toBase58();
  const IN_MINT = Keypair.generate().publicKey.toBase58();
  const OUT_MINT = Keypair.generate().publicKey.toBase58();
  const JUP = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  const tAta = ata(TREASURY, OUT_MINT);
  const rAta = ata(REFERRER, OUT_MINT);
  const src = ata(OWNER, OUT_MINT);
  /** A stand-in for a Jupiter token-to-token route. */
  const routeTx = () =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: me.publicKey,
        recentBlockhash: BLOCKHASH,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          new TransactionInstruction({
            programId: JUP,
            keys: [
              { pubkey: me.publicKey, isSigner: true, isWritable: true },
              { pubkey: new PublicKey(ata(OWNER, IN_MINT)), isSigner: false, isWritable: true },
              { pubkey: new PublicKey(src), isSigner: false, isWritable: true },
            ],
            data: Buffer.from([9, 9]),
          }),
        ],
      }).compileToV0Message(),
    ).serialize();
  const plan = (treasuryRaw, referrerRaw, over = {}) => [
    { source: src, mint: OUT_MINT, decimals: 6, dest: tAta, amountRaw: treasuryRaw, priority: 0, ...over },
    ...(referrerRaw > 0n ? [{ source: src, mint: OUT_MINT, decimals: 6, dest: rAta, amountRaw: referrerRaw, priority: 1 }] : []),
  ];
  const SWAP = (allow) => ({
    intent: 'trade',
    trade: { side: 'sell', mint: IN_MINT },
    maxTransferLamports: 10_000_000,
    tokenFeeAllowance: allow,
  });
  const allowFor = (t, r) => ({
    mint: OUT_MINT,
    recipients: [{ account: tAta, maxRaw: String(t) }, ...(r > 0n ? [{ account: rAta, maxRaw: String(r) }] : [])],
  });

  const fit = await injectTokenTransfersFit(routeTx(), OWNER, plan(4_000n, 1_000n), 'http://unused');
  assert.ok(fit && fit.kept.length === 2 && fit.dropped.length === 0, 'both token fee transfers attach');
  const decoded = VersionedTransaction.deserialize(fit.tx);
  const n = decoded.message.compiledInstructions.length;
  assert.equal(n, 4, 'appended after the route, so they are the LAST instructions (what revertedAtFee is told)');
  const last = decoded.message.compiledInstructions[n - 1];
  assert.equal(decoded.message.staticAccountKeys[last.programIdIndex].toBase58(), TOKEN.toBase58());
  assert.equal(last.data[0], 12, 'a TransferChecked');
  assert.equal(Buffer.from(last.data).readBigUInt64LE(1), 1_000n, 'carrying exactly the split');
  let r = check(fit.tx, OWNER, HOME, SWAP(allowFor(4_000n, 1_000n)));
  assert.equal(r.ok, true, r.message);
  console.log('ok  an output-token fee is injected and the signer accepts exactly it');

  r = check(fit.tx, OWNER, HOME, SWAP(allowFor(3_999n, 1_000n)));
  assert.equal(r.ok, false, 'one base unit over the ceiling is refused');
  assert.match(r.message, /over the 3999 allowed/);
  r = check(fit.tx, OWNER, HOME, SWAP(undefined));
  assert.equal(r.ok, false, 'no allowance: the ordinary token rule refuses moving the OUTPUT token out');
  const evil = ata(Keypair.generate().publicKey.toBase58(), OUT_MINT);
  const redirected = await injectTokenTransfersFit(routeTx(), OWNER, plan(4_000n, 0n, { dest: evil }), 'http://unused');
  r = check(redirected.tx, OWNER, HOME, SWAP(allowFor(4_000n, 0n)));
  assert.equal(r.ok, false, 'a token fee redirected to a stranger is refused');
  const otherMint = Keypair.generate().publicKey.toBase58();
  const wrongMint = await injectTokenTransfersFit(
    routeTx(),
    OWNER,
    plan(4_000n, 0n, { mint: otherMint, source: ata(OWNER, otherMint) }),
    'http://unused',
  );
  r = check(wrongMint.tx, OWNER, HOME, SWAP(allowFor(4_000n, 0n)));
  assert.equal(r.ok, false, 'a different token out of a different account is not the fee');
  r = check(fit.tx, OWNER, HOME, { ...SWAP(allowFor(4_000n, 1_000n)), intent: 'sweep' });
  assert.equal(r.ok, false, 'the allowance means nothing outside a trade');
  console.log('ok  a tampered, redirected, other-mint or out-of-trade token fee is REFUSED');

  // A route's own lookup table often holds the output mint and our token
  // account for it; the signer names every account of the fee transfer, so
  // the compile must keep them static even then.
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [new PublicKey(OUT_MINT), new PublicKey(src), new PublicKey(tAta)],
    },
  });
  const msg = TransactionMessage.decompile(VersionedTransaction.deserialize(fit.tx).message);
  const loose = msg.compileToV0Message([table]);
  assert.ok(
    !loose.staticAccountKeys.some((k) => k.toBase58() === OUT_MINT),
    'without the guard the table would hide the mint (so this test can fail)',
  );
  const compiled = compileKeepingTransfersStatic(msg, [], [table], new Set([OUT_MINT, src, tAta]));
  const staticKeys = new Set(compiled.staticAccountKeys.map((k) => k.toBase58()));
  assert.ok([OUT_MINT, src, tAta].every((k) => staticKeys.has(k)), 'every token-fee account stays static despite the table');
  console.log('ok  token-fee accounts are kept out of lookup tables');

  // The Swap card's wiring, pinned at the source.
  const swap = fs.readFileSync(new URL('../electron/engine/swap.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(swap, /quoteSellLamports\(inputMint, inRaw, \{ priority: true \}\)/, 'the input is priced in SOL first');
  assert.match(swap, /quoteSellLamports\(outputMint, outRaw, \{ priority: true \}\)/, 'then the OUTPUT');
  assert.match(swap, /return \{ kind: 'token', basisRaw: outRaw \}/, 'and with no SOL price at all, the fee is taken in the output token');
  assert.match(swap, /if \(info\.data\.owner !== TOKEN_PROGRAM\) return \{ plan: null/, 'classic Token only (a Token-2022 hook could revert the swap)');
  assert.match(swap, /if \(!treasuryOk\) return \{ plan: null/, "never creates the treasury's account at the user's expense");
  assert.match(swap, /const received = outAfter - outBefore\.raw \+ tokenFeeRaw;/, 'the receipt check adds the token fee back');
  assert.match(
    swap,
    /prepared\.feeReverted && draft\.inputMint !== WSOL_MINT\) \{[\s\S]*?prepared = await prepare\(false\)/,
    'a swap failing AT the fee is re-run fee-free, never a SOL-spending one',
  );
  assert.match(swap, /revertedAtFee\(raw, feeIxIndexes\)/, 'and only when the failing instruction is a fee transfer');
  assert.match(swap, /requireFeeTransfer:\s*draft\.inputMint === WSOL_MINT && treasuryKept/, 'a SOL-spending swap is a buy and keeps the fee interlock');
  assert.match(swap, /treasuryIntegrity\(\)\.treasury/, 'the treasury comes from the integrity layer');
  assert.match(swap, /holderFeeBps\(FEE_BPS, holderRateApplies\(kryptoUsableTokens\(\)\)\)/, 'the $KRYPTO rate applies to the token fee too');
  // USDC callout rewards -> SOL ride the Swap card's execute, so they pay the
  // same fee on their SOL leg — no second path to forget.
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const rewards = ipc.slice(ipc.indexOf("ipcMain.handle('calloutRewards:swapUsdc'"), ipc.indexOf("ipcMain.handle('calloutRewards:withdrawUsdc'"));
  assert.match(rewards, /swap\.execute\(\s*\{ chain: 'solana', inputMint: USDC_MINT, outputMint: WSOL_MINT/, 'USDC -> SOL goes through the billed swap path');
  console.log('ok  the Swap card bills every pair; USDC rewards -> SOL ride the same fee point');
}
