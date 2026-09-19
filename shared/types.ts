// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — shared types. The single contract between the Electron
// main process (engine) and the renderer. `src/**` never imports from
// `electron/**`; everything crosses via window.krypt.* using these types.
// ──────────────────────────────────────────────────────────────────────

import { DEFAULT_DATA_SETTINGS, type DataSettings } from './market';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from './alerts';
import { DEFAULT_HOTKEYS, type HotkeySettings } from './hotkeys';
export { DEFAULT_DATA_SETTINGS } from './market';
export type { DataSettings } from './market';
import type { AiSettings } from './ai';
import { DEFAULT_AI_SETTINGS } from './ai';
export type { AiSettings } from './ai';
export { DEFAULT_ALERT_SETTINGS } from './alerts';
export { DEFAULT_HOTKEYS } from './hotkeys';

export interface IpcResult<T = undefined> {
  ok: boolean;
  message: string;
  data?: T;
}

/**
 * The live-execution CAPABILITY now exists: trades are built by a maintained
 * relayer (PumpPortal Local, returns an UNSIGNED tx), then our signer
 * validates + simulates + bounds the worst-case loss before signing and
 * broadcasting. This flag only says the code path exists.
 *
 * Real broadcast additionally requires ALL of: a funded wallet, the engine
 * ARMED, execution.liveEnabled turned on by the user, and the per-trade
 * simulation loss-guard passing. Autonomous live firing was REMOVED on
 * 2026-08-16 — every real trade is user-initiated. See
 * docs/product-swarm-2026-08-16.md.
 */
export const LIVE_EXECUTION_AVAILABLE = true;

/** One held trading wallet, as the switcher sees it. Public data only —
 *  the encrypted secret never crosses IPC. */
export interface WalletSummary {
  id: string;
  label: string;
  publicKey: string;
  active: boolean;
  balanceSol: number | null;
  balanceCheckedAt: number | null;
  maxBalanceSol: number;
  homeAddress: string | null;
  createdAt: number;
}

/** A wallet group with its members resolved to public data, for the UI. */
export interface WalletGroupView {
  id: string;
  name: string;
  members: Array<{ id: string; label: string; publicKey: string }>;
}

/** Outcome of a user-initiated SOL withdrawal (wallet:withdraw). */
export interface WalletWithdrawResult {
  ok: boolean;
  message: string;
  signature?: string;
  /** Lamports actually requested/sent (resolved from 'max' server-side). */
  lamports: number;
  /** The withdrawal address the transfer went to, or null if none is set. */
  dest: string | null;
}

export interface WalletInfo {
  exists: boolean;
  /** Base58 address — safe to display. The secret never leaves the signer. */
  publicKey: string | null;
  /** Where a sweep/withdraw sends funds. */
  homeAddress: string | null;
  balanceSol: number | null;
  balanceCheckedAt: number | null;
  /** Refuse to hold more than this; warn the user above it. */
  maxBalanceSol: number;
  /** True if the OS keystore (DPAPI/Keychain) is available for encryption. */
  encryptionAvailable: boolean;
  createdAt: number | null;
  /** Local id of the ACTIVE wallet, and its label. Null when none is held. */
  id: string | null;
  label: string | null;
  /** How many wallets are held in total — the switcher only appears above 1. */
  walletCount: number;
}

export type DisarmReason =
  | 'user'
  | 'restart'
  | 'program_upgrade'
  | 'decoder_drift'
  | 'loss_limit'
  | 'no_wallet'
  /** The crash panel's stop button: the user has no working UI. */
  | 'kill_switch';

export interface LiveState {
  /** Whether live execution has been built at all (mirrors the const gate). */
  available: boolean;
  armed: boolean;
  armedAt: number | null;
  lastDisarmReason: DisarmReason | null;
}

// ── Settings ──────────────────────────────────────────────────────────

export interface RpcSettings {
  /** WebSocket endpoint used for logsSubscribe launch detection. */
  wssUrl: string;
  /** Additional WS endpoints raced in parallel with the primary. All sockets
   *  subscribe simultaneously; events are deduped by signature and the first
   *  arrival wins. An event is lost only if EVERY socket drops it — the fix
   *  for the ~20% single-socket event loss measured on 2026-07-21. */
  extraWssUrls: string[];
  /** Helius API key — free at helius.dev, the recommended one-field upgrade.
   *  Resolved via resolveRpc() at the engine boundary; never stored inside
   *  the URLs. The key is spent ONLY on execution-critical calls (live
   *  simulate/send/confirm, send-time fee estimates, tx-template sampling)
   *  via the derived `execHttpUrl` — bulk traffic (mint checks on every
   *  launch, the WS firehose) stays on free public endpoints, because the
   *  free tier's 1M credits/month die in ~30h if the firehose runs on it. */
  heliusApiKey: string;
  /** Opt-in: also add the Helius websocket to the racing feed pool. Billed
   *  BY BYTES — 2 credits per 0.1 MB of pushes — which is ~21k credits an
   *  hour at firehose rates (780k pushes/h measured), so the free tier's
   *  month lasts about two days of runtime; leave off unless on a paid plan. */
  heliusFeedSocket: boolean;
  /**
   * Monthly Helius credit ceiling. The app meters websocket bytes (2 credits
   * per 0.1 MB) plus HTTP calls and turns the feed socket OFF by itself when
   * this is reached, so an expensive switch cannot quietly become an overage
   * bill. 0 = no guard.
   *
   * Default matches the free tier. At the measured firehose (~21k credits/h
   * under byte billing) 1M buys about 48 hours.
   */
  heliusMonthlyCredits: number;
  /**
   * Feed insurance: a `blockSubscribe` standby socket on the pump program
   * that decodes trades from emit_cpi inner instructions ~200 ms behind the
   * log sockets. It loses every race while pump still emits `Program data:`
   * logs and takes over the day those go quiet (Anchor's stated direction).
   * Bandwidth: whole blocks, base64 — measured 0.5–0.9 MB/s, roughly
   * 1.5–3 GB/h while scanning. Optional in the type only so older renderer
   * code that builds a full RpcSettings literal still compiles; absent means
   * the default (on).
   */
  blockFeed?: boolean;
  /**
   * Same standby for pump-amm (post-graduation trades). OFF by default:
   * publicnode ignores a `mentionsAccountOrProgram` filter on the pAMM
   * program id (0 blocks in 45 s, three sockets), and filtering on the pAMM
   * global-config account instead works but pulls ~3.2 MB/s (~11 GB/h).
   * Turn on only on an unmetered connection.
   */
  blockFeedAmm?: boolean;
  /** Host for the block socket — MUST be one of BLOCK_FEED_WSS_URLS. The
   *  list is hardcoded and the renderer cannot extend it (no URL over IPC);
   *  publicnode is the only free host that accepts blockSubscribe (2026-08-30). */
  blockWssUrl?: string;
  /**
   * A paid endpoint of your own for the EXECUTION lane (2026-09-15).
   *
   * The fast lane used to be reachable only by pasting a Helius key, which
   * left everyone on QuickNode, Triton, Shyft or their own validator with
   * one choice: put it in `httpUrl` and pay for the bulk traffic too — the
   * mint checks on every launch, the holder reads, the template sampling.
   * This is the other half of that switch: execution-critical calls go here,
   * everything else stays on `httpUrl`.
   *
   * https only, checked main-side. Empty = the Helius key decides, exactly
   * as before. Set, it WINS over the derived Helius URL: a URL someone typed
   * is a stated intent, and silently preferring a key they also happen to
   * have would make the field a lie.
   */
  fastHttpUrl?: string;
  /**
   * The endpoint execution-critical work actually uses, derived by
   * resolveRpc() — NEVER persisted, and never handed to the renderer (see
   * the settings round-trip trap, 2026-09-08).
   *
   * Called `heliusHttpUrl` until 2026-09-15, when a key stopped being the
   * only way to fill it.
   */
  execHttpUrl?: string;
  /** HTTP JSON-RPC endpoint used for account lookups (mint safety checks). */
  httpUrl: string;
  /** Commitment level for the log subscription. `processed` = fastest. */
  commitment: 'processed' | 'confirmed';
}

export const PUBLIC_HTTP_URL = 'https://api.mainnet-beta.solana.com';

/** The only hosts the block-feed socket may connect to. Renderer-side
 *  settings can pick one; they cannot add one. Measured 2026-08-30:
 *  publicnode is the only keyless endpoint that accepts blockSubscribe
 *  (api.mainnet-beta refuses it; Helius free answers -32601). */
export const BLOCK_FEED_WSS_URLS = ['wss://solana-rpc.publicnode.com'] as const;
export const DEFAULT_BLOCK_FEED_WSS_URL: string = BLOCK_FEED_WSS_URLS[0];

/** Expand the stored RPC settings into what the engine should actually use.
 *  Pure + idempotent-in-spirit: the stored settings keep the key in ONE field
 *  so the UI never shows derived URLs and the key never persists twice. */
export function resolveRpc(rpc: RpcSettings): RpcSettings {
  const key = (rpc.heliusApiKey ?? '').trim();
  // A typed endpoint wins over a derived one: someone who pasted a URL means
  // it, and quietly preferring a key they also have would make the field a
  // lie. Either way `execHttpUrl` is the one name the engine reads.
  const fast = (rpc.fastHttpUrl ?? '').trim();
  if (!key) return fast ? { ...rpc, execHttpUrl: fast } : rpc;
  return {
    ...rpc,
    // Feed socket is opt-in: every WS push bills a credit, and the firehose
    // ran ~33k credits/hour when measured on 2026-07-21 — the free tier's
    // whole month evaporates in ~30h of runtime for a feed that public
    // sockets mostly cover anyway (racing pool dedupes across them).
    extraWssUrls: rpc.heliusFeedSocket
      ? [...(rpc.extraWssUrls ?? []), `wss://mainnet.helius-rpc.com/?api-key=${key}`]
      : rpc.extraWssUrls,
    execHttpUrl: fast || `https://mainnet.helius-rpc.com/?api-key=${key}`,
  };
}

/**
 * Which pump.fun curve variants the Solana scanner looks at.
 *
 * A "mayhem" coin trades against inflated virtual reserves — hundreds of SOL
 * rather than the standard 30 — so it can run to a six-figure cap while
 * still on the curve. That is a different instrument with different
 * mechanics, and traders split cleanly on whether they want it: some only
 * want mayhem, some want it nowhere near their feed.
 *
 * 'all' is the default and is exactly the old behaviour.
 */
export type MayhemFilter = 'all' | 'standard' | 'mayhem';

/**
 * Does a launch pass the filter?
 *
 * `isMayhem` is null when the app could not tell — the classic create-event
 * layout carries no reserves. An unknown is treated as NOT KNOWN TO BE
 * MAYHEM, which is exactly what it is: it survives 'standard' (hiding a
 * launch for a reason the app cannot state would hide a real launch) and it
 * is refused by 'mayhem' ("mayhem only" that includes unknowns is not
 * mayhem only). Both readings put the unknown on the side that makes no
 * claim the app cannot support.
 */
export function passesMayhemFilter(isMayhem: boolean | null, filter: MayhemFilter | undefined): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'mayhem') return isMayhem === true;
  return isMayhem !== true;
}

export interface StrategySettings {
  /**
   * Which curve variants reach the scanner (Solana only — the EVM
   * launchpads have no equivalent). Optional: absent on every save written
   * before 2026-09-15 and read as 'all'.
   */
  mayhemFilter?: MayhemFilter;
  /** Seconds of live flow observed before an entry decision is made. */
  evalWindowSec: number;
  /** Minimum unique (non-creator) buyers inside the eval window. */
  minUniqueBuyers: number;
  /** Minimum net SOL inflow (buys − sells) inside the eval window. */
  minNetInflowSol: number;
  /** Max share of buy volume owned by the single largest buyer (0..1). */
  maxTopBuyerShare: number;
  /** Composite opportunity score needed to enter (0..100). */
  minScore: number;
  // ── Scorer v2 gates (data-driven, 2026-07) — our recorded trades showed
  //    the old momentum gates rewarded the losing direction. These invert it:
  //    reject hype tops, favor clean books and early curve entry. ──
  /** Reject if more than this many sells occurred in the window. */
  maxSellsInWindow: number;
  /** Reject if sell volume exceeds this (SOL) — the strongest loss signal. */
  maxSellVolumeSol: number;
  /** Reject entering before this curve progress (thin exits). */
  entryCurveMinPct: number;
  /** Reject entering after this curve progress (already pumped). */
  entryCurveMaxPct: number;
  /** Reject over-crowded launches (buying the top). */
  maxUniqueBuyers: number;
  /** Reject when net inflow is suspiciously high (hype top). */
  maxNetInflowSol: number;
  /** Reject when one wallet holds more than this token share. */
  maxTopHolderShare: number;
  /** Reject when wallets in the first N ms hold more than this share. */
  maxEarlyBuyerShare: number;
  /** Window (ms) that counts as "early buyer" for bundle detection. */
  earlyBuyerWindowMs: number;
  /** Paper position size in SOL. */
  positionSizeSol: number;
  /** Maximum simultaneously open paper positions. */
  maxOpenPositions: number;
  /** Hard stop-loss, fraction of entry (0.35 = −35%). */
  stopLossPct: number;
  /** First take-profit trigger, fraction above entry (0.6 = +60%). */
  takeProfit1Pct: number;
  /** Second take-profit trigger, fraction above entry. */
  takeProfit2Pct: number;
  /** Trailing stop, fraction below peak once TP1 has fired. */
  trailingPct: number;
  /** Exit if the position is older than this and below +10%. */
  timeStopSec: number;
  /** Exit instantly when the creator sells. */
  exitOnCreatorSell: boolean;
  /** Exit when sell volume overwhelms buy volume (flow reversal). */
  exitOnFlowReversal: boolean;
  /** Pause new entries when session realized PnL drops below −this. */
  maxSessionLossSol: number;
  /** Pause new entries for a cooldown after this many losses in a row. */
  maxConsecutiveLosses: number;
  /**
   * Potential-runner alerts (2026-09-02): the scanner's job. Launches whose
   * measured graduation odds land in the top buckets are flagged and the
   * user is told; nothing is bought. See shared/runners.ts.
   */
  runnerAlerts: import('./runners').RunnerAlertSettings;
  /**
   * Open PAPER positions on qualifying launches (the old auto-entry). OFF by
   * default: six months of research found no profitable automated entry
   * (docs/strat-swarm-2026-07-24.md — negative EV even with perfect landing).
   * Kept as an opt-in research tool.
   */
  paperEntries: boolean;
}

/** See ExecutionSettings.mevMode. */
export type MevMode = 'off' | 'fast' | 'private';

export type FeeUrgency = 'normal' | 'competitive' | 'high' | 'emergency';

export interface ExecutionSettings {
  /** Priority-fee urgency percentile for entries. */
  feeUrgency: FeeUrgency;
  /** Whether to route through Jito bundles (revert-protected, exclusive). */
  useJito: boolean;
  /** Jito tip percentile target (p50/p75/p95 of the live tip floor). */
  jitoTipPercentile: 50 | 75 | 95;
  /** Free-tier staked landing via Helius Sender swqosOnly (near-zero tip). */
  useHeliusSender: boolean;
  /** Modeled compute-unit budget for a buy (before per-protocol calibration). */
  computeUnitLimit: number;
  /** Build pump buy/sell transactions locally from an on-chain-learned
   *  template (no relayer, saves its 0.5%/side fee). EXPERIMENTAL — default
   *  off; every local tx is simulated and falls back to the relayer if
   *  anything is off, so it can never lose money, but it needs a
   *  low-rate-limit RPC (a Helius key) to reliably sample its template. */
  localTxBuild: boolean;
  // ── Real execution (LIVE_EXECUTION_AVAILABLE is TRUE — this signs) ──
  /** The trading MODE: true = Live (real SOL), false = Paper (simulated).
   *  Live is the default (2026-08-29); Paper is the opt-in toggle. Changed
   *  ONLY through live:setLive, never a raw settings patch, so the persisted
   *  bit and the engine's armed state can't disagree — and every safety
   *  trip that disarms the engine also flips this bit to false, so the top
   *  bar always tells the truth. */
  liveEnabled: boolean;
  /** Hard per-trade cap on SOL spent (and the loss-guard bound). */
  maxLiveSol: number;
  /** Slippage tolerance (%) passed to the relayer. */
  /**
   * How a trade is routed, which is the only lever anyone has over
   * sandwiching on Solana.
   *
   *  'off'     — public RPC only, no tips. Cheapest, most exposed.
   *  'fast'    — public RPC + the staked and bundle lanes, tipped. Best
   *              landing odds. The transaction IS public.
   *  'private' — BUYS go to the Jito bundle lane alone: not broadcast to a
   *              public RPC, so it is not sitting in a mempool for anyone to
   *              read before it lands. Costs a tip and can miss a block.
   *              SELLS ignore this and keep every lane — being unable to
   *              exit is worse than being sandwiched on the way out.
   */
  mevMode: MevMode;
  liveSlippagePct: number;
  /** Switch to Paper once REALISED losses this live session (sum of the
   *  losing sells' PnL, from the chain) reach this many SOL. 0 = off. Capital
   *  deployed in open positions is NOT a loss — the old balance-delta rule
   *  counted every buy as one. Opt-in since 2026-08-29: a manual terminal
   *  should not switch modes under a trader's hands by default. */
  maxLiveSessionLossSol: number;
  /** Switch to Paper after this many real losing round-trips in a row.
   *  0 = off (default). */
  maxLiveConsecutiveLosses: number;
  /** Auto-sell every held token when the engine stops, the app quits, or a
   *  previous run crashed leaving tokens behind. Needs liveEnabled. */
  autoSellOnExit: boolean;
  /** Sweep realized live profits to the wallet's withdrawal address. */
  autoCashout: boolean;
  /** Sweep once unswept live profit reaches this many SOL. */
  cashoutThresholdSol: number;
}

/** One SPL token the trading wallet actually holds on-chain — the ground
 *  truth, independent of any session's position list. */
export interface WalletHolding {
  mint: string;
  tokenAccount: string;
  /** Raw base-unit amount as a decimal string (u64-safe). */
  amountRaw: string;
  uiAmount: number;
  decimals: number;
  /** Symbol if this session's engine has metadata for the mint. */
  symbol: string | null;
  /** Token program that owns the account (classic SPL or Token-2022). */
  programId?: string;
  /** Why this holding may not be sellable — a Token-2022 mint with a
   *  permanent delegate (spam airdrop), a transfer hook, or no transfers at
   *  all. Null when the mint carries nothing suspicious; absent when the
   *  mint could not be read (honest-null: unknown is not "fine"). */
  warning?: string | null;
}

/** Bump when a persisted setting must be force-corrected on existing installs.
 *  Saved settings are merged OVER defaults, so changing a default alone never
 *  reaches a user who already has the old value on disk — see
 *  `settings-store.ts` migrateUnsafe(). */
export const SETTINGS_REVISION = 6;

import { defaultBotSettings, type BotSettings } from './bots';
import { DEFAULT_EVM_SETTINGS, type EvmSettings } from './evm';
export { DEFAULT_EVM_SETTINGS } from './evm';
export type { EvmSettings } from './evm';

export interface AppSettings {
  /** Revision of the last safety migration applied to this save. Absent/0 on
   *  saves written before 2026-08-16. */
  settingsRevision: number;
  rpc: RpcSettings;
  strategy: StrategySettings;
  execution: ExecutionSettings;
  /** Krypto Bot market-data providers. Separate from `rpc` because these
   *  are third-party HTTP APIs, not Solana endpoints, and every one of them
   *  learns which tokens you look at — which is why they get their own
   *  master switch and their own privacy panel. See shared/market.ts. */
  data: DataSettings;
  /** Desktop notification behaviour for alerts (shared/alerts.ts). */
  alerts: AlertSettings;
  /** Single-keypress trading (shared/hotkeys.ts). Off by default. */
  hotkeys: HotkeySettings;
  /** Telegram / Discord bots (shared/bots.ts). Off and unpaired by default;
   *  READ-ONLY — no command can trade. */
  bots: BotSettings;
  /** BYO-key AI second opinion on a token. Off by default; keys stay main-side. */
  ai: AiSettings;
  /** Robinhood Chain (shared/evm.ts): RPC, slippage, referrer. The chain's
   *  wallet lives in its own file, not here. */
  evm: EvmSettings;
  /**
   * SOL address of whoever referred this user, collected once at onboarding.
   * They receive their share of the platform fee in the same transaction as
   * each trade. Empty means nobody was named.
   */
  referrer: string;
  /** True once the first-run flow has been shown, so it is never shown twice.
   *  Separate from `referrer` because declining to name one is a real answer. */
  onboarded: boolean;
  /** Pin a token to the watchlist when you buy it by hand. On by default:
   *  a coin you just put money into is the definition of one you want to
   *  keep an eye on, and doing it manually is the step people skip. */
  /**
   * UI language. 'system' asks the OS once at startup and is the default,
   * because someone whose machine is in Korean should not have to find a
   * setting written in English to say so.
   *
   * It moves menus, buttons, settings and onboarding. The legal documents
   * and every message about money stay English on purpose - see
   * shared/i18n/en.ts for why.
   */
  locale: import('./i18n').LocaleId;
  watchOnBuy: boolean;
  /** Record every decoded event + decision to JSONL for replay. */
  recorderEnabled: boolean;
  /**
   * Start every enabled EVM scanner as soon as the app is ready.
   *
   * Solana has its own switch (`autoStartEngine`); this is the EVM twin, so
   * an unattended run can cover all three chains.
   *
   * OFF by default and deliberately opt-in: a scanner polls RPC, and one that
   * starts itself on a chain nobody is looking at is how someone wakes up to a
   * rate-limited endpoint. It exists for the case it was written for — a long
   * unattended collection run, where the scanners must survive a restart
   * without someone at the keyboard.
   *
   * Scanning is not trading. The engine watches launches and flags them;
   * autonomous firing was removed in code on 2026-08-16 and this cannot bring
   * it back, nor does it arm any chain for live execution.
   */
  scannersAutoStart: boolean;
  /**
   * Launching tokens from inside the app. OFF by default.
   *
   * While `enabled` is false the signer's `launch` intent cannot be built, so
   * the one-signer rule applies untouched — see shared/launch.ts.
   */
  launch: import('./launch').LaunchConfig;
  /**
   * Cross-chain transfers. OFF by default and deliberately separate from
   * everything else: a bridge puts the user's funds in a third party's hands
   * for the seconds between two chains, which is a trust model nothing else in
   * this app asks of them. While it is off, the `bridge` signing intent is
   * never constructed, so the signer refuses a bridge exactly as it did before
   * the feature existed.
   */
  bridge: { enabled: boolean };
  /**
   * Lite mode. Replaces the WebGL scenes (the Dashboard observatory, the
   * Wallet tome) with a still — they are decoration that renders every frame
   * through the GPU driver, the one thing a user-mode app can do that
   * provokes a bad driver into a blue screen (a user's BSOD, 2026-09-08) —
   * and, since 2026-09-12, also stops every CSS transition and decorative
   * animation, blur, glow and backdrop (`html.lite`, src/state/liteMode.ts)
   * and framer-motion's transform/layout animation. Off by default. The CSS
   * side applies at once; a scene leaves on the next visit to its page.
   * Also toggled by the Hub's "Laggy?" button.
   */
  /** Accent colour. Moves the chrome only - the colours that carry meaning
   *  (emerald up, rose down, gold money) are fixed. See src/index.css. */
  theme: import('./theme').ThemeId;
  reduceEffects: boolean;
  /**
   * Let Chromium render through the GPU. Off = software rendering: slower,
   * but it never touches the graphics driver. Read before the app is ready
   * (main.ts), so it applies on the next start. Turned off automatically
   * after the GPU process dies twice in one run.
   */
  hardwareAcceleration: boolean;
  /**
   * Ceiling in GB for the recordings directory; oldest day files are pruned
   * to stay under it. 0 = no cap (deliberate, for a dedicated drive).
   *
   * Measured 2026-08-25: a single day of firehose recording reached 15 GB.
   */
  recorderMaxGb: number;
  /** Directory for recordings. Empty = userData/recordings. Set to e.g.
   *  D:\memedata to mass-collect on a big drive. */
  recorderDir: string;
  /** Firehose: record the ENTIRE Pump.fun tape (every trade of every token,
   *  all wallets) regardless of whether we track it. High volume — GBs/day. */
  recordFirehose: boolean;
  /** Shadow dip-buy detector: watch for post-capitulation survivor bounces
   *  (the only strategy family that survived the tape analysis at realistic
   *  latency) and record paper round-trips. Never trades — measurement only. */
  shadowDipBuy: boolean;
  /** Strategy Lab: run N tandem paper strategies (config-driven, honest
   *  latency fills) against the live feed, recording tagged strat_signal /
   *  strat_exit rows per strategy. Never trades — measurement only. */
  shadowStratLab: boolean;
  /** Migration-block shadow: paper-trade the big-balance migration strategy
   *  (5 SOL, 5 s hold, 5% slippage cap) across arrival lanes on every
   *  PumpSwap migration, honest constant-product fills from the observed AMM
   *  tape. Never trades — measurement only. */
  shadowMigration: boolean;
  /** Discord Rich Presence. */
  discordRpcEnabled: boolean;
  /** Auto-start the engine when the app opens. */
  autoStartEngine: boolean;
  /**
   * v1 is shadow-mode only: the engine makes real decisions with real
   * latency but never signs or submits a transaction. Kept in settings so
   * the execution build can flip it later — the UI shows it honestly.
   */
  shadowMode: true;
}

// ── Engine status ─────────────────────────────────────────────────────

export type FeedState = 'stopped' | 'connecting' | 'live' | 'reconnecting';

export interface FeedSocketStatus {
  url: string;
  host: string;
  state: FeedState;
  /** Notifications this socket delivered (pre-dedupe). */
  events: number;
  /** Notifications where this socket was first — its share of the race. */
  wins: number;
}

export interface EngineStatus {
  running: boolean;
  feed: FeedState;
  /** Last slot seen on the subscription. */
  slot: number;
  /** Rolling average ms between chain event and local decode finish. */
  decodeLatencyMs: number;
  /** Events per second over the last 10s. */
  eventsPerSec: number;
  launchesSeen: number;
  launchesEvaluated: number;
  launchesEntered: number;
  /** Potential runners flagged this session (see shared/runners.ts). */
  runnersFlagged: number;
  launchesRejected: number;
  /**
   * Launches the curve-variant filter turned away before anything looked at
   * them (`strategy.mayhemFilter`). Counted separately from `rejected`,
   * which is a strategy decision about a launch it DID evaluate — a filter
   * that quietly inflated the rejection count would misreport the scanner's
   * own hit rate. Optional: absent on a status built before 2026-09-15.
   */
  launchesFiltered?: number;
  /**
   * When the LIVE session's counters last started from zero, and why.
   *
   * The session ledger shows two different accountings — paper positions
   * when idle, live-session counters when armed — and swaps between them the
   * moment `liveActive` changes. To anyone watching, that swap is
   * indistinguishable from the numbers being wiped, which is what a user
   * reported on 2026-09-16 ("the session ledger resets"). Both resets are
   * deliberate (arming rebaselines the loss breakers on purpose), so the fix
   * is not to stop resetting — it is to say so. Absent on a status built
   * before this existed; null when nothing has started a live session.
   */
  liveSessionStartedAt?: number | null;
  liveSessionReason?: string | null;
  openPositions: number;
  closedPositions: number;
  /** Paper PnL in SOL, after modeled fees. */
  realizedPnlSol: number;
  startedAt: number | null;
  /** Circuit breakers / fail-closed guards. Null reason = entries allowed. */
  entriesPaused: boolean;
  pauseReason: string | null;
  /** Known-event payloads that failed layout parsing (decoder drift signal). */
  layoutErrors: number;
  /** Per-socket state of the racing feed pool. Block-feed standby sockets
   *  appear here too, with host `<host>:block`. */
  feedSockets: FeedSocketStatus[];
  /** Feed-insurance watchdog (engine.ts). `emitDropped` flips true when
   *  pump Buy/Sell logs stop decoding while the block socket delivers —
   *  i.e. pump dropped `emit!` and the block path is carrying the feed. */
  feedInsurance?: { emitDropped: boolean; blockDelivering: boolean; undecodedPct: number | null };
  /** Estimated feed event-loss % over the last 15 min via reserve-continuity
   *  checks (null until enough trades observed). Healthy: <2. */
  feedLossPct: number | null;
  /** Legacy autonomous-live indicator. Autonomous firing was removed
   *  2026-08-16 (manual execution only), so this is now always false. */
  liveActive: boolean;
  /** Real buys/sells placed this session. */
  liveBuys: number;
  liveSells: number;
  /** Actual wallet-balance change since live went active, in SOL (null if not live). */
  liveRealizedPnlSol: number | null;
  /** Current trading-wallet balance in SOL (null if unread). */
  walletBalanceSol: number | null;
}

// ── Launches ──────────────────────────────────────────────────────────

export type LaunchPhase =
  | 'detected'      // create event decoded, risk checks running
  | 'evaluating'    // inside the live-flow window
  | 'rejected'      // hard reject or failed entry filters
  | 'entered'       // paper position opened
  | 'flagged'       // potential runner — alerted, nothing bought
  | 'completed'     // bonding curve completed (migration)
  | 'stale';        // eval window passed without qualifying

export interface RiskFlag {
  id: string;
  label: string;
  /** true = hard reject, false = informational penalty */
  hard: boolean;
}

export interface LiveFlow {
  uniqueBuyers: number;
  buys: number;
  sells: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  netInflowSol: number;
  /** Buyers in the second half of the window vs the first half. */
  buyerAcceleration: number;
  topBuyerShare: number;
  creatorSold: boolean;
  curveProgressPct: number;
  /** Distinct wallets that sold in the window (sell-pressure signal). */
  distinctSellers: number;
  /** Largest single wallet's share of circulating tokens (0..1). */
  topHolderTokenShare: number;
  /** Combined share held by wallets that bought in the early window (0..1). */
  earlyBuyerShare: number;
}

export interface ScoreBreakdown {
  safety: number;        // 0..20
  creator: number;       // 0..18
  sellPressure: number;  // 0..18  (clean book = high; any sell caps it)
  entryTiming: number;   // 0..12  (band-shaped, rewards early curve entry)
  crowd: number;         // 0..8   (band-shaped, penalizes over-hyped tops)
  concentration: number; // 0..14  (token-weighted holder distribution)
  metadata: number;      // 0..10
  penalties: number;     // subtracted
  total: number;         // 0..100
}

export interface LaunchRow {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  bondingCurve: string;
  signature: string;
  slot: number;
  detectedAt: number;
  phase: LaunchPhase;
  riskFlags: RiskFlag[];
  flow: LiveFlow;
  score: ScoreBreakdown | null;
  /** Latest price in SOL per token (from virtual reserves). */
  priceSol: number;
  /** Rolling price series for sparklines (display floats, capped). */
  priceHistory: number[];
  /** Why the launch was rejected / went stale, if it did. */
  reason: string | null;
  /** Creator intel from the local history db. */
  creatorPriorLaunches: number;
  creatorPriorRugs: number;
  /** Watched "smart" wallets that bought this launch (research: participation
   *  as a signal). smartEarly = at least one bought within the early window. */
  smartBuyerCount: number;
  smartEarly: boolean;
}

export interface WatchedWallet {
  address: string;
  label: string;
  addedAt: number;
}

/** One row of the backtest dataset — a closed round-trip with the features
 *  observed at the entry decision and the realized outcome. */
export interface BacktestTrade {
  score: number;
  uniqueBuyers: number;
  netInflowSol: number;
  sells: number;
  sellVolSol: number;
  curvePct: number;
  topHolderShare: number;
  earlyBuyerShare: number;
  smartBuyerCount: number;
  pnlSol: number;
  exit: string;
  win: boolean;
}

// ── Positions ─────────────────────────────────────────────────────────

export type PositionState =
  | 'open'
  | 'take_profit_1'
  | 'trailing'
  | 'closed';

export type ExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'time_stop'
  | 'creator_sell'
  | 'flow_reversal'
  | 'curve_complete'
  | 'kill_switch'
  | 'engine_stopped'
  /** The launch tx never confirmed — it lived on a dropped fork. The
   *  position is voided (PnL zeroed) rather than counted. */
  | 'orphaned';

export interface PaperPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  state: PositionState;
  openedAt: number;
  closedAt: number | null;
  entryPriceSol: number;
  /** Tokens bought with the paper SOL, after curve math + fees. */
  tokenAmount: number;
  remainingTokens: number;
  costSol: number;
  /** SOL recovered so far from partial + final exits. */
  recoveredSol: number;
  currentPriceSol: number;
  peakPriceSol: number;
  pnlSol: number;
  pnlPct: number;
  exitReason: ExitReason | null;
  events: Array<{ at: number; label: string }>;
  /** True once a REAL on-chain buy backs this position (autonomous live). */
  live?: boolean;
}

// ── Orders (Phase-2 foundation — exactly-once economic intent) ────────

export type OrderState =
  | 'created'
  | 'policy_validated'
  | 'policy_rejected'
  | 'persisted'
  | 'filled_paper'   // shadow mode terminal state
  | 'reconciled';

export interface OrderIntent {
  /** Deterministic client order id: one intent → at most one position. */
  id: string;
  mint: string;
  symbol: string;
  side: 'buy';
  quoteLamports: string; // bigint as string across IPC/JSONL
  state: OrderState;
  createdAt: number;
  policyNote: string | null;
  stateLog: Array<{ at: number; state: OrderState; note?: string }>;
}

// ── Shadow send plans (what a LIVE send would do — never executed) ────

export interface SendLanePlan {
  lane: 'helius-sender' | 'jito-bundle' | 'rpc-fallback';
  detail: string;
  tipLamports: number;
}

export interface ShadowSendPlan {
  mint: string;
  symbol: string;
  builtAt: number;
  /** Prewarmed accounts the buy would reference. */
  bondingCurve: string;
  creatorVault: string;
  associatedTokenAccount: string;
  /** Compute-unit price (micro-lamports) and its source. */
  computeUnitPrice: number;
  computeUnitLimit: number;
  feeSource: string;
  /** Lanes the tx would fan out to (same signature — runtime dedupes). */
  lanes: SendLanePlan[];
  /** Modeled all-in cost in lamports: priority fee + tip + base + rent. */
  estCostLamports: number;
  /** Always true in v1 — this plan was NOT signed or submitted. */
  shadow: true;
}

// ── History (aggregated from the JSONL recordings on disk) ────────────

export interface HistoryClose {
  at: number;
  mint: string;
  reason: string;
  pnlSol: number;
  pnlPct: number;
}

export interface HistorySummary {
  /** Files scanned + the time span covered. */
  files: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Lifetime counts across every recorded session. */
  launches: number;
  trades: number;
  entered: number;
  closed: number;
  /** Decision tallies: enter / reject / pass / blocked. */
  decisions: Record<string, number>;
  /** Exit-reason tallies. */
  exitReasons: Record<string, number>;
  realizedPnlSol: number;
  wins: number;
  losses: number;
  best: number;
  worst: number;
  /** Cumulative realized-PnL series (downsampled), for the equity chart. */
  equity: Array<{ t: number; v: number }>;
  /** Launches + entries per hour bucket. */
  hourly: Array<{ label: string; launches: number; entries: number }>;
  /** Most recent closes (capped). */
  recentCloses: HistoryClose[];
}

export interface ExecutionSnapshot {
  feeEstimate: {
    p50: number; p75: number; p90: number; p95: number; source: string;
  } | null;
  tipFloor: { p50Lamports: number; p75Lamports: number; p95Lamports: number; ok: boolean } | null;
  recentPlans: ShadowSendPlan[];
}

// ── Engine → renderer event stream ────────────────────────────────────

/**
 * What a desktop notification is ABOUT.
 *
 * Carried so a click can open the token (main owns the Notification and
 * therefore the click; the engine owns the router channel) and so a Discord
 * webhook post can link to it.
 */
export interface NotifyTarget {
  mint: string;
  chain: import('./evm').ChainKind;
}

export type EngineEvent =
  | { kind: 'status'; status: EngineStatus }
  | { kind: 'launch'; launch: LaunchRow }
  | { kind: 'launchUpdate'; launch: LaunchRow }
  | { kind: 'position'; position: PaperPosition }
  | { kind: 'positionUpdate'; position: PaperPosition }
  | { kind: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; message: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; line: string; at: number }
  /** Advanced-order list changed (created, triggered, filled, cancelled). */
  | { kind: 'orders'; snapshot: import('./orders').OrdersSnapshot }
  /** Alert list changed (created, fired, muted, removed). */
  | { kind: 'alerts'; alerts: import('./alerts').Alert[] }
  /** Copy-trade configs or results changed. */
  | { kind: 'copy'; snapshot: import('./copytrade').CopySnapshot }
  /** User scripts and rules changed — a save, a fire, a refusal, a log line. */
  | { kind: 'automation'; snapshot: import('./automation').ScriptSnapshot }
  /** A script asked to pin (or unpin) a token on the renderer's Watchlist. */
  | { kind: 'pin'; mint: string; on: boolean }
  /**
   * Open this token's page. Sent when someone CLICKS a desktop notification.
   *
   * Until 2026-09-13 a notification was a dead end: it told you a runner had
   * been flagged and clicking it did nothing at all, so the one action it was
   * pushing you toward — look at the coin — still meant finding it by hand.
   * The click handler lives in main (only main has the Notification), and
   * this is how it reaches the router.
   */
  | { kind: 'openToken'; mint: string; chain: import('./evm').ChainKind }
  /** The portfolio was rebuilt (by any caller). Pages paint from it instead
   *  of each asking for their own build (2026-09-08: Portfolio took 5–7 s to
   *  show anything, every visit). */
  | { kind: 'portfolio'; summary: import('./portfolio').PortfolioSummary }
  /** The wallet's token accounts were re-read and differ from the last snapshot. */
  | { kind: 'holdings'; data: WalletHolding[]; at: number }
  /** The active signer changed — every renderer cache keyed by wallet is void. */
  | { kind: 'walletSwitched'; publicKey: string | null }
  /**
   * A live trade on a mint the terminal has open (tape-subscribed). Priced
   * in SOL per token — the renderer converts to the chart's unit, and drops
   * the tick if it cannot (no unit mixing). Throttled main-side to at most
   * 8/s per mint: `volSol` is the SUM over the throttle window, `priceSol`
   * and `isBuy` are the latest trade's. `time` is epoch SECONDS.
   */
  | { kind: 'tick'; mint: string; time: number; priceSol: number; volSol: number; isBuy: boolean }
  /**
   * A chart series finished loading in the background. `market.candles`
   * answers the token page from cache/tape FIRST so the chart paints at once,
   * then pushes the provider-merged series here when it lands. The renderer
   * applies it only if the mint+interval are still the ones on screen.
   */
  | { kind: 'candles'; series: import('./market').CandleSeries }
  /**
   * A real trade's lifecycle, pushed the moment each stage is known so the
   * position panel never waits on a poll: `landed` = seen on chain (processed
   * or better), `reconciled` = the ledger booked the on-chain delta,
   * `failed` = reverted or expired. `side` is the user's intent.
   */
  | { kind: 'fill'; mint: string; side: 'buy' | 'sell'; signature: string; state: 'landed' | 'reconciled' | 'failed' }
  /** A paper fill was booked (never on chain): the position panel and the
   *  Trades tab reload, like they do for a real fill. */
  | { kind: 'paper'; mint: string; side: 'buy' | 'sell' }
  /** A launch was flagged as a potential runner (see shared/runners.ts). */
  | { kind: 'runner'; runner: import('./runners').RunnerFlag }
  /** The whole flag list, pushed when expiry removed some of it. */
  | { kind: 'runners'; runners: import('./runners').RunnerFlag[] }
  /** EVM rail (shared/evm.ts). A fill that landed, reconciled or failed on
   *  `fill.chain`; the panels re-read that chain's portfolio on it. */
  | { kind: 'evmFill'; fill: import('./evm').EvmFill; state: 'landed' | 'reconciled' | 'failed' }
  /** Arm state or active wallet changed on one EVM chain (`state.chain`). */
  | { kind: 'evmState'; state: import('./evm').EvmState }
  /**
   * One EVM chain's Observatory moved. `status.chain` says which, and a
   * renderer showing another chain must ignore it — the scanners are
   * isolated, so an event carries one chain's numbers and never a blend.
   */
  | { kind: 'evmScan'; status: import('./evmScan').EvmScanStatus };

export interface EngineSnapshot {
  status: EngineStatus;
  launches: LaunchRow[];
  positions: PaperPosition[];
  settings: AppSettings;
  /** Potential runners flagged this session, newest first. */
  runners: import('./runners').RunnerFlag[];
}

// ── Defaults ──────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: AppSettings = {
  settingsRevision: SETTINGS_REVISION,
  rpc: {
    wssUrl: 'wss://api.mainnet-beta.solana.com',
    // Free keyless second socket for the racing pool. Add a Helius/QuickNode
    // WS URL here (Settings > Solana RPC) for a third — more sockets = less loss.
    extraWssUrls: ['wss://solana-rpc.publicnode.com'],
    heliusApiKey: '',
    fastHttpUrl: '',
    heliusFeedSocket: false,
    httpUrl: 'https://api.mainnet-beta.solana.com',
    commitment: 'processed',
    heliusMonthlyCredits: 1_000_000,
    blockFeed: true,
    blockFeedAmm: false,
    blockWssUrl: DEFAULT_BLOCK_FEED_WSS_URL,
  },
  strategy: {
    evalWindowSec: 15,
    minUniqueBuyers: 5,
    minNetInflowSol: 1,
    maxTopBuyerShare: 0.4,
    minScore: 58,
    // Data-refit on 150 real round-trips (2026-07-19): requiring a COMPLETELY
    // clean book at entry (0 sells) removed 27 creator-dump losers worth
    // −0.16 SOL; tightening the crowd/inflow caps compounded it. In-sample
    // this lifted win 43%→51% and total PnL +0.54→+0.83.
    maxSellsInWindow: 0,
    maxSellVolumeSol: 0.4,
    entryCurveMinPct: 4,
    entryCurveMaxPct: 22,
    maxUniqueBuyers: 11,
    maxNetInflowSol: 18,
    maxTopHolderShare: 0.25,
    maxEarlyBuyerShare: 0.45,
    earlyBuyerWindowMs: 2000,
    positionSizeSol: 0.1,
    maxOpenPositions: 3,
    stopLossPct: 0.35,
    takeProfit1Pct: 0.6,
    takeProfit2Pct: 1.5,
    trailingPct: 0.25,
    timeStopSec: 90,
    exitOnCreatorSell: true,
    exitOnFlowReversal: true,
    maxSessionLossSol: 0.5,
    maxConsecutiveLosses: 4,
    mayhemFilter: 'all',
    runnerAlerts: { enabled: true, minBucket: 'top1_5', maxPerHour: 12, webhookUrl: '' },
    paperEntries: false,
  },
  execution: {
    feeUrgency: 'competitive',
    useJito: true,
    jitoTipPercentile: 75,
    useHeliusSender: true,
    computeUnitLimit: 120_000,
    // 2026-07-24 swarm: relayer fees (0.5%/side) alone exceed the best gross
    // drift ever measured, so local building is a cost-floor prerequisite —
    // but it decides which accounts a SIGNED instruction touches and has no
    // golden-fixture coverage (2026-08-16 product swarm, §8). Default OFF
    // until test/txBuilder fixtures exist; opt in from the Execution page.
    localTxBuild: true,
    liveEnabled: true,
    maxLiveSol: 0.05,
    mevMode: 'fast',
    liveSlippagePct: 12,
    maxLiveSessionLossSol: 0,
    maxLiveConsecutiveLosses: 0,
    // 2026-08-16: was `true`, which market-dumped EVERY SPL token the wallet
    // held — not just this session's positions — on the ordinary Stop button.
    // Off by default; scoping sellAllHeld to session-opened mints is tracked
    // separately.
    autoSellOnExit: false,
    autoCashout: false,
    cashoutThresholdSol: 0.05,
  },
  data: structuredClone(DEFAULT_DATA_SETTINGS),
  alerts: structuredClone(DEFAULT_ALERT_SETTINGS),
  hotkeys: structuredClone(DEFAULT_HOTKEYS),
  bots: defaultBotSettings(),
  ai: DEFAULT_AI_SETTINGS,
  evm: { ...DEFAULT_EVM_SETTINGS },
  referrer: '',
  onboarded: false,
  locale: 'system',
  watchOnBuy: true,
  recorderEnabled: false,
  scannersAutoStart: false,
  launch: { enabled: false, walletId: '', evmWalletId: '' },
  bridge: { enabled: false },
  theme: 'purple',
  reduceEffects: false,
  hardwareAcceleration: true,
  recorderDir: '',
  recorderMaxGb: 2,
  recordFirehose: false,
  // The three shadow modules are RESEARCH instrumentation: they trade
  // nothing, they exist to measure strategy families against the live tape,
  // and each one writes rows through the recorder and does per-event work on
  // the AMM feed. They shipped ON from the era when finding a strategy was
  // the point. That programme is over (docs/), the product is a terminal
  // someone trades in, and a fresh install should not be collecting data for
  // a study nobody is running. Off by default; the switches are in Settings
  // and an existing user's own choice is untouched (settings merge OVER
  // defaults), so this only changes what a NEW install does.
  shadowDipBuy: false,
  shadowStratLab: false,
  shadowMigration: false,
  // ON since 3.0.0, deliberately: Rich Presence publishes to the Discord
  // client on THIS machine and nothing reaches us — the privacy policy says
  // so in those words, and revision 5 turns it on for existing installs too
  // (settings-store migrateUnsafe) so the feature is not silently off for
  // everyone who predates it. One click in Settings turns it off.
  discordRpcEnabled: true,
  autoStartEngine: false,
  shadowMode: true,
};
