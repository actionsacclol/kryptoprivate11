// Does order-flow imbalance predict established-coin returns by enough to pay?
//
// ─────────────────────────────────────────────────────────────────────
// PRE-REGISTERED 2026-09-14, BEFORE ANY DATA EXISTED.
//
// This file was written and committed while scripts/ofi-collect.mjs held
// roughly one hour of trades — far too little to evaluate anything. That is
// deliberate. Every parameter and the pass/fail rule below were fixed before
// they could be tuned against an answer.
//
// The reason is specific, not ceremonial. In this project, on 2026-09-14, a
// sweep of 5,130 setup combinations produced 12 that were positive in both
// halves of the sample; every one had 6-15 trades and the set was consistent
// with noise. docs/bluechip-data-plan-2026-09-14.md §3 had already written the
// warning: "with 300 trips and 30 candidate setups you will find a winner by
// construction." A pre-registered rule is the only cheap defence.
//
// IF THIS FILE IS EDITED AFTER LOOKING AT RESULTS, THE TEST IS VOID.
// Add a new test with a new name instead, and say what motivated it.
// ─────────────────────────────────────────────────────────────────────
//
// THE HYPOTHESIS
//
// The pump swarm (docs/volume-edge-swarm-2026-09-14.md) measured order-flow
// imbalance lifting the 60 s win rate monotonically 50.9% -> 87.4% across
// deciles, n = 159,958, replicating six weeks apart. It was real and it was
// correctly signed. It died only on pump's ~1.6% cost floor.
//
// On established pairs at FARM_FEE_BPS the measured all-in floor is 0.19-0.25%
// for these three coins (docs/bluechip-hurdle-2026-09-14.md). The same
// +0.583% gross edge would net roughly +0.39%. So: does the signal exist here,
// and is it bigger than the floor?
//
// PRIOR, STATED SO IT CANNOT BE REVISED SILENTLY
//
// A proxy built from 1-minute bar direction over 124,148 observations said the
// blue-chip version is CONTRARIAN (heavy buying predicts WORSE forward return)
// and small: a top-minus-bottom decile spread of 0.03-0.14 pp against a 0.19%
// floor. Established pairs are more efficient than pump and the expectation is
// that this fails. The proxy is too lossy to settle it, which is the only
// reason the real measurement is worth 328 calls a day.
//
// USAGE
//   node scripts/ofi-analyze.mjs [--dir tape/ofi]

import fs from 'fs';
import path from 'path';

// ── PRE-REGISTERED PARAMETERS ────────────────────────────────────────
const LOOKBACK_S = 60;              // OFI accumulated over the prior 60 s
const HORIZONS_S = [30, 60, 300];   // 60 s is the pump swarm's horizon; 30/300 bracket it
const DECILES = 10;
const MIN_PER_DECILE = 2_000;       // below this, report "insufficient", never a verdict
const MIN_TOTAL = 40_000;           // per coin, before any verdict is issued

// All-in round-trip cost at FARM_FEE_BPS and 10 SOL sizing, measured
// 2026-09-14 (0.10% fee + route friction + priority). Fixed here so a
// disappointing result cannot be rescued by quietly assuming a cheaper fill.
const FLOOR_PCT = { JUP: 0.19, FARTCOIN: 0.24, BONK: 0.25 };

// ── PRE-REGISTERED DECISION RULE ─────────────────────────────────────
// The signal is worth building on ONLY IF, at one of the horizons, ALL FOUR:
//   1. n >= MIN_TOTAL for the coin and >= MIN_PER_DECILE in every decile;
//   2. the decile means are monotone in the right direction, Spearman |rho|
//      >= 0.70 across the ten decile means;
//   3. the extreme decile's mean forward return, NET of that coin's floor, is
//      positive in BOTH halves of the collection window;
//   4. the net edge is >= 0.05% per round trip in the second half — a margin,
//      not a rounding error.
// Anything less is reported as "no", including a result that is positive but
// fails replication. Two of four is not a partial pass.
// ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DIR = path.resolve(args.includes('--dir') ? args[args.indexOf('--dir') + 1] : path.join('tape', 'ofi'));

function loadTrades(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.t === 'number' && typeof o.k === 'number' && o.p > 0) out.push(o);
    } catch {}
  }
  out.sort((a, b) => a.t - b.t || (a.b ?? 0) - (b.b ?? 0));
  return out;
}

/** Spearman rank correlation of a series against 1..n. */
function spearman(vals) {
  const n = vals.length;
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const rank = new Array(n);
  idx.forEach(([, i], r) => { rank[i] = r + 1; });
  const mean = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const a = rank[i] - mean, b = (i + 1) - mean;
    num += a * b; da += a * a; db += b * b;
  }
  return num / Math.sqrt(da * db);
}

/** Observations: OFI over the prior LOOKBACK_S, and the forward return at H. */
function observations(trades, H) {
  const rows = [];
  let lo = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i].t;
    while (trades[lo].t < t - LOOKBACK_S) lo++;
    if (i - lo < 5) continue;                       // need some flow to speak of
    let sv = 0, tv = 0;
    for (let j = lo; j <= i; j++) { sv += trades[j].k * trades[j].v; tv += trades[j].v; }
    if (!(tv > 0)) continue;
    // forward price: the last trade at or before t+H
    let k = i;
    while (k + 1 < trades.length && trades[k + 1].t <= t + H) k++;
    if (trades[k].t < t + H * 0.5) continue;        // no fill anywhere near the horizon
    if (k === i) continue;
    const fwd = (trades[k].p / trades[i].p - 1) * 100;
    if (!Number.isFinite(fwd)) continue;
    rows.push({ ofi: sv / tv, fwd, t });
  }
  return rows;
}

function decileTable(rows) {
  const s = [...rows].sort((a, b) => a.ofi - b.ofi);
  const per = Math.floor(s.length / DECILES);
  const cells = [];
  for (let d = 0; d < DECILES; d++) {
    const sl = s.slice(d * per, d === DECILES - 1 ? s.length : (d + 1) * per);
    const mean = sl.reduce((a, r) => a + r.fwd, 0) / sl.length;
    cells.push({ n: sl.length, mean, medOfi: sl[Math.floor(sl.length / 2)].ofi });
  }
  return cells;
}

console.log(`Reading ${DIR}`);
console.log(`PRE-REGISTERED: lookback ${LOOKBACK_S}s, horizons ${HORIZONS_S.join('/')}s, `
  + `need n>=${MIN_TOTAL}, |rho|>=0.70, net>=0.05% replicating in both halves.\n`);

let anyVerdict = false;
for (const sym of Object.keys(FLOOR_PCT)) {
  const trades = loadTrades(path.join(DIR, `${sym}.jsonl`));
  const floor = FLOOR_PCT[sym];
  if (!trades.length) { console.log(`${sym}: no data`); continue; }
  const spanH = (trades[trades.length - 1].t - trades[0].t) / 3600;
  console.log(`=== ${sym} — ${trades.length.toLocaleString()} trades over ${spanH.toFixed(1)}h, floor ${floor}% ===`);
  if (trades.length < MIN_TOTAL) {
    console.log(`  INSUFFICIENT: need ${MIN_TOTAL.toLocaleString()}, have ${trades.length.toLocaleString()}. `
      + `No verdict. (~${Math.max(0, ((MIN_TOTAL - trades.length) / Math.max(1, trades.length / Math.max(spanH, 0.01))) / 24).toFixed(1)} more days)\n`);
    continue;
  }
  anyVerdict = true;
  const mid = trades[0].t + (trades[trades.length - 1].t - trades[0].t) / 2;
  for (const H of HORIZONS_S) {
    const rows = observations(trades, H);
    if (rows.length < MIN_TOTAL) { console.log(`  H=${H}s: only ${rows.length} usable observations`); continue; }
    const cells = decileTable(rows);
    const rho = spearman(cells.map((c) => c.mean));
    const contrarian = rho < 0;
    const extreme = contrarian ? cells[0] : cells[DECILES - 1];
    const net = extreme.mean - floor;
    // replication: same extreme decile, each half
    const h1 = decileTable(rows.filter((r) => r.t < mid));
    const h2 = decileTable(rows.filter((r) => r.t >= mid));
    const n1 = (contrarian ? h1[0] : h1[DECILES - 1]).mean - floor;
    const n2 = (contrarian ? h2[0] : h2[DECILES - 1]).mean - floor;
    const thin = Math.min(...cells.map((c) => c.n)) < MIN_PER_DECILE;
    const pass = !thin && Math.abs(rho) >= 0.70 && n1 > 0 && n2 > 0 && n2 >= 0.05;
    console.log(`  H=${H}s  n=${rows.length.toLocaleString()}  rho=${rho.toFixed(2)} `
      + `(${contrarian ? 'contrarian' : 'momentum'})  extreme decile ${extreme.mean >= 0 ? '+' : ''}${extreme.mean.toFixed(3)}%  `
      + `net ${net >= 0 ? '+' : ''}${net.toFixed(3)}%  halves ${n1 >= 0 ? '+' : ''}${n1.toFixed(3)}/${n2 >= 0 ? '+' : ''}${n2.toFixed(3)}  `
      + `${pass ? '** PASS **' : 'no'}`);
    console.log('    deciles: ' + cells.map((c) => (c.mean >= 0 ? '+' : '') + c.mean.toFixed(2)).join(' '));
  }
  console.log('');
}
if (!anyVerdict) {
  console.log('No coin has enough data for a verdict yet. Leave scripts/ofi-collect.mjs running.');
  console.log('Re-run this unchanged — editing it after seeing partial results voids the test.');
}
