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

import { cached, getJson, memo, putCache } from '../http';
import { normaliseCandles, type Candle, type CandleInterval, type TokenPool } from '@shared/market';

// "Nothing here" is an answer worth remembering. memo() never stores null,
// so a token GeckoTerminal has no pool or no candles for was re-asked on
// every chart poll — two calls on a 2.1 s-gap host, 3–4 s per candle load
// for every bonding-curve token (measured 2026-09-08). These markers are
// written ONLY for a real empty reply, never for a 429, a park or a failed
// request, so a rate limit can never poison them.
const NONE_POOLS_MS = 45_000;
const NONE_OHLCV_MS = 30_000;

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
  return ohlcvOn('solana', pool, interval, limit, opts);
}

/** GeckoTerminal network slug. 'solana' for the Solana terminal; 'robinhood'
 *  for Robinhood Chain (verified in its /networks list, 2026-09-08). */
export type GtNetwork = 'solana' | 'robinhood' | 'bsc';

/** Candles for a POOL on any network GeckoTerminal indexes. */
export async function ohlcvOn(
  network: GtNetwork,
  pool: string,
  interval: CandleInterval,
  limit = 500,
  opts: { priority?: boolean } = {},
): Promise<Candle[] | null> {
  const spec = TIMEFRAME[interval];
  if (!spec) return null;
  const key = `gt:ohlcv:${network}:${pool}:${interval}:${limit}`;
  if (cached<boolean>(`gt:ohlcv:none:${network}:${pool}:${interval}`)) return null;
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
      `/api/v2/networks/${network}/pools/${encodeURIComponent(pool)}/ohlcv/${spec.tf}?${q.toString()}`,
      // The chart the user is LOOKING AT must not queue behind Discover's
      // background polls on the same 2.1 s-gap host.
      { priority: opts.priority },
    );
    const list = r.ok ? r.data?.data?.attributes?.ohlcv_list : null;
    if (r.ok && Array.isArray(list) && !list.length) putCache(`gt:ohlcv:none:${network}:${pool}:${interval}`, true, NONE_OHLCV_MS);
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

/** Pools for a mint — the fallback when DexScreener has not indexed it.
 *  `priority` puts the visible chart's lookup ahead of background polls. */
export async function poolsForToken(mint: string, opts: { priority?: boolean } = {}): Promise<TokenPool[]> {
  return poolsForTokenOn('solana', mint, opts);
}

export async function poolsForTokenOn(network: GtNetwork, mint: string, opts: { priority?: boolean } = {}): Promise<TokenPool[]> {
  if (cached<boolean>(`gt:pools:none:${network}:${mint}`)) return [];
  const hit = await memo<TokenPool[]>(`gt:pools:${network}:${mint}`, 60_000, async () => {
    const r = await getJson<PoolsResponse>(
      'geckoterminal',
      `/api/v2/networks/${network}/tokens/${encodeURIComponent(mint)}/pools?page=1`,
      { priority: opts.priority },
    );
    if (!r.ok || !Array.isArray(r.data?.data)) return null;
    if (!r.data.data.length) putCache(`gt:pools:none:${network}:${mint}`, true, NONE_POOLS_MS);
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
        // GeckoTerminal's pool list does not name the quote token here.
        quoteMint: null,
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
  /** Absent on the Solana routes; set by the *On variants. */
  network?: GtNetwork;
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
  return newPoolsOn('solana', pages);
}

/** A page of pools from any GeckoTerminal listing route, mapped to NewPool. */
async function poolListing(network: GtNetwork, key: string, path: string, ttlMs: number): Promise<NewPool[] | null> {
  return memo<NewPool[]>(key, ttlMs, async () => {
    const r = await getJson<NewPoolsResponse>('geckoterminal', path);
    if (!r.ok || !Array.isArray(r.data?.data)) return null;
    const mapped: NewPool[] = [];
    for (const p of r.data.data) {
      const a = p.attributes;
      if (!a?.address) continue;
      const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
      const t5 = a.transactions?.m5;
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
        network,
      });
    }
    // An EMPTY page the route answered is an answer, and is cached like any
    // other; `null` is only for a request that failed. Returning null here
    // made every empty listing (a quiet dex, a network with no new pools)
    // a request on every Discover pass — measured 2026-09-20 in the
    // call-count harness, where the four listings were re-asked each pass
    // and pushed the columns seconds apart.
    return mapped;
  });
}

/** Trending pools on a network (GeckoTerminal's own ranking), one page. */
export async function trendingPoolsOn(network: GtNetwork, page = 1): Promise<NewPool[]> {
  return (await poolListing(network, `gt:trending:${network}:${page}`, `/api/v2/networks/${network}/trending_pools?page=${page}`, 60_000)) ?? [];
}

export async function poolsForDexOn(network: GtNetwork, dexId: string, page = 1): Promise<NewPool[]> {
  return (await poolListing(network, `gt:dexpools:${network}:${dexId}:${page}`, `/api/v2/networks/${network}/dexes/${encodeURIComponent(dexId)}/pools?page=${page}`, 60_000)) ?? [];
}

export async function newPoolsOn(network: GtNetwork, pages = 2): Promise<NewPool[]> {
  const wanted = Math.max(1, Math.min(3, pages));
  const out: NewPool[] = [];
  for (let page = 1; page <= wanted; page++) {
    const rows = await memo<NewPool[]>(`gt:newpools:${network}:${page}`, 45_000, async () => {
      const r = await getJson<NewPoolsResponse>('geckoterminal', `/api/v2/networks/${network}/new_pools?page=${page}`);
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
      // An EMPTY page the route answered is an answer, and is cached like any
    // other; `null` is only for a request that failed. Returning null here
    // made every empty listing (a quiet dex, a network with no new pools)
    // a request on every Discover pass — measured 2026-09-20 in the
    // call-count harness, where the four listings were re-asked each pass
    // and pushed the columns seconds apart.
    return mapped;
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
/**
 * Per-dex memo windows, deliberately UNEQUAL. The three per-dex listings
 * and `new_pools` are asked together on the first Discover pass, and with
 * one shared TTL they expired together and were re-asked together: four
 * requests inside eight seconds every minute, which GeckoTerminal answered
 * with a 429 on 2026-09-20 at a mere five calls a minute overall — its
 * limiter is on the burst, not the minute. Staggered, the four spread out
 * to roughly one every fifteen seconds.
 */
const DEX_LISTING_TTL_MS: Record<string, number> = {
  'raydium-launchlab': 60_000,
  'boop-fun': 75_000,
  'meteora-dbc': 90_000,
};

export async function poolsForDex(dexId: string, page = 1): Promise<NewPool[]> {
  const hit = await memo<NewPool[]>(`gt:dexpools:${dexId}:${page}`, DEX_LISTING_TTL_MS[dexId] ?? 60_000, async () => {
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
    // An EMPTY page the route answered is an answer, and is cached like any
    // other; `null` is only for a request that failed. Returning null here
    // made every empty listing (a quiet dex, a network with no new pools)
    // a request on every Discover pass — measured 2026-09-20 in the
    // call-count harness, where the four listings were re-asked each pass
    // and pushed the columns seconds apart.
    return mapped;
  });
  return hit ?? [];
}

// ── Batched prices (simple/token_price) ───────────────────────────────
//
// One request answers price, market cap, 24 h volume, 24 h change and
// liquidity for up to THIRTY mints (verified 2026-09-09; `tokens/multi`
// carries the same cap and refuses a longer list with a clean HTTP 400).
//
// This is a FALLBACK, not a default. GeckoTerminal's whole budget is 30
// calls a minute and the chart lives on it, so this only runs where the app
// would otherwise have no number at all — Jupiter switched off or parked.
// Every field is read defensively: a shape that does not match leaves the
// field null, which the UI prints as an em dash, and never a wrong number.

/** Hard cap on one `simple/token_price` request. */
export const PRICE_BATCH_MAX = 30;

export interface GtTokenPrice {
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
}

interface TokenPriceResponse {
  data?: {
    attributes?: {
      token_prices?: Record<string, string | number | null>;
      market_cap_usd?: Record<string, string | number | null>;
      h24_volume_usd?: Record<string, string | number | null>;
      h24_price_change_percentage?: Record<string, string | number | null>;
      total_reserve_in_usd?: Record<string, string | number | null>;
    };
  };
}

const pickNum = (map: Record<string, string | number | null> | undefined, key: string): number | null =>
  map ? numOrNull(map[key]) : null;

/**
 * Prices for many mints, ≤ 30 per request, memoised 30 s per chunk.
 * Mints GeckoTerminal does not price are simply absent from the map.
 */
export async function simpleTokenPrices(
  mints: string[],
  network: GtNetwork = 'solana',
): Promise<Map<string, GtTokenPrice>> {
  const out = new Map<string, GtTokenPrice>();
  const unique = [...new Set(mints.filter((m) => typeof m === 'string' && m))];
  for (let i = 0; i < unique.length; i += PRICE_BATCH_MAX) {
    const chunk = unique.slice(i, i + PRICE_BATCH_MAX);
    const q = new URLSearchParams({
      include_market_cap: 'true',
      include_24hr_vol: 'true',
      include_24hr_price_change: 'true',
      include_total_reserve_in_usd: 'true',
    });
    const hit = await memo<TokenPriceResponse['data']>(
      `gt:price:${network}:${chunk.join(',')}`,
      30_000,
      async () => {
        const r = await getJson<TokenPriceResponse>(
          'geckoterminal',
          `/api/v2/simple/networks/${network}/token_price/${chunk.map(encodeURIComponent).join(',')}?${q.toString()}`,
        );
        return r.ok && r.data?.data ? r.data.data : null;
      },
    );
    const a = hit?.attributes;
    if (!a) continue;
    for (const mint of chunk) {
      const priceUsd = pickNum(a.token_prices, mint);
      const marketCapUsd = pickNum(a.market_cap_usd, mint);
      const volume24hUsd = pickNum(a.h24_volume_usd, mint);
      const priceChange24hPct = pickNum(a.h24_price_change_percentage, mint);
      const liquidityUsd = pickNum(a.total_reserve_in_usd, mint);
      if (
        priceUsd === null &&
        marketCapUsd === null &&
        volume24hUsd === null &&
        priceChange24hPct === null &&
        liquidityUsd === null
      ) {
        continue; // nothing known about this mint — absent, not zeroed
      }
      out.set(mint, { priceUsd, marketCapUsd, volume24hUsd, priceChange24hPct, liquidityUsd });
    }
  }
  return out;
}

// ── Token info (holders) ──────────────────────────────────────────────
//
// GeckoTerminal's token/info route carries a holder count and a top-10 /
// 11–30 / 31–50 / rest distribution for networks with no free holder RPC —
// Robinhood Chain's Blockscout sits behind a Cloudflare challenge, so this
// is the keyless holder source there. Memoised 2 min: holders move slowly
// and the budget is 30 calls a minute for everything.

interface TokenInfoResponse {
  data?: {
    attributes?: {
      name?: string;
      symbol?: string;
      decimals?: number;
      image_url?: string | null;
      websites?: string[];
      twitter_handle?: string | null;
      telegram_handle?: string | null;
      holders?: { count?: number | null; distribution_percentage?: { top_10?: string } | null } | null;
    };
  };
}

export interface GtTokenInfo {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  imageUrl: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  holders: number | null;
  top10Pct: number | null;
}

export async function tokenInfoOn(network: GtNetwork, address: string, opts: { priority?: boolean } = {}): Promise<GtTokenInfo | null> {
  return memo<GtTokenInfo>(`gt:tokeninfo:${network}:${address.toLowerCase()}`, 120_000, async () => {
    const r = await getJson<TokenInfoResponse>(
      'geckoterminal',
      `/api/v2/networks/${network}/tokens/${encodeURIComponent(address)}/info`,
      { priority: opts.priority },
    );
    const a = r.data?.data?.attributes;
    if (!r.ok || !a) return null;
    const top10 = Number(a.holders?.distribution_percentage?.top_10);
    const tw = a.twitter_handle ? `https://x.com/${a.twitter_handle}` : null;
    const tg = a.telegram_handle ? `https://t.me/${a.telegram_handle}` : null;
    const site = Array.isArray(a.websites) ? a.websites.find((w) => typeof w === 'string' && w.startsWith('https://')) ?? null : null;
    return {
      name: a.name ?? null,
      symbol: a.symbol ?? null,
      decimals: typeof a.decimals === 'number' ? a.decimals : null,
      imageUrl: typeof a.image_url === 'string' && a.image_url.startsWith('https://') ? a.image_url : null,
      website: site,
      twitter: tw,
      telegram: tg,
      holders: typeof a.holders?.count === 'number' ? a.holders.count : null,
      top10Pct: Number.isFinite(top10) ? top10 : null,
    };
  });
}
