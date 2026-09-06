// Live tape store — the terminal's own, authoritative, sub-second data.
//
// WHY. No free API serves 1-second candles, and term.txt asks for 1s/5s/15s
// because that is the resolution a memecoin actually moves at in its first
// minutes. We already have the raw material: the engine decodes every
// pump.fun curve trade and every PumpSwap swap off the WSS feed, with a
// LOCAL arrival timestamp. This module keeps those ticks for the handful of
// mints the user is actually looking at and aggregates them into candles on
// demand.
//
// The result is the one dataset in the app that is strictly better than what
// a hosted terminal shows: it is our own observation, timestamped when WE
// received it, with no indexer lag in between.
//
// SUBSCRIPTION-GATED ON PURPOSE. The pump firehose is thousands of trades a
// minute; recording all of it here would be a memory leak with a UI attached.
// The renderer names the mints it has open (token page, pinned charts) and
// only those are taped.

import type { Candle, CandleInterval, TradeRow } from '@shared/market';

export interface Tick {
  /** Local arrival time, ms. */
  at: number;
  wallet: string;
  isBuy: boolean;
  /** SOL that changed hands. */
  sol: number;
  tokens: number;
  /** Spot price in SOL per token AFTER this trade. */
  priceSol: number;
}

/** How many mints may be taped at once. A token page opens one; pinned
 *  charts and the trade panel reuse the same subscription. */
const MAX_SUBSCRIPTIONS = 8;
/** Ticks kept per mint. At 20 trades/sec this is ~15 minutes of a hot launch,
 *  which is more than the 1s chart can usefully show anyway. */
const MAX_TICKS = 20_000;

interface Entry {
  ticks: Tick[];
  subscribedAt: number;
  lastTouchedAt: number;
}

const entries = new Map<string, Entry>();

export function subscribe(mint: string): void {
  const existing = entries.get(mint);
  if (existing) {
    existing.lastTouchedAt = Date.now();
    return;
  }
  if (entries.size >= MAX_SUBSCRIPTIONS) {
    // Evict the least recently touched subscription rather than refusing —
    // the user moving between tokens must never need a manual unsubscribe.
    let oldestMint: string | null = null;
    let oldestAt = Infinity;
    for (const [m, e] of entries) {
      if (e.lastTouchedAt < oldestAt) {
        oldestAt = e.lastTouchedAt;
        oldestMint = m;
      }
    }
    if (oldestMint) entries.delete(oldestMint);
  }
  entries.set(mint, { ticks: [], subscribedAt: Date.now(), lastTouchedAt: Date.now() });
}

export function unsubscribe(mint: string): void {
  entries.delete(mint);
}

export function subscriptions(): string[] {
  return [...entries.keys()];
}

/** Hot-path guard the engine calls before doing any work per trade. */
export function isSubscribed(mint: string): boolean {
  return entries.has(mint);
}

/** Whether the tape has actually OBSERVED trades for this mint.
 *  Distinct from isSubscribed: opening a token page subscribes it, but with
 *  the engine stopped no trades ever arrive. Only this one may drive a
 *  "live" indicator in the UI — a subscription alone promises nothing. */
export function hasTicks(mint: string): boolean {
  return (entries.get(mint)?.ticks.length ?? 0) > 0;
}

/** Last traded price (SOL per token) for a subscribed mint, or null. */
export function lastPriceSol(mint: string): number | null {
  const ticks = entries.get(mint)?.ticks;
  if (!ticks || ticks.length === 0) return null;
  const p = ticks[ticks.length - 1].priceSol;
  return Number.isFinite(p) && p > 0 ? p : null;
}

export function record(mint: string, tick: Tick): void {
  const e = entries.get(mint);
  if (!e) return;
  e.ticks.push(tick);
  if (e.ticks.length > MAX_TICKS) e.ticks.splice(0, e.ticks.length - MAX_TICKS);
}

const BUCKET_SEC: Partial<Record<CandleInterval, number>> = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
};

export function supports(interval: CandleInterval): boolean {
  return BUCKET_SEC[interval] !== undefined;
}

/**
 * Aggregate the tape into candles, priced in SOL.
 *
 * Gaps are NOT filled. A minute with no trades produces no candle rather
 * than a flat synthetic one — an invented candle in an illiquid token is
 * exactly the kind of chart artefact that gets someone to buy a corpse.
 */
export function candles(mint: string, interval: CandleInterval, limit = 600): Candle[] {
  const e = entries.get(mint);
  const bucket = BUCKET_SEC[interval];
  if (!e || !bucket || !e.ticks.length) return [];

  const out: Candle[] = [];
  let current: Candle | null = null;
  let currentBucket = -1;

  for (const t of e.ticks) {
    if (!Number.isFinite(t.priceSol) || t.priceSol <= 0) continue;
    const b = Math.floor(t.at / 1000 / bucket) * bucket;
    if (b !== currentBucket) {
      if (current) out.push(current);
      currentBucket = b;
      current = {
        time: b,
        open: t.priceSol,
        high: t.priceSol,
        low: t.priceSol,
        close: t.priceSol,
        volume: t.sol,
      };
      continue;
    }
    if (!current) continue;
    current.high = Math.max(current.high, t.priceSol);
    current.low = Math.min(current.low, t.priceSol);
    current.close = t.priceSol;
    current.volume += t.sol;
  }
  if (current) out.push(current);
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** Most recent trades, newest first. Feeds the Live Trades panel. */
export function trades(
  mint: string,
  limit: number,
  label: (wallet: string) => string | null,
  solUsd: number | null,
  supply: number | null,
): TradeRow[] {
  const e = entries.get(mint);
  if (!e) return [];
  const slice = e.ticks.slice(Math.max(0, e.ticks.length - limit));
  const rows: TradeRow[] = slice.map((t) => {
    const priceUsd = solUsd !== null ? t.priceSol * solUsd : null;
    return {
      at: t.at,
      signature: null, // the decoder works off logs; the sig is per-notification
      side: t.isBuy ? 'buy' : 'sell',
      wallet: t.wallet,
      label: label(t.wallet),
      solAmount: t.sol,
      tokenAmount: t.tokens,
      priceUsd,
      marketCapUsd: priceUsd !== null && supply !== null ? priceUsd * supply : null,
      tags: [],
    };
  });
  rows.reverse();
  return rows;
}

/** Per-wallet aggregation over the taped window — Trader Scan, our own data. */
export function traderScan(mint: string, label: (wallet: string) => string | null): Array<{
  wallet: string;
  label: string | null;
  boughtSol: number;
  soldSol: number;
  tokensNet: number;
  firstAt: number;
  lastAt: number;
  entryPriceSol: number | null;
}> {
  const e = entries.get(mint);
  if (!e) return [];
  interface Agg {
    boughtSol: number;
    soldSol: number;
    tokensNet: number;
    firstAt: number;
    lastAt: number;
    entryPriceSol: number | null;
  }
  const map = new Map<string, Agg>();
  for (const t of e.ticks) {
    let a = map.get(t.wallet);
    if (!a) {
      a = { boughtSol: 0, soldSol: 0, tokensNet: 0, firstAt: t.at, lastAt: t.at, entryPriceSol: null };
      map.set(t.wallet, a);
    }
    a.lastAt = t.at;
    if (t.isBuy) {
      a.boughtSol += t.sol;
      a.tokensNet += t.tokens;
      if (a.entryPriceSol === null) a.entryPriceSol = t.priceSol;
    } else {
      a.soldSol += t.sol;
      a.tokensNet -= t.tokens;
    }
  }
  return [...map.entries()]
    .map(([wallet, a]) => ({ wallet, label: label(wallet), ...a }))
    .sort((x, y) => y.boughtSol + y.soldSol - (x.boughtSol + x.soldSol));
}

export function clear(): void {
  entries.clear();
}

// ── Chart assembly helpers (pure) ─────────────────────────────────────
//
// Used by market.ts to build ONE chart out of provider history and the live
// tape instead of choosing either/or — the either/or is what threw away a
// token's history the moment the tape started winning, and threw away the
// live edge whenever a provider answered (the "chart doesn't show the full
// chart" complaint). They live here rather than in market.ts so the unit
// tests reach them through the same esbuild bundle as the tape itself.

/**
 * Merge provider history with tape candles into one series.
 *
 *   • provider candles fill every bucket the tape has not observed —
 *     including history from before this install ever saw the token;
 *   • where BOTH hold the same bucket, the tape wins: it is our own
 *     observation of the live edge, timestamped on arrival, with no
 *     indexer lag (and the provider's last bucket is usually partial);
 *   • sorted ascending, deduped by bucket time, capped to the most
 *     recent `limit` buckets.
 *
 * Both inputs MUST already be priced in the same unit — the caller converts
 * the SOL-priced tape (or drops it) before merging. Mixing units here would
 * draw a false cliff at the seam.
 */
export function mergeCandles(provider: Candle[], tape: Candle[], limit = 600): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const k of provider) if (Number.isFinite(k.time)) byTime.set(k.time, k);
  for (const k of tape) if (Number.isFinite(k.time)) byTime.set(k.time, k);
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/**
 * Convert SOL-priced tape candles to USD (prices AND volume). Returns null
 * when the SOL/USD rate is unknown — the caller must then DROP the tape from
 * a USD merge rather than mix units (honest-null rule: never guess a rate).
 */
export function convertSolCandles(candles: Candle[], solUsd: number | null): Candle[] | null {
  if (solUsd === null || !Number.isFinite(solUsd) || solUsd <= 0) return null;
  return candles.map((k) => ({
    time: k.time,
    open: k.open * solUsd,
    high: k.high * solUsd,
    low: k.low * solUsd,
    close: k.close * solUsd,
    volume: k.volume * solUsd,
  }));
}

/** Buckets at or after `sinceTime` (seconds) — the incremental-poll cutoff. */
export function candlesSince(candles: Candle[], sinceTime: number): Candle[] {
  if (!Number.isFinite(sinceTime) || sinceTime <= 0) return candles;
  return candles.filter((k) => k.time >= sinceTime);
}

/** The serve-stale-over-blank note. Age is stated so nobody trades a chart
 *  believing it is live. */
export function staleChartNote(ageMs: number, rateLimited: boolean): string {
  const age = Math.max(1, Math.round(ageMs / 1000));
  return rateLimited
    ? `Chart provider rate-limited — showing the last loaded chart (${age}s old).`
    : `No chart source is answering — showing the last loaded chart (${age}s old).`;
}
