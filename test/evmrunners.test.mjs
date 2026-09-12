// Runner calls on Robinhood and BNB — built from each chain's own records.
//
// This is the file where a leaderboard becomes a recommendation, so the rules
// pinned are the ones that stop it overclaiming: no rate without a sample, no
// flag without beating the chain's own base rate, and no launch counted as a
// failure before it has had time to succeed.

import assert from 'node:assert';
import {
  BUYER_BUCKETS,
  MIN_BUCKET_SAMPLES,
  baseRatePct,
  bucketOf,
  bucketRatePct,
  emptyModel,
  judge,
  DEFAULT_EVM_RUNNER_ALERTS,
  evmRunnerNotification,
  otherRatePct,
  wilsonLowerPct,
  wilsonUpperPct,
  evmRunnerVerdict,
} from './.evmrunners.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const model = (rows, chain = 'robinhood') => {
  const m = emptyModel(chain);
  for (const [bucket, settled, graduated] of rows) {
    const t = m.tallies.find((x) => x.bucket === bucket);
    t.settled = settled;
    t.graduated = graduated;
  }
  m.totalSettled = m.tallies.reduce((a, t) => a + t.settled, 0);
  m.totalGraduated = m.tallies.reduce((a, t) => a + t.graduated, 0);
  return m;
};

{
  assert.deepEqual([...BUYER_BUCKETS], [0, 1, 3, 6, 11, 21]);
  const cases = [
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 3],
    [5, 3],
    [6, 6],
    [10, 6],
    [11, 11],
    [20, 11],
    [21, 21],
    [500, 21],
  ];
  for (const [buyers, want] of cases) assert.equal(bucketOf(buyers), want, `${buyers} buyers lands in ${want}`);
  ok('buyer counts land in the bucket they belong to, including the edges');
}

{
  // A fresh chain knows nothing, and says so rather than showing 0%.
  const m = emptyModel('bnb');
  assert.equal(baseRatePct(m), null, 'no base rate before anything settles');
  assert.equal(bucketRatePct(m, 6), null, 'and no bucket rate');
  const call = judge(m, 8);
  assert.equal(call.flag, false);
  assert.equal(call.ratePct, null);
  assert.match(call.detail, /not enough yet/);
  ok('a chain with no records reports "not enough yet", never 0%');
}

{
  // Under the sample floor a bucket stays silent, however good it looks.
  const m = model([[6, MIN_BUCKET_SAMPLES - 1, MIN_BUCKET_SAMPLES - 1]]);
  assert.equal(bucketRatePct(m, 6), null, 'a 100% bucket under the floor still reports nothing');
  const call = judge(m, 7);
  assert.equal(call.flag, false, 'and cannot flag');
  assert.equal(call.samples, MIN_BUCKET_SAMPLES - 1, 'but the sample count is shown honestly');
  ok('a bucket under the sample floor never reports a rate, however flattering');
}

{
  // A measured bucket that does NOT beat the base rate is not a signal.
  const m = model([
    [0, 1000, 20],
    [6, 200, 4],
  ]);
  assert.equal(baseRatePct(m)?.toFixed(2), '2.00');
  const call = judge(m, 7);
  assert.equal(call.ratePct, 2, 'the bucket rate is measured');
  assert.equal(call.flag, false, 'but matching the base rate is not a call');
  assert.match(call.detail, /no better than/);
  ok('a bucket that only matches the base rate does not flag');
}

{
  // The real thing: measured, sampled, and better than the chain itself.
  const m = model([
    [0, 5000, 50],
    [21, 300, 45],
  ]);
  const call = judge(m, 30);
  assert.equal(call.bucket, 21);
  assert.equal(call.flag, true);
  assert.equal(call.ratePct, 15);
  assert.ok(call.baseRatePct !== null && call.baseRatePct < 15, 'it beats the base rate');
  assert.equal(call.samples, 300, 'and the sample travels with it');
  // Both numbers, always together — and the bar is every OTHER launch
  // (50 of 5,000 = 1.0 %), not the chain-wide base the bucket is part of.
  assert.match(call.detail, /15\.0% of 300/);
  assert.match(call.detail, /against 1\.0% \(at most 1\.\d%\) for every other launch/, 'the bar, and its ceiling');
  assert.equal(call.otherRatePct, 1);
  assert.ok(call.lowerPct !== null && call.lowerPct > 11 && call.lowerPct < 12, `the lower bound travels too (${call.lowerPct})`);
  ok('a flagged call carries its rate, its sample, its lower bound and the rate it beat');
}

{
  // The word that must never appear on its own.
  const m = model([
    [0, 5000, 50],
    [21, 300, 45],
  ]);
  for (const buyers of [0, 2, 4, 8, 15, 40]) {
    const d = judge(m, buyers).detail;
    assert.ok(!/\brunner\b/i.test(d), `no bare "runner" in: ${d}`);
    assert.ok(/graduated|not enough/.test(d), 'every call says what was measured');
  }
  ok('no call ever says "runner" — it says what was measured');
}

// ── The filter ─────────────────────────────────────────────────────────────
//
// A second, separate question from the measurement above: which of these
// calls is worth interrupting someone for. Everything below pins that the
// filter can only ever SUPPRESS — it never invents a reason to notify.

const alerts = (over = {}) => ({ ...DEFAULT_EVM_RUNNER_ALERTS, ...over });

{
  assert.equal(DEFAULT_EVM_RUNNER_ALERTS.requireBeatsBase, true, 'by default a call must beat the chain');
  assert.equal(DEFAULT_EVM_RUNNER_ALERTS.minBucket, 11, 'and start at 11+ buyers, not at the top bucket alone');
  ok('the defaults are the conservative ones');
}

{
  // Robinhood's real shape on 2026-09-11 13:33 UTC: 2,192 settled, 32
  // graduated, monotone across buckets. 21+ clears every other launch with
  // room to spare. 11–20 sits above the base on SIX graduations — a margin
  // of two — and the old rule (point estimate > chain-wide mean) flagged it.
  // It was the default alert floor. The audit that found it computed
  // P(X ≥ 6 | base) = 0.18 and a 95 % interval straddling the base; the
  // lower-bound rule agrees, and stays quiet.
  const m = model([
    [0, 335, 0],
    [1, 652, 0],
    [3, 381, 1],
    [6, 299, 2],
    [11, 268, 6],
    [21, 257, 23],
  ]);
  const top = judge(m, 30);
  assert.equal(top.flag, true, '21+ beats every other launch, even at its lower bound');
  assert.ok(top.lowerPct > 5.9 && top.lowerPct < 6.2, `21+ lower bound ≈ 6.0 % (${top.lowerPct})`);
  assert.ok(top.otherRatePct < 0.5, `every other launch graduates under 0.5 % (${top.otherRatePct})`);
  assert.equal(evmRunnerVerdict(top, alerts()).alert, true);
  assert.equal(evmRunnerVerdict(top, alerts({ minBucket: 21 })).alert, true, 'and clears the highest floor');

  const mid = judge(m, 15);
  assert.equal(mid.ratePct.toFixed(2), '2.24', 'the point estimate is above the base');
  assert.ok(mid.otherRatePct > 1.3 && mid.otherRatePct < 1.4, `every other launch: ≈1.35 % (${mid.otherRatePct})`);
  assert.ok(mid.lowerPct < mid.otherRatePct, 'but the lower bound is not');
  assert.equal(mid.flag, false, '11–20 does not flag on this record');
  assert.match(mid.detail, /inside the noise/);
  assert.equal(evmRunnerVerdict(mid, alerts()).alert, false, 'so the default floor raises nothing for it');
  assert.equal(evmRunnerVerdict(mid, alerts({ requireBeatsBase: false })).alert, true, 'unless the user drops the base-rate rule');
  assert.equal(evmRunnerVerdict(mid, alerts({ requireBeatsBase: false, minBucket: 21 })).alert, false, 'and the floor still excludes it');
  assert.match(evmRunnerVerdict(mid, alerts({ minBucket: 21 })).reason, /below the/);
  ok('a bucket above the base on a handful of graduations is inside the noise, and says so');
}

{
  // The bound itself, on numbers a reader can check.
  assert.equal(wilsonLowerPct(0, 0), null, 'an empty sample has no bound');
  assert.equal(wilsonLowerPct(0, 100), 0, 'no graduations: at least 0 %');
  const top = wilsonLowerPct(23, 257);
  assert.ok(top > 5.9 && top < 6.2, `23 of 257 → at least ≈6.0 % (${top})`);
  const mid = wilsonLowerPct(6, 268);
  assert.ok(mid > 0.9 && mid < 1.1, `6 of 268 → at least ≈1.0 % (${mid})`);
  assert.ok(wilsonLowerPct(100, 100) < 100, 'even a perfect record is not promised at 100 %');
  // And the bar: every launch outside the bucket.
  const m = model([[0, 1000, 10], [21, 200, 40]]);
  assert.equal(otherRatePct(m, 21), 1, 'the 21+ bar is the other 1,000 launches at 1 %');
  assert.equal(otherRatePct(m, 0), 20, 'and bucket 0 would have to beat the 21+ set');
  assert.equal(otherRatePct(model([[21, 200, 40]]), 21), null, 'a chain with nothing outside the bucket has no bar');
  ok('the lower bound and the bar are computed as stated');
}

{
  // A zero base is not a known zero. BNB on 2026-09-11 read 0 of 468
  // graduated; the first bucket to reach 100 launches with ONE graduation
  // would have cleared a 0 % point estimate and been announced. Its lower
  // bound (0.18 %) does not clear the other launches' ceiling (0.76 %).
  const m = model([[0, 500, 0], [21, 100, 1]]);
  const call = judge(m, 30);
  assert.equal(call.otherRatePct, 0);
  assert.ok(call.lowerPct > 0.1 && call.lowerPct < 0.3, `1 of 100 → at least ≈0.18 % (${call.lowerPct})`);
  const ceiling = wilsonUpperPct(0, 500);
  assert.ok(ceiling > 0.7 && ceiling < 0.8, `0 of 500 → at most ≈0.76 % (${ceiling})`);
  assert.equal(call.flag, false, 'one graduation against a zero base is inside the noise');
  assert.match(call.detail, /inside the noise/);
  // Ten of a hundred against the same zero base is a different matter.
  const strong = judge(model([[0, 500, 0], [21, 100, 10]]), 30);
  assert.ok(strong.lowerPct > 5, `10 of 100 → at least ≈5.5 % (${strong.lowerPct})`);
  assert.equal(strong.flag, true);
  ok('a bucket has to clear the ceiling of every other launch, not their point estimate');
}

{
  // A call that did not flag is never announced as a runner, even when the
  // user has asked to hear about every measured bucket.
  const m = model([[0, 5000, 500], [21, 300, 30]]);
  const even = judge(m, 40);
  assert.equal(even.flag, false);
  const { title } = evmRunnerNotification('Robinhood Chain', 'FLAT', '0xabcdef0123456789', even);
  assert.doesNotMatch(title, /runner/, 'the title does not say runner');
  assert.match(title, /not above base/);
  ok('a measured-but-not-better call is announced as exactly that');
}

{
  // Off means off, whatever the call says.
  const m = model([[0, 5000, 50], [21, 300, 45]]);
  const loud = judge(m, 40);
  assert.equal(loud.flag, true);
  assert.equal(evmRunnerVerdict(loud, alerts({ enabled: false })).alert, false);
  ok('switched off, even the strongest call raises nothing');
}

{
  // An unmeasured bucket can never alert. This is the rule that stops a
  // fresh install notifying on the first launch it ever sees.
  const m = model([[0, 5000, 50], [21, MIN_BUCKET_SAMPLES - 1, 40]]);
  const thin = judge(m, 40);
  assert.equal(thin.ratePct, null, 'the bucket is under the sample floor');
  for (const cfg of [alerts(), alerts({ requireBeatsBase: false }), alerts({ minBucket: 1 })]) {
    assert.equal(evmRunnerVerdict(thin, cfg).alert, false, 'and no setting can make it alert');
  }
  assert.match(evmRunnerVerdict(thin, alerts()).reason, /launches recorded/);
  ok('no configuration can produce an alert from a bucket with no measured rate');
}

{
  // Turning the base-rate rule off widens to every MEASURED bucket, and not
  // one launch further.
  const m = model([
    [0, 5000, 500],
    [21, 300, 30],
  ]);
  const even = judge(m, 40);
  assert.equal(even.flag, false, '10% against a 10% base is not a signal');
  assert.equal(evmRunnerVerdict(even, alerts({ minBucket: 21 })).alert, false);
  assert.equal(evmRunnerVerdict(even, alerts({ minBucket: 21, requireBeatsBase: false })).alert, true, 'the user asked for measured, not better');
  ok('relaxing the base-rate rule admits measured buckets only — never unmeasured ones');
}

{
  // The notification states the odds AND the odds against, like the Solana
  // one, and never a bare claim.
  const m = model([[0, 5000, 50], [21, 300, 45]]);
  const { title, body } = evmRunnerNotification('Robinhood Chain', 'TEST', '0xabcdef0123456789', judge(m, 40));
  assert.match(title, /Robinhood Chain/);
  assert.match(title, /TEST/);
  assert.match(body, /15 % of the 300|15% of the 300/, 'the rate and its sample');
  assert.match(body, /against 1\.0 % for every other launch/, 'the rate it was judged against');
  assert.match(body, /at least 11\.\d % with 95 % confidence/, 'and the bound it cleared');
  assert.match(body, /85 % did not|85% did not/, 'and the odds against');
  assert.match(body, /nothing is bought for you/i);
  ok('the notification carries the rate, the sample, the base and the failure rate');
}

{
  // A token with no symbol still reads as something: the address, shortened,
  // never an empty name.
  const m = model([[0, 5000, 50], [21, 300, 45]]);
  const { title } = evmRunnerNotification('BNB Smart Chain', '', '0xabcdef0123456789', judge(m, 40));
  assert.match(title, /0xabcdef/);
  ok('a nameless token is announced by its address, not by a blank');
}

console.log(`\nevmrunners: ${passed}/${passed} passed`);
