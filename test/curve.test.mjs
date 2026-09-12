// Bonding-curve math tests — INTEGER ONLY invariants:
// - quotes are bigint, no floats anywhere in the money path
// - rounding always goes against the user (curve keeps the dust)
// - a buy→sell round trip must always lose money (fees + impact)
// - constant product never decreases from the curve's perspective

import assert from 'node:assert/strict';
import {
  buyQuote,
  sellQuote,
  spotPriceSol,
  curveProgressPct,
  curveProgressTokenPct,
  CURVE_COMPLETE_VIRTUAL_TOKENS,
  INITIAL_VIRTUAL_SOL,
  INITIAL_VIRTUAL_TOKENS,
  MODELED_TX_FEE_LAMPORTS,
} from './.curve.mjs';

const vSol = INITIAL_VIRTUAL_SOL;
const vTok = INITIAL_VIRTUAL_TOKENS;
const SOL = 1_000_000_000n;

// Types: everything monetary is bigint.
{
  const q = buyQuote(SOL, vSol, vTok);
  assert.equal(typeof q.tokensOut, 'bigint');
  assert.equal(typeof q.feesLamports, 'bigint');
  console.log('ok  bigint types');
}

// Spot price at launch ≈ 30 / 1_073_000_000 SOL per token (display edge).
{
  const p = spotPriceSol(vSol, vTok);
  assert.ok(p > 2.7e-8 && p < 2.9e-8, `launch spot price sane, got ${p}`);
  console.log('ok  spot price');
}

// Exact golden value: buying 1 SOL at launch reserves.
// effectiveIn = 1e9 − 1% = 990_000_000; k = vSol·vTok;
// tokensOut = vTok − ceil(k / (vSol + effectiveIn))
{
  const q = buyQuote(SOL, vSol, vTok);
  const eff = SOL - SOL / 100n;
  const k = vSol * vTok;
  const newVSol = vSol + eff;
  const expected = vTok - (k + newVSol - 1n) / newVSol;
  assert.equal(q.tokensOut, expected);
  assert.equal(q.feesLamports, SOL / 100n + MODELED_TX_FEE_LAMPORTS);
  console.log('ok  golden buy');
}

// Round trip against unchanged reserves loses fees + impact, and is small.
{
  const half = SOL / 2n;
  const buy = buyQuote(half, vSol, vTok);
  const sell = sellQuote(buy.tokensOut, vSol, vTok);
  assert.ok(sell.solOutLamports < half, 'round trip must lose money');
  assert.ok(sell.solOutLamports > (half * 90n) / 100n, 'but <10% loss on a 0.5 SOL clip');
  console.log('ok  round trip');
}

// Rounding goes against the user: the curve's k never decreases after a buy.
{
  const q = buyQuote(SOL, vSol, vTok);
  const eff = SOL - SOL / 100n;
  const kBefore = vSol * vTok;
  const kAfter = (vSol + eff) * (vTok - q.tokensOut);
  assert.ok(kAfter >= kBefore, 'constant product preserved or grown (dust to curve)');
  console.log('ok  rounding direction');
}

// Bigger clips get fewer tokens per lamport (monotone price impact).
{
  const small = buyQuote(SOL / 10n, vSol, vTok);
  const big = buyQuote(SOL * 5n, vSol, vTok);
  // tokens per lamport: small.tokensOut / 0.1 SOL vs big.tokensOut / 5 SOL
  assert.ok(small.tokensOut * 50n > big.tokensOut, 'large clip pays a worse average price');
  console.log('ok  monotone impact');
}

// Degenerate inputs never produce negative quotes.
{
  assert.equal(buyQuote(0n, vSol, vTok).tokensOut, 0n);
  assert.equal(sellQuote(0n, vSol, vTok).solOutLamports, 0n);
  assert.equal(sellQuote(1n, vSol, vTok).solOutLamports, 0n, 'dust sell nets zero after fees, never negative');
  console.log('ok  degenerate inputs');
}

// Curve progress: 0% at launch, 100% at completion reserves (display edge).
{
  assert.equal(curveProgressPct(vSol), 0);
  assert.equal(curveProgressTokenPct(INITIAL_VIRTUAL_TOKENS), 0, 'token-side: nothing sold');
  assert.equal(curveProgressTokenPct(CURVE_COMPLETE_VIRTUAL_TOKENS), 100, 'token-side: sellable supply gone');
  assert.equal(CURVE_COMPLETE_VIRTUAL_TOKENS, 279_900_000_000_000n, 'floor is 279.9e12 raw (README §3)');
  const half = curveProgressTokenPct(INITIAL_VIRTUAL_TOKENS - 396_550_000_000_000n);
  assert.ok(Math.abs(half - 50) < 1e-9, 'token-side: half the sellable supply is 50 %');
  assert.equal(curveProgressTokenPct(0n), 100, 'token-side clamps at 100');
  assert.equal(curveProgressPct(115n * SOL), 100);
  const mid = curveProgressPct(72n * SOL);
  assert.ok(mid > 45 && mid < 55, `midpoint ~50%, got ${mid}`);
  console.log('ok  curve progress');
}

console.log('curve tests passed');
