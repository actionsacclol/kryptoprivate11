// Potential-runner alerts: the verdict, the cap, and the honesty of the text.
import assert from 'node:assert';
import fs from 'node:fs';
import { ODDS_TAPE_CAP, markCreatorSold, regimeLine, FLAG_FORWARD_LINE, runnerVerdict, RunnerRateLimit, runnerNotification, bucketWithin, DEFAULT_RUNNER_ALERTS, RUNNER_TTL_MS, pruneRunners, windowAllowed, describeRunnerFilters } from './.runners.mjs';

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
  // Mixed curves flag by default — they are most flags — and only the
  // setting skips them; an unknown regime is never treated as mixed.
  assert.equal(DEFAULT_RUNNER_ALERTS.excludeMixed, false, 'off by default');
  assert.equal(runnerVerdict({ ...report('top1'), regime: 'mixed' }, cfg, { ...ctx, regime: 'mixed' }).flag, true);
  const skip = { ...cfg, excludeMixed: true };
  assert.equal(runnerVerdict({ ...report('top1'), regime: 'mixed' }, skip, { ...ctx, regime: 'mixed' }).flag, false, 'the switch skips a mixed curve');
  assert.match(runnerVerdict({ ...report('top1'), regime: 'mixed' }, skip, { ...ctx, regime: 'mixed' }).reason, /mixed curve/);
  assert.equal(runnerVerdict(report('top1'), skip, { ...ctx, regime: 'classic' }).flag, true, 'and keeps a classic one');
  assert.equal(runnerVerdict(report('top1'), skip, { ...ctx, regime: 'unknown' }).flag, true, 'unknown is not mixed');
  assert.equal(runnerVerdict(report('top1'), skip, ctx).flag, true, 'no regime given: not mixed');
  console.log('ok  mixed curves flag unless the setting skips them');
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

// ── The user's own filters (2026-09-20) ───────────────────────────────
// Every one is off by default, applies only when the fact is known, and
// says which setting refused the launch.
{
  assert.equal(DEFAULT_RUNNER_ALERTS.windows, 'both');
  assert.equal(DEFAULT_RUNNER_ALERTS.minBuyers, 0);
  assert.equal(DEFAULT_RUNNER_ALERTS.minNetSol, 0);
  assert.equal(DEFAULT_RUNNER_ALERTS.minCurvePct, 0);
  assert.equal(DEFAULT_RUNNER_ALERTS.maxCurvePct, 100);
  assert.equal(DEFAULT_RUNNER_ALERTS.skipRepeatDumpers, false);
  const full = { ...ctx, windowS: 60, uniqueBuyers: 3, netInflowSol: 0.4, curvePct: 2, creatorPriorDumps: 2 };
  assert.equal(runnerVerdict(report('top1'), cfg, full).flag, true, 'the defaults filter nothing');
  console.log('ok  the user filters are all off by default');
}
{
  assert.equal(windowAllowed(cfg, 60), true);
  assert.equal(windowAllowed(cfg, 120), true);
  assert.equal(windowAllowed({ windows: '60' }, 120), false);
  assert.equal(windowAllowed({ windows: '120' }, 60), false);
  assert.equal(windowAllowed({ windows: '120' }, 120), true);
  assert.equal(windowAllowed({}, 120), true, 'absent = both');
  const only120 = { ...cfg, windows: '120' };
  assert.equal(runnerVerdict(report('top1'), only120, { ...ctx, windowS: 60 }).flag, false);
  assert.match(runnerVerdict(report('top1'), only120, { ...ctx, windowS: 60 }).reason, /\+60 s window is off/);
  assert.equal(runnerVerdict(report('top1'), only120, { ...ctx, windowS: 120 }).flag, true);
  assert.equal(runnerVerdict(report('top1'), only120, ctx).flag, true, 'no window given: not a window question');
  console.log('ok  a judge window the user turned off never flags, and the other still does');
}
{
  const floor = { ...cfg, minBuyers: 8, minNetSol: 2 };
  assert.equal(runnerVerdict(report('top1'), floor, { ...ctx, uniqueBuyers: 7, netInflowSol: 5 }).flag, false);
  assert.match(runnerVerdict(report('top1'), floor, { ...ctx, uniqueBuyers: 7, netInflowSol: 5 }).reason, /7 buyers, under the 8 floor/);
  assert.equal(runnerVerdict(report('top1'), floor, { ...ctx, uniqueBuyers: 8, netInflowSol: 1.99 }).flag, false);
  assert.match(runnerVerdict(report('top1'), floor, { ...ctx, uniqueBuyers: 8, netInflowSol: 1.99 }).reason, /1\.99 SOL net, under the 2 SOL floor/);
  assert.equal(runnerVerdict(report('top1'), floor, { ...ctx, uniqueBuyers: 8, netInflowSol: 2 }).flag, true, 'floors are inclusive');
  assert.equal(runnerVerdict(report('top1'), floor, ctx).flag, true, 'unknown counts are never a reason to hide a launch');
  console.log('ok  buyer and net-SOL floors refuse thin launches and never unknown ones');
}
{
  const band = { ...cfg, minCurvePct: 5, maxCurvePct: 60 };
  assert.equal(runnerVerdict(report('top1'), band, { ...ctx, curvePct: 4.9 }).flag, false);
  assert.equal(runnerVerdict(report('top1'), band, { ...ctx, curvePct: 60.1 }).flag, false);
  assert.match(runnerVerdict(report('top1'), band, { ...ctx, curvePct: 60.1 }).reason, /outside 5–60 %/);
  assert.equal(runnerVerdict(report('top1'), band, { ...ctx, curvePct: 5 }).flag, true);
  assert.equal(runnerVerdict(report('top1'), band, { ...ctx, curvePct: 60 }).flag, true);
  assert.equal(runnerVerdict(report('top1'), band, ctx).flag, true, 'unknown progress: not refused');
  console.log('ok  the supply-sold band is inclusive and ignores an unknown');
}
{
  const skip = { ...cfg, skipRepeatDumpers: true };
  assert.equal(runnerVerdict(report('top1'), skip, { ...ctx, creatorPriorDumps: 1 }).flag, false);
  assert.match(runnerVerdict(report('top1'), skip, { ...ctx, creatorPriorDumps: 1 }).reason, /creator dumped 1 earlier launch \(/);
  assert.match(runnerVerdict(report('top1'), skip, { ...ctx, creatorPriorDumps: 3 }).reason, /3 earlier launches/);
  assert.equal(runnerVerdict(report('top1'), skip, { ...ctx, creatorPriorDumps: 0 }).flag, true, 'no dump on record');
  assert.equal(runnerVerdict(report('top1'), skip, { ...ctx, creatorPriorDumps: null }).flag, true, 'no record is not a dump');
  assert.equal(runnerVerdict(report('top1'), cfg, { ...ctx, creatorPriorDumps: 5 }).flag, true, 'off by default');
  console.log('ok  repeat dumpers are skipped only by choice, and only on a real record');
}
{
  assert.deepEqual(describeRunnerFilters(cfg), [], 'defaults: nothing but the floor');
  const phrases = describeRunnerFilters({ ...cfg, windows: '60', minBuyers: 8, minNetSol: 2, minCurvePct: 5, maxCurvePct: 60, excludeMixed: true, skipRepeatDumpers: true });
  assert.deepEqual(phrases, ['+60 s only', '≥ 8 buyers', '≥ 2 SOL net', '5–60 % of supply sold', 'no mixed curves', 'no repeat dumpers']);
  console.log('ok  the filter summary names each active filter and nothing else');
}
{
  // Where the controls live. The runner-alert tuning moved from the
  // Strategy page (beside the paper-entry gates, which read as if they
  // decided the flags) to the Execution page, next to the mayhem filter;
  // the auto-buy leftovers left the Execution page with it.
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const execution = src('../src/pages/Execution.tsx');
  const strategy = src('../src/pages/Strategy.tsx');
  for (const key of ['minBucket', 'windows', 'minBuyers', 'minNetSol', 'minCurvePct', 'maxCurvePct', 'excludeMixed', 'skipRepeatDumpers', 'maxPerHour', 'mayhemFilter']) {
    assert.ok(execution.includes(key), `Execution page sets ${key}`);
    assert.ok(!strategy.includes(key), `Strategy page no longer sets ${key}`);
  }
  assert.ok(!/Paper send plans|recentPlans|would-be snipe/.test(execution), 'no auto-buy leftovers on the Execution page');
  assert.ok(/Nothing on this page buys/.test(execution) && /Nothing on this page buys/.test(strategy), 'both pages say so');
  assert.ok(/Execution page/.test(src('../src/pages/Runners.tsx')), 'the Runners tab points at the Execution page');
  assert.ok(!/Spellbook|Grimoire/.test(src('../src/components/Sidebar.tsx')), 'plain names in the sidebar');
  console.log('ok  runner tuning lives on the Execution page and the auto-buy leftovers are gone');
}
