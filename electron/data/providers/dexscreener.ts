// DexScreener (api.dexscreener.com) — keyless, no rate-limit key required.
//
// What it is the best source for, and nothing else:
//   • the POOL a token actually trades in (address + dexId) — the chart needs
//     a pool, and Jupiter's `firstPool` is often the bonding curve, not the
//     AMM pair;
//   • socials that survived migration (twitter / telegram / website), plus
//     whether the creator PAID for enhanced info — the "DEX paid" filter;
//   • per-pair 5m/1h/6h/24h txn counts as a cross-check on Jupiter.
//
// We do NOT use it for market cap. DexScreener reports mcap per PAIR and a
// token with several pools reports several different numbers; Jupiter's
// aggregate is the honest one.

import { cached, getJson, memo, putCache } from '../http';
import type { TokenPool, TokenSocials } from '@shared/market';

interface DsToken {
  address?: string;
  name?: string;
  symbol?: string;
}

interface DsPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  labels?: string[];
  baseToken?: DsToken;
  quoteToken?: DsToken;
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    websites?: Array<{ label?: string; url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
  boosts?: { active?: number };
}

export interface DsTokenInfo {
  pools: TokenPool[];
  socials: TokenSocials;
  imageUrl: string | null;
  /** Earliest pair creation across all pools — a decent age fallback. */
  pairCreatedAt: number | null;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  txns24h: { buys: number; sells: number } | null;
}

/** Wrapped SOL — the only quote token whose price is a SOL price. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const TTL_TOKEN_MS = 15_000;

/**
 * "DexScreener indexes no pair for this mint" is an ANSWER, and `memo` never
 * stores null, so a token still on its bonding curve — which by definition
 * has no AMM pair — was re-asked on every poll of every surface showing it:
 * 12 DexScreener calls a minute against 4 for a migrated token (rate-limit
 * swarm A5, still open on this half as of 2026-09-09).
 *
 * Written ONLY for a real 200 carrying an empty pair list, never for a
 * failure, a 429 or a park, so a rate limit can never poison it. Short
 * enough that a token migrating mid-session is picked up within half a
 * minute.
 */
const NONE_TOKEN_MS = 30_000;
const noneKey = (mint: string): string => `ds:token:none:${mint}`;
const tokenKey = (mint: string): string => `ds:token:${mint}`;

/** Assemble one token's answer from the pairs DexScreener returned for it.
 *  Shared by the per-mint route and the batch route below, which the swarm
 *  verified return BYTE-IDENTICAL pair objects. */
function buildInfo(pairs: DsPair[]): DsTokenInfo | null {
  if (!pairs.length) return null;

  // The pool with the most recent VOLUME is the one the market uses; pure
  // liquidity ranking picked a dead $1 Meteora pool over a token's live DBC
  // curve (which reports no liquidity figure) and priced a holding at −90 %
  // (2026-09-02). Liquidity breaks ties.
  const vol = (p: DsPair): number => num(p.volume?.h1) ?? num(p.volume?.h6) ?? 0;
  const sorted = [...pairs].sort(
    (a, b) => vol(b) - vol(a) || (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0),
  );
  const best = sorted[0];

  const pools: TokenPool[] = sorted.slice(0, 8).map((p) => ({
    address: p.pairAddress as string,
    dexId: p.dexId ?? 'unknown',
    label: `${p.baseToken?.symbol ?? '?'}/${p.quoteToken?.symbol ?? '?'}`,
    liquidityUsd: num(p.liquidity?.usd),
    quoteMint: p.quoteToken?.address ?? null,
  }));

  // Socials can appear on any pair; take the first non-empty across all.
  let twitter: string | null = null;
  let telegram: string | null = null;
  let website: string | null = null;
  let dexPaid = false;
  let imageUrl: string | null = null;
  for (const p of sorted) {
    // `info` is only populated when the creator submitted (paid for)
    // enhanced token info — which is exactly what the DEX-paid filter is.
    if (p.info) dexPaid = true;
    imageUrl = imageUrl ?? p.info?.imageUrl ?? null;
    for (const s of p.info?.socials ?? []) {
      const t = (s.type ?? '').toLowerCase();
      const u = typeof s.url === 'string' && s.url.startsWith('https://') ? s.url : null;
      if (!u) continue;
      if (!twitter && (t === 'twitter' || u.includes('x.com') || u.includes('twitter.com'))) twitter = u;
      if (!telegram && (t === 'telegram' || u.includes('t.me'))) telegram = u;
    }
    for (const w of p.info?.websites ?? []) {
      if (!website && typeof w.url === 'string' && w.url.startsWith('https://')) website = w.url;
    }
  }

  const created = sorted.map((p) => num(p.pairCreatedAt)).filter((n): n is number => n !== null);

  const t24 = best.txns?.h24;
  return {
    pools,
    socials: { twitter, telegram, website, dexPaid },
    imageUrl,
    pairCreatedAt: created.length ? Math.min(...created) : null,
    priceUsd: num(best.priceUsd),
    // priceNative is the price in the pair's QUOTE token. Reading a
    // USDC-quoted pair's value as SOL would misprice the holding, the
    // position value and the sell-side fee basis by the SOL price itself.
    priceNative: best.quoteToken?.address === WSOL_MINT ? num(best.priceNative) : null,
    liquidityUsd: num(best.liquidity?.usd),
    txns24h: t24 ? { buys: t24.buys ?? 0, sells: t24.sells ?? 0 } : null,
  };
}

/** Pools this token trades in, richest first, plus socials and image. */
export async function tokenInfo(mint: string): Promise<DsTokenInfo | null> {
  if (cached<boolean>(noneKey(mint))) return null;
  return memo<DsTokenInfo>(tokenKey(mint), TTL_TOKEN_MS, async () => {
    const r = await getJson<{ pairs?: DsPair[] | null }>('dexscreener', `/latest/dex/tokens/${encodeURIComponent(mint)}`);
    if (!r.ok) return null;
    const pairs = (r.data?.pairs ?? []).filter((p) => p?.chainId === 'solana' && p.pairAddress);
    if (!pairs.length) {
      putCache(noneKey(mint), true, NONE_TOKEN_MS);
      return null;
    }
    return buildInfo(pairs);
  });
}

// ── The batch route ───────────────────────────────────────────────────
//
// `/tokens/v1/solana/{comma-separated mints}` returns the same pair objects
// as the per-mint route for up to THIRTY mints in one request — a ~30×
// saving on the portfolio path, which was making sixty individual calls
// (api swarm 2026-09-09 §4).
//
// The cap is enforced here, client-side, and that is not politeness: the
// route SILENTLY DROPS everything past the thirtieth address rather than
// erroring, so a chunk of 60 would come back looking like a complete answer
// in which half the portfolio simply has no pools. That would be a
// correctness bug — a missing pool reads as "not tradeable yet" — not just
// waste. `test/dexscreener.test.mjs` pins the chunking.

/** Hard cap on one `/tokens/v1/solana/…` request. Verified 2026-09-09. */
export const BATCH_MAX = 30;

/** Split into chunks no larger than the route's real cap. Exported for the test
 *  that proves a 60-mint ask never becomes one truncated request. */
export function chunkMints(mints: string[], size = BATCH_MAX): string[][] {
  const unique = [...new Set(mints.filter((m) => typeof m === 'string' && m))];
  const n = Math.max(1, Math.min(BATCH_MAX, size));
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += n) out.push(unique.slice(i, i + n));
  return out;
}

/**
 * Token info for MANY mints, batched 30 at a time, warming the very cache
 * `tokenInfo` reads — so a caller can batch first and then call `tokenInfo`
 * per mint without a single extra request.
 *
 * A mint the batch returned no BASE-side pair for is left alone rather than
 * marked absent: it may simply be somebody else's quote token (wSOL, USDC),
 * and the per-mint route is the honest place to find that out.
 */
export async function tokenInfoMany(
  mints: string[],
  opts: { priority?: boolean } = {},
): Promise<Map<string, DsTokenInfo>> {
  const out = new Map<string, DsTokenInfo>();
  const wanted: string[] = [];
  for (const m of [...new Set(mints.filter(Boolean))]) {
    const hit = cached<DsTokenInfo>(tokenKey(m));
    if (hit) out.set(m, hit);
    else if (!cached<boolean>(noneKey(m))) wanted.push(m);
  }
  if (!wanted.length) return out;

  for (const chunk of chunkMints(wanted)) {
    const rows = await memo<DsPair[]>(`ds:batch:${chunk.join(',')}`, TTL_TOKEN_MS, async () => {
      const r = await getJson<DsPair[]>(
        'dexscreener',
        `/tokens/v1/solana/${chunk.map(encodeURIComponent).join(',')}`,
        { priority: opts.priority },
      );
      return r.ok && Array.isArray(r.data) ? r.data : null;
    });
    if (!rows) continue;

    const byMint = new Map<string, DsPair[]>();
    for (const p of rows) {
      if (p?.chainId !== 'solana' || !p.pairAddress) continue;
      const base = p.baseToken?.address;
      if (!base) continue;
      const list = byMint.get(base);
      if (list) list.push(p);
      else byMint.set(base, [p]);
    }
    for (const [mint, pairs] of byMint) {
      const info = buildInfo(pairs);
      if (!info) continue;
      putCache(tokenKey(mint), info, TTL_TOKEN_MS);
      out.set(mint, info);
    }
  }
  return out;
}


// ── Orders (DEX paid / boosts / CTO) ──────────────────────────────────

export interface DsOrders {
  /** Enhanced token info paid for and approved. False on a 200 with no
   *  approved profile order; null when the endpoint did not answer. */
  paid: boolean | null;
  /** Earliest approved payment, ms. */
  paidAt: number | null;
  /** Sum of active boost amounts. 0 on a 200 that lists none; null when the
   *  answer carried no boosts block at all. */
  boosts: number | null;
  /** An approved community-takeover order exists. */
  communityTakeover: boolean | null;
}

interface DsOrder {
  type?: string;
  status?: string;
  paymentTimestamp?: number;
}

interface DsBoost {
  amount?: number;
}

const PAID_TYPES = new Set(['tokenProfile', 'tokenAd', 'trendingBarAd']);

/**
 * `orders/v1/solana/{mint}` — 60/min, verified 2026-08-30. Answers as
 * either a bare array of orders or `{ orders, boosts }`; both are read. A
 * 200 with nothing in it is an honest "not paid", a non-200 is all-null.
 * Memoised 10 min: whether somebody paid DexScreener does not change fast,
 * and it is a descriptive fact with no measured edge (rugrules NO_EDGE_NOTE).
 */
export async function orders(mint: string): Promise<DsOrders> {
  const silent: DsOrders = { paid: null, paidAt: null, boosts: null, communityTakeover: null };
  const hit = await memo<DsOrders>(`ds:orders:${mint}`, 600_000, async () => {
    const r = await getJson<DsOrder[] | { orders?: DsOrder[]; boosts?: DsBoost[] }>(
      'dexscreener',
      `/orders/v1/solana/${encodeURIComponent(mint)}`,
    );
    if (!r.ok) return null;
    const body = r.data;
    const list: DsOrder[] = Array.isArray(body) ? body : Array.isArray(body?.orders) ? body.orders : [];
    const boostList: DsBoost[] | null = !Array.isArray(body) && Array.isArray(body?.boosts) ? body.boosts : null;
    const approved = list.filter((o) => o && o.status === 'approved');
    const paidOrders = approved.filter((o) => PAID_TYPES.has(o.type ?? ''));
    const stamps = paidOrders
      .map((o) => num(o.paymentTimestamp))
      .filter((n): n is number => n !== null)
      .map((n) => (n < 1e12 ? n * 1000 : n));
    return {
      paid: paidOrders.length > 0,
      paidAt: stamps.length ? Math.min(...stamps) : null,
      boosts: boostList === null ? null : boostList.reduce((acc, b) => acc + (num(b?.amount) ?? 0), 0),
      communityTakeover: approved.some((o) => o.type === 'communityTakeover'),
    };
  });
  return hit ?? silent;
}

// ── Any chain: the token-pairs route ──────────────────────────────────
//
// `/token-pairs/v1/{chain}/{address}` answers with the same pair objects
// as the Solana route, for every chain DexScreener indexes ('robinhood'
// verified 2026-09-08). Kept as a separate export with the chain in its
// cache key so the Solana callers above never see another chain's pools.

export interface DsPairLite {
  pairAddress: string;
  dexId: string;
  labels: string[];
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  pairCreatedAt: number | null;
  volume: Record<string, number>;
  priceChange: Record<string, number>;
  txns: Record<string, { buys: number; sells: number }>;
  imageUrl: string | null;
  socials: TokenSocials;
}

/** The memo key `tokenPairsOn` reads. Shared so a batch can fill it. */
const pairsKey = (chain: string, address: string): string => `ds:pairs:${chain}:${address.toLowerCase()}`;
const PAIRS_TTL_MS = 15_000;

/** Rank and trim one token's pairs into the lite shape the app stores. */
function toLite(chain: string, rows: DsPair[]): DsPairLite[] {
  const pairs = rows.filter((p) => p?.chainId === chain && p.pairAddress);
  const vol = (p: DsPair): number => num(p.volume?.h1) ?? num(p.volume?.h6) ?? 0;
  pairs.sort((a, b) => vol(b) - vol(a) || (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0));
  return pairs.slice(0, 8).map((p) => {
      let twitter: string | null = null;
      let telegram: string | null = null;
      let website: string | null = null;
      for (const s of p.info?.socials ?? []) {
        const t = (s.type ?? '').toLowerCase();
        const u = typeof s.url === 'string' && s.url.startsWith('https://') ? s.url : null;
        if (!u) continue;
        if (!twitter && (t === 'twitter' || u.includes('x.com') || u.includes('twitter.com'))) twitter = u;
        if (!telegram && (t === 'telegram' || u.includes('t.me'))) telegram = u;
      }
      for (const w of p.info?.websites ?? []) {
        if (!website && typeof w.url === 'string' && w.url.startsWith('https://')) website = w.url;
      }
      const txns: Record<string, { buys: number; sells: number }> = {};
      for (const [k, v] of Object.entries(p.txns ?? {})) txns[k] = { buys: v?.buys ?? 0, sells: v?.sells ?? 0 };
      return {
        pairAddress: p.pairAddress as string,
        dexId: p.dexId ?? 'unknown',
        labels: Array.isArray(p.labels) ? p.labels : [],
        baseToken: { address: p.baseToken?.address ?? '', symbol: p.baseToken?.symbol ?? '', name: p.baseToken?.name ?? '' },
        quoteToken: { address: p.quoteToken?.address ?? '', symbol: p.quoteToken?.symbol ?? '' },
        priceUsd: num(p.priceUsd),
        priceNative: num(p.priceNative),
        liquidityUsd: num(p.liquidity?.usd),
        fdv: num(p.fdv),
        marketCap: num(p.marketCap),
        pairCreatedAt: num(p.pairCreatedAt),
        volume: Object.fromEntries(Object.entries(p.volume ?? {}).map(([k, v]) => [k, num(v) ?? 0])),
        priceChange: Object.fromEntries(Object.entries(p.priceChange ?? {}).map(([k, v]) => [k, num(v) ?? 0])),
        txns,
        imageUrl: typeof p.info?.imageUrl === 'string' && p.info.imageUrl.startsWith('https://') ? p.info.imageUrl : null,
        socials: { twitter, telegram, website, dexPaid: !!p.info },
      };
  });
}

export async function tokenPairsOn(chain: string, address: string, opts: { priority?: boolean } = {}): Promise<DsPairLite[]> {
  const hit = await memo<DsPairLite[]>(pairsKey(chain, address), PAIRS_TTL_MS, async () => {
    const r = await getJson<DsPair[]>('dexscreener', `/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`, { priority: opts.priority });
    if (!r.ok || !Array.isArray(r.data)) return null;
    const out = toLite(chain, r.data);
    return out.length ? out : null;
  });
  return hit ?? [];
}

/**
 * The pairs for MANY tokens on one chain, in one request per 30.
 *
 * `/tokens/v1/{chain}/{a,b,c}` is the same route `tokenInfoMany` uses for
 * Solana, and it works for every chain DexScreener indexes. Results are
 * written under the very key `tokenPairsOn` memoises, so a caller that warms
 * this first and then builds summaries one at a time makes NO further
 * request — which is how the watchlist stopped spending one round trip per
 * pinned EVM token (2026-09-15).
 *
 * A token the batch returns nothing for is left uncached rather than cached
 * empty: "the batch did not mention it" is not "it has no pairs", and a
 * negative cache built from an absence would hide a token from its own page.
 */
export async function tokenPairsOnMany(chain: string, addresses: string[], opts: { priority?: boolean } = {}): Promise<void> {
  const wanted = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))].filter((a) => cached<DsPairLite[]>(pairsKey(chain, a)) === null);
  if (wanted.length < 2) return; // one token is not a batch — let the single route handle it
  for (const chunk of chunkMints(wanted)) {
    const rows = await memo<DsPair[]>(`ds:pairsbatch:${chain}:${chunk.join(',')}`, PAIRS_TTL_MS, async () => {
      const r = await getJson<DsPair[]>(
        'dexscreener',
        `/tokens/v1/${encodeURIComponent(chain)}/${chunk.map(encodeURIComponent).join(',')}`,
        { priority: opts.priority },
      );
      return r.ok && Array.isArray(r.data) ? r.data : null;
    });
    if (!rows) continue;
    const byToken = new Map<string, DsPair[]>();
    for (const p of rows) {
      const base = p?.baseToken?.address?.toLowerCase();
      if (!base || p.chainId !== chain || !p.pairAddress) continue;
      const list = byToken.get(base);
      if (list) list.push(p);
      else byToken.set(base, [p]);
    }
    for (const [token, pairs] of byToken) {
      const lite = toLite(chain, pairs);
      if (lite.length) putCache(pairsKey(chain, token), lite, PAIRS_TTL_MS);
    }
  }
}
