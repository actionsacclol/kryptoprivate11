// Trade-level order-flow collector for liquid Solana pairs.
//
// WHY THIS EXISTS
//
// The pump swarm (docs/volume-edge-swarm-2026-09-14.md) measured ONE large,
// replicating, correctly-signed signal: order-flow imbalance lifts the 60 s
// win rate monotonically 50.9% -> 87.4% across deciles (n = 159,958). It died
// on pump only because the cost floor there is 1.6% + impact.
//
// On established pairs, at the farm fee (FARM_FEE_BPS = 5), the measured floor
// is 0.19-0.69% round trip (docs/bluechip-hurdle-2026-09-14.md). A +0.583%
// gross edge — what the pump swarm actually measured — would clear that. So
// the question is worth one real measurement.
//
// A proxy built from 1-minute bar direction says the blue-chip signal is
// CONTRARIAN and small (0.03-0.14 pp, vs a 0.19% floor). But a 1-minute bar is
// a lossy compression of flow, so that is evidence, not an answer. This
// collects the real thing.
//
// WHAT IT COSTS
//
// GeckoTerminal's /trades route is keyless and returns the last ~300 trades,
// which spans roughly 90-100 minutes on a pair like JUP. Polling every 80
// minutes therefore captures the COMPLETE trade stream with overlap and no
// gaps: ~18 calls per coin per day. Three coins is ~54 calls/day against a
// budget that tolerated ~5.7/min when measured. It signs nothing, spends
// nothing and needs no wallet or key.
//
// The route does NOT page backwards — `block_number_less_than` is accepted and
// ignored (verified 2026-09-14), returning the same window. There is no
// backfill. That is the whole reason this records forward.
//
// WHAT IT WRITES
//
// One JSONL per coin under the output dir, appended, deduped by tx hash. Rows
// are the raw fields that matter for signing flow: timestamp, kind (buy/sell),
// USD volume, price, and the trader address. ~14k rows/day across three coins,
// about 3 MB/day. It writes to its OWN directory and never touches the app's
// recorder, whose prune deletes whole day files oldest-first and would evict
// this to reclaim pump rows (docs/bluechip-data-plan-2026-09-14.md §4).
//
// USAGE
//   node scripts/ofi-collect.mjs [--out DIR] [--once]
//
// Resumable: re-running picks up where it left off and re-dedupes.

import fs from 'fs';
import path from 'path';

const HOST = 'https://api.geckoterminal.com';
// Each coin is polled at a fraction of ITS OWN observed window, because the
// 300-trade window spans ~97 min on JUP but only ~21 min on BONK — measured
// 2026-09-14. A single interval either misses most of the fast pairs' flow or
// wastes calls on the slow one. Starts pessimistic and adapts on the first
// reply, so the first pass cannot open a gap either.
const TICK_MS = 5 * 60 * 1000;       // scheduler granularity
const MIN_POLL_MS = 5 * 60 * 1000;
const MAX_POLL_MS = 45 * 60 * 1000;
const SAFETY = 0.40;                 // poll at 40% of the window: two-and-a-half-fold overlap
const GAP_MS = 12_000;               // measured-safe spacing; the tier 429s well under its documented 28/min
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ONCE = args.includes('--once');
const OUT = path.resolve(argOf('--out', path.join('tape', 'ofi')));

// The three cheapest floors measured at the farm rate, 10 SOL: JUP 0.19%,
// FARTCOIN 0.24%, BONK 0.25%. If an edge cannot clear these it clears nothing.
const POOLS = {
  JUP:      'C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg',
  FARTCOIN: null,  // resolved on first run
  BONK:     null,
};
const MINTS = {
  FARTCOIN: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
  BONK:     'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gap = GAP_MS, lastCall = 0;

function log(s) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(path.join(OUT, 'collect.log'), line + '\n'); } catch {}
}

/** One keyless GET, spaced and 429-aware. Never throws. */
async function gt(pathname) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, lastCall + gap - Date.now());
    if (wait) await sleep(wait);
    lastCall = Date.now();
    let r, body;
    try {
      r = await fetch(HOST + pathname, { headers: { accept: 'application/json;version=20230302' } });
      body = await r.text();
    } catch (e) {
      await sleep(5000);
      continue;
    }
    if (r.status === 429) {
      gap = Math.min(60_000, Math.round(gap * 1.6));
      log(`  429 — backing off, gap now ${gap}ms`);
      await sleep(45_000);
      continue;
    }
    if (!r.ok) return null;
    gap = Math.max(GAP_MS, Math.round(gap * 0.98));
    try { return JSON.parse(body); } catch { return null; }
  }
  return null;
}

async function resolvePool(sym) {
  if (POOLS[sym]) return POOLS[sym];
  const d = await gt(`/api/v2/networks/solana/tokens/${MINTS[sym]}/pools?page=1`);
  const rows = (d?.data ?? [])
    .map((p) => ({ addr: p.attributes?.address, res: Number(p.attributes?.reserve_in_usd) || 0 }))
    .sort((a, b) => b.res - a.res);
  POOLS[sym] = rows[0]?.addr ?? null;
  if (POOLS[sym]) log(`resolved ${sym} pool ${POOLS[sym]}`);
  return POOLS[sym];
}

/** Tx hashes already on disk, so a restart cannot double-count a trade. */
function seenHashes(file) {
  const seen = new Set();
  if (!fs.existsSync(file)) return seen;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o.h) seen.add(o.h); } catch {}
  }
  return seen;
}

async function pollCoin(sym, seen) {
  const pool = await resolvePool(sym);
  if (!pool) { log(`${sym}: no pool`); return 0; }
  const d = await gt(`/api/v2/networks/solana/pools/${pool}/trades`);
  const rows = d?.data ?? [];
  if (!rows.length) { log(`${sym}: no trades returned`); return 0; }
  const file = path.join(OUT, `${sym}.jsonl`);
  const out = [];
  for (const t of rows) {
    const a = t.attributes ?? {};
    const h = a.tx_hash;
    if (!h || seen.has(h)) continue;
    seen.add(h);
    const ts = Date.parse(a.block_timestamp);
    if (!Number.isFinite(ts)) continue;
    out.push(JSON.stringify({
      h,
      t: Math.floor(ts / 1000),
      k: a.kind === 'buy' ? 1 : a.kind === 'sell' ? -1 : 0,
      v: Number(a.volume_in_usd) || 0,
      p: Number(a.price_to_in_currency_token) || Number(a.price_from_in_currency_token) || 0,
      w: a.tx_from_address ?? null,
      b: a.block_number ?? null,
    }));
  }
  if (out.length) fs.appendFileSync(file, out.join('\n') + '\n');
  const span = (Date.parse(rows[0].attributes.block_timestamp) - Date.parse(rows[rows.length - 1].attributes.block_timestamp)) / 60000;
  // Re-aim this coin's interval at a fraction of its own window. A window that
  // has shrunk (a busy hour) shortens the interval on the very next pass.
  const next = Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.round(span * 60000 * SAFETY)));
  interval[sym] = next;
  dueAt[sym] = Date.now() + next;
  // Every row new means the previous window was fully consumed — i.e. we may
  // already have missed trades between passes. Worth saying out loud.
  const gapRisk = out.length === rows.length && seen.size > rows.length;
  log(`${sym}: +${out.length} of ${rows.length} (window ${span.toFixed(0)}m, next in ${(next / 60000).toFixed(0)}m, total ${seen.size})${gapRisk ? '  ** no overlap — a gap is possible **' : ''}`);
  return out.length;
}

fs.mkdirSync(OUT, { recursive: true });
log(`collecting to ${OUT} — adaptive interval per coin, ${ONCE ? 'single pass' : 'continuous'}`);
const seen = {};
const interval = {};
const dueAt = {};
for (const sym of Object.keys(POOLS)) {
  seen[sym] = seenHashes(path.join(OUT, `${sym}.jsonl`));
  interval[sym] = MIN_POLL_MS;   // pessimistic until the first window is seen
  dueAt[sym] = 0;
}

for (;;) {
  let added = 0;
  for (const sym of Object.keys(POOLS)) {
    if (Date.now() < dueAt[sym]) continue;
    try { added += await pollCoin(sym, seen[sym]); }
    catch (e) { log(`${sym}: ${(e && e.message) || e}`); dueAt[sym] = Date.now() + MIN_POLL_MS; }
  }
  const totals = Object.entries(seen).map(([s, v]) => `${s} ${v.size}`).join(', ');
  const perDay = Object.values(interval).reduce((a, ms) => a + 86400000 / ms, 0);
  log(`pass done, +${added}. Totals: ${totals} | ~${Math.round(perDay)} calls/day`);
  if (ONCE) break;
  await sleep(TICK_MS);
}
