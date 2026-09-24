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
