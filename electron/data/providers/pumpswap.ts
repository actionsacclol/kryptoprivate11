// pump.fun swap API (swap-api.pump.fun) — keyless historical trades.
//
// This is the only free source that will hand you the trades a token had
// MONTHS ago, and it is what makes retroactive launch analysis possible for a
// contract address the user pastes in cold. `frontend-api-v3` used to serve
// `/trades/all/{mint}`; that route is gone (404 "Cannot GET", measured
// 2026-08-24) and this replaced it.
//
// Shape, verified live 2026-08-24:
//
//   GET /v2/coins/{mint}/trades?limit=100&cursor=<slotIndexId>-<timestampMs>
//   → { trades: [...], pagination: { nextCursor, hasMore, limit } }
//
//   • newest-first, ALWAYS — `sort`, `order` and `direction` are accepted and
//     silently ignored, so there is no way to ask for the launch directly;
//   • `limit` is capped at 100 (a 400 above that);
//   • the cursor is a plain seek key and the slot half may be all zeros, so
//     `0…0-<createdAt+5s>` seeks straight to the launch. That one line is why
//     this costs 1–2 calls instead of paging through a token's entire life.
//   • `slotIndexId.slice(0, 12)` is the Solana slot — checked against
//     `getSlot` on a fresh trade, delta 0.
//
// There is no holders route and no top-traders route here (both 404).

import { getJson, memo } from '../http';
import type { LaunchTrade } from '@shared/launchintel';
import type { Candle, CandleInterval } from '@shared/market';

interface SwapTrade {
  slotIndexId?: string;
  tx?: string;
  timestamp?: string;
  userAddress?: string;
  type?: string;
  program?: string;
  amountSol?: string;
  baseAmount?: string;
}

interface SwapTradesResponse {
  trades?: SwapTrade[];
  pagination?: { nextCursor?: string | null; hasMore?: boolean };
}

/** The slot half of a cursor, zeroed — the timestamp is what actually seeks. */
const ZERO_SLOT = '0'.repeat(22);

const PAGE = 100;

/** Hard ceiling on calls per launch scan, so one token page cannot chew the
 *  whole rate budget hunting for a launch it will never reach. The common
 *  case is ONE call; this only bounds the awkward ones. */
const MAX_CALLS = 5;

export function parseSlot(slotIndexId: string | undefined): number | null {
  if (typeof slotIndexId !== 'string' || slotIndexId.length < 12) return null;
  const n = Number(slotIndexId.slice(0, 12));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normaliseTrade(t: SwapTrade): LaunchTrade | null {
  const slot = parseSlot(t.slotIndexId);
  const ts = t.timestamp ? Date.parse(t.timestamp) : NaN;
  const base = Number(t.baseAmount);
  const sol = Number(t.amountSol);
  if (slot === null || !Number.isFinite(ts)) return null;
  if (typeof t.userAddress !== 'string' || !t.userAddress) return null;
  if (t.type !== 'buy' && t.type !== 'sell') return null;
  if (!Number.isFinite(base) || base < 0) return null;
  return {
    slot,
    ts,
    user: t.userAddress,
    isBuy: t.type === 'buy',
    base,
    sol: Number.isFinite(sol) ? Math.abs(sol) : 0,
    program: typeof t.program === 'string' ? t.program : 'unknown',
    tx: typeof t.tx === 'string' ? t.tx : '',
  };
}

async function page(mint: string, cursor: string | null): Promise<{
  trades: LaunchTrade[];
  hasMore: boolean;
  nextCursor: string | null;
  ok: boolean;
  message: string;
} | null> {
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (cursor) q.set('cursor', cursor);
  const r = await getJson<SwapTradesResponse>('pumpswap', `/v2/coins/${encodeURIComponent(mint)}/trades?${q}`);
  if (!r.ok || !r.data || !Array.isArray(r.data.trades)) {
    return { trades: [], hasMore: false, nextCursor: null, ok: false, message: r.message };
  }
  const trades = r.data.trades.map(normaliseTrade).filter((t): t is LaunchTrade => t !== null);
  return {
    trades,
    hasMore: r.data.pagination?.hasMore === true,
    nextCursor: r.data.pagination?.nextCursor ?? null,
    ok: true,
    message: 'ok',
  };
}

export interface RecentScan {
  /** OLDEST-FIRST, the order a position book has to be fed in. */
  trades: LaunchTrade[];
  /** True when the pages reached `sinceMs` or the token's first trade. */
  complete: boolean;
  calls: number;
  ok: boolean;
  message: string;
}

/**
 * A token's trades from now back to `sinceMs`, at most `maxPages` pages.
 *
 * This is the Wallet Scout's manual scan: the newest page first, then older
 * ones until a trade predates `sinceMs` or the token runs out of history. The
 * API is newest-first and so is each page, so the result is reversed once at
 * the end — a sell fed before its buy scores nothing.
 */
export async function recentTrades(mint: string, sinceMs: number, maxPages = 3): Promise<RecentScan> {
  const all: LaunchTrade[] = [];
  let cursor: string | null = null;
  let calls = 0;
  let complete = false;
  let ok = true;
  let message = 'ok';
  while (calls < maxPages) {
    calls += 1;
    const p = await page(mint, cursor);
    if (!p || !p.ok) {
      ok = false;
      message = p?.message ?? 'request failed';
      break;
    }
    let reached = false;
    for (const t of p.trades) {
      if (t.ts < sinceMs) {
        reached = true;
        break;
      }
      all.push(t);
    }
    if (reached || !p.hasMore || !p.nextCursor) {
      complete = true;
      break;
    }
    cursor = p.nextCursor;
  }
  all.reverse();
  return { trades: all, complete, calls, ok, message };
}

export interface LaunchScan {
  trades: LaunchTrade[];
  /** True when the scan is certain it reached the token's FIRST ever trade. */
  complete: boolean;
  calls: number;
  message: string;
}

/**
 * The first trades of a mint, ending at the genuine first trade where possible.
 *
 * `complete` is the load-bearing field. Bundle detection defines the bundle as
 * "everything in the same slot as the first trade" — so if the scan did NOT
 * reach the first trade, the slot it thinks is the launch is just some slot in
 * the middle of the launch, and every cohort built on it would be wrong while
 * looking entirely plausible. The caller must refuse to report bundle numbers
 * when this is false. It is the difference between an em dash and a lie.
 *
 * Strategy, at most MAX_CALLS requests:
 *   1. seek to `createdAt + 5s`. Almost every launch fits in the 100 trades
 *      below that point, and `hasMore === false` proves we hit trade #1.
 *   2. nothing there ⇒ the coin sat untraded after creation; widen the seek.
 *   3. still more below ⇒ over 100 trades in the first 5 seconds; narrow the
 *      seek, then fall back to paging backwards.
 */
export async function launchTrades(mint: string, createdAtMs: number): Promise<LaunchScan> {
  let calls = 0;
  const seek = (deltaMs: number) => `${ZERO_SLOT}-${createdAtMs + deltaMs}`;

  // 1 + 2: widen until we actually find the launch trades.
  //
  // The widening must NOT stop when a seek comes back empty with
  // `hasMore: false`. That combination says "nothing at or before this
  // point", which is exactly what a token whose first trade came minutes
  // after creation looks like — and reading it as "this token has never
  // traded" reported precisely that about a live, migrated token with months
  // of history (caught by the live check, 2026-08-24). An empty seek is an
  // instruction to look further out, never a verdict.
  let found: { trades: LaunchTrade[]; hasMore: boolean; nextCursor: string | null } | null = null;
  for (const delta of [5_000, 120_000, 3_600_000]) {
    if (calls >= MAX_CALLS - 1) break;
    calls++;
    const p = await page(mint, seek(delta));
    if (!p || !p.ok) return { trades: [], complete: false, calls, message: p?.message ?? 'request failed' };
    if (p.trades.length) {
      found = p;
      break;
    }
  }
  if (!found) {
    // One unseeked call decides between the two very different answers: a
    // token nobody ever bought, and a token whose launch we simply could not
    // locate from the creation timestamp the API gave us.
    calls++;
    const newest = await page(mint, null);
    if (!newest?.ok) return { trades: [], complete: false, calls, message: newest?.message ?? 'request failed' };
    if (!newest.trades.length) return { trades: [], complete: true, calls, message: 'no trades' };
    // The mint trades, but nothing exists at or before its creation time.
    // Measured 2026-08-24: a 919-day-old token returns an empty page for
    // every seek near its launch while still serving this month's trades —
    // the index does not go back that far. Do not dress this up as a bundle
    // verdict.
    return {
      trades: [],
      complete: false,
      calls,
      message: 'the trade index does not reach this launch',
    };
  }
  if (!found.hasMore) return { trades: found.trades, complete: true, calls, message: 'ok' };

  // 3: a busy launch. Narrow the seek first — cheaper and more likely to land
  // exactly on trade #1 than paging.
  if (calls < MAX_CALLS) {
    calls++;
    const narrow = await page(mint, seek(1_200));
    if (narrow?.ok && narrow.trades.length && !narrow.hasMore) {
      return { trades: narrow.trades, complete: true, calls, message: 'ok' };
    }
    if (narrow?.ok && narrow.trades.length) found = narrow;
  }

  // Fall back to walking older until the budget runs out.
  const all = [...found.trades];
  let cursor = found.nextCursor;
  let hasMore = found.hasMore;
  while (hasMore && cursor && calls < MAX_CALLS) {
    calls++;
    const p = await page(mint, cursor);
    if (!p?.ok) break;
    all.push(...p.trades);
    hasMore = p.hasMore;
    cursor = p.nextCursor;
  }

  return {
    trades: all,
    complete: !hasMore,
    calls,
    message: hasMore ? `over ${all.length} trades in the launch window` : 'ok',
  };
}

// ── Candles ───────────────────────────────────────────────────────────
//
// MEASURED 2026-10-01: `GET /v1/coins/{mint}/candles?interval=&limit=&currency=`
// serves OHLC for a coin still on its bonding curve, from its first trade — a
// coin two minutes old already had its 1m bars. No chart provider indexes a
// curve, so before this a curve coin's chart was only ever our own tape, and
// the tape records a coin only while its page is open: a script's buy, or an
// AI asking for the chart, got no bars at all (user report 2026-10-01, three
// of five trades). A graduated coin's series runs across the migration.
//
// Shape: an array, oldest first; `timestamp` in ms; every number a string;
// `volume` in the quote currency; `limit` at most 1000 (a 400 above it).
// Intervals: 1s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 6h, 12h, 24h — no 5s,
// which is built here from 1s. `/v2/…` answers the same but demands
// `createdTs`.

const CANDLE_INTERVAL: Partial<Record<CandleInterval, string>> = {
  '1s': '1s',
  '5s': '1s',
  '15s': '15s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
};

const CANDLE_LIMIT_MAX = 1000;

export function candlesSupported(interval: CandleInterval): boolean {
  return CANDLE_INTERVAL[interval] !== undefined;
}

/** The route's rows as chart candles: seconds, numbers, oldest first, one
 *  per bucket. A row with any price missing or non-positive is dropped —
 *  never drawn as a zero. */
export function parseCandles(rows: unknown[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const x of rows) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const ts = Number(r.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const [open, high, low, close] = [r.open, r.high, r.low, r.close].map(Number);
    if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;
    const volume = Number(r.volume);
    const time = Math.floor(ts > 1e12 ? ts / 1000 : ts);
    byTime.set(time, { time, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Wider buckets from narrower ones (5s from the route's 1s). Input oldest
 *  first; open from the first row in a bucket, close from the last. */
export function rebucket(rows: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const time = Math.floor(r.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, r.high);
      last.low = Math.min(last.low, r.low);
      last.close = r.close;
      last.volume += r.volume;
    } else {
      out.push({ ...r, time });
    }
  }
  return out;
}

/**
 * pump.fun's candles for a mint, in USD (the unit every other chart provider
 * answers in, so the merge with the tape converts exactly as it does for
 * them). Null when the route refused; an EMPTY array when it answered with
 * nothing (a coin seconds old is not indexed yet) — kept for the same TTL,
 * so a chart polling every second does not re-ask for nothing every second.
 *
 * Never `priority`: this host's Cloudflare rule EXTENDS its block for every
 * request made during it (swap-api burst limit, 2026-09-21), and a chart is
 * not the trade path. The memo is what keeps a chart's 1-5 s poll from
 * re-asking: one request per few seconds at most, whatever polls.
 */
export async function candles(mint: string, interval: CandleInterval, limit = 500): Promise<Candle[] | null> {
  const iv = CANDLE_INTERVAL[interval];
  if (!iv) return null;
  const five = interval === '5s';
  const want = Math.max(1, Math.min(CANDLE_LIMIT_MAX, five ? limit * 5 : limit));
  const subMinute = interval === '1s' || interval === '5s' || interval === '15s';
  const ttl = subMinute ? 5_000 : interval === '1m' ? 15_000 : 60_000;
  return memo<Candle[]>(`ps:candles:${mint}:${interval}:${want}`, ttl, async () => {
    const q = new URLSearchParams({ interval: iv, limit: String(want), currency: 'USD' });
    const r = await getJson<unknown>('pumpswap', `/v1/coins/${encodeURIComponent(mint)}/candles?${q}`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    const rows = parseCandles(r.data);
    const out = five ? rebucket(rows, 5) : rows;
    return out.slice(-limit);
  });
}
