// GeckoTerminal (api.geckoterminal.com) — keyless OHLCV.
//
// This is the free candle source, and it is the reason the chart works for a
// stranger with no API keys on first launch. Free tier is ~30 requests per
// minute, which `http.ts` enforces with a 2.1s per-host gap — a chart that
// repaints on every interval switch would otherwise 429 within seconds.
//
// LIMIT, STATED HONESTLY: the smallest bucket GeckoTerminal serves is ONE
// MINUTE. term.txt asks for 1s/5s/15s candles. Those cannot come from here
// and are not faked — `market.ts` builds sub-minute candles from our own
// live tape when the engine is tracking the mint, and otherwise returns 1m
// with `note` set so the UI can say so instead of pretending.

import { getJson, memo } from '../http';
import { normaliseCandles, type Candle, type CandleInterval, type TokenPool } from '@shared/market';

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } };
  meta?: { base?: { address?: string; symbol?: string } };
}

/** GeckoTerminal's (timeframe, aggregate) pair for each interval we serve. */
const TIMEFRAME: Partial<Record<CandleInterval, { tf: 'minute' | 'hour' | 'day'; agg: number }>> = {
  '1m': { tf: 'minute', agg: 1 },
  '5m': { tf: 'minute', agg: 5 },
  '15m': { tf: 'minute', agg: 15 },
  '1h': { tf: 'hour', agg: 1 },
  '4h': { tf: 'hour', agg: 4 },
};

export function supports(interval: CandleInterval): boolean {
  return TIMEFRAME[interval] !== undefined;
}

/** Candles for a POOL, oldest-first, priced in USD against the base token. */
export async function ohlcv(
  pool: string,
  interval: CandleInterval,
  limit = 500,
  opts: { priority?: boolean } = {},
): Promise<Candle[] | null> {
  const spec = TIMEFRAME[interval];
  if (!spec) return null;
  const key = `gt:ohlcv:${pool}:${interval}:${limit}`;
  // A 1m candle is only interesting once it closes; caching for a third of
  // the bucket keeps the chart live without spending the rate budget.
  const ttl = spec.tf === 'minute' ? spec.agg * 20_000 : 60_000;
  return memo<Candle[]>(key, ttl, async () => {
    const q = new URLSearchParams({
      aggregate: String(spec.agg),
      limit: String(Math.min(1000, Math.max(1, limit))),
      currency: 'usd',
      token: 'base',
    });
    const r = await getJson<OhlcvResponse>(
      'geckoterminal',
      `/api/v2/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${spec.tf}?${q.toString()}`,
      // The chart the user is LOOKING AT must not queue behind Discover's
      // background polls on the same 2.1 s-gap host.
      { priority: opts.priority },
    );
    const list = r.ok ? r.data?.data?.attributes?.ohlcv_list : null;
    if (!Array.isArray(list) || !list.length) return null;
    const candles: Candle[] = [];
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [time, open, high, low, close, volume] = row;
      if (![time, open, high, low, close].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      candles.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
    // The API returns newest-first, and has been seen repeating a bucket
    // within one response — normalise handles both.
    const clean = normaliseCandles(candles);
    return clean.length ? clean : null;
  });
}

interface PoolsResponse {
  data?: Array<{
    id?: string;
    attributes?: {
      address?: string;
      name?: string;
      pool_created_at?: string;
      reserve_in_usd?: string;
    };
    relationships?: { dex?: { data?: { id?: string } } };
  }>;
}

/** Pools for a mint — the fallback when DexScreener has not indexed it. */
export async function poolsForToken(mint: string): Promise<TokenPool[]> {
  const hit = await memo<TokenPool[]>(`gt:pools:${mint}`, 60_000, async () => {
    const r = await getJson<PoolsResponse>(
      'geckoterminal',
      `/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`,
    );
    if (!r.ok || !Array.isArray(r.data?.data)) return null;
    const pools: TokenPool[] = [];
    for (const p of r.data.data) {
      const address = p.attributes?.address;
      if (!address) continue;
      const reserve = Number(p.attributes?.reserve_in_usd);
      pools.push({
        address,
        dexId: p.relationships?.dex?.data?.id ?? 'unknown',
        label: p.attributes?.name ?? address.slice(0, 8),
        liquidityUsd: Number.isFinite(reserve) ? reserve : null,
      });
    }
    pools.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    return pools.length ? pools : null;
  });
  return hit ?? [];
}

// ── New pools ─────────────────────────────────────────────────────────
//
// `new_pools` is the one keyless feed that sees EVERY Solana DEX, which
// makes it the backbone of multi-platform discovery:
//
//   • a brand-new pool on an AMM (pumpswap, raydium, meteora-damm, orca …)
//     is a token that just MIGRATED off its launch curve;
//   • a brand-new pool on a curve dex (`meteora-dbc`, `pump-fun`) is a token
//     that just launched, and is the candidate list for GRADUATING.
//
// Verified 2026-08-24: one page returns 20 pools roughly six minutes old,
// spanning pump-fun, pumpswap, meteora-dbc, meteora-damm-v2 and orca.

export interface NewPool {
  address: string;
  dexId: string;
  name: string;
  /** Mint of the base token, extracted from the relationship id. */
  baseMint: string | null;
  createdAt: number | null;
  reserveUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  volume24hUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
}

interface NewPoolsResponse {
  data?: Array<{
    attributes?: {
      address?: string;
      name?: string;
      pool_created_at?: string;
      reserve_in_usd?: string;
      fdv_usd?: string;
      market_cap_usd?: string | null;
      base_token_price_usd?: string;
      volume_usd?: Record<string, string>;
      transactions?: Record<string, { buys?: number; sells?: number }>;
    };
    relationships?: {
      dex?: { data?: { id?: string } };
      base_token?: { data?: { id?: string } };
    };
  }>;
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** `solana_<mint>` → `<mint>`. */
function mintFromId(id: string | undefined): string | null {
  if (!id) return null;
  const i = id.indexOf('_');
  return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * Recently created pools across every Solana DEX, newest first.
 *
 * `pages` is capped hard: GeckoTerminal's free tier allows ~30 requests a
 * minute and `http.ts` already spaces calls 2.1s apart, so asking for more
 * than a couple of pages would starve the chart of its rate budget.
 */
export async function newPools(pages = 2): Promise<NewPool[]> {
  const wanted = Math.max(1, Math.min(3, pages));
  const out: NewPool[] = [];
  for (let page = 1; page <= wanted; page++) {
    const rows = await memo<NewPool[]>(`gt:newpools:${page}`, 45_000, async () => {
      const r = await getJson<NewPoolsResponse>('geckoterminal', `/api/v2/networks/solana/new_pools?page=${page}`);
      if (!r.ok || !Array.isArray(r.data?.data)) return null;
      const mapped: NewPool[] = [];
      for (const p of r.data.data) {
        const a = p.attributes;
        if (!a?.address) continue;
        const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
        const t5 = p.attributes?.transactions?.m5;
        mapped.push({
          address: a.address,
          dexId: p.relationships?.dex?.data?.id ?? 'unknown',
          name: a.name ?? '',
          baseMint: mintFromId(p.relationships?.base_token?.data?.id),
          createdAt: Number.isFinite(created) ? created : null,
          reserveUsd: numOrNull(a.reserve_in_usd),
          fdvUsd: numOrNull(a.fdv_usd),
          marketCapUsd: numOrNull(a.market_cap_usd),
          priceUsd: numOrNull(a.base_token_price_usd),
          volume24hUsd: numOrNull(a.volume_usd?.h24),
          buys5m: t5?.buys ?? null,
          sells5m: t5?.sells ?? null,
        });
      }
      return mapped.length ? mapped : null;
    });
    if (!rows?.length) break;
    out.push(...rows);
  }
  return out;
}

/** DEX ids that are LAUNCH CURVES rather than AMMs. A new pool on one of
 *  these is a launch; a new pool anywhere else is a migration. */
export const CURVE_DEX_IDS = new Set(['pump-fun', 'meteora-dbc', 'launchlab', 'raydium-launchlab', 'moonshot', 'boop-fun']);

export function isCurveDex(dexId: string): boolean {
  return CURVE_DEX_IDS.has(dexId.toLowerCase());
}

/**
 * Top pools for one DEX, by 24h volume.
 *
 * This — not `new_pools` — is the right candidate source for the Graduating
 * column. Verified 2026-08-24: every `meteora-dbc` pool appearing in
 * `new_pools` was ALREADY migrated (`isMigrated`, quote reserve exactly equal
 * to the threshold), because GeckoTerminal indexes a DBC pool around its
 * migration rather than its launch. The per-dex listing instead returns
 * pools with live reserves mid-curve, which is what "about to graduate"
 * means.
 *
 * One request, cached — the free tier's ~30/min budget is shared with the
 * chart, so this must not be called per row.
 */
export async function poolsForDex(dexId: string, page = 1): Promise<NewPool[]> {
  const hit = await memo<NewPool[]>(`gt:dexpools:${dexId}:${page}`, 60_000, async () => {
    const r = await getJson<NewPoolsResponse>(
      'geckoterminal',
      `/api/v2/networks/solana/dexes/${encodeURIComponent(dexId)}/pools?page=${page}`,
    );
    if (!r.ok || !Array.isArray(r.data?.data)) return null;
    const mapped: NewPool[] = [];
    for (const p of r.data.data) {
      const a = p.attributes;
      if (!a?.address) continue;
      const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
      const t5 = a.transactions?.m5;
      mapped.push({
        address: a.address,
        dexId: p.relationships?.dex?.data?.id ?? dexId,
        name: a.name ?? '',
        baseMint: mintFromId(p.relationships?.base_token?.data?.id),
        createdAt: Number.isFinite(created) ? created : null,
        reserveUsd: numOrNull(a.reserve_in_usd),
        fdvUsd: numOrNull(a.fdv_usd),
        marketCapUsd: numOrNull(a.market_cap_usd),
        priceUsd: numOrNull(a.base_token_price_usd),
        volume24hUsd: numOrNull(a.volume_usd?.h24),
        buys5m: t5?.buys ?? null,
        sells5m: t5?.sells ?? null,
      });
    }
    return mapped.length ? mapped : null;
  });
  return hit ?? [];
}
