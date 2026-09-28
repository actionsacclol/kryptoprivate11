// The cheap price of a migrated coin (user report 2026-09-27): the launch
// row's price is the CURVE's last spot — the graduation price — and it never
// moves again. Once the curve is complete the newest timed print must win
// over it, and the row is only the last resort.

import assert from 'node:assert/strict';
import { cheapPrice, ammDecodeWanted } from './.pricesource.mjs';

const GRAD = 4.1088e-7; // the graduation price: 115 SOL over 279.9M tokens
const T0 = 1_000_000;

// On the curve the row is the live spot and wins over anything timed.
{
  const p = cheapPrice({ rowPriceSol: 2e-8, curveComplete: false, timed: [{ priceSol: 9e-8, at: T0 + 5_000 }] });
  assert.equal(p, 2e-8);
  console.log('ok  on the curve the row (the live spot) wins');
}

// Complete: the newest timed print wins over the row, whatever its order.
{
  const p = cheapPrice({
    rowPriceSol: GRAD,
    curveComplete: true,
    timed: [
      { priceSol: 3.9e-8, at: T0 + 20_000 }, // an AMM swap 20 s later: the coin down 90 %
      { priceSol: GRAD, at: T0 },            // the graduation price, stamped at completion
      { priceSol: 1.2e-7, at: T0 + 9_000 },  // the orders poller in between
    ],
  });
  assert.equal(p, 3.9e-8);
  console.log('ok  after completion the newest timed print wins, not the graduation price');
}

// Complete with nothing timed: the row (the graduation price) is the last resort, never null.
{
  assert.equal(cheapPrice({ rowPriceSol: GRAD, curveComplete: true, timed: [] }), GRAD);
  console.log('ok  after completion with nothing newer the graduation price stands');
}

// Untracked (no row): the newest timed print, else null. Junk never counts.
{
  assert.equal(cheapPrice({ rowPriceSol: null, curveComplete: false, timed: [{ priceSol: 0, at: T0 + 1 }, { priceSol: 5e-8, at: T0 }] }), 5e-8);
  assert.equal(cheapPrice({ rowPriceSol: null, curveComplete: false, timed: [] }), null);
  assert.equal(cheapPrice({ rowPriceSol: NaN, curveComplete: true, timed: [{ priceSol: Infinity, at: T0 }] }), null);
  console.log('ok  untracked reads the newest timed print; nothing known is null, never a number');
}

// The pump-amm feed decodes when a script holds or watches something.
{
  const off = { shadowStratLab: false, shadowMigration: false, tapeSubscribed: 0, ordersArmed: false, scriptsWantTicks: false };
  assert.equal(ammDecodeWanted(off), false);
  assert.equal(ammDecodeWanted({ ...off, scriptsWantTicks: true }), true);
  assert.equal(ammDecodeWanted({ ...off, tapeSubscribed: 1 }), true);
  assert.equal(ammDecodeWanted({ ...off, ordersArmed: true }), true);
  assert.equal(ammDecodeWanted({ ...off, shadowMigration: true }), true);
  console.log('ok  amm decoding: a script following a coin is reason enough');
}

console.log('pricesource: all passed');
