// Migration-block edge re-validation across tape days.
//
// The 2026-07-25 scoping (docs/migration-block-scope-2026-07-25.md) killed the
// migration-block strategy on ONE day of tape. This script reproduces its four
// decisive tables on any day file so the kill (or the edge) can be tested for
// day-robustness:
//   A. P&L by arrival position (5 SOL, 5 s hold, uncapped)
//   B. 5% slippage cap as a position filter (fill rate + median by position)
//   C. Position-1 P&L by 95%-crossing lead-time bucket (the reachability split)
//   D. Reactive entry AFTER migration in the fast/mid buckets, net of 4.5%
//   E. Contested share: migration blocks with >1 distinct first-slot actor
//
// Usage: node scripts/analysis/migration_revalidate.mjs E:\data\2026-07-26.jsonl
// Constants match the originals (cap.mjs FEE=0.011, reachable2.mjs COST=0.045)
// so outputs are directly comparable with the 07-25 doc.
//
// Memory: only trades within POOL_WINDOW_MS of the migration are kept (every
// sim needs ≤ 80 s), stored as flat number arrays — a full 10 GB day fits in
// the default heap.

import fs from 'node:fs';
import readline from 'node:readline';
import { decodeAmmEvent, executedPriceSol } from '../../test/.ammdecoder.mjs';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node migration_revalidate.mjs <day.jsonl>'); process.exit(1); }
const FEE = 0.011;       // per-side AMM cost used in the 07-25 sim
const COST = 0.045;      // round-trip floor for the reactive-entry table
const SIZE_SOL = 5;
const HOLD_MS = 5_000;
const POOL_WINDOW_MS = 120_000; // keep trades this long after each migration
const POOL_TRADE_CAP = 2_000;
const L = 1e9;

// Per-pool: seed reserves + flat trade array [at, isBuy, q, b, px] * n.
const STRIDE = 5;
const migs = [];                 // { pool, mint, at }
const pools = new Map();         // pool -> { at, B0, Q0, t: number[], firstSlot, users:Set, slotTrades }
const cross95 = new Map();       // mint -> first ts curvePct>=95

let lines = 0;
const rl = readline.createInterface({ input: fs.createReadStream(SRC, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });
for await (const line of rl) {
  if (++lines % 5_000_000 === 0) {
    const m = process.memoryUsage();
    console.error(`${lines / 1e6}M lines: heap ${(m.heapUsed / 1e9).toFixed(2)}GB rss ${(m.rss / 1e9).toFixed(2)}GB pools ${pools.size} cross95 ${cross95.size}`);
  }
  if (line.startsWith('{"t":"tape_amm"')) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    for (const b64 of rec.d) {
      const e = decodeAmmEvent(b64); if (!e) continue;
      if (e.kind === 'amm_migration') {
        migs.push({ pool: e.pool, mint: e.mint, at: rec.at });
        pools.set(e.pool, { at: rec.at, B0: 0, Q0: 0, t: [], firstSlot: -1, users: new Set(), slotTrades: 0 });
        continue;
      }
      const p = pools.get(e.pool); if (!p) continue;
      if (rec.at - p.at > POOL_WINDOW_MS || p.t.length >= POOL_TRADE_CAP * STRIDE) continue;
      if (p.t.length === 0) { p.B0 = Number(e.poolBaseReserves); p.Q0 = Number(e.poolQuoteReserves); }
      p.t.push(rec.at, e.isBuy ? 1 : 0, Number(e.quoteAmount), Number(e.baseAmount), executedPriceSol(e));
      if (p.firstSlot < 0) p.firstSlot = rec.slot;
      if (rec.slot === p.firstSlot) { p.users.add(e.user); p.slotTrades++; }
    }
    continue;
  }
  if (!line.startsWith('{"t":"tape_trade"')) continue;
  const ci = line.indexOf('"curvePct":'); if (ci < 0) continue;
  let ce = line.indexOf(',', ci); if (ce < 0) ce = line.indexOf('}', ci);
  if (!(+line.slice(ci + 11, ce) >= 95)) continue;
  const mi = line.indexOf('"mint":"'); if (mi < 0) continue;
  const mint = line.slice(mi + 8, line.indexOf('"', mi + 8));
  if (cross95.has(mint)) continue;
  const ai = line.indexOf('"at":');
  // Store a FLAT copy: a stored slice is a V8 SlicedString that pins its
  // parent — ultimately the 4 MB stream chunk — and OOMs the whole run.
  cross95.set(Buffer.from(mint, 'utf8').toString('utf8'), +line.slice(ai + 5, line.indexOf(',', ai)));
}

const q = (a, f) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)] : NaN;
const pct = (x) => Number.isFinite(x) ? (100 * x).toFixed(2) + '%' : '—';

// Pool state (and price move vs seed) after replaying the first k trades.
function stateAfter(p, k) {
  let B = p.B0, Q = p.Q0;
  if (!(B > 0 && Q > 0)) return null;
  const seed = Q / B;
  for (let i = 0; i < k; i++) {
    const o = i * STRIDE;
    if (p.t[o + 1]) { const qq = p.t[o + 2]; const out = (B * qq) / (Q + qq); B -= out; Q += qq; }
    else { const b = p.t[o + 3]; const out = (Q * b) / (B + b); B += b; Q -= out; }
    if (!(B > 0 && Q > 0)) return null;
  }
  return { B, Q, moved: (Q / B) / seed - 1 };
}

// Insert our buy at arrival position `skip`, replay the tape, sell after HOLD_MS.
function sim(pool, skip, cap) {
  const p = pools.get(pool);
  if (!p || p.t.length < (skip + 3) * STRIDE) return null;
  const st = stateAfter(p, skip);
  if (!st) return null;
  if (cap !== null && st.moved > cap) return 'rejected';
  let { B, Q } = st;
  const qIn = SIZE_SOL * L * (1 - FEE);
  const ourBase = (B * qIn) / (Q + qIn);
  B -= ourBase; Q += qIn;
  const n = p.t.length / STRIDE;
  const t0 = p.t[Math.min(skip, n - 1) * STRIDE];
  for (let i = skip; i < n; i++) {
    const o = i * STRIDE;
    if (p.t[o] - t0 > HOLD_MS) break;
    if (p.t[o + 1]) { const qq = p.t[o + 2]; const out = (B * qq) / (Q + qq); B -= out; Q += qq; }
    else { const b = p.t[o + 3]; const out = (Q * b) / (B + b); B += b; Q -= out; }
    if (!(B > 0 && Q > 0)) return null;
  }
  return (((Q * ourBase) / (B + ourBase)) * (1 - FEE) - SIZE_SOL * L) / L;
}

console.log(`\n########## ${SRC} — ${migs.length} migrations, ${cross95.size} mints crossed 95% ##########`);

console.log('\n===== A. P&L by arrival position (5 SOL, 5 s, uncapped) =====');
console.log(`${'pos'.padStart(4)} ${'n'.padStart(5)} ${'median SOL'.padStart(11)} ${'median %'.padStart(9)} ${'win%'.padStart(6)}`);
for (const skip of [0, 1, 2, 3, 5]) {
  const out = [];
  for (const m of migs) { const r = sim(m.pool, skip, null); if (Number.isFinite(r)) out.push(r); }
  console.log(`${String(skip + 1).padStart(4)} ${String(out.length).padStart(5)} ${q(out, .5).toFixed(4).padStart(11)} ${pct(q(out, .5) / SIZE_SOL).padStart(9)} ${(100 * out.filter((x) => x > 0).length / (out.length || 1)).toFixed(1).padStart(5)}%`);
}

console.log('\n===== B. 5% slippage cap as position filter =====');
console.log(`${'pos'.padStart(4)} ${'filled'.padStart(7)} ${'fill%'.padStart(6)} ${'median SOL'.padStart(11)} ${'win%'.padStart(6)}`);
for (const skip of [0, 1, 2, 3, 5]) {
  const filled = []; let seen = 0;
  for (const m of migs) {
    const r = sim(m.pool, skip, 0.05);
    if (r === null) continue;
    seen++;
    if (r !== 'rejected' && Number.isFinite(r)) filled.push(r);
  }
  console.log(`${String(skip + 1).padStart(4)} ${String(filled.length).padStart(7)} ${(100 * filled.length / (seen || 1)).toFixed(0).padStart(5)}% ${q(filled, .5).toFixed(4).padStart(11)} ${(100 * filled.filter((x) => x > 0).length / (filled.length || 1)).toFixed(1).padStart(5)}%`);
}

console.log('\n===== C. Position-1 P&L by 95%-crossing lead time =====');
const buckets = [
  // No lower bound: a migration whose ≥95% tick arrives after the migration
  // event (out-of-order delivery of a same-instant crossing) is the FASTEST
  // case, not "no crossing" — matches the original reachable2.mjs semantics.
  ['fast <400ms', (d) => d < 400],
  ['mid 400ms-2s', (d) => d >= 400 && d < 2000],
  ['2s-30s', (d) => d >= 2000 && d < 30_000],
  ['>30s', (d) => d >= 30_000],
  ['no crossing', null],
];
const byBucket = new Map(buckets.map(([n]) => [n, []]));
for (const m of migs) {
  const c = cross95.get(m.mint);
  let name = 'no crossing';
  if (c !== undefined) {
    const d = m.at - c;
    for (const [n, f] of buckets) if (f && f(d)) { name = n; break; }
  }
  byBucket.get(name).push(m);
}
console.log(`${'bucket'.padStart(14)} ${'n'.padStart(5)} ${'median SOL'.padStart(11)} ${'median %'.padStart(9)} ${'win%'.padStart(6)} ${'SOL/day'.padStart(9)}`);
for (const [name] of buckets) {
  const out = [];
  for (const m of byBucket.get(name)) { const r = sim(m.pool, 0, null); if (Number.isFinite(r)) out.push(r); }
  if (!out.length) { console.log(`${name.padStart(14)} ${'0'.padStart(5)}`); continue; }
  console.log(`${name.padStart(14)} ${String(out.length).padStart(5)} ${q(out, .5).toFixed(4).padStart(11)} ${pct(q(out, .5) / SIZE_SOL).padStart(9)} ${(100 * out.filter((x) => x > 0).length / out.length).toFixed(1).padStart(5)}% ${(q(out, .5) * out.length).toFixed(1).padStart(9)}`);
}

console.log(`\n===== D. Reactive entry AFTER migration (net of ${pct(COST)}) =====`);
function pxAfter(p, t) {
  for (let o = 0; o < p.t.length; o += STRIDE) if (p.t[o] >= t && p.t[o + 4] > 0) return p.t[o + 4];
  return 0;
}
function pxBefore(p, t) {
  let last = 0;
  for (let o = 0; o < p.t.length; o += STRIDE) { if (p.t[o] <= t) { if (p.t[o + 4] > 0) last = p.t[o + 4]; } else break; }
  return last;
}
for (const bname of ['fast <400ms', 'mid 400ms-2s']) {
  const set = byBucket.get(bname);
  console.log(`--- ${bname}, n=${set.length} ---`);
  console.log(`${'entry'.padStart(7)} ${'hold'.padStart(6)} ${'n'.padStart(5)} ${'median'.padStart(9)} ${'win%'.padStart(6)}`);
  for (const entryMs of [1_000, 5_000, 15_000]) {
    for (const holdMs of [5_000, 30_000, 60_000]) {
      const out = [];
      for (const m of set) {
        const p = pools.get(m.pool); if (!p || p.t.length < 4 * STRIDE) continue;
        const e = pxAfter(p, m.at + entryMs); if (!(e > 0)) continue;
        const x = pxBefore(p, m.at + entryMs + holdMs); if (!(x > 0)) continue;
        out.push(x / e - 1 - COST);
      }
      if (out.length < 15) continue;
      console.log(`${(entryMs / 1000 + 's').padStart(7)} ${(holdMs / 1000 + 's').padStart(6)} ${String(out.length).padStart(5)} ${pct(q(out, .5)).padStart(9)} ${(100 * out.filter((x) => x > 0).length / out.length).toFixed(1).padStart(5)}%`);
    }
  }
}

console.log('\n===== E. First-slot contention =====');
let contested = 0, withTrades = 0;
const firstSlotTrades = [];
for (const p of pools.values()) {
  if (!p.t.length) continue;
  withTrades++;
  firstSlotTrades.push(p.slotTrades);
  if (p.users.size > 1) contested++;
}
console.log(`pools with trades: ${withTrades}; first-slot >1 distinct actor: ${contested} (${(100 * contested / (withTrades || 1)).toFixed(1)}%); median first-slot trades: ${q(firstSlotTrades, .5)}`);
