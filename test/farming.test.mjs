// Volume-farming arithmetic (shared/farming.ts), rebuilt 2026-09-14.
//
// This page decides whether someone funds a run, so the failure that matters
// is not a wrong rate — it is a cost that renders as a number when it was
// never measured. The first version of this file GUESSED a 0.25 %/side pool
// fee; measured, it was 0.30 % on a settled PumpSwap pool, 1.20 % on a fresh
// one, and 0.000-0.007 % on a real established pair. Wrong by two orders of
// magnitude, in the direction that makes a feature look viable.
//
// So the load-bearing property here is: UNMEASURED IS NULL, NEVER ZERO.

import assert from 'node:assert/strict';
import {
  DEFAULT_VOLUME_FARM,
  FARM_FEE_BPS,
  FARM_FEE_PCT_PER_SIDE,
  FEE_BPS,
  FULL_FEE_PCT_PER_SIDE,
  eligibilityNote,
  netPctOfVolume,
  ownerNote,
  presetProblems,
  projectFarming,
  requiredRewardPct,
} from './.farming.mjs';
import { FARM_FEE_BPS as FEES_FARM_BPS, FEE_BPS as FEES_FULL_BPS, splitFee } from './.fees.mjs';

const measured = (over = {}) => ({ ...DEFAULT_VOLUME_FARM, mint: 'x', tradeSol: 10, frictionPctPerRoundTrip: 0.004, ...over });

{
  // The percents must be the real constants, not a second copy that can drift.
  assert.equal(FARM_FEE_PCT_PER_SIDE, FEES_FARM_BPS / 100);
  assert.equal(FULL_FEE_PCT_PER_SIDE, FEES_FULL_BPS / 100);
  assert.equal(FARM_FEE_BPS, FEES_FARM_BPS);
  assert.equal(FEE_BPS, FEES_FULL_BPS);
  console.log('ok  the quoted rates ARE the rates in fees.ts');
}

{
  // THE property. Unmeasured friction poisons every derived number to null.
  // A zero here would read as "free", which is the most expensive thing this
  // page could imply.
  const p = { ...DEFAULT_VOLUME_FARM, mint: 'x', frictionPctPerRoundTrip: null };
  const r = projectFarming(p);
  assert.equal(r.frictionSolPerHour, null);
  assert.equal(r.costSolPerHour, null);
  assert.equal(r.costPctOfVolume, null);
  assert.equal(r.budgetHours, null);
  assert.equal(r.volumeSolForBudget, null);
  assert.equal(requiredRewardPct(r), null);
  assert.equal(netPctOfVolume(r, 5), null, 'no net is computable without a cost');
  // ...but the things that do NOT depend on it are still real.
  assert.ok(r.tripsPerHour > 0 && r.volumeSolPerHour > 0 && r.gasSolPerHour > 0);
  console.log('ok  unmeasured friction is null everywhere downstream, never zero');
}

{
  // The shipped preset arrives unmeasured and off, and says so.
  assert.equal(DEFAULT_VOLUME_FARM.enabled, false);
  assert.equal(DEFAULT_VOLUME_FARM.mint, '');
  assert.equal(DEFAULT_VOLUME_FARM.frictionPctPerRoundTrip, null);
  const probs = presetProblems(DEFAULT_VOLUME_FARM);
  assert.ok(probs.some((t) => /No coin/i.test(t)));
  assert.ok(probs.some((t) => /not been measured/i.test(t)));
  console.log('ok  the shipped preset is off, unmeasured, and admits both');
}

{
  // A worked example by hand. 30 s cycle = 120 trips/h; 10 SOL a trip over two
  // legs = 2400 SOL of volume an hour.
  const p = measured({ holdSec: 20, gapSec: 10, gasSolPerTx: 0 });
  const r = projectFarming(p);
  assert.equal(r.tripsPerHour, 120);
  assert.equal(r.fillsPerHour, 240);
  assert.equal(r.volumeSolPerHour, 2400);
  // App fee: 0.05 % of 2400 = 1.2 SOL.
  assert.ok(Math.abs(r.appFeeSolPerHour - 1.2) < 1e-9);
  // Friction is per ROUND TRIP on the trade size, not per side on the volume:
  // 120 trips x 10 SOL x 0.004 % = 0.048 SOL.
  assert.ok(Math.abs(r.frictionSolPerHour - 0.048) < 1e-9);
  assert.ok(Math.abs(r.costSolPerHour - 1.248) < 1e-9);
  console.log('ok  the worked example matches by hand, line by line');
}

{
  // Every cost line is in the total. A dropped line always makes farming look
  // cheaper than it is — the only direction this page can be wrong in that
  // costs someone money.
  const r = projectFarming(measured({ gasSolPerTx: 0.003 }));
  const sum = r.appFeeSolPerHour + r.frictionSolPerHour + r.gasSolPerHour;
  assert.ok(Math.abs(r.costSolPerHour - sum) < 1e-9);
  assert.ok(r.gasSolPerHour > 0, 'gas is counted, not rounded away');
  console.log('ok  the total is exactly the sum of its lines');
}

{
  // The owner's fee is a wash; a user's is not. This is the whole reason the
  // payer field exists.
  const user = projectFarming(measured({ payer: 'user' }));
  const owner = projectFarming(measured({ payer: 'owner' }));
  assert.ok(user.appFeeSolPerHour > 0);
  assert.equal(owner.appFeeSolPerHour, 0);
  assert.ok(owner.costSolPerHour < user.costSolPerHour);
  assert.ok(ownerNote.length > 0 && /not make it profitable|only ever net out slightly negative/i.test(ownerNote),
    'the owner note must refuse to imply that paying yourself is income');
  console.log('ok  the owner pays no app fee, and the page says that is not profit');
}

{
  // Gas is FIXED per transaction, so it dominates at small size and vanishes
  // at large. This inverted the whole design and must stay pinned.
  const small = projectFarming(measured({ tradeSol: 1, gasSolPerTx: 0.00301 }));
  const large = projectFarming(measured({ tradeSol: 100, gasSolPerTx: 0.00301 }));
  assert.ok(small.costPctOfVolume > large.costPctOfVolume * 5,
    'a small round trip is far more expensive per unit of volume');
  assert.ok(presetProblems(measured({ tradeSol: 1 })).some((t) => /gas alone/i.test(t)),
    'and the page says so before someone funds it');
  console.log('ok  gas dominates at small size — bigger round trips are cheaper');
}

{
  // Break-even and net are the same number seen from two sides.
  const r = projectFarming(measured({ gasSolPerTx: 0 }));
  const need = requiredRewardPct(r);
  assert.ok(Math.abs(netPctOfVolume(r, need)) < 1e-9, 'paying exactly the required rate nets zero');
  assert.ok(netPctOfVolume(r, need + 0.1) > 0);
  assert.ok(netPctOfVolume(r, need - 0.1) < 0);
  console.log('ok  break-even and net agree at the boundary');
}

{
  // The reduced rate has to actually be a reduction, and reach the arithmetic.
  assert.ok(FARM_FEE_BPS < FEE_BPS, 'the farm rate must be a reduction, not a second full rate');
  const SOL = 1_000_000_000;
  assert.equal(splitFee(SOL, false).treasuryLamports, 5_000_000, 'the ordinary rate is untouched');
  assert.equal(splitFee(SOL, false, FARM_FEE_BPS).treasuryLamports, 500_000, 'the farm rate is 10x cheaper');
  // And it cannot be used to widen the fee — a caller passing something above
  // the ordinary rate gets the ordinary rate, not the larger one.
  assert.equal(splitFee(SOL, false, 500).treasuryLamports, 5_000_000, 'the farm parameter cannot RAISE the fee');
  console.log('ok  the farm rate is a reduction and cannot be used to widen the fee');
}

{
  // A thin pair must be called out rather than silently priced in.
  assert.ok(presetProblems(measured({ frictionPctPerRoundTrip: 3.4 })).some((t) => /not a deep pair/i.test(t)));
  console.log('ok  a pair too thin for cheap volume is named as the problem');
}

{
  // The eligibility warning is the one thing the maths cannot cover.
  assert.match(eligibilityNote, /self-matched/i);
  assert.match(eligibilityNote, /after the window/i);
  console.log('ok  the eligibility warning names the risk the maths cannot price');
}

console.log('farming: all tests passed');
