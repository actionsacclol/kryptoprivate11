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

import { getJson, memo } from '../http';
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

/** Pools this token trades in, richest first, plus socials and image. */
export async function tokenInfo(mint: string): Promise<DsTokenInfo | null> {
  return memo<DsTokenInfo>(`ds:token:${mint}`, 15_000, async () => {
    const r = await getJson<{ pairs?: DsPair[] | null }>('dexscreener', `/latest/dex/tokens/${encodeURIComponent(mint)}`);
    if (!r.ok) return null;
    const pairs = (r.data?.pairs ?? []).filter((p) => p?.chainId === 'solana' && p.pairAddress);
    if (!pairs.length) return null;

    // The pool with the most recent VOLUME is the one the market uses; pure
    // liquidity ranking picked a dead $1 Meteora pool over a token's live DBC
    // curve (which reports no liquidity figure) and priced a holding at −90 %
    // (2026-09-02). Liquidity breaks ties.
    const vol = (p: DsPair): number => num(p.volume?.h1) ?? num(p.volume?.h6) ?? 0;
    pairs.sort((a, b) => vol(b) - vol(a) || (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0));
    const best = pairs[0];

    const pools: TokenPool[] = pairs.slice(0, 8).map((p) => ({
      address: p.pairAddress as string,
      dexId: p.dexId ?? 'unknown',
      label: `${p.baseToken?.symbol ?? '?'}/${p.quoteToken?.symbol ?? '?'}`,
      liquidityUsd: num(p.liquidity?.usd),
    }));

    // Socials can appear on any pair; take the first non-empty across all.
    let twitter: string | null = null;
    let telegram: string | null = null;
    let website: string | null = null;
    let dexPaid = false;
    let imageUrl: string | null = null;
    for (const p of pairs) {
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

    const created = pairs
      .map((p) => num(p.pairCreatedAt))
      .filter((n): n is number => n !== null);

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
  });
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
