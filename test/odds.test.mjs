// Runner odds — pure, offline.
//
// The number a user sees is an observed rate for a score BUCKET measured on
// 2026-07-27, so the TypeScript scorer must land a launch in the same bucket
// the python model did. Pinned by a golden round-trip: 25 held-out rows per
// model, the TS probability within ±0.03 of python's and the bucket equal
// for ≥ 23/25 (the shipped 201-point rank grid reproduces the exact train
// percentile within ±0.005, so a row sitting on a bucket cut can flip — that
// is the artefact, and it is documented, not hidden).
//
// Also pinned: honest null (a required feature unknown → no report, zero
// trades → no report), the curve-regime constants, the wording carrying n,
// base and the measured day, and every feature definition the integrator
// must satisfy in oddsFeaturesFromTrades.

import assert from 'node:assert';
import {
  ODDS_MODEL,
  __oddsInternals,
  curveRegime,
  oddsFeaturesFromTrades,
  rankPercentile,
  scoreOdds,
} from './.odds.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const { modelProbability, bucketOf } = __oddsInternals;

// ── Artefact shape ────────────────────────────────────────────────────

test('artefact is dated and carries the four models', () => {
  assert.equal(ODDS_MODEL.measuredOn, '2026-07-27');
  assert.deepEqual(ODDS_MODEL.fittedOn, ['2026-07-25', '2026-07-26']);
  for (const k of ['60|grad', '120|grad', '60|peak3', '60|peak5']) {
    const m = ODDS_MODEL.models[k];
    assert.ok(m, k);
    assert.equal(m.buckets.length, 6);
    assert.equal(m.golden.length, 25, `${k} golden rows`);
    for (const f of m.features) {
      if (f.kind === 'rank') {
        assert.equal(f.grid.length, ODDS_MODEL.gridPoints);
        for (let i = 1; i < f.grid.length; i++) assert.ok(f.grid[i] >= f.grid[i - 1], `${k} ${f.key} grid sorted`);
      } else assert.equal(f.grid, null);
    }
    // score cuts descend from top1 to bottom50
    for (let i = 1; i < m.buckets.length; i++) assert.ok(m.buckets[i].scoreMin < m.buckets[i - 1].scoreMin);
  }
  assert.equal(ODDS_MODEL.models['120|peak3'], undefined, 'no 120 s multiple models shipped');
  assert.ok(!Object.keys(ODDS_MODEL.models).some((k) => k.includes('m5m2')), '2×-in-5-min is not shipped');
});

// ── Golden round-trip ─────────────────────────────────────────────────

const golden = {};
for (const k of ['60|grad', '120|grad', '60|peak3', '60|peak5']) {
  test(`golden round-trip ${k}: bucket agrees ≥ 23/25, probability within ±0.03`, () => {
    const m = ODDS_MODEL.models[k];
    let agree = 0;
    let maxDp = 0;
    const misses = [];
    for (const g of m.golden) {
      const p = modelProbability(m, g.features);
      assert.notEqual(p, null, `${k} ${g.mint} scored null`);
      const dp = Math.abs(p - g.p);
      if (dp > maxDp) maxDp = dp;
      assert.ok(dp <= 0.03, `${k} ${g.mint}: p ${p.toFixed(4)} vs python ${g.p.toFixed(4)}`);
      const b = bucketOf(m, p).bucket;
      if (b === g.bucket) agree += 1;
      else misses.push(`${g.mint.slice(0, 6)} ts=${b} py=${g.bucket} p=${p.toFixed(4)} pyp=${g.p.toFixed(4)}`);
    }
    golden[k] = { agree, maxDp, misses };
    assert.ok(agree >= 23, `${k}: only ${agree}/25 buckets agree: ${misses.join('; ')}`);
  });
}

test('rank percentile reproduces mid-rank on ties and interpolates between grid points', () => {
  const grid = [0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 64];
  // 4 of 11 points are 0 → lo = 0, hi = 4 → (0/10 + 4/10)/2
  assert.ok(Math.abs(rankPercentile(grid, 0) - 0.2) < 1e-12);
  assert.equal(rankPercentile(grid, -1), 0);
  assert.equal(rankPercentile(grid, 100), 1);
  // exactly on a single grid point: (5/10 + 6/10)/2
  assert.ok(Math.abs(rankPercentile(grid, 2) - 0.55) < 1e-12);
  // half way between 2 (q=0.5) and 4 (q=0.6)
  assert.ok(Math.abs(rankPercentile(grid, 3) - 0.55) < 1e-12);
  // the top grid point: (10/10 + 11/10 capped at 1)/2 = 1, python's (2n−1)/2n within 1/n
  assert.ok(Math.abs(rankPercentile(grid, 64) - 1.0) < 1e-12);
});

// ── Curve regime ──────────────────────────────────────────────────────

test('curveRegime: README constants are classic, 0.5 % off is mixed, null is unknown', () => {
  const vSol = 30e9;
  const vTok = 1.073e15;
  assert.equal(curveRegime(vSol, vTok), 'classic');
  assert.equal(curveRegime(vSol * 1.004, vTok), 'classic');
  assert.equal(curveRegime(vSol * 1.006, vTok), 'mixed');
  assert.equal(curveRegime(vSol * 2, vTok / 2), 'classic', 'constant product after trades');
  assert.equal(curveRegime(vSol * 2, vTok), 'mixed');
  assert.equal(curveRegime(null, vTok), 'unknown');
  assert.equal(curveRegime(vSol, null), 'unknown');
  assert.equal(curveRegime(0, vTok), 'unknown');
});

// ── Null / unknown handling ───────────────────────────────────────────

const known60 = () => ({ ...ODDS_MODEL.models['60|grad'].golden[0].features });

test('a required feature unknown → null report; tradesSeen 0 → null report', () => {
  assert.ok(scoreOdds(known60()), 'the golden row itself scores');
  assert.equal(scoreOdds({ ...known60(), tradesSeen: 0 }), null);
  assert.equal(scoreOdds({ ...known60(), nBuys: null }), null, 'n_buys is required at 60 s');
  assert.equal(scoreOdds({ ...known60(), tradesPerSecondLast10s: null }), null);
  assert.equal(scoreOdds({ ...known60(), uniqueSellers: null }), null);
  assert.equal(scoreOdds({ ...known60(), creatorShareOfSupply: null }), null);
});

test('an optional feature unknown still scores (meta_twitter at 120 s had nulls in train)', () => {
  const f = { ...ODDS_MODEL.models['120|grad'].golden[0].features, metaTwitter: null };
  const r = scoreOdds(f);
  assert.ok(r && r.graduate, 'scored');
  assert.equal(r.windowS, 120);
  assert.equal(r.mult3, null, 'no 3× line at 120 s');
  assert.equal(r.mult5, null, 'no 5× line at 120 s');
});

test('at 60 s the 3×/5× lines drop out on their own when only their inputs are unknown', () => {
  const r = scoreOdds({ ...known60(), curveMixed: null, devBuyShareOfSupply: null });
  assert.ok(r && r.graduate, 'graduation still scored');
  assert.equal(r.regime, 'unknown');
  assert.equal(r.mult3, null, 'curve_mixed is required by peak3');
  assert.equal(r.mult5, null, 'curve_mixed is required by peak5');
  const r2 = scoreOdds({ ...known60(), devBuyShareOfSupply: null });
  assert.equal(r2.mult3, null, 'dev_buy_share is required by peak3');
  assert.ok(r2.mult5, 'peak5 does not need it');
});

test('features the models do not use are ignored even when null', () => {
  const f = { ...known60(), sniperShare: null, buySolPerBuyer: null, medianBuySol: null, largestBuyFrac: null, top3BuyersShare: null, netOverBuy: null, curveProgress: null, metaTwitter: null };
  const r = scoreOdds(f);
  assert.ok(r && r.graduate && r.mult3 && r.mult5);
});

// ── Wording ───────────────────────────────────────────────────────────

test('wording carries n, base and the measured day; never the probability', () => {
  const r = scoreOdds(known60());
  assert.equal(r.model, '2026-07-27');
  assert.match(r.graduate.line, /\(n = [\d,]+\)/);
  assert.match(r.graduate.line, /Base: [\d.]+ in 100\./);
  assert.match(r.graduate.line, /launches like this graduated/);
  assert.match(r.footer, /2026-07-27/);
  assert.match(r.footer, /27,937 launches/);
  assert.match(r.footer, /Past rates, not a prediction for this token\./);
  assert.ok(!('p' in r) && !('probability' in r) && !('score' in r));
  assert.ok(!('p' in r.graduate) && !('score' in r.graduate));
  assert.match(r.mult3.line, /hit 3× within the hour/);
  assert.match(r.mult5.line, /hit 5× within the hour/);
});

test('the §7 lines are reproduced for the +60 s buckets', () => {
  const m = ODDS_MODEL.models['60|grad'];
  const line = (bucket) => {
    const g = m.golden.find((x) => x.bucket === bucket);
    return scoreOdds(g.features).graduate.line;
  };
  assert.equal(line('top1_5'), 'About 17 in 100 launches like this graduated (n = 1,117). Base: 2 in 100.');
  assert.equal(line('top1'), 'About 15 in 100 launches like this graduated (n = 279). Base: 2 in 100.');
  assert.equal(line('top5_10'), 'About 11 in 100 launches like this graduated (n = 1,397). Base: 2 in 100.');
  assert.equal(line('top10_25'), 'About 4 in 100 launches like this graduated (n = 4,191). Base: 2 in 100.');
  assert.equal(line('top25_50'), 'About 1 in 200 launches like this graduated (n = 6,984). Base: 2 in 100.');
  assert.equal(line('bottom50'), 'Fewer than 1 in 1,000 launches like this graduated (n = 13,969). Base: 2 in 100.');
});

test('the 3×/5× lines split by regime: report numbers for the top 5 %, in-bucket rates below', () => {
  const p3 = ODDS_MODEL.models['60|peak3'];
  const top = p3.golden.find((x) => x.bucket === 'top1_5');
  const r = scoreOdds(top.features);
  assert.ok(r.mult3.line.includes('Classic ~10 · mixed ~25'), r.mult3.line);
  assert.ok(Math.abs(r.mult3.classicPct - 10.18) < 0.05);
  assert.ok(Math.abs(r.mult3.mixedPct - 24.89) < 0.05);
  // 5×: no classic launch clears the global cut; classic is the within-regime top 5 %
  const p5 = ODDS_MODEL.models['60|peak5'];
  const t5 = p5.golden.find((x) => x.bucket === 'top1_5');
  const r5 = scoreOdds(t5.features);
  assert.ok(r5.mult5.line.includes('Classic ~3 · mixed ~13'), r5.mult5.line);
  // bottom half: the in-bucket split, "—" when a regime has fewer than 50 launches there
  const low = p3.golden.find((x) => x.bucket === 'top5_10');
  const rl = scoreOdds(low.features);
  const b = p3.buckets.find((x) => x.bucket === 'top5_10');
  assert.ok(Math.abs(rl.mult3.classicPct - b.byRegime.classic.observed * 100) < 1e-9);
  assert.ok(Math.abs(rl.mult3.mixedPct - b.byRegime.mixed.observed * 100) < 1e-9);
});

// ── oddsFeaturesFromTrades ────────────────────────────────────────────

const SUPPLY = 1_000_000_000;
const CREATOR = 'CREATOR';
const CREATE_SLOT = 1000;
const T0 = 1_700_000_000_000;
let n = 0;
const trade = (offsetS, user, isBuy, sol, base, slot = CREATE_SLOT + Math.round(offsetS * 2.5)) => ({
  slot,
  ts: T0 + offsetS * 1000,
  user,
  isBuy,
  base,
  sol,
  program: 'pump',
  tx: `tx${n++}`,
});

const ctx = (over = {}) => ({
  creator: CREATOR,
  supply: SUPPLY,
  curveProgress: 0.12,
  virtualSolReserves: 30e9,
  virtualTokenReserves: 1.073e15,
  hasTwitter: true,
  createSlot: CREATE_SLOT,
  windowS: 60,
  ...over,
});

const sample = () => [
  trade(0, CREATOR, true, 1.0, 30_000_000, CREATE_SLOT), // dev buy in the create slot
  trade(0, 'bundler', true, 0.5, 15_000_000, CREATE_SLOT), // bundled (same slot) — not a snipe
  trade(2, 'sniperA', true, 2.0, 50_000_000, CREATE_SLOT + 5), // snipe: 5 slots after create
  trade(9, 'sniperB', true, 0.2, 5_000_000, CREATE_SLOT + 20), // snipe: exactly 20 slots
  trade(15, 'late', true, 0.4, 9_000_000, CREATE_SLOT + 40), // 40 slots: not a snipe
  trade(20, CREATOR, false, 0.6, 10_000_000), // creator sells a third
  trade(30, 'sniperA', false, 1.0, 25_000_000), // sniper sells half
  trade(52, 'w6', true, 0.3, 6_000_000),
  trade(55, 'w7', true, 0.3, 6_000_000),
  trade(60, 'w8', true, 0.1, 2_000_000), // exactly at the window edge: inside
  trade(61, 'w9', true, 5.0, 90_000_000), // after the window: ignored
  trade(300, 'w9', false, 5.0, 90_000_000),
];

test('oddsFeaturesFromTrades freezes at the window and counts what the models need', () => {
  const f = oddsFeaturesFromTrades(sample(), ctx());
  assert.equal(f.windowS, 60);
  assert.equal(f.tradesSeen, 10, 'trades ≤ 60 s only');
  assert.equal(f.nBuys, 8);
  assert.equal(f.uniqueSellers, 2, 'creator + sniperA');
  // buys: 1+0.5+2+0.2+0.4+0.3+0.3+0.1 = 4.8 ; sells 0.6+1.0 = 1.6
  assert.ok(Math.abs(f.netSol - 3.2) < 1e-9);
  assert.ok(Math.abs(f.netOverBuy - 3.2 / 4.8) < 1e-9);
  // last 10 s: offsets in (50, 60] → 52, 55, 60
  assert.ok(Math.abs(f.tradesPerSecondLast10s - 0.3) < 1e-12);
  assert.equal(f.creatorSold, true);
  // creator net: 30M − 10M = 20M of 1B
  assert.ok(Math.abs(f.creatorShareOfSupply - 0.02) < 1e-12);
  // largest buy 2.0 of 4.8
  assert.ok(Math.abs(f.largestBuyFrac - 2.0 / 4.8) < 1e-12);
  // median of [1,0.5,2,0.2,0.4,0.3,0.3,0.1] sorted → (0.3+0.4)/2
  assert.ok(Math.abs(f.medianBuySol - 0.35) < 1e-12);
  // top-3 non-creator net positions: sniperA 25M, bundler 15M, late 9M
  assert.ok(Math.abs(f.top3BuyersShare - 0.049) < 1e-12);
  // dev buy in the create slot: 30M
  assert.ok(Math.abs(f.devBuyShareOfSupply - 0.03) < 1e-12);
  // snipers: sniperA 50M bought + sniperB 5M (bought, not net)
  assert.ok(Math.abs(f.sniperShare - 0.055) < 1e-12);
  // 4.8 SOL over 8 unique buyers (creator, bundler, sniperA, sniperB, late, w6, w7, w8)
  assert.ok(Math.abs(f.buySolPerBuyer - 0.6) < 1e-12);
  assert.equal(f.curveMixed, false);
  assert.equal(f.metaTwitter, true);
  assert.equal(f.curveProgress, 0.12);
});

test('oddsFeaturesFromTrades accepts trades in any order', () => {
  const a = oddsFeaturesFromTrades(sample(), ctx());
  const b = oddsFeaturesFromTrades(sample().reverse(), ctx());
  assert.deepEqual(a, b);
});

test('oddsFeaturesFromTrades: unknown inputs stay null, never 0', () => {
  const f = oddsFeaturesFromTrades(sample(), ctx({ creator: null, supply: null, createSlot: null, virtualSolReserves: null, hasTwitter: null, curveProgress: null }));
  assert.equal(f.creatorSold, null);
  assert.equal(f.creatorShareOfSupply, null);
  assert.equal(f.top3BuyersShare, null);
  assert.equal(f.devBuyShareOfSupply, null);
  assert.equal(f.sniperShare, null);
  assert.equal(f.curveMixed, null);
  assert.equal(f.metaTwitter, null);
  assert.equal(f.curveProgress, null);
  assert.equal(f.nBuys, 8, 'counts need nothing but trades');
  const g = oddsFeaturesFromTrades(sample(), ctx({ createSlot: null }));
  assert.equal(g.devBuyShareOfSupply, null, 'dev buy share needs the create slot');
  assert.equal(g.sniperShare, null);
  assert.ok(Math.abs(g.creatorShareOfSupply - 0.02) < 1e-12, 'creator share does not');
  const h = oddsFeaturesFromTrades(sample(), ctx({ virtualSolReserves: 31e9 }));
  assert.equal(h.curveMixed, true);
});

test('oddsFeaturesFromTrades: no trades → tradesSeen 0 → no report', () => {
  const f = oddsFeaturesFromTrades([], ctx());
  assert.equal(f.tradesSeen, 0);
  assert.equal(f.nBuys, null);
  assert.equal(f.tradesPerSecondLast10s, null);
  assert.equal(scoreOdds(f), null);
});

test('a 120 s window keeps the later trades and scores the 120 s model', () => {
  const f = oddsFeaturesFromTrades(sample(), ctx({ windowS: 120 }));
  assert.equal(f.tradesSeen, 11);
  assert.equal(f.nBuys, 9);
  assert.equal(f.tradesPerSecondLast10s, 0, 'nothing in (110, 120]');
  const r = scoreOdds(f);
  assert.ok(r && r.graduate);
  assert.equal(r.windowS, 120);
  assert.match(r.footer, /\+120 s/);
});

test('a live-looking launch scores end to end without exposing a number the report forbids', () => {
  const r = scoreOdds(oddsFeaturesFromTrades(sample(), ctx()));
  assert.ok(r.graduate);
  assert.ok(['top1', 'top1_5', 'top5_10', 'top10_25', 'top25_50', 'bottom50'].includes(r.graduate.bucket));
  assert.equal(r.regime, 'classic');
  assert.equal(r.tradesSeen, 10);
});

// ── run ───────────────────────────────────────────────────────────────

for (const c of cases) {
  try {
    c.fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${c.name}\n  ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}
for (const [k, g] of Object.entries(golden)) {
  console.log(`  golden ${k}: ${g.agree}/25 buckets agree, max |Δp| = ${g.maxDp.toFixed(4)}${g.misses.length ? ` (${g.misses.join('; ')})` : ''}`);
}
console.log(`odds: ${passed}/${cases.length} passed`);
