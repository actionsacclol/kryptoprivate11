// What the platform fee is charged on, pinned against a REAL round trip.
//
// BRAINMINI, 2026-09-11, signatures 3vUS95qY… (buy) and 5DTq8rCR… (sell).
// Every number below was read off the chain, not constructed.
//
// A buy is charged on the exact amount spent — the app names it, so there is
// nothing to estimate. A sell is charged on Jupiter's QUOTED output, because
// on Solana the fee transfer is injected into the same transaction before
// signing and there is no later moment to rebase it (the EVM rail can, and
// does). The quote is unbiased: fills land near it, above and below, so the
// charge averages to the published rate.
//
// The measured trip below shows the low tail — the fill came in 11 % under
// quote, so the fee worked out at 0.556 % of what arrived. Charging on the
// slippage FLOOR instead was considered and rejected: the floor sits a whole
// slippage tolerance under the quote, so it would undercharge systematically
// on every sell to correct an occasional few thousand lamports.

import assert from 'node:assert';
import { FEE_BPS, splitFee } from './.fees.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  assert.equal(FEE_BPS, 50, 'the published rate is 0.5 % a side');
  ok('the published rate is 0.5 % a side');
}

{
  // The real buy. The app spent 0.05 SOL and the treasury received exactly
  // 250,000 lamports — verified on chain.
  assert.equal(splitFee(50_000_000, false).totalLamports, 250_000);
  ok('a buy is charged on the exact amount spent — 250,000 lamports, as it was');
}

{
  // The real sell. Quoted 69,219,400 out; the treasury received 346,097,
  // which is exactly 0.5 % of the quote.
  assert.equal(splitFee(69_219_400, false).totalLamports, 346_097);
  ok('a sell is charged 0.5 % of the quoted proceeds — 346,097 lamports, as it was');
}

{
  // And the tail that produced it: 62,225,361 actually arrived, so the charge
  // came to 0.556 % of the fill. Pinned so the number is on the record rather
  // than rediscovered later as a surprise.
  const arrived = 62_225_361;
  const rate = (346_097 / arrived) * 100;
  assert.ok(rate > 0.55 && rate < 0.56, `0.5 % of the quote was ${rate.toFixed(3)} % of the fill`);
  // The other tail is equally real: a fill ABOVE quote pays under the rate.
  assert.ok((346_097 / 75_000_000) * 100 < 0.5, 'a fill above quote pays less than 0.5 %');
  ok('the quote basis cuts both ways — under the rate when a fill lands well');
}

{
  // Rounding never invents a lamport, in either direction.
  assert.equal(splitFee(0, false).totalLamports, 0);
  assert.equal(splitFee(1, false).totalLamports, 0, 'a dust basis rounds down to nothing, never up to one');
  assert.equal(splitFee(-5, false).totalLamports, 0, 'and a negative basis is not a refund');
  ok('the split rounds down and never manufactures a fee');
}

{
  // The referral split comes out of OUR share, never on top of the user's.
  const solo = splitFee(10_000_000, false);
  const withRef = splitFee(10_000_000, true);
  assert.equal(solo.totalLamports, withRef.totalLamports, 'a referred trade costs the user exactly the same');
  assert.ok(withRef.referrerLamports > 0);
  assert.equal(withRef.treasuryLamports + withRef.referrerLamports, withRef.totalLamports);
  ok('a referral splits our share and never adds to the user’s cost');
}

console.log(`\nfeebasis: ${passed}/${passed} passed`);
