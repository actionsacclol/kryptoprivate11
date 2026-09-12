// Potential-runner alerts: the verdict, the cap, and the honesty of the text.
import assert from 'node:assert';
import { ODDS_TAPE_CAP, markCreatorSold, regimeLine, FLAG_FORWARD_LINE, runnerVerdict, RunnerRateLimit, runnerNotification, bucketWithin, DEFAULT_RUNNER_ALERTS, RUNNER_TTL_MS, pruneRunners } from './.runners.mjs';

const report = (bucket, observedPct = 18, basePct = 2.2) => ({
  model: '2026-07-27',
  windowS: 60,
  regime: 'classic',
  graduate: { bucket, observedPct, n: 300, basePct, line: 'x' },
  mult3: null,
  mult5: null,
  footer: '',
  tradesSeen: 12,
});
const ctx = { hardRejected: false, creatorSold: false, alreadyFlagged: false };
const cfg = { ...DEFAULT_RUNNER_ALERTS };

{
  assert.equal(runnerVerdict(report('top1'), cfg, ctx).flag, true);
  assert.equal(runnerVerdict(report('top1_5'), cfg, ctx).flag, true, 'default floor is top 5 %');
  assert.equal(runnerVerdict(report('top5_10'), cfg, ctx).flag, false, 'top 5–10 % is below the default floor');
  assert.equal(runnerVerdict(report('top5_10'), { ...cfg, minBucket: 'top5_10' }, ctx).flag, true);
  assert.equal(runnerVerdict(report('top1'), { ...cfg, minBucket: 'top1' }, ctx).flag, true);
  assert.equal(runnerVerdict(report('top1_5'), { ...cfg, minBucket: 'top1' }, ctx).flag, false);
  console.log('ok  bucket floor: only buckets at or above the floor flag');
}
{
  assert.equal(runnerVerdict(report('top1'), cfg, { ...ctx, hardRejected: true }).flag, false, 'a hard reject never flags');
  assert.equal(runnerVerdict(report('top1'), cfg, { ...ctx, creatorSold: true }).flag, false, 'a creator sell never flags');
  assert.equal(runnerVerdict(report('top1'), cfg, { ...ctx, tapeTruncated: true }).flag, false, 'a truncated odds tape is unknown, never a flag');
  assert.equal(runnerVerdict(report('top1'), cfg, { ...ctx, nonSolQuote: true }).flag, false, 'a curve not quoted in SOL is never scored');
  assert.ok(ODDS_TAPE_CAP >= 5000, 'the odds tape holds at least 5,000 trades (600 zeroed the last-10-s rate on the hottest launches)');
  assert.equal(runnerVerdict(report('top1'), cfg, { ...ctx, alreadyFlagged: true }).flag, false, 'once per mint');
  assert.equal(runnerVerdict(null, cfg, ctx).flag, false, 'no report, no flag');
  assert.equal(runnerVerdict(report('top1'), { ...cfg, enabled: false }, ctx).flag, false, 'switch off');
  console.log('ok  rug rules and the switch override the odds');
}
{
  const rl = new RunnerRateLimit();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rl.allow(t0 + i, 3), true);
  assert.equal(rl.allow(t0 + 10, 3), false, 'fourth in the hour refused');
  assert.equal(rl.count(t0 + 10), 3);
  assert.equal(rl.allow(t0 + 3_600_001, 3), true, 'the window rolls');
  console.log('ok  rolling-hour cap');
}
{
  const f = {
    mint: 'M', name: 'Doge Two', symbol: 'DOGE2', creator: 'C', flaggedAt: 0, windowS: 60,
    bucket: 'top1_5', observedPct: 18, basePct: 2.2, n: 300, line: '', mult3Line: null,
    priceSol: 1e-7, curvePct: 14, uniqueBuyers: 11, netInflowSol: 3.4, tradesSeen: 20,
  };
  const { title, body } = runnerNotification(f);
  assert.match(title, /Potential runner: DOGE2/);
  assert.match(body, /18 % of these graduated/);
  assert.match(body, /base 2\.2 %/);
  assert.match(body, /82 % did not/);
  assert.match(body, /nothing is bought for you/);
  console.log('ok  the alert states the odds, the base rate, the odds against, and that it does not buy');
}
{
  assert.equal(bucketWithin('top1', 'top5_10'), true);
  assert.equal(bucketWithin('bottom50', 'top5_10'), false);
  console.log('ok  bucket ordering');
}
{
  const list = [{ mint: 'A', flaggedAt: 1000 }, { mint: 'B', flaggedAt: 1000 }];
  const marked = markCreatorSold(list, 'A', 5000);
  assert.ok(marked && marked !== list, 'marking returns a new list');
  assert.equal(marked[0].creatorSoldAt, 5000, 'the flagged mint carries the sell time');
  assert.equal(marked[1].creatorSoldAt, undefined, 'other flags untouched');
  assert.equal(markCreatorSold(marked, 'A', 9000), null, 'a second sell does not move the first mark');
  assert.equal(markCreatorSold(list, 'Z', 1), null, 'an unflagged mint changes nothing');
  console.log('ok  a creator sell after the flag is marked once, on that flag only');
}
{
  assert.ok(regimeLine('mixed') && regimeLine('mixed').includes('0.16 SOL'), 'a mixed flag says what its graduation is worth');
  assert.equal(regimeLine('classic'), null, 'a classic flag adds nothing');
  assert.equal(regimeLine(undefined), null, 'an unknown regime adds nothing');
  assert.ok(FLAG_FORWARD_LINE[60].includes('18 in 100 graduated') && FLAG_FORWARD_LINE[60].includes('2026-07-27'), 'the 60 s line names the day and the graduation rate');
  assert.equal(FLAG_FORWARD_LINE[120], null, 'the 120 s window has no honest line (n = 132)');
  console.log('ok  the flag carries its regime and the measured forward lines');
}
console.log('runners: all tests passed');

// ── Flags expire ──────────────────────────────────────────────────────
{
  const now = 1_000_000_000;
  const flags = [
    { mint: 'fresh', flaggedAt: now - 60_000 },
    { mint: 'edge', flaggedAt: now - (RUNNER_TTL_MS - 1) },
    { mint: 'stale', flaggedAt: now - RUNNER_TTL_MS },
    { mint: 'ancient', flaggedAt: now - 3_600_000 },
  ];
  const kept = pruneRunners(flags, now);
  assert.deepEqual(kept.map((f) => f.mint), ['fresh', 'edge'], 'only flags inside the window survive');
  assert.equal(pruneRunners([], now).length, 0, 'an empty list is fine');
  // Order is preserved: the page relies on newest-first staying newest-first.
  assert.equal(pruneRunners(flags, now)[0].mint, 'fresh');
  // Nothing is dropped when everything is fresh, so the engine can compare
  // lengths to decide whether a push is needed.
  const allFresh = [{ mint: 'a', flaggedAt: now }, { mint: 'b', flaggedAt: now - 1 }];
  assert.equal(pruneRunners(allFresh, now).length, allFresh.length);
  console.log('ok  a flag expires at the TTL and the order survives pruning');
}
