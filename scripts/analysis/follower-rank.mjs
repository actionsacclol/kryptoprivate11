// Rank leaders by what a FOLLOWER would have made, not by what they made.
//
// docs/wallet-convergence-2026-09-14.md found that rankLeaders' objective —
// the leader's own profitability — selects on pump for latency edge. The
// median such wallet holds six seconds, and an 800 ms lag makes a follower
// late on both legs. So the Leaderboard surfaces the least followable names.
//
// This tests the alternative objective directly:
//
//   score(wallet) = the MEDIAN return a follower would have realised mirroring
//                   that wallet's positions, entering and exiting at an honest
//                   fill (>= 800 ms after each of the wallet's own trades),
//                   net of the round-trip cost.
//
// The question is not whether that score is higher — by construction it is
// better aligned. The question is whether it PERSISTS: do wallets that were
// followable yesterday stay followable today? An objective that does not
// persist is a leaderboard that reshuffles noise.
//
// Method, same discipline as the convergence study:
//   * wallets are scored on the TRAINING day only and never re-scored;
//   * training-day deciles are carried to the test day untouched, so the top
//     decile is a prediction and not a description;
//   * positions the wallet never closed in-window are EXCLUDED, which flatters
//     every number here, and is said rather than hidden.
//
// Usage:
//   node scripts/analysis/follower-rank.mjs --train tape/trades/2026-09-10.csv \
//                                            --test  tape/trades/2026-09-11.csv

import fs from 'fs';
import readline from 'readline';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TRAIN = argOf('--train', null);
const TEST = argOf('--test', null);
if (!TRAIN || !TEST) { console.error('need --train and --test'); process.exit(1); }

const FILL_MS = 800;
const FILL_GIVEUP_MS = 60_000;
const COST_PCT = 0.85;          // pump round trip at FARM_FEE_BPS, 2 SOL
const MIN_POS = 5;              // rankLeaders' floor, in followable positions
const DECILES = 10;

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const trimmed = (a) => {
  if (a.length < 100) return null;
  const s = [...a].sort((x, y) => x - y);
  const c = Math.floor(s.length * 0.01);
  const t = s.slice(c, s.length - c);
  return t.reduce((x, y) => x + y, 0) / t.length;
};
const pct = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%');

async function load(file) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const p = line.split(',');
    const at = +p[0], price = +p[6], sol = +p[4];
    if (!Number.isFinite(at) || !Number.isFinite(price) || price <= 0) continue;
    rows.push({ at, mint: p[1], user: p[2], buy: p[3] === '1', sol: Number.isFinite(sol) ? sol : 0, price });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

function buildDay(rows) {
  const path = new Map();
  for (const r of rows) {
    let a = path.get(r.mint); if (!a) { a = []; path.set(r.mint, a); }
    a.push(r);
  }
  const fill = (mint, at) => {
    const a = path.get(mint); if (!a) return null;
    const target = at + FILL_MS;
    let lo = 0, hi = a.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].at >= target) { idx = m; hi = m - 1; } else lo = m + 1; }
    if (idx < 0 || a[idx].at > at + FILL_GIVEUP_MS) return null;
    return { price: a[idx].price, at: a[idx].at };
  };
  // first buy and subsequent sells per (user,mint)
  const firstBuy = new Map(), sells = new Map();
  for (const r of rows) {
    const k = r.user + '|' + r.mint;
    if (r.buy) { if (!firstBuy.has(k)) firstBuy.set(k, r.at); }
    else { const a = sells.get(k) || []; a.push(r.at); sells.set(k, a); }
  }
  for (const a of sells.values()) a.sort((x, y) => x - y);
  return { path, fill, firstBuy, sells };
}

/** Follower returns per wallet: what mirroring that wallet actually pays. */
function followerReturns(day) {
  const byUser = new Map();
  let unclosed = 0, unfillable = 0;
  for (const [k, bAt] of day.firstBuy) {
    const bar = k.indexOf('|');
    const user = k.slice(0, bar), mint = k.slice(bar + 1);
    const ss = day.sells.get(k);
    const sAt = ss && ss.find((t) => t > bAt);
    if (!sAt) { unclosed++; continue; }
    const entry = day.fill(mint, bAt);
    const exit = entry && day.fill(mint, sAt);
    if (!entry || !exit) { unfillable++; continue; }
    const ret = (exit.price / entry.price - 1) * 100 - COST_PCT;
    const a = byUser.get(user) || []; a.push(ret); byUser.set(user, a);
  }
  return { byUser, unclosed, unfillable };
}

console.log(`train ${TRAIN}\ntest  ${TEST}\n`);
const trainRows = await load(TRAIN);
const testRows = await load(TEST);
const trainDay = buildDay(trainRows);
const testDay = buildDay(testRows);

const tr = followerReturns(trainDay);
const te = followerReturns(testDay);
console.log(`training day: ${tr.byUser.size.toLocaleString()} wallets with a followable position `
  + `(${tr.unclosed.toLocaleString()} positions never closed, ${tr.unfillable.toLocaleString()} unfillable — both excluded)`);

// Score on the training day only.
const scored = [];
for (const [user, rets] of tr.byUser) {
  if (rets.length < MIN_POS) continue;
  scored.push({ user, n: rets.length, score: median(rets) });
}
scored.sort((a, b) => a.score - b.score);   // ascending, so decile 10 is best
console.log(`scored (>=${MIN_POS} followable positions): ${scored.length.toLocaleString()}`);
const positive = scored.filter((w) => w.score > 0);
console.log(`  followable-profitable on the training day: ${positive.length.toLocaleString()} `
  + `(${(100 * positive.length / (scored.length || 1)).toFixed(1)}%)`);

// ── does the objective PERSIST? ──────────────────────────────────────
console.log('\n=== Training-day follower-score deciles, carried to the test day ===');
console.log('decile   wallets   trainScore   |   testPos   testMedian   testTrimmed   win%');
const per = Math.floor(scored.length / DECILES);
let topCell = null;
for (let d = 0; d < DECILES; d++) {
  const sl = scored.slice(d * per, d === DECILES - 1 ? scored.length : (d + 1) * per);
  const trainMed = median(sl.map((w) => w.score));
  const rets = [];
  for (const w of sl) { const a = te.byUser.get(w.user); if (a) rets.push(...a); }
  const cell = {
    d: d + 1, wallets: sl.length, trainMed,
    n: rets.length, med: median(rets), trim: trimmed(rets),
    win: rets.length ? rets.filter((x) => x > 0).length / rets.length : null,
  };
  if (d === DECILES - 1) topCell = cell;
  console.log(`  ${String(d + 1).padStart(4)}   ${String(sl.length).padStart(7)}   ${pct(trainMed).padStart(10)}   |`
    + `   ${String(rets.length).padStart(7)}   ${pct(cell.med).padStart(10)}   ${pct(cell.trim).padStart(11)}   `
    + (cell.win == null ? '—' : (100 * cell.win).toFixed(1) + '%'));
}

// ── the comparison that matters ──────────────────────────────────────
// Current objective: the leader's OWN profitability. Rebuilt here from the
// same training day so the two rankings are compared on identical data.
const ownPos = new Map();
for (const r of trainRows) {
  const k = r.user + '|' + r.mint;
  let p = ownPos.get(k); if (!p) { p = { in: 0, out: 0, b: 0, s: 0 }; ownPos.set(k, p); }
  if (r.buy) { p.in += r.sol; p.b++; } else { p.out += r.sol; p.s++; }
}
const ownBy = new Map();
for (const [k, p] of ownPos) {
  if (!p.b || !p.s || p.in <= 0) continue;
  const u = k.slice(0, k.indexOf('|'));
  const a = ownBy.get(u) || []; a.push((p.out - p.in) / p.in * 100); ownBy.set(u, a);
}
function testReturnsFor(users) {
  const rets = [];
  for (const u of users) { const a = te.byUser.get(u); if (a) rets.push(...a); }
  return rets;
}
const oldTop = [...ownBy.entries()].filter(([, a]) => a.length >= MIN_POS)
  .map(([u, a]) => ({ u, s: a.reduce((x, y) => x + y, 0) / a.length }))
  .sort((a, b) => b.s - a.s);
const N = Math.max(1, per);
const oldSel = oldTop.slice(0, N).map((w) => w.u);
const newSel = scored.slice(-N).map((w) => w.user);
const oldR = testReturnsFor(oldSel), newR = testReturnsFor(newSel);
console.log(`\n=== Top ${N.toLocaleString()} wallets by each objective, mirrored on the test day ===`);
console.log('objective                        positions   median   trimmed    win%');
for (const [name, rets] of [['leader own PnL (rankLeaders today)', oldR], ['follower-realisable (proposed)', newR]]) {
  const w = rets.length ? rets.filter((x) => x > 0).length / rets.length : 0;
  console.log(`${name.padEnd(34)} ${String(rets.length).padStart(9)}   ${pct(median(rets)).padStart(6)}   `
    + `${pct(trimmed(rets)).padStart(7)}   ${(100 * w).toFixed(1)}%`);
}
console.log('\n(All net of the 0.85% round trip. Positions a wallet never closed in-window are');
console.log(' excluded from both, which flatters both. A negative top decile means the objective');
console.log(' does not persist and the ranking is reshuffling noise.)');
