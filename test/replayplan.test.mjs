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
console.log('replayplan: all tests passed');
