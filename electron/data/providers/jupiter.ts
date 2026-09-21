// Jupiter Lite API (lite-api.jup.ag) — the terminal's primary keyless
// provider and the backbone of Discover.
//
// Jupiter's /tokens/v2 endpoints return, per mint and with no API key: price,
// mcap, fdv, liquidity, holder count, holder change, 5m/1h/6h/24h buy/sell
// counts and trader counts, ORGANIC volume (their wash/bot-filtered figure),
// first-pool creation time, and an `audit` block carrying mint/freeze
// authority state, top-holder percentage, dev balance percentage and the
// number of other mints that dev has created.
//
// That last block is why Jupiter leads: it answers most of term.txt §6 for
// any mint, including ones this install never watched launch. We still
// re-verify mint and freeze authority on-chain before the security panel
// calls them "pass" — a third-party audit flag is a hint, not a fact.

import { cached, getJson, memo, putCache } from '../http';
import {
  emptySummary,
  type Launchpad,
  type StatsWindow,
  type TokenSummary,
  type WindowStats,
} from '@shared/market';

// ── Wire shapes (only the fields we consume) ──────────────────────────

interface JupStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupAudit {
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  topHoldersPercentage?: number;
  devBalancePercentage?: number;
  /** Total mints this dev has ever created. Verified present 2026-08-24. */
  devMints?: number;
  /** How many of those actually graduated — the useful half of devMints.
   *  A dev with 8437 mints and 20 migrations is a launch farm. */
  devMigrations?: number;
}

export interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  dev?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  circSupply?: number;
  totalSupply?: number;
  tokenProgram?: string;
  holderCount?: number;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  stats5m?: JupStats;
  stats1h?: JupStats;
  stats6h?: JupStats;
  stats24h?: JupStats;
  firstPool?: { id?: string; createdAt?: string };
  audit?: JupAudit;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  launchpad?: string;
  bondingCurve?: number;
  graduatedPool?: string;
  graduatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── Mapping ───────────────────────────────────────────────────────────

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function mapStats(s: JupStats | undefined): WindowStats | undefined {
  if (!s) return undefined;
  const buyVol = num(s.buyVolume) ?? 0;
  const sellVol = num(s.sellVolume) ?? 0;
  const organic = (num(s.buyOrganicVolume) ?? 0) + (num(s.sellOrganicVolume) ?? 0);
  return {
    priceChangePct: num(s.priceChange),
    volumeUsd: buyVol + sellVol,
    buys: num(s.numBuys),
    sells: num(s.numSells),
    traders: num(s.numTraders),
    organicVolumeUsd: organic > 0 ? organic : null,
  };
}

/** Jupiter tags the launchpad on newer mints; the suffix is the fallback. */
function detectLaunchpad(t: JupToken): Launchpad {
  const lp = (t.launchpad ?? '').toLowerCase();
  if (lp.includes('pump')) return 'pumpfun';
  if (lp.includes('bonk') || lp.includes('letsbonk')) return 'bonk';
  if (lp.includes('moonshot')) return 'moonshot';
  if (lp.includes('believe')) return 'believe';
  if (lp.includes('boop')) return 'boop';
  if (lp.includes('meteora') || lp.includes('dbc')) return 'meteora';
  if (lp.includes('raydium')) return 'raydium';
  const id = t.id ?? '';
  if (id.endsWith('pump')) return 'pumpfun';
  if (id.endsWith('bonk')) return 'bonk';
  if (id.endsWith('moon')) return 'moonshot';
  if (id.endsWith('boop')) return 'boop';
  return 'unknown';
}

export function toSummary(t: JupToken): TokenSummary {
  const s = emptySummary(t.id);
  s.name = t.name ?? '';
  s.symbol = t.symbol ?? '';
  s.imageUrl = t.icon ?? null;
  s.decimals = t.decimals ?? 6;
  s.createdAt = parseTime(t.firstPool?.createdAt) ?? parseTime(t.createdAt);
  s.launchpad = detectLaunchpad(t);

  s.priceUsd = num(t.usdPrice);
  s.marketCapUsd = num(t.mcap);
  s.fdvUsd = num(t.fdv);
  s.liquidityUsd = num(t.liquidity);
  s.circSupply = num(t.circSupply);
  s.totalSupply = num(t.totalSupply);
  s.holders = num(t.holderCount);
  s.holderChange24h = num(t.stats24h?.holderChange);

  for (const [win, raw] of [
    ['5m', t.stats5m],
    ['1h', t.stats1h],
    ['6h', t.stats6h],
    ['24h', t.stats24h],
  ] as Array<[StatsWindow, JupStats | undefined]>) {
    const mapped = mapStats(raw);
    if (mapped) s.stats[win] = mapped;
  }

  // Jupiter does NOT expose bonding-curve progress (checked 2026-08-24) —
  // it comes from pump.fun's virtual reserves or our own curve math. The
  // field is read defensively in case it appears later.
  const curve = num(t.bondingCurve);
  s.bondingCurvePct = curve === null ? null : curve <= 1 ? curve * 100 : curve;
  s.poolAddress = t.graduatedPool ?? t.firstPool?.id ?? null;

  s.top10Pct = num(t.audit?.topHoldersPercentage);
  s.devHoldingPct = num(t.audit?.devBalancePercentage);
  s.creator = t.dev ?? null;
  // Cross-launchpad creator record. Null when Jupiter omits it — a dev
  // Jupiter has not counted is not a dev with zero launches.
  s.audit.devMints = num(t.audit?.devMints);
  s.audit.devMigrations = num(t.audit?.devMigrations);

  s.socials = {
    twitter: t.twitter ?? null,
    telegram: t.telegram ?? null,
    website: t.website ?? null,
    dexPaid: false, // DexScreener owns this field
  };

  s.sources = {
    price: 'jupiter',
    marketCap: 'jupiter',
    liquidity: 'jupiter',
    holders: 'jupiter',
    concentration: t.audit?.topHoldersPercentage === undefined ? 'none' : 'jupiter',
    socials: 'jupiter',
  };
  s.fetchedAt = Date.now();
  return s;
}

// ── Endpoints ─────────────────────────────────────────────────────────

const TTL_LIST = 6_000;
const TTL_TOKEN = 8_000;
/**
 * The slower lists (2026-09-20). `recent` and the two trending lists were
 * refetched on every 8 s Discover pass — three of the ~seven Jupiter calls
 * a pass made, against a host that turned out to serve ~60 a minute. The
 * newest launches are the scanner's business (sub-second, free); Jupiter's
 * copy of them can be twelve seconds old. Trending is "most traded over a
 * window of five minutes or more"; fifteen seconds does not change it.
 */
export const TTL_RECENT = 12_000;
export const TTL_TRENDING = 15_000;
/**
 * A LIST ROW's facts, remembered longer for the rows a Discover column
 * decorates with them (image, holders, volume, audit). The 8 s per-mint
 * memory above serves the token page, whose price may come from here on a
 * non-pump token and must not be a minute old; a card in a list of forty
 * can carry a holder count from 45 s ago. Written alongside the short key.
 */
export const TTL_ENRICH = 45_000;
/** A mint Jupiter did not return is not asked again for this long: a coin
 *  minutes old is not indexed yet, and asking on every pass was one batch
 *  per column per pass forever. */
export const TTL_ENRICH_NONE = 60_000;

/**
 * Every row any list or batch returns is also remembered PER MINT, so a
 * later single-mint `search` (the token page, the portfolio, the watchlist,
 * the orders poll) is answered from memory instead of a request. Before
 * 2026-09-06 a Discover refresh fetched the same forty mints Jupiter had
 * just listed, and a portfolio of thirty mints was thirty searches every
 * twenty seconds — ~180 calls a minute for facts already in hand.
 */
const tokenKey = (mint: string): string => `jup:tok:${mint}`;
const enrichKey = (mint: string): string => `jup:enrich:${mint}`;
const enrichNoneKey = (mint: string): string => `jup:enrich:none:${mint}`;

function rememberTokens(rows: JupToken[]): void {
  for (const t of rows) {
    if (!t?.id) continue;
    putCache(tokenKey(t.id), t, TTL_TOKEN);
    putCache(enrichKey(t.id), t, TTL_ENRICH);
  }
}

/** A bare mint address (base58, 32–44 chars) rather than free text. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Merge the batch requests that arrive close together into ONE.
 *
 * Measured 2026-09-20 with route counters: Shield was Jupiter's most-called
 * route (58 of 141 in four minutes) and the enrichment batch the second
 * (32), because four Discover columns each asked for their own rows within
 * a second or two of each other, and each column's batch is a request
 * however many mints it holds. A column's rows arrive at most this window
 * later, on a pass that already spends two seconds on the rug rules; the
 * request count is what matters, and the union costs one.
 *
 * The priority lane (the orders poll) never waits here.
 */
export const COALESCE_MS = 1_500;

function coalescer<T>(run: (mints: string[]) => Promise<Map<string, T>>): (mints: string[]) => Promise<Map<string, T>> {
  let pending = new Set<string>();
  let waiters: Array<{ resolve: (m: Map<string, T>) => void; reject: (e: unknown) => void }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (mints) =>
    new Promise<Map<string, T>>((resolve, reject) => {
      for (const m of mints) pending.add(m);
      waiters.push({ resolve, reject });
      if (timer) return;
      timer = setTimeout(() => {
        const batch = [...pending];
        const ws = waiters;
        pending = new Set();
        waiters = [];
        timer = null;
        run(batch).then(
          (r) => ws.forEach((w) => w.resolve(r)),
          (e) => ws.forEach((w) => w.reject(e)),
        );
      }, COALESCE_MS);
    });
}

async function list(path: string, key: string, ttl: number, opts: { priority?: boolean } = {}): Promise<JupToken[]> {
  const hit = await memo<JupToken[]>(key, ttl, async () => {
    const r = await getJson<JupToken[]>('jupiter', path, opts.priority ? { priority: true } : {});
    if (!r.ok || !Array.isArray(r.data)) return null;
    rememberTokens(r.data);
    return r.data;
  });
  return hit ?? [];
}

/** Newest mints Jupiter has indexed. Powers the NEW column's non-pump rows. */
export function recent(limit = 40): Promise<JupToken[]> {
  return list(`/tokens/v2/recent?limit=${Math.min(100, Math.max(1, limit))}`, `jup:recent:${limit}`, TTL_RECENT);
}

/** Most-traded over a window. Powers TRENDING. */
export function topTraded(window: '5m' | '1h' | '6h' | '24h', limit = 40): Promise<JupToken[]> {
  return list(
    `/tokens/v2/toptraded/${window}?limit=${Math.min(100, Math.max(1, limit))}`,
    `jup:toptraded:${window}:${limit}`,
    TTL_TRENDING,
  );
}

/** Highest organic (wash-filtered) score. The quality half of TRENDING. */
export function topOrganic(window: '5m' | '1h' | '6h' | '24h', limit = 40): Promise<JupToken[]> {
  return list(
    `/tokens/v2/toporganicscore/${window}?limit=${Math.min(100, Math.max(1, limit))}`,
    `jup:toporganic:${window}:${limit}`,
    TTL_TRENDING,
  );
}

/** Free-text or mint search. Also the cheapest way to enrich a known mint. */
export function search(query: string): Promise<JupToken[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return Promise.resolve([]);
  // A mint a list or batch already returned is answered from memory.
  if (MINT_RE.test(q)) {
    const known = cached<JupToken>(tokenKey(q));
    if (known) return Promise.resolve([known]);
  }
  return list(`/tokens/v2/search?query=${encodeURIComponent(q)}`, `jup:search:${q}`, TTL_TOKEN);
}

/**
 * Enrich up to 100 mints in ONE request. `search` accepts a comma-separated
 * list of addresses, which is how a Discover column of pump.fun rows gets
 * holder counts and audit flags without 40 separate calls.
 *
 * Only the mints NOT already in the per-mint memory are requested, and the
 * batch is keyed by its exact (sorted) membership. The old key — first mint
 * plus count — missed on every refresh of a column whose newest row had
 * changed (so the whole page was re-fetched every four seconds) and could
 * answer one set's rows for another set that happened to share its first
 * mint and length.
 */
export async function byMints(mints: string[], opts: { priority?: boolean; enrich?: boolean } = {}): Promise<Map<string, JupToken>> {
  const out = new Map<string, JupToken>();
  const unique = [...new Set(mints.filter(Boolean))];
  const misses: string[] = [];
  for (const m of unique) {
    // Decoration accepts the longer memory, and skips a mint Jupiter did
    // not know a minute ago; a price path takes only the short one.
    const known = cached<JupToken>(tokenKey(m)) ?? (opts.enrich ? cached<JupToken>(enrichKey(m)) : null);
    if (known) out.set(m, known);
    else if (!(opts.enrich && cached<boolean>(enrichNoneKey(m)))) misses.push(m);
  }
  if (!misses.length) return out;
  // Decoration waits for the merge window; a price path fetches now.
  const fetched = opts.enrich && !opts.priority ? await enrichBatches(misses) : await fetchBatches(misses, opts);
  for (const m of misses) {
    const t = fetched.get(m);
    if (t) out.set(m, t);
  }
  return out;
}

/** The chunked batch fetch itself: up to 100 mints per request. */
async function fetchBatches(mints: string[], opts: { priority?: boolean; enrich?: boolean } = {}): Promise<Map<string, JupToken>> {
  const out = new Map<string, JupToken>();
  const misses = [...new Set(mints)].sort();
  for (let i = 0; i < misses.length; i += 100) {
    const batch = misses.slice(i, i + 100);
    const rows = await list(
      `/tokens/v2/search?query=${encodeURIComponent(batch.join(','))}`,
      `jup:batch:${batch.join(',')}`,
      TTL_TOKEN,
      opts,
    );
    const got = new Set<string>();
    for (const t of rows) {
      if (!t?.id) continue;
      out.set(t.id, t);
      got.add(t.id);
    }
    // Only when the route ANSWERED: an empty answer for a batch is "none of
    // these are indexed", a failed request is nothing at all.
    if (opts.enrich && rows.length) for (const m of batch) if (!got.has(m)) putCache(enrichNoneKey(m), true, TTL_ENRICH_NONE);
  }
  return out;
}

const enrichBatches = coalescer<JupToken>((mints) => fetchBatches(mints, { enrich: true }));

/** USD price for arbitrary mints — used for the SOL/USD conversion. */
export async function prices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(mints.filter(Boolean))].slice(0, 50);
  if (!unique.length) return out;
  const r = await getJson<Record<string, { usdPrice?: number }>>(
    'jupiter',
    `/price/v3?ids=${unique.join(',')}`,
  );
  if (!r.ok || !r.data) return out;
  for (const [mint, v] of Object.entries(r.data)) {
    const p = num(v?.usdPrice);
    if (p !== null) out.set(mint, p);
  }
  return out;
}

// ── Shield ────────────────────────────────────────────────────────────

export interface ShieldVerdict {
  /** True on a NOT_SELLABLE warning; false on a 200 without one; null when
   *  Shield did not answer — silence is not "sellable". */
  notSellable: boolean | null;
  /** Warning types as Jupiter names them (NOT_VERIFIED, NEW_LISTING, ...). */
  warnings: string[];
}

interface ShieldWarning {
  type?: string;
  message?: string;
  severity?: string;
}

/** A Shield verdict changes rarely; two minutes on a LIST row (2026-09-20).
 *  The token page's own security report re-reads the chain for the facts
 *  that decide a sale; this badge is a warning label, not the gate. */
export const TTL_SHIELD = 120_000;

/**
 * Jupiter Shield — per-mint warnings, batched up to 100 per call. Verified
 * 2026-08-30: ~300 ms for 6 mints; NOT_SELLABLE is `critical`, the rest
 * (NOT_VERIFIED, LOW_ORGANIC_ACTIVITY, NEW_LISTING) are `info`.
 *
 * A 200 answers for EVERY requested mint: one absent from the map has no
 * warnings. A non-200 answers for none, and every mint gets null.
 */
export async function shield(mints: string[], opts: { priority?: boolean } = {}): Promise<Map<string, ShieldVerdict>> {
  const out = new Map<string, ShieldVerdict>();
  const unique = [...new Set(mints.filter(Boolean))];
  // Per-mint memory first (same reasoning as byMints): a Discover page
  // whose row set shifted by one mint asked Shield about all forty again.
  const misses: string[] = [];
  for (const m of unique) {
    const known = cached<ShieldVerdict>(`jup:shieldv:${m}`);
    if (known) out.set(m, known);
    else misses.push(m);
  }
  if (!misses.length) return out;
  const fetched = opts.priority ? await fetchShield(misses, opts) : await shieldBatches(misses);
  for (const m of misses) {
    const v = fetched.get(m);
    if (v) out.set(m, v);
  }
  return out;
}

async function fetchShield(mints: string[], opts: { priority?: boolean } = {}): Promise<Map<string, ShieldVerdict>> {
  const out = new Map<string, ShieldVerdict>();
  const misses = [...new Set(mints)].sort();
  for (let i = 0; i < misses.length; i += 100) {
    const batch = misses.slice(i, i + 100);
    const hit = await memo<Record<string, ShieldWarning[]>>(`jup:shield:${batch.join(',')}`, TTL_SHIELD, async () => {
      const r = await getJson<{ warnings?: Record<string, ShieldWarning[]> }>(
        'jupiter',
        `/ultra/v1/shield?mints=${encodeURIComponent(batch.join(','))}`,
        opts.priority ? { priority: true } : {},
      );
      if (!r.ok || !r.data || typeof r.data !== 'object') return null;
      const w = r.data.warnings;
      // `warnings: {}` means Shield looked and found nothing — a real pass.
      // A response with NO `warnings` key at all means Shield did not answer,
      // and falling back to `{}` there turned every such mint into
      // "Sellable — PASS", cached per mint. A 200 that omits the field is a
      // polite refusal, not a clean bill of health: report it as unknown.
      if (!w || typeof w !== 'object') return null;
      return w;
    });
    for (const m of batch) {
      if (!hit) {
        out.set(m, { notSellable: null, warnings: [] });
        continue;
      }
      const list = Array.isArray(hit[m]) ? hit[m] : [];
      const types = list.map((x) => (typeof x?.type === 'string' ? x.type : '')).filter(Boolean);
      const verdict = { notSellable: types.includes('NOT_SELLABLE'), warnings: types };
      putCache(`jup:shieldv:${m}`, verdict, TTL_SHIELD);
      out.set(m, verdict);
    }
  }
  return out;
}

const shieldBatches = coalescer<ShieldVerdict>((mints) => fetchShield(mints));

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** SOL/USD, cached for 20s. Every SOL-denominated display depends on it. */
export async function solUsd(): Promise<number | null> {
  return memo<number>('jup:solusd', 20_000, async () => {
    const p = await prices([WSOL_MINT]);
    return p.get(WSOL_MINT) ?? null;
  });
}
