// Does SMART-MONEY CONVERGENCE predict, and does it predict better than
// following one smart wallet?
//
// THE QUESTION, AND WHY IT IS NOT ALREADY ANSWERED
//
// docs/volume-edge-swarm-2026-09-14.md tested "smart" — follow repeat-
// profitable wallets, 60 s hold — and it lost: -1.79% in sample, -3.35% out.
// Its diagnosis was arithmetic, not predictive: "the leaders' own edge is
// +0.34%/trip; the follower's tax is 1.60%."
//
// That test followed wallets INDIVIDUALLY. It never asked whether several
// independent leaders landing on the SAME mint within a few minutes is a
// stronger signal than any one of them. That is this file.
//
// Discipline, because this project has been burned by it twice:
//   * leaders are ranked on a TRAINING day and never re-ranked on the test day;
//   * every forward return is measured from the price of the trade we would
//     actually enter on, not from the first leader's price;
//   * the K=1 column IS the swarm's original strategy, so the convergence
//     claim has to beat a baseline computed the same way on the same data.
//
// THE THREE WAYS THIS DIES, all reported before any edge number:
//   1. Leaders do not persist — pump wallets are often single-day. If few
//      day-1 leaders trade on day 2 there is nothing to converge.
//   2. Convergence is too rare to be a business.
//   3. Waiting for the K-th confirmation costs more than the confirmation is
//      worth — the price has already moved. Reported as "drift 1st->Kth".
//
// Usage:
//   node scripts/analysis/convergence.mjs --train tape/trades/2026-09-10.csv \
//                                         --test  tape/trades/2026-09-11.csv

import fs from 'fs';
import readline from 'readline';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TRAIN = argOf('--train', null);
const TEST = argOf('--test', null);
if (!TRAIN || !TEST) { console.error('need --train and --test CSVs'); process.exit(1); }

const MIN_TRIPS = 5;              // rankLeaders' own floor
const WINDOWS_MIN = [5, 15, 30];  // how close together leader buys must land
const KS = [1, 2, 3, 4];          // 1 = the swarm's original single-leader strategy
const HORIZONS_MIN = [1, 5, 15, 30, 60];
// Pump round trip at FARM_FEE_BPS, 2 SOL: 0.10% fee + 0.60% pool (0.30%/side,
// measured over 13.6M swaps) + ~0.15% priority. The pool fee is unavoidable
// and is why pump stays expensive even at the farm rate.
const COST_PCT = 0.85;
// The honest-fill rule from the swarm: we cannot fill inside the leader's own
// transaction. Entry is the first print at least this long after their trade.
const FILL_MS = 800;
const FILL_GIVEUP_MS = 60_000;   // no print within a minute -> the event is unfillable

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

/** Realized edge per wallet: SOL out vs SOL in, per (wallet,mint) position. */
function rankWallets(rows) {
  const pos = new Map();   // `${user}|${mint}` -> {in,out,buys,sells}
  for (const r of rows) {
    const k = r.user + '|' + r.mint;
    let p = pos.get(k);
    if (!p) { p = { in: 0, out: 0, buys: 0, sells: 0 }; pos.set(k, p); }
    if (r.buy) { p.in += r.sol; p.buys++; } else { p.out += r.sol; p.sells++; }
  }
  const byUser = new Map();
  for (const [k, p] of pos) {
    if (!p.buys || !p.sells || p.in <= 0) continue;     // only CLOSED positions count
    const user = k.slice(0, k.indexOf('|'));
    let u = byUser.get(user);
    if (!u) { u = { trips: 0, edge: 0 }; byUser.set(user, u); }
    u.trips++; u.edge += (p.out - p.in) / p.in * 100;
  }
  const out = [];
  for (const [user, u] of byUser) {
    if (u.trips < MIN_TRIPS) continue;
    out.push({ user, trips: u.trips, edge: u.edge / u.trips });
  }
  out.sort((a, b) => b.edge - a.edge);
  return out;
}

const pct = (x) => (x >= 0 ? '+' : '') + x.toFixed(3) + '%';

console.log(`train ${TRAIN}\ntest  ${TEST}\n`);
const train = await load(TRAIN);
const test = await load(TEST);
console.log(`trades: train ${train.length.toLocaleString()}, test ${test.length.toLocaleString()}`);

const ranked = rankWallets(train);
const profitable = ranked.filter((w) => w.edge > 0);
console.log(`wallets with >=${MIN_TRIPS} closed trips on the training day: ${ranked.length.toLocaleString()}`);
console.log(`  of which profitable: ${profitable.length.toLocaleString()} (mean edge ${pct(profitable.reduce((a, w) => a + w.edge, 0) / (profitable.length || 1))})`);

const leaders = new Set(profitable.map((w) => w.user));

// ── death #1: do leaders persist? ────────────────────────────────────
const testUsers = new Set(test.map((r) => r.user));
let present = 0;
for (const l of leaders) if (testUsers.has(l)) present++;
console.log(`\n[1] LEADER PERSISTENCE: ${present.toLocaleString()} of ${leaders.size.toLocaleString()} `
  + `(${(100 * present / (leaders.size || 1)).toFixed(1)}%) traded again on the test day`);
if (!present) { console.log('  no leaders persist — nothing can converge. Stop.'); process.exit(0); }

// price path per mint on the test day, for forward returns
const path = new Map();
for (const r of test) {
  let a = path.get(r.mint);
  if (!a) { a = []; path.set(r.mint, a); }
  a.push(r);
}
/** The price we could actually be filled at: first print >= FILL_MS after the
 *  leader's trade. Returns null when nothing prints, which is itself a finding
 *  — an event you cannot enter is not an opportunity. */
function fillAfter(mint, at) {
  const a = path.get(mint); if (!a) return null;
  let lo = 0, hi = a.length - 1, idx = -1;
  const target = at + FILL_MS;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].at >= target) { idx = m; hi = m - 1; } else lo = m + 1; }
  if (idx < 0) return null;
  if (a[idx].at > at + FILL_GIVEUP_MS) return null;
  return { price: a[idx].price, at: a[idx].at };
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
/** 1%-trimmed mean — the swarm's own summary for fat-tailed pump returns. */
const trimmed = (a) => {
  if (a.length < 100) return null;
  const s = [...a].sort((x, y) => x - y);
  const cut = Math.floor(s.length * 0.01);
  const t = s.slice(cut, s.length - cut);
  return t.reduce((x, y) => x + y, 0) / t.length;
};

function fwd(mint, at, mins) {
  const a = path.get(mint); if (!a) return null;
  const target = at + mins * 60000;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].at <= target) { best = m; lo = m + 1; } else hi = m - 1; }
  if (best < 0) return null;
  // require a print reasonably near the horizon, else the token went quiet
  if (a[best].at < at + mins * 60000 * 0.5) return null;
  return a[best].price;
}

// ── THE CONTROL ──────────────────────────────────────────────────────
// Pump tokens bleed. Without a baseline measured the SAME way — same honest
// fill, same forward lookup, same survivorship filter — a negative number says
// nothing about whether the signal is bad or the asset class is.
{
  const buys = test.filter((r) => r.buy);
  const step = Math.max(1, Math.floor(buys.length / 20000));
  const sample = [];
  for (let i = 0; i < buys.length; i += step) sample.push(buys[i]);
  console.log(`
=== CONTROL: ${sample.length.toLocaleString()} random buys, identical fill and forward logic ===`);
  const cells = [];
  for (const H of HORIZONS_MIN) {
    const rs = []; let dead = 0;
    for (const e of sample) {
      const f = fillAfter(e.mint, e.at);
      if (!f) continue;
      const p = fwd(e.mint, f.at, H);
      if (!p) { dead++; continue; }
      rs.push((p / f.price - 1) * 100);
    }
    cells.push(rs.length ? { med: median(rs), trim: trimmed(rs), n: rs.length, dead } : null);
  }
  console.log('     median          :' + cells.map((c) => (c ? pct(c.med).padStart(11) : '          —')).join(''));
  console.log('     trimmed mean    :' + cells.map((c) => (c && c.trim != null ? pct(c.trim).padStart(11) : '          —')).join(''));
  console.log('     survived        :' + cells.map((c) => (c ? `${(100 * c.n / (c.n + c.dead)).toFixed(0)}%`.padStart(11) : '          —')).join(''));
  console.log('  Any convergence number must be read against THIS row, not against zero.');
}

// ── convergence events ───────────────────────────────────────────────
for (const W of WINDOWS_MIN) {
  console.log(`\n=== window ${W}m — distinct leaders buying the same mint within ${W} minutes ===`);
  // per mint: rolling list of (leader, at, price) buys
  const seen = new Map();
  const events = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of test) {
    if (!r.buy || !leaders.has(r.user)) continue;
    let a = seen.get(r.mint);
    if (!a) { a = []; seen.set(r.mint, a); }
    const cut = r.at - W * 60000;
    while (a.length && a[0].at < cut) a.shift();
    if (!a.some((x) => x.user === r.user)) a.push({ user: r.user, at: r.at, price: r.price });
    const k = a.length;
    if (KS.includes(k) && a[a.length - 1].at === r.at && a[a.length - 1].user === r.user) {
      events[k].push({ mint: r.mint, at: r.at, price: r.price, first: a[0].price, firstAt: a[0].at });
    }
  }
  console.log('  K  events  fillable   drift1->K  ' + HORIZONS_MIN.map((h) => `${h}m med`.padStart(11)).join(''));
  for (const K of KS) {
    const ev = events[K];
    if (!ev.length) { console.log(`  ${K}  (none)`); continue; }
    // honest fill first: an event we cannot enter is dropped and COUNTED
    const filled = [];
    for (const e of ev) { const f = fillAfter(e.mint, e.at); if (f) filled.push({ ...e, entry: f.price, entryAt: f.at }); }
    const drift = filled.length ? filled.reduce((a, e) => a + (e.price / e.first - 1) * 100, 0) / filled.length : 0;
    const cells = [];
    for (const H of HORIZONS_MIN) {
      const rs = [];
      let dead = 0;
      for (const e of filled) {
        const p = fwd(e.mint, e.entryAt, H);
        if (!p) { dead++; continue; }
        rs.push((p / e.entry - 1) * 100);
      }
      cells.push(rs.length ? { med: median(rs), trim: trimmed(rs), mean: rs.reduce((a, b) => a + b, 0) / rs.length, n: rs.length, dead } : null);
    }
    console.log(`  ${K}  ${String(ev.length).padStart(6)}  ${(100 * filled.length / ev.length).toFixed(0).padStart(7)}%  `
      + pct(drift).padStart(10) + '  '
      + cells.map((c) => (c ? pct(c.med).padStart(11) : '          —')).join(''));
    console.log('      trimmed mean:'.padEnd(29) + cells.map((c) => (c && c.trim != null ? pct(c.trim).padStart(11) : '          —')).join(''));
    console.log('      survived to horizon:'.padEnd(29) + cells.map((c) => (c ? `${(100 * c.n / (c.n + c.dead)).toFixed(0)}%`.padStart(11) : '          —')).join(''));
  }
  console.log(`  (MEDIAN and 1%-trimmed mean; cost at the farm rate on pump is ${COST_PCT}% a round trip.`);
  console.log(`   "survived" = the mint still printed near that horizon; the rest are excluded and that is survivorship.)`);
}

// ── MIRROR THE EXIT, which is what the product actually does ──────────
// Everything above holds for a fixed horizon. The leaders do not: they sell.
// copytrade-paper-first has mirrored leader sells since 2026-09-08, so the
// honest simulation of the shipped feature is buy when they buy, sell when
// they sell — both legs at an honest fill.
{
  console.log('');
  console.log('=== MIRROR ENTRY *AND* EXIT (the shipped copy-trade shape) ===');
  // when did each leader sell each mint? first sell after their buy.
  const sells = new Map();   // user|mint -> [at,...]
  for (const r of test) {
    if (r.buy || !leaders.has(r.user)) continue;
    const k = r.user + '|' + r.mint;
    let a = sells.get(k); if (!a) { a = []; sells.set(k, a); }
    a.push(r.at);
  }
  for (const a of sells.values()) a.sort((x, y) => x - y);

  const rets = []; let noExit = 0, noFill = 0;
  const holds = [];
  const firstBuy = new Set();
  for (const r of test) {
    if (!r.buy || !leaders.has(r.user)) continue;
    const k = r.user + '|' + r.mint;
    if (firstBuy.has(k)) continue;           // one position per leader per mint
    firstBuy.add(k);
    const entry = fillAfter(r.mint, r.at);
    if (!entry) { noFill++; continue; }
    const ss = sells.get(k);
    const sAt = ss && ss.find((t) => t > r.at);
    if (!sAt) { noExit++; continue; }        // never sold in-window: unresolved, NOT a win
    const exit = fillAfter(r.mint, sAt);
    if (!exit) { noFill++; continue; }
    rets.push((exit.price / entry.price - 1) * 100);
    holds.push((sAt - r.at) / 60000);
  }
  const n = rets.length;
  console.log(`  positions: ${n.toLocaleString()} mirrored, ${noExit.toLocaleString()} never closed in-window (excluded), ${noFill.toLocaleString()} unfillable`);
  if (n) {
    const med = median(rets), tm = trimmed(rets);
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    const win = rets.filter((x) => x > COST_PCT).length / n;
    console.log(`  median ${pct(med)}   trimmed mean ${pct(tm ?? NaN)}   raw mean ${pct(mean)}`);
    console.log(`  net of ${COST_PCT}% cost:  median ${pct(med - COST_PCT)}   trimmed ${pct((tm ?? 0) - COST_PCT)}`);
    console.log(`  win rate (beats cost): ${(100 * win).toFixed(1)}%   median hold ${median(holds).toFixed(1)}m`);
    console.log('  NOTE: positions the leader never closed in-window are EXCLUDED, which flatters this.');
  }
}

// ── ARE THERE SLOW LEADERS? ──────────────────────────────────────────
// The mirror test says the median leader holds 6 SECONDS. That edge is
// latency, and latency is the one thing a follower cannot copy — especially
// in a manual-execution product. So: rank leaders by how long they HOLD on the
// training day, and ask whether the slow ones are profitable to follow.
{
  console.log('');
  console.log('=== LEADERS BUCKETED BY THEIR OWN HOLD TIME (training day) ===');
  // per (user,mint) on the TRAINING day: first buy -> first sell after it
  const fb = new Map(), fs2 = new Map();
  for (const r of train) {
    const k = r.user + '|' + r.mint;
    if (r.buy) { if (!fb.has(k)) fb.set(k, r.at); }
    else { const a = fs2.get(k) || []; a.push(r.at); fs2.set(k, a); }
  }
  const byUser = new Map();
  for (const [k, bAt] of fb) {
    const ss = (fs2.get(k) || []).filter((t) => t > bAt);
    if (!ss.length) continue;
    const hold = (Math.min(...ss) - bAt) / 60000;
    const user = k.slice(0, k.indexOf('|'));
    const a = byUser.get(user) || []; a.push(hold); byUser.set(user, a);
  }
  const BUCKETS = [[0, 1], [1, 10], [10, 60], [60, 1e9]];
  const names = ['<1m', '1-10m', '10-60m', '>60m'];
  const sellsT = new Map();
  for (const r of test) {
    if (r.buy) continue;
    const k = r.user + '|' + r.mint;
    const a = sellsT.get(k) || []; a.push(r.at); sellsT.set(k, a);
  }
  for (const a of sellsT.values()) a.sort((x, y) => x - y);

  console.log('  bucket   leaders   positions   median net   trimmed net   win%');
  for (let bi = 0; bi < BUCKETS.length; bi++) {
    const [lo, hi] = BUCKETS[bi];
    const set = new Set();
    for (const [u, hs] of byUser) {
      if (!leaders.has(u)) continue;
      const m = median(hs);
      if (m >= lo && m < hi) set.add(u);
    }
    if (!set.size) { console.log(`  ${names[bi].padEnd(8)} (none)`); continue; }
    const rets = []; const seenPos = new Set();
    for (const r of test) {
      if (!r.buy || !set.has(r.user)) continue;
      const k = r.user + '|' + r.mint;
      if (seenPos.has(k)) continue; seenPos.add(k);
      const entry = fillAfter(r.mint, r.at); if (!entry) continue;
      const ss = sellsT.get(k); const sAt = ss && ss.find((t) => t > r.at);
      if (!sAt) continue;
      const ex = fillAfter(r.mint, sAt); if (!ex) continue;
      rets.push((ex.price / entry.price - 1) * 100);
    }
    if (!rets.length) { console.log(`  ${names[bi].padEnd(8)} ${String(set.size).padStart(7)}   (no closed positions)`); continue; }
    const med = median(rets) - COST_PCT;
    const tm = trimmed(rets); const tn = tm == null ? null : tm - COST_PCT;
    const win = rets.filter((x) => x > COST_PCT).length / rets.length;
    console.log(`  ${names[bi].padEnd(8)} ${String(set.size).padStart(7)}   ${String(rets.length).padStart(9)}   ${pct(med).padStart(10)}   ${(tn == null ? '—' : pct(tn)).padStart(11)}   ${(100 * win).toFixed(1)}%`);
  }
  console.log('  If no bucket is positive, the leaders edge is not copyable at any speed.');
}
