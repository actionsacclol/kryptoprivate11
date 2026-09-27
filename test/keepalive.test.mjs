// Launch updates outlive the decision when something needs them, and the
// Hub's Automation card counts running scripts (two user reports,
// 2026-09-20). Read from source, like tapefirst: the rule is an ordering and
// a gate inside a 6,000-line class, and the harness for the whole engine is
// the live app.
//
// Report 1: "My script receives runner events, but many candidates receive
// no subsequent launchUpdate events before their entry window expires … 40
// tick events but zero launchUpdate." The strategy decides a launch after
// its evaluation window (15 s by default) and the trade handler then stopped
// reading it unless a position held it; runner flags arrive at +60/+120 s.
// Report 2: a paper script was running and the Hub said "Nothing running".

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

{
  const src = read('../electron/engine/engine.ts');
  const start = src.indexOf('  private onTrade(ev: PumpTradeEvent, n: LogNotification): void {');
  assert.ok(start > 0, 'onTrade is where it was');
  const body = src.slice(start, start + 16_000);
  const gate = body.indexOf('const kept = held || this.runnerFlagged(ev.mint, n.receivedAt) || this.ticksWanted(ev.mint);');
  assert.ok(gate > 0, 'a decided launch is kept alive by a position, a runner flag, a tape subscription or a script following it');
  assert.ok(body.indexOf('if (t.decided && !kept) {') > gate, 'and the fast-path return tests that, not the position alone');
  assert.ok(!/if \(t\.decided && !held\) \{/.test(body), 'the old position-only gate is gone');
  const refresh = body.indexOf('this.pushLaunchThrottled(t, true);');
  assert.ok(refresh > gate, 'a kept decided launch re-reads its flow on the push');
  assert.ok(/private pushLaunchThrottled\(t: TrackedToken, refresh = false\): void \{[\s\S]{0,300}if \(refresh\) this\.refreshFlow\(t\);/.test(src), 'the throttled push refreshes only when a push actually goes out');
  assert.ok(/private runnerFlagged\(mint: string, now: number\): boolean \{[\s\S]{0,200}RUNNER_TTL_MS/.test(src), 'a runner flag keeps a launch alive for its TTL, not forever');
  assert.ok(/this\.positions\.hasOpenFor\(mint\) \|\| this\.runnerFlagged\(mint, Date\.now\(\)\)/.test(src), 'eviction past the launch cap spares a flagged runner like a held position');
  ok('a flagged, held or subscribed launch keeps its flow and launch updates after the decision');
}

{
  // Scripts follow coins WITHOUT taking the terminal's tape slots (2026-09-27).
  // The tape keeps eight, least-recently-touched evicted; a script watching
  // forty runners evicted the chart the user had open and got ticks for at
  // most eight of its own coins.
  const src = read('../electron/engine/engine.ts');
  const has = (text, s) => text.includes(s);
  assert.ok(has(src, 'private ticksWanted(mint: string): boolean {\n    return tape.isSubscribed(mint) || automation.wantsTicks(mint);'), 'ticks are wanted by a tape subscription OR a script');
  assert.ok(has(src, 'isOpen: (mint) => this.ticksWanted(mint)'), 'the chart-tick throttle lets script-followed mints through');
  assert.equal(src.split('if (this.ticksWanted(ev.mint)) this.recordTapeTrade(ev, n);').length - 1, 2, 'both curve-trade paths tick for a script-followed mint');
  assert.ok(!has(src, 'subscribeTicks: (mint) => tape.subscribe(mint)'), 'a script never takes a tape slot');
  const ipc = read('../electron/ipc.ts');
  assert.ok(has(ipc, "if (ev.kind !== 'tick' || tape.isSubscribed(ev.mint)) broadcast(ev);"), 'and a script-only tick is not sent to the window');
  ok('scripts follow coins through their own interest set, not the terminal tape');
}

{
  const ref = read('../shared/automation.ts');
  // Tolerates the entry being one line or several: it was reformatted when
  // "THE SCORE DOES NOT CHANGE" was moved to the front of the sentence
  // (2026-09-21), and a regex that only matched one line failed on wording it
  // was never meant to police.
  const row = /event: 'launchUpdate'[\s\S]{0,600}?when:\s*'([^']+)'/.exec(ref)?.[1] ?? '';
  assert.ok(row.length > 0, 'the launchUpdate entry is findable whatever shape it is written in');
  assert.ok(/flagged runner/.test(row) && /bot\.subscribe/.test(row) && /15 s/.test(row), `the script reference says when launchUpdate flows and how to keep it flowing: "${row.slice(0, 120)}"`);
  const doc = read('../docs/user-scripting.md');
  assert.ok(/bot\.subscribe\(mint\)/.test(doc) && /15 min/.test(doc), 'the doc says the same');
  ok('the reference and the doc name the rule and the supported way to keep updates coming');
}

{
  const hub = read('../src/pages/Hub.tsx');
  assert.ok(/window\.krypt\.automation\s*\.list\(\)/.test(hub), 'the Hub reads the scripts');
  assert.ok(/r\.data\.killSwitch \? 0 :/.test(hub), 'a kill switch counts as nothing running');
  assert.ok(/script\$\{scripts\.running === 1 \? '' : 's'\} running/.test(hub), 'and says how many run');
  assert.ok(/\(paper\)/.test(hub), 'a paper-only run is labelled paper');
  // Krypto Trader sessions joined the card on 2026-09-25: still a dash only when NOTHING could be read.
  assert.ok(/if \(copyCount === null && scripts === null && traders === null\) return \{ line: '—'/.test(hub), 'the em dash only when none could be read');
  ok('the Hub Automation card counts running scripts, paper or live');
}

console.log(`\nkeepalive: ${passed}/${passed} passed`);
