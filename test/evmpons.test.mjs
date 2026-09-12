// electron/evm/pons.ts — the Pons V2 curve arithmetic, pool-key derivation
// and calldata, against the state read from a live curve on 2026-09-08.
//
// The documented formula and the curve's own arithmetic DISAGREE by a few
// percent: for a 0.001 ETH buy on the state below the formula gives
// 59,423.854… tokens and the curve (eth_call of the real buy) returned
// 57,313.633…. That is why the app treats the formula as an estimate and
// simulates the exact calldata for every quote — pinned here so nobody
// "fixes" the formula into the quote path.

import assert from 'node:assert';
import { estimateBuy, estimateSell, spotPrice, toShared, poolKeyFor, encodeBuy, encodeSell, PONS_SUPPLY } from './.evmpons.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

// Live curve 0xec8DAA33ec6eb33258af6f29d7590afe8e8b0f42, block ~58,230,700.
const LIVE = {
  address: '0xec8daa33ec6eb33258af6f29d7590afe8e8b0f42',
  quoteReserve: 5_209_185_642_258_913_225n,
  tokenReserve: 322_507_223_849_193_478_166_252_020n,
  realQuoteReserve: 3_529_185_642_258_913_225n,
  sellableTokens: 36_792_938_134_907_763_880_537_735n, // tokenReserve − reserved
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  graduated: false,
  readyToGraduate: false,
  graduationThreshold: 4_200_000_000_000_000_000n,
  feeBps: 100n,
  creatorTaxBps: 300n,
  isNativeQuote: true,
  pairToken: '0x0000000000000000000000000000000000000000',
};

const FORMULA_OUT = 59_423_854_178_669_832_529_850n;
const CURVE_OUT = 57_313_633_004_573_098_373_415n;

// ── buys ──────────────────────────────────────────────────────────────

ok('estimateBuy reproduces the documented formula on the live state', () => {
  assert.equal(estimateBuy(LIVE, 10n ** 15n), FORMULA_OUT);
});

ok('the formula runs ~3.7 % above what the curve actually paid — quotes must be simulated', () => {
  const ratio = Number(FORMULA_OUT) / Number(CURVE_OUT);
  assert.ok(ratio > 1.03 && ratio < 1.045, `ratio ${ratio}`);
});

ok('estimateBuy takes fee, creator tax and snipe tax off the input', () => {
  const noTax = estimateBuy({ ...LIVE, feeBps: 0n, creatorTaxBps: 0n }, 10n ** 15n);
  const feeOnly = estimateBuy({ ...LIVE, creatorTaxBps: 0n }, 10n ** 15n);
  const full = estimateBuy(LIVE, 10n ** 15n);
  const sniped = estimateBuy(LIVE, 10n ** 15n, 5_000n);
  assert.ok(noTax > feeOnly && feeOnly > full && full > sniped);
  // 1 % fee + 3 % tax leaves 96 % of the input on the curve.
  const net = 10n ** 15n - 10n ** 13n - 3n * 10n ** 13n;
  assert.equal(full, (net * LIVE.tokenReserve) / (LIVE.quoteReserve + net));
});

ok('a 99 % snipe tax at launch leaves almost nothing', () => {
  const out = estimateBuy(LIVE, 10n ** 15n, 9_900n);
  assert.ok(out < estimateBuy(LIVE, 10n ** 15n) / 20n);
  assert.equal(estimateBuy(LIVE, 10n ** 15n, 10_000n), 0n, '100 % tax nets zero');
});

ok('estimateBuy clamps to the sellable supply near graduation', () => {
  const nearlyDone = { ...LIVE, sellableTokens: 1_000n };
  assert.equal(estimateBuy(nearlyDone, 10n ** 18n), 1_000n);
});

ok('estimateBuy of zero is zero', () => {
  assert.equal(estimateBuy(LIVE, 0n), 0n);
});

// ── sells ─────────────────────────────────────────────────────────────

ok('estimateSell takes the gross off the curve then fee + tax off the quote side', () => {
  const tokensIn = 10n ** 22n; // 10,000 tokens
  const gross = (tokensIn * LIVE.quoteReserve) / (LIVE.tokenReserve + tokensIn);
  const expected = gross - (gross * 100n) / 10_000n - (gross * 300n) / 10_000n;
  assert.equal(estimateSell(LIVE, tokensIn), expected);
  assert.ok(expected < gross);
  assert.equal(estimateSell({ ...LIVE, feeBps: 0n, creatorTaxBps: 0n }, tokensIn), gross);
});

ok('a round trip loses the fees on both legs', () => {
  const bought = estimateBuy(LIVE, 10n ** 15n);
  const back = estimateSell(LIVE, bought);
  assert.ok(back < 10n ** 15n);
  assert.ok(back > (10n ** 15n * 90n) / 100n, 'but not more than the ~8 % two fee legs + rounding');
});

ok('estimateSell of zero is zero', () => {
  assert.equal(estimateSell(LIVE, 0n), 0n);
});

// ── price and progress ────────────────────────────────────────────────

ok('spotPrice is the marginal quote per whole token', () => {
  const p = spotPrice(LIVE, 18);
  const expected = Number(LIVE.quoteReserve) / Number(LIVE.tokenReserve);
  assert.ok(Math.abs(p - expected) / expected < 1e-9, `${p} vs ${expected}`);
  assert.ok(p > 1.6e-8 && p < 1.62e-8);
  // A USDG-quoted curve (6-decimal quote) scales by 1e12.
  assert.ok(Math.abs(spotPrice(LIVE, 6) - p * 1e12) / (p * 1e12) < 1e-9);
  assert.equal(spotPrice({ ...LIVE, tokenReserve: 0n }), null);
});

ok('toShared carries progress (84.02 %), strings for the big numbers, and the fee facts', () => {
  const s = toShared(LIVE);
  assert.equal(s.progressPct, 84.02);
  assert.equal(s.graduated, false);
  assert.equal(s.realQuoteWei, LIVE.realQuoteReserve.toString());
  assert.equal(s.thresholdWei, LIVE.graduationThreshold.toString());
  assert.equal(s.feeBps, 100);
  assert.equal(s.creatorTaxBps, 300);
  assert.equal(s.isNativeQuote, true);
  assert.equal(s.sellableTokens, LIVE.sellableTokens.toString());
  assert.equal(typeof s.priceQuote, 'number');
});

ok('toShared reports 100 % once graduated', () => {
  assert.equal(toShared({ ...LIVE, graduated: true }).progressPct, 100);
});

// ── pool key ──────────────────────────────────────────────────────────

const RECORD = {
  token: '0xc7410e5136ac803e167782316c4a939a4f5097d5',
  curve: '0xdfaa60a1806f5ce56d2a3446d0df648b57b07e56',
  deployer: '0x1111111111111111111111111111111111111111',
  creatorFeeRecipient: '0x1111111111111111111111111111111111111111',
  pairToken: '0x0000000000000000000000000000000000000000',
  graduationThreshold: 4_200_000_000_000_000_000n,
  poolFee: 0,
  tickSpacing: 200,
  creatorTaxBps: 300,
  buybackEnabled: false,
  phase: 2,
  sweptQuote: 0n,
  sweptTokens: 0n,
  sweptAt: 0n,
  exists: true,
};

ok('poolKeyFor: a native pair puts ETH (address 0) as currency0 and the token as currency1', () => {
  const k = poolKeyFor(RECORD);
  assert.equal(k.currency0, '0x0000000000000000000000000000000000000000');
  assert.equal(k.currency1, RECORD.token);
  assert.equal(k.fee, 0);
  assert.equal(k.tickSpacing, 200);
  assert.equal(k.hooks, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');
});

ok('poolKeyFor: a pair token ABOVE the token address sorts after it', () => {
  const k = poolKeyFor({ ...RECORD, pairToken: '0xffffffffffffffffffffffffffffffffffffffff' });
  assert.equal(k.currency0, RECORD.token);
  assert.equal(k.currency1, '0xffffffffffffffffffffffffffffffffffffffff');
});

ok('poolKeyFor: a pair token BELOW the token address (USDG) sorts first', () => {
  const usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const k = poolKeyFor({ ...RECORD, pairToken: usdg });
  assert.equal(k.currency0, usdg);
  assert.equal(k.currency1, RECORD.token);
});

// ── calldata ──────────────────────────────────────────────────────────

ok('encodeBuy / encodeSell carry the pinned selectors and their arguments', () => {
  const me = '0x1111111111111111111111111111111111111111';
  const buy = encodeBuy(10n ** 15n, 5n, me);
  assert.equal(buy.slice(0, 10), '0x59a87bc1');
  assert.equal(buy.length, 2 + 8 + 3 * 64);
  assert.equal(BigInt('0x' + buy.slice(10, 74)), 10n ** 15n);
  assert.equal(BigInt('0x' + buy.slice(74, 138)), 5n);
  assert.equal('0x' + buy.slice(138 + 24), me);
  const sell = encodeSell(10n ** 20n, 7n, me);
  assert.equal(sell.slice(0, 10), '0xd04c6983');
  assert.equal(BigInt('0x' + sell.slice(10, 74)), 10n ** 20n);
  assert.equal(BigInt('0x' + sell.slice(74, 138)), 7n);
});

ok('PONS_SUPPLY is one billion tokens at 18 decimals', () => {
  assert.equal(PONS_SUPPLY, 10n ** 27n);
  assert.equal(LIVE.reservedTokens + LIVE.sellableTokens, LIVE.tokenReserve, 'reserved + sellable = reserve on the live curve');
});

console.log(`\n${passed} evm pons cases passed`);
