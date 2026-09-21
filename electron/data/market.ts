// Market orchestrator — assembles one honest row out of many disagreeing
// sources, and is the ONLY module the IPC layer talks to.
//
// The merge rule, in priority order, is the whole design:
//
//   1. our own chain read      (onchain.ts)      — authoritative
//   2. our own live tape       (tape.ts)         — authoritative, session-scoped
//   3. the source that is best at that specific field
//   4. null
//
// Rule 4 is the one that makes this honest. Where nothing answered, the
// field stays null and the UI prints an em dash. It never falls through to
// zero, and it never falls through to a stale value from a different token.
//
// Every field a user can trade on carries `sources[...]` so the UI can say
// where the number came from on hover. A terminal that shows a market cap
// without saying whether it came from the chain or from a cached index is
// asking the user to trust it — and this product's entire position is that
// it does not ask for trust.

import {
  builtinPresets,
  DEFAULT_DATA_SETTINGS,
  describeSocials,
  emptySummary,
  holderPct,
  passesFilters,
  quickScore as quickScoreShared,
  scoreChecks,
  securityChecks,
  type Candle,
  type CandleInterval,
  type CandleSeries,
  type DataSettings,
  type DiscoverColumn,
  type CreatorRecord,
  type DataSource,
  type DescriptiveFacts,
  type DiscoverFilters,
  type HolderReport,
  type HolderRow,
  type HolderTag,
  type ProviderId,
  type ProviderStatus,
  type SecurityFacts,
  type StatsWindow,
  type SecurityReport,
  type TokenDetail,
  type TokenPool,
  type TokenSummary,
  type TradeRow,
  type TraderScanRow,
  humanWait,
} from '@shared/market';
import {
  cached,
  cooldownRemainingMs,
  parkIsQuota,
  memo,
  providerHost,
  putCache,
  queueDepth,
  setJupiterKeySource,
  telemetry,
  windowUsage,
} from './http';
import * as jup from './providers/jupiter';
import * as ds from './providers/dexscreener';
import * as pf from './providers/pumpfun';
import * as gt from './providers/geckoterminal';
import * as rc from './providers/rugcheck';
import { NO_EDGE_NOTE, type RugReport, type VolatilityNote } from '@shared/rugrules';
import type { OddsReport } from '@shared/odds';
import * as li from './launchIntel';
import * as launchLab from './launchLabAccounts';
import * as boop from './boopAccounts';
import {
  creatorVerdict,
  emptyAnalysis,
  SNIPER_WINDOW_SLOTS,
  type CreatorHistory,
  type LaunchIntelReport,
} from '@shared/launchintel';
import * as dbcAccounts from './dbcAccounts';
import * as holderGraph from './holderGraph';
import * as be from './providers/birdeye';
import * as onchain from './onchain';
import * as pumpChain from './pumpChain';
// A leaf module (global fetch, no imports of ours) — no cycle through data/.
import { fetchMetadataLinks, metadataLinksIfCached, type MetadataLinks } from '../engine/metadata';
import type { LiveCurve, LiveMigration } from '../engine/liveCurves';
import * as tape from './tape';
import { mergeLiveLaunches, summaryFromLaunch, PUMP_TOTAL_SUPPLY } from '@shared/liveRows';
import { mergeLivePools, type LiveAmmPool } from '@shared/raydium';
import type { LaunchRow } from '@shared/types';

// ── Host context ──────────────────────────────────────────────────────
//
// Everything the orchestrator needs from the engine, as a narrow interface
// so `data/` never imports the engine (which would be a cycle: the engine
// imports the tape, the tape is read from here).

export interface TerminalContext {
  httpUrl(): string;
  data(): DataSettings;
  /** Helius key from RPC settings, reused rather than asked for twice. */
  heliusKey(): string;
  /** Local creator DB — only counts launches THIS install observed. */
  creatorIntel(creator: string): { priorLaunches: number; priorRugs: number; blacklisted: boolean } | null;
  /** Smart-money watchlist: address → label. */
  walletLabel(address: string): string | null;
  /** Mints the engine currently has live state for. */
  isLiveTracked(mint: string): boolean;
  /**
   * Launches the scanner has decoded off the websocket, newest first.
   *
   * A second source for the New column, alongside the providers: free,
   * sub-second, and unaffected by a park - see shared/liveRows.ts. Empty
   * when the scanner is not running, which is the honest answer, because
   * then the app is not watching the feed and knows of no launches.
   */
  liveLaunches(limit: number): LaunchRow[];
  /** The scanner's row for ONE mint, when it is tracking it — the name,
   *  creator and detection time a summary would otherwise buy. Optional so a
   *  call-count harness built before it existed still attaches. */
  liveLaunch?(mint: string): LaunchRow | null;
  /** Register a PumpSwap pool so AMM swaps for it reach the tape. */
  registerPool(pool: string, mint: string): void;
  /**
   * Tape a pump.fun mint (curve or PumpSwap) for the token page. Independent
   * of the launch scanner: the engine points its per-mint socket at the mint
   * whether or not the scanner is running — see engine.watchPumpMint.
   */
  watchPumpMint(mint: string): void;
  unwatchPumpMint(mint: string): void;
  /**
   * Start/stop taping a Meteora DBC pool. DBC events are emit_cpi! and
   * invisible to logsSubscribe, so they need a dedicated per-pool watcher
   * rather than the shared program feed — see dbcWatcher.ts.
   */
  /** `poolHint` is the pool the providers already named for this mint; the
   *  engine confirms whether it is actually a DBC curve with ONE account
   *  read rather than scanning transaction history. */
  watchDbcPool(mint: string, decimals: number, poolHint: string | null): void;
  unwatchDbcPool(mint: string): void;
  /** LaunchLab needs only the mint: its pool is a PDA and its events are logs. */
  watchLaunchLabPool(mint: string, decimals: number, poolHint: string | null): void;
  unwatchLaunchLabPool(mint: string): void;
  /** Boop needs only the mint — its events name it. */
  watchBoop(mint: string, decimals: number): void;
  unwatchBoop(mint: string): void;
  /**
   * Start/stop taping a Raydium AMM v4 / CPMM pool. The engine reads the
   * pool's owner once and refuses anything that is not one of the two, or
   * that has no SOL side — see raydiumWatcher.ts.
   */
  watchRaydiumPool(mint: string, poolHint: string | null): void;
  unwatchRaydiumPool(mint: string): void;
  /**
   * Raydium pools the engine saw created, newest first — a second source
   * for the Migrated column, seconds ahead of any indexer and unaffected
   * by a park. Empty while the scanner is off. See shared/raydium.ts.
   */
  livePools(limit: number): LiveAmmPool[];
  /**
   * The program feed's own books (engine/liveCurves.ts), the Discover
   * columns' free source while the scanner runs: every pump curve trading
   * right now ranked by progress, and every migration seen, newest first.
   * Both empty when the scanner is stopped — `scannerRunning` says which.
   * Optional so a call-count harness built before them still attaches.
   */
  scannerRunning?(): boolean;
  liveCurves?(limit: number): LiveCurve[];
  liveMigrations?(limit: number): LiveMigration[];
}

let ctx: TerminalContext | null = null;

export function attach(c: TerminalContext): void {
  ctx = c;
  // Jupiter's host, gap and window all follow whether the user has pasted a
  // key. It is PULLED from settings rather than pushed in, so registering
  // the accessor once here is the whole wiring and it can never go stale.
  setJupiterKeySource(() => c.data().jupiterApiKey ?? '');
}

function need(): TerminalContext {
  if (!ctx) throw new Error('market: context not attached');
  return ctx;
}

// ── Provider gating ───────────────────────────────────────────────────

const PROVIDER_META: Record<ProviderId, { label: string; keyless: boolean; provides: string }> = {
  jupiter: {
    label: 'Jupiter',
    keyless: true,
    provides: 'Prices, market cap, liquidity, holder counts, buy/sell counts, dev + top-holder audit',
  },
  dexscreener: {
    label: 'DexScreener',
    keyless: true,
    provides: 'Trading pools, socials, DEX-paid status',
  },
  pumpfun: {
    label: 'pump.fun',
    keyless: true,
    provides: 'New + graduating + migrated feeds, bonding-curve reserves',
  },
  geckoterminal: {
    label: 'GeckoTerminal',
    keyless: true,
    provides: 'Price candles from 1 minute upward',
  },
  pumpswap: {
    label: 'pump.fun swap API',
    keyless: true,
    provides: 'Historical trades — launch bundle + sniper analysis for any pump mint',
  },
  birdeye: {
    label: 'Birdeye',
    keyless: false,
    provides: 'Sub-minute candles, full holder lists, historical trades (needs your API key)',
  },
  helius: {
    label: 'Helius',
    keyless: false,
    provides: 'Faster RPC for on-chain reads (uses the key already in RPC settings)',
  },
  rugcheck: {
    label: 'RugCheck',
    keyless: true,
    provides: 'Creator rug history, insider transfer clusters, keyless top holders (summary routes only)',
  },
};

function usable(id: ProviderId): boolean {
  if (!ctx) return false;
  const d = ctx.data();
  if (!d.networkDataEnabled) return false;
  // Settings saved before a provider existed have no entry for it; the
  // shipped default decides rather than a missing key silently disabling it.
  if (!(d.providers[id] ?? DEFAULT_DATA_SETTINGS.providers[id])) return false;
  if (id === 'birdeye') return d.birdeyeApiKey.trim().length > 0;
  if (id === 'helius') return ctx.heliusKey().trim().length > 0;
  return true;
}

/**
 * Warm the handful of provider calls every Discover column blocks on, while
 * the window is still painting.
 *
 * GeckoTerminal is queued at one request every 2.1 s (data/http.ts), so the
 * four listings the columns share come back roughly 2, 4, 6 and 8 seconds
 * after the first one is asked for — and today nothing asks until React has
 * mounted and the columns stagger themselves. Asking at boot moves that whole
 * ladder earlier; the in-flight dedupe in `memo` means the renderer's own
 * call joins the same promise rather than queueing a second time, and every
 * TTL here (45-60 s) outlives the boot window.
 *
 * It goes through `usable()`, so the master data switch AND the per-provider
 * toggles both hold — a user who turned GeckoTerminal off must not see this
 * make requests to it. Fire-and-forget: a failure here is a cold cache, not
 * an error.
 */
export function prewarmDiscover(): void {
  if (!ctx || !ctx.data().networkDataEnabled) return;
  const swallow = (p: Promise<unknown>): void => void p.catch(() => undefined);
  if (usable('jupiter')) swallow(jup.solUsd());
  if (usable('geckoterminal')) {
    // Same argument lists the columns use, so these are the same memo keys.
    swallow(gt.poolsForDex('raydium-launchlab', 1));
    swallow(gt.poolsForDex('boop-fun', 1));
    swallow(gt.poolsForDex('meteora-dbc', 1));
    swallow(gt.newPools(1));
  }
}

export function providerStatuses(): ProviderStatus[] {
  const d = ctx?.data();
  return (Object.keys(PROVIDER_META) as ProviderId[]).map((id) => {
    const meta = PROVIDER_META[id];
    const t = telemetry(id);
    return {
      id,
      label: meta.label,
      host: providerHost(id),
      keyless: meta.keyless,
      enabled: d ? d.networkDataEnabled && (d.providers[id] ?? DEFAULT_DATA_SETTINGS.providers[id]) : false,
      usable: usable(id),
      provides: meta.provides,
      calls: t.calls,
      errors: t.errors,
      lastError: t.lastError,
      lastCallAt: t.lastCallAt,
      latencyMs: t.latencyMs,
      cooldownMs: cooldownRemainingMs(id),
      // A spent plan and a throttle need different words: one waits, the
      // other needs the user to do something.
      cooldownIsQuota: parkIsQuota(id),
      queued: queueDepth(id),
      routes: t.routes.slice(0, 12),
      ...(() => {
        const w = windowUsage(id);
        return w ? { minuteUsed: w.used, minuteCap: w.n } : {};
      })(),
    };
  });
}

/**
 * One line naming the parked providers among `only` (default: all) and when
 * each is asked again, or '' when none is. Carried back as a result's
 * message so the renderer can say "rate limited" instead of showing an
 * empty list under a fresh "2s ago" stamp.
 */
export function parkNote(only?: ProviderId[]): string {
  const parked = parkedProviders().filter((id) => !only || only.includes(id));
  if (!parked.length) return '';
  const parts = parked.map((id) =>
    parkIsQuota(id)
      ? `${PROVIDER_META[id].label} (no allowance left)`
      : `${PROVIDER_META[id].label} (retrying in ${humanWait(cooldownRemainingMs(id))})`,
  );
  return `Rate limited by ${parts.join(', ')}.`;
}

/**
 * The providers a Discover column's ROWS come from. The intel providers
 * (swap-api seeks, RugCheck, DexScreener, Birdeye) only decorate rows with
 * badges, and a badge that lags is not a stale column — a swap-api park used
 * to stamp "showing the last good rows" on all four columns while every row
 * in them was fresh (2026-09-06).
 */
const COLUMN_ROW_SOURCES: Record<DiscoverColumn, ProviderId[]> = {
  new: ['pumpfun', 'jupiter', 'geckoterminal'],
  graduating: ['pumpfun', 'geckoterminal'],
  migrated: ['pumpfun', 'geckoterminal'],
  trending: ['jupiter'],
};

/**
 * Which row providers each column ASKED on its last pass. With the scanner
 * running, the New, Graduating and Migrated columns take their pump rows
 * from the feed and never ask pump.fun — so a parked pump.fun is not their
 * problem and must not be stamped on them (2026-09-20: it was, on all three,
 * for as long as the host kept 429ing, over rows that were entirely fresh).
 * A column that has not run yet falls back to the static table.
 */
const askedByColumn = new Map<DiscoverColumn, ProviderId[]>();

export function discoverParkNote(column: DiscoverColumn): string {
  return parkNote(askedByColumn.get(column) ?? COLUMN_ROW_SOURCES[column]);
}

// ── Merge helpers ─────────────────────────────────────────────────────

const pick = <T>(...vals: Array<T | null | undefined>): T | null => {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return null;
};

/**
 * Fold `patch` into `base`, keeping whatever `base` already knows.
 * Deliberately NOT a spread: a provider returning null for a field must not
 * erase a better provider's answer.
 */
function merge(base: TokenSummary, patch: TokenSummary): TokenSummary {
  const out: TokenSummary = { ...base };
  out.name = base.name || patch.name;
  out.symbol = base.symbol || patch.symbol;
  out.imageUrl = pick(base.imageUrl, patch.imageUrl);
  out.decimals = base.decimals ?? patch.decimals;
  out.createdAt = pick(base.createdAt, patch.createdAt);
  if (base.launchpad === 'unknown') out.launchpad = patch.launchpad;

  out.priceUsd = pick(base.priceUsd, patch.priceUsd);
  out.priceSol = pick(base.priceSol, patch.priceSol);
  out.marketCapUsd = pick(base.marketCapUsd, patch.marketCapUsd);
  out.fdvUsd = pick(base.fdvUsd, patch.fdvUsd);
  out.liquidityUsd = pick(base.liquidityUsd, patch.liquidityUsd);
  out.circSupply = pick(base.circSupply, patch.circSupply);
  out.totalSupply = pick(base.totalSupply, patch.totalSupply);
  out.holders = pick(base.holders, patch.holders);
  out.holderChange24h = pick(base.holderChange24h, patch.holderChange24h);
  out.bondingCurvePct = pick(base.bondingCurvePct, patch.bondingCurvePct);
  out.poolAddress = pick(base.poolAddress, patch.poolAddress);
  out.poolQuoteMint = pick(base.poolQuoteMint, patch.poolQuoteMint);
  out.dexId = pick(base.dexId, patch.dexId);
  out.devHoldingPct = pick(base.devHoldingPct, patch.devHoldingPct);
  out.top10Pct = pick(base.top10Pct, patch.top10Pct);
  out.sniperPct = pick(base.sniperPct, patch.sniperPct);
  out.insiderPct = pick(base.insiderPct, patch.insiderPct);
  out.bundledPct = pick(base.bundledPct, patch.bundledPct);
  out.smartHolders = pick(base.smartHolders, patch.smartHolders);
  out.creator = pick(base.creator, patch.creator);

  out.socials = {
    twitter: pick(base.socials.twitter, patch.socials.twitter),
    telegram: pick(base.socials.telegram, patch.socials.telegram),
    website: pick(base.socials.website, patch.socials.website),
    dexPaid: base.socials.dexPaid || patch.socials.dexPaid,
  };

  out.rug = base.rug ?? patch.rug;
  out.volatility = base.volatility.length ? base.volatility : patch.volatility;
  out.odds = base.odds ?? patch.odds;
  out.audit = {
    devMints: pick(base.audit.devMints, patch.audit.devMints),
    devMigrations: pick(base.audit.devMigrations, patch.audit.devMigrations),
    notSellable: pick(base.audit.notSellable, patch.audit.notSellable),
    shieldWarnings: base.audit.shieldWarnings.length ? base.audit.shieldWarnings : patch.audit.shieldWarnings,
    isBanned: pick(base.audit.isBanned, patch.audit.isBanned),
    nsfw: pick(base.audit.nsfw, patch.audit.nsfw),
    kingOfTheHillAt: pick(base.audit.kingOfTheHillAt, patch.audit.kingOfTheHillAt),
    athMarketCapUsd: pick(base.audit.athMarketCapUsd, patch.audit.athMarketCapUsd),
  };

  out.stats = { ...patch.stats, ...base.stats };
  out.sources = { ...patch.sources, ...base.sources };
  out.fetchedAt = Math.max(base.fetchedAt, patch.fetchedAt);
  return out;
}

/**
 * Attach the parts only THIS install can know. Always runs last.
 *
 * `liveTracked` means "we are receiving this token's trades ourselves". A
 * tape SUBSCRIPTION is not enough — opening a token page subscribes it, but
 * with the engine stopped no trade ever arrives, and a green "live" dot over
 * a dead feed is the worst kind of wrong. So it requires either the engine
 * actively tracking the mint, or ticks actually in the tape.
 */
function localise(s: TokenSummary): TokenSummary {
  const c = need();
  s.liveTracked = c.isLiveTracked(s.mint) || tape.hasTicks(s.mint);
  if (s.liveTracked) s.sources.price = 'engine';
  // A pump.fun token's supply is a property of the LAUNCHPAD: 1,000,000,000
  // with no mint authority, before and after graduation. Without it the live
  // market cap cannot be computed at all - the header freezes on whatever
  // number the provider last sent while the price beside it moves on every
  // tick - and the provider that serves the supply is the same one most
  // likely to be throttled. This is not a guess standing in for a fact; the
  // fact is the same for every coin on the rail, and an API figure always
  // wins when there is one.
  if (s.launchpad === 'pumpfun') {
    if (s.totalSupply === null) s.totalSupply = PUMP_TOTAL_SUPPLY;
    if (s.circSupply === null) s.circSupply = PUMP_TOTAL_SUPPLY;
  }
  return s;
}

/**
 * Majors and stablecoins are excluded from TRENDING.
 *
 * Jupiter's "most traded" is honest and useless here: SOL, USDC and USDT are
 * always the most traded things on Solana, so an unfiltered trending column
 * is three stablecoins and a wrapper. This is a memecoin terminal; anyone
 * who wants USDC can paste the mint.
 */
const TRENDING_EXCLUDE = new Set<string>([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',  // jupSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', // FARTCOIN (major, not new)
]);

// ── Krypt score ───────────────────────────────────────────────────────
//
// The score is a WEIGHTED AVERAGE OVER THE GATES THAT RESOLVED, not a sum
// with unknowns treated as zero. A brand-new mint where only three gates
// answered scores on those three and reports `checksResolved: 3` — because
// scoring an unknown as a failure would rate every fresh launch as a rug,
// and scoring it as a pass would rate every fresh launch as safe. Both are
// lies; the honest output is "3 of 10 checks answered".
//
// What is a gate and what is a fact was decided by measurement
// (docs/rug-filter-2026-08-30.md §4, §9): dev %, top-10, top-20, bundled %
// and sniper % all have lift < 1 for "dead or dumped" and together hide
// 57 % of graduations, so they are weightless facts that show a number.
// The gates are the things that actually stop a sale or name a repeat
// offender: sellability, creator rug history, transfer clusters, launch
// factories, pump.fun bans, plus the chain reads. The rule logic itself is
// pure and lives in shared/market.ts so the tests can pin it.

type RugIntel = { rug: RugReport | null; volatility: VolatilityNote[]; top3Pct: number | null };
/** Jupiter's cross-launchpad creator counts, off the row we already have. */
type DevRecord = { mints: number | null; migrations: number | null };
interface RugIntelApi {
  rugReportFor(
    mint: string,
    opts?: { creator?: string | null; createdAt?: number | null; dev?: DevRecord; creatorLookup?: boolean; buyCoin?: boolean },
  ): Promise<RugIntel | null>;
  oddsFor(mint: string, opts?: { creator?: string | null; createdAt?: number | null; buyCoin?: boolean }): Promise<OddsReport | null>;
}

/** The creator record every row already carries, for free, from Jupiter's
 *  batched audit block — see providers/jupiter.ts `toSummary`. */
const devRecordOf = (s: TokenSummary): DevRecord => ({
  mints: s.audit.devMints,
  migrations: s.audit.devMigrations,
});

/**
 * The measured rug rules for a pump launch, from launchIntel. Guarded so a
 * build in which that module has not landed the function — or throws —
 * degrades to "no report" rather than taking the security panel down.
 */
async function rugReportSafe(
  mint: string,
  creator: string | null,
  createdAt: number | null = null,
  opts: { dev?: DevRecord; creatorLookup?: boolean; buyCoin?: boolean } = {},
): Promise<RugIntel | null> {
  if (!usable('pumpswap')) return null;
  try {
    const api = li as unknown as Partial<RugIntelApi>;
    if (typeof api.rugReportFor !== 'function') return null;
    return (await api.rugReportFor(mint, { creator, createdAt, ...opts })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Graduation odds for a pump launch, from launchIntel. Guarded the same way:
 * a missing or throwing `oddsFor` is "no odds", never a broken panel.
 */
async function oddsSafe(mint: string, creator: string | null, createdAt: number | null = null, opts: { buyCoin?: boolean } = {}): Promise<OddsReport | null> {
  if (!usable('pumpswap')) return null;
  try {
    const api = li as unknown as Partial<RugIntelApi>;
    if (typeof api.oddsFor !== 'function') return null;
    return (await api.oddsFor(mint, { creator, createdAt, ...opts })) ?? null;
  } catch {
    return null;
  }
}

/**
 * `onchain.topHolders`, memoised.
 *
 * It costs `getTokenSupply` + `getTokenLargestAccounts`, and the second is
 * the ONE method the public RPC refuses hardest (documented budget 0, and
 * its refusal parks the whole host). Opening a token page ran it three
 * times — the security report, the holders panel and the holder graph each
 * asked independently. The memo lives here rather than in onchain.ts
 * because that module is deliberately a thin, uncached chain reader.
 *
 * Short TTL: holder concentration is a fact people trade on, so this buys
 * one page load's worth of sharing, not a stale panel.
 */
const HOLDERS_TTL_MS = 10_000;

async function topHoldersMemo(httpUrl: string, mint: string): Promise<HolderReport> {
  const hit = await memo<HolderReport>(`market:topholders:${mint}`, HOLDERS_TTL_MS, async () =>
    onchain.topHolders(httpUrl, mint, { resolveOwners: true }),
  );
  if (!hit) return { mint, totalSupply: null, holderCount: null, rows: [], source: 'onchain', note: null };
  // Callers tag and sort rows in place, so each gets its own copy — a shared
  // array would accumulate every caller's tags and every caller's sort.
  return { ...hit, rows: hit.rows.map((r) => ({ ...r, tags: [...r.tags] })) };
}

export async function securityReport(mint: string, summary: TokenSummary): Promise<SecurityReport> {
  const c = need();
  const httpUrl = c.httpUrl();
  const creator = summary.creator;
  const pumpRail = summary.launchpad === 'pumpfun';

  // Launch intel is memoised on the same key the dedicated panel uses, so the
  // report and the panel share one fetch rather than paying for it twice.
  // Every external answer here is optional: a provider that is off or silent
  // leaves its gate 'unknown' with a detail that says so.
  const [facts, holdersRaw, intel, rcSummary, rcNets, shieldMap, dsOrders, history, rugIntel, odds] = await Promise.all([
    onchain.mintFacts(httpUrl, mint),
    topHoldersMemo(httpUrl, mint),
    usable('pumpswap') ? li.launchIntel(mint, httpUrl) : Promise.resolve(null),
    usable('rugcheck') ? rc.summary(mint) : Promise.resolve(null),
    usable('rugcheck') ? rc.insiderNetworks(mint) : Promise.resolve(null),
    usable('jupiter') ? jup.shield([mint]) : Promise.resolve(null),
    usable('dexscreener') ? ds.orders(mint) : Promise.resolve(null),
    creator && usable('pumpfun') ? li.creatorHistory(creator) : Promise.resolve(null),
    // Single mint, so both creator floors are affordable: Jupiter's counts
    // off the summary, plus the pump.fun history — which is the very fetch
    // three lines up, joined through the same 120 s memo, not a second one.
    pumpRail ? rugReportSafe(mint, creator, null, { dev: devRecordOf(summary) }) : Promise.resolve(null),
    pumpRail ? oddsSafe(mint, creator) : Promise.resolve(null),
  ]);

  // Holders: the chain first; RugCheck's keyless list when the public RPC
  // refused the call (it 429s getTokenLargestAccounts specifically).
  let holders = holdersRaw;
  if (holders.source === 'none' && usable('rugcheck')) {
    const fb = await rc.holdersFallback(mint, summary.totalSupply);
    if (fb) holders = fb;
  }

  const top10Chain = onchain.concentration(holders.rows, 10);
  const top20 = onchain.concentration(holders.rows, 20);
  let top10 = top10Chain ?? summary.top10Pct;
  let concSource: DataSource =
    top10Chain !== null ? (holders.source === 'rugcheck' ? 'rugcheck' : 'onchain') : summary.sources.concentration ?? 'none';

  // Last keyless resort for concentration: GeckoTerminal's token/info route,
  // which carries a holder count and a top-10 share and needs no key at all.
  // It was already implemented here and called only from the EVM rail, which
  // is why "holder features need a Helius key" was over-stated (api swarm
  // 2026-09-09 §3). Asked ONLY when the chain and RugCheck both came back
  // with nothing and Jupiter had no audit share either — GeckoTerminal's
  // budget is 30 calls a minute and the chart lives on it.
  if (top10 === null && usable('geckoterminal')) {
    const gtInfo = await gt.tokenInfoOn('solana', mint).catch(() => null);
    if (gtInfo?.top10Pct !== null && gtInfo?.top10Pct !== undefined) {
      top10 = gtInfo.top10Pct;
      // Provenance stays exact: this number is GeckoTerminal's, and the
      // panel says so rather than borrowing the chain's authority.
      concSource = 'geckoterminal';
    }
  }

  const local = creator ? c.creatorIntel(creator) : null;

  // The launch tape this install recorded live still wins where it exists: it
  // is our own measurement. The retroactive scan fills in every other token.
  const launch = intel?.analysis ?? null;
  const bundledPct = summary.bundledPct ?? launch?.bundle.boughtPct ?? null;
  const sniperPct = summary.sniperPct ?? launch?.snipers.boughtPct ?? null;
  const bundledHeldPct = launch?.bundle.heldPct ?? null;
  const sniperHeldPct = launch?.snipers.heldPct ?? null;
  const launchSource: DataSource =
    summary.bundledPct !== null ? 'engine' : launch && launch.bundle.boughtPct !== null ? 'pumpswap' : 'none';

  const shieldHit = shieldMap?.get(mint) ?? null;
  const shield: SecurityFacts['shield'] = {
    answered: shieldHit !== null && shieldHit.notSellable !== null,
    notSellable: shieldHit?.notSellable === true,
    warnings: shieldHit?.warnings ?? [],
  };

  const creatorRecord: CreatorRecord = {
    launches: history?.launches ?? null,
    graduated: history?.graduated ?? null,
    devMints: summary.audit.devMints,
    devMigrations: summary.audit.devMigrations,
    rugcheckCreatorRugs: rcSummary ? rc.creatorRugsFlag(rcSummary) : null,
    source: history ? 'pumpfun' : summary.audit.devMints !== null ? 'jupiter' : rcSummary ? 'rugcheck' : 'none',
  };

  const verdict = creatorVerdict(history);
  const inputs = securityChecks({
    launchpad: summary.launchpad,
    bondingCurvePct: summary.bondingCurvePct,
    mint: {
      checked: facts.checked,
      message: facts.message,
      mintAuthority: facts.checked ? facts.mintAuthority !== null : null,
      freezeAuthority: facts.checked ? facts.freezeAuthority !== null : null,
      isToken2022: facts.checked ? facts.isToken2022 : null,
    },
    liquidityUsd: summary.liquidityUsd,
    liquiditySource: summary.sources.liquidity ?? 'none',
    shares: {
      devPct: summary.devHoldingPct,
      top10Pct: top10,
      top20Pct: top20,
      bundledPct,
      bundledHeldPct,
      bundleWallets: launch?.bundle.wallets ?? null,
      bundleStillHolding: launch?.bundle.stillHolding ?? null,
      sniperPct,
      sniperHeldPct,
      sniperWindowSlots: intel?.sniperWindowSlots ?? null,
      launchNote: intel?.note ?? null,
      concSource,
      launchSource,
    },
    rugcheck: {
      answered: rcSummary !== null,
      creatorRugs: creatorRecord.rugcheckCreatorRugs,
      riskCount: rcSummary?.risks.length ?? 0,
    },
    insiders: {
      answered: rcNets !== null,
      networks: rcNets?.length ?? 0,
      largestSharePct: rcNets ? rc.largestNetworkSharePct(rcNets) : null,
    },
    shield,
    creatorRecord,
    banned: summary.audit.isBanned,
    localCreator: local,
    history: history ? { launches: history.launches, verdict: verdict.verdict, detail: verdict.detail } : null,
  });

  const { checks, score, resolved, total } = scoreChecks(inputs);

  const dexPaid: DescriptiveFacts['dexPaid'] = {
    paid: dsOrders?.paid ?? (summary.socials.dexPaid ? true : null),
    paidAt: dsOrders?.paidAt ?? null,
    boosts: dsOrders?.boosts ?? null,
    communityTakeover: dsOrders?.communityTakeover ?? null,
    source: dsOrders && dsOrders.paid !== null ? 'dexscreener' : summary.socials.dexPaid ? 'dexscreener' : 'none',
  };

  return {
    mint,
    score,
    checksResolved: resolved,
    checksTotal: total,
    checks,
    concentration: {
      devPct: summary.devHoldingPct,
      top10Pct: top10,
      top20Pct: top20,
      insiderPct: summary.insiderPct,
      sniperPct,
      bundledPct,
      bundledHeldPct,
      sniperHeldPct,
      source: concSource,
    },
    creator: {
      address: creator,
      priorLaunches: local?.priorLaunches ?? null,
      priorRugs: local?.priorRugs ?? null,
      source: 'derived',
      history,
    },
    rug: rugIntel?.rug ?? null,
    volatility: rugIntel?.volatility ?? [],
    odds: odds ?? null,
    descriptive: {
      socials: describeSocials(summary),
      dexPaid,
      note: NO_EDGE_NOTE,
    },
    creatorRecord,
    generatedAt: Date.now(),
  };
}

/**
 * Discover-row score. The rule is shared (shared/market.ts quickScore) so
 * the tests pin it: liquidity plus the gates a list row can carry — Shield,
 * the creator record, the pump.fun ban — and null under three resolved.
 * Holder counts and socials are gone from it: the first is gameable at zero
 * cost, the second has no measured edge.
 */
const quickScore = quickScoreShared;

/** Stamp Jupiter Shield's verdict on a page of rows — one call for ≤ 100. */
async function attachShield(rows: TokenSummary[]): Promise<void> {
  if (!usable('jupiter') || !rows.length) return;
  const m = await jup.shield(rows.map((r) => r.mint));
  for (const r of rows) {
    const v = m.get(r.mint);
    if (!v) continue;
    r.audit.notSellable = v.notSellable;
    r.audit.shieldWarnings = v.warnings;
  }
}

/**
 * Attach the measured rug rules to the pump rows old enough to have a
 * launch window (≥ 20 s), three at a time, and give it about two seconds.
 * Whatever has not answered by then arrives on the next refresh from the
 * memo in launchIntel — the list is never held for it.
 *
 * The graduation odds ride the same workers and the same budget for the
 * same rows once they are >= 60 s old (the model's first window); younger
 * rows keep `odds: null`. Both share the memoised coin record and seek, so
 * the second judgement costs no extra request.
 */
const RUG_ATTACH_BUDGET_MS = 2_000;
const RUG_ATTACH_MIN_AGE_S = 20;
const ODDS_ATTACH_MIN_AGE_S = 60;

async function attachRugReports(rows: TokenSummary[]): Promise<void> {
  if (!usable('pumpswap')) return;
  const now = Date.now();
  // Curve rows only. The rules were measured on the launch window of tokens
  // still on their curve; a Migrated row (curve gone, `bondingCurvePct`
  // null) was being judged too — forty extra coin lookups and seeks per
  // refresh of a column whose cards never show the badge.
  const queue = rows.filter(
    (r) =>
      r.launchpad === 'pumpfun' &&
      r.createdAt !== null &&
      (now - r.createdAt) / 1000 >= RUG_ATTACH_MIN_AGE_S &&
      r.bondingCurvePct !== null &&
      r.bondingCurvePct < 100,
  );
  if (!queue.length) return;
  // The budget is a DEADLINE for starting rows, not just for waiting: the
  // workers used to keep draining the queue after the race resolved, so
  // every refresh added the whole column to the pump.fun / swap-api queues
  // and the token page's own lookups sat behind minutes of seeks.
  const deadline = now + RUG_ATTACH_BUDGET_MS;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const r = queue.shift();
      if (!r) return;
      const oldEnoughForOdds = r.createdAt !== null && (now - r.createdAt) / 1000 >= ODDS_ATTACH_MIN_AGE_S;
      const [x, odds] = await Promise.all([
        // A LIST row: its creator record is Jupiter's, already on the row,
        // and no per-row `/coins?creator=` may be bought on top of it — nor,
        // since 2026-09-20, the coin record itself (`buyCoin: false`): a row
        // from the feed has its record on the chain, read in the column's
        // own batch, and a list of forty must never buy forty records.
        rugReportSafe(r.mint, r.creator, r.createdAt, { dev: devRecordOf(r), creatorLookup: false, buyCoin: false }),
        oldEnoughForOdds ? oddsSafe(r.mint, r.creator, r.createdAt, { buyCoin: false }) : Promise.resolve(null),
      ]);
      if (x) {
        r.rug = x.rug;
        r.volatility = x.volatility;
      }
      r.odds = odds;
    }
  };
  // Two workers, not three (2026-09-20): three concurrent seeks of two or
  // three pages each burst the swap-api at ~3 requests a second inside the
  // budget, and it answered 429 (parking itself for a minute, badges gone).
  // The memo carries what a pass did not reach to the next one.
  const all = Promise.all(Array.from({ length: 2 }, worker)).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RUG_ATTACH_BUDGET_MS);
  });
  await Promise.race([all, budget]);
  if (timer) clearTimeout(timer);
}

// ── Discover ──────────────────────────────────────────────────────────

/** Enrich a set of pump.fun rows with Jupiter's aggregate data in one call. */
async function enrichWithJupiter(rows: TokenSummary[]): Promise<TokenSummary[]> {
  if (!usable('jupiter') || !rows.length) return rows;
  // Decoration (image, holders, volume, audit) accepts a 45 s memory and
  // skips mints Jupiter did not know a minute ago — see jupiter.byMints.
  // This was one batch per column per pass at the 8 s per-mint TTL.
  const byMint = await jup.byMints(rows.map((r) => r.mint), { enrich: true });
  return rows.map((r) => {
    const j = byMint.get(r.mint);
    return j ? merge(r, jup.toSummary(j)) : r;
  });
}

/**
 * `win` only changes the TRENDING column, and it must.
 *
 * New / Graduating / Migrated are ranked by age, curve progress and pool
 * creation — none of which have a time window. Trending is "most traded in
 * <window>", so hardcoding 5m here (which it did until 2026-08-24) left the
 * window buttons visibly inert on the one column they should move. Jupiter
 * serves all four windows and returns materially different sets for each.
 */
export async function discover(
  column: DiscoverColumn,
  limit: number,
  win: StatsWindow = '5m',
): Promise<TokenSummary[]> {
  const c = need();
  const d = c.data();
  const n = Math.min(80, Math.max(5, limit || d.discoverLimit));

  if (!d.networkDataEnabled) return [];

  // SOL price first: the pump rows price their curve's real SOL with it.
  const solUsd = usable('jupiter') ? await jup.solUsd() : null;

  // The providers this pass takes ROWS from — what a park banner may name.
  // Decoration (Jupiter's per-row facts, Shield, the rug rules) is not
  // recorded: a badge that lags is not a stale column.
  const asked: ProviderId[] = [];
  const ask = <T>(id: ProviderId, load: () => Promise<T>, empty: T): Promise<T> => {
    if (!usable(id)) return Promise.resolve(empty);
    asked.push(id);
    return load();
  };
  // With the scanner running, the feed IS the pump source: every create,
  // every trade on every curve and every migration reaches the engine
  // sub-second and free (engine/liveCurves.ts, liveLaunches). pump.fun's
  // list routes are then asked only to BOOTSTRAP a column the feed has not
  // filled yet (the first minute or two after the scanner starts), and never
  // once the feed carries half the column on its own. Scanner stopped: the
  // lists are the only pump source, exactly as before.
  const live = c.scannerRunning?.() === true;
  // …and never to bootstrap from a provider that is PARKED right now: the
  // request would be refused locally, the column would carry the park's
  // banner for nothing, and the feed fills the column within a minute or
  // two anyway (measured 2026-09-20: pump.fun asked three times at start-up,
  // three 429s, banner on all three columns until the books filled).
  const bootstrapWanted = (liveCount: number): boolean => !live || (liveCount < Math.ceil(n / 2) && cooldownRemainingMs('pumpfun') === 0);

  let rows: TokenSummary[] = [];

  switch (column) {
    case 'new': {
      // pump.fun is authoritative for "just created"; Jupiter's `recent`
      // catches everything launched somewhere else. Neither reliably carries
      // a fresh LaunchLab or Boop curve, so those rails are added directly —
      // this column was pump-only in practice, which made the launchpad
      // selector look broken when it was really a coverage gap.
      //
      // The two `poolsForDex` calls are the SAME ones the Graduating column
      // makes and are memoised for 60s, so at an 8s refresh this shares one
      // fetch per dex rather than doubling the GeckoTerminal spend — the
      // budget that starves the token chart when it is overspent.
      // Per-dex listings for the other rails, memoised for 60s and shared
      // with the Graduating column, so this adds no GeckoTerminal spend at an
      // 8s refresh.
      //
      // NOT `new_pools`: that is ordered by creation across every dex, and
      // pump.fun creates so many tokens that its newest page contains nothing
      // else — measured, 0 of 20 were LaunchLab or Boop. The per-dex listing
      // is volume-ranked, which for a slow rail is the better answer anyway:
      // it surfaces the launches people are actually trading.
      const launches = c.liveLaunches(n * 2);
      const [pump, recent, llFresh, boopFresh] = await Promise.all([
        bootstrapWanted(launches.length) ? ask('pumpfun', () => pf.latest(n), [] as pf.PumpCoin[]) : Promise.resolve([] as pf.PumpCoin[]),
        ask('jupiter', () => jup.recent(n), [] as jup.JupToken[]),
        ask('geckoterminal', () => gt.poolsForDex('raydium-launchlab', 1), [] as gt.NewPool[]),
        ask('geckoterminal', () => gt.poolsForDex('boop-fun', 1), [] as gt.NewPool[]),
      ]);
      const byMint = new Map<string, TokenSummary>();

      // Only pools young enough to belong in a "new" column get an account
      // read. Reading state for every listed pool would spend RPC on tokens
      // this column will not show anyway.
      // "New" is relative to the rail. pump.fun mints dozens a minute, so its
      // newest are seconds old; LaunchLab and Boop launch rarely enough that
      // a token hours old is still one of their newest. Every card shows its
      // own age, so a wider window here informs rather than misleads.
      const NEW_MAX_AGE_MS = 24 * 60 * 60_000;
      const freshEnough = (createdAt: number | null): boolean =>
        createdAt !== null && Date.now() - createdAt < NEW_MAX_AGE_MS;

      // A new pool ON A CURVE DEX is a launch; a new pool anywhere else is a
      // migration, which is the Migrated column's business.
      const llNew = llFresh.filter((p) => p.address && freshEnough(p.createdAt));
      if (llNew.length) {
        const states = await launchLab.progressFor(c.httpUrl(), llNew.map((p) => p.address));
        for (const p of llNew) {
          const st = states.get(p.address);
          // Migrated is not new, and a stablecoin-quoted pool's reserves are
          // not lamports — both are excluded rather than shown wrong.
          if (!st || st.isMigrated || !st.isSolQuoted) continue;
          const row = emptySummary(st.baseMint);
          row.launchpad = 'bonk';
          row.bondingCurvePct = st.progressPct;
          row.poolAddress = p.address;
          row.dexId = 'raydium-launchlab';
          row.createdAt = p.createdAt;
          row.decimals = st.baseDecimals;
          row.liquidityUsd = p.reserveUsd;
          const mc = p.marketCapUsd ?? p.fdvUsd;
          row.marketCapUsd = mc && mc > 0 ? mc : null;
          row.priceUsd = p.priceUsd;
          row.sources = { liquidity: 'geckoterminal', marketCap: 'geckoterminal' };
          row.fetchedAt = Date.now();
          if (!byMint.has(st.baseMint)) byMint.set(st.baseMint, row);
        }
      }

      const boopNew = boopFresh.filter((p) => p.baseMint && freshEnough(p.createdAt));
      if (boopNew.length) {
        const states = await boop.progressForMints(c.httpUrl(), boopNew.map((p) => p.baseMint as string));
        for (const p of boopNew) {
          const st = p.baseMint ? states.get(p.baseMint) : undefined;
          if (!st || (st.progressPct !== null && st.progressPct >= 100)) continue;
          const row = emptySummary(st.mint);
          row.launchpad = 'boop';
          row.bondingCurvePct = st.progressPct;
          row.poolAddress = st.pool;
          row.dexId = 'boop-fun';
          row.createdAt = p.createdAt;
          row.decimals = boop.BOOP_DECIMALS;
          row.liquidityUsd = p.reserveUsd;
          const mc = p.marketCapUsd ?? p.fdvUsd;
          row.marketCapUsd = mc && mc > 0 ? mc : null;
          row.priceUsd = p.priceUsd;
          row.sources = { liquidity: 'geckoterminal', marketCap: 'geckoterminal' };
          row.fetchedAt = Date.now();
          if (!byMint.has(st.mint)) byMint.set(st.mint, row);
        }
      }

      for (const co of pump) {
        if (!byMint.has(co.mint)) byMint.set(co.mint, pf.toSummary(co, solUsd));
      }

      // Our own tape, last. It costs no request, it is seconds ahead of any
      // list route, and it is the reason this column keeps filling while
      // pump.fun is throttling us. A mint the providers already returned
      // keeps their row and takes the tape's price and curve percentage;
      // one they have not listed yet becomes a row of its own.
      //
      // The age limit is the column's own: a launch the scanner saw six
      // hours ago is not new, whatever the tape still remembers about it.
      mergeLiveLaunches(byMint, launches, solUsd, NEW_MAX_AGE_MS);
      for (const t of recent) {
        const s = jup.toSummary(t);
        byMint.set(t.id, byMint.has(t.id) ? merge(byMint.get(t.id) as TokenSummary, s) : s);
      }

      // The other rails get a RESERVED SHARE of the column.
      //
      // Sorting everything by age and slicing deletes them every time, which
      // is how this column stayed pump-only: pump launches dozens of tokens a
      // minute, so any LaunchLab or Boop pool more than about a minute old
      // sorts below the cut no matter how new it is in its own rail's terms.
      // Merging first and reserving map slots is not enough — the SLICE is
      // what discards them. So the two groups are cut separately.
      const byAge = (a: TokenSummary, b: TokenSummary): number => (b.createdAt ?? 0) - (a.createdAt ?? 0);
      const isOtherRail = (r: TokenSummary): boolean => r.launchpad === 'bonk' || r.launchpad === 'boop';
      const all = [...byMint.values()];
      // A quarter of the column, at most — enough that the other rails are
      // always visible, small enough that pump (which genuinely produces most
      // new tokens) still dominates a column about what is new.
      const otherQuota = Math.max(1, Math.floor(n / 4));
      const others = all.filter(isOtherRail).sort(byAge).slice(0, otherQuota);
      const pumpish = all.filter((r) => !isOtherRail(r)).sort(byAge).slice(0, Math.max(0, n - others.length));
      rows = [...others, ...pumpish].sort(byAge);
      rows = await enrichWithJupiter(rows);
      break;
    }
    case 'graduating': {
      // Two independent sources, because no single one covers both rails:
      //   pump.fun — its own API, exact reserves;
      //   Meteora DBC — candidate pools from GeckoTerminal's `meteora-dbc`
      //   dex, with EXACT progress read from the pool and config accounts.
      // Both give real percentages. Nothing here is estimated.
      // The feed's own book first: every incomplete curve traded in the
      // last fifteen minutes, most progressed first. Their exact reserves,
      // real SOL, name and creator come from ONE batched chain read
      // (pumpChain), which is also what prices them — nothing here is a
      // provider's copy.
      const liveCurves = live ? (c.liveCurves?.(n) ?? []) : [];
      const [pump, curvePools, llPools, boopPools, liveCoins] = await Promise.all([
        bootstrapWanted(liveCurves.length) ? ask('pumpfun', () => pf.graduating(n), [] as pf.PumpCoin[]) : Promise.resolve([] as pf.PumpCoin[]),
        // Per-DEX listing, NOT new_pools: a DBC pool only shows up in
        // new_pools once it has already migrated, so that source can never
        // contain a token that is about to graduate.
        // Two pages: measured 2026-08-24, 19 of the top 20 DBC pools by
        // volume are ALREADY migrated — a graduated token keeps the volume it
        // did on its curve, so the list skews heavily to finished ones.
        // Widening the candidate set is what makes the column non-empty.
        // ONE page. Two pages doubled the GeckoTerminal spend and the free
        // tier 429s well before its documented 30/min — which starved the
        // token chart, a far more valuable use of the same budget.
        ask('geckoterminal', () => gt.poolsForDex('meteora-dbc', 1), [] as gt.NewPool[]),
        // Raydium LaunchLab — the rail behind letsbonk.fun, and the third
        // launch venue this column covers. Same treatment as DBC: candidates
        // from GeckoTerminal, EXACT progress read from the pool account.
        ask('geckoterminal', () => gt.poolsForDex('raydium-launchlab', 1), [] as gt.NewPool[]),
        // Boop runs its own curve program. Its pool is a PDA of the mint, so
        // this only needs the candidate MINTS from GeckoTerminal.
        ask('geckoterminal', () => gt.poolsForDex('boop-fun', 1), [] as gt.NewPool[]),
        liveCurves.length ? pumpChain.readMany(c.httpUrl(), liveCurves.map((x) => x.mint)).catch(() => new Map<string, pumpChain.PumpChainCoin | null>()) : Promise.resolve(new Map<string, pumpChain.PumpChainCoin | null>()),
      ]);

      const byMint = new Map<string, TokenSummary>();
      for (const lc of liveCurves) {
        const row = liveCurveRow(lc, liveCoins.get(lc.mint) ?? null, c, solUsd);
        if (row) byMint.set(lc.mint, row);
      }
      for (const co of pump) if (!byMint.has(co.mint)) byMint.set(co.mint, pf.toSummary(co, solUsd));

      const launchLabPools = llPools.filter((p) => p.address);
      if (launchLabPools.length) {
        const states = await launchLab.progressFor(c.httpUrl(), launchLabPools.map((p) => p.address));
        for (const p of launchLabPools) {
          const st = states.get(p.address);
          if (!st || st.progressPct === null || st.isMigrated) continue;
          // A USDC/USDT-quoted pool's reserves are not lamports. Rather than
          // print a SOL figure that is wrong by ~200x, those are left out of
          // a column whose other rows are SOL-denominated.
          if (!st.isSolQuoted) continue;
          const row = emptySummary(st.baseMint);
          row.launchpad = 'bonk';
          row.bondingCurvePct = st.progressPct;
          row.poolAddress = p.address;
          row.dexId = 'raydium-launchlab';
          row.createdAt = p.createdAt;
          row.decimals = st.baseDecimals;
          row.liquidityUsd = p.reserveUsd;
          const mcLl = p.marketCapUsd ?? p.fdvUsd;
          row.marketCapUsd = mcLl && mcLl > 0 ? mcLl : null;
          row.priceUsd = p.priceUsd;
          row.sources = { liquidity: 'geckoterminal', marketCap: 'geckoterminal' };
          row.fetchedAt = Date.now();
          byMint.set(st.baseMint, row);
        }
      }

      const dbcPools = curvePools.filter((p) => p.baseMint);
      if (dbcPools.length) {
        const progress = await dbcAccounts.progressFor(c.httpUrl(), dbcPools.map((p) => p.address));
        for (const p of dbcPools) {
          const st = progress.get(p.address);
          // A pool whose threshold we could not read has unknown progress,
          // and an unknown cannot be ranked in a column that exists to rank
          // by progress — so it is left out rather than shown at zero.
          if (!st || st.progressPct === null || st.isMigrated) continue;
          const row = emptySummary(st.baseMint);
          row.launchpad = 'meteora';
          row.bondingCurvePct = st.progressPct;
          row.poolAddress = p.address;
          row.dexId = 'meteora-dbc';
          row.createdAt = p.createdAt;
          row.liquidityUsd = p.reserveUsd;
          // GeckoTerminal reports 0 for an unknown market cap; 0 is not a
          // market cap, so it becomes null like any other unknown.
          const mc = p.marketCapUsd ?? p.fdvUsd;
          row.marketCapUsd = mc && mc > 0 ? mc : null;
          row.priceUsd = p.priceUsd;
          row.sources = { liquidity: 'geckoterminal', marketCap: 'geckoterminal' };
          row.fetchedAt = Date.now();
          byMint.set(st.baseMint, row);
        }
      }

      const boopMints = boopPools.map((p) => p.baseMint).filter((m): m is string => !!m);
      if (boopMints.length) {
        const states = await boop.progressForMints(c.httpUrl(), boopMints);
        for (const p of boopPools) {
          if (!p.baseMint) continue;
          const st = states.get(p.baseMint);
          if (!st || st.progressPct === null || st.progressPct >= 100) continue;
          const row = emptySummary(st.mint);
          row.launchpad = 'boop';
          row.bondingCurvePct = st.progressPct;
          row.poolAddress = st.pool;
          row.dexId = 'boop-fun';
          row.createdAt = p.createdAt;
          row.decimals = boop.BOOP_DECIMALS;
          row.liquidityUsd = p.reserveUsd;
          const mcB = p.marketCapUsd ?? p.fdvUsd;
          row.marketCapUsd = mcB && mcB > 0 ? mcB : null;
          row.priceUsd = p.priceUsd;
          row.sources = { liquidity: 'geckoterminal', marketCap: 'geckoterminal' };
          row.fetchedAt = Date.now();
          byMint.set(st.mint, row);
        }
      }

      rows = [...byMint.values()]
        .sort((a, b) => (b.bondingCurvePct ?? 0) - (a.bondingCurvePct ?? 0))
        .slice(0, n);
      rows = await enrichWithJupiter(rows);
      break;
    }
    case 'migrated': {
      // pump.fun's own `complete` feed, plus every OTHER launchpad's
      // migration seen as a brand-new AMM pool. A new pool on an AMM (rather
      // than on a launch curve) is exactly what graduating produces, whoever
      // the launchpad was.
      // The feed's own book first: every pump migration this session saw,
      // newest first. Priced and named by one batched chain read of the
      // canonical PumpSwap pool and its vaults (pumpChain).
      const liveMigs = live ? (c.liveMigrations?.(n) ?? []) : [];
      const [pump, fresh, migCoins] = await Promise.all([
        bootstrapWanted(liveMigs.length) ? ask('pumpfun', () => pf.migrated(n), [] as pf.PumpCoin[]) : Promise.resolve([] as pf.PumpCoin[]),
        ask('geckoterminal', () => gt.newPools(1), [] as gt.NewPool[]),
        liveMigs.length ? pumpChain.readMany(c.httpUrl(), liveMigs.map((x) => x.mint)).catch(() => new Map<string, pumpChain.PumpChainCoin | null>()) : Promise.resolve(new Map<string, pumpChain.PumpChainCoin | null>()),
      ]);

      const byMint = new Map<string, TokenSummary>();
      for (const m of liveMigs) {
        const row = liveMigrationRow(m, migCoins.get(m.mint) ?? null, c, solUsd);
        if (row) byMint.set(m.mint, row);
      }
      for (const co of pump) if (!byMint.has(co.mint)) byMint.set(co.mint, pf.toSummary(co, solUsd));

      // Our own observation next: Raydium pools the engine saw created,
      // seconds ahead of any indexer and free (shared/raydium.ts). Same age
      // window as the New column — a pool from yesterday is not a migration
      // this column should lead with.
      mergeLivePools(byMint, c.livePools(n * 2), solUsd, 24 * 60 * 60_000);

      // Non-pump migrations go in FIRST so the pump feed cannot fill the
      // whole quota and starve every other launchpad out of the column —
      // which is exactly what happened when pump was merged first.
      for (const p of fresh) {
        if (!p.baseMint || gt.isCurveDex(p.dexId)) continue;
        if (byMint.has(p.baseMint)) continue;
        const row = emptySummary(p.baseMint);
        row.poolAddress = p.address;
        row.dexId = p.dexId;
        // `createdAt` here is the POOL's creation, i.e. the migration moment,
        // which is what this column is actually sorted by. Jupiter overwrites
        // it below with the token's real birth time where it knows one.
        row.createdAt = p.createdAt;
        row.liquidityUsd = p.reserveUsd;
        const mc = p.marketCapUsd ?? p.fdvUsd;
        row.marketCapUsd = mc && mc > 0 ? mc : null;
        row.priceUsd = p.priceUsd;
        row.bondingCurvePct = 100;
        row.sources = { liquidity: 'geckoterminal', marketCap: 'geckoterminal' };
        row.fetchedAt = Date.now();
        byMint.set(p.baseMint, row);
      }

      for (const co of pump) {
        if (byMint.size >= n && !byMint.has(co.mint)) break;
        if (!byMint.has(co.mint)) byMint.set(co.mint, pf.toSummary(co, solUsd));
      }

      rows = [...byMint.values()]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, n);
      rows = await enrichWithJupiter(rows);
      break;
    }
    case 'trending': {
      if (!usable('jupiter')) return [];
      // Traded volume finds what is moving; organic score filters out the
      // wash-traded half of it. Union, organic first.
      const [traded, organic] = await Promise.all([
        ask('jupiter', () => jup.topTraded(win, n), [] as jup.JupToken[]),
        ask('jupiter', () => jup.topOrganic(win, Math.ceil(n / 2)), [] as jup.JupToken[]),
      ]);
      const byMint = new Map<string, TokenSummary>();
      for (const t of organic) byMint.set(t.id, jup.toSummary(t));
      for (const t of traded) if (!byMint.has(t.id)) byMint.set(t.id, jup.toSummary(t));
      rows = [...byMint.values()]
        .filter((r) => !TRENDING_EXCLUDE.has(r.mint))
        .sort((a, b) => (b.stats[win]?.volumeUsd ?? 0) - (a.stats[win]?.volumeUsd ?? 0))
        .slice(0, n);
      break;
    }
  }

  askedByColumn.set(column, [...new Set(asked)]);

  // Shield is one batched call; the rug rules get a bounded slice of time
  // and the memo carries the rest to the next refresh.
  await attachShield(rows);
  await attachRugReports(rows);

  for (const r of rows) {
    if (r.priceSol === null && r.priceUsd !== null && solUsd) r.priceSol = r.priceUsd / solUsd;
    r.kryptScore = quickScore(r);
    localise(r);
  }
  return rows;
}

/**
 * A Graduating row from the feed's book. The chain read carries the exact
 * reserves, real SOL, name, creator, decimals and supply; when it did not
 * answer (RPC hiccup) the trade event's own reserves still price the row and
 * state its progress — with no name, which the card renders as the mint,
 * rather than no row. A curve the chain says is complete is not graduating.
 */
function liveCurveRow(lc: LiveCurve, coin: pumpChain.PumpChainCoin | null, c: TerminalContext, solUsd: number | null): TokenSummary | null {
  if (coin?.curve.complete) return null;
  const launch = c.liveLaunch?.(lc.mint) ?? null;
  let row: TokenSummary;
  if (coin) {
    row = pumpChain.toSummary(coin, solUsd);
  } else {
    row = emptySummary(lc.mint);
    row.launchpad = 'pumpfun';
    row.dexId = 'pumpfun-curve';
    row.creator = lc.creator;
    row.priceSol = lc.vTok > 0n ? Number(lc.vSol) / 1e9 / (Number(lc.vTok) / 1e6) : null;
    row.priceUsd = row.priceSol !== null && solUsd ? row.priceSol * solUsd : null;
    row.totalSupply = PUMP_TOTAL_SUPPLY;
    row.circSupply = PUMP_TOTAL_SUPPLY;
    if (row.priceUsd !== null) {
      row.marketCapUsd = row.priceUsd * PUMP_TOTAL_SUPPLY;
      row.fdvUsd = row.marketCapUsd;
    }
    row.bondingCurvePct = lc.progressPct;
    row.sources = { price: 'engine', marketCap: row.marketCapUsd !== null ? 'derived' : undefined } as TokenSummary['sources'];
    row.fetchedAt = lc.lastTradeAt;
  }
  if (launch) {
    if (!row.name) row.name = launch.name;
    if (!row.symbol) row.symbol = launch.symbol;
    if (row.creator === null) row.creator = launch.creator;
    if (row.createdAt === null) row.createdAt = launch.detectedAt;
  }
  return row;
}

/**
 * A Migrated row from the feed's book. Priced on the canonical PumpSwap
 * pool by the chain read; `createdAt` is the MIGRATION moment, which is what
 * this column sorts by (the GeckoTerminal rows use their pool's creation
 * the same way). A migration whose pool the chain could not read still
 * lists — named if the feed tracked its launch — with no price claimed.
 */
function liveMigrationRow(m: LiveMigration, coin: pumpChain.PumpChainCoin | null, c: TerminalContext, solUsd: number | null): TokenSummary | null {
  const launch = c.liveLaunch?.(m.mint) ?? null;
  const row = coin ? pumpChain.toSummary(coin, solUsd) : emptySummary(m.mint);
  if (!coin) {
    row.launchpad = 'pumpfun';
    row.dexId = 'pumpswap';
    row.poolAddress = m.pool;
    row.poolQuoteMint = WSOL_MINT_ADDRESS;
    row.bondingCurvePct = 100;
    row.fetchedAt = m.detectedAt;
  }
  if (launch) {
    if (!row.name) row.name = launch.name;
    if (!row.symbol) row.symbol = launch.symbol;
    if (row.creator === null) row.creator = launch.creator;
  }
  row.createdAt = m.detectedAt;
  return row;
}

const WSOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

/** Apply filters main-side so the renderer never sees rows it will drop. */
export function filterRows(rows: TokenSummary[], filters: DiscoverFilters | null): TokenSummary[] {
  if (!filters) return rows;
  const c = ctx;
  const now = Date.now();
  return rows.filter((r) => {
    if (!passesFilters(r, filters, now)) return false;
    if (filters.hideBlacklistedCreators && r.creator && c) {
      const intel = c.creatorIntel(r.creator);
      if (intel && (intel.blacklisted || intel.priorRugs > 0)) return false;
    }
    return true;
  });
}

export function presets(): ReturnType<typeof builtinPresets> {
  return builtinPresets();
}

// ── Single token ──────────────────────────────────────────────────────

/**
 * Assembled token summary, memoised for a few seconds.
 *
 * Seven call sites reach for this during a single token-page load — the
 * header, the security report, pools, holders, the graph, candles and the
 * tape subscription — and each one used to rebuild it from scratch,
 * re-querying every provider and the chain. The cache makes the page's
 * queries share one assembly. It is short enough that a refresh still gets
 * fresh numbers.
 */
const SUMMARY_TTL_MS = 5_000;

/** The cached summary, or null — never a fetch. For the trade path, which
 *  must not wait on a provider for a fact it may already hold. */
export function summaryIfCached(mint: string): TokenSummary | null {
  return cached<TokenSummary>(`market:summary:${mint}`);
}

/**
 * A summary a MONEY path may act on, or null.
 *
 * The grace tier in http.ts holds the last good value over a failed reload
 * so a throttled provider does not blank the screen. That is right for a
 * panel and wrong for a price something is about to be sized against: an
 * order placed at a reference price from fifty seconds ago is not a smoother
 * experience, it is a worse fill.
 *
 * So the paths that spend or simulate money ask for the price through here,
 * and take a refusal over an old number. Three TTLs of slack, which covers a
 * slow build without reaching into what grace serves.
 */
export async function freshSummary(mint: string, maxAgeMs = SUMMARY_TTL_MS * 3): Promise<TokenSummary | null> {
  const s = await summary(mint);
  if (s.fetchedAt <= 0) return null;
  return Date.now() - s.fetchedAt <= maxAgeMs ? s : null;
}

export async function summary(mint: string): Promise<TokenSummary> {
  return summaryWith(mint, { identity: true });
}

/** What a build may spend on. `identity: false` is the batch paths' rule:
 *  never a per-mint pump.fun record, only what the chain and the batched
 *  routes give — see summaryMany. */
interface BuildOptions {
  identity: boolean;
}

async function summaryWith(mint: string, build: BuildOptions): Promise<TokenSummary> {
  const hit = await memo<TokenSummary>(`market:summary:${mint}`, SUMMARY_TTL_MS, () => buildSummary(mint, build));
  // A mint no provider can price is remembered as such for five minutes —
  // ONLY read by callers that opt in (`summaryMany(…, { skipUnpriceable })`,
  // the portfolio's off-path naming). The trade path never sees the marker.
  if (!hit || (hit.priceSol === null && hit.priceUsd === null)) putCache(`market:nopx:${mint}`, true, 300_000);
  return hit ?? emptySummary(mint);
}

/**
 * Summaries for MANY mints with the batched Jupiter routes warmed first —
 * one search and one Shield call for the whole set — so each per-mint
 * assembly finds its Jupiter half in memory and only the pump.fun and
 * DexScreener halves go out, `concurrency` wide behind the per-host gate.
 *
 * The portfolio (sixty mints, three pollers), the watchlist and the orders
 * poll each priced their mints one `summary()` at a time: two Jupiter calls
 * per mint per refresh, which on its own put an idle app over Jupiter's
 * budget (rate-limit swarm, 2026-09-06). `priority` puts the Jupiter batch
 * on the trade lane — for the orders poll, whose price a stop-loss evaluates
 * against and which must not go blind behind a parked provider.
 */
export async function summaryMany(
  mints: string[],
  concurrency = 4,
  opts: { priority?: boolean; skipUnpriceable?: boolean } = {},
): Promise<Map<string, TokenSummary>> {
  const out = new Map<string, TokenSummary>();
  const all = [...new Set(mints.filter(Boolean))];
  // Opt-in: leave out mints marked unpriceable in the last five minutes
  // (dead launches re-walking parked providers). Never on the trade path.
  const unique = opts.skipUnpriceable ? all.filter((m) => !cached<boolean>(`market:nopx:${m}`)) : all;
  if (!unique.length) return out;

  const lanes = Math.max(1, Math.min(concurrency, unique.length));
  const httpUrl = ctx?.httpUrl() ?? '';
  for (let start = 0; start < unique.length; start += WARM_CHUNK) {
    const chunk = unique.slice(start, start + WARM_CHUNK);
    const cold = chunk.filter((m) => summaryIfCached(m) === null);
    if (cold.length) {
      // Everything that HAS a batch route, batched, immediately before the
      // assembly that consumes it — the chain's curve/mint/metadata reads
      // (thirty-three mints per RPC call), Jupiter's rows and Shield
      // verdicts, and DexScreener's pairs 30 at a time. Each writes the very
      // per-mint cache `buildSummary` reads, so the assembly below makes no
      // request for any of the four.
      const pumpCold = httpUrl ? cold.filter(pumpChain.looksLikePumpMint) : [];
      await Promise.all([
        pumpCold.length ? pumpChain.readMany(httpUrl, pumpCold) : Promise.resolve(null),
        usable('jupiter') ? jup.byMints(cold, opts) : Promise.resolve(null),
        usable('jupiter') ? jup.shield(cold, opts) : Promise.resolve(null),
        usable('dexscreener') ? ds.tokenInfoMany(cold, opts) : Promise.resolve(null),
      ]).catch(() => undefined);
    }
    await Promise.all(
      Array.from({ length: lanes }, async (_, lane) => {
        for (let i = lane; i < chunk.length; i += lanes) {
          const m = chunk[i];
          try {
            // A batch row never buys pump's identity record — a list of
            // sixty holdings asking pump.fun sixty times is the storm this
            // path used to be. Whatever identity is already cached is used.
            out.set(m, await summaryWith(m, { identity: false }));
          } catch {
            /* an unpriced mint is simply absent — the caller says so */
          }
        }
      }),
    );
  }

  await fillPricesFromGecko(out);
  return out;
}

/**
 * Mints warmed per pass.
 *
 * The warm-then-assemble pattern only works while a chunk finishes INSIDE
 * the warmed data's TTL. A 60-mint build takes about 16 s (the pump.fun
 * per-mint leg at its 260 ms host gap is the pacer) against Jupiter's 8 s
 * per-mint TTL, so warming all sixty up front meant 26 of them had gone
 * stale by the time their assembly ran and re-fetched a row the same
 * function had just batched (api swarm 2026-09-09 §4).
 *
 * Twenty is the fix, and it is the honest one: the answer stays as fresh as
 * it always was — fresher, in fact, since a chunk's rows are seconds old
 * when used — rather than lengthening the TTL until the staleness fits.
 */
const WARM_CHUNK = 20;

/**
 * Last resort for mints nothing priced: GeckoTerminal's batched
 * `simple/token_price`, 30 per request.
 *
 * Only ever reached when Jupiter is switched off or parked AND DexScreener
 * had nothing either, so on a healthy app this makes zero requests — which
 * matters, because GeckoTerminal's entire budget is 30 calls a minute and
 * the chart lives on it. Fills only fields that are still null and stamps
 * `sources` accordingly: a GeckoTerminal price must never read as Jupiter's.
 */
async function fillPricesFromGecko(rows: Map<string, TokenSummary>): Promise<void> {
  if (!usable('geckoterminal')) return;
  const gaps = [...rows.values()].filter((s) => s.priceUsd === null && s.priceSol === null);
  if (!gaps.length) return;
  const prices = await gt.simpleTokenPrices(gaps.map((s) => s.mint)).catch(() => new Map());
  if (!prices.size) return;
  const solUsd = cached<number>('jup:solusd');
  for (const s of gaps) {
    const p = prices.get(s.mint);
    if (!p) continue;
    if (s.priceUsd === null && p.priceUsd !== null) {
      s.priceUsd = p.priceUsd;
      s.sources.price = 'geckoterminal';
      if (s.priceSol === null && solUsd) s.priceSol = p.priceUsd / solUsd;
    }
    if (s.marketCapUsd === null && p.marketCapUsd !== null) {
      s.marketCapUsd = p.marketCapUsd;
      s.sources.marketCap = 'geckoterminal';
    }
    if (s.liquidityUsd === null && p.liquidityUsd !== null) {
      s.liquidityUsd = p.liquidityUsd;
      s.sources.liquidity = 'geckoterminal';
    }
  }
}

/**
 * SOL/USD, from the rate Jupiter's own price route already caches for 20 s.
 *
 * Exists so nothing has to price wSOL by building a whole `summary()` for
 * it: that is a four-call assembly (Jupiter search, Shield, DexScreener,
 * an RPC mint read) for one number `jup.solUsd()` is already holding, and
 * the portfolio was doing exactly that on every refresh.
 */
export async function solUsd(): Promise<number | null> {
  if (!usable('jupiter')) return null;
  return jup.solUsd();
}

/** Providers currently parked after a 429 — for a message that names them. */
export function parkedProviders(): ProviderId[] {
  return (Object.keys(PROVIDER_META) as ProviderId[]).filter((id) => cooldownRemainingMs(id) > 0);
}

/** How long a person's build waits for the metadata file before going on
 *  without it. The fetch keeps running and lands in the module's cache, so
 *  the next build (five seconds later on a token page) has the links. */
const METADATA_WAIT_MS = 1_500;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

const httpsOnly = (v: string | null): string | null => (v && v.startsWith('https://') ? v : null);

/**
 * The token's own metadata JSON as a summary patch — the file every
 * provider's "socials" and image are copied from, reached through the URI
 * the chain carries (the Token-2022 metadata extension or the Metaplex
 * account) or the create event. It exists the moment the coin does, where
 * pump.fun's record says null for the first minutes and nobody else has
 * indexed the coin at all (user report 2026-09-20: a runner flagged with an
 * X and a website on pump.fun, and neither in the app). Merged LAST, so a
 * provider that did answer keeps its values and this fills the gaps.
 */
function metadataPatch(mint: string, links: MetadataLinks): TokenSummary {
  const patch = emptySummary(mint);
  patch.imageUrl = httpsOnly(links.image);
  patch.socials = {
    twitter: httpsOnly(links.twitter),
    telegram: httpsOnly(links.telegram),
    website: httpsOnly(links.website),
    dexPaid: false,
  };
  if (patch.socials.twitter || patch.socials.telegram || patch.socials.website) patch.sources = { socials: 'metadata' };
  patch.fetchedAt = Date.now();
  return patch;
}

/** Whether the summary still lacks what the metadata file would add. */
function wantsMetadata(s: TokenSummary): boolean {
  return (!s.socials.twitter && !s.socials.telegram && !s.socials.website) || s.imageUrl === null;
}

async function buildSummary(mint: string, build: BuildOptions = { identity: true }): Promise<TokenSummary> {
  const c = need();
  let s = emptySummary(mint);

  // The chain FIRST, and in parallel with the providers. For a pump coin one
  // derived-account batch states the price, the reserves, the progress, the
  // creator, the decimals and supply, and the name — authoritative, fresh to
  // the slot, and on an RPC budget this app is nowhere near. It is merged
  // before any provider so those fields WIN; the providers fill what the
  // chain cannot know (image, socials, creation time, holders, volume).
  // Before 2026-09-20 every one of these builds bought pump.fun's coin
  // record, and that route's 429s kept the provider parked around the clock.
  const pumpMint = pumpChain.looksLikePumpMint(mint);
  const chainRead = pumpMint ? pumpChain.read(c.httpUrl(), mint).catch(() => null) : Promise.resolve(null);
  const fromLive = (solUsd: number | null): void => {
    const row = c.liveLaunch?.(mint) ?? null;
    if (row) s = merge(s, summaryFromLaunch(row, solUsd));
  };

  let solUsd: number | null = null;
  if (c.data().networkDataEnabled) {
    // The metadata URI the app already holds — the scanner's row or the
    // last chain read — so the file can be fetched alongside the providers
    // rather than after them. The chain read below is the fallback.
    const knownUri = pumpMint ? c.liveLaunch?.(mint)?.uri || pumpChain.readIfCached(mint)?.uri || null : null;
    const earlyLinks = knownUri && build.identity ? fetchMetadataLinks(knownUri) : null;

    // Identity — creation time, pump's flags — is the ONLY thing still asked
    // of pump.fun here, on a ten-minute memo, and only for a build a person
    // is looking at (never a batch row). Its image and socials are welcome
    // too, but the metadata file below is where they come from when the
    // record is minutes young and still says null.
    const wantIdentity = usable('pumpfun') && pumpMint;
    const [jupRows, pump, dsInfo, shieldMap, sol, chain] = await Promise.all([
      usable('jupiter') ? jup.search(mint) : Promise.resolve([]),
      wantIdentity ? (build.identity ? pf.coinIdentity(mint) : Promise.resolve(pf.coinIdentityIfCached(mint))) : Promise.resolve(null),
      usable('dexscreener') ? ds.tokenInfo(mint) : Promise.resolve(null),
      usable('jupiter') ? jup.shield([mint]) : Promise.resolve(null),
      usable('jupiter') ? jup.solUsd() : Promise.resolve(null),
      chainRead,
    ]);
    solUsd = sol;

    if (chain) {
      s = merge(s, pumpChain.toSummary(chain, solUsd));
      // A graduated coin's PumpSwap pool is how AMM swaps reach the tape;
      // registered from the chain's own answer, so the 1s chart works after
      // graduation whether or not DexScreener has indexed the pool yet.
      if (chain.curve.complete && s.poolAddress) c.registerPool(s.poolAddress, mint);
    }
    fromLive(solUsd);
    const jupHit = jupRows.find((t) => t.id === mint);
    if (jupHit) s = merge(s, jup.toSummary(jupHit));
    if (pump) s = merge(s, pf.toSummary(pump, solUsd));
    const shieldHit = shieldMap?.get(mint);
    if (shieldHit) {
      s.audit.notSellable = shieldHit.notSellable;
      s.audit.shieldWarnings = shieldHit.warnings;
    }
    if (dsInfo) {
      const patch = emptySummary(mint);
      patch.imageUrl = dsInfo.imageUrl;
      patch.socials = dsInfo.socials;
      patch.createdAt = dsInfo.pairCreatedAt;
      patch.priceUsd = dsInfo.priceUsd;
      patch.priceSol = dsInfo.priceNative;
      patch.liquidityUsd = dsInfo.liquidityUsd;
      patch.poolAddress = dsInfo.pools[0]?.address ?? null;
      patch.poolQuoteMint = dsInfo.pools[0]?.quoteMint ?? null;
      patch.dexId = dsInfo.pools[0]?.dexId ?? null;
      patch.sources = { liquidity: 'dexscreener', socials: 'dexscreener' };
      patch.fetchedAt = Date.now();
      s = merge(s, patch);
      // A migrated pump token's PumpSwap pool is how AMM swaps reach the
      // tape — register it so the 1s chart works after graduation too.
      for (const p of dsInfo.pools) {
        if (p.dexId.toLowerCase().includes('pump')) c.registerPool(p.address, mint);
      }
    }

    // The metadata file, last: it fills what no provider answered — for a
    // coin seconds old that is the X, the website and the image. A person's
    // build waits a short while for it and takes it from the cache after;
    // a batch row takes only what the create path already resolved (this
    // is IPFS, not pump.fun, but a Discover pass is still no place for it).
    const uri = knownUri ?? chain?.uri ?? null;
    if (uri && wantsMetadata(s)) {
      const links = build.identity
        ? await withDeadline(earlyLinks ?? fetchMetadataLinks(uri), METADATA_WAIT_MS)
        : metadataLinksIfCached(uri);
      if (links) {
        const before = s.socials;
        s = merge(s, metadataPatch(mint, links));
        // `merge` keeps the first source that ANSWERED, and a provider that
        // answered "none" counts; when the values on screen came from the
        // file, say so.
        if (s.socials.twitter !== before.twitter || s.socials.telegram !== before.telegram || s.socials.website !== before.website) {
          s.sources.socials = 'metadata';
        }
      }
    }
  } else {
    // Network data off: the chain and this session's own tape are the whole
    // answer, which for a pump coin is a real price rather than nothing.
    const chain = await chainRead;
    if (chain) {
      s = merge(s, pumpChain.toSummary(chain, null));
      if (chain.curve.complete && s.poolAddress) c.registerPool(s.poolAddress, mint);
    }
    fromLive(null);
  }

  // The chain overrides everything it can answer. (For a pump coin this is
  // a cache hit: the reader above seeded the mint's facts from the batch.)
  const facts = await onchain.mintFacts(c.httpUrl(), mint);
  if (facts.checked && facts.uiSupply !== null) {
    s.totalSupply = facts.uiSupply;
    s.decimals = facts.decimals ?? s.decimals;
    if (s.circSupply === null) s.circSupply = facts.uiSupply;
  }

  if (s.priceSol === null && s.priceUsd !== null && solUsd) s.priceSol = s.priceUsd / solUsd;
  if (s.priceUsd === null && s.priceSol !== null && solUsd) s.priceUsd = s.priceSol * solUsd;
  if (s.marketCapUsd === null && s.priceUsd !== null && s.circSupply !== null) {
    s.marketCapUsd = s.priceUsd * s.circSupply;
    s.sources.marketCap = 'derived';
  }
  s.kryptScore = quickScore(s);
  return localise(s);
}

export async function tokenDetail(mint: string): Promise<TokenDetail> {
  const c = need();
  const warnings: string[] = [];
  const s = await summary(mint);

  if (!c.data().networkDataEnabled) {
    warnings.push('Network data is off — showing on-chain reads only. Turn providers on in Settings for prices and charts.');
  }

  const [security, pools] = await Promise.all([
    securityReport(mint, s),
    poolsFor(mint, s),
  ]);

  // "Nobody priced it" and "we could not ask" are different facts, and only
  // one of them is about the token. With every price source parked these two
  // lines asserted a market fact the app never observed, next to a Buy button
  // (API swarm 2026-09-09, fo-1). `parkNote` names the parked providers and
  // how long until each retries.
  const priceParked = parkNote(['jupiter', 'dexscreener', 'geckoterminal', 'birdeye']);
  const poolParked = parkNote(['dexscreener', 'geckoterminal']);
  if (s.priceUsd === null) {
    warnings.push(priceParked ? `No price — ${priceParked} This is not a fact about the token.` : 'No provider returned a price for this mint.');
  }
  if (!pools.length) {
    warnings.push(
      poolParked
        ? `No pool data — ${poolParked} The token may still be tradeable; the app could not ask.`
        : 'No trading pool found — this token may not be tradeable yet.',
    );
  }

  const solUsd = usable('jupiter') ? await jup.solUsd() : null;
  const liveTrades = tape.trades(mint, 100, (w) => c.walletLabel(w), solUsd, s.circSupply);

  // On the token page the full security report — mint/freeze authority,
  // bundled and sniper supply, top-20, creator history — is the honest krypt
  // score. quickScore (5 checks: liq, dev, top10, holders, socials) is a
  // list-view stand-in that CANNOT see the signals a scam hides behind, so it
  // routinely over-rates a bundled/sniped launch. Here, where we actually pay
  // for the report, prefer it; quickScore only survives as the fallback when
  // the report could not resolve enough checks to score honestly.
  if (security.score !== null) s.kryptScore = security.score;
  // The rug rules and volatility notes are judged once, in the report, and
  // the row shape carries them so a list card and the page agree.
  s.rug = security.rug;
  s.volatility = security.volatility;
  s.odds = security.odds;

  return { summary: s, security, pools, liveTrades, warnings };
}

async function poolsFor(mint: string, s: TokenSummary, opts: { priority?: boolean } = {}): Promise<TokenPool[]> {
  if (usable('dexscreener')) {
    const info = await ds.tokenInfo(mint);
    if (info?.pools.length) return info.pools;
  }
  if (usable('geckoterminal')) {
    const pools = await gt.poolsForToken(mint, opts);
    if (pools.length) return pools;
  }
  if (s.poolAddress) {
    return [{ address: s.poolAddress, dexId: s.dexId ?? 'unknown', label: s.symbol || 'pool', liquidityUsd: s.liquidityUsd, quoteMint: s.poolQuoteMint }];
  }
  return [];
}

// ── Candles ───────────────────────────────────────────────────────────

/** Bucket width per interval, for judging how old a cached chart is. */
const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400,
};

/**
 * Last-good chart per `mint:interval` — serve stale over blank.
 *
 * When GeckoTerminal is parked after a 429 (20s cooldown) and the tape has
 * nothing, the honest answer used to be "no data", which on a poll meant the
 * chart the user was LOOKING AT was replaced by an empty panel. A chart that
 * says "30s old, provider rate-limited" is strictly more honest than a blank
 * one. Bounded LRU; the "none" result is never cached.
 */
interface CachedChart {
  series: CandleSeries;
  /** When the series was built from live sources — the age in the note. */
  at: number;
  /** True when the candles are a coarser interval than requested (the 1m
   *  degrade for a sub-minute ask). A degraded series must never be merged
   *  with tape candles of the REAL interval — mixed bucket widths. */
  degraded: boolean;
}
const chartCache = new Map<string, CachedChart>();
const CHART_CACHE_CAP = 200;

function rememberChart(key: string, series: CandleSeries, degraded = false): void {
  if (!series.candles.length) return; // never cache "none"
  if (chartCache.has(key)) chartCache.delete(key);
  else if (chartCache.size >= CHART_CACHE_CAP) {
    const oldest = chartCache.keys().next().value;
    if (oldest !== undefined) chartCache.delete(oldest);
  }
  chartCache.set(key, { series, at: Date.now(), degraded });
}

function recallChart(key: string): CachedChart | null {
  const e = chartCache.get(key);
  if (!e) return null;
  // LRU touch.
  chartCache.delete(key);
  chartCache.set(key, e);
  return e;
}

/** For tests and the settings "clear cache" path. */
export function clearChartCache(): void {
  chartCache.clear();
}

function chartProvidersParked(): boolean {
  return cooldownRemainingMs('geckoterminal') > 0 || cooldownRemainingMs('birdeye') > 0;
}

const PROVIDER_LABEL: Record<'birdeye' | 'geckoterminal', string> = {
  birdeye: 'Birdeye',
  geckoterminal: 'GeckoTerminal',
};

/**
 * The interval ladder, resolved honestly — and MERGED, never either/or.
 *
 *   history: Birdeye if keyed, else GeckoTerminal (keyless, 1m floor)
 *   live edge: our own tape, which wins every bucket it observed
 *
 * The old rule was either/or: the tape replaced a full provider history the
 * moment it held 30 candles (so the chart lost everything before this
 * session), and a provider answer threw away the tape's fresher tail. Now
 * both are fetched and merged into one series — provider candles for the
 * buckets the tape never saw, tape candles for the overlap and the tail.
 *
 * Units at the seam: providers price in USD, the tape in SOL. The tape is
 * converted with SOL/USD; when that rate is unknown and a provider answered
 * in USD, the tape is DROPPED from the merge with a note — mixing units
 * would draw a false move.
 *
 * The sub-minute degrade path survives: 1s/5s/15s with no tape and no
 * Birdeye key still degrades to a 1m GeckoTerminal chart with a note saying
 * so, rather than silently looking wrong.
 */
export async function candles(mint: string, interval: CandleInterval, limit = 500): Promise<CandleSeries> {
  const c = need();
  const s = await summary(mint);
  const solUsd = usable('jupiter') ? await jup.solUsd() : null;
  const supply = s.circSupply;
  const cacheKey = `${mint}:${interval}`;

  const base: CandleSeries = {
    mint,
    interval,
    unit: 'usd',
    candles: [],
    source: 'none',
    supplyForMcap: supply,
    note: null,
  };

  const subMinute = interval === '1s' || interval === '5s' || interval === '15s';

  // Our own tape, priced in SOL; converted (or honestly dropped) at the seam.
  const tapeSol: Candle[] = tape.supports(interval) ? tape.candles(mint, interval, limit) : [];
  const tapeUsd: Candle[] | null = tape.convertSolCandles(tapeSol, solUsd);

  // A thin tape still deserves its "filling in" note; a real one does not.
  const fromTape = (): CandleSeries => ({
    ...base,
    unit: tapeUsd ? 'usd' : 'sol',
    candles: tapeUsd ?? tapeSol,
    source: 'engine',
    note:
      tapeSol.length < 5
        ? `Built from this app’s own live feed — only ${tapeSol.length} ${interval} candle${tapeSol.length === 1 ? '' : 's'} so far. It fills in as the token trades.`
        : 'Built from this app’s own live feed.',
  });

  // A pump token still on its launch curve has no pool for GeckoTerminal to
  // know about (`poolAddress` is the curve itself before migration); the
  // tape IS its chart, and Birdeye (keyed, step 1) still gets its say.
  // Asking GeckoTerminal anyway cost 3–4 s per candle load on every
  // bonding-curve token (measured 2026-09-08; 7–9 s once the host was
  // parked): two calls on a 2.1 s-gap host, re-paid on each poll because
  // "nothing" is never cached. Migrated tokens keep the walk.
  const stillOnCurve = s.launchpad === 'pumpfun' && s.bondingCurvePct !== null && s.bondingCurvePct < 100;
  const skipProviderWalk = stillOnCurve;

  // 1. Provider history at the REQUESTED interval. Precedence unchanged:
  //    Birdeye when the user brought a key, else GeckoTerminal.
  let history: Candle[] | null = null;
  let historySource: 'birdeye' | 'geckoterminal' | null = null;
  if (usable('birdeye') && be.supports(interval)) {
    const rows = await be.ohlcv(c.data().birdeyeApiKey.trim(), mint, interval, limit, { priority: true });
    if (rows?.length) {
      history = rows;
      historySource = 'birdeye';
    }
  }
  if (!history && !subMinute && !skipProviderWalk && usable('geckoterminal') && gt.supports(interval)) {
    const pools = await poolsFor(mint, s, { priority: true });
    const pool = pools[0]?.address ?? s.poolAddress;
    if (pool) {
      const rows = await gt.ohlcv(pool, interval, limit, { priority: true });
      if (rows?.length) {
        history = rows;
        historySource = 'geckoterminal';
      }
    }
  }

  // 2. Merge, never either/or.
  if (history && historySource) {
    if (tapeUsd?.length) {
      const series: CandleSeries = {
        ...base,
        candles: tape.mergeCandles(history, tapeUsd, limit),
        source: 'merged',
        note: `History via ${PROVIDER_LABEL[historySource]} · live edge from this app’s own feed.`,
      };
      rememberChart(cacheKey, series);
      return series;
    }
    const series: CandleSeries = {
      ...base,
      candles: history,
      source: historySource,
      // Unit guard: a SOL-priced tape must not be mixed into a USD chart.
      note: tapeSol.length
        ? 'Live-feed candles left out of this chart — the SOL/USD rate is unknown right now and mixing SOL-priced candles into a USD series would draw a false move.'
        : null,
    };
    rememberChart(cacheKey, series);
    return series;
  }

  // 3. Sub-minute with no Birdeye and no real tape yet: degrade to a 1m
  //    GeckoTerminal chart with a note, exactly as before. A tape that can
  //    already draw the real interval skips this — real 1s beats degraded 1m.
  const TAPE_CAN_LEAD_AT = 30;
  if (subMinute && tapeSol.length < TAPE_CAN_LEAD_AT && !skipProviderWalk && usable('geckoterminal')) {
    const pools = await poolsFor(mint, s, { priority: true });
    const pool = pools[0]?.address ?? s.poolAddress;
    if (pool) {
      const rows = await gt.ohlcv(pool, '1m', limit, { priority: true });
      if (rows?.length) {
        const series: CandleSeries = {
          ...base,
          candles: rows,
          source: 'geckoterminal',
          effectiveInterval: '1m',
          note: `${interval} candles are not available from any keyless source. Showing 1m. Open this token while the engine is running to build a real ${interval} chart from the live feed, or add a Birdeye key in Settings.`,
        };
        rememberChart(cacheKey, series, true);
        return series;
      }
    }
  }

  // 4. No provider answered. The tape is still the truth we hold — and the
  //    cache may still hold the history a parked provider gave us earlier,
  //    so stitch the two rather than throwing the history away.
  const cachedNow = recallChart(cacheKey);
  const parked = chartProvidersParked();

  // "No chart source is answering" is the wrong sentence for a token still
  // on its bonding curve: NO provider indexes one, and none ever will until
  // it graduates. The only source that can exist is our own feed, so the
  // note has to say what the user can actually do about it — start the
  // engine — instead of reading like an outage (user report, 2026-09-13).
  // Any launchpad's curve, not just pump's: nothing indexes a pre-graduation
  // token on any of them.
  const onCurveNow = s.bondingCurvePct !== null && s.bondingCurvePct < 100;
  const staleNote = (ageMs: number): string =>
    onCurveNow
      ? `Not updating — this token is still on its bonding curve, so no chart provider indexes it. Showing the last loaded chart (${Math.max(1, Math.round(ageMs / 1000))}s old). Start scanning and keep this page open and Krypt draws it live from its own feed.`
      : tape.staleChartNote(ageMs, parked);

  if (tapeSol.length) {
    if (cachedNow && !cachedNow.degraded) {
      const age = Date.now() - cachedNow.at;
      const cached = cachedNow.series;
      if (cached.unit === 'usd' && tapeUsd?.length) {
        // Do NOT re-remember: the provider half is still the old fetch, and
        // refreshing `at` would both lie about its age and stop candlesTail
        // from retrying the provider once its cooldown ends.
        return {
          ...cached,
          supplyForMcap: supply,
          candles: tape.mergeCandles(cached.candles, tapeUsd, limit),
          source: 'merged',
          note: `${staleNote(age)} Live edge from this app’s own feed.`,
        };
      }
      if (cached.unit === 'sol') {
        // An all-ours chart from earlier in the session; extend it with the
        // live tape (also SOL) — this survives the tape's tick pruning.
        return {
          ...cached,
          supplyForMcap: supply,
          candles: tape.mergeCandles(cached.candles, tapeSol, limit),
          source: 'engine',
          note: 'Built from this app’s own live feed.',
        };
      }
      // USD history but no SOL/USD rate: the fuller stale chart beats a
      // unit-mixed or tape-only one.
      if (cached.candles.length > tapeSol.length) {
        return { ...cached, supplyForMcap: supply, note: staleNote(age) };
      }
    }
    if (cachedNow?.degraded && tapeSol.length < TAPE_CAN_LEAD_AT && cachedNow.series.candles.length > tapeSol.length) {
      // A stale 1m degrade chart still shows more than two fresh 1s candles.
      return {
        ...cachedNow.series,
        supplyForMcap: supply,
        note: `${cachedNow.series.note ?? ''} ${staleNote(Date.now() - cachedNow.at)}`.trim(),
      };
    }
    const series = fromTape();
    // Cache pure tape only when it does not shadow a fuller chart.
    if (!cachedNow) rememberChart(cacheKey, series);
    return series;
  }

  // 5. Nothing new at all — the last loaded chart, aged honestly, beats blank.
  if (cachedNow) {
    return {
      ...cachedNow.series,
      supplyForMcap: supply,
      note: staleNote(Date.now() - cachedNow.at),
    };
  }

  // A token still on its bonding curve has no AMM pool, so no candle
  // provider indexes it at all. That is not an error and the user should not
  // be left guessing — the only chart that can exist for it is one we build
  // ourselves from the feed.
  const onCurve = s.bondingCurvePct !== null && s.bondingCurvePct < 100;
  return {
    ...base,
    note: onCurve
      ? `This token is still on its bonding curve at ${s.bondingCurvePct?.toFixed(1)}%, so no chart provider indexes it yet. Start the engine (Start scanning) and keep this page open — Krypt will build the chart from its own live feed.`
      : subMinute
        ? `No ${interval} data. Sub-minute candles come from the live feed (start the engine and open this token) or from Birdeye with an API key.`
        : parked
          ? chartParkNote()
          : 'No candle source returned data for this token.',
  };
}

/**
 * Why there is no chart, when a provider is parked.
 *
 * It used to report the LONGER of the two waits as one "rate limited" line.
 * Once a spent allowance could park a provider for six hours that produced
 * "retrying in 21596s" — a number nobody can read, about a provider that may
 * not even be the one that would have served this chart (reported
 * 2026-09-16). So: name the providers actually down, say the wait in human
 * units, and separate a spent plan from a throttle — the first needs the
 * user to do something, the second only needs time.
 */
function chartParkNote(): string {
  const down = (['geckoterminal', 'birdeye'] as const).filter((id) => cooldownRemainingMs(id) > 0);
  if (!down.length) return 'No candle source returned data for this token.';
  const spent = down.filter((id) => parkIsQuota(id));
  const slow = down.filter((id) => !parkIsQuota(id));
  const parts: string[] = [];
  if (spent.length) {
    parts.push(
      `${spent.map((id) => PROVIDER_META[id].label).join(' and ')} ${spent.length === 1 ? 'has' : 'have'} no allowance left — ` +
        'top up the plan or switch it off in Settings.',
    );
  }
  if (slow.length) {
    parts.push(
      `${slow.map((id) => PROVIDER_META[id].label).join(' and ')} rate limited — retrying in ` +
        `${humanWait(Math.min(...slow.map((id) => cooldownRemainingMs(id))))}.`,
    );
  }
  return parts.join(' ');
}

/**
 * Incremental chart poll: only the buckets with `time >= sinceTime`, from
 * the SAME merged view `candles()` serves.
 *
 * Cheap on purpose — this is what the renderer's 1s poll calls. While the
 * cached history is younger than one full bucket the providers are not
 * touched at all: the cached series is re-merged with the live tape (the
 * only part that can have moved) and filtered. Only when the cache has aged
 * past a bucket does it fall through to the full `candles()` fetch.
 */
export async function candlesTail(mint: string, interval: CandleInterval, sinceTime: number): Promise<CandleSeries> {
  const cacheKey = `${mint}:${interval}`;
  const bucketMs = (INTERVAL_SECONDS[interval] ?? 60) * 1000;
  const hit = recallChart(cacheKey);

  if (hit && Date.now() - hit.at <= bucketMs) {
    let series = hit.series;
    if (!hit.degraded && tape.supports(interval)) {
      const tapeSol = tape.candles(mint, interval, 600);
      if (tapeSol.length) {
        if (series.unit === 'sol') {
          series = {
            ...series,
            candles: tape.mergeCandles(series.candles, tapeSol, series.candles.length + tapeSol.length),
          };
        } else {
          const solUsd = usable('jupiter') ? await jup.solUsd() : null;
          const tapeUsd = tape.convertSolCandles(tapeSol, solUsd);
          if (tapeUsd) {
            series = {
              ...series,
              candles: tape.mergeCandles(series.candles, tapeUsd, series.candles.length + tapeUsd.length),
              source: series.source === 'engine' ? 'engine' : 'merged',
            };
          }
        }
      }
    }
    return { ...series, candles: tape.candlesSince(series.candles, sinceTime) };
  }

  const full = await candlesShared(mint, interval, 500);
  return { ...full, candles: tape.candlesSince(full.candles, sinceTime) };
}

// ── Instant first paint ───────────────────────────────────────────────
//
// `candles()` above answers only after summary() (→ an 8 s-timeout RPC
// read), SOL/USD and the strictly sequential provider chain — 2–18 s on a
// cold open, and even a warm re-open waited on the whole chain. The token
// page now asks candlesFast(): whatever we already hold (the last-good
// series for this mint+interval, extended with the live tape; or the tape
// alone) goes back immediately with `pending: true`, and the full merged
// series follows as an EngineEvent `candles` push when it lands. Nothing
// is answered from cache that was not honest a moment ago, and the note
// says so.

let onSeriesReady: ((series: CandleSeries) => void) | null = null;

/** Register the push (ipc.ts broadcasts it as `{ kind: 'candles' }`). */
export function onCandlesReady(cb: (series: CandleSeries) => void): void {
  onSeriesReady = cb;
}

/** One full load per mint+interval at a time — the fast path's background
 *  upgrade and the tail poll's slow path share it. */
const loading = new Map<string, Promise<CandleSeries>>();

function candlesShared(mint: string, interval: CandleInterval, limit: number): Promise<CandleSeries> {
  const key = `${mint}:${interval}`;
  let p = loading.get(key);
  if (!p) {
    p = candles(mint, interval, limit).finally(() => loading.delete(key));
    loading.set(key, p);
  }
  return p;
}

function quickSeries(mint: string, interval: CandleInterval, limit: number): CandleSeries | null {
  const cacheKey = `${mint}:${interval}`;
  const hit = recallChart(cacheKey);
  const tapeSol: Candle[] = tape.supports(interval) ? tape.candles(mint, interval, limit) : [];
  // Synchronous reads only: whatever the caches hold, or nothing.
  const solUsd = cached<number>('jup:solusd');
  const tapeUsd = tape.convertSolCandles(tapeSol, solUsd);
  const supply = cached<TokenSummary>(`market:summary:${mint}`)?.circSupply ?? hit?.series.supplyForMcap ?? null;

  if (hit && !hit.degraded) {
    const age = Date.now() - hit.at;
    let rows = hit.series.candles;
    if (hit.series.unit === 'usd' && tapeUsd?.length) rows = tape.mergeCandles(rows, tapeUsd, limit);
    else if (hit.series.unit === 'sol' && tapeSol.length) rows = tape.mergeCandles(rows, tapeSol, limit);
    return {
      ...hit.series,
      candles: rows,
      supplyForMcap: supply,
      note: age > 30_000 ? `Refreshing — showing the chart from ${Math.round(age / 1000)} s ago.` : hit.series.note,
      pending: true,
    };
  }
  if (hit?.degraded) return { ...hit.series, supplyForMcap: supply, pending: true };
  if (tapeSol.length) {
    return {
      mint,
      interval,
      unit: tapeUsd ? 'usd' : 'sol',
      candles: tapeUsd ?? tapeSol,
      source: 'engine',
      supplyForMcap: supply,
      note: 'Built from this app’s own live feed — loading history…',
      pending: true,
    };
  }
  return null;
}

/** How long the fast path waits on a full load when it holds nothing at
 *  all: enough for a token with a cached summary to answer, short enough
 *  that the page never sits on a spinner for a provider walk (7–9 s measured
 *  2026-09-08 on fresh curve tokens with the chart host parked). */
const FAST_BUDGET_MS = 1_200;

/** The honest "nothing yet" answer: no candles, marked pending, so the page
 *  keeps its spinner until the push below replaces it. */
function placeholderSeries(mint: string, interval: CandleInterval): CandleSeries {
  return {
    mint,
    interval,
    unit: 'usd',
    candles: [],
    source: 'none',
    supplyForMcap: cached<TokenSummary>(`market:summary:${mint}`)?.circSupply ?? null,
    note: 'Loading history…',
    pending: true,
  };
}

/** One push per landed load, however many fast answers were handed out
 *  while it ran. A load that answered a placeholder pushes even an empty
 *  series (the page is waiting on it to drop the spinner and show the
 *  note); one that upgraded a real quick answer pushes only when it has
 *  candles to add. */
const pushing = new Set<string>();
function pushWhenLanded(key: string, full: Promise<CandleSeries>, afterPlaceholder: boolean): void {
  if (pushing.has(key)) return;
  pushing.add(key);
  full
    .then((f) => {
      if (f.candles.length || afterPlaceholder) onSeriesReady?.(f);
    })
    .catch((err: unknown) => {
      if (!afterPlaceholder) return; // the quick answer stands; the tail poll retries
      const [mint, interval] = key.split(':') as [string, CandleInterval];
      onSeriesReady?.({ ...placeholderSeries(mint, interval), pending: false, note: `Chart load failed: ${(err as Error).message}` });
    })
    .finally(() => pushing.delete(key));
}

/**
 * Instant answer when one exists, full load otherwise — but never a long
 * one: past FAST_BUDGET_MS the caller gets a pending placeholder. Either way
 * the full merged series is (re)loaded and pushed via onCandlesReady when
 * it lands.
 */
export async function candlesFast(mint: string, interval: CandleInterval, limit = 500): Promise<CandleSeries> {
  const key = `${mint}:${interval}`;
  const quick = quickSeries(mint, interval, limit);
  const full = candlesShared(mint, interval, limit);
  if (quick) {
    pushWhenLanded(key, full, false);
    return quick;
  }
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'budget'>((res) => {
    timer = setTimeout(() => res('budget'), FAST_BUDGET_MS);
  });
  const settled = await Promise.race([
    full.then(
      (f) => ({ f }),
      (err: unknown) => ({ err }),
    ),
    budget,
  ]);
  clearTimeout(timer);
  if (settled !== 'budget') {
    if ('f' in settled) return settled.f;
    throw settled.err;
  }
  pushWhenLanded(key, full, true);
  return placeholderSeries(mint, interval);
}

// ── Holders ───────────────────────────────────────────────────────────

function tagHolder(row: HolderRow, s: TokenSummary, c: TerminalContext): HolderTag[] {
  const tags: HolderTag[] = [];
  const owner = row.owner;
  if (owner && s.creator && owner === s.creator) tags.push('dev');
  if (owner && c.walletLabel(owner)) tags.push('smart');
  if (row.pct !== null && row.pct >= 5) tags.push('whale');
  // Pump's bonding curve and AMM pools hold most of the supply pre-migration
  // and would otherwise dominate every concentration number.
  if (s.poolAddress && (row.address === s.poolAddress || owner === s.poolAddress)) tags.push('lp');
  return tags;
}

export async function holders(mint: string, limit = 50): Promise<HolderReport> {
  const c = need();
  const s = await summary(mint);

  // Birdeye gives a real list with owners; the RPC gives the top 20 accounts.
  if (usable('birdeye')) {
    const rows = await be.holders(c.data().birdeyeApiKey.trim(), mint, Math.min(100, limit));
    if (rows?.length) {
      const supply = s.circSupply ?? s.totalSupply;
      for (const r of rows) {
        // Honest null: no supply, no share — never a 0 that reads as "empty".
        r.pct = holderPct(r.amount, supply);
        r.tags = tagHolder(r, s, c);
        r.label = r.owner ? c.walletLabel(r.owner) : null;
      }
      return {
        mint,
        totalSupply: supply,
        holderCount: s.holders,
        rows: rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1)).slice(0, limit),
        source: 'birdeye',
        note: null,
      };
    }
  }

  let report = await topHoldersMemo(c.httpUrl(), mint);
  // The public RPC refuses getTokenLargestAccounts; RugCheck's keyless list
  // stands in, labelled as such, rather than an empty panel.
  if (report.source === 'none' && usable('rugcheck')) {
    const fb = await rc.holdersFallback(mint, s.circSupply ?? s.totalSupply);
    if (fb) report = fb;
  }
  for (const r of report.rows) {
    r.tags = [...new Set([...r.tags, ...tagHolder(r, s, c)])];
    r.label = r.owner ? c.walletLabel(r.owner) : null;
  }
  report.rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  report.holderCount = s.holders;
  if (report.totalSupply === null) report.totalSupply = s.circSupply ?? s.totalSupply;

  // Nobody could list the holders and nobody could even count them. The
  // keyless GeckoTerminal token/info route can usually do the second, and a
  // count with a note beats a blank panel with none — as long as the note
  // says whose count it is and does not imply a list we do not have.
  if (!report.rows.length && report.holderCount === null && usable('geckoterminal')) {
    const gtInfo = await gt.tokenInfoOn('solana', mint).catch(() => null);
    if (gtInfo && (gtInfo.holders !== null || gtInfo.top10Pct !== null)) {
      report.holderCount = gtInfo.holders;
      report.source = 'geckoterminal';
      report.note =
        gtInfo.top10Pct !== null
          ? `No holder list is available without an API key. GeckoTerminal reports ${gtInfo.holders === null ? 'no holder count' : `${gtInfo.holders} holders`} and a top-10 share of ${gtInfo.top10Pct.toFixed(1)}%.`
          : 'No holder list is available without an API key. The count above is GeckoTerminal’s.';
    }
  }
  return report;
}

// ── Holder graph (term.txt §7) ────────────────────────────────────────

/** Nodes only — free, from the holder list the panel already loaded. */
export async function holderGraph_(mint: string, limit = 40): Promise<import('./holderGraph').HolderGraph> {
  const report = await holders(mint, limit);
  return holderGraph.fromHolders(mint, report.rows);
}

/**
 * Funding analysis. EXPENSIVE and explicitly user-triggered — it costs a
 * couple of RPC calls per holder and the resulting graph reports exactly how
 * many it spent, so the price is never hidden.
 */
export async function analyseHolderGraph(mint: string, limit = 40): Promise<import('./holderGraph').HolderGraph> {
  const c = need();
  const [base, s] = await Promise.all([holderGraph_(mint, limit), summary(mint)]);
  return holderGraph.analyseFunding(c.httpUrl(), base, { creator: s.creator });
}

// ── Trades + trader scan ──────────────────────────────────────────────

export async function trades(mint: string, limit = 60): Promise<{ rows: TradeRow[]; source: string; note: string | null }> {
  const c = need();
  const s = await summary(mint);
  const solUsd = usable('jupiter') ? await jup.solUsd() : null;

  const local = tape.trades(mint, limit, (w) => c.walletLabel(w), solUsd, s.circSupply);
  if (local.length) {
    return { rows: local, source: 'engine', note: 'Live from this app’s own feed.' };
  }
  if (usable('birdeye')) {
    const rows = await be.trades(c.data().birdeyeApiKey.trim(), mint, limit);
    if (rows?.length) {
      for (const r of rows) r.label = c.walletLabel(r.wallet);
      return { rows, source: 'birdeye', note: null };
    }
  }
  return {
    rows: [],
    source: 'none',
    note: 'No live trades. Start the engine and open this token to tape it, or add a Birdeye key for historical trades.',
  };
}

export async function traderScan(mint: string): Promise<{ rows: TraderScanRow[]; note: string | null }> {
  const c = need();
  const s = await summary(mint);
  const agg = tape.traderScan(mint, (w) => c.walletLabel(w));
  if (!agg.length) {
    return {
      rows: [],
      note: 'Trader Scan runs on this app’s own tape. Open this token while the engine is running to start recording it.',
    };
  }
  const priceSol = s.priceSol;
  const solUsd = usable('jupiter') ? await jup.solUsd() : null;
  const now = Date.now();

  const rows: TraderScanRow[] = agg.map((a) => {
    // No price means the bag cannot be valued — null, not a worthless 0.
    const holdingSol = priceSol !== null ? Math.max(0, a.tokensNet) * priceSol : null;
    return {
      wallet: a.wallet,
      label: a.label,
      boughtSol: a.boughtSol,
      soldSol: a.soldSol,
      holdingSol,
      realizedPnlSol: a.soldSol - Math.min(a.boughtSol, a.soldSol),
      unrealizedPnlSol: holdingSol === null ? null : holdingSol - Math.max(0, a.boughtSol - a.soldSol),
      entryMcapUsd:
        a.entryPriceSol !== null && solUsd !== null && s.circSupply !== null
          ? a.entryPriceSol * solUsd * s.circSupply
          : null,
      holdMs: a.tokensNet > 0 ? now - a.firstAt : a.lastAt - a.firstAt,
      tags: a.label ? (['smart'] as HolderTag[]) : [],
    };
  });
  return { rows, note: 'Aggregated from this app’s own tape — covers only the window since you opened this token.' };
}

// ── Search ────────────────────────────────────────────────────────────

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Launch intel for the token page — who bought the first blocks and what they
 * still hold. Costs 1-2 pump.fun calls plus one RPC batch, memoised for 45s,
 * and shares that cache with the security report.
 */
export async function launchIntel(mint: string): Promise<LaunchIntelReport> {
  const c = need();
  if (!usable('pumpswap')) {
    return {
      mint,
      creator: null,
      supply: null,
      analysis: emptyAnalysis(),
      sniperWindowSlots: SNIPER_WINDOW_SLOTS,
      source: 'none',
      note: 'The pump.fun swap API is switched off in Settings → Market data.',
      balancesNote: null,
      generatedAt: Date.now(),
    };
  }
  return li.launchIntel(mint, c.httpUrl());
}

/** A creator's pump.fun track record. Null when unknown or switched off. */
export async function creatorHistory(creator: string): Promise<CreatorHistory | null> {
  if (!usable('pumpfun')) return null;
  return li.creatorHistory(creator);
}

export function looksLikeMint(q: string): boolean {
  return MINT_RE.test(q.trim());
}

export async function search(query: string): Promise<TokenSummary[]> {
  const q = query.trim();
  if (!q) return [];
  if (looksLikeMint(q)) return [await summary(q)];
  if (!usable('jupiter')) return [];
  const rows = await jup.search(q);
  const solUsd = await jup.solUsd();
  return rows.slice(0, 25).map((t) => {
    const s = jup.toSummary(t);
    if (s.priceSol === null && s.priceUsd !== null && solUsd) s.priceSol = s.priceUsd / solUsd;
    s.kryptScore = quickScore(s);
    return localise(s);
  });
}

/**
 * Ask the tape to start recording a mint (token page opened).
 *
 * pump.fun mints are already covered by the shared program feed. Anything
 * else MIGHT be a Meteora DBC token — the rail behind Believe, Boop and
 * others — which needs its own pool subscription because DBC events are
 * emit_cpi! and invisible to a program-level logsSubscribe.
 *
 * We do NOT decide that from the launchpad label. Provider labels are not
 * trustworthy here: `letsbonk.fun` is Raydium LaunchLab rather than DBC, and
 * a graduated `met-dbc` token's reported pool is a Meteora DLMM pool.
 *
 * Instead the engine reads the OWNER of the pool the providers named — one
 * account fetch, definitive, and immune to a label being wrong or new. It
 * replaced a transaction-history scan that cost ~13 RPC calls for every
 * non-pump token opened; on a major like BONK that saturated the public RPC
 * and left the token page stuck on its spinner while its own queries queued
 * behind the scan.
 */
export async function watch(mint: string): Promise<void> {
  const c = need();
  tape.subscribe(mint);
  // Per-mint socket FIRST, before any provider round trip: a logsSubscribe
  // on the mint delivers every transaction that touches it, so the page has
  // its live tape whether the scanner is running or not (2026-09-02: "when I
  // go to any coin it's not taped" — the tape used to exist only while the
  // launch scanner's program feed was up).
  c.watchPumpMint(mint);
  try {
    const s = await summary(mint);
    // pump.fun (curve or PumpSwap) is covered by the per-mint socket above.
    if (s.launchpad === 'pumpfun') return;
    // LaunchLab first, and it is FREE to try: its pool is a PDA of the mint,
    // so a wrong guess costs nothing and a right one needs no lookup. Its
    // events are log lines, so all open LaunchLab tokens share one
    // subscription. Only if the token is not on that rail do we pay for the
    // DBC path, which costs an account read and a socket per pool.
    if (s.dexId === 'boop-fun' || s.launchpad === 'boop') {
      c.watchBoop(mint, s.decimals);
      return;
    }
    // Both pool watchers read raw QUOTE amounts and divide by 1e9 — SOL's
    // decimals. A USDC-quoted pool would therefore price the whole live tape
    // in the wrong currency, and that tape feeds the chart, rememberPrice and
    // every advOrders trigger. The app already refuses non-SOL pools in three
    // other places (`isSolQuoted`); this path did not. A pool we cannot
    // confirm is SOL-quoted gets no tape rather than a wrong one — the page
    // works without it, and the per-mint socket above is unaffected.
    const poolIsSol = s.poolQuoteMint === null || s.poolQuoteMint === jup.WSOL_MINT;
    if (!poolIsSol) return;

    const looksLaunchLab = s.launchpad === 'bonk' || s.dexId === 'raydium-launchlab';
    if (looksLaunchLab) {
      c.watchLaunchLabPool(mint, s.decimals, s.poolAddress);
      return;
    }
    // A Raydium AMM v4 / CPMM pool — a graduated LaunchLab token, or a coin
    // that listed there directly. The label only picks what to try first:
    // the engine confirms the pool by its OWNER, and the DBC path below
    // hands a Raydium-owned pool to the same watcher when a provider
    // labelled it as something else entirely.
    const dexId = (s.dexId ?? '').toLowerCase();
    const looksRaydium = dexId.includes('raydium') && !dexId.includes('launchlab');
    if (looksRaydium) {
      c.watchRaydiumPool(mint, s.poolAddress);
      return;
    }
    c.watchDbcPool(mint, s.decimals, s.poolAddress);
  } catch {
    /* the token page still works without a live tape */
  }
}

export function unwatch(mint: string): void {
  tape.unsubscribe(mint);
  try {
    const c = need();
    c.unwatchPumpMint(mint);
    c.unwatchDbcPool(mint);
    c.unwatchLaunchLabPool(mint);
    c.unwatchBoop(mint);
    c.unwatchRaydiumPool(mint);
  } catch {
    /* context not attached — nothing to stop */
  }
}
