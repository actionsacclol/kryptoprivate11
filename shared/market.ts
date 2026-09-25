// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — market data contract.
//
// `shared/types.ts` is the ENGINE contract (the pump.fun launch scanner and
// its automation). This file is the TERMINAL contract: everything the app
// knows about a token it did not personally watch launch.
//
// The split matters. The engine's `LaunchRow` is a live, in-memory object
// that only exists for mints the WSS feed happened to catch inside this
// session. `TokenSummary` is the terminal's unit of work: it describes ANY
// mint, is assembled from pluggable providers, and is the row shape the
// Discover columns and every watchlist render.
//
// Provenance is a first-class field on purpose. A terminal that quietly
// mixes an authoritative on-chain read with a third-party API guess is the
// exact dishonesty this product is positioned against — so every number a
// user can trade on carries the source that produced it.
// ──────────────────────────────────────────────────────────────────────

/** Where a piece of market data came from. Rendered in the UI on hover. */
import type { CreatorHistory } from './launchintel';
import type { RugReport, VolatilityNote } from './rugrules';
import type { OddsReport } from './odds';

export type DataSource =
  | 'onchain'       // our own RPC read — authoritative
  | 'engine'        // our own live WSS tape — authoritative, session-scoped
  | 'jupiter'
  | 'dexscreener'
  | 'pumpfun'
  | 'geckoterminal'
  | 'pumpswap'
  | 'birdeye'
  | 'helius'
  | 'rugcheck'
  | 'metadata'      // the token's own metadata JSON, reached through the URI the chain carries
  | 'derived'       // computed locally from the above
  | 'merged'        // provider history + our live tape, one chart (candles only)
  | 'none';         // no provider could answer

export type ProviderId =
  | 'jupiter'
  | 'dexscreener'
  | 'pumpfun'
  | 'geckoterminal'
  | 'pumpswap'
  | 'birdeye'
  | 'helius'
  | 'rugcheck';

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /** Host this provider contacts — shown verbatim in the privacy panel. */
  host: string;
  /** Does it work without the user supplying a key? */
  keyless: boolean;
  /** User has switched it on in Settings. */
  enabled: boolean;
  /** Enabled AND has whatever credential it needs. */
  usable: boolean;
  /** What this provider is the source for, in plain language. */
  provides: string;
  /** Requests made this session + last error, for the diagnostics panel. */
  calls: number;
  errors: number;
  lastError: string | null;
  lastCallAt: number | null;
  /** Median round-trip over the last 20 calls, ms. */
  latencyMs: number | null;
  /** Parked after a 429: milliseconds until it is asked again, else 0. */
  cooldownMs: number;
  /** The park is a SPENT ALLOWANCE, not a throttle — it will not clear by
   *  waiting a little longer. Absent on telemetry built before 2026-09-16. */
  cooldownIsQuota?: boolean;
  /** Calls waiting in its queue right now. */
  queued: number;
  /** Requests per route this session, most-called first (2026-09-20) —
   *  which pages and pollers are spending this provider's budget. Absent
   *  on telemetry built before it existed. */
  routes?: Array<{ route: string; calls: number }>;
  /**
   * How much of this provider's per-minute budget is spent, and the budget.
   *
   * Absent when the provider has no window (a gap alone holds it) and on
   * telemetry built before 2026-09-19. This is the app's OWN accounting, not
   * the provider's: it is what the gate will enforce, which is the number
   * that decides whether the next call waits.
   */
  minuteUsed?: number;
  minuteCap?: number;
}

// ── Discovery ─────────────────────────────────────────────────────────

/** The four Discover columns. Mirrors what memecoin traders actually scan. */
export type DiscoverColumn = 'new' | 'graduating' | 'migrated' | 'trending';

export const DISCOVER_COLUMNS: DiscoverColumn[] = ['new', 'graduating', 'migrated', 'trending'];

/** Where a token was created. Drives the launchpad badge + filters. */
export type Launchpad =
  | 'pumpfun'
  | 'bonk'
  | 'moonshot'
  | 'believe'
  | 'boop'
  | 'raydium'
  | 'meteora'
  /** Pons on Robinhood Chain — a bonding curve that graduates into a locked
   *  Uniswap v4 pool at 4.2 ETH. The chain's pump.fun. */
  | 'pons'
  /** Any other Robinhood Chain listing (Uniswap, Pools.trade, Bags, …). */
  | 'robinhood'
  /** four.meme on BNB Smart Chain — a bonding curve that graduates into a
   *  PancakeSwap v2 pair at 18 BNB. The chain's pump.fun. */
  | 'fourmeme'
  /** Any other BNB Smart Chain listing (PancakeSwap, Flap, GraFun, …). */
  | 'bnb'
  | 'unknown';

export interface TokenSocials {
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  /** DexScreener "enhanced token info" paid — a weak but real filter. */
  dexPaid: boolean;
}

/** Rolling stats over one window. Every Discover filter reads these. */
export interface WindowStats {
  priceChangePct: number | null;
  volumeUsd: number | null;
  buys: number | null;
  sells: number | null;
  traders: number | null;
  /** Jupiter's organic (non-wash, non-bot) share of volume, USD. */
  organicVolumeUsd: number | null;
}

export type StatsWindow = '5m' | '1h' | '6h' | '24h';

export const STATS_WINDOWS: StatsWindow[] = ['5m', '1h', '6h', '24h'];

export const WINDOW_SECONDS: Record<StatsWindow, number> = {
  '5m': 300,
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
};

/**
 * True when a token is YOUNGER than the window its stats are being read in.
 *
 * This is why the New column looks identical whichever window you pick: a
 * token 40 seconds old has one set of trades, so its 5m, 1h and 24h volumes
 * are the same number — correctly. Without saying so, the window buttons
 * look broken. The UI marks these instead of pretending the windows differ.
 */
export function windowExceedsAge(createdAt: number | null, w: StatsWindow, nowMs = Date.now()): boolean {
  if (createdAt === null || !Number.isFinite(createdAt) || createdAt <= 0) return false;
  return (nowMs - createdAt) / 1000 < WINDOW_SECONDS[w];
}

/**
 * One row in a Discover column, one entry in a watchlist, one search hit.
 * Fields are nullable by design: a brand-new pump.fun mint has no 24h volume
 * and no holder count, and rendering `0` for "we don't know" is a lie the
 * user would trade on. `null` renders as an em dash.
 */
export interface TokenSummary {
  /**
   * The $Krypto Mode bot wallet this coin's metadata declares (a creator's
   * public trading bot — shared/kryptoMode.ts). Absent/null = none declared.
   */
  kryptoBot?: string | null;
  /**
   * Which chain this row lives on. Absent means Solana (every row written
   * before 2026-09-08). On Robinhood Chain `mint` is the 0x token address and
   * `priceSol` is the price in ETH — the field names stayed so every panel
   * that renders a row keeps working; the unit label follows `chain`.
   */
  chain?: import('./evm').ChainKind;
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  decimals: number;
  /** Creation time, ms. Null when no provider could date it. */
  createdAt: number | null;
  launchpad: Launchpad;

  priceUsd: number | null;
  priceSol: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  circSupply: number | null;
  totalSupply: number | null;

  holders: number | null;
  /** Holder count change over 24h, as a fraction (0.12 = +12%). */
  holderChange24h: number | null;

  stats: Partial<Record<StatsWindow, WindowStats>>;

  /** Bonding-curve completion 0..100. Null once migrated / not a curve token. */
  bondingCurvePct: number | null;
  /** Pool address for the primary market — the chart's subject. */
  poolAddress: string | null;
  /** Quote mint of `poolAddress`, when known. See TokenPool.quoteMint. */
  poolQuoteMint: string | null;
  dexId: string | null;

  /** Supply concentration, all 0..100. Null where unmeasured. */
  devHoldingPct: number | null;
  top10Pct: number | null;
  sniperPct: number | null;
  insiderPct: number | null;
  bundledPct: number | null;
  /** Wallets from the local smart-money DB currently holding. */
  smartHolders: number | null;

  creator: string | null;
  socials: TokenSocials;

  /** 0..100 composite, or null when too little is known to score honestly. */
  kryptScore: number | null;
  /** True when THIS session's engine has live tape for the mint. */
  liveTracked: boolean;

  /**
   * Measured rug rules (shared/rugrules.ts) for pump launches, judged from
   * the launch window. Null when no window exists for this mint yet.
   */
  rug: RugReport | null;
  /** Concentration facts with their two-sided rates — never a hide. */
  volatility: VolatilityNote[];
  /**
   * Graduation odds (shared/odds.ts) for pump launches at +60 s / +120 s.
   * Null until the window exists, when inputs are unknown, or after
   * graduation — never a base-rate stand-in.
   */
  odds: OddsReport | null;

  /**
   * Provider audit facts a list row can carry cheaply. Every field is null
   * when its provider did not answer — a missing Shield reply is not "sellable".
   */
  audit: TokenAudit;

  /** Per-field provenance for the numbers users trade on. `socials` records
   *  that SOME provider answered for socials, so "none" can be told apart
   *  from "nobody looked". */
  sources: Partial<Record<'price' | 'marketCap' | 'liquidity' | 'holders' | 'concentration' | 'security' | 'socials', DataSource>>;
  fetchedAt: number;
}

export interface TokenAudit {
  /** Jupiter `audit.devMints` — mints this creator made, cross-launchpad. */
  devMints: number | null;
  /** Jupiter `audit.devMigrations` — how many of those graduated. */
  devMigrations: number | null;
  /** Jupiter Shield NOT_SELLABLE. Null when Shield was not asked / silent. */
  notSellable: boolean | null;
  /** Shield warning types (NOT_VERIFIED, LOW_ORGANIC_ACTIVITY, ...). */
  shieldWarnings: string[];
  /** pump.fun flags. Null when the coin endpoint did not answer. */
  isBanned: boolean | null;
  nsfw: boolean | null;
  /** pump.fun king-of-the-hill timestamp, ms. */
  kingOfTheHillAt: number | null;
  /** pump.fun all-time-high market cap, USD. */
  athMarketCapUsd: number | null;
}

export function emptyAudit(): TokenAudit {
  return {
    devMints: null,
    devMigrations: null,
    notSellable: null,
    shieldWarnings: [],
    isBanned: null,
    nsfw: null,
    kingOfTheHillAt: null,
    athMarketCapUsd: null,
  };
}

/** A blank row — providers fill what they know, everything else stays null. */
export function emptySummary(mint: string): TokenSummary {
  return {
    mint,
    name: '',
    symbol: '',
    imageUrl: null,
    decimals: 6,
    createdAt: null,
    launchpad: 'unknown',
    priceUsd: null,
    priceSol: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    circSupply: null,
    totalSupply: null,
    holders: null,
    holderChange24h: null,
    stats: {},
    bondingCurvePct: null,
    poolAddress: null,
    poolQuoteMint: null,
    dexId: null,
    devHoldingPct: null,
    top10Pct: null,
    sniperPct: null,
    insiderPct: null,
    bundledPct: null,
    smartHolders: null,
    creator: null,
    socials: { twitter: null, telegram: null, website: null, dexPaid: false },
    kryptScore: null,
    liveTracked: false,
    rug: null,
    volatility: [],
    odds: null,
    audit: emptyAudit(),
    sources: {},
    fetchedAt: 0,
  };
}

// ── Filters ───────────────────────────────────────────────────────────

export interface Range {
  min: number | null;
  max: number | null;
}

const emptyRange = (): Range => ({ min: null, max: null });

/**
 * Every min/max in term.txt section 4. All optional — an untouched filter
 * set matches everything, and a filter over a field the providers did not
 * supply is SKIPPED rather than treated as a failed match (see inRange).
 */
export interface DiscoverFilters {
  /** Which stats window the volume/txn/buy/sell ranges apply to. */
  window: StatsWindow;
  ageSec: Range;
  marketCapUsd: Range;
  liquidityUsd: Range;
  volumeUsd: Range;
  txns: Range;
  buys: Range;
  sells: Range;
  buySellRatio: Range;
  holders: Range;
  holderGrowthPct: Range;
  top10Pct: Range;
  devHoldingPct: Range;
  insiderPct: Range;
  sniperPct: Range;
  bundledPct: Range;
  smartHolders: Range;
  bondingCurvePct: Range;
  kryptScore: Range;
  launchpads: Launchpad[];
  dexIds: string[];
  requireDexPaid: boolean;
  requireTwitter: boolean;
  requireTelegram: boolean;
  requireWebsite: boolean;
  /** Hide mints whose creator is in the local blacklist / has prior rugs. */
  hideBlacklistedCreators: boolean;
  /** Free-text over name/symbol/mint. */
  search: string;
}

export function emptyFilters(): DiscoverFilters {
  return {
    window: '5m',
    ageSec: emptyRange(),
    marketCapUsd: emptyRange(),
    liquidityUsd: emptyRange(),
    volumeUsd: emptyRange(),
    txns: emptyRange(),
    buys: emptyRange(),
    sells: emptyRange(),
    buySellRatio: emptyRange(),
    holders: emptyRange(),
    holderGrowthPct: emptyRange(),
    top10Pct: emptyRange(),
    devHoldingPct: emptyRange(),
    insiderPct: emptyRange(),
    sniperPct: emptyRange(),
    bundledPct: emptyRange(),
    smartHolders: emptyRange(),
    bondingCurvePct: emptyRange(),
    kryptScore: emptyRange(),
    launchpads: [],
    dexIds: [],
    requireDexPaid: false,
    requireTwitter: false,
    requireTelegram: false,
    requireWebsite: false,
    hideBlacklistedCreators: false,
    search: '',
  };
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: DiscoverFilters;
  /** Built-in presets can be reset but not deleted. */
  builtin: boolean;
}

// ── Chart ─────────────────────────────────────────────────────────────

/** Sub-minute intervals are only available for mints on the live tape. */
export type CandleInterval = '1s' | '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | '4h';

export const CANDLE_INTERVALS: CandleInterval[] = ['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h'];
export const SUBMINUTE_INTERVALS: CandleInterval[] = ['1s', '5s', '15s'];

export interface Candle {
  /** Bucket start, SECONDS (lightweight-charts' unit). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  mint: string;
  interval: CandleInterval;
  /** Candles are priced in this unit. The UI multiplies for the MC toggle. */
  unit: 'usd' | 'sol';
  candles: Candle[];
  source: DataSource;
  /** Supply used to convert price to market cap on the MC toggle. */
  supplyForMcap: number | null;
  /** Set when the request degraded (e.g. 1s asked for, 1m returned). */
  note: string | null;
  /**
   * The bucket width the candles ACTUALLY have when it differs from
   * `interval` (the 1m degrade for a sub-minute ask). The renderer must
   * bucket live ticks by this, never by the requested interval — 5 s ticks
   * appended to 1 m bars drew a false tail.
   */
  effectiveInterval?: CandleInterval;
  /**
   * True for the instant answer (last-good cache / own tape) that lets the
   * chart paint at once; the provider-merged series follows as an
   * EngineEvent `candles` push and replaces it.
   */
  pending?: boolean;
}

/**
 * Sort ascending and collapse duplicate timestamps, keeping the last value
 * for each bucket.
 *
 * Providers do return duplicates: GeckoTerminal was observed emitting the
 * same hourly bucket twice in one response. lightweight-charts throws on a
 * non-ascending series, and while the chart component defends itself, the
 * data layer should not hand out a series it knows is malformed — anything
 * else consuming candles (an indicator, an export) would have to re-learn
 * the same lesson.
 */
export function normaliseCandles(candles: Candle[]): Candle[] {
  if (candles.length < 2) return candles;
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (!Number.isFinite(c.time)) continue;
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** A fill or a tracked-wallet action, drawn on the chart. */
export type ChartMarkerKind = 'buy' | 'sell' | 'dev_sell' | 'tracked_buy' | 'tracked_sell';

export interface ChartMarker {
  time: number;
  kind: ChartMarkerKind;
  label: string;
  priceUsd: number | null;
}

// ── Security / rug analysis ───────────────────────────────────────────

export type CheckVerdict = 'pass' | 'warn' | 'fail' | 'unknown';

export interface SecurityCheck {
  id: string;
  label: string;
  verdict: CheckVerdict;
  /** One line the user can act on. Never a bare boolean. */
  detail: string;
  source: DataSource;
  /** Points this check contributes to the Krypt score when it passes. */
  weight: number;
  /**
   * 'gate' rows are weighted and can fail. 'fact' rows carry weight 0, are
   * never red, and exist to show a number — the supply-share rows, since
   * every share threshold measured lift < 1 (docs/rug-filter-2026-08-30.md §4).
   * Absent means 'gate' (older rows).
   */
  kind?: 'gate' | 'fact';
}

export interface DescriptiveFacts {
  /** Null = no provider answered for socials at all — not "none". */
  socials: { hasAny: boolean | null; twitter: boolean | null; telegram: boolean | null; website: boolean | null };
  dexPaid: {
    paid: boolean | null;
    paidAt: number | null;
    boosts: number | null;
    communityTakeover: boolean | null;
    source: DataSource;
  };
  /** NO_EDGE_NOTE from shared/rugrules.ts — why none of this is scored. */
  note: string;
}

export interface CreatorRecord {
  /** pump.fun-wide launches / graduations (creatorHistory). */
  launches: number | null;
  graduated: number | null;
  /** Jupiter's cross-launchpad count. */
  devMints: number | null;
  devMigrations: number | null;
  /** RugCheck "creator history of rugged tokens" risk. Null when silent. */
  rugcheckCreatorRugs: boolean | null;
  source: DataSource;
}

export interface SecurityReport {
  mint: string;
  /** 0..100, or null when too few checks resolved to score honestly. */
  score: number | null;
  /** How many of the weighted checks actually returned an answer. */
  checksResolved: number;
  checksTotal: number;
  checks: SecurityCheck[];
  /** Concentration block, separated because the UI charts it. */
  concentration: {
    devPct: number | null;
    top10Pct: number | null;
    top20Pct: number | null;
    insiderPct: number | null;
    sniperPct: number | null;
    bundledPct: number | null;
    /** Of total supply, what the bundle wallets STILL hold. Null when the
     *  balances could not be priced — never inferred from bundledPct. */
    bundledHeldPct: number | null;
    sniperHeldPct: number | null;
    source: DataSource;
  };
  creator: {
    address: string | null;
    priorLaunches: number | null;
    priorRugs: number | null;
    /** From the local creator DB — only counts launches WE observed. */
    source: DataSource;
    /** pump.fun-wide track record, independent of what this install saw.
     *  Null when the creator is unknown or the source did not answer. */
    history: CreatorHistory | null;
  };
  /** Measured rug rules for the launch window. Null when no window exists. */
  rug: RugReport | null;
  /** Two-sided concentration notes — the supply-share rows' real meaning. */
  volatility: VolatilityNote[];
  /** Graduation odds for the launch window (+60 s / +120 s). Null when unjudged. */
  odds: OddsReport | null;
  /** Socials / DEX-paid: shown, never scored. */
  descriptive: DescriptiveFacts;
  creatorRecord: CreatorRecord;
  generatedAt: number;
}

// ── Holders ───────────────────────────────────────────────────────────

export type HolderTag = 'dev' | 'insider' | 'sniper' | 'bundle' | 'smart' | 'fresh' | 'whale' | 'lp' | 'unknown';

export interface HolderRow {
  /** Token account address. */
  address: string;
  /** Owner wallet where resolvable. */
  owner: string | null;
  amount: number;
  /** Of total supply. Null when the supply could not be read — never 0. */
  pct: number | null;
  tags: HolderTag[];
  label: string | null;
}

/**
 * A holder's share of supply. Null — never 0 — when the supply is unknown or
 * zero, because "0 %" reads as "holds nothing" and the truth is "no idea".
 */
export function holderPct(amount: number, totalSupply: number | null): number | null {
  if (totalSupply === null || !Number.isFinite(totalSupply) || totalSupply <= 0) return null;
  if (!Number.isFinite(amount)) return null;
  return (amount / totalSupply) * 100;
}

export interface HolderReport {
  mint: string;
  totalSupply: number | null;
  holderCount: number | null;
  rows: HolderRow[];
  source: DataSource;
  note: string | null;
}

// ── Holder graph (term.txt §7) ────────────────────────────────────────

export interface GraphNode {
  /** Owner wallet, or the token account when the owner is unknown. */
  id: string;
  label: string | null;
  /** 0..100; null when supply is unknown. */
  pct: number | null;
  amount: number;
  tags: string[];
  /** Wallet age in ms, or null when not analysed / too much history. */
  ageMs: number | null;
  /** Address that appears to have funded this wallet. */
  fundedBy: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'funded' | 'sibling';
}

export interface HolderGraph {
  mint: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Wallets sharing a funder, biggest combined holding first. */
  clusters: Array<{ funder: string; members: string[]; totalPct: number }>;
  analysed: boolean;
  note: string | null;
  /** RPC calls the analysis spent — surfaced so the cost is never hidden. */
  rpcCalls: number;
}

// ── Live trades / trader scan ─────────────────────────────────────────

export interface TradeRow {
  at: number;
  signature: string | null;
  side: 'buy' | 'sell';
  wallet: string;
  label: string | null;
  solAmount: number;
  tokenAmount: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  tags: HolderTag[];
}

export interface TraderScanRow {
  wallet: string;
  label: string | null;
  boughtSol: number;
  soldSol: number;
  /** Null when the token has no price — an unpriced bag is not worth 0. */
  holdingSol: number | null;
  realizedPnlSol: number;
  unrealizedPnlSol: number | null;
  entryMcapUsd: number | null;
  holdMs: number | null;
  tags: HolderTag[];
}

// ── Token page payload ────────────────────────────────────────────────

export interface TokenPool {
  address: string;
  dexId: string;
  label: string;
  liquidityUsd: number | null;
  /**
   * The pool's QUOTE mint, when the provider named it.
   *
   * A pool quoted in USDC prices the token in dollars, not SOL. The live-tape
   * watchers divide raw quote amounts by 1e9 (SOL's decimals), so handing them
   * a non-SOL pool prices the whole tape — chart, rememberPrice and every
   * advOrders trigger — in the wrong currency. Null means unknown.
   */
  quoteMint: string | null;
}

export interface TokenDetail {
  summary: TokenSummary;
  security: SecurityReport;
  /** Pools the token trades in, best liquidity first. */
  pools: TokenPool[];
  /** Populated from the live tape when the engine is tracking this mint. */
  liveTrades: TradeRow[];
  /** Non-fatal problems worth showing: stale data, provider down, etc. */
  warnings: string[];
}

// ── Settings block (added to AppSettings) ─────────────────────────────

export interface DataSettings {
  /** Master switch. Off = the terminal shows ONLY on-chain + own-tape data. */
  networkDataEnabled: boolean;
  /** Fetch token icons. The image host is chosen by the token's creator, so
   *  loading one reveals your IP to them. Served through the main process's
   *  hardened krypt-img:// handler, never straight from the renderer. */
  loadTokenImages: boolean;
  /** Per-provider opt-in. A disabled provider is never contacted. */
  providers: Record<ProviderId, boolean>;
  /** BYO key. Empty = Birdeye stays unusable. */
  birdeyeApiKey: string;
  /** BYO key. Empty = the keyless (and retiring) `lite-api.jup.ag`; set = the
   *  successor `api.jup.ag` at its documented 1 rps. Jupiter works either
   *  way — see electron/data/http.ts. */
  jupiterApiKey: string;
  /** BYO keys for GIF backgrounds on cards and replays. Empty = that
   *  provider is not offered. Both are free and neither is required for
   *  anything else in the app. */
  giphyApiKey: string;
  tenorApiKey: string;
  /** Seconds a Discover column is reused before refetching. */
  discoverRefreshSec: number;
  /** Rows requested per Discover column. */
  discoverLimit: number;
}

export const DEFAULT_DATA_SETTINGS: DataSettings = {
  // Default ON for the keyless providers: a terminal that shows nothing on
  // first launch is not a terminal. The privacy panel in Settings names
  // every host, and the master switch turns all of it off in one click.
  networkDataEnabled: true,
  loadTokenImages: true,
  providers: {
    jupiter: true,
    dexscreener: true,
    pumpfun: true,
    geckoterminal: true,
    pumpswap: true,
    // Keyed provider stays off until a key exists — enabling it without one
    // would just produce errors in the diagnostics panel.
    birdeye: false,
    // Reuses the Helius key already in RPC settings; no-ops without it.
    helius: true,
    // Keyless. Only /report/summary and /insiders/networks are ever fetched.
    rugcheck: true,
  },
  birdeyeApiKey: '',
  jupiterApiKey: '',
  giphyApiKey: '',
  tenorApiKey: '',
  discoverRefreshSec: 8,
  discoverLimit: 40,
};

// ── Filter evaluation (shared so main and renderer agree exactly) ──────

/**
 * NUMERIC filters skip unknowns. CATEGORICAL ones do not — and the
 * difference is deliberate.
 *
 * A range like "holders >= 500" is a threshold on a quantity that simply has
 * not arrived yet: holder counts land seconds after the row does, so
 * rejecting on null would blank the NEW column the instant anyone set a
 * holder floor. Skipping is the honest reading of "I don't know yet".
 *
 * A set like `launchpads: ['pumpfun']` is the user naming which tokens they
 * want. "I don't know where this launched" is not a member of that set, so
 * it is excluded. Same for `requireTwitter` — an unverifiable social is not
 * a present one. Treating those as skips would make the filter do nothing.
 */
function inRange(v: number | null | undefined, r: Range): boolean {
  if (v === null || v === undefined || !Number.isFinite(v)) return true;
  if (r.min !== null && v < r.min) return false;
  if (r.max !== null && v > r.max) return false;
  return true;
}

/**
 * Do two refreshed rows say the same thing?
 *
 * Discover re-fetches every few seconds and gets back BRAND-NEW objects even
 * when nothing about a token moved. Handing those straight to React defeats
 * memoisation by reference and reconciles every card — about 10,000 DOM
 * elements across four columns. The provider uses this to keep the previous
 * object when the new one is equivalent, which turns the common case back
 * into a pointer comparison.
 *
 * Compares only what a row DISPLAYS. `fetchedAt` deliberately does not count:
 * it changes on every poll by definition and nothing renders it.
 */
export function sameRow(a: TokenSummary, b: TokenSummary): boolean {
  if (a === b) return true;
  if (
    a.mint !== b.mint ||
    a.symbol !== b.symbol ||
    a.name !== b.name ||
    a.imageUrl !== b.imageUrl ||
    a.priceUsd !== b.priceUsd ||
    a.priceSol !== b.priceSol ||
    a.marketCapUsd !== b.marketCapUsd ||
    a.liquidityUsd !== b.liquidityUsd ||
    a.holders !== b.holders ||
    a.kryptScore !== b.kryptScore ||
    a.bondingCurvePct !== b.bondingCurvePct ||
    a.top10Pct !== b.top10Pct ||
    a.devHoldingPct !== b.devHoldingPct ||
    a.insiderPct !== b.insiderPct ||
    a.sniperPct !== b.sniperPct ||
    a.bundledPct !== b.bundledPct ||
    a.smartHolders !== b.smartHolders ||
    a.createdAt !== b.createdAt ||
    a.launchpad !== b.launchpad ||
    a.dexId !== b.dexId ||
    a.socials.dexPaid !== b.socials.dexPaid ||
    a.socials.twitter !== b.socials.twitter ||
    a.socials.telegram !== b.socials.telegram ||
    a.socials.website !== b.socials.website ||
    (a.rug?.hide ?? null) !== (b.rug?.hide ?? null) ||
    (a.rug?.flags.length ?? -1) !== (b.rug?.flags.length ?? -1) ||
    a.volatility.length !== b.volatility.length ||
    (a.odds?.graduate?.bucket ?? null) !== (b.odds?.graduate?.bucket ?? null) ||
    (a.odds?.windowS ?? null) !== (b.odds?.windowS ?? null) ||
    a.audit.notSellable !== b.audit.notSellable ||
    a.audit.isBanned !== b.audit.isBanned
  ) {
    return false;
  }
  for (const w of STATS_WINDOWS) {
    const x = a.stats[w];
    const y = b.stats[w];
    if (x === y) continue;
    if (!x || !y) return false;
    if (
      x.volumeUsd !== y.volumeUsd ||
      x.buys !== y.buys ||
      x.sells !== y.sells ||
      x.priceChangePct !== y.priceChangePct
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Merge a refreshed page over the previous one, reusing unchanged rows.
 *
 * Returns the PREVIOUS ARRAY itself when nothing moved, so React can skip the
 * list wholesale rather than walking it. Otherwise returns a new array in
 * which every equivalent row is the old object, which is what lets a memoised
 * card compare by reference and bail out.
 */
export function reuseRows(prev: TokenSummary[], next: TokenSummary[]): TokenSummary[] {
  if (!prev.length) return next;
  const byMint = new Map(prev.map((r) => [r.mint, r]));
  let reused = 0;
  const merged = next.map((row) => {
    const old = byMint.get(row.mint);
    if (old && sameRow(old, row)) {
      reused += 1;
      return old;
    }
    return row;
  });
  return reused === next.length && next.length === prev.length ? prev : merged;
}

export function passesFilters(t: TokenSummary, f: DiscoverFilters, nowMs = Date.now()): boolean {
  const w = t.stats[f.window];
  const buys = w?.buys ?? null;
  const sells = w?.sells ?? null;
  const txns = buys !== null && sells !== null ? buys + sells : null;
  const ratio = buys !== null && sells !== null && sells > 0 ? buys / sells : null;
  const ageSec = t.createdAt !== null ? (nowMs - t.createdAt) / 1000 : null;

  if (!inRange(ageSec, f.ageSec)) return false;
  if (!inRange(t.marketCapUsd, f.marketCapUsd)) return false;
  if (!inRange(t.liquidityUsd, f.liquidityUsd)) return false;
  if (!inRange(w?.volumeUsd ?? null, f.volumeUsd)) return false;
  if (!inRange(txns, f.txns)) return false;
  if (!inRange(buys, f.buys)) return false;
  if (!inRange(sells, f.sells)) return false;
  if (!inRange(ratio, f.buySellRatio)) return false;
  if (!inRange(t.holders, f.holders)) return false;
  if (!inRange(t.holderChange24h === null ? null : t.holderChange24h * 100, f.holderGrowthPct)) return false;
  if (!inRange(t.top10Pct, f.top10Pct)) return false;
  if (!inRange(t.devHoldingPct, f.devHoldingPct)) return false;
  if (!inRange(t.insiderPct, f.insiderPct)) return false;
  if (!inRange(t.sniperPct, f.sniperPct)) return false;
  if (!inRange(t.bundledPct, f.bundledPct)) return false;
  if (!inRange(t.smartHolders, f.smartHolders)) return false;
  if (!inRange(t.bondingCurvePct, f.bondingCurvePct)) return false;
  if (!inRange(t.kryptScore, f.kryptScore)) return false;

  if (f.launchpads.length && !f.launchpads.includes(t.launchpad)) return false;
  if (f.dexIds.length && (!t.dexId || !f.dexIds.includes(t.dexId))) return false;
  if (f.requireDexPaid && !t.socials.dexPaid) return false;
  if (f.requireTwitter && !t.socials.twitter) return false;
  if (f.requireTelegram && !t.socials.telegram) return false;
  if (f.requireWebsite && !t.socials.website) return false;

  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${t.name} ${t.symbol} ${t.mint}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** The scheme the main process serves validated token icons on. */
export const IMAGE_SCHEME = 'krypt-img';

/**
 * Turn a creator-supplied https image URL into a krypt-img:// URL.
 *
 * The renderer NEVER puts the original URL in an <img src>. Everything goes
 * through the main process so the host can be resolved, checked against
 * private address ranges, size-capped and content-type-verified first. A
 * non-https input returns null, and the caller renders a letter avatar.
 */
export function imageSrc(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  const b64 = (typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(url)))
    : Buffer.from(url, 'utf8').toString('base64')
  ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${IMAGE_SCHEME}://i/${b64}`;
}

/** The six starter presets from term.txt section 4, as real filter objects. */
export function builtinPresets(): FilterPreset[] {
  const p = (id: string, name: string, patch: Partial<DiscoverFilters>): FilterPreset => ({
    id,
    name,
    builtin: true,
    filters: { ...emptyFilters(), ...patch },
  });
  return [
    p('fresh-pumpfun', 'Fresh Pump.fun', {
      launchpads: ['pumpfun'],
      ageSec: { min: null, max: 900 },
      bondingCurvePct: { min: 2, max: 60 },
    }),
    p('safe-migrated', 'Safe Migrated', {
      window: '1h',
      liquidityUsd: { min: 25_000, max: null },
      top10Pct: { min: null, max: 30 },
      devHoldingPct: { min: null, max: 3 },
      kryptScore: { min: 70, max: null },
    }),
    p('high-momentum', 'High Momentum', {
      window: '5m',
      volumeUsd: { min: 15_000, max: null },
      buySellRatio: { min: 1.4, max: null },
      liquidityUsd: { min: 8_000, max: null },
    }),
    p('low-bundles', 'Low Bundles', {
      bundledPct: { min: null, max: 8 },
      sniperPct: { min: null, max: 12 },
      devHoldingPct: { min: null, max: 2 },
    }),
    p('smart-money', 'Smart Money', {
      smartHolders: { min: 1, max: null },
      liquidityUsd: { min: 5_000, max: null },
    }),
    p('degenerate', 'Degenerate', {
      window: '5m',
      ageSec: { min: null, max: 300 },
      volumeUsd: { min: 2_000, max: null },
    }),
  ];
}

// ── Security checks (pure — the orchestrator gathers, this decides) ───
//
// Shared so `test/market.test.mjs` can pin the rules without a network:
// which rows are weighted gates, which are weightless facts, and what each
// says when its source was silent. The measured basis for the split is
// docs/rug-filter-2026-08-30.md §4 and §9: every supply-share threshold has
// lift < 1 for "dead or dumped" and together they hide 57 % of graduations,
// so those rows show a number and never a verdict.

export interface CheckInput {
  id: string;
  label: string;
  weight: number;
  /** null = could not be determined. */
  verdict: 'pass' | 'warn' | 'fail' | null;
  detail: string;
  source: DataSource;
  kind?: 'gate' | 'fact';
}

/**
 * Weighted average over the GATES that resolved. Facts are carried through
 * with weight 0 and a verdict of 'pass' or 'unknown' — never red — and count
 * toward neither `resolved` nor `total`.
 */
export function scoreChecks(
  inputs: CheckInput[],
  minResolved = 4,
): { checks: SecurityCheck[]; score: number | null; resolved: number; total: number } {
  const checks: SecurityCheck[] = [];
  let earned = 0;
  let possible = 0;
  let resolved = 0;
  let total = 0;

  for (const i of inputs) {
    const kind = i.kind ?? 'gate';
    if (kind === 'fact') {
      checks.push({
        id: i.id,
        label: i.label,
        verdict: i.verdict === null ? 'unknown' : 'pass',
        detail: i.detail,
        source: i.source,
        weight: 0,
        kind: 'fact',
      });
      continue;
    }
    checks.push({
      id: i.id,
      label: i.label,
      verdict: i.verdict ?? 'unknown',
      detail: i.detail,
      source: i.source,
      weight: i.weight,
      kind: 'gate',
    });
    total += 1;
    if (i.verdict === null) continue;
    resolved += 1;
    possible += i.weight;
    if (i.verdict === 'pass') earned += i.weight;
    else if (i.verdict === 'warn') earned += i.weight * 0.5;
  }

  const score = resolved >= minResolved && possible > 0 ? Math.round((earned / possible) * 100) : null;
  return { checks, score, resolved, total };
}

/** Everything the orchestrator could find out, already merged. */
export interface SecurityFacts {
  launchpad: Launchpad;
  bondingCurvePct: number | null;
  mint: {
    /** False when the RPC could not be read — NOT the same as "all clear". */
    checked: boolean;
    message: string;
    /** True = an authority is present. Null when unread. */
    mintAuthority: boolean | null;
    freezeAuthority: boolean | null;
    isToken2022: boolean | null;
  };
  liquidityUsd: number | null;
  liquiditySource: DataSource;
  shares: {
    devPct: number | null;
    top10Pct: number | null;
    top20Pct: number | null;
    bundledPct: number | null;
    bundledHeldPct: number | null;
    bundleWallets: number | null;
    bundleStillHolding: number | null;
    sniperPct: number | null;
    sniperHeldPct: number | null;
    sniperWindowSlots: number | null;
    /** Why the launch scan is missing, from the scanner. */
    launchNote: string | null;
    concSource: DataSource;
    launchSource: DataSource;
  };
  /** RugCheck /report/summary. `answered` false means every field below is moot. */
  rugcheck: { answered: boolean; creatorRugs: boolean | null; riskCount: number };
  /** RugCheck /insiders/networks. */
  insiders: { answered: boolean; networks: number; largestSharePct: number | null };
  /** Jupiter Shield. */
  shield: { answered: boolean; notSellable: boolean; warnings: string[] };
  creatorRecord: CreatorRecord;
  /** pump.fun `is_banned`. Null when the coin endpoint did not answer. */
  banned: boolean | null;
  localCreator: { priorLaunches: number; priorRugs: number; blacklisted: boolean } | null;
  /** pump.fun track record, pre-judged by shared/launchintel creatorVerdict. */
  history: { launches: number; verdict: 'pass' | 'warn' | 'fail' | null; detail: string } | null;
}

const RUGCHECK_SILENT = '— RugCheck did not answer';
const SHIELD_SILENT = '— Jupiter Shield did not answer';

const fmtPct = (v: number, d = 1): string => `${v.toFixed(d)}%`;

export function liquidityCheck(liquidityUsd: number | null, source: DataSource): CheckInput {
  return {
    id: 'liquidity',
    label: 'Liquidity',
    weight: 12,
    verdict: liquidityUsd === null ? null : liquidityUsd >= 25_000 ? 'pass' : liquidityUsd >= 5_000 ? 'warn' : 'fail',
    detail:
      liquidityUsd === null
        ? '— no provider priced the pool'
        : `$${Math.round(liquidityUsd).toLocaleString('en-US')} of exit liquidity.`,
    source,
  };
}

export function sellableCheck(shield: { answered: boolean; notSellable: boolean; warnings: string[] }): CheckInput {
  const info = shield.warnings.filter((w) => w !== 'NOT_SELLABLE');
  return {
    id: 'sellable',
    label: 'Sellable',
    weight: 16,
    verdict: !shield.answered ? null : shield.notSellable ? 'fail' : 'pass',
    detail: !shield.answered
      ? SHIELD_SILENT
      : shield.notSellable
        ? 'Jupiter Shield: NOT_SELLABLE — a sell through Jupiter fails for this mint.'
        : info.length
          ? `Jupiter Shield raised no sell-side warning (info: ${info.join(', ')}).`
          : 'Jupiter Shield raised no sell-side warning.',
    source: shield.answered ? 'jupiter' : 'none',
  };
}

/**
 * R5 from shared/rugrules.ts, from whichever creator record exists. Counts
 * are treated as INCLUDING the launch being looked at, so "prior" is one
 * fewer. The two thresholds carry their held-out rates (2026-07-27).
 */
export function factoryCreatorCheck(r: CreatorRecord): CheckInput {
  const launches = r.launches ?? r.devMints;
  const graduated = r.graduated ?? r.devMigrations;
  const source: DataSource = r.launches !== null ? 'pumpfun' : r.devMints !== null ? 'jupiter' : 'none';
  if (launches === null || graduated === null) {
    return {
      id: 'factory-creator',
      label: 'Launch factory',
      weight: 10,
      verdict: null,
      detail: '— no creator record from pump.fun or Jupiter',
      source: 'none',
    };
  }
  const prior = Math.max(0, launches - 1);
  const fired30 = prior >= 30 && graduated === 0;
  const fired10 = prior >= 10 && graduated === 0;
  return {
    id: 'factory-creator',
    label: 'Launch factory',
    weight: 10,
    verdict: fired30 ? 'fail' : fired10 ? 'warn' : 'pass',
    detail: fired30
      ? `Creator has ${prior} prior launches and none graduated — 93 % of such launches were dead or dumped, 0.5 % graduated (n = 6,117, 2026-07-27).`
      : fired10
        ? `Creator has ${prior} prior launches and none graduated — 92 % of such launches were dead or dumped, 0.7 % graduated (n = 9,681, 2026-07-27).`
        : prior === 0
          ? 'First launch from this creator on record.'
          : `${prior} prior launches, ${graduated} graduated.`,
    source,
  };
}

export function bannedCheck(banned: boolean | null): CheckInput {
  return {
    id: 'is-banned',
    label: 'pump.fun ban',
    weight: 10,
    verdict: banned === null ? null : banned ? 'fail' : 'pass',
    detail: banned === null ? '— pump.fun did not answer' : banned ? 'Banned by pump.fun.' : 'Not banned on pump.fun.',
    source: banned === null ? 'none' : 'pumpfun',
  };
}

export function creatorRugsCheck(rc: SecurityFacts['rugcheck']): CheckInput {
  return {
    id: 'creator-rugs',
    label: 'Creator rug history',
    weight: 12,
    verdict: !rc.answered ? null : rc.creatorRugs ? 'fail' : 'pass',
    detail: !rc.answered
      ? RUGCHECK_SILENT
      : rc.creatorRugs
        ? 'RugCheck flags a creator history of rugged tokens.'
        : `RugCheck lists no creator rug history (${rc.riskCount} risk${rc.riskCount === 1 ? '' : 's'} reported).`,
    source: rc.answered ? 'rugcheck' : 'none',
  };
}

export function insiderNetworkCheck(n: SecurityFacts['insiders']): CheckInput {
  const base = { id: 'insider-network', label: 'Insider network', weight: 10 } as const;
  if (!n.answered) return { ...base, verdict: null, detail: RUGCHECK_SILENT, source: 'none' };
  if (n.networks === 0) {
    return { ...base, verdict: 'pass', detail: 'No transfer clusters detected among holders.', source: 'rugcheck' };
  }
  const plural = n.networks === 1 ? '' : 's';
  if (n.largestSharePct === null) {
    return {
      ...base,
      verdict: null,
      detail: `RugCheck listed ${n.networks} transfer cluster${plural} without a supply share.`,
      source: 'rugcheck',
    };
  }
  const v = n.largestSharePct;
  return {
    ...base,
    verdict: v >= 25 ? 'fail' : v >= 10 ? 'warn' : 'pass',
    detail: `Largest transfer cluster holds ${fmtPct(v)} of supply (${n.networks} cluster${plural}).`,
    source: 'rugcheck',
  };
}

/** The full check list for the token page. Order is display order. */
export function securityChecks(f: SecurityFacts): CheckInput[] {
  const pumpRail = f.launchpad === 'pumpfun';
  const m = f.mint;
  const onCurve = f.bondingCurvePct !== null && f.bondingCurvePct < 100;
  const out: CheckInput[] = [];

  // Mint / freeze authority. pump.fun mints are created by the program with
  // both revoked, so on that rail the rows are facts — unless the chain says
  // otherwise, in which case the label was a lie and the gate fails.
  const pumpGuaranteed = (present: boolean | null): boolean => pumpRail && present !== true;
  const guaranteeText = m.checked
    ? 'Revoked — guaranteed by the pump.fun program (confirmed on-chain).'
    : `Revoked — guaranteed by the pump.fun program (on-chain read pending: ${m.message}).`;
  const guaranteeSource: DataSource = m.checked ? 'onchain' : 'derived';

  if (pumpGuaranteed(m.mintAuthority)) {
    out.push({ id: 'mint-authority', label: 'Mint authority', weight: 0, kind: 'fact', verdict: 'pass', detail: guaranteeText, source: guaranteeSource });
  } else {
    out.push({
      id: 'mint-authority',
      label: 'Mint authority',
      weight: 14,
      verdict: !m.checked ? null : m.mintAuthority === false ? 'pass' : pumpRail ? 'fail' : onCurve ? 'warn' : 'fail',
      detail: !m.checked
        ? `Not verified — ${m.message}`
        : m.mintAuthority === false
          ? 'Disabled. No new supply can be minted.'
          : pumpRail
            ? 'ACTIVE despite the pump.fun label — this is not a normal pump mint.'
            : onCurve
              ? 'Active — expected while the bonding curve is live.'
              : 'ACTIVE after migration. Supply can still be inflated.',
      source: 'onchain',
    });
  }

  if (pumpGuaranteed(m.freezeAuthority)) {
    out.push({ id: 'freeze-authority', label: 'Freeze authority', weight: 0, kind: 'fact', verdict: 'pass', detail: guaranteeText, source: guaranteeSource });
  } else {
    out.push({
      id: 'freeze-authority',
      label: 'Freeze authority',
      weight: 16,
      verdict: !m.checked ? null : m.freezeAuthority === false ? 'pass' : 'fail',
      detail: !m.checked
        ? `Not verified — ${m.message}`
        : m.freezeAuthority === false
          ? 'Disabled. Your tokens cannot be frozen.'
          : 'ACTIVE. The authority can freeze your account and stop you selling.',
      source: 'onchain',
    });
  }

  out.push({
    id: 'token-program',
    label: 'Token program',
    weight: 6,
    verdict: !m.checked || m.isToken2022 === null ? null : m.isToken2022 ? 'warn' : 'pass',
    detail:
      !m.checked || m.isToken2022 === null
        ? 'Not verified'
        : m.isToken2022
          ? 'Token-2022. Now standard for pump.fun, but check for transfer fees and hooks.'
          : 'Classic SPL token.',
    source: 'onchain',
  });

  out.push(liquidityCheck(f.liquidityUsd, f.liquiditySource));
  out.push(sellableCheck(f.shield));
  out.push(creatorRugsCheck(f.rugcheck));
  out.push(insiderNetworkCheck(f.insiders));
  out.push(factoryCreatorCheck(f.creatorRecord));
  if (pumpRail) out.push(bannedCheck(f.banned));

  // Creator history: a local rug beats any track record. A first launch is
  // NOT a pass — it is the absence of a record.
  const local = f.localCreator;
  const h = f.history;
  out.push({
    id: 'creator-history',
    label: 'Creator history',
    weight: 8,
    verdict: local?.blacklisted
      ? 'fail'
      : local && local.priorRugs > 0
        ? 'fail'
        : !h
          ? null
          : h.launches <= 1
            ? null
            : h.verdict,
    detail: local?.blacklisted
      ? 'Creator is on your blacklist.'
      : local && local.priorRugs > 0
        ? `${local.priorRugs} of ${local.priorLaunches} launches this install watched ended in a dump.`
        : !h
          ? 'No record — this install has not seen this creator and pump.fun did not answer.'
          : h.launches <= 1
            ? 'First launch — no record.'
            : h.detail,
    source: h ? 'pumpfun' : 'derived',
  });

  // Supply shares: facts. Measured lift < 1 for every threshold; the
  // two-sided rates live in `volatility`.
  const s = f.shares;
  const wallets = (n: number | null): string =>
    n === null ? 'an unknown number of wallets' : `${n} wallet${n === 1 ? '' : 's'}`;
  out.push({
    id: 'dev-holding',
    label: 'Dev holdings',
    weight: 0,
    kind: 'fact',
    verdict: s.devPct === null ? null : 'pass',
    detail: s.devPct === null ? '— not measured' : `Creator holds ${fmtPct(s.devPct, 2)} of supply.`,
    source: s.concSource,
  });
  out.push({
    id: 'top10',
    label: 'Top 10 concentration',
    weight: 0,
    kind: 'fact',
    verdict: s.top10Pct === null ? null : 'pass',
    detail: s.top10Pct === null ? '— not measured' : `Top 10 accounts hold ${fmtPct(s.top10Pct)} of supply.`,
    source: s.concSource,
  });
  out.push({
    id: 'top20',
    label: 'Top 20 concentration',
    weight: 0,
    kind: 'fact',
    verdict: s.top20Pct === null ? null : 'pass',
    detail: s.top20Pct === null ? '— not measured' : `Top 20 accounts hold ${fmtPct(s.top20Pct)} of supply.`,
    source: s.concSource,
  });
  out.push({
    id: 'bundled',
    label: 'Bundled supply',
    weight: 0,
    kind: 'fact',
    verdict: s.bundledPct === null ? null : 'pass',
    detail:
      s.bundledPct === null
        ? s.launchNote ?? '— not measured'
        : s.bundledHeldPct === null
          ? `${fmtPct(s.bundledPct)} of supply was bought in the launch block by ${wallets(s.bundleWallets)}.`
          : `${fmtPct(s.bundledPct)} bought in the launch block by ${wallets(s.bundleWallets)}; ${fmtPct(s.bundledHeldPct)} of supply still held${s.bundleStillHolding === null ? '' : ` by ${s.bundleStillHolding} of them`}.`,
    source: s.launchSource,
  });
  const slots = s.sniperWindowSlots === null ? 'the launch window' : `${s.sniperWindowSlots} slots of launch`;
  out.push({
    id: 'sniper',
    label: 'Sniper supply',
    weight: 0,
    kind: 'fact',
    verdict: s.sniperPct === null ? null : 'pass',
    detail:
      s.sniperPct === null
        ? s.launchNote ?? '— not measured'
        : s.sniperHeldPct === null
          ? `${fmtPct(s.sniperPct)} bought within ${slots}.`
          : `${fmtPct(s.sniperPct)} sniped within ${slots}; ${fmtPct(s.sniperHeldPct)} of supply still held.`,
    source: s.launchSource,
  });

  return out;
}

/**
 * The Discover-row score: liquidity plus the gates a list row can carry
 * (Shield, creator record, pump ban). Holder counts and socials are out —
 * holder counts are gameable at zero cost and socials have no measured
 * edge. Null under three resolved gates.
 */
export function quickScore(s: TokenSummary): number | null {
  const inputs: CheckInput[] = [
    liquidityCheck(s.liquidityUsd, s.sources.liquidity ?? 'none'),
    sellableCheck({
      answered: s.audit.notSellable !== null,
      notSellable: s.audit.notSellable === true,
      warnings: s.audit.shieldWarnings,
    }),
    factoryCreatorCheck({
      launches: null,
      graduated: null,
      devMints: s.audit.devMints,
      devMigrations: s.audit.devMigrations,
      rugcheckCreatorRugs: null,
      source: s.audit.devMints === null ? 'none' : 'jupiter',
    }),
  ];
  if (s.launchpad === 'pumpfun') inputs.push(bannedCheck(s.audit.isBanned));
  return scoreChecks(inputs, 3).score;
}

/** Socials as facts: `hasAny` is null when NO provider answered for them. */
export function describeSocials(s: TokenSummary): DescriptiveFacts['socials'] {
  const answered = s.sources.socials !== undefined && s.sources.socials !== 'none';
  if (!answered) return { hasAny: null, twitter: null, telegram: null, website: null };
  const twitter = !!s.socials.twitter;
  const telegram = !!s.socials.telegram;
  const website = !!s.socials.website;
  return { hasAny: twitter || telegram || website, twitter, telegram, website };
}

/**
 * A wait, in units a person reads.
 *
 * Seconds stopped being readable the moment a park could be hours: a spent
 * API allowance rendered as "retrying in 21596s" (reported 2026-09-16).
 * Defined here because main formats the same waits into log lines and the
 * renderer into labels, and two implementations would drift.
 */
export function humanWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 6) / 10} h`;
}
