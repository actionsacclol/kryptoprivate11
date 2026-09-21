// Fee arithmetic and referral validation.
//
// The interesting cases are the ones where money could go missing or a user
// could be blocked: rounding, the dust floor, self-referral, and the
// treasury-not-configured default.

import assert from 'node:assert';
import {
  FEE_BPS,
  REFERRAL_SHARE_BPS,
  MIN_FEE_LAMPORTS,
  TREASURY_ADDRESS,
  splitFee,
  looksLikeSolAddress,
  referralProblem,
  feePctLabel,
  referralPctLabel,
  feesEnabled,
} from './.fees.mjs';
import { holderFeePctLabel } from './.fees.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const SOL = 1_000_000_000;
const REAL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // a real, well-known address
const OTHER = 'So11111111111111111111111111111111111111112';

// ─── the split ────────────────────────────────────────────────────────

ok('0.5% of a 1 SOL trade is 0.005 SOL', () => {
  const s = splitFee(SOL, false);
  assert.equal(s.totalLamports, 5_000_000);
  assert.equal(s.treasuryLamports, 5_000_000);
  assert.equal(s.referrerLamports, 0);
});

ok('a referrer takes 20% of the fee, not 20% of the trade', () => {
  const s = splitFee(SOL, true);
  assert.equal(s.totalLamports, 5_000_000, 'the user still pays 0.5% total');
  assert.equal(s.referrerLamports, 1_000_000, '0.1% of the trade');
  assert.equal(s.treasuryLamports, 4_000_000);
});

ok('a $KRYPTO holder pays half, and the referrer still earns — half', () => {
  // 25 bps is what shared/krypto.ts hands the signer for a holder.
  const s = splitFee(SOL, true, 25);
  assert.equal(s.totalLamports, 2_500_000, '0.25 % of the trade');
  assert.equal(s.referrerLamports, 500_000, '20 % of the halved fee: 0.05 % of the trade, not zero');
  assert.equal(s.treasuryLamports, 2_000_000);
  assert.equal(splitFee(SOL, false, 25).treasuryLamports, 2_500_000);
  // The rate can only go DOWN from the ordinary one: a caller asking for
  // more than FEE_BPS gets FEE_BPS, never a surcharge.
  assert.equal(splitFee(SOL, false, 500).totalLamports, 5_000_000);
  assert.equal(holderFeePctLabel(), '0.25%');
});

ok('a referral never costs the user more', () => {
  // The whole design: the referrer is paid out of OUR cut.
  assert.equal(splitFee(SOL, true).totalLamports, splitFee(SOL, false).totalLamports);
});

ok('the split always adds up — no lamport invented or lost', () => {
  for (const amount of [1_234_567, 7_777_777, 999_999_999, 3_333, 50_000_001]) {
    for (const ref of [true, false]) {
      const s = splitFee(amount, ref);
      assert.equal(
        s.treasuryLamports + s.referrerLamports,
        s.totalLamports,
        `parts must equal the whole for ${amount}`,
      );
    }
  }
});

ok('rounding favours the treasury, never overcharges the user', () => {
  // An odd fee that cannot split evenly: the remainder goes to us, and the
  // user's total is still exactly floor(0.5%).
  const s = splitFee(3_333_333, true);
  assert.equal(s.totalLamports, Math.floor((3_333_333 * FEE_BPS) / 10_000));
  assert.ok(s.treasuryLamports >= s.referrerLamports);
});

// ─── the dust floor ───────────────────────────────────────────────────

ok('a trade too small to be worth a transfer pays nothing', () => {
  const tiny = splitFee(1_000, true); // 0.5% = 5 lamports
  assert.deepEqual(tiny, { totalLamports: 0, treasuryLamports: 0, referrerLamports: 0 });
});

ok('the floor is where it says it is', () => {
  const justUnder = Math.floor(((MIN_FEE_LAMPORTS - 1) * 10_000) / FEE_BPS);
  assert.equal(splitFee(justUnder, false).totalLamports, 0);
  const wellOver = Math.ceil((MIN_FEE_LAMPORTS * 10_000) / FEE_BPS) + 10_000;
  assert.ok(splitFee(wellOver, false).totalLamports >= MIN_FEE_LAMPORTS);
});

ok('nonsense input charges nothing rather than throwing', () => {
  for (const bad of [0, -1, NaN, Infinity, undefined, null]) {
    assert.equal(splitFee(bad, true).totalLamports, 0, `input ${bad}`);
  }
});

// ─── address validation ───────────────────────────────────────────────

ok('a real address passes', () => {
  assert.equal(looksLikeSolAddress(REAL), true);
  assert.equal(looksLikeSolAddress(OTHER), true);
});

ok('base58 look-alikes are rejected', () => {
  assert.equal(looksLikeSolAddress(''), false);
  assert.equal(looksLikeSolAddress('too-short'), false);
  assert.equal(looksLikeSolAddress('0OIl' + REAL.slice(4)), false, 'excluded base58 chars');
  assert.equal(looksLikeSolAddress(REAL + REAL), false, 'too long');
});

ok('an address with stray whitespace still validates — people paste badly', () => {
  assert.equal(looksLikeSolAddress(`  ${REAL}  `), true);
});

// ─── referral rules ───────────────────────────────────────────────────

const ctx = { ownAddresses: [OTHER], treasury: 'TreasuryAddr1111111111111111111111111111111' };

ok('no referrer is not a problem — the field is optional', () => {
  assert.equal(referralProblem('', ctx), null);
  assert.equal(referralProblem('   ', ctx), null);
});

ok('a valid stranger address is accepted', () => {
  assert.equal(referralProblem(REAL, ctx), null);
});

ok('self-referral is refused, and says why', () => {
  const why = referralProblem(OTHER, ctx);
  assert.ok(why, 'should be refused');
  assert.match(why, /your own wallet/i);
});

ok('self-referral is caught across ALL of the user\'s wallets, not just the active one', () => {
  const multi = { ownAddresses: [REAL, OTHER], treasury: ctx.treasury };
  assert.ok(referralProblem(REAL, multi), 'a non-active wallet is still the same person');
});

ok('the treasury cannot be named as a referrer', () => {
  const why = referralProblem(ctx.treasury, ctx);
  assert.ok(why);
  assert.match(why, /fee address/i);
});

ok('a malformed address explains itself instead of just saying invalid', () => {
  const why = referralProblem('nope', ctx);
  assert.ok(why);
  assert.match(why, /missing or extra character/i);
});

// ─── the safe default ─────────────────────────────────────────────────

ok('with no treasury configured the build charges nothing', () => {
  // Guards against shipping a placeholder that someone might control.
  if (!TREASURY_ADDRESS) {
    assert.equal(feesEnabled(), false, 'fees must be off until a real address is set');
  } else {
    assert.equal(looksLikeSolAddress(TREASURY_ADDRESS), true, 'a configured treasury must be a real address');
    assert.equal(feesEnabled(), true);
  }
});

// ─── the treasury itself ──────────────────────────────────────────────

ok('the treasury address is the exact one Krypt gave, character for character', () => {
  // Pinned deliberately. A single wrong character here does not fail loudly —
  // it silently pays a stranger, forever, on every trade every user makes.
  assert.equal(TREASURY_ADDRESS, 'J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n');
  assert.equal(TREASURY_ADDRESS.length, 44);
  assert.equal(looksLikeSolAddress(TREASURY_ADDRESS), true);
});

// ─── labels are derived, not typed twice ──────────────────────────────

ok('the UI percentages come from the constants that are actually charged', () => {
  assert.equal(feePctLabel(), '0.5%');
  assert.equal(referralPctLabel(), '0.1%');
  // If someone changes FEE_BPS, the copy moves with it.
  assert.equal(FEE_BPS, 50);
  assert.equal(REFERRAL_SHARE_BPS, 2000);
});

console.log(`fees: ${passed}/${passed} tests passed`);
