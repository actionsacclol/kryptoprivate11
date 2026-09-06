// Daily shadow report.
//
// One streaming pass over a recorder day-file. Answers the only question that
// matters while the bot runs in shadow: has anything changed versus the
// measured baselines in docs\?
//
//   node scripts/daily-report.mjs                  # latest day in E:\data
//   node scripts/daily-report.mjs 2026-07-26
//   node scripts/daily-report.mjs 2026-07-26 D:\other
//
// Memory-safe: nothing per-trade is retained except bounded per-pool price
// paths for the migration section. Day files run ~10 GB.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
// argv[2] is a date if it looks like one, otherwise it is the directory.
const argDate = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
const argDir = process.argv[3] ?? (argDate ? null : process.argv[2]);
const DIR = argDir ?? readRecorderDir() ?? 'E:\\data';

function readRecorderDir() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA ?? '', 'Krypt Sniper', 'settings.json'), 'utf8'));
    return typeof s.recorderDir === 'string' && s.recorderDir.trim() ? s.recorderDir.trim() : null;
  } catch { return null; }
}

const day = argDate ?? fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().pop()?.slice(0, 10);
if (!day) { console.error(`no day files in ${DIR}`); process.exit(1); }
const FILE = path.join(DIR, `${day}.jsonl`);
if (!fs.existsSync(FILE)) { console.error(`missing ${FILE}`); process.exit(1); }

// Build the amm decoder on demand (esbuild is a devDependency; ~5ms).
const BUNDLE = path.join(ROOT, 'test', '.ammdecoder.mjs');
try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['esbuild', 'electron/engine/ammDecoder.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${BUNDLE}`],
    { cwd: ROOT, stdio: 'ignore' });
} catch { /* fall back to an existing bundle if esbuild is unavailable */ }
const { decodeAmmEvent, executedPriceSol } = await import(pathToFileURL(BUNDLE).href);

// ── baselines measured on 2026-07-25 (docs\tape-audit, amm-decoder, migration-block-scope)
const BASE = {
  gradResolvedWin: 1.00,      // 25/25 graduations profitable at first post-migration trade
  costFloorAt010: 0.045,      // local-build + ATA close @0.10 SOL
  reachableMedian: -0.0393,   // fast-crossing, +1s entry, 5s hold, net
  posOneFastMedianPct: 0.299, // first-in-block, fast crossing, 5 SOL
};

const kinds = new Map();
const rejectReasons = new Map();
let creates = 0, enters = 0, passes = 0;
const posCloses = [], stratExits = [], dipExits = [], migExits = [];
let feedLoss = [], ammLayoutErr = 0;

// migration section state
const migs = [];                 // {mintH, pool, at}
const paths = new Map();         // pool -> [[at, px]]
const cross95 = new Map();       // mintH -> first t at >=95%
const MIN_QUOTE = 10_000_000n;
function hash(s, a, b) { let h = 0x811c9dc5; for (let i = a; i < b; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

const t0 = Date.now();
const rl = readline.createInterface({ input: fs.createReadStream(FILE, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });
for await (const line of rl) {
  const ti = line.indexOf('"t":"'); if (ti !== 1) continue;
  const te = line.indexOf('"', ti + 5);
  const kind = line.slice(ti + 5, te);
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);

  if (kind === 'tape_amm') {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    for (const b64 of rec.d) {
      const e = decodeAmmEvent(b64); if (!e) continue;
      if (e.kind === 'amm_migration') { migs.push({ h: hash(e.mint, 0, e.mint.length), pool: e.pool, at: rec.at }); paths.set(e.pool, []); continue; }
      const p = paths.get(e.pool); if (!p) continue;
      if (e.quoteAmount < MIN_QUOTE) continue;
      const px = executedPriceSol(e);
      if (px > 0 && p.length < 8000) p.push([rec.at, px]);
    }
    continue;
  }
  if (kind === 'tape_trade') {
    const ci = line.indexOf('"curvePct":'); if (ci < 0) continue;
    let ce = line.indexOf(',', ci); if (ce < 0) ce = line.indexOf('}', ci);
    if (!(+line.slice(ci + 11, ce) >= 95)) continue;
    const mi = line.indexOf('"mint":"'); if (mi < 0) continue;
    const me = line.indexOf('"', mi + 8);
    const ai = line.indexOf('"at":'); const t = +line.slice(ai + 5, line.indexOf(',', ai));
    const h = hash(line, mi + 8, me);
    if (!cross95.has(h)) cross95.set(h, t);
    continue;
  }
  if (kind === 'create') { creates++; continue; }
  if (kind === 'decision') {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.action === 'enter') enters++;
    else if (r.action === 'pass') passes++;
    else if (r.action === 'reject') rejectReasons.set(r.reason, (rejectReasons.get(r.reason) ?? 0) + 1);
    continue;
  }
  if (kind === 'position_close') { try { posCloses.push(JSON.parse(line)); } catch {} continue; }
  if (kind === 'strat_exit') { try { stratExits.push(JSON.parse(line)); } catch {} continue; }
  if (kind === 'dip_exit') { try { dipExits.push(JSON.parse(line)); } catch {} continue; }
  if (kind === 'mig_exit') { try { migExits.push(JSON.parse(line)); } catch {} continue; }
  if (kind === 'feed_health') { try { feedLoss.push(JSON.parse(line).lossPct ?? 0); } catch {} continue; }
}

const n = (x, d = 4) => (x >= 0 ? '+' : '') + x.toFixed(d);
const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)] : NaN);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const bar = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

console.log(`\nKRYPT SNIPER — shadow report for ${day}`);
console.log(`file ${FILE}  (${(fs.statSync(FILE).size / 1e9).toFixed(2)} GB, scanned in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

bar('CAPTURE');
for (const [k, c] of [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
  console.log(`  ${k.padEnd(18)} ${c.toLocaleString().padStart(12)}`);
if (feedLoss.length) {
  const md = q(feedLoss, .5);
  console.log(`  feed loss%: median ${md.toFixed(2)}  p90 ${q(feedLoss, .9).toFixed(2)}  (samples ${feedLoss.length})`);
  if (md >= 5) {
    console.log(`  ** FEED LOSS ${md.toFixed(1)}% — flow features are computed on ${(100 - md).toFixed(0)}% of events.`);
    console.log(`     uniqueBuyers / netInflow / topBuyerShare are all understated, and a lossy`);
    console.log(`     feed is a documented source of fake backtest edge. Set a Helius key in`);
    console.log(`     Settings (rpc.heliusApiKey) before trusting any new signal from this day.`);
  }
}

bar('FUNNEL');
const rejTot = sum([...rejectReasons.values()]);
console.log(`  creates ${creates.toLocaleString()} → reject ${rejTot.toLocaleString()} · pass ${passes.toLocaleString()} · ENTER ${enters}`);
for (const [r, c] of [...rejectReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4))
  console.log(`    ${((100 * c) / (rejTot || 1)).toFixed(1).padStart(5)}%  ${r}`);

bar('LIVE ENGINE (paper book)');
if (!posCloses.length) console.log('  no closed positions');
else {
  const p = posCloses.map((x) => x.pnlSol).filter(Number.isFinite);
  const reasons = new Map();
  for (const c of posCloses) reasons.set(c.reason, (reasons.get(c.reason) ?? 0) + 1);
  console.log(`  n=${p.length}  total=${n(sum(p))} SOL  mean=${n(sum(p) / p.length, 5)}  wins=${p.filter((x) => x > 0).length}/${p.length}`);
  console.log(`  exits: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
}

bar('SHADOW STRAT LAB');
if (!stratExits.length) console.log('  no exits');
else {
  const byStrat = new Map();
  for (const e of stratExits) {
    let g = byStrat.get(e.strat); if (!g) { g = { booked: [], resolved: [], unresolved: 0 }; byStrat.set(e.strat, g); }
    if (e.reason === 'graduated' && e.resolved) { g.resolved.push(e.pnlSol); g.booked.push(e.pnlSol); }
    else if (e.reason === 'graduated' && e.unresolved) g.unresolved++;
    else if (Number.isFinite(e.pnlSol)) g.booked.push(e.pnlSol);
  }
  console.log(`  ${'strat'.padEnd(24)} ${'n'.padStart(5)} ${'total SOL'.padStart(11)} ${'win%'.padStart(6)} ${'grad✓'.padStart(6)} ${'grad?'.padStart(6)}`);
  for (const [k, g] of byStrat) {
    const t = sum(g.booked);
    console.log(`  ${k.padEnd(24)} ${String(g.booked.length).padStart(5)} ${n(t).padStart(11)} ${(g.booked.length ? ((100 * g.booked.filter((x) => x > 0).length) / g.booked.length).toFixed(1) : '—').padStart(5)}% ${String(g.resolved.length).padStart(6)} ${String(g.unresolved).padStart(6)}`);
  }
  const allRes = stratExits.filter((e) => e.resolved && Number.isFinite(e.pnlSol));
  if (allRes.length) {
    const w = allRes.filter((e) => e.pnlSol > 0).length / allRes.length;
    console.log(`\n  graduations MARKED: ${allRes.length}, ${(100 * w).toFixed(0)}% profitable, total ${n(sum(allRes.map((e) => e.pnlSol)))} SOL`);
    console.log(`  baseline 2026-07-25: 100% profitable at first post-migration trade (n=25)`);
    if (w < 0.6) console.log(`  ** graduation edge has degraded vs baseline **`);
  }
  const stillOpen = stratExits.filter((e) => e.unresolved).length;
  if (stillOpen) console.log(`  ${stillOpen} graduation(s) went unresolved (pool never traded in the window)`);
}

bar('DIP SHADOW');
if (!dipExits.length) console.log('  no exits');
else {
  const byVar = new Map();
  for (const e of dipExits) { let g = byVar.get(e.variant); if (!g) { g = []; byVar.set(e.variant, g); } if (Number.isFinite(e.pnlSol)) g.push(e.pnlSol); }
  for (const [k, v] of [...byVar.entries()].sort((a, b) => sum(b[1]) - sum(a[1])))
    console.log(`  ${k.padEnd(24)} n=${String(v.length).padStart(5)} total=${n(sum(v), 3).padStart(9)} win=${((100 * v.filter((x) => x > 0).length) / v.length).toFixed(1)}%`);
}

bar('MIGRATION SHADOW  (paper 5 SOL, per arrival lane)');
if (!migExits.length) console.log('  no records (shadowMigration off or no graduations)');
else {
  const lanes = new Map();
  for (const e of migExits) {
    let g = lanes.get(e.lane);
    if (!g) { g = { pnl: [], aborts: 0, noFills: 0, fast: [], mid: [] }; lanes.set(e.lane, g); }
    if (e.outcome === 'filled' && Number.isFinite(e.pnlSol)) {
      g.pnl.push(e.pnlSol);
      if (e.leadMs !== null && e.leadMs < 400) g.fast.push(e.pnlSol);
      else if (e.leadMs !== null && e.leadMs < 2000) g.mid.push(e.pnlSol);
    } else if (e.outcome === 'abort_slippage') g.aborts++;
    else g.noFills++;
  }
  console.log(`  ${'lane'.padEnd(10)} ${'fills'.padStart(6)} ${'total SOL'.padStart(10)} ${'median'.padStart(8)} ${'win%'.padStart(6)} ${'cap-aborts'.padStart(11)} ${'no-fill'.padStart(8)}`);
  for (const [k, g] of lanes) {
    console.log(`  ${k.padEnd(10)} ${String(g.pnl.length).padStart(6)} ${n(sum(g.pnl), 3).padStart(10)} ${(g.pnl.length ? n(q(g.pnl, .5), 3) : '—').padStart(8)} ${(g.pnl.length ? ((100 * g.pnl.filter((x) => x > 0).length) / g.pnl.length).toFixed(0) : '—').padStart(5)}% ${String(g.aborts).padStart(11)} ${String(g.noFills).padStart(8)}`);
  }
  for (const [k, g] of lanes) {
    if (g.fast.length >= 5 || g.mid.length >= 5)
      console.log(`  ${k}: fast-lead fills ${g.fast.length} (${n(sum(g.fast), 3)} SOL) · mid-lead fills ${g.mid.length} (${n(sum(g.mid), 3)} SOL)`);
  }
  console.log(`  block0 is the unreachable position-1 reference; react400/react800 are what a reactive sender gets.`);
}

bar('MIGRATION REGIME  (the thing to watch)');
for (const p of paths.values()) p.sort((a, b) => a[0] - b[0]);
const after = (p, t) => { for (const [ts, px] of p) if (ts >= t) return px; return 0; };
const before = (p, t) => { let last = 0; for (const [ts, px] of p) { if (ts <= t) last = px; else break; } return last; };
console.log(`  migrations: ${migs.length}   with a 95% crossing observed: ${migs.filter((m) => cross95.has(m.h)).length}`);
if (migs.length) {
  const leads = migs.filter((m) => cross95.has(m.h)).map((m) => m.at - cross95.get(m.h)).filter((x) => x >= 0);
  if (leads.length) console.log(`  lead 95%→migration: median ${q(leads, .5)}ms  p25 ${q(leads, .25)}ms  <400ms ${((100 * leads.filter((x) => x < 400).length) / leads.length).toFixed(0)}%`);

  // the reachable trade: enter +1s after migration on fast-crossing tokens
  const COST = BASE.costFloorAt010;
  for (const [label, lo, hi] of [['fast  <400ms', -1, 400], ['mid   0.4-2s', 400, 2000], ['slow  2-30s', 2000, 30_000]]) {
    const rows = [];
    for (const m of migs) {
      if (!cross95.has(m.h)) continue;
      const lead = m.at - cross95.get(m.h);
      if (!(lead >= lo && lead < hi)) continue;
      const p = paths.get(m.pool); if (!p || p.length < 4) continue;
      const e = after(p, m.at + 1000); if (!(e > 0)) continue;
      const x = before(p, m.at + 6000); if (!(x > 0)) continue;
      rows.push(x / e - 1 - COST);
    }
    if (rows.length < 10) { console.log(`  ${label}  n=${rows.length} — too few`); continue; }
    const md = q(rows, .5);
    const flag = md > 0 ? '   <<< POSITIVE — investigate' : '';
    console.log(`  ${label}  n=${String(rows.length).padStart(4)}  median ${(100 * md).toFixed(2).padStart(7)}%  win ${((100 * rows.filter((x) => x > 0).length) / rows.length).toFixed(0).padStart(3)}%${flag}`);
  }
  console.log(`  baseline 2026-07-25 (fast, +1s, net): ${(100 * BASE.reachableMedian).toFixed(2)}% median, 6.5% win`);
}

bar('VERDICT');
const liveTot = posCloses.length ? sum(posCloses.map((x) => x.pnlSol).filter(Number.isFinite)) : 0;
const labTot = sum(stratExits.filter((e) => Number.isFinite(e.pnlSol)).map((e) => e.pnlSol));
const dipTot = sum(dipExits.filter((e) => Number.isFinite(e.pnlSol)).map((e) => e.pnlSol));
console.log(`  live paper ${n(liveTot)} SOL · strat lab ${n(labTot)} SOL · dip shadow ${n(dipTot)} SOL`);
console.log(`  Reminder: a candidate needs gross drift > ~4.5% at 0.10 SOL before it is worth a shadow slot.`);
console.log(`  Dead ends are recorded in docs\\ — check the registry before acting on anything here.\n`);
