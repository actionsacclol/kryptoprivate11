// The replay planner. Both failure modes it guards against are silent in a
// rendered animation: an interval too fine to reach the trade at all, and
// one so coarse the trade is two candles.
import assert from 'node:assert';
import {
  INTERVAL_SECONDS,
  frameCount,
  pickInterval,
  priceRange,
  replayWindow,
  revealCount,
  runningPnl,
  trimCandles,
  anchorCandlesToEntry,
  pickSyntheticInterval,
  syntheticCandles,
  tradePrices,
} from './.replayplan.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = 1_700_000_000_000;

{
  // A trade that just closed: the finest interval reaches it.
  assert.equal(pickInterval(now - 3 * MIN, now - MIN, now), '1s');
  // Four hours ago: 1s cannot reach back, a coarser one must.
  const iv = pickInterval(now - 4 * HOUR, now - 4 * HOUR + 5 * MIN, now);
  assert.ok(INTERVAL_SECONDS[iv] >= 60, `expected a minute or coarser, got ${iv}`);
  // Whatever it picks must actually cover the span within the request cap.
  for (const agoHours of [0.1, 1, 4, 24, 24 * 30]) {
    const opened = now - agoHours * HOUR;
    const chosen = pickInterval(opened, opened + MIN, now);
    const needed = (now - opened) / 1000 / INTERVAL_SECONDS[chosen];
    assert.ok(needed <= 600, `${agoHours}h ago: ${chosen} needs ${Math.round(needed)} candles`);
  }
  console.log('ok  the interval always reaches back to the trade');
}

{
  const w = replayWindow(now - 10 * MIN, now - 5 * MIN);
  const openSec = Math.floor((now - 10 * MIN) / 1000);
  const closeSec = Math.floor((now - 5 * MIN) / 1000);
  assert.ok(w.fromSec < openSec, 'there is room before the entry');
  assert.ok(w.toSec > closeSec, 'there is room after the exit');
  // A ten-second scalp still gets a usable margin.
  const tiny = replayWindow(now, now + 10_000);
  assert.ok(tiny.toSec - tiny.fromSec >= 70, 'a very short hold is still padded');
  console.log('ok  the window frames the hold with room either side');
}

{
  const candles = Array.from({ length: 10 }, (_, i) => ({ time: 1000 + i * 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }));
  const kept = trimCandles(candles, { fromSec: 1120, toSec: 1300 });
  assert.deepEqual(kept.map((c) => c.time), [1120, 1180, 1240, 1300]);
  assert.deepEqual(trimCandles([], { fromSec: 0, toSec: 10 }), []);
  console.log('ok  only candles inside the window are replayed');
}

{
  assert.equal(revealCount(0, 50), 1, 'the first frame is never an empty chart');
  assert.equal(revealCount(1, 50), 50);
  assert.equal(revealCount(0.5, 50), 25);
  assert.equal(revealCount(2, 50), 50, 'progress past the end clamps');
  assert.equal(revealCount(-1, 50), 1);
  assert.equal(revealCount(0.5, 0), 0, 'no candles, nothing revealed');
  console.log('ok  the reveal never runs past either end');
}

{
  const p = runningPnl(0.002, 0.001, 0.5);
  assert.ok(p !== null);
  assert.ok(Math.abs(p.pct - 100) < 1e-9, `doubled → +100 %, got ${p.pct}`);
  assert.ok(Math.abs(p.sol - 0.5) < 1e-9, `0.5 SOL doubled → +0.5 SOL, got ${p.sol}`);
  const half = runningPnl(0.0005, 0.001, 0.5);
  assert.ok(half !== null && half.pct === -50 && Math.abs(half.sol + 0.25) < 1e-9);
  // Unknowable is null, never zero and never a guess.
  assert.equal(runningPnl(0.001, null, 0.5), null);
  assert.equal(runningPnl(0.001, 0, 0.5), null);
  assert.equal(runningPnl(0.001, 0.001, 0), null);
  assert.equal(runningPnl(0, 0.001, 0.5), null);
  console.log('ok  the running PnL is right, and null when it cannot be known');
}

{
  const r = priceRange([
    { time: 1, open: 1, high: 3, low: 1, close: 2, volume: 0 },
    { time: 2, open: 2, high: 4, low: 0.5, close: 3, volume: 0 },
  ]);
  assert.ok(r.min < 0.5 && r.max > 4, 'the extremes are padded off the edges');
  const flat = priceRange([{ time: 1, open: 2, high: 2, low: 2, close: 2, volume: 0 }]);
  assert.ok(flat.max > flat.min, 'a flat series still has a drawable range');
  const empty = priceRange([]);
  assert.ok(empty.max > empty.min, 'an empty series does not divide by zero');
  console.log('ok  the price scale is always drawable');
}

{
  assert.equal(frameCount(10, 60), 600);
  assert.equal(frameCount(0, 60), 1);
  assert.equal(frameCount(1e9, 60), 3600, 'the frame count is bounded');
  console.log('ok  the frame count is bounded at both ends');
}
// ── Units: USD history is scaled to SOL at the entry fill ─────────────
{
  // A +300 % trade: bought at 0.000001 SOL, sold at 0.000004. The history
  // comes back in USD at SOL = $150, so every close is 150× the SOL price.
  const opened = now - 10 * MIN;
  const closed = now - 2 * MIN;
  const usd = [];
  for (let i = 0; i < 20; i++) {
    const t = Math.floor(opened / 1000) - 60 + i * 60;
    const sol = 0.000001 * (1 + (3 * Math.max(0, i - 1)) / 18); // 1× at the entry candle (i = 1), 4× at the end
    const p = sol * 150;
    usd.push({ time: t, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 0 });
  }
  const before = runningPnl(usd[usd.length - 1].close, 0.000001, 0.5);
  assert.ok(before.pct > 30_000, 'the raw comparison is the 40,000 % bug: ' + before.pct.toFixed(0));
  const a = anchorCandlesToEntry(usd, opened, 0.000001);
  assert.equal(a.anchored, true);
  const atEntry = a.candles.filter((c) => c.time <= Math.floor(opened / 1000)).pop();
  assert.ok(Math.abs(atEntry.close - 0.000001) < 1e-15, 'the candle at the entry closes at the entry price');
  const after = runningPnl(a.candles[a.candles.length - 1].close, 0.000001, 0.5);
  assert.ok(Math.abs(after.pct - 300) < 1e-6, 'the running PnL at the end is the real +300 %: ' + after.pct);
  assert.ok(Math.abs(after.sol - 1.5) < 1e-9, 'and +1.5 SOL on a 0.5 SOL position');
  // Wicks scale with the closes; nothing else changes.
  assert.equal(a.candles.length, usd.length);
  assert.ok(a.candles.every((c, i) => Math.abs(c.high / c.close - usd[i].high / usd[i].close) < 1e-9));
  // Nothing to anchor on: unchanged, and said so.
  assert.equal(anchorCandlesToEntry(usd, opened, null).anchored, false);
  assert.equal(anchorCandlesToEntry([], opened, 0.000001).anchored, false);
  console.log('ok  USD history is anchored to the SOL entry price');
}

// ── A trade with no history gets a path pinned to its real fills ───────
{
  const trade = { mint: 'MintA', openedAt: now - 30 * MIN, closedAt: now - 5 * MIN, entryPriceSol: 0.00002, exitPriceSol: 0.00008, pnlPct: 300 };
  const iv = pickSyntheticInterval(trade.openedAt, trade.closedAt);
  const a = syntheticCandles(trade, iv);
  const b = syntheticCandles(trade, iv);
  assert.ok(a && a.length >= 12, 'enough candles to animate: ' + (a ? a.length : 'null'));
  assert.deepEqual(a, b, 'seeded from the trade: the same trade always draws the same path');
  assert.notDeepEqual(a, syntheticCandles({ ...trade, mint: 'MintB' }, iv), 'a different trade draws a different path');
  const step = INTERVAL_SECONDS[iv];
  for (let i = 1; i < a.length; i++) assert.equal(a[i].time - a[i - 1].time, step, 'evenly spaced');
  for (const c of a) {
    assert.ok(c.low > 0 && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close), 'a well-formed candle');
  }
  const openSec = Math.floor(trade.openedAt / 1000);
  const closeSec = Math.floor(trade.closedAt / 1000);
  const atEntry = a.filter((c) => c.time <= openSec).pop();
  const atExit = a.filter((c) => c.time <= closeSec).pop();
  assert.equal(atEntry.close, 0.00002, 'starts at the real entry price');
  assert.equal(atExit.close, 0.00008, 'ends at the real exit price');
  assert.ok(a[0].time < openSec && a[a.length - 1].time > closeSec, 'context either side of the hold');
  const pnlAtExit = runningPnl(atExit.close, trade.entryPriceSol, 1);
  assert.ok(Math.abs(pnlAtExit.pct - 300) < 1e-9, 'the running PnL at the exit is the realised +300 %');
  // One fill price missing: rebuilt from the other and the realised percent.
  assert.deepEqual(tradePrices({ entryPriceSol: 0.00002, exitPriceSol: null, pnlPct: 300 }), { entry: 0.00002, exit: 0.00008 });
  assert.deepEqual(tradePrices({ entryPriceSol: null, exitPriceSol: 0.00008, pnlPct: 300 }), { entry: 0.00002, exit: 0.00008 });
  // Neither known: nothing honest to draw.
  assert.equal(tradePrices({ entryPriceSol: null, exitPriceSol: null, pnlPct: 300 }), null);
  assert.equal(syntheticCandles({ ...trade, entryPriceSol: null, exitPriceSol: null }, iv), null);
  // A loss works the same way.
  const loss = syntheticCandles({ ...trade, exitPriceSol: 0.00001, pnlPct: -50 }, iv);
  assert.equal(loss.filter((c) => c.time <= closeSec).pop().close, 0.00001);
  // A ten-second scalp still gets a usable number of candles.
  const scalp = syntheticCandles({ ...trade, openedAt: now - 20_000, closedAt: now - 10_000 });
  assert.ok(scalp && scalp.length >= 12, 'scalp: ' + (scalp ? scalp.length : 'null'));
  console.log('ok  a trade with no history gets a seeded path pinned to its fills');
}

console.log('replayplan: all tests passed');
