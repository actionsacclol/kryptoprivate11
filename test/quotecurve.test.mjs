// The SOL view of a pump.fun curve quoted in something other than SOL
// (electron/engine/quoteCurve.ts). Pure: the rate is injected.
//
// 2026-10-26, user report: the chart of 5skM7cwc…pump flipped between two
// prices. Its curve is quoted in RDDT (a tokenized stock, 6 decimals); pump
// zeroes the SOL fields of such a curve's events and keeps the figures in
// quote units. Read as lamports they were ~700× too small. These pin the
// conversion that every SOL-shaped reader in the engine now goes through.

import assert from 'node:assert/strict';
import { tradeInSol, curveVSolLamports } from './.quotecurve.mjs';
import { spotPriceSol } from './.curve.mjs';

const RDDT = 'RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh';
// RDDT $138.59, SOL $205, 6 decimals → SOL per RAW quote unit.
const RATE = 138.59 / 205 / 1e6;
const rate = (mint) => (mint === RDDT ? RATE : null);

const solEv = {
  mint: 'm', solAmount: 500_000_000n, tokenAmount: 15_000_000_000_000n, isBuy: true, user: 'u', timestamp: 0,
  virtualSolReserves: 30_500_000_000n, virtualTokenReserves: 1_058_000_000_000_000n, creator: 'c',
  quoteMint: null, quoteAmount: null, virtualQuoteReserves: null, realQuoteReserves: null,
};
// The real buy in test/fixtures/trade-quote-rddt.json: zero SOL fields, RDDT quote fields.
const quoteEv = {
  ...solEv, solAmount: 0n, virtualSolReserves: 0n, virtualTokenReserves: 565_822_810_781_556n,
  quoteMint: RDDT, quoteAmount: 140_025n, virtualQuoteReserves: 45_130_918n, realQuoteReserves: 21_332_306n,
};

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
};

test('a SOL curve passes through untouched and never asks for a rate', () => {
  const v = tradeInSol(solEv, () => {
    throw new Error('the rate must not be asked for on a SOL curve');
  });
  assert.equal(v.solLamports, 500_000_000n);
  assert.equal(v.sol, 0.5);
  assert.equal(v.vSol, 30_500_000_000n);
  assert.equal(v.priceSol, spotPriceSol(30_500_000_000n, 1_058_000_000_000_000n));
});

test('a quote curve converts the amount and the reserve at the rate', () => {
  const v = tradeInSol(quoteEv, rate);
  assert.ok(v, 'converted');
  // 0.140025 RDDT ≈ $19.41 ≈ 0.0947 SOL changed hands
  assert.ok(Math.abs(v.sol - (0.140025 * 138.59) / 205) < 1e-9, `sol ${v.sol}`);
  assert.equal(v.solLamports, BigInt(Math.round(140_025 * RATE * 1e9)));
  // 45.13 RDDT ≈ $6,255 ≈ 30.5 SOL of virtual reserve — the curve math accepts it
  assert.ok(Math.abs(Number(v.vSol) / 1e9 - (45.130918 * 138.59) / 205) < 1e-6, `vSol ${v.vSol}`);
  assert.equal(v.priceSol, spotPriceSol(v.vSol, quoteEv.virtualTokenReserves));
  // …and it is hundreds of times what the raw-units-as-lamports reading said (the bug).
  const wrong = spotPriceSol(quoteEv.virtualQuoteReserves, quoteEv.virtualTokenReserves);
  const factor = v.priceSol / wrong;
  assert.ok(factor > 600 && factor < 800, `fixed/wrong = ${factor} (expected ≈ ${RATE * 1e9})`);
});

test('no rate yet → null, never a figure in the wrong unit', () => {
  assert.equal(tradeInSol(quoteEv, () => null), null);
  assert.equal(tradeInSol(quoteEv, () => 0), null);
  assert.equal(tradeInSol(quoteEv, () => NaN), null);
  assert.equal(tradeInSol(quoteEv, () => -1), null);
  assert.equal(tradeInSol({ ...quoteEv, quoteAmount: null }, rate), null, 'a quote curve with a short tail cannot be priced');
  assert.equal(tradeInSol({ ...quoteEv, virtualQuoteReserves: null }, rate), null);
});

test('a curve account: lamports as-is on a SOL curve, converted on a quote one, null without a rate', () => {
  assert.equal(curveVSolLamports({ vSol: 30_500_000_000n, quoteMint: null }, () => null), 30_500_000_000n);
  assert.equal(curveVSolLamports({ vSol: 45_130_918n, quoteMint: RDDT }, rate), BigInt(Math.round(45_130_918 * RATE * 1e9)));
  assert.equal(curveVSolLamports({ vSol: 45_130_918n, quoteMint: RDDT }, () => null), null);
  assert.equal(curveVSolLamports({ vSol: 45_130_918n, quoteMint: RDDT }, () => 0), null);
});

console.log(`\nquotecurve: ${passed} passed`);
