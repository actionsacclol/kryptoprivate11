// The Copy score (shared/walletScore.ts) — a Krypt score for wallets.
//
// Built on docs/wallet-convergence-2026-09-14.md: ranking by what a FOLLOWER
// realises (both legs at a lag, net of cost) persists and halves the loss of
// ranking by the wallet's own PnL, but no decile is positive. So the score
// ranks least-bad to follow and the mappings say so: the tape-wide best
// (~−3 % per trip) scores in the middle, never at the top. Pinned here:
// honest-null gates, monotone ramps, the follower return arithmetic, flags.

import assert from 'node:assert';
import {
  FOLLOWER_COST_PER_SIDE,
  FOLLOWER_LAG_MS,
  SCORE_MIN_RESOLVED,
  SCORE_MIN_TRIPS,
  followerNetReturnPct,
  ramp,
  scoreTone,
  scoreWallet,
} from './.walletscore.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const base = {
  roundTrips: 20,
  fTrips: 16,
  fMedianReturnPct: -3,
  fWinRatePct: 45,
  reachablePct: 80,
  judgedTrips: 20,
  activeDays: 5,
  windowDays: 7,
  distinctMints: 20,
  looksAutomated: false,
};

{
  assert.equal(FOLLOWER_LAG_MS, 2_000, 'the lag is what the app\'s copier actually gets, not an in-house bot\'s 800 ms');
  assert.equal(FOLLOWER_COST_PER_SIDE, 0.015, 'venue 1 % + Krypt 0.5 % per side');
  // Buy 1, sell 1: costs on both legs, ~−3 %.
  const flat = followerNetReturnPct(1, 1);
  assert.ok(flat < -2.9 && flat > -3.0, `a flat round trip loses the costs: ${flat}`);
  // Doubling nets ~+94 %.
  const dbl = followerNetReturnPct(1, 2);
  assert.ok(dbl > 93 && dbl < 95, `a double nets about +94 %: ${dbl}`);
  assert.equal(followerNetReturnPct(0, 1), null, 'no entry price is no return');
  assert.equal(followerNetReturnPct(1, NaN), null);
  ok('the follower return arithmetic: both legs pay, a flat trip loses');
}

{
  assert.equal(ramp(-100, [[-25, 0], [0, 75]]), 0, 'clamped below');
  assert.equal(ramp(100, [[-25, 0], [0, 75]]), 75, 'clamped above');
  assert.equal(ramp(-12.5, [[-25, 0], [0, 75]]), 37.5, 'linear between');
  assert.equal(ramp(-3, [[-25, 0], [-10, 35], [-3, 60], [0, 75], [10, 100]]), 60, 'the tape-wide best sits in the middle, not the top');
  ok('ramps are piecewise-linear and clamped');
}

{
  const s = scoreWallet(base);
  assert.ok(typeof s.score === 'number', 'a full record scores');
  assert.equal(s.total, 5);
  assert.equal(s.resolved, 5);
  const by = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(by.followerReturn.weight, 3, 'follower return carries the most weight');
  assert.equal(by.followerReturn.points, 60, '−3 % median is the middle of the scale');
  assert.equal(by.followerWin.points, 60, '45 % follower win rate is the tape-wide best, mid-scale');
  assert.equal(by.reachable.points, 88, '80 % reachable: 50 + 30/40 of the last 50 points');
  assert.equal(by.consistency.value, '5 of 7');
  assert.equal(by.focus.points, 100, '20 trips over 20 coins is spread out');
  assert.deepEqual(s.flags, []);
  ok('a real record: every check resolved, weights as designed');
}

{
  const thin = scoreWallet({ ...base, roundTrips: 4, fTrips: 4 });
  assert.equal(thin.score, null, `under ${SCORE_MIN_TRIPS} trips there is no score`);
  assert.ok(thin.flags.includes('thin'));
  const unmeasured = scoreWallet({ ...base, fTrips: 2, fMedianReturnPct: null, fWinRatePct: null, windowDays: null });
  // reachable + focus resolve; follower return, win and consistency do not.
  assert.equal(unmeasured.resolved, 2);
  assert.equal(unmeasured.score, null, `under ${SCORE_MIN_RESOLVED} resolved checks there is no score`);
  const dayWindow = scoreWallet({ ...base, windowDays: null });
  assert.equal(dayWindow.checks.find((c) => c.id === 'consistency').resolved, false, 'consistency means nothing over one day');
  assert.ok(typeof dayWindow.score === 'number', 'but the other four still score');
  ok('honest null: thin records and unmeasured checks never become a number');
}

{
  const better = scoreWallet({ ...base, fMedianReturnPct: 2, fWinRatePct: 55, reachablePct: 95 });
  const worse = scoreWallet({ ...base, fMedianReturnPct: -15, fWinRatePct: 30, reachablePct: 40 });
  assert.ok(better.score > scoreWallet(base).score && scoreWallet(base).score > worse.score, 'monotone in the follower figures');
  const insider = scoreWallet({ ...base, roundTrips: 40, distinctMints: 4 });
  assert.ok(insider.flags.includes('concentrated'), 'ten trips per coin is a relationship, flagged');
  assert.ok(insider.score < scoreWallet({ ...base, roundTrips: 40, distinctMints: 30 }).score);
  const unjudged = scoreWallet({ ...base, judgedTrips: 0, reachablePct: null, fTrips: 0, fMedianReturnPct: null, fWinRatePct: null });
  assert.equal(unjudged.checks.find((c) => c.id === 'reachable').resolved, false, 'a record from before the model is not judged unreachable');
  assert.ok(!unjudged.flags.includes('unreachable'));
  const bot = scoreWallet({ ...base, looksAutomated: true, reachablePct: 5, fTrips: 1, fMedianReturnPct: null, fWinRatePct: null });
  assert.ok(bot.flags.includes('bot') && bot.flags.includes('unreachable'));
  assert.equal(bot.checks.find((c) => c.id === 'reachable').points, 5, 'a sniper\'s trips are not reachable');
  ok('better follower outcomes score higher; insiders and bots are flagged');
}

{
  const slice = scoreWallet({ ...base, roundTrips: 1_352, judgedTrips: 6, fTrips: 6, distinctMints: 3 });
  assert.ok(slice.flags.includes('partial'), 'six judged of 1,352 is a slice, and says so');
  assert.ok(slice.flags.includes('concentrated'));
  assert.ok(typeof slice.score === 'number', 'the number still stands');
  assert.ok(!scoreWallet(base).flags.includes('partial'), '20 judged of 20 is the whole record');
  assert.equal(scoreTone(null), null, 'no score is no colour');
  assert.equal(scoreTone(70), 'good');
  assert.equal(scoreTone(40), 'mid');
  assert.equal(scoreTone(39), 'bad');
  ok('score tones');
}

console.log(`\nwalletscore: ${passed}/${passed} passed`);
