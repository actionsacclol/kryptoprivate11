// Sell dust (2026-10-03): what the button sells, and what it never touches.
import assert from 'node:assert/strict';
import { DUST_SELL_USD, planDustSell } from './.dustsell.mjs';

const KRYPTO = '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump';
const h = (mint, symbol, uiAmount = 1000, amountRaw = '1000000000') => ({ mint, symbol, uiAmount, amountRaw });
const prices = { A: 0.12, B: 0.03, C: 0.49, BIG: 0.5, HUGE: 40, [KRYPTO]: 0.2, RAW: 0.0001 };

const plan = planDustSell(
  [h('A', 'SEEDLESS'), h('B', 'DW'), h('C', 'FUGU'), h('BIG', 'BIG'), h('HUGE', 'BAG'), h(KRYPTO, 'KRYPTO'), h('NOPX', 'MYSTERY'), h('RAW', 'RAW', 0.000001, '1'), h('ZERO', 'Z', 0, '0')],
  (m) => (m in prices ? prices[m] : null),
  {
    exclude: new Map([[KRYPTO, 'your $KRYPTO — holding it halves your fees']]),
    unroutable: (x) => x.amountRaw === '1',
  },
);

assert.equal(DUST_SELL_USD, 0.5, 'the line is fifty cents');
assert.deepEqual(plan.sell.map((x) => x.symbol), ['DW', 'SEEDLESS', 'FUGU'], 'under $0.50, smallest first');
assert.equal(plan.totalUsd, 0.64);
assert.ok(!plan.sell.some((x) => x.symbol === 'BIG' || x.symbol === 'BAG'), '$0.50 and up is not dust');
assert.ok(!plan.sell.some((x) => x.mint === KRYPTO), 'never $KRYPTO');
assert.match(plan.skip.find((x) => x.mint === KRYPTO).why, /KRYPTO/);
assert.match(plan.skip.find((x) => x.symbol === 'MYSTERY').why, /no price/, 'unknown is not "small"');
assert.match(plan.skip.find((x) => x.symbol === 'RAW').why, /too few tokens/, 'a balance no route can sell is left alone');
assert.ok(!plan.skip.some((x) => x.symbol === 'Z') && !plan.sell.some((x) => x.symbol === 'Z'), 'an empty account is not listed');
assert.ok(!plan.skip.some((x) => x.symbol === 'BAG'), 'a real position is not even mentioned');

// A higher line sells more; $KRYPTO stays out whatever the line.
const wide = planDustSell([h(KRYPTO, 'KRYPTO'), h('HUGE', 'BAG')], (m) => prices[m] ?? null, { maxUsd: 100, exclude: new Map([[KRYPTO, 'x']]) });
assert.deepEqual(wide.sell.map((x) => x.symbol), ['BAG']);

console.log('dustsell: 1/1 passed');
