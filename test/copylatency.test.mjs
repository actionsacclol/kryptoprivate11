// Copy latency telemetry (2026-09-21).
//
// A tester watching a leader's wallet and their copy wallet side by side timed
// ~5–6 s from one fill to the other and asked which half was which. These are
// the rules the answer has to obey to be worth trusting: a stage that did not
// happen is never reported as zero, the median never invents a number, and the
// line reads as the path in the order it is walked.

import assert from 'node:assert';
import fs from 'node:fs';
import { accountedMs, copyLatency, describeCopyTiming } from './.copyshared.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};

/** A complete sample, on the read-back transport. */
const full = {
  feed: 'logs',
  detectMs: 900,
  readMs: 740,
  readTries: 2,
  decodeMs: 3,
  checkMs: 620,
  factsMs: 590,
  delayMs: 0,
  sendMs: 1400,
  buildMs: 210,
  confirmMs: 1050,
  totalMs: 3700,
};

{
  // The line reads as the path, in order, and names the read-back's retries.
  // A retry is time spent sleeping before a request is even sent, so the
  // count is what tells a reader whether `read` was one call or four.
  const line = describeCopyTiming(full);
  const at = (s) => line.indexOf(s);
  assert.ok(at('heard') < at('read'), 'hearing comes before reading');
  assert.ok(at('read') < at('decode'), 'reading before decoding');
  assert.ok(at('decode') < at('checks'), 'decoding before the checks');
  assert.ok(at('checks') < at('order'), 'the checks before the order');
  assert.match(line, /2 tries/, 'the retry count is on the line');
  assert.match(line, /token facts/, 'and the one stage that makes a network call is named');
  assert.match(line, /3\.70s their fill → ours/, 'the headline is the number the tester was timing');
  assert.match(line, /via logs/, 'and the transport, because it changes what the numbers mean');
  ok('the breakdown reads as the path, in order, with the retries and the lookup named');
}

{
  // A stage that DID NOT HAPPEN is left out, never printed as zero. On the
  // `tx` transport there is no read-back at all; in paper there is no order.
  const tx = { ...full, feed: 'tx', readMs: null, readTries: 0 };
  const line = describeCopyTiming(tx);
  assert.doesNotMatch(line, /read /, 'no read-back stage when there was no read-back');
  assert.match(line, /via tx/);

  const paper = { ...full, sendMs: null, buildMs: null, confirmMs: null };
  assert.doesNotMatch(describeCopyTiming(paper), /order /, 'paper has no order to report');

  // And an unknown TOTAL does not become a made-up one.
  const undated = { ...full, totalMs: null };
  assert.doesNotMatch(describeCopyTiming(undated), /their fill/, 'no total when the leader trade was undated');
  assert.match(describeCopyTiming(undated), /^timing/, 'it says so rather than printing 0.00s');
  ok('a stage that did not happen is absent, never a zero');
}

{
  // A configured delay is the follower's own choice, so it is only mentioned
  // when it is non-zero — it is not a cost anyone should try to fix.
  assert.doesNotMatch(describeCopyTiming(full), /your delay/, 'a zero delay is not mentioned');
  assert.match(describeCopyTiming({ ...full, delayMs: 500 }), /your delay 500ms/);
  ok('the configured delay is named only when it was set');
}

{
  // What the record accounts for is every stage but the chain's own, so the
  // difference against the total is what the breakdown does NOT explain.
  assert.equal(accountedMs(full), 740 + 3 + 620 + 0 + 1400);
  // factsMs sits INSIDE checkMs and must not be counted twice.
  assert.equal(accountedMs({ ...full, factsMs: 999999 }), accountedMs(full), 'the token lookup is inside the checks');
  assert.equal(accountedMs({ detectMs: null, readMs: null, decodeMs: null, checkMs: null, factsMs: null, delayMs: null, sendMs: null, totalMs: null }), 0);
  ok('the accounted total covers every stage once, and the lookup is not double-counted');
}

{
  // The median. Not a mean: one copy that waited out a parked endpoint would
  // drag an average somewhere no copy ever was.
  const rows = [100, 120, 130, 140, 10_000].map((n) => ({ ...full, sendMs: n }));
  const l = copyLatency(rows);
  assert.equal(l.sendMs, 130, 'the outlier does not move the median');
  assert.equal(l.samples, 5);
  assert.equal(l.feeds.logs, 5);
  assert.equal(l.feeds.tx, 0);

  // An even count averages the middle two.
  assert.equal(copyLatency([{ ...full, sendMs: 100 }, { ...full, sendMs: 200 }]).sendMs, 150);
  ok('each stage is a median, so one parked endpoint cannot move it');
}

{
  // Nothing measured is null, not zero — the same rule as the line, because a
  // panel reading "0ms" for a stage nobody timed is a claim, not a blank.
  const empty = copyLatency([]);
  assert.equal(empty.samples, 0);
  for (const k of ['detectMs', 'readMs', 'decodeMs', 'checkMs', 'factsMs', 'delayMs', 'sendMs', 'totalMs']) {
    assert.equal(empty[k], null, `${k} with no samples is null`);
  }
  // And a stage missing from EVERY sample stays null even when others are not.
  const noRead = copyLatency([{ ...full, readMs: null }, { ...full, readMs: null }]);
  assert.equal(noRead.readMs, null, 'a run with no read-backs reports none');
  assert.equal(noRead.sendMs, full.sendMs, 'while the stages that did happen still report');
  // A stage missing from SOME samples is the median of the ones that have it.
  assert.equal(copyLatency([{ ...full, readMs: null }, { ...full, readMs: 500 }]).readMs, 500);
  ok('an unmeasured stage is null across the summary, never a zero');
}

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // A RECOVERED transaction is one the watcher fetched after a socket gap: it
  // can be minutes old through no fault of the delivery path, and timing it
  // would make the feed look far worse than it is.
  const ww = src('../electron/engine/walletWatcher.ts');
  assert.match(ww, /detectMs: recovered \|\| tradeAt === null \? null :/, 'a recovered trade is not timed');
  // The read-back is measured from before the FIRST attempt, so the backoff
  // between retries is inside the number rather than hidden between them.
  const readStart = ww.indexOf('const readStart = Date.now()');
  const loop = ww.indexOf('for (let attempt = 0; attempt < FETCH_ATTEMPTS');
  assert.ok(readStart > 0 && readStart < loop, 'the read clock starts before the retry loop, not inside it');
  assert.match(ww, /readTries: attempt \+ 1/, 'and the attempt count is reported');
  ok('the watcher times the whole read-back and refuses to time a recovered trade');
}

{
  // Every copy reports, including a FAILED one — a copy that failed slowly is
  // the most interesting row in a latency benchmark, and logging only the
  // successes would hide exactly those.
  const ct = src('../electron/engine/copyTrade.ts');
  const report = ct.indexOf('reportTiming(timing, \'live\')');
  const okBranch = ct.indexOf('if (res.ok || res.pending === true)');
  assert.ok(report > 0 && okBranch > 0 && report < okBranch, 'the live timing is reported before the outcome is branched on');
  assert.match(ct, /reportTiming\(paperTiming, 'paper'\)/, 'paper copies are timed too — the detection half costs the same');
  // The send clock wraps the order and nothing else.
  assert.match(ct, /const sendStart = Date\.now\(\);\n\s*const res = await h\.buy\(/, 'the send clock starts immediately before the buy');
  ok('every copy is timed, paper and live, and a failure is reported too');
}

{
  // ── The two things actually made faster (2026-09-21) ──
  //
  // 1. The read-back's FIRST gap. A transaction the socket just told us about
  // is confirmed; the node has simply not indexed it, which takes tens of
  // milliseconds. The old schedule slept 700 ms before asking again, putting
  // most of a second in the middle of every copy on the `logs` transport.
  const ww = src('../electron/engine/walletWatcher.ts');
  const m = /const FETCH_BACKOFF_MS = \[([^\]]+)\]/.exec(ww);
  assert.ok(m, 'the gaps are an explicit schedule, not a formula to re-derive');
  const gaps = m[1].split(',').map((s) => Number(s.trim().replace(/_/g, '')));
  assert.ok(gaps.every((n) => Number.isFinite(n) && n > 0), `every gap is a real number: ${m[1]}`);
  assert.ok(gaps[0] <= 200, `the first gap is short — a just-confirmed tx is milliseconds away, not ${gaps[0]}ms`);
  assert.ok(
    gaps.every((n, i) => i === 0 || n >= gaps[i - 1]),
    'and the schedule only ever grows, so a genuinely missing transaction is still chased patiently',
  );
  assert.ok(gaps[gaps.length - 1] >= 2_000, 'the tail keeps real patience — an exit decision is worth waiting for');
  // The patience that matters is the number of attempts, which is unchanged.
  assert.match(ww, /const FETCH_ATTEMPTS = 6;/, 'six attempts, as before');
  assert.equal(gaps.length, 5, 'one gap between each pair of attempts');
  ok('the read-back asks again quickly, then backs off — six attempts either way');
}

{
  // 2. The token lookup is a network round trip on a mint nothing has seen,
  // and it used to be paid whether or not a filter read the answer. Every
  // filter that reads `facts` MUST be named in needsFacts: one left out would
  // be checked against an empty object and, because filters fail closed,
  // would refuse every copy.
  const ct = src('../electron/engine/copyTrade.ts');
  const fn = ct.slice(ct.indexOf('function needsFacts'), ct.indexOf('const NO_FACTS'));
  assert.ok(fn.length > 0, 'needsFacts exists');
  // Pulled from the filter block itself: every config field tested against a
  // `facts.` value has to appear in needsFacts.
  const body = ct.slice(ct.indexOf('async function copyOnce'), ct.indexOf('// Live.'));
  const guarded = new Set();
  for (const mm of body.matchAll(/if \(c\.(\w+) !== null\)|if \(c\.(\w+) &&|if \(c\.(\w+)\)/g)) {
    const name = mm[1] || mm[2] || mm[3];
    if (name) guarded.add(name);
  }
  // Only the ones whose branch actually reads a fact.
  for (const name of guarded) {
    const start = body.indexOf(`c.${name}`);
    const branch = body.slice(start, start + 500);
    if (!/facts\./.test(branch)) continue;
    assert.ok(fn.includes(name), `needsFacts must list ${name} — its filter reads the token facts and fails closed`);
  }
  assert.match(ct, /if \(needsFacts\(c\)\) \{/, 'and the lookup is behind it');
  assert.match(ct, /let factsMs: number \| null = null;/, 'an unmade lookup is null, not a zero');
  ok('the token lookup is skipped only when no filter reads it, and every such filter is listed');
}

console.log(`\ncopylatency: ${passed}/${passed} passed`);
