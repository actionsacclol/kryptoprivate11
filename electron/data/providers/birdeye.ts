// Birdeye (public-api.birdeye.so) — BYO key, entirely optional.
//
// Everything the terminal shows works without this provider. What a key buys
// you is the data the keyless set genuinely cannot produce:
//
//   • 1s / 15s / 30s candles for tokens the local engine is NOT tracking
//     (GeckoTerminal's floor is 1 minute);
//   • a real holder LIST with owners and percentages for any mint, rather
//     than the 20-row `getTokenLargestAccounts` window an RPC gives us;
//   • historical trades and top-trader PnL for Trader Scan on tokens that
//     launched before this install was running.
//
// VERIFIED 2026-08-24 against a live key — `npm run test:birdeye` re-checks
// it. What that run found and fixed: OHLCV had to move from `/defi/ohlcv` to
// `/defi/v3/ohlcv`, because the v1 route rejects 1s/15s with "type invalid
// format" and so served none of the sub-minute candles this provider is here
// for. Holders and trades were correct as written.
//
// Every function still fails soft and the caller falls back to the keyless
// path, so a future route change degrades a panel rather than breaking it.

import { getJson, memo } from '../http';
import { normaliseCandles, type Candle, type CandleInterval, type HolderRow, type TradeRow, type TraderScanRow } from '@shared/market';

function headers(apiKey: string): Record<string, string> {
  return { 'X-API-KEY': apiKey, 'x-chain': 'solana' };
}

/** Birdeye's `type` parameter per interval. Sub-minute is the whole point. */
const TYPE: Partial<Record<CandleInterval, string>> = {
  '1s': '1s',
  '15s': '15s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
};

export function supports(interval: CandleInterval): boolean {
  return TYPE[interval] !== undefined;
}

interface OhlcvItem {
  /** v3 spells it `unix_time`; v1 spelled it `unixTime`. Both are accepted so
   *  a route change cannot silently empty the chart — reading only the v1
   *  spelling against v3 skipped EVERY item and returned "no data" while the
   *  endpoint was answering 200 with a full page (measured 2026-08-24). */
  unix_time?: number;
  unixTime?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

/** Seconds each interval covers, for sizing the time window we request. */
const SECONDS: Record<string, number> = {
  '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400,
};

export async function ohlcv(
  apiKey: string,
  mint: string,
  interval: CandleInterval,
  limit = 500,
  opts: { priority?: boolean } = {},
): Promise<Candle[] | null> {
  const type = TYPE[interval];
  if (!type || !apiKey) return null;
  // A window of exactly `interval × limit` is too tight for sub-minute
  // candles: a second with no trade produces no candle, so 50 one-second
  // buckets rarely span 50 seconds of actual trading and the request comes
  // back empty (measured on a deeply liquid mint, 2026-08-24). Ask for a much
  // wider window and keep the most recent `limit`.
  const secs = SECONDS[interval] ?? 60;
  const span = Math.max(secs * limit, secs < 60 ? 1_800 : 0);
  const now = Math.floor(Date.now() / 1000);
  const key = `be:ohlcv:${mint}:${interval}:${limit}`;
  return memo<Candle[]>(key, Math.max(3_000, (SECONDS[interval] ?? 60) * 300), async () => {
    const q = new URLSearchParams({
      address: mint,
      type,
      time_from: String(now - span),
      time_to: String(now),
    });
    const r = await getJson<{ success?: boolean; data?: { items?: OhlcvItem[] } }>(
      'birdeye',
      // v3, NOT v1. `/defi/ohlcv` rejects sub-minute types outright with
      // "type invalid format" (measured 2026-08-24 with a live key), which
      // silently disabled the 1s/15s candles that are this provider's entire
      // reason to exist. `/defi/v3/ohlcv` serves every interval we ask for.
      `/defi/v3/ohlcv?${q.toString()}`,
      { headers: headers(apiKey), priority: opts.priority },
    );
    const items = r.ok ? r.data?.data?.items : null;
    if (!Array.isArray(items) || !items.length) return null;
    const candles: Candle[] = [];
    for (const it of items) {
      const time = typeof it?.unix_time === 'number' ? it.unix_time : it?.unixTime;
      if (typeof time !== 'number') continue;
      if (![it.o, it.h, it.l, it.c].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      candles.push({
        time,
        open: it.o as number,
        high: it.h as number,
        low: it.l as number,
        close: it.c as number,
        volume: Number.isFinite(it.v) ? (it.v as number) : 0,
      });
    }
    const clean = normaliseCandles(candles);
    // The widened window can overshoot; the chart wants the newest `limit`.
    const trimmed = clean.length > limit ? clean.slice(clean.length - limit) : clean;
    return trimmed.length ? trimmed : null;
  });
}

interface HolderItem {
  amount?: string;
  decimals?: number;
  owner?: string;
  token_account?: string;
  ui_amount?: number;
}

/** Full holder page — owners and amounts, which an RPC alone cannot give. */
export async function holders(apiKey: string, mint: string, limit = 100): Promise<HolderRow[] | null> {
  if (!apiKey) return null;
  return memo<HolderRow[]>(`be:holders:${mint}:${limit}`, 45_000, async () => {
    const q = new URLSearchParams({ address: mint, offset: '0', limit: String(Math.min(100, limit)) });
    const r = await getJson<{ data?: { items?: HolderItem[] } }>(
      'birdeye',
      `/defi/v3/token/holder?${q.toString()}`,
      { headers: headers(apiKey) },
    );
    const items = r.ok ? r.data?.data?.items : null;
    if (!Array.isArray(items) || !items.length) return null;
    const rows: HolderRow[] = items
      .map((h) => ({
        address: h.token_account ?? h.owner ?? '',
        owner: h.owner ?? null,
        amount: typeof h.ui_amount === 'number' ? h.ui_amount : Number(h.amount ?? 0) / 10 ** (h.decimals ?? 6),
        pct: 0, // filled by the caller, which knows total supply
        tags: [],
        label: null,
      }))
      .filter((r2) => r2.address);
    return rows.length ? rows : null;
  });
}

interface TxItem {
  blockUnixTime?: number;
  txHash?: string;
  side?: string;
  owner?: string;
  from?: { uiAmount?: number; symbol?: string };
  to?: { uiAmount?: number; symbol?: string };
  volumeUSD?: number;
}

/** Recent swaps against a mint — the Live Trades panel for non-tracked mints. */
export async function trades(apiKey: string, mint: string, limit = 50): Promise<TradeRow[] | null> {
  if (!apiKey) return null;
  return memo<TradeRow[]>(`be:trades:${mint}:${limit}`, 6_000, async () => {
    const q = new URLSearchParams({ address: mint, limit: String(Math.min(50, limit)), tx_type: 'swap' });
    const r = await getJson<{ data?: { items?: TxItem[] } }>(
      'birdeye',
      `/defi/txs/token?${q.toString()}`,
      { headers: headers(apiKey) },
    );
    const items = r.ok ? r.data?.data?.items : null;
    if (!Array.isArray(items) || !items.length) return null;
    const rows: TradeRow[] = [];
    for (const t of items) {
      if (typeof t?.blockUnixTime !== 'number') continue;
      const side = (t.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy';
      // For a buy the SOL leg is `from`; for a sell it is `to`.
      const solLeg = side === 'buy' ? t.from : t.to;
      const tokLeg = side === 'buy' ? t.to : t.from;
      rows.push({
        at: t.blockUnixTime * 1000,
        signature: t.txHash ?? null,
        side,
        wallet: t.owner ?? '',
        label: null,
        solAmount: typeof solLeg?.uiAmount === 'number' ? solLeg.uiAmount : 0,
        tokenAmount: typeof tokLeg?.uiAmount === 'number' ? tokLeg.uiAmount : 0,
        priceUsd: null,
        marketCapUsd: null,
        tags: [],
      });
    }
    rows.sort((a, b) => b.at - a.at);
    return rows.length ? rows : null;
  });
}

interface TopTraderItem {
  owner?: string;
  volume?: number;
  volumeBuy?: number;
  volumeSell?: number;
  trade?: number;
}

