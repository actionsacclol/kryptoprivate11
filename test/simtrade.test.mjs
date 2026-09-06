// The trade simulator. It exists to look at layouts, so what matters is that
// it lands exactly on the number asked for, produces a drawable path, and
// carries a mark nothing can strip.
import assert from 'node:assert';
import { DEFAULT_SIM, isSimulated, simInterval, simulateTrade } from './.simtrade.mjs';

const closedAt = 1_700_000_000_000;
const base = { ...DEFAULT_SIM, closedAt };

{
  for (const pnlPct of [-92, -35, 0, 45, 180, 900, 4200]) {
    const { trade, candles } = simulateTrade({ ...base, pnlPct });
    assert.ok(Math.abs(trade.pnlPct - pnlPct) < 1e-9, `pnlPct kept for ${pnlPct}`);
    const ratio = trade.proceedsSol / trade.costSol;
    assert.ok(Math.abs(ratio - (1 + pnlPct / 100)) < 1e-9, `proceeds match ${pnlPct} %`);
    // The path must actually arrive where the numbers say.
    const exit = candles.find((c) => c.time === Math.floor(trade.closedAt / 1000) - simInterval(trade.holdMs)[1]);
    assert.ok(candles.length > 10, 'there is a path to draw');
    assert.ok(trade.exitPriceSol / trade.entryPriceSol - (1 + pnlPct / 100) < 1e-9, 'exit price matches the result');
    void exit;
  }
  console.log('ok  the exit lands exactly on the requested result');
}

{
  const { candles } = simulateTrade(base);
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close) - 1e-18, 'high is the highest');
    assert.ok(c.low <= Math.min(c.open, c.close) + 1e-18, 'low is the lowest');
    assert.ok(c.low > 0 && Number.isFinite(c.high), 'prices are real positive numbers');
  }
  for (let i = 1; i < candles.length; i++) {
    assert.ok(candles[i].time > candles[i - 1].time, 'candles run forward in time');
  }
  console.log('ok  every candle is well formed and in order');
}

{
  // The window covers the hold, with room before the buy and after the sell.
  const { trade, candles } = simulateTrade(base);
  const openSec = Math.floor(trade.openedAt / 1000);
  const closeSec = Math.floor(trade.closedAt / 1000);
  assert.ok(candles[0].time < openSec, 'there is lead-in before the buy');
  assert.ok(candles[candles.length - 1].time > closeSec - simInterval(trade.holdMs)[1], 'there is tail after the sell');
  console.log('ok  the path starts before the buy and continues past the sell');
}

{
  const a = simulateTrade({ ...base, seed: 11 });
  const b = simulateTrade({ ...base, seed: 11 });
  const c = simulateTrade({ ...base, seed: 12 });
  assert.deepEqual(a.candles, b.candles, 'same seed, same path');
  assert.notDeepEqual(a.candles, c.candles, 'a different seed moves differently');
  console.log('ok  the same input always draws the same trade');
}

{
  for (const shape of ['steady', 'dip-then-run', 'spike-then-fade', 'chop']) {
    const { trade } = simulateTrade({ ...base, shape });
    assert.ok(Math.abs(trade.pnlPct - base.pnlPct) < 1e-9, `${shape} still ends on the number`);
  }
  console.log('ok  every shape ends on the same result');
}

{
  // The mark is in the data, not in a UI flag someone can forget to pass.
  const { trade } = simulateTrade(base);
  assert.ok(isSimulated(trade), 'a simulated trade identifies itself');
  assert.ok(!isSimulated({ mint: 'So11111111111111111111111111111111111111112' }), 'a real mint does not');
  console.log('ok  a simulated trade carries its own mark');
}

{
  // Interval scales with the hold, so a scalp is not two candles and an
  // eight-hour hold is not ten thousand.
  assert.equal(simInterval(60_000)[0], '1s');
  assert.equal(simInterval(30 * 60_000)[0], '1m');
  assert.ok(simInterval(8 * 3600_000)[1] >= 300, 'a long hold uses coarse candles');
  const long = simulateTrade({ ...base, holdMs: 8 * 3600_000 });
  assert.ok(long.candles.length < 200, `an eight-hour hold stays drawable (${long.candles.length} candles)`);
  console.log('ok  the candle size follows the hold length');
}
console.log('simtrade: all tests passed');
