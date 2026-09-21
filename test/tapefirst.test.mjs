// The terminal tape is recorded BEFORE the order / alert / copy evaluation
// on every rail, and that evaluation is fenced (2026-09-20). A user
// reported the chart and its ticks freezing for a token the moment an
// order was set on it, until the order was cancelled. Both trade handlers
// used to record the tape AFTER evaluating orders, so anything thrown or
// stalled in there skipped the chart's record for every trade of that one
// mint. Read from source: the order of the two must never flip back.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const src = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
const from = (marker) => {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `engine.ts has ${marker}`);
  return i;
};

{
  // pump.fun curve trades: onTrade.
  const start = from('  private onTrade(ev: PumpTradeEvent, n: LogNotification): void {');
  const body = src.slice(start, start + 12_000);
  // The FIRST tape record is the untracked-mint early return; the second is
  // the main body's, and it must come before the first order tick.
  const firstTape = body.indexOf('this.recordTapeTrade(ev, n);');
  const mainTape = body.indexOf('this.recordTapeTrade(ev, n);', firstTape + 1);
  const orderTick = body.indexOf('advOrders.onTick({');
  assert.ok(firstTape > 0 && mainTape > firstTape && orderTick > 0, 'both records and the order tick are in onTrade');
  assert.ok(mainTape < orderTick, 'the tape is recorded before the orders evaluate');
  assert.ok(body.indexOf("this.noteEvalError('orders/alerts/copy', ev.mint, err);") > orderTick, 'the evaluation is fenced');
  assert.equal((body.match(/this\.recordTapeTrade\(ev, n\);/g) || []).length, 2, 'exactly two tape records (early return + main body) — not a duplicate');
  ok('curve trades: tape first, orders fenced');
}

{
  // PumpSwap swaps: the AMM handler.
  const start = from('      const mint = this.ammPoolToMint.get(event.pool);');
  const body = src.slice(start, start + 4_000);
  const tape = body.indexOf('tape.record(mint, {');
  const tick = body.indexOf('advOrders.onTick({ mint, priceSol, mcapUsd: null });');
  assert.ok(tape > 0 && tick > 0, 'both in the AMM handler');
  assert.ok(tape < tick, 'the tape is recorded before the orders evaluate');
  assert.ok(body.indexOf("this.noteEvalError('orders/alerts/copy', mint, err);") > tick, 'the evaluation is fenced');
  ok('graduated tokens: tape first, orders fenced');
}

{
  // The other rails already recorded the tape first; pin them too.
  for (const rail of ['boopWatcher.attach({', 'launchLabWatcher.attach({', 'dbcWatcher.attach({', 'raydiumWatcher.attach({']) {
    const start = from(rail);
    const body = src.slice(start, start + 3_000);
    const tape = body.indexOf('this.chartTicks.push(t.mint');
    const tick = body.indexOf('advOrders.onTick({ mint: t.mint');
    assert.ok(tape > 0 && tick > 0 && tape < tick, `${rail.replace('.attach({', '')}: chart tick before the order tick`);
  }
  ok('the four watcher rails tick the chart before the orders');
}

{
  const i = from('private noteEvalError(what: string, mint: string, err: unknown): void {');
  const body = src.slice(i, i + 1_200);
  assert.ok(/60_000/.test(body), 'at most once a minute per mint');
  assert.ok(/this\.log\('error'/.test(body), 'logged as an error, so it reaches the Console');
  ok('a throwing evaluation is a Console line, not a silent chart');
}

console.log(`\ntapefirst: ${passed}/${passed} passed`);
