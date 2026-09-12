// pump.fun frontend API (frontend-api-v3.pump.fun) — keyless.
//
// The ONLY source that answers "which mints are about to graduate". Jupiter
// and DexScreener both index a token once it has a pool; the interesting
// window for a memecoin trader is the hour BEFORE that, while it is still on
// the bonding curve. That is the GRADUATING column, and it needs the curve
// reserves, which only pump publishes.
//
// It is also the cheapest source of `complete` (migrated) and of pump's own
// creation timestamp.
//
// Curve progress is computed with the engine's own bigint curve math
// (`electron/engine/curve.ts`) rather than trusting a percentage from the
// API — same arithmetic that prices a paper fill, so the number in the
// Discover row and the number in the trade panel can never disagree.

import { getJson, memo, putCache } from '../http';
import { curveProgressPct, INITIAL_VIRTUAL_SOL } from '../../engine/curve';
import { emptySummary, type TokenSummary } from '@shared/market';

export interface PumpCoin {
  mint: string;
  name?: string;
  symbol?: string;
  description?: string;
  image_uri?: string;
  metadata_uri?: string;
  bonding_curve?: string;
  associated_bonding_curve?: string;
  creator?: string;
  created_timestamp?: number;
  complete?: boolean;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  real_sol_reserves?: number;
  real_token_reserves?: number;
  total_supply?: number;
  last_trade_timestamp?: number;
  market_cap?: number;
  usd_market_cap?: number;
  market_cap_usd?: number;
  ath_market_cap?: number;
  king_of_the_hill_timestamp?: number;
  reply_count?: number;
  nsfw?: boolean;
  is_banned?: boolean;
  pool_address?: string;
  program?: string;
  protocol?: string;
  token_program?: string;
  base_decimals?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
  verified?: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const httpsOnly = (v: unknown): string | null =>
  typeof v === 'string' && v.startsWith('https://') ? v : null;

/** 0..100 curve completion from the live virtual SOL reserve. */
export function progressPct(c: PumpCoin): number | null {
  if (c.complete) return 100;
  const v = num(c.virtual_sol_reserves);
  if (v === null || v <= 0) return null;
  const asLamports = BigInt(Math.round(v));
  // A curve that has not been bought yet sits exactly at the initial reserve.
  if (asLamports < INITIAL_VIRTUAL_SOL) return 0;
  return curveProgressPct(asLamports);
}

/**
 * `solUsd` lets the caller price the curve's real SOL as exit liquidity.
 * Without it the field stays null and `sources.liquidity` stays 'none' —
 * the audit of 2026-08-30 found the source claimed with no value behind it.
 */
export function toSummary(c: PumpCoin, solUsd: number | null = null): TokenSummary {
  const s = emptySummary(c.mint);
  s.name = c.name ?? '';
  s.symbol = c.symbol ?? '';
  // pump image URIs are creator-controlled. They are passed to the renderer
  // as a plain <img src>, which is a REQUEST from the user's machine to a
  // host the creator picked. The renderer gates these behind the image
  // proxy decision in market.ts — see `sanitizeImage` there.
  s.imageUrl = httpsOnly(c.image_uri);
  s.decimals = c.base_decimals ?? 6;
  s.createdAt = num(c.created_timestamp);
  s.launchpad = 'pumpfun';
  s.marketCapUsd = num(c.usd_market_cap) ?? num(c.market_cap_usd);
  s.totalSupply = num(c.total_supply) === null ? null : (c.total_supply as number) / 10 ** (c.base_decimals ?? 6);
  s.circSupply = s.totalSupply;
  s.bondingCurvePct = progressPct(c);
  s.poolAddress = c.pool_address ?? c.bonding_curve ?? null;
  s.dexId = c.complete ? 'pumpswap' : 'pumpfun-curve';
  s.creator = c.creator ?? null;
  s.socials = {
    twitter: httpsOnly(c.twitter),
    telegram: httpsOnly(c.telegram),
    website: httpsOnly(c.website),
    dexPaid: false,
  };
  // pump.fun's own flags. Absent means null: the API not saying is not "no".
  s.audit.isBanned = typeof c.is_banned === 'boolean' ? c.is_banned : null;
  s.audit.nsfw = typeof c.nsfw === 'boolean' ? c.nsfw : null;
  s.audit.kingOfTheHillAt = num(c.king_of_the_hill_timestamp);
  s.audit.athMarketCapUsd = num(c.ath_market_cap);
  // Real SOL in the curve IS the exit liquidity for a pre-graduation token.
  // Reserves are lamports; only priced when the caller knows SOL/USD.
  const realSol = num(c.real_sol_reserves);
  if (realSol !== null && solUsd !== null && solUsd > 0 && !c.complete) {
    s.liquidityUsd = (realSol / 1e9) * solUsd;
  }
  s.sources = {
    marketCap: 'pumpfun',
    liquidity: s.liquidityUsd === null ? 'none' : 'pumpfun',
    socials: 'pumpfun',
  };
  s.fetchedAt = Date.now();
  return s;
}

// ── Feeds ─────────────────────────────────────────────────────────────

/**
 * The `/coins?` list routes return COMPLETE coin records — the same object
 * `/coins/{mint}` serves. Every row a list returns is therefore remembered
 * per mint, exactly as `jupiter.ts` remembers its batch rows, so the intel
 * paths read the row we were already given instead of buying it back.
 *
 * Measured before this existed (api swarm 2026-09-09 §4): 45 `/coins/{mint}`
 * a minute on an idle Discover, 100 % of them following a list read that
 * contained the row, against a documented budget of 60 per 60 s.
 *
 * The TTL is the one `coinForIntel` already accepted for this data (60 s):
 * a list row is at most its own list TTL old (4-6 s) when it lands here, so
 * this is strictly FRESHER than the request it replaces, never staler.
 */
export const COIN_INTEL_TTL_MS = 60_000;

const intelKey = (mint: string): string => `pf:coin:intel:${mint}`;

function rememberCoins(rows: PumpCoin[]): void {
  for (const c of rows) if (c && typeof c.mint === 'string' && c.mint) putCache(intelKey(c.mint), c, COIN_INTEL_TTL_MS);
}

/**
 * The coin record for the INTEL paths (launch analysis, rug rules, odds).
 *
 * `coin()` memoises 6 s, which is right for a price header and wrong for
 * thirty Discover rows re-asking every refresh. Intel tolerates a
 * minute-old record — and usually pays nothing at all, because the list
 * route that produced the row already filled this cache.
 */
export function coinForIntel(mint: string): Promise<PumpCoin | null> {
  return memo<PumpCoin>(intelKey(mint), COIN_INTEL_TTL_MS, () => coin(mint));
}

type Sort = 'created_timestamp' | 'market_cap' | 'last_trade_timestamp';

async function coins(params: {
  sort: Sort;
  limit: number;
  complete?: boolean;
  key: string;
  ttlMs: number;
}): Promise<PumpCoin[]> {
  const q = new URLSearchParams({
    offset: '0',
    limit: String(Math.min(100, Math.max(1, params.limit))),
    sort: params.sort,
    order: 'DESC',
    includeNsfw: 'false',
  });
  if (params.complete !== undefined) q.set('complete', String(params.complete));
  const hit = await memo<PumpCoin[]>(params.key, params.ttlMs, async () => {
    const r = await getJson<PumpCoin[]>('pumpfun', `/coins?${q.toString()}`, { lane: 'list' });
    if (!r.ok || !Array.isArray(r.data)) return null;
    const rows = r.data.filter((c) => c && typeof c.mint === 'string' && !c.is_banned);
    rememberCoins(rows);
    return rows;
  });
  return hit ?? [];
}

/** Newest mints on the curve. */
export function latest(limit = 40): Promise<PumpCoin[]> {
  return coins({ sort: 'created_timestamp', limit, complete: false, key: `pf:new:${limit}`, ttlMs: 4_000 });
}

/**
 * Tokens closest to completing their bonding curve.
 *
 * NOT sorted by market cap, which is what this originally did and got wrong.
 * pump's `usd_market_cap` is unreliable for `complete=false` coins: verified
 * on 2026-08-24, the top four by market cap included a 404-day-old token
 * reporting a $17M cap whose `virtual_sol_reserves` was exactly
 * 30000000000 — the INITIAL reserve, i.e. 0% progress. Sorting that way
 * filled the Graduating column with stale year-old listings that will never
 * graduate, at a permanent 100% or 0%.
 *
 * `last_trade_timestamp` gives tokens with actual current curve activity;
 * progress is then computed from the reserves and the list re-ranked. Rows
 * at 0% (never bought) and 100% (already at the threshold but not migrated)
 * are dropped — neither is "about to graduate".
 */
export async function graduating(limit = 40): Promise<PumpCoin[]> {
  const rows = await coins({
    sort: 'last_trade_timestamp',
    limit: 100,
    complete: false,
    key: `pf:grad:${limit}`,
    ttlMs: 5_000,
  });
  return rows
    .map((c) => ({ c, p: progressPct(c) }))
    .filter((x) => x.p !== null && x.p > 0 && x.p < 100)
    .sort((a, b) => (b.p as number) - (a.p as number))
    .slice(0, limit)
    .map((x) => x.c);
}

/** Graduated onto PumpSwap, most recently traded first. */
export function migrated(limit = 40): Promise<PumpCoin[]> {
  return coins({ sort: 'last_trade_timestamp', limit, complete: true, key: `pf:mig:${limit}`, ttlMs: 6_000 });
}

/** One coin by mint — the bonding-curve half of the token page. */
/** `coin()` for the trade path: no memo (one call per trade), and the HTTP
 *  failure is returned instead of swallowed. pump.fun's frontend API sits
 *  behind Cloudflare and blocks many VPN / datacenter exits with 403 — a user
 *  on a VPN must see THAT, not "no local builder". */
export async function coinOrError(
  mint: string,
  opts: { priority?: boolean } = {},
): Promise<{ coin: PumpCoin | null; error: string | null }> {
  const r = await getJson<PumpCoin>('pumpfun', `/coins/${encodeURIComponent(mint)}`, { priority: opts.priority });
  if (!r.ok) return { coin: null, error: `pump.fun ${r.status ?? 'network'}: ${r.message}` };
  if (!r.data || typeof r.data.mint !== 'string') return { coin: null, error: null };
  return { coin: r.data, error: null };
}

export async function coin(mint: string): Promise<PumpCoin | null> {
  return memo<PumpCoin>(`pf:coin:${mint}`, 6_000, async () => {
    const r = await getJson<PumpCoin>('pumpfun', `/coins/${encodeURIComponent(mint)}`);
    if (!r.ok || !r.data || typeof r.data.mint !== 'string') return null;
    return r.data;
  });
}

/**
 * Every coin a wallet has launched on pump.fun, newest first.
 *
 * The dedicated route for this (`/coins/user-created/{address}`) is gone —
 * 404 on 2026-08-24 — but the plain `/coins` list accepts `creator` as a
 * filter, which nothing documents and which works. This is the entire basis
 * of the creator track record: how many launches, how many graduated, and how
 * fast they are being minted.
 *
 * Two pages max (200 launches). A wallet past that is a factory and the exact
 * count stops mattering; `truncated` says so rather than implying the number
 * is complete.
 */
export async function byCreator(creator: string, maxPages = 2): Promise<{ coins: PumpCoin[]; truncated: boolean }> {
  const out: PumpCoin[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let p = 0; p < maxPages; p++) {
    const q = new URLSearchParams({
      offset: String(p * 100),
      limit: '100',
      creator,
      sort: 'created_timestamp',
      order: 'DESC',
      includeNsfw: 'true', // a track record must not hide the nsfw launches
    });
    const hit = await memo<PumpCoin[]>(`pf:creator:${creator}:${p}`, 60_000, async () => {
      const r = await getJson<PumpCoin[]>('pumpfun', `/coins?${q.toString()}`, { lane: 'list' });
      if (!r.ok || !Array.isArray(r.data)) return null;
      const rows = r.data.filter((c) => c && typeof c.mint === 'string');
      rememberCoins(rows);
      return rows;
    });
    if (!hit) break;
    // The API's offset paging overlaps at the boundary; dedupe by mint.
    for (const c of hit) {
      if (seen.has(c.mint)) continue;
      seen.add(c.mint);
      out.push(c);
    }
    if (hit.length < 100) break;
    if (p === maxPages - 1) truncated = true;
  }

  return { coins: out, truncated };
}
