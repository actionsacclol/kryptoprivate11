// The Krypto Bot automation engine — orchestrates feed → decode → track → risk →
// score → strategy → paper positions → recorder, exactly the pipeline from
// research.txt. Runs entirely in the Electron main process; the UI is never
// in the hot path. v1 is shadow-mode: real decisions, real latency
// accounting, zero signing.

import type {
  AppSettings,
  EngineEvent,
  EngineSnapshot,
  EngineStatus,
  LaunchRow,
  LiveFlow,
  PaperPosition,
  StrategySettings,
  WalletHolding,
} from '@shared/types';
import { passesMayhemFilter } from '@shared/types';
import { EVM_CHAIN_META, nativeSymbolOf } from '@shared/evm';
import type { EvmChainKind } from '@shared/evm';
import { FeedManager, type LogNotification } from './feed';
import { ReserveContinuity, curveFeedIsTicking } from './feedHealth';
import { DipShadow } from './dipShadow';
import { StratLab } from './stratLab';
import { MigShadow } from './migShadow';
import { decodeAmmEventEx, decodeCpiAmmEventData, executedPriceSol, PUMP_AMM_GLOBAL_CONFIG, type AmmEvent } from './ammDecoder';
import { fetchSocials, metadataLinksIfCached, type TokenSocials } from './metadata';
import { decodeCpiEventData, decodeLogsEx, logsMentionPumpTrade, PUMP_PROGRAM_ID, type PumpCreateEvent, type PumpEvent, type PumpTradeEvent } from './pumpDecoder';
import { staticChecks, checkMint, hasHardReject } from './risk';
import { computeScore } from './scoring';
import { curveProgressPct, curveProgressTokenPct, mayhemFromReserves, spotPriceSol, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS, CURVE_COMPLETE_VIRTUAL_TOKENS } from './curve';
import { oddsFeaturesFromTrades, scoreOdds } from '@shared/odds';
import type { LaunchTrade } from '@shared/launchintel';
import { runnerVerdict, runnerNotification, pruneRunners, markCreatorSold, windowAllowed, RunnerRateLimit, ODDS_TAPE_CAP, RUNNER_TTL_MS, type RunnerFlag } from '@shared/runners';
import type { NotifyTarget } from '@shared/types';
import type { ChainKind } from '@shared/evm';
import { PositionManager, type TokenMarket } from './positions';
import { noteActiveMint, parseCurve } from './txBuilder';
import { getTokenBalanceForMint, getTokenBalanceRawForMint, getAccountInfo, getMultipleAccountInfo, getSignatureStatuses, getBalance, getTokenAccountsByOwner, getTokenSupply, setRpcFallback, isEndpointRejected } from '../chain/rpcClient';
import { solToLamports } from './curve';
import * as wallet from '../system/wallet';
import * as programWatch from './programWatch';
import { verifyDecoder } from './decoderVerify';
import { scanExtraDelayMs, detectedTamper, seized, seizeMessage } from '../system/integrityGuard';
import * as policy from './policy';
import * as orders from './orders';
import * as creators from './creators';
import * as watchlist from './watchlist';
import * as recorder from './recorder';
import * as pumpAuth from '../system/pumpAuth';
import * as feeEstimator from './feeEstimator';
import * as jitoTips from './jitoTips';
import * as tradePrewarm from './prewarm';
import { quoteSellLamports, liquidationQuotes } from './jupiterRoute';
import { prewarm, bondingCurveFor, TOKEN_2022_PROGRAM, type PrewarmedAddresses } from '../chain/addresses';
import { parseMintExtensions, mintWarning } from './mintExtensions';
import * as tape from '../data/tape';
import { createChartTicks } from './chartTicks';
import { LiveCurves, LiveMigrations } from './liveCurves';
import * as market from '../data/market';
import type { CalloutFacts } from '@shared/calloutAuto';
import * as launchIntel from '../data/launchIntel';
import * as xStatsStore from '../data/xStats';
import * as linkIntel from '../data/linkIntel';
import * as siteReadStore from '../data/siteRead';
import { marketFactsFromSummary, scriptLinksFromSummary } from '@shared/automation';
import { countReuse, parseXLink } from '@shared/xLink';
import type { AiAnalysis } from '@shared/ai';
import * as advOrders from './advOrders';
import * as ledger from './ledger';
import * as scout from './walletScout';
import { rankScout, summarise, tradeId } from '@shared/walletScout';
import * as paperBook from './paperBook';
import * as walletWatcher from './walletWatcher';
import { PAPER_FILL_MODEL, paperToPosition, modelledPaperFill, paperHistoryRows } from '@shared/paper';
import * as alerts from './alerts';
import * as copyTrade from './copyTrade';
import * as kryptoHolding from './kryptoHolding';
import { KRYPTO_TOKEN, isValidMint } from '@shared/krypto';
import { liveSessionLedger } from '@shared/liveSession';
import * as automation from './automation';
import * as scriptSandbox from '../system/scriptSandbox';
import { positionPnl, type ScriptPosition } from '@shared/automation';
import * as dbcWatcher from './dbcWatcher';
import * as launchLabWatcher from './launchLabWatcher';
import * as boopWatcher from './boopWatcher';
import * as raydiumWatcher from './raydiumWatcher';
import * as heliusBudget from '../system/heliusBudget';
import * as priorityFeed from './priorityFeed';
import * as portfolio from './portfolio';
import { buildShadowPlan } from './sender';
import { shouldRetrySell, shouldRetryPreBroadcast, escalatedSellSlippagePct, nextConsecutiveLosses, liveBreakerReason } from '@shared/liveBreakers';
import { LEAN_EXIT_LAMPORTS, planBuySize, planExitBudget } from '@shared/exitBudget';
import { describeTemplate, ordersForTemplate } from '@shared/orderTemplates';
import { isPctKind } from '@shared/orders';
import * as templateStore from '../system/templateStore';
import type { DisarmReason, ExecutionSnapshot, LiveState, ShadowSendPlan } from '@shared/types';
import { DEFAULT_BLOCK_FEED_WSS_URL, LIVE_EXECUTION_AVAILABLE } from '@shared/types';

/**
 * A live trade result plus the size the engine actually SENT.
 *
 * The requested amount is a wish: the exit-headroom trim can shrink it, and
 * anything that books a cost basis off the request is wrong by asked ÷ sent
 * (copy trade audit, copy-8). The authoritative number is still the chain's
 * lamport delta, which the ledger reads back asynchronously — this is what to
 * use until it does, and it is undefined on every path that never broadcast.
 */
type EngineTradeResult = import('./liveSigner').LiveTradeResult & { sentSol?: number };

interface TrackedTrade {
  at: number;
  user: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
}

interface TrackedToken {
  row: LaunchRow;
  createEvent: PumpCreateEvent;
  trades: TrackedTrade[];
  buyersBySol: Map<string, number>;
  /** Net token balance per wallet (buys add, sells subtract) — token-weighted
   *  concentration + bundle detection (scorer v2). */
  tokensByUser: Map<string, number>;
  /** First time each wallet was seen buying — early-buyer window. */
  firstBuyAtByUser: Map<string, number>;
  /** Watched "smart" wallets that have bought this launch. */
  smartBuyers: Set<string>;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  mintChecked: boolean;
  evalDeadline: number;
  decided: boolean;
  curveComplete: boolean;
  dumpRecorded: boolean;
  /** PDAs derived at detection so the (future) hot path never blocks. */
  addr: PrewarmedAddresses | null;
  /** Every trade of the first ~2 minutes, for the odds model (which is
   *  judged at +60 s and +120 s over the launch's full tape — `trades` above
   *  is a rolling flow window and stops filling once decided). */
  oddsTrades: LaunchTrade[];
  /** The odds tape hit ODDS_TAPE_CAP: its window features are floors and
   *  the last-10-s rate is wrong, so the judge does not score it. */
  oddsTapeTruncated: boolean;
  /** Highest window already judged: 0, 60 or 120. */
  oddsJudged: 0 | 60 | 120;
  flagged: boolean;
  /** Off-chain socials once the create-time fetch resolves (null until then;
   *  the odds model's `metaTwitter` is null-tolerant — null for 4.6 % of the
   *  train set — so "not yet known" scores as unknown, never as "no"). */
  socials: TokenSocials | null;
}

/** Hypothetical trading wallet used only to shape shadow send plans.
 *  This is a fixed, well-known burn address — NOT a real key. */
const SHADOW_WALLET = '11111111111111111111111111111111';
/** pump-amm (PumpSwap) — where graduated tokens trade post-migration. */
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Graduations run ~50/hour; this holds well over a day of them. */
const AMM_POOL_MAP_CAP = 5_000;

const LAUNCH_LIST_CAP = 300;
const TRADE_WINDOW_MS = 30_000;
/** Entries require an event this fresh — stale feed means blind decisions. */
const FRESHNESS_LIMIT_MS = 3_000;
/** Known-event layout failures in the rolling window that trip fail-closed. */
const DRIFT_LIMIT = 5;
const DRIFT_WINDOW_MS = 60_000;
/** How long after entry the launch signature must be canonically visible. */
const ORPHAN_CHECK_DELAY_MS = 20_000;
const LOSS_COOLDOWN_MS = 5 * 60_000;
/**
 * A holding with nothing worth selling.
 *
 * Measured 2026-09-09 from a user's log: a balance of ONE base unit went
 * through the local builder, a Jupiter quote ("cannot compute other amount
 * threshold, with amount 1 and slippageBps 1500") and three relayer retries
 * before failing. No route exists for dust, so every attempt is spent proving
 * that again — on the panic button, ahead of exits that are real.
 *
 * Deliberately generous in what counts as REAL: any account holding at least
 * a thousandth of one whole token is sold as normal. Below that, the token
 * account's own rent exceeds the balance's value on anything but a
 * six-figure market cap, and closing it is a deliberate act, not an exit.
 */
const DUST_UI_AMOUNT = 0.001;

function isDustHolding(h: { amountRaw: string; uiAmount: number }): boolean {
  // Trust the raw string over the float: uiAmount is derived, and a mint with
  // absurd decimals can round a real balance to 0 or a dust balance to
  // something that looks real.
  let raw: bigint;
  try {
    raw = BigInt(h.amountRaw);
  } catch {
    // Unreadable balance is not "dust" — it is unknown, so let the normal
    // path handle it rather than silently skipping a position (honest null).
    return false;
  }
  if (raw <= 0n) return true;
  return Number.isFinite(h.uiAmount) && h.uiAmount < DUST_UI_AMOUNT;
}

const PROGRAM_CHECK_INTERVAL_MS = 10 * 60_000;
/**
 * How often copy trading re-reads the balances its open positions live in.
 *
 * "Recheck balances periodically and flag leftovers even when the ledger
 * says closed" — the fourth of the four fixes asked for on 2026-09-15. A
 * leftover does not change between one minute and the next, and the sweep
 * takes at most a handful of reads per pass, so this is deliberately slow.
 */
const COPY_SWEEP_INTERVAL_MS = 90_000;

/**
 * A chain timestamp (unix SECONDS) as ms, or null when it is not credible.
 *
 * Pump's TradeEvent carries the Clock's `unix_timestamp`. It is free and
 * exact — but it is also a number off the wire, and a nonsense one must not
 * be allowed to make every trade look ancient, because copyTrade refuses a
 * stale entry. Anything before the program existed or in the future is
 * "unknown", which every caller already treats as "do not judge the age".
 */
const CHAIN_TIME_FLOOR_MS = Date.UTC(2021, 0, 1);
function chainTimeMs(seconds: number | null | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1_000;
  if (ms < CHAIN_TIME_FLOOR_MS || ms > Date.now() + 60 * 60_000) return null;
  return ms;
}
/** The one hard pause the engine may lift by itself, once the decoder has been
 *  re-checked against chain. Layout-drift pauses are a different signal with a
 *  different remedy and are NOT auto-cleared. */
const PROGRAM_UPGRADE_PAUSE = 'Pump program was redeployed — decoder must be re-verified';

/** What main hands the engine so copy trading can reach the EVM rail. */
export interface EvmCopyBridge {
  buy(chain: EvmChainKind, token: string, amountNative: number, walletId?: string): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean; spentSol?: number }>;
  /** `amountRaw` sells EXACTLY that many base units and the percent is
   *  ignored — the rail has taken an exact size since the BNB audit, and
   *  copy trading is the caller that knows one (2026-09-15). */
  sell(chain: EvmChainKind, token: string, pct: number, walletId?: string, amountRaw?: string): Promise<{ ok: boolean; message: string; signature?: string }>;
  /** Why a LIVE copy cannot go out on this chain right now, or null. */
  blocked(chain: EvmChainKind): string | null;
  maxLive(chain: EvmChainKind): number | null;
  /** Last price the Observatory saw for the token, native per token; null if unknown. */
  price(chain: EvmChainKind, token: string): number | null;
  facts(chain: EvmChainKind, token: string): Promise<{ liquidityUsd: number | null; marketCapUsd: number | null; kryptScore: number | null; isPumpfun: boolean }>;
  /** A leader's current token balance, whole units — the rescue read for a
   *  sell whose size the log did not carry. Optional: a rail that cannot
   *  answer leaves such a sell unmirrored, as it was before. */
  holdingOf?(chain: EvmChainKind, owner: string, token: string): Promise<number | null>;
  /** What THIS install holds of a token on the chain, in base units, with
   *  the token's decimals — the number a mirrored sell is sized from and
   *  settled against. Null when it cannot be read; never zero for an
   *  unreadable balance. */
  tokensOf?(chain: EvmChainKind, token: string, walletId?: string): Promise<{ raw: string; decimals: number } | null>;
  /** Base units a confirmed transaction moved, from the EVM ledger's
   *  reconciliation of that hash. Waits for it; null if it never settles. */
  fillTokens?(chain: EvmChainKind, hash: string): Promise<{ raw: string; decimals: number } | null>;
  /** The ledger's record of a BUY of `token` around `atMs`, for recovering
   *  the quantity of a copy opened before quantities were tracked. Refuses
   *  an ambiguous match. */
  buyFill?(chain: EvmChainKind, token: string, atMs: number, walletId?: string): Promise<{ raw: string; decimals: number } | null>;
  /** What this install holds on the chain right now, for a script's own
   *  position list. Optional: a rail that cannot answer leaves a live EVM
   *  script with an EMPTY list, which refuses an exit rather than offering it
   *  the wrong chain's bags. */
  holdings?(chain: EvmChainKind): Promise<Array<{ token: string; symbol: string; amount: number; priceNative: number | null }>>;
  /** The same tokens WITH cost basis, from the EVM ledger's reconciled fills.
   *  Optional: a rail that cannot answer leaves a script with an empty list
   *  rather than positions it cannot price. */
  positions?(chain: EvmChainKind): Promise<Array<{
    token: string;
    symbol: string;
    amount: number;
    priceNative: number | null;
    basisKnown: boolean;
    costNative: number | null;
    avgEntryPriceNative: number | null;
    unrealizedPnlNative: number | null;
    unrealizedPnlPct: number | null;
    firstBuyAt: number | null;
  }>>;
  /** This install's wallet on the chain: native balance and address. Optional;
   *  absent leaves a script's `walletSol` UNKNOWN rather than showing it the
   *  Solana balance, which is a different number about a different chain. */
  wallet?(chain: EvmChainKind): { native: number | null; address: string | null } | null;
  /**
   * Is this chain's leader feed running, and when did it last poll?
   *
   * A followed wallet on an EVM chain is only seen through that chain's
   * SCANNER, which the user starts. An armed copy config on a stopped
   * scanner watches nothing at all, silently.
   */
  leaderFeed?(chain: EvmChainKind): { running: boolean; lastPollAt: number | null } | null;
  /**
   * Make sure that feed is running, because a config was just enabled on it.
   * Returns null when it is (or has just been started), or why it cannot be.
   * Idempotent — an already-running scanner is a no-op.
   */
  ensureLeaderFeed?(chain: EvmChainKind): string | null;
}

export class SniperEngine {
  private feed: FeedManager | null = null;
  /** Post-migration tape: raw pump-amm event capture (2026-07-24 swarm build
   *  order #5 — graduation-adjacent PnL is unknowable without it). */
  private ammFeed: FeedManager | null = null;
  private tokens = new Map<string, TrackedToken>();
  private launchOrder: string[] = [];
  private positions: PositionManager;
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private tamperLogged = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private eventTimes: number[] = [];
  private decodeLatencies: number[] = [];
  private counters = { seen: 0, evaluated: 0, entered: 0, rejected: 0, filtered: 0 };
  private startedAt: number | null = null;
  private feedState: EngineStatus['feed'] = 'stopped';
  private lastEventAt = 0;
  // Feed-health: reserve-continuity loss estimator + alarm/record throttles.
  private continuity = new ReserveContinuity();
  private lastFeedHealthRecordAt = 0;
  private lastFeedLossWarnAt = 0;
  // Dip-buy survivor detector — shadow-only, measures the one strategy family
  // that survived the tape analysis at realistic latency (docs/tape-analysis).
  private dip = new DipShadow();
  private dipCreatedAt = new Map<string, number>();
  // Strategy Lab — N tandem paper strategies (shadow-only), config-driven.
  private lab = new StratLab();
  private mig = new MigShadow();
  private labCreator = new Map<string, string>();
  private layoutErrorTimes: number[] = [];
  private layoutErrorTotal = 0;
  /** Hard pauses persist for the session (program upgrade, decoder drift). */
  private hardPauseReason: string | null = null;
  /** One re-verification at a time; each one reads several accounts and a
   *  handful of transactions. */
  private reverifyInFlight = false;
  /** A short retry when the only thing missing was a launch to test against. */
  private reverifySoonTimer: NodeJS.Timeout | null = null;
  private lossCooldownUntil = 0;
  private programCheckTimer: NodeJS.Timeout | null = null;
  private orphanTimers = new Set<NodeJS.Timeout>();
  private execTimer: NodeJS.Timeout | null = null;
  private feeEstimate: feeEstimator.FeeEstimate | null = null;
  private shadowPlans: ShadowSendPlan[] = [];
  private firstBuyDone = false;
  // Arming is real state, but never persisted true — it always starts
  // disarmed on launch (auto-disarm on restart). While
  // LIVE_EXECUTION_AVAILABLE is false, arming changes nothing about signing.
  private armed = false;
  private armedAt: number | null = null;
  private lastDisarmReason: DisarmReason | null = null;
  /** Live was armed when the program-upgrade watchdog disarmed it — the
   *  condition for re-arming once the decoder re-check passes. */
  private armedWhenUpgradeHit = false;
  /** main.ts: arm live the way the top-bar switch does (engine + the saved
   *  mode). Returns what arm() said. */
  onRearmAfterUpgrade: (() => { ok: boolean; message: string }) | null = null;
  /** Set by main: persists the mode bit whenever the engine disarms, so a
   *  safety trip reverts the UI to Paper truthfully (see live:setLive). */
  onDisarm: ((reason: DisarmReason) => void) | null = null;
  /** Why the local builder had nothing for a mint, from the last lookup. */
  private localUnavailable = new Map<string, string>();
  // Autonomous live trading: mints we hold a REAL position in, and a promise
  // chain that serializes live trades so concurrent buys can't race the
  // wallet balance.
  private liveMints = new Set<string>();
  private liveChain: Promise<void> = Promise.resolve();
  private liveBuys = 0;
  private liveSells = 0;
  /** A fee-estimate failure streak is logged once, not every 8 s. */
  private feeEstimateFailing = false;
  /** When the live counters last started from zero, and why — so the ledger
   *  can say "this is a new session" instead of looking wiped. */
  private liveSessionAt: number | null = null;
  private liveSessionWhy: string | null = null;
  // Live-buy pipeline breaker: consecutive pre-broadcast failures (validate/
  // simulate/relayer) mean the pipeline is broken (underfunded wallet, dead
  // RPC, relayer change) — NOT market losses. Without this, an underfunded
  // wallet made every buy silently no-op for two days (found 2026-07-21).
  private liveConsecutiveSendFails = 0;
  private liveBlockedReason: string | null = null;
  /** Wallet balance (lamports) captured when live first went active. */
  private liveBaselineLamports: number | null = null;
  private walletBalanceLamports: number | null = null;
  /** Real losing round-trips in a row, and the wallet balance after the
   *  previous live sell (to measure per-round-trip real PnL). */
  private liveConsecutiveLosses = 0;
  private liveBalanceAtLastSell: number | null = null;
  /** Mints where a live sell failed — tokens still held, need manual sell. */
  private stuckMints = new Set<string>();
  /** Profit already swept to the home address this session (lamports) —
   *  added back into live PnL so a sweep doesn't look like a loss. */
  private sweptLamports = 0;
  private cashoutInFlight = false;
  private cashoutWarned = false;
  private lastCashoutAttemptAt = 0;

  // ── Live chart ticks ──────────────────────────────────
  // Throttling the trade firehose down to something a chart can draw lives
  // in engine/chartTicks.ts. Both closures are deferred, so they read the
  // constructor's parameter properties when a tick fires rather than while
  // this field is being initialised.
  private readonly chartTicks = createChartTicks({
    emit: (ev) => this.emit(ev),
    isOpen: (mint) => tape.isSubscribed(mint),
  });

  constructor(
    private getSettings: () => AppSettings,
    private emit: (ev: EngineEvent) => void,
  ) {
    // The terminal's data layer needs a handful of engine-owned facts (the
    // RPC url, the local creator DB, the wallet labels) but must not import
    // the engine — that would be a cycle, since the engine writes the tape
    // the data layer reads. A narrow injected context breaks it.
    // Transport failover for every JSON-RPC call: the keyed endpoint (Helius)
    // is the trade path's primary; the public endpoint the user configured is
    // its fallback, and vice-versa when there is no key (then both are the
    // same and no fallback applies). See rpcClient.ts.
    setRpcFallback(
      () => {
        const rpc = this.getSettings().rpc;
        return rpc.execHttpUrl && rpc.execHttpUrl !== rpc.httpUrl ? rpc.httpUrl : '';
      },
      (line) => this.log('warn', line),
      // A refused key is not a blip to bury in the log: it is a setting the
      // user has to correct, so it gets a toast and a desktop notice.
      (line) => this.announce('error', line),
    );

    // The per-mint socket serves TWO masters: held positions (scanner) and
    // open token pages (terminal). Attached here, not in start(), so a token
    // page has its tape with the scanner stopped. Helius when keyed (fastest,
    // billed), else the primary public socket (free, unbilled).
    priorityFeed.attach({
      wssUrl: () => {
        const rpc = this.getSettings().rpc;
        const key = (rpc.heliusApiKey ?? '').trim();
        if (!key) return rpc.wssUrl;
        const keyed = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
        // A key the endpoint has already refused would just reconnect-loop.
        return isEndpointRejected(keyed) ? rpc.wssUrl : keyed;
      },
      execHttpUrl: () => this.getSettings().rpc.execHttpUrl ?? '',
      commitment: () => this.getSettings().rpc.commitment,
      onLogs: (n) => {
        this.onLogs(n);
        // A per-mint subscription also carries the mint's PumpSwap trades.
        // While the scanner runs its own AMM socket delivers those; with it
        // stopped this is the only copy, so route it.
        if (!this.running && n.logs.some((l) => l.includes(PUMP_AMM_PROGRAM_ID))) this.onAmmLogs(n);
      },
      onAccount: (a) => this.onCurveAccount(a),
      billHttp: (calls) => heliusBudget.billHttp(calls),
      log: (level, line) => this.log(level, line),
    });

    // Every FOLLOWED WALLET gets its own subscription, so copy trading sees
    // a leader wherever it trades — Jupiter into Raydium, Meteora, Orca, the
    // pump AMM — not only on the pump.fun curve firehose (2026-09-06). The
    // swap is read from the wallet's balance deltas, so no per-DEX decoder
    // is needed. Same socket picker as the priority feed; runs with the
    // scanner stopped, because paper copying costs nothing.
    walletWatcher.attach({
      wssUrl: () => {
        const rpc = this.getSettings().rpc;
        const key = (rpc.heliusApiKey ?? '').trim();
        if (!key) return rpc.wssUrl;
        const keyed = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
        return isEndpointRejected(keyed) ? rpc.wssUrl : keyed;
      },
      httpUrl: () => {
        const rpc = this.getSettings().rpc;
        return rpc.execHttpUrl ?? rpc.httpUrl;
      },
      onSwap: ({ wallet: leader, swap, signature, at, tradeAt, timing }) => {
        // The leader's fill IS a price for that mint, and often the only
        // one this app has for a token the launch feed never carried.
        this.rememberPrice(swap.mint, swap.priceSol);
        const symbol = this.tokens.get(swap.mint)?.row.symbol ?? market.summaryIfCached(swap.mint)?.symbol ?? '';
        copyTrade.onWalletTrade({
          wallet: leader,
          mint: swap.mint,
          symbol,
          isBuy: swap.isBuy,
          sol: swap.sol,
          priceSol: swap.priceSol,
          soldFraction: swap.soldFraction,
          tokens: swap.tokens,
          at,
          // When they actually traded, from the block. A transaction the
          // watcher recovered after a socket gap can be minutes old, and
          // copyTrade refuses to enter on one and says how late an exit is.
          tradeAt,
          signature,
          // What hearing about it cost. The copier adds its own stages and
          // the signer's, and logs one line per copy (2026-09-21).
          delivery: timing,
        });
        // User scripts see the same trade (Automation → Scripts, "Followed wallet traded").
        automation.onLeaderTrade({
          mint: swap.mint,
          symbol,
          wallet: leader,
          label: copyTrade.all().find((c) => c.wallet === leader)?.label ?? '',
          side: swap.isBuy ? 'buy' : 'sell',
          sol: swap.sol,
          priceSol: swap.priceSol,
          soldFraction: swap.soldFraction,
        });
        const share = swap.soldFraction !== null ? ` (${Math.round(swap.soldFraction * 100)}% of their bag)` : '';
        this.log('info', `copy: ${leader.slice(0, 6)}… ${swap.isBuy ? 'bought' : 'sold'} ${swap.sol.toFixed(3)} SOL of ${symbol || swap.mint.slice(0, 8)}${share} (via ${swap.programs.length ? swap.programs.map((p) => p.slice(0, 4)).join('/') : 'chain'})`);
      },
      log: (level, line) => this.log(level, line),
    });

    market.attach({
      // Prefer the Helius endpoint when a key exists. The house rule is that
      // the key is spent only on execution-critical calls, never on the
      // firehose — and the terminal's on-chain reads qualify: they are
      // user-initiated clicks, a few per minute, and the free public RPC
      // rate-limits `getTokenLargestAccounts` specifically (verified 429 on
      // 2026-08-24), which is exactly the call the holders panel needs.
      httpUrl: () => {
        const rpc = this.getSettings().rpc;
        return rpc.execHttpUrl ?? rpc.httpUrl;
      },
      data: () => this.getSettings().data,
      heliusKey: () => this.getSettings().rpc.heliusApiKey ?? '',
      creatorIntel: (creator) => {
        const rec = creators.get(creator);
        const blacklisted = creators.blacklist().has(creator);
        if (!rec.launches && !blacklisted) return null;
        return { priorLaunches: rec.launches, priorRugs: rec.dumps, blacklisted };
      },
      walletLabel: (address) => watchlist.labelFor(address),
      isLiveTracked: (mint) => this.tokens.has(mint),
      // Newest first, and only as many as the column asked for. `launchOrder`
      // is append-order, so the tail is the newest; building the whole list
      // to throw most of it away is the sort of thing Discover does fifteen
      // times a minute.
      liveLaunches: (limit) => {
        const out: LaunchRow[] = [];
        for (let i = this.launchOrder.length - 1; i >= 0 && out.length < limit; i--) {
          const row = this.tokens.get(this.launchOrder[i])?.row;
          if (row) out.push(row);
        }
        return out;
      },
      liveLaunch: (mint) => this.tokens.get(mint)?.row ?? null,
      registerPool: (pool, mint) => this.rememberAmmPool(pool, mint),
      watchPumpMint: (mint) => this.watchPumpMint(mint),
      unwatchPumpMint: (mint) => this.unwatchPumpMint(mint),
      watchDbcPool: (mint, decimals, poolHint) => {
        // ONE account read decides it: a Meteora DBC curve pool is owned by
        // the DBC program, and nothing else is. Cheap, definitive, and it
        // costs nothing for the overwhelming majority of tokens, which are
        // not on a DBC curve.
        //
        // Fire-and-forget, so it has to survive the user leaving mid-flight:
        // without the subscription check below, a late result would open a
        // websocket for a token nobody is looking at and nothing would close
        // it. The tape subscription is the authority on "still interested".
        if (!poolHint) return;
        void (async () => {
          try {
            const rpc = this.getSettings().rpc;
            const httpUrl = rpc.execHttpUrl ?? rpc.httpUrl;
            const info = await getAccountInfo(httpUrl, poolHint);
            if (!info.ok || !info.data) return;
            if (!tape.isSubscribed(mint)) return; // the page closed while we checked
            // A Raydium pool a provider labelled as something else still
            // gets its tape: the owner is the truth, whatever the label said.
            if (info.data.owner === raydiumWatcher.RAYDIUM_AMM_V4_PROGRAM || info.data.owner === raydiumWatcher.RAYDIUM_CPMM_PROGRAM) {
              void raydiumWatcher.watchPool(mint, poolHint, () => tape.isSubscribed(mint)).catch(() => undefined);
              return;
            }
            if (info.data.owner !== dbcWatcher.DBC_PROGRAM_ID) return; // not a DBC curve
            dbcWatcher.watch(mint, poolHint, decimals);
          } catch {
            /* no tape for this token, and no error worth showing */
          }
        })();
      },
      unwatchDbcPool: (mint) => dbcWatcher.unwatch(mint),
      // Raydium LaunchLab needs no pool lookup at all: the pool is a PDA of
      // the mint, and its events arrive as LOG lines, so one shared
      // program-wide subscription serves every open LaunchLab token.
      watchLaunchLabPool: (mint, decimals, poolHint) => launchLabWatcher.watch(mint, decimals, poolHint),
      unwatchLaunchLabPool: (mint) => launchLabWatcher.unwatch(mint),
      // Boop names the mint AND the trader in its events, so it needs neither
      // a pool hint nor a pool→mint map, and its ticks carry real wallets.
      watchBoop: (mint, decimals) => boopWatcher.watch(mint, decimals),
      unwatchBoop: (mint) => boopWatcher.unwatch(mint),
      // Raydium AMM v4 / CPMM: the pool's OWNER decides, read once — a
      // provider's "raydium" label is a hint to try first, never the
      // authority. The watcher refuses a pool with no SOL side, and asks
      // whether the page is still open before it opens a socket. See
      // raydiumWatcher.ts.
      watchRaydiumPool: (mint, poolHint) => {
        if (!poolHint) return;
        void raydiumWatcher.watchPool(mint, poolHint, () => tape.isSubscribed(mint)).catch(() => undefined);
      },
      unwatchRaydiumPool: (mint) => raydiumWatcher.unwatch(mint),
      livePools: (limit) => raydiumWatcher.recentPools(limit),
      // The program feed's own books, for the Discover columns. Both are
      // empty while the scanner is stopped, which `scannerRunning` says.
      scannerRunning: () => this.running,
      liveCurves: (limit) => this.liveCurves.graduating(limit),
      liveMigrations: (limit) => this.liveMigrations.recent(limit),
    });

    // Advanced orders (term.txt §2). This module never decides to trade —
    // it notices that a condition the user wrote down has become true, and
    // then goes through exactly the same gated execution path as a manual
    // click. See advOrders.ts for the exactly-once and restart rules.
    // Real-money losing streak, from the CHAIN: each reconciled sell fill's
    // realised PnL (proceeds vs the same wallet's average cost) feeds the
    // live consecutive-loss breaker. Unknown basis changes nothing.
    // Fill lifecycle → renderer. The position panel used to learn about a
    // settled trade from a 20 s poll; now it is told the moment the ledger
    // books the on-chain delta (or gives up on the signature).
    ledger.onSettled((f) => {
      if (!f.signature) return;
      if (f.state === 'reconciled') this.emitFill(f.mint, f.side, f.signature, 'reconciled');
      else if (f.state === 'unreconciled' && /failed on chain|did not land/i.test(f.note ?? '')) {
        this.emitFill(f.mint, f.side, f.signature, 'failed');
      }
    });
    // The kept wallet balance moves the moment a fill is booked from the
    // chain: the fill's own lamport delta is applied and status pushed, so
    // the session PnL on every surface reflects the trade NOW — not at the
    // next poll of the public endpoint, which runs every 8–30 s and fails
    // silently while that host is parked (user report 2026-09-20: the
    // Observatory headline stopped after the first trade). A chain read
    // follows to settle any drift.
    ledger.onSettled((f) => {
      if (f.state !== 'reconciled' || f.solDeltaLamports === null) return;
      const owner = wallet.publicKey();
      if (!owner || (f.wallet && f.wallet !== owner)) return;
      if (this.walletBalanceLamports !== null) {
        this.walletBalanceLamports = Math.max(0, this.walletBalanceLamports + f.solDeltaLamports);
        wallet.noteBalance(owner, this.walletBalanceLamports);
        this.pushStatus();
      }
      void this.refreshWalletBalance();
    });
    ledger.onSettled((f) => {
      if (f.side !== 'sell' || f.state !== 'reconciled') return;
      // A fill owned by ANOTHER wallet in this install must never trip the
      // active wallet's streak breaker — the streak is about one signer.
      if (f.wallet && f.wallet !== wallet.publicKey()) return;
      const pnl = ledger.realizedPnlForSell(f);
      const next = nextConsecutiveLosses(this.liveConsecutiveLosses, pnl);
      if (next === this.liveConsecutiveLosses) return;
      this.liveConsecutiveLosses = next;
      if (pnl !== null) this.log(pnl < 0 ? 'warn' : 'info', `live sell ${f.symbol || f.mint.slice(0, 8)} realised ${pnl.toFixed(4)} SOL — streak ${next}`);
      this.updateLiveBreakers();
    });
    advOrders.attach({
      buy: async (mint, sol) => {
        const r = await this.testTrade(mint, sol, false);
        return { ok: r.ok, message: r.message, signature: r.signature, pending: r.stage === 'pending' };
      },
      sell: async (mint, percent) => {
        const r = await this.manualSell(mint, percent);
        return { ok: r.ok, message: r.message, signature: r.signature, pending: r.stage === 'pending' };
      },
      blockedReason: () => this.executionBlockedReason(),
      buyBlockedReason: () => {
        const pause = this.running ? this.entriesPauseReason() : null;
        return pause ? `entries are paused (${pause})` : null;
      },
      maxLiveSol: () => this.getSettings().execution.maxLiveSol,
      // The wallet an order is written over (advOrders §7): the ACTIVE signer,
      // whose bag is what "sell 100%" means. Null when this install has no
      // wallet — advOrders reads that as "the host cannot name a signer" and
      // leaves armed orders alone rather than stamping or pausing them, which
      // is why an empty string is normalised away here too.
      owner: () => wallet.publicKey() || null,
      // Only a CONFIRMED zero means anything to advOrders; an unreadable
      // balance is null and changes nothing, so a failed RPC read can never
      // stand between someone and their exit.
      heldTokensRaw: async (mint) => {
        const owner = wallet.publicKey();
        if (!owner) return null;
        const s = this.getSettings();
        const r = await getTokenBalanceRawForMint(s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner, mint);
        return r.ok && r.data ? r.data.raw : null;
      },
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'orders', snapshot: this.ordersSnapshot() }),
    });
    alerts.attach({
      notify: (title, body, mint) => this.notify(title, body, mint ? { mint, chain: 'solana' } : undefined),
      settings: () => this.getSettings().alerts,
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'alerts', alerts: alerts.all() }),
    });

    // $KRYPTO holdings decide whether Krypt's fee applies. Every wallet this
    // install has keys for counts, not the active signer alone — someone who
    // keeps their bag in one wallet and trades from another is one user.
    kryptoHolding.attach({
      wallets: () => wallet.list().map((w) => w.publicKey),
      httpUrl: () => {
        const s2 = this.getSettings();
        return s2.rpc.execHttpUrl ?? s2.rpc.httpUrl;
      },
      // Cached only. This runs on a timer, and a price lookup that reached
      // the network here would put a provider round trip behind a fee rule.
      priceUsd: (mint) => market.summaryIfCached(mint)?.priceUsd ?? null,
    });
    if (isValidMint(KRYPTO_TOKEN.mint)) {
      void this.refreshKrypto();
      this.kryptoTimer = setInterval(() => void this.refreshKrypto(), 120_000);
    }

    copyTrade.attach({
      buy: async (mint, sol, opts) => {
        // Robinhood Chain / BNB: the rail, by way of the bridge main wired.
        if (opts?.chain && opts.chain !== 'solana') {
          if (!this.evmCopy) return { ok: false, message: 'EVM copy trading is not available in this build' };
          return this.evmCopy.buy(opts.chain, mint, sol, opts.walletId);
        }
        // A config that names its own wallet buys through the per-wallet
        // pipeline (the same one a fan-out uses: every gate, fee and record,
        // signed by THAT wallet). The active wallet keeps the manual path.
        if (opts?.walletId) {
          const lr = await this.labBuy(opts.walletId, mint, sol);
          return { ok: lr.ok, message: lr.message, signature: lr.signature ?? undefined, pending: lr.stage === 'pending', spentSol: lr.costSol ?? undefined };
        }
        // `slippagePct` is the config's own `maxSlippagePct`, which until now
        // had no execution path at all — every copy went out at the global
        // execution slippage whatever the follower was set to (copy-7).
        const r = await this.testTrade(mint, sol, false, { slippagePct: opts?.slippagePct });
        const pending = r.stage === 'pending';
        // A broadcast that has not confirmed is not a failure: the tokens may
        // already be ours, and reporting it as "skipped" left a real position
        // off the copy record entirely (copy-5).
        // What it COST is the chain's number, never the size we asked for
        // (house rule). The ledger reconciles a fresh fill in the background,
        // so this is usually still unknown here — and `sentSol` is then the
        // honest second best: the amount actually submitted, after the
        // per-trade cap and the exit-headroom trim. Undefined means "I do not
        // know", which leaves copyTrade on its own fallback rather than
        // inventing a number.
        const priced = r.signature ? this.reconciledFill(r.signature) : null;
        return {
          ok: r.ok,
          message: r.message,
          signature: r.signature,
          pending,
          spentSol: priced?.spentSol ?? r.sentSol,
          fillPriceSol: priced?.priceSol ?? undefined,
          // The signer already measures itself (TradeTiming); passing two of
          // its numbers through is what lets a copy's timing line separate
          // building the transaction from waiting for the chain.
          timing: r.timing ? { build: r.timing.build, confirm: r.timing.confirm } : undefined,
        };
      },
      // A mirrored sell is the same order a user places by hand: the full
      // pipeline, sized as a share of what THIS wallet holds now. It is only
      // reported done when it confirmed — a broadcast that is still pending
      // is not a fill, and calling it one is how the history came to say
      // "closed" over a bag that was still there (2026-09-08).
      sell: async (mint, pct, opts) => {
        if (opts?.chain && opts.chain !== 'solana') {
          if (!this.evmCopy) return { ok: false, message: 'EVM copy trading is not available in this build' };
          return this.evmCopy.sell(opts.chain, mint, pct, opts.walletId, opts.tokensRaw);
        }
        if (opts?.walletId) {
          const labShare = pct >= 100 ? pct : ((await this.pctForTokens(mint, opts.tokensRaw, opts.walletId)) ?? pct);
          const lr = await this.labSell(opts.walletId, mint, labShare);
          if (lr.ok) return { ok: true, message: lr.message, signature: lr.signature ?? undefined };
          return { ok: false, message: lr.stage === 'pending' ? `broadcast but not confirmed in time — check Trades (${lr.message})` : lr.message, signature: lr.signature ?? undefined };
        }
        // An exact quantity beats a percentage of the whole account: the
        // copier knows how many base units the copy holds, and this converts
        // that to the share of the CURRENT balance it really is, to two
        // decimal places, instead of the copier guessing from cost basis and
        // rounding to a whole percent. An unreadable balance falls back to
        // the percentage the copier computed, which is what used to be sent;
        // and at 100 % there is nothing to convert — "all of it" is all of
        // it — so a full exit costs no extra read.
        const share = pct >= 100 ? pct : ((await this.pctForTokens(mint, opts?.tokensRaw)) ?? pct);
        const r = await this.manualSell(mint, share, { slippagePct: opts?.slippagePct });
        if (r.ok) return { ok: true, message: r.message, signature: r.signature };
        return {
          ok: false,
          message: r.stage === 'pending' ? `broadcast but not confirmed in time — check Trades (${r.message})` : r.message,
          signature: r.signature,
        };
      },
      liveBlockedReason: (chain) => (chain && chain !== 'solana' ? (this.evmCopy ? this.evmCopy.blocked(chain) : 'EVM copy trading is not available in this build') : this.executionBlockedReason()),
      // The entry breakers, which `liveBlockedReason` deliberately omits so an
      // exit is never trapped. Without this a copy could OPEN a position
      // during a decoder hard-pause or on a stale feed (copy-11). Same wording
      // and same source as the automation and advanced-order hosts.
      buyBlockedReason: (chain) => {
        if (chain && chain !== 'solana') return null; // the rail has no entry breakers; `blocked` above is the gate
        const pause = this.running ? this.entriesPauseReason() : null;
        return pause ? `entries are paused (${pause})` : null;
      },
      // House rule 2: a budget is a refusal, not a clamp. copyTrade refuses a
      // copy over this and records the size it refused (copy-8).
      maxLiveSol: (chain) => (chain && chain !== 'solana' ? (this.evmCopy?.maxLive(chain) ?? null) : this.getSettings().execution.maxLiveSol),
      // What the ACTIVE wallet paid for its whole holding of the mint, so a
      // mirrored "they sold 40%" is scaled to the copier's share of our bag
      // instead of taking 40% of hand-bought size too (copy-2).
      ourCostBasisSol: (mint, chain) => (chain && chain !== 'solana' ? null : this.ourCostBasisSol(mint)),
      // The leader's CURRENT holding — the rescue path for a sell whose size
      // the transaction did not carry. One read, and the fraction it yields
      // is exact rather than assumed. EVM has its own balance reader; a rail
      // without one answers null, which leaves the sell unmirrored exactly
      // as before.
      leaderHolding: async (leader, mint, chain) => {
        if (chain && chain !== 'solana') return this.evmCopy?.holdingOf?.(chain, leader, mint) ?? null;
        const s2 = this.getSettings();
        try {
          const r = await getTokenBalanceForMint(s2.rpc.execHttpUrl ?? s2.rpc.httpUrl, leader, mint);
          return r.ok && typeof r.data === 'number' ? r.data : null;
        } catch {
          return null;
        }
      },
      // What the copy WALLET holds of a mint, in base units. The copier
      // sizes an exit from it, settles one against it, and the leftover
      // sweep compares its own book to it. Null is "unreadable", which the
      // copier reads as unknown — never as zero.
      walletTokens: async (mint, opts) => {
        if (opts?.chain && opts.chain !== 'solana') {
          return (await this.evmCopy?.tokensOf?.(opts.chain, mint, opts.walletId)) ?? null;
        }
        const owner = opts?.walletId ? wallet.publicKeyOf(opts.walletId) : wallet.publicKey();
        if (!owner) return null;
        const s2 = this.getSettings();
        try {
          const r = await getTokenBalanceRawForMint(s2.rpc.execHttpUrl ?? s2.rpc.httpUrl, owner, mint);
          if (!r.ok || !r.data) return null;
          return { raw: r.data.raw.toString(), decimals: r.data.decimals ?? 0 };
        } catch {
          return null;
        }
      },
      // Base units a confirmed fill actually moved, from the ledger's own
      // reconciliation of that signature — the transaction's token delta,
      // not an inference from a balance. Waits for it, because the copier
      // calling this is always off the hot path.
      fillTokens: async (signature, opts) => {
        if (opts?.chain && opts.chain !== 'solana') {
          return (await this.evmCopy?.fillTokens?.(opts.chain, signature)) ?? null;
        }
        return this.awaitFillTokens(signature);
      },
      // The ledger's record of a copy's buy, for a row opened before the
      // quantity was tracked. Ambiguity is REFUSED in both implementations:
      // the number sizes a real sell, and unknown is already safe.
      buyFill: async (mint, atMs, opts) => {
        if (opts?.chain && opts.chain !== 'solana') {
          return (await this.evmCopy?.buyFill?.(opts.chain, mint, atMs, opts.walletId)) ?? null;
        }
        return this.ledgerBuyFill(mint, atMs, opts?.walletId);
      },
      priceSol: (mint, chain) =>
        chain && chain !== 'solana' ? (this.evmCopy?.price(chain, mint) ?? null) : (this.tokens.get(mint)?.row.priceSol ?? this.lastKnownPriceSol.get(mint) ?? null),
      tokenFacts: async (mint, chain) => {
        if (chain && chain !== 'solana') {
          return this.evmCopy ? this.evmCopy.facts(chain, mint) : { liquidityUsd: null, marketCapUsd: null, kryptScore: null, isPumpfun: false };
        }
        const t = this.tokens.get(mint);
        // Liquidity and market cap are NOT on a launch row — a curve token has
        // no USD basis in the hot path — so both come from the market layer
        // whether or not the launch feed carried the mint. Returning null for
        // every feed token (as this did until 2026-09-09) refused every copy
        // on the whole pump rail, because copyTrade's filters fail closed and
        // the shipped default is a $5,000 liquidity floor (copy-4b). Cached
        // first, a round trip when cold — the same two sources automation's
        // `marketCached` / `market` pair uses, so the two agree on a mint.
        const sum = market.summaryIfCached(mint) ?? (await market.summary(mint));
        return {
          liquidityUsd: sum.liquidityUsd,
          marketCapUsd: sum.marketCapUsd,
          // Our own live score when the feed is tracking the launch; the
          // market layer's otherwise. Unknown stays null — the filter then
          // refuses rather than guessing.
          kryptScore: t ? (t.row.score?.total ?? sum.kryptScore) : sum.kryptScore,
          isPumpfun: t ? true : sum.launchpad === 'pumpfun',
          // For the age and creator filters (2026-09-21): a feed token's own
          // launch time and creator, else what the market layer knows. Null
          // is unknown, and those filters refuse rather than guess.
          createdAt: t ? t.row.detectedAt : sum.createdAt,
          creator: (t ? t.row.creator : null) || sum.creator || null,
        };
      },
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'copy', snapshot: copyTrade.snapshot() }),
      watchStatus: () => walletWatcher.status(),
      // Solana wallets are watched one subscription each; an EVM leader is
      // seen through its chain's scanner poll, and a config on a stopped one
      // is a follower watching nothing.
      // FOMO crowd sources (2026-09-20). Solana only: the crowd is heard on
      // the pump curve firehose and the followed wallets' subscriptions.
      scoutSaved: (chain) => (chain === 'solana' ? scout.savedList('solana') : []),
      trackedWallets: (chain) => (chain === 'solana' ? watchlist.all().map((w) => w.address) : []),
      scoutTop: (chain, n) =>
        chain === 'solana'
          ? rankScout(scout.wallets('solana').map((w) => summarise(w, 'week')).filter((r) => r.copyScore !== null), 'copyScore')
              .slice(0, Math.max(1, n))
              .map((r) => r.address)
          : [],
      leaderFeed: (chain) => (chain === 'solana' ? null : (this.evmCopy?.leaderFeed?.(chain) ?? null)),
    });

    // User scripts and rules. Same pipeline as a hand-placed order — a
    // script's buy IS testTrade, its sell IS manualSell — under the
    // script's own budget (checked in automation.ts, never here).
    scriptSandbox.install({
      onMessage: (id, msg) => automation.onSandboxMessage(id, msg),
      onGone: (id, reason) => automation.onSandboxGone(id, reason),
      log: (level, line) => this.log(level, line),
    });
    automation.attach({
      // One implementation, two callers: user scripts reach it here, the AI
      // connection reaches `hostBuy` / `hostSell` directly (2026-09-21). They
      // were duplicated for a day and that is exactly how an EVM routing rule
      // ends up fixed on one path and not the other.
      buy: (mint, sol, mode, chain, ownCapSol) => this.hostBuy(mint, sol, mode, chain, ownCapSol),
      sell: (mint, pct, mode, chain) => this.hostSell(mint, pct, mode, chain),
      liveBlockedReason: (chain) =>
        chain && chain !== 'solana'
          ? (this.evmCopy ? this.evmCopy.blocked(chain) : 'EVM trading is not available in this build')
          : this.executionBlockedReason(),
      buyBlockedReason: (chain) => {
        if (chain && chain !== 'solana') return null; // the rail has no entry breakers; `blocked` above is the gate
        const pause = this.running ? this.entriesPauseReason() : null;
        return pause ? `entries are paused (${pause})` : null;
      },
      maxLiveSol: (chain) =>
        chain && chain !== 'solana'
          ? (this.evmCopy?.maxLive(chain) ?? 0)
          : this.getSettings().execution.maxLiveSol,
      priceSol: (mint, chain) =>
        chain && chain !== 'solana' ? (this.evmCopy?.price(chain, mint) ?? null) : this.cheapPriceSol(mint),
      launch: (mint) => this.tokens.get(mint)?.row ?? null,
      launchLinks: (mint) => {
        const t = this.tokens.get(mint);
        const so = t?.socials;
        if (!t || !so || !so.resolved) return null;
        // The addresses themselves, from the same cached metadata file — a
        // "website" that is really an X search is only visible in the URL.
        const urls = t.createEvent.uri ? metadataLinksIfCached(t.createEvent.uri) : null;
        return {
          twitter: so.twitter,
          website: so.website,
          telegram: so.telegram,
          twitterUrl: urls?.twitter ?? null,
          websiteUrl: urls?.website ?? null,
          telegramUrl: urls?.telegram ?? null,
        };
      },
      marketCached: (mint, chain) => {
        // The EVM rails have no cached provider summary here; their facts come
        // from the bridge and only on request, so "cached" is honestly nothing.
        if (chain && chain !== 'solana') return null;
        const s = market.summaryIfCached(mint);
        return s ? marketFactsFromSummary(s, this.xReuseFor(s.socials.twitter, mint).handle, xStatsStore.get(mint), linkIntel.facts(mint), siteReadStore.get(mint)) : null;
      },
      market: async (mint, chain) => {
        if (chain && chain !== 'solana') {
          if (!this.evmCopy) return null;
          try {
            const f = await this.evmCopy.facts(chain, mint);
            // Only what that rail can actually answer. holders, priceUsd and
            // launchpad have no source there and stay null rather than 0 —
            // and the rule editor does not offer them on these chains.
            return {
              priceSol: this.evmCopy.price(chain, mint), priceUsd: null,
              marketCapUsd: f.marketCapUsd, liquidityUsd: f.liquidityUsd,
              holders: null, launchpad: null, symbol: '', name: '',
            };
          } catch {
            return null;
          }
        }
        try {
          const s = await market.summary(mint);
          // A script asked about this token: start its Telegram and domain
          // lookups (budgeted, cached); the answers ride into later reads.
          linkIntel.trigger(mint);
          return marketFactsFromSummary(s, this.xReuseFor(s.socials.twitter, mint).handle, xStatsStore.get(mint), linkIntel.facts(mint), siteReadStore.get(mint));
        } catch {
          return null;
        }
      },
      // The rest of what the app knows about a token (2026-09-20). Solana only:
      // the EVM rails have no security report, creator record or AI opinion.
      links: (mint, chain) => this.linksFor(mint, chain),
      security: async (mint, chain) => {
        if (chain && chain !== 'solana') return null;
        try {
          const d = await market.tokenDetail(mint);
          return {
            score: d.security.score,
            checksResolved: d.security.checksResolved,
            checksTotal: d.security.checksTotal,
            checks: d.security.checks.map((c) => ({ id: c.id, label: c.label, verdict: c.verdict, detail: c.detail })),
            warnings: d.warnings,
          };
        } catch {
          return null;
        }
      },
      creator: async (mint, chain) => {
        if (chain && chain !== 'solana') return null;
        let creator = market.summaryIfCached(mint)?.creator ?? this.tokens.get(mint)?.createEvent.creator ?? null;
        if (!creator) {
          try {
            creator = (await market.summary(mint)).creator;
          } catch {
            return null;
          }
        }
        if (!creator) return null;
        const h = await launchIntel.creatorHistory(creator).catch(() => null);
        if (!h) return null;
        return {
          address: h.address,
          launches: h.launches,
          graduated: h.graduated,
          graduationRate: h.graduationRate,
          medianAthUsd: h.medianAthUsd,
          bestAthUsd: h.bestAthUsd,
          firstLaunchAt: h.firstLaunchAt,
          lastLaunchAt: h.lastLaunchAt,
          truncated: h.truncated,
        };
      },
      analyze: async (mint, chain) => {
        if (chain && chain !== 'solana') throw new Error('AI analysis is Solana-only for now');
        // Cached per token for ten minutes: the same question twice must not
        // spend the user's key twice.
        const hit = this.scriptAiCache.get(mint);
        if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
        const d = await market.tokenDetail(mint);
        const { analyze } = await import('../data/aiAnalysis');
        const r = await analyze(this.getSettings().ai, d.summary, d, Date.now());
        if (!r.ok || !r.analysis) throw new Error(r.message);
        this.scriptAiCache.set(mint, r.analysis);
        return r.analysis;
      },
      positions: (mode, chain) => this.scriptPositions(mode, chain),
      wallet: (chain) => {
        // `walletSol` on an EVM script is that chain's own coin and that
        // chain's own address. Returning the Solana balance would have a rule
        // like "walletSol > 1" gate a BNB trade on an unrelated number.
        if (chain && chain !== 'solana') {
          const w = this.evmCopy?.wallet?.(chain) ?? null;
          return { sol: w?.native ?? null, address: w?.address ?? null };
        }
        const info = wallet.info();
        return { sol: info.balanceSol, address: wallet.publicKey() || null };
      },
      orders: (mint) =>
        advOrders
          .all()
          .filter((o) => !mint || o.mint === mint)
          .map((o) => ({ id: o.id, mint: o.mint, symbol: o.symbol, kind: o.kind, state: o.state, triggerBasis: o.triggerBasis, triggerValue: o.triggerValue, amount: o.amount })),
      placeOrder: (req) => this.createOrder({ ...req, symbol: req.symbol || this.tokens.get(req.mint)?.row.symbol || market.summaryIfCached(req.mint)?.symbol || '' }),
      cancelOrders: (mint) => {
        let cancelled = 0;
        for (const o of advOrders.all()) {
          if (o.mint !== mint || !['armed', 'paused', 'triggered'].includes(o.state)) continue;
          if (advOrders.cancel(o.id).ok) cancelled += 1;
        }
        if (cancelled) this.emit({ kind: 'orders', snapshot: this.ordersSnapshot() });
        return { ok: true, message: cancelled ? `cancelled ${cancelled} order(s)` : 'no open orders on this token', cancelled };
      },
      // Prune finished orders (filled/cancelled/expired/failed) so a long-lived
      // script does not accumulate terminal orders against MAX_ORDERS and
      // eventually get its new orders refused. Housekeeping, not a trade.
      clearCompletedOrders: () => {
        const cleared = advOrders.clearCompleted();
        if (cleared) this.emit({ kind: 'orders', snapshot: this.ordersSnapshot() });
        return { ok: true, message: cleared ? `cleared ${cleared} finished order(s)` : 'nothing to clear', cleared };
      },
      templates: () => templateStore.list().map((t) => ({ id: t.id, name: t.name })),
      applyTemplate: async (mint, templateId) => {
        const t = templateStore.list().find((x) => x.id === templateId);
        if (!t) return { ok: false, message: 'template not found' };
        const symbol = this.tokens.get(mint)?.row.symbol || market.summaryIfCached(mint)?.symbol || '';
        let placed = 0;
        const problems: string[] = [];
        for (const req of ordersForTemplate(t, mint, symbol)) {
          const r = await this.createOrder(req);
          if (r.ok) placed += 1;
          else problems.push(r.message);
        }
        return { ok: placed > 0, message: `${describeTemplate(t)}: ${placed} order(s) armed${problems.length ? ` — ${problems.join('; ')}` : ''}` };
      },
      createAlert: (req) => this.createAlert(req),
      subscribeTicks: (mint) => tape.subscribe(mint),
      pin: (mint, on) => this.emit({ kind: 'pin', mint, on }),
      runners: () => this.runnersSnapshot(),
      leaders: () => copyTrade.all().map((c) => ({ wallet: c.wallet, label: c.label, enabled: c.enabled, mode: c.mode })),
      notify: (title, body) => this.notify(title, body),
      // A script posting a callout. By default the ACTIVE Solana wallet's
      // account — the wallet the script trades with, so the one holding the
      // coin. A script may name a different account, but only one of the
      // user's OWN signed-in ones, and it names it by address: `postNow` is
      // given a wallet id resolved here, never one the sandbox invented.
      callout: async (mint, thesis, who) => {
        const pick = this.pumpAccountFor(who);
        if ('error' in pick) return { ok: false, message: pick.error };
        const { pickThesis } = await import('@shared/calloutAuto');
        // Given text wins; otherwise a random line from the Auto-callout
        // settings, which is where the user's own wording already lives.
        const chosen = thesis || pickThesis(this.getSettings().autoCallout.text) || '';
        if (!chosen) return { ok: false, message: 'no text given, and Auto-callout has no lines to pick from' };
        // {ticker}, {mc} and the rest, from what the app already knows.
        const { fillCallout } = await import('@shared/calloutAuto');
        const text = fillCallout(chosen, this.calloutFacts(mint));
        const { postNow } = await import('./autoCallout');
        const r = await postNow(pick.walletId, mint, text, { likeOwn: this.getSettings().autoCallout.likeOwn });
        recorder.record('auto_callout', { mint, ok: r.ok, verdict: r.verdict ?? null, note: r.message.slice(0, 160) });
        return { ok: r.ok, message: r.message, thesis: r.thesis, address: pick.address, calloutId: r.calloutId ?? null };
      },
      // Your own wallets, so a script can name one to trade with. Addresses
      // and labels only — no key, no id a caller could have invented.
      wallets: () => wallet.list().map((w) => ({ address: w.publicKey, label: w.label, active: !!w.active })),
      walletBuy: (address, mint, sol, ownCapSol) => this.scriptWalletTrade('buy', address, mint, sol, ownCapSol),
      walletSell: (address, mint, pct) => this.scriptWalletTrade('sell', address, mint, pct),
      // Following up a call that already exists. Same account rules; the
      // callout's id is pump's to supply, not a script's.
      calloutReply: async (mint, content, who) => {
        const pick = this.pumpAccountFor(who);
        if ('error' in pick) return { ok: false, message: pick.error };
        const { fillCallout } = await import('@shared/calloutAuto');
        const { replyNow } = await import('./autoCallout');
        const r = await replyNow(pick.walletId, mint, fillCallout(content, this.calloutFacts(mint)));
        recorder.record('auto_callout', { mint, ok: r.ok, verdict: r.verdict ?? null, note: `reply: ${r.message.slice(0, 150)}` });
        return { ok: r.ok, message: r.message, thesis: r.thesis, address: pick.address, calloutId: r.calloutId ?? null, replyId: r.replyId ?? null };
      },
      // A script's Discord post. The URL was resolved from the script's own
      // webhook answer in automation.ts; postEmbed checks the host again.
      discord: async (url, embed) => {
        const { postEmbed } = await import('../system/discordWebhook');
        return postEmbed(url, embed);
      },
      // Follows and likes, from the same account a callout would post from.
      pumpSocial: async (action, target, who) => {
        const pick = this.pumpAccountFor(who);
        if ('error' in pick) return { ok: false, message: pick.error };
        const { act } = await import('../system/pumpSocial');
        const r = await act(pick.walletId, action, target);
        return { ok: r.ok, message: r.message, address: pick.address };
      },
      // Addresses and names only. A session's token never leaves main, and
      // certainly never reaches a sandbox.
      pumpAccounts: () =>
        pumpAuth.status().sessions.map((x) => ({
          address: x.address,
          username: x.username,
          active: x.walletId === (wallet.list().find((w) => w.active)?.id ?? null),
        })),
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'automation', snapshot: automation.snapshot() }),
      sandbox: {
        start: scriptSandbox.start,
        dispatch: scriptSandbox.dispatch,
        reply: scriptSandbox.reply,
        stop: scriptSandbox.stop,
        isRunning: scriptSandbox.isRunning,
      },
    });

    // Meteora DBC (LetsBonk / Believe / Boop). Unlike pump.fun this cannot
    // run as a program-wide firehose — its events are emit_cpi! and would
    // need a getTransaction per trade — so it watches the pool of whichever
    // token the terminal has open. See dbcWatcher.ts.
    boopWatcher.attach({
      wssUrls: () => {
        const rpc = this.getSettings().rpc;
        return [rpc.wssUrl, ...(rpc.extraWssUrls ?? [])].filter(Boolean);
      },
      commitment: () => this.getSettings().rpc.commitment,
      onTick: (t) => {
        this.rememberPrice(t.mint, t.priceSol);
        tape.record(t.mint, {
          at: t.at,
          wallet: t.wallet,
          isBuy: t.isBuy,
          sol: t.sol,
          tokens: t.tokens,
          priceSol: t.priceSol,
        });
        this.chartTicks.push(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
        advOrders.onTick({ mint: t.mint, priceSol: t.priceSol, mcapUsd: null });
        alerts.onTick({ mint: t.mint, priceSol: t.priceSol, curvePct: null });
        copyTrade.markToMarket(t.mint, t.priceSol);
      },
      log: (level, line) => this.log(level, line),
    });

    launchLabWatcher.attach({
      wssUrls: () => {
        const rpc = this.getSettings().rpc;
        return [rpc.wssUrl, ...(rpc.extraWssUrls ?? [])].filter(Boolean);
      },
      commitment: () => this.getSettings().rpc.commitment,
      onTick: (t) => {
        this.rememberPrice(t.mint, t.priceSol);
        tape.record(t.mint, {
          at: t.at,
          // Empty by construction on this rail — a log subscription carries no
          // account list. The trades panel renders it as unknown.
          wallet: t.wallet,
          isBuy: t.isBuy,
          sol: t.sol,
          tokens: t.tokens,
          priceSol: t.priceSol,
        });
        this.chartTicks.push(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
        advOrders.onTick({ mint: t.mint, priceSol: t.priceSol, mcapUsd: null });
        alerts.onTick({ mint: t.mint, priceSol: t.priceSol, curvePct: t.curvePct });
        copyTrade.markToMarket(t.mint, t.priceSol);
      },
      log: (level, line) => this.log(level, line),
    });

    dbcWatcher.attach({
      wssUrls: () => {
        const rpc = this.getSettings().rpc;
        return [rpc.wssUrl, ...(rpc.extraWssUrls ?? [])].filter(Boolean);
      },
      httpUrl: () => {
        const rpc = this.getSettings().rpc;
        return rpc.execHttpUrl ?? rpc.httpUrl;
      },
      commitment: () => this.getSettings().rpc.commitment,
      onTick: (t) => {
        this.rememberPrice(t.mint, t.priceSol);
        tape.record(t.mint, {
          at: t.at,
          wallet: t.wallet,
          isBuy: t.isBuy,
          sol: t.sol,
          tokens: t.tokens,
          priceSol: t.priceSol,
        });
        this.chartTicks.push(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
        advOrders.onTick({ mint: t.mint, priceSol: t.priceSol, mcapUsd: null });
        alerts.onTick({ mint: t.mint, priceSol: t.priceSol, curvePct: t.curvePct });
        copyTrade.markToMarket(t.mint, t.priceSol);
      },
      onCurveComplete: (mint) => {
        this.log('info', `DBC: ${mint.slice(0, 8)}… completed its curve`);
        advOrders.onTick({ mint, priceSol: this.lastKnownPriceSol.get(mint) ?? 0, mcapUsd: null, migrated: true });
        alerts.onTick({ mint, migrated: true, curvePct: 100 });
      },
      log: (level, line) => this.log(level, line),
    });

    // Raydium AMM v4 / CPMM — the post-migration rail. Two subscriptions on
    // the pool-creation fee accounts hear every new pool (opened with the
    // scanner in start()); the tape for an open token's pool is per pool,
    // like DBC's, but decoded from logs with no transaction fetch. Ticks
    // carry no wallet: logs have no account list. See raydiumWatcher.ts.
    raydiumWatcher.attach({
      wssUrls: () => {
        const rpc = this.getSettings().rpc;
        return [rpc.wssUrl, ...(rpc.extraWssUrls ?? [])].filter(Boolean);
      },
      httpUrl: () => {
        const rpc = this.getSettings().rpc;
        return rpc.execHttpUrl ?? rpc.httpUrl;
      },
      commitment: () => this.getSettings().rpc.commitment,
      onTick: (t) => {
        this.rememberPrice(t.mint, t.priceSol);
        tape.record(t.mint, {
          at: t.at,
          wallet: t.wallet,
          isBuy: t.isBuy,
          sol: t.sol,
          tokens: t.tokens,
          priceSol: t.priceSol,
        });
        this.chartTicks.push(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
        advOrders.onTick({ mint: t.mint, priceSol: t.priceSol, mcapUsd: null });
        // An AMM pool has no curve. Null rather than 100: a token that never
        // had a curve completed nothing, and an alert keyed on graduation
        // must not fire because a pool merely exists.
        alerts.onTick({ mint: t.mint, priceSol: t.priceSol, curvePct: null });
        copyTrade.markToMarket(t.mint, t.priceSol);
      },
      onPool: (p) => {
        recorder.record('raydium_pool', { kind: p.kind, pool: p.pool, mint: p.mint, solQuoted: p.solQuoted, priceSol: p.priceSol, solInPool: p.solInPool, sig: p.signature });
      },
      log: (level, line) => this.log(level, line),
    });

    // Deliberately started here rather than in start(): orders on migrated
    // tokens are not on the launch feed at all, so tying their evaluation to
    // the scanner would mean a stop loss silently stops watching whenever
    // the user presses Stop.
    this.startOrdersPoll();

    this.positions = new PositionManager(
      () => this.getSettings().strategy,
      (mint) => this.marketFor(mint),
      {
        onOpen: (p) => {
          this.emit({ kind: 'position', position: { ...p } });
          this.emit({ kind: 'toast', level: 'success', message: `Paper entry (research): ${p.symbol} (${p.costSol} SOL simulated)` });
          recorder.record('position_open', { id: p.id, mint: p.mint, entry: p.entryPriceSol, cost: p.costSol });
        },
        onUpdate: (p) => this.emitPositionUpdate(p),
        // Fires at TRIGGER time, before the honest-latency paper fill: the
        // real sell's latency is physical, so it must not inherit the paper
        // book's simulated 800ms.
        onExitTriggered: (p, reason) => {
          this.autoLiveSell(p.mint, p.symbol, reason);
        },
        onClose: (p) => {
          this.emit({ kind: 'positionUpdate', position: { ...p } });
          const sign = p.pnlSol >= 0 ? '+' : '';
          this.emit({
            kind: 'toast',
            level: p.exitReason === 'orphaned' ? 'warn' : p.pnlSol >= 0 ? 'success' : 'warn',
            message:
              p.exitReason === 'orphaned'
                ? `Voided ${p.symbol}: launch tx never confirmed (dropped fork)`
                : `Closed ${p.symbol} (${p.exitReason}): ${sign}${p.pnlSol.toFixed(4)} SOL`,
          });
          recorder.record('position_close', {
            id: p.id,
            mint: p.mint,
            reason: p.exitReason,
            pnlSol: p.pnlSol,
            pnlPct: p.pnlPct,
          });
          // Orphaned = launch tx never confirmed; there is no real position
          // (onExitTriggered never fires for voids) — just clear tracking.
          if (p.exitReason === 'orphaned') this.liveMints.delete(p.mint);
          this.updateBreakers();
          const t = this.tokens.get(p.mint);
          if (t) this.updatePhase(t, 'entered'); // keep phase; position row carries the outcome
        },
      },
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(): { ok: boolean; message: string } {
    if (this.running) return { ok: false, message: 'Engine already running' };
    // A seized build would scan, score and then be refused at every buy.
    // Saying so up front is more honest than letting it look like it works.
    if (seized()) return { ok: false, message: seizeMessage() };
    const s = this.getSettings();
    this.running = true;
    this.startedAt = Date.now();
    // Reset live-session tracking so breakers measure this session only.
    this.liveBuys = 0;
    this.liveSells = 0;
    this.liveSessionAt = Date.now();
    this.liveSessionWhy = 'the scanner was started';
    this.liveConsecutiveLosses = 0;
    this.liveConsecutiveSendFails = 0;
    this.liveBlockedReason = null;
    this.liveBaselineLamports = null;
    this.liveBalanceAtLastSell = null;
    this.stuckMints.clear();
    this.sweptLamports = 0;
    this.cashoutInFlight = false;
    this.cashoutWarned = false;
    this.lastCashoutAttemptAt = 0;
    orders.reset();
    const feedUrls = [s.rpc.wssUrl, ...(s.rpc.extraWssUrls ?? [])];
    this.continuity.reset();
    this.dip.reset();
    this.dipCreatedAt.clear();
    this.lab.reset();
    this.labCreator.clear();
    this.lastFeedHealthRecordAt = Date.now();
    // Feed insurance: a blockSubscribe standby that decodes emit_cpi inner
    // instructions and loses every race while pump still emits logs. Hosts
    // come from a hardcoded list (shared/types BLOCK_FEED_WSS_URLS); the
    // validator refuses anything else, so this cannot be pointed elsewhere.
    const blockUrls = (s.rpc.blockFeed ?? true) ? [s.rpc.blockWssUrl || DEFAULT_BLOCK_FEED_WSS_URL] : [];
    this.feed = new FeedManager(
      feedUrls,
      s.rpc.commitment,
      {
        onLogs: (n) => this.onLogs(n),
        onState: (state, detail) => {
          this.feedState = state;
          this.log('info', `feed: ${state} (${detail})`);
          this.pushStatus();
        },
        onSubscribeError: (host, message) => this.log('warn', `feed: ${host} rejected subscribe — ${message}`),
      },
      PUMP_PROGRAM_ID,
      {},
      blockUrls.length ? { urls: blockUrls, decodeInner: decodeCpiEventData } : undefined,
    );
    this.feed.start();
    // Post-migration capture: one socket (primary WSS only — this is a data
    // asset, not a race) on the pump-amm program, recording raw event
    // payloads for offline decoding. Its state never touches feedState.
    // The amm block standby is a separate opt-in (~3 MB/s): publicnode
    // delivers nothing for the pAMM program id, so it filters on the
    // global-config account every swap touches instead.
    const ammBlockUrls = s.rpc.blockFeedAmm === true ? blockUrls : [];
    this.ammFeed = new FeedManager(
      [feedUrls[0]],
      s.rpc.commitment,
      {
        onLogs: (n) => this.onAmmLogs(n),
        onState: (state, detail) => this.log('info', `amm tape: ${state} (${detail})`),
      },
      PUMP_AMM_PROGRAM_ID,
      {},
      ammBlockUrls.length ? { urls: ammBlockUrls, decodeInner: decodeCpiAmmEventData, mentions: PUMP_AMM_GLOBAL_CONFIG } : undefined,
    );
    this.ammFeed.start();
    // New Raydium pools for the Migrated column: two subscriptions that sit
    // idle between creations (see raydiumWatcher.ts).
    raydiumWatcher.startCreations();

    // Priority feed: attached in the constructor (it also serves the terminal's
    // open tokens); the 1 s priorityTick below keeps it pointed at held mints.
    this.tickTimer = setInterval(() => {
      this.positions.tick();
      this.decideDue();
    }, 500);
    this.statusTimer = setInterval(() => {
      this.feedHealthTick();
      this.shadowSummaryTick();
      this.priorityTick();
      this.creditTick();
      this.pushStatus();
    }, 1_000);
    // Program-upgrade watchdog: verify Pump's deployment slot against the
    // recorded baseline now and periodically. A change = fail closed.
    void this.checkProgramUpgrade();
    this.programCheckTimer = setInterval(() => void this.checkProgramUpgrade(), PROGRAM_CHECK_INTERVAL_MS);
    // Execution telemetry: keep priority-fee + Jito tip estimates warm so
    // shadow plans (and, later, live sends) price off fresh data.
    void this.refreshExecution();
    this.execTimer = setInterval(() => void this.refreshExecution(), 8_000);
    this.log('info', `scanner started — watching Pump.fun via ${feedUrls.length} racing socket(s); flagging potential runners`);
    // Recordings travel (shared for analysis) — never let an API key in.
    recorder.record('engine_start', { wss: feedUrls.map((u) => u.replace(/api-key=[^&]+/gi, 'api-key=***')) });
    this.pushStatus();
    return { ok: true, message: 'Scanner started — potential runners will be flagged' };
  }

  private async checkProgramUpgrade(): Promise<void> {
    const s = this.getSettings();
    const r = await programWatch.checkProgram(s.rpc.httpUrl, PUMP_PROGRAM_ID);
    if (!r.ok) {
      this.log('warn', `program watchdog: ${r.message}`);
      return;
    }
    if (r.changed && !this.hardPauseReason) {
      this.hardPauseReason = PROGRAM_UPGRADE_PAUSE;
      this.armedWhenUpgradeHit = this.armed;
      this.disarm('program_upgrade');
      this.log('error', `program watchdog: ${r.message} — entries paused, recording continues`);
      this.emit({ kind: 'toast', level: 'error', message: 'Pump program upgraded — new entries paused while the decoder is re-checked' });
      // A toast is gone in seconds, and on 2026-09-23 this disarm left a live
      // script refusing every buy for eight hours with nobody the wiser. A
      // desktop notification (and the paired chat bot) is what reaches
      // someone who is not looking. No target: never posted to a channel.
      this.notify('Live trading switched OFF', 'pump.fun upgraded its program. Krypto Bot disarmed live trading as a safety check. Scripts and orders cannot buy until you re-arm.');
      recorder.record('program_upgrade', { programId: PUMP_PROGRAM_ID, detail: r.message });
    } else if (!r.changed) {
      this.log('info', `program watchdog: ${r.message}`);
    }
    // Pause FIRST, verify second. If the pause is ours to lift, try to lift
    // it — on this pass and on every later one, because the reason it failed
    // may be a provider that was down rather than a program that changed.
    if (r.changed && r.deployedSlot !== undefined && r.programdata && this.hardPauseReason === PROGRAM_UPGRADE_PAUSE) {
      await this.tryReverifyDecoder(r.deployedSlot, r.programdata);
    }
  }

  /**
   * Re-read what the decoder assumes and lift the pause only if it all still
   * holds.
   *
   * The watchdog used to be a one-way door: `acceptCurrent()` had no caller,
   * `hardPauseReason` is never assigned null, and the baseline kept the old
   * slot — so a redeploy disabled live buys permanently, across restarts,
   * recoverable only by deleting program-baseline.json by hand. Verified
   * against the 2026-09-09 redeploy (slot 433095571 → 445691021).
   *
   * "Could not verify" is never "verified": an RPC that will not answer, a
   * sample that cannot be read, or any failing check all leave the pause in
   * place and it is retried on the next watchdog pass.
   */
  private async tryReverifyDecoder(deployedSlot: number, programdata: string): Promise<void> {
    if (this.reverifyInFlight) return;
    this.reverifyInFlight = true;
    try {
      const s = this.getSettings();
      // Freshest first: a mint the feed saw seconds ago is the one most
      // likely to still have an open curve and recent trades to read.
      const samples = [...this.tokens.values()]
        .sort((a, b) => b.row.detectedAt - a.row.detectedAt)
        .map((t) => t.row.mint)
        .slice(0, 8);
      const v = await verifyDecoder(s.rpc.execHttpUrl ?? s.rpc.httpUrl, samples);
      for (const c of v.checks) this.log(c.pass ? 'info' : 'warn', `decoder check ${c.name}: ${c.pass ? 'PASS' : 'FAIL'} — ${c.detail}`);
      recorder.record('decoder_verify', { programId: PUMP_PROGRAM_ID, deployedSlot, ok: v.ok, checks: v.checks });
      if (!v.ok) {
        // A verification that failed only because the feed has not seen a
        // launch yet is not evidence of anything — at engine start `tokens`
        // is empty, and the watchdog's own interval is ten minutes. Come back
        // in a minute rather than leaving buys paused that long for a reason
        // that has nothing to do with the program.
        const noSampleYet = samples.length === 0 && v.checks.some((c) => c.name === 'curve-layout' && /no recent pump mint/.test(c.detail));
        this.log(
          noSampleYet ? 'info' : 'error',
          noSampleYet
            ? 'program watchdog: no launch seen yet to re-check the decoder against — retrying shortly, entries stay paused'
            : `program watchdog: ${v.summary} — entries stay paused, will retry`,
        );
        if (noSampleYet && !this.reverifySoonTimer) {
          this.reverifySoonTimer = setTimeout(() => {
            this.reverifySoonTimer = null;
            void this.checkProgramUpgrade();
          }, 60_000);
          this.reverifySoonTimer.unref?.();
        }
        return;
      }
      // The address just observed, never the stored one.
      programWatch.acceptCurrent(PUMP_PROGRAM_ID, deployedSlot, programdata);
      this.hardPauseReason = null;
      // Re-arm only what the upgrade itself disarmed, only when asked to,
      // and only if nothing else has touched the mode since (a user who
      // armed or disarmed in between has decided for themselves).
      const wanted = this.armedWhenUpgradeHit;
      this.armedWhenUpgradeHit = false;
      if (
        wanted &&
        !this.armed &&
        this.lastDisarmReason === 'program_upgrade' &&
        this.getSettings().execution.rearmAfterVerifiedUpgrade !== false &&
        this.onRearmAfterUpgrade
      ) {
        const r = this.onRearmAfterUpgrade();
        if (r.ok) {
          this.log('warn', `program watchdog: ${v.summary} — entries resume and live is RE-ARMED automatically (Wallet → "Re-arm after a checked pump upgrade")`);
          this.emit({ kind: 'toast', level: 'success', message: 'pump.fun upgrade checked out — live trading is back ON.' });
          this.notify('Live trading is back ON', 'The pump.fun upgrade checked out against real launches, so live was re-armed automatically.');
          return;
        }
        this.log('warn', `program watchdog: re-check passed but re-arming failed (${r.message}) — live stays off`);
      }
      this.log('warn', `program watchdog: ${v.summary} — entries resume; live execution stays DISARMED until you arm it`);
      this.emit({
        kind: 'toast',
        level: 'success',
        message: 'Decoder re-verified against the new pump deployment — entries resume. Live execution is still disarmed.',
      });
      if (wanted) this.notify('Safe to re-arm live trading', 'The pump.fun upgrade checked out. Live is still OFF until you switch it back on in the top bar.');
    } catch (e) {
      this.log('warn', `decoder re-verify failed to run (${(e as Error)?.message ?? 'unknown'}) — entries stay paused`);
    } finally {
      this.reverifyInFlight = false;
    }
  }

  /**
   * Every socket down, positions and orders untouched.
   *
   * A lid closing stops the network without closing a socket: each class only
   * notices when its own ping deadline expires, and then they all redial in
   * the same millisecond — into a budget of TEN pubsub connections per IP,
   * where the eleventh handshake is a 429 that parks the host for 30 s for
   * everyone. Measured 2026-09-09. Exits are unaffected: broadcast is never
   * gated, and confirmation falls back to HTTP polling with no socket.
   */
  suspendSockets(why: string): void {
    this.log('info', `sockets suspended (${why})`);
    this.feed?.stop();
    this.ammFeed?.stop();
    priorityFeed.stop();
    walletWatcher.stop();
    dbcWatcher.stopAll();
    launchLabWatcher.stopAll();
    boopWatcher.stopAll();
    raydiumWatcher.stopAll();
  }

  /** Back up in priority order, one every 750 ms, so ten handshakes are not
   *  one burst against a ten-connection budget. Order matters: the things a
   *  user could be about to act on come first. */
  resumeSockets(): void {
    this.log('info', 'sockets resuming');
    const steps: Array<() => void> = [
      () => this.priorityTick(),
      () => this.syncCopyWatch(),
      () => {
        if (this.running) this.feed?.start();
      },
      () => {
        if (this.running) this.ammFeed?.start();
      },
      () => {
        if (this.running) raydiumWatcher.startCreations();
      },
    ];
    steps.forEach((fn, i) =>
      setTimeout(() => {
        try {
          fn();
        } catch {
          /* one socket failing to come back must not stop the rest */
        }
      }, i * 750),
    );
  }

  stop(): { ok: boolean; message: string } {
    // DBC pool watches are independent of the launch scanner, but stopping
    // the engine should still release their sockets.
    dbcWatcher.stopAll();
    launchLabWatcher.stopAll();
    boopWatcher.stopAll();
    raydiumWatcher.stopAll();
    // The fast socket also carries the terminal's open-token tape, which is
    // not the scanner's to stop — release only the mints held for positions.
    for (const p of this.positions.all()) {
      if (!tape.isSubscribed(p.mint)) priorityFeed.unwatch(p.mint);
    }
    this.chartTicks.clear();
    if (!this.running) return { ok: false, message: 'Engine is not running' };
    this.running = false;
    this.feed?.stop();
    this.ammFeed?.stop();
    this.ammFeed = null;
    this.feed = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.programCheckTimer) clearInterval(this.programCheckTimer);
    if (this.reverifySoonTimer) clearTimeout(this.reverifySoonTimer);
    this.reverifySoonTimer = null;
    if (this.execTimer) clearInterval(this.execTimer);
    this.tickTimer = null;
    this.statusTimer = null;
    this.programCheckTimer = null;
    this.execTimer = null;
    for (const t of this.orphanTimers) clearTimeout(t);
    this.orphanTimers.clear();
    this.positions.killAll('engine_stopped');
    // Never leave real tokens behind: after the paper closes (which fire
    // their own live sells for known mints), liquidate anything the wallet
    // still actually holds. Chained behind in-flight live trades.
    const s2 = this.getSettings();
    if (s2.execution.liveEnabled && s2.execution.autoSellOnExit) {
      this.sellAllHeld('engine_stopped');
    }
    recorder.record('engine_stop', {});
    recorder.flushSync();
    creators.flush();
    this.log('info', 'engine stopped');
    this.pushStatus();
    return { ok: true, message: 'Engine stopped' };
  }

  /**
   * The kill switch is reached from the crash panel, where the user has no
   * working UI and needs everything to stop. Closing paper positions while
   * leaving the engine running and live execution armed — which is what this
   * did — is the opposite of what both callers promise. It now stops the
   * engine and disarms; real holdings are deliberately NOT sold, because
   * dumping a bag at market is not a decision to make on the user's behalf
   * while their screen is broken.
   */
  killSwitch(): { ok: boolean; message: string } {
    this.positions.killAll('kill_switch');
    const wasArmed = this.armed;
    if (wasArmed) this.disarm('kill_switch');
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.log('warn', `kill switch: paper positions closed${wasArmed ? ', live execution disarmed' : ''}${wasRunning ? ', engine stopped' : ''}`);
    const held = this.stuckMints.size + this.liveMints.size;
    return {
      ok: true,
      message: held
        ? `Engine stopped and live execution disarmed. ${held} real holding(s) are untouched — sell them from the Holdings page.`
        : 'Engine stopped and live execution disarmed. Paper positions closed.',
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  snapshot(): EngineSnapshot {
    return {
      status: this.status(),
      launches: this.launchOrder.map((m) => this.tokens.get(m)!.row).filter(Boolean),
      positions: this.positions.all(),
      settings: this.getSettings(),
      runners: this.runners,
    };
  }

  /** The single gate for opening new positions. Returns null when entries
   *  are allowed, otherwise the human-readable reason (fail closed). */
  private entriesPauseReason(): string | null {
    if (this.hardPauseReason) return this.hardPauseReason;
    if (this.feedState !== 'live') return 'Feed is not live';
    if (Date.now() - this.lastEventAt > FRESHNESS_LIMIT_MS) return 'Feed data is stale';
    const s = this.getSettings();
    // When live trading, REAL results govern — not the parallel paper run.
    if (this.manualLiveActive()) {
      const r = this.liveBreakerReason();
      if (r) return r;
    } else {
      if (this.positions.realizedPnlSol() <= -s.strategy.maxSessionLossSol)
        return `Paper session loss limit (−${s.strategy.maxSessionLossSol} SOL)`;
      if (Date.now() < this.lossCooldownUntil)
        return `Cooling down after ${s.strategy.maxConsecutiveLosses} consecutive paper losses`;
    }
    return null;
  }

  /** Real SOL lost since live went active (negative = up). Swept profit is
   *  counted back in so a cashout never reads as a loss. */
  /** REALISED SOL lost this live session: the sum of the reconciled sell
   *  fills' PnL since arm(), sign-flipped so a loss is positive. Capital
   *  sitting in open positions is not a loss — the old balance-delta rule
   *  counted every 0.05 SOL buy as 0.05 SOL "lost" and tripped the 0.03 SOL
   *  limit on the first trade. Unknown-basis sells contribute nothing. */
  /** Realised SOL on closed live trades since arming, gains included. The
   *  loss breaker only wants the negative side; auto-cashout needs both. */
  private liveRealisedSol(): number {
    const since = this.armedAt;
    if (since === null) return 0;
    const active = wallet.publicKey();
    let pnl = 0;
    for (const f of ledger.all()) {
      if (f.side !== 'sell' || f.state !== 'reconciled' || f.at < since) continue;
      if (f.wallet && f.wallet !== active) continue; // other wallets are not this session's trading
      const r = ledger.realizedPnlForSell(f);
      if (r !== null && Number.isFinite(r)) pnl += r;
    }
    return pnl;
  }

  private liveSessionLossSol(): number {
    const since = this.armedAt;
    if (since === null) return 0;
    let pnl = 0;
    const active = wallet.publicKey();
    for (const f of ledger.all()) {
      if (f.side !== 'sell' || f.state !== 'reconciled' || f.at < since) continue;
      if (f.wallet && f.wallet !== active) continue; // lab legs are not this session's trading
      const r = ledger.realizedPnlForSell(f);
      if (r !== null && Number.isFinite(r)) pnl += r;
    }
    return pnl < 0 ? -pnl : 0;
  }

  /** PAPER consecutive-loss cooldown — only governs PAPER-mode entries now
   *  (see entriesPauseReason). Never disarms live trading. */
  private updateBreakers(): void {
    const s = this.getSettings().strategy;
    if (
      this.positions.consecutiveLosses() >= s.maxConsecutiveLosses &&
      Date.now() >= this.lossCooldownUntil
    ) {
      this.lossCooldownUntil = Date.now() + LOSS_COOLDOWN_MS;
      this.log('warn', `${s.maxConsecutiveLosses} consecutive paper losses — paper entries cooling down`);
    }
  }

  /** Why a real BUY is blocked right now (loss limit, losing streak, hard
   *  pause), or null. BUYS ONLY — sells never consult this. */
  private liveBreakerReason(): string | null {
    const e = this.getSettings().execution;
    return liveBreakerReason(
      { sessionLossSol: this.liveSessionLossSol(), consecutiveLosses: this.liveConsecutiveLosses, hardPauseReason: this.hardPauseReason },
      { maxLiveSessionLossSol: e.maxLiveSessionLossSol, maxLiveConsecutiveLosses: e.maxLiveConsecutiveLosses },
    );
  }

  /** LIVE breakers — disarm real trading on real losses. Called after each
   *  reconciled live sell (streak), on the balance poll (session loss) and
   *  before every user-facing buy. Disarming is what snaps the UI back to
   *  Paper — the same path every other safety trip takes. */
  private updateLiveBreakers(): void {
    if (!this.armed) return;
    const e = this.getSettings().execution;
    // ONE rule for both the buy gate and the disarm: shared/liveBreakers.ts,
    // where a limit of 0 means OFF. This used to compare `loss >= limit`
    // directly, so the 0 default (breakers opt-in since 2026-08-29) tripped
    // on every balance poll — "loss limit (−0 SOL)" disarmed a beta user in
    // Live mode within seconds of arming (2026-08-30).
    const reason = liveBreakerReason(
      { sessionLossSol: this.liveSessionLossSol(), consecutiveLosses: this.liveConsecutiveLosses, hardPauseReason: null },
      { maxLiveSessionLossSol: e.maxLiveSessionLossSol, maxLiveConsecutiveLosses: e.maxLiveConsecutiveLosses },
    );
    if (!reason) return;
    this.disarm('loss_limit');
    this.log('error', `${reason} — live trading disarmed`);
    this.emit({ kind: 'toast', level: 'error', message: `${reason} — disarmed` });
  }

  status(): EngineStatus {
    const now = Date.now();
    this.eventTimes = this.eventTimes.filter((t) => now - t < 10_000);
    const lat = this.decodeLatencies;
    const pause = this.running ? this.entriesPauseReason() : null;
    return {
      running: this.running,
      feed: this.feedState,
      slot: this.feed?.lastSlot ?? 0,
      decodeLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      eventsPerSec: Math.round((this.eventTimes.length / 10) * 10) / 10,
      launchesSeen: this.counters.seen,
      launchesEvaluated: this.counters.evaluated,
      launchesEntered: this.counters.entered,
      runnersFlagged: this.runners.length,
      launchesRejected: this.counters.rejected,
      launchesFiltered: this.counters.filtered,
      openPositions: this.positions.openCount(),
      closedPositions: this.positions.closedCount(),
      realizedPnlSol: Math.round(this.positions.realizedPnlSol() * 1e6) / 1e6,
      startedAt: this.startedAt,
      entriesPaused: pause !== null,
      pauseReason: pause,
      layoutErrors: this.layoutErrorTotal,
      feedSockets: this.feed?.getStats() ?? [],
      feedInsurance: this.running
        ? { emitDropped: this.emitDropped, blockDelivering: this.blockDelivering, undecodedPct: this.lastUndecodedPct }
        : undefined,
      feedLossPct: this.running ? this.continuity.snapshot().lossPct : null,
      liveActive: this.manualLiveActive(),
      liveBuys: this.liveBuys,
      liveSells: this.liveSells,
      liveSessionStartedAt: this.liveSessionAt,
      liveSessionReason: this.liveSessionWhy,
      liveRealizedPnlSol:
        this.liveBaselineLamports !== null && this.walletBalanceLamports !== null
          ? Math.round((this.walletBalanceLamports + this.sweptLamports - this.liveBaselineLamports) / 1e3) / 1e6
          : null,
      // The session's REAL fills, trips and open positions — what the
      // Observatory ledger shows while armed. Read from the kept portfolio
      // build (never triggers one: this runs every second) and only when
      // that build is the active wallet's.
      liveSession:
        this.liveSessionAt !== null
          ? liveSessionLedger(
              this.liveSessionAt,
              ledger.all(),
              this.lastPortfolio && this.lastPortfolio.owner === (wallet.publicKey() ?? '') ? this.lastPortfolio.summary : null,
              wallet.publicKey(),
            )
          : null,
      walletBalanceSol: this.walletBalanceLamports !== null ? this.walletBalanceLamports / 1e9 : null,
    };
  }

  /** Poll the priority-fee estimate + Jito tip floor. Scope fees to the
   *  most recently entered token's accounts (local fee markets). */
  private async refreshExecution(): Promise<void> {
    // Corroded builds get staler execution telemetry (worse fills). Zero delay
    // on a genuine build. Also the once-per-run tamper notice — another
    // independent detection site, deliberately far from the buy path.
    const corrodeDelay = scanExtraDelayMs();
    if (corrodeDelay > 0) await new Promise((r) => setTimeout(r, corrodeDelay));
    if (detectedTamper() && !this.tamperLogged) {
      this.tamperLogged = true;
      this.log('warn', 'runtime self-check failed — this build appears modified; reinstall from krypt.cc');
    }
    const s = this.getSettings();
    // Scope the fee estimate to a live bonding curve if we have one, else
    // the Pump program itself.
    const recentToken = [...this.tokens.values()].reverse().find((t) => t.addr);
    const scope = recentToken?.addr
      ? [recentToken.addr.bondingCurve, recentToken.addr.creatorVault]
      : ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'];
    // The periodic poll runs all day — keep it on the free endpoint. Spend
    // Helius credits on the better getPriorityFeeEstimate only while real
    // buys are actually armed, when fee quality pays for itself.
    const feeUrl = this.autoLiveActive() ? (s.rpc.execHttpUrl ?? s.rpc.httpUrl) : s.rpc.httpUrl;
    // The balance read below must not depend on the fee and tip providers:
    // a rejected estimate used to abandon this whole poll, and with it the
    // only periodic balance read the session PnL had. Logged once per
    // failure streak, not every 8 s.
    try {
      const [fee] = await Promise.all([
        feeEstimator.estimate(feeUrl, scope),
        s.execution.useJito ? jitoTips.refresh() : Promise.resolve(jitoTips.current()),
      ]);
      this.feeEstimate = fee;
      this.feeEstimateFailing = false;
    } catch (err) {
      if (!this.feeEstimateFailing) this.log('warn', `fee estimate failed: ${(err as Error).message} — the last estimate stands`);
      this.feeEstimateFailing = true;
    }

    // Track the trading wallet balance so the UI can show real live PnL as
    // the actual balance change since live went active.
    const owner = wallet.publicKey();
    if (owner) {
      const bal = await getBalance(s.rpc.httpUrl, owner);
      if (bal.ok && bal.data !== undefined) {
        this.walletBalanceLamports = bal.data;
        wallet.noteBalance(owner, bal.data);
        // Capture the baseline the first time real trading becomes active.
        if (this.manualLiveActive() && this.liveBaselineLamports === null) {
          this.liveBaselineLamports = bal.data;
          this.liveBalanceAtLastSell = bal.data;
          this.log('info', `live PnL baseline set at ${(bal.data / 1e9).toFixed(4)} SOL`);
        }
        // Session-loss breaker on the real wallet.
        this.updateLiveBreakers();
        // Profit sweep — runs off the same balance poll.
        void this.maybeCashout();
      }
    }
  }

  /** Build the shadow send plan for an entered token — what a LIVE buy
   *  would submit. Purely descriptive; nothing is signed or sent. */
  private buildShadowSend(t: TrackedToken, quoteLamports: bigint): void {
    if (!t.addr || !this.feeEstimate) return;
    try {
      const plan = buildShadowPlan({
        mint: t.row.mint,
        symbol: t.row.symbol,
        owner: SHADOW_WALLET,
        quoteLamports,
        exec: this.getSettings().execution,
        fee: this.feeEstimate,
        tips: jitoTips.current(),
        addr: t.addr,
        firstBuy: !this.firstBuyDone,
      });
      this.firstBuyDone = true;
      this.shadowPlans.unshift(plan);
      if (this.shadowPlans.length > 50) this.shadowPlans.length = 50;
      recorder.record('shadow_send', {
        mint: plan.mint,
        cuPrice: plan.computeUnitPrice,
        lanes: plan.lanes.map((l) => l.lane),
        estCostLamports: plan.estCostLamports,
      });
      this.log('info', `shadow send plan for ${t.row.symbol}: ${plan.lanes.map((l) => l.lane).join('+')} · ~${(plan.estCostLamports / 1e9).toFixed(5)} SOL cost`);
    } catch (err) {
      this.log('warn', `shadow plan build failed: ${(err as Error).message}`);
    }
  }

  // ── Arming (gated behind LIVE_EXECUTION_AVAILABLE) ────────────────

  liveState(): LiveState {
    return {
      available: LIVE_EXECUTION_AVAILABLE,
      armed: this.armed,
      armedAt: this.armedAt,
      lastDisarmReason: this.lastDisarmReason,
    };
  }

  /**
   * Manual/one-off live trade — the intended first use of real execution.
   * Runs the full relayer→validate→simulate→(guard)→sign→send pipeline.
   * `simulateOnly` stops before broadcast (free, safe dry run). A real
   * broadcast additionally requires the engine armed + execution.liveEnabled.
   */
  async testTrade(
    mint: string,
    sol: number,
    simulateOnly: boolean,
    opts: {
      manual?: boolean;
      slippagePct?: number;
      /**
       * The CALLER's own per-trade cap, when it has one it already enforces.
       *
       * A script's budget is set on the same screen as its code and is the
       * thing its author actually decided; making it also answer to the
       * manual per-trade cap meant keeping two numbers in step for one
       * decision, and the smaller one winning silently to whoever set the
       * other. When this is given it REPLACES `execution.maxLiveSol` below —
       * it does not add a second limit, and it is still a refusal rather than
       * a clamp.
       */
      ownCapSol?: number;
    } = {},
  ): Promise<EngineTradeResult> {
    const { executeTrade } = await import('./liveSigner');
    const s = this.getSettings();
    const wantBroadcast = !simulateOnly;
    if (wantBroadcast && !this.armed) {
      return { ok: false, stage: 'validate', message: 'Arm the engine before a real trade' };
    }
    if (wantBroadcast && !s.execution.liveEnabled) {
      return { ok: false, stage: 'validate', message: 'Enable live execution in settings before a real trade' };
    }
    // Real-money breakers gate every user-facing BUY (quick buy, trade panel,
    // hotkeys, orders, copy trade). Tripping one disarms → Paper.
    if (wantBroadcast) {
      const breaker = this.liveBreakerReason();
      if (breaker) {
        this.updateLiveBreakers();
        return { ok: false, stage: 'validate', message: `Live buys paused — ${breaker}` };
      }
    }
    // The per-trade cap bounds execution that happens WITHOUT a click at that
    // moment — advanced orders, copy trade, fan-out, the automation path. A
    // trade the user is placing by hand right now is their call at whatever
    // size they typed (2026-09-02, user's call: "if the trade is above their
    // cap that shouldn't matter, it's them doing it manually"). The simulation
    // loss guard and the wallet balance still bound it.
    //
    // House rule 2: a budget is a REFUSAL, not a clamp. This used to be a
    // silent `Math.min`, which is the parity break the copy-trade audit found
    // (copy-8): copyTrade, advOrders and the script budgets all refuse over
    // the cap and say so, while a buy that reached here was quietly shrunk and
    // then recorded at a size it never traded. Every unattended caller already
    // checks the cap before it gets here, so this is the backstop and it
    // names the cap it is enforcing.
    // The caller's own cap when it brought one (a script's budget), else the
    // app-wide manual cap. Either way there is exactly one number, and it is
    // named in the refusal so nobody hunts for which limit bit.
    const unattendedCap = opts.ownCapSol ?? s.execution.maxLiveSol;
    if (!opts.manual && !simulateOnly && sol > unattendedCap) {
      return {
        ok: false,
        stage: 'validate',
        message:
          opts.ownCapSol !== undefined
            ? `${sol} SOL is above this script's max per trade of ${unattendedCap} SOL.`
            : `${sol} SOL is above your per-trade cap of ${unattendedCap} SOL.`,
      };
    }
    // A dry run spends nothing, so the cap only SHAPES it: paper keeps
    // modelling the trade at the size live would have been allowed, rather
    // than refusing a rehearsal over a limit no money is crossing.
    let capped = opts.manual || !simulateOnly ? sol : Math.min(sol, unattendedCap);
    if (opts.manual && sol > s.execution.maxLiveSol && !simulateOnly) {
      this.log('info', `manual buy ${sol} SOL is above the ${s.execution.maxLiveSol} SOL per-trade cap — allowed (manual)`);
    }
    // Whatever the size, the wallet keeps enough SOL to SELL this again. A
    // sell pays its fees before the swap can return anything, so a buy that
    // spends the last of the balance leaves a position that cannot be
    // exited — which happened for real on 2026-09-05. This is arithmetic,
    // not a policy cap: it only ever trims, and it says so.
    if (!simulateOnly && this.walletBalanceLamports !== null) {
      const plan = planBuySize(this.walletBalanceLamports, Math.round(capped * 1e9));
      if (plan.refused) {
        this.log('warn', `buy refused: ${plan.note}`);
        return { ok: false, stage: 'validate', message: plan.note ?? 'Not enough SOL to trade' };
      }
      if (plan.note) {
        capped = Math.floor((plan.lamports / 1e9) * 1e6) / 1e6;
        this.log('warn', `buy trimmed: ${plan.note}`);
        this.emit({ kind: 'toast', level: 'warn', message: plan.note });
      }
    }
    const httpUrl = s.rpc.execHttpUrl ?? s.rpc.httpUrl;
    // A dry run feeds the paper book, which needs the mint's decimals to turn
    // the simulated token receipt into a countable amount. Read them from the
    // chain (one cheap call, paper only); unknown stays unknown.
    let decimals: number | undefined;
    if (simulateOnly) {
      try {
        const sup = await getTokenSupply(httpUrl, mint);
        if (sup.ok && sup.data) decimals = sup.data.decimals;
      } catch {
        /* decimals unknown → raw receipt, flagged */
      }
    }
    // A simulation is signed by, and pays fees from, the real wallet. With no
    // wallet — or one too empty to cover a fee — it cannot run at all, and
    // paper mode must not depend on money the user has deliberately not put
    // in. Model the fill from the live price instead.
    if (simulateOnly) {
      const bal = this.walletBalanceLamports;
      const cannot = !wallet.exists()
        ? 'this install has no wallet yet'
        : bal !== null && bal < LEAN_EXIT_LAMPORTS
          ? 'the wallet has too little SOL to simulate a transaction'
          : null;
      if (cannot) return this.paperFillFromPrice(mint, capped, decimals, cannot);
    }

    const res = await executeTrade({
      action: 'buy',
      mint,
      amount: capped,
      denominatedInSol: true,
      // A caller that states its own tolerance is honoured (copy trading's
      // per-follower `maxSlippagePct`, which had no execution path at all
      // before 2026-09-09). Everything else takes the execution setting.
      slippagePct: opts.slippagePct !== undefined && opts.slippagePct > 0 ? opts.slippagePct : s.execution.liveSlippagePct,
      priorityFeeSol: this.priorityFeeSolFor('buy'),
      httpUrl,
      simulateOnly,
      decimals,
      // Manual trades take a pasted mint the feed may never have seen — fetch
      // its curve state on demand so the local builder can build it.
      local: await this.localBuildParamsAsync(mint),
      localWhy: s.execution.localTxBuild ? this.localUnavailable.get(mint) : undefined,
      exec: s.execution,
      wssUrl: this.confirmWssUrl(),
      onProcessed: (sig) => this.emitFill(mint, 'buy', sig, 'landed'),
    });
    recorder.record('live_trade', { mint, sol: capped, simulateOnly, ok: res.ok, stage: res.stage, signature: res.signature ?? null, note: res.message.slice(0, 220), timing: res.timing ?? null });
    if (!simulateOnly && res.signature) {
      if (res.ok) this.emitFill(mint, 'buy', res.signature, 'landed');
      else if (res.stage === 'confirm') this.emitFill(mint, 'buy', res.signature, 'failed');
    }
    // Auto-sell template: arm the exit the user already decided on. These are
    // ordinary advanced orders — they appear on the Orders page and can be
    // cancelled — placed the moment there is a position to protect, rather
    // than typed out again per token.
    // A pump.fun callout on what was just bought, when the wallet has an
    // account and pump's own preflight allows it. Off by default, and a
    // refusal is reported rather than retried (autoCallout.ts).
    //
    // MANUAL buys only — the same gate as the template orders below. A script,
    // a copy config or an advanced order runs its OWN social flow (scorenow
    // posts + likes from its account pool); the app grabbing the one callout
    // pump allows per coin off the back of the script's buy is exactly the
    // interference the user hit — the auto-call from the active account beat
    // the script to it, and the script's like pool then found "already called"
    // (2026-09-24). Automation is separate; this is for hand buys.
    if (opts.manual && !simulateOnly && res.ok) this.autoCallout(mint, capped);
    if (opts.manual && !simulateOnly && res.ok) this.armTemplateOrders(mint);
    if (!res.ok && res.stage !== 'pending') {
      this.log('warn', `live buy FAILED ${mint} (${capped} SOL, stage ${res.stage}): ${res.message}`);
    }
    // A landed buy goes to the ledger, which reconciles it against the chain
    // in the background so the portfolio's cost basis is the real number and
    // not the amount we asked for.
    // A PENDING buy (broadcast, unconfirmed, not provably dead) is recorded
    // too: the ledger keeps polling the signature and books it if it lands,
    // instead of the user rebuying a bag they may already hold.
    if ((res.ok || res.stage === 'pending') && !simulateOnly && res.signature) {
      ledger.recordFill(
        { mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'buy', requested: capped, signature: res.signature },
        { httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner: wallet.publicKey() },
      );
    }
    this.log(res.ok ? 'info' : 'warn', `live ${simulateOnly ? 'dry-run' : 'trade'} (${res.stage}): ${res.message}`);
    // PAPER: a successful dry run opens a paper position from the
    // simulation's own numbers (tokens the ATA would hold, SOL the wallet
    // would lose). Nothing is recorded in the ledger or the real portfolio.
    if (simulateOnly && res.ok && res.simulatedTokensReceived !== undefined && res.simulatedCostSol !== undefined) {
      const symbol = await this.paperSymbolFor(mint);
      const opened = paperBook.open({
        mint,
        symbol,
        tokens: res.simulatedTokensReceived,
        costSol: res.simulatedCostSol,
        decimalsKnown: res.decimalsKnown === true,
      });
      if (opened.ok) {
        const tokensText = res.decimalsKnown
          ? `${res.simulatedTokensReceived.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens`
          : `${res.simulatedTokensRaw ?? '?'} raw units (decimals unknown)`;
        this.log('info', `PAPER buy ${symbol || mint.slice(0, 8)}: ${tokensText} for ${res.simulatedCostSol.toFixed(5)} SOL (simulated fill)`);
        this.emit({ kind: 'paper', mint, side: 'buy' });
        return { ...res, message: `Paper position opened — ${tokensText} for ${res.simulatedCostSol.toFixed(4)} SOL (simulated fill)` };
      }
      this.log('warn', `PAPER buy not booked: ${opened.message}`);
      return { ...res, message: `${res.message} — ${opened.message}` };
    }
    // The simulation could not run or reverted. That is a fact about this
    // wallet or this RPC, not about whether the trade was worth practising,
    // so paper falls back to a modelled fill rather than failing.
    if (simulateOnly && !res.ok) {
      const why = res.stage === 'simulate' ? 'the chain simulation could not run' : `the ${res.stage} step failed`;
      this.log('info', `PAPER buy: ${res.message} — modelling the fill instead`);
      return this.paperFillFromPrice(mint, capped, decimals, why);
    }
    // `sentSol` is what was actually submitted after the exit-headroom trim —
    // not the same thing as what the chain took, but never the wish either.
    return { ...res, sentSol: capped };
  }

  /** Paper = the mode the top bar shows as Paper: not (armed AND liveEnabled).
   *  Matches the UI's `isLive` exactly so a button that says "Paper sell"
   *  can never reach the real signer. */
  private paperMode(): boolean {
    return !this.manualLiveActive();
  }

  /**
   * The symbol a paper position is booked under. A pasted mint the launch
   * feed never carried has no tracked row, and a position booked as '' came
   * back as "$???" on the replay and the card (2026-09-06). The market
   * summary is memoised and usually already fetched for the fill price, so
   * this is normally free; a token nobody can name stays ''.
   */
  private async paperSymbolFor(mint: string): Promise<string> {
    const own = this.tokens.get(mint)?.row.symbol ?? market.summaryIfCached(mint)?.symbol ?? '';
    if (own) return own;
    try {
      return (await market.summary(mint)).symbol ?? '';
    } catch {
      return '';
    }
  }

  /** Current SOL price for a paper fill: our tape first, then the market
   *  layer (the number the token page shows). Null = no fill possible. */
  /**
   * Open a paper position from the live price, without asking the chain.
   *
   * A paper buy used to REQUIRE a successful on-chain simulation, which needs
   * a real wallet holding real SOL for fees. So paper trading — the mode that
   * exists to be practised with no money — failed for exactly the people
   * using it that way, with a raw RPC error. This is the fallback, and it is
   * labelled as modelled rather than simulated wherever it shows.
   */
  private async paperFillFromPrice(
    mint: string,
    sol: number,
    decimals: number | undefined,
    why: string,
  ): Promise<import('./liveSigner').LiveTradeResult> {
    const price = await this.paperFillPrice(mint);
    const fill = price === null ? null : modelledPaperFill(sol, price);
    if (!fill) {
      return {
        ok: false,
        stage: 'validate',
        message: `No price for this token yet, so a paper fill cannot be modelled${why ? ` (${why})` : ''}.`,
      };
    }
    const symbol = await this.paperSymbolFor(mint);
    const opened = paperBook.open({
      mint,
      symbol,
      tokens: fill.tokens,
      costSol: fill.costSol,
      decimalsKnown: decimals !== undefined,
    });
    if (!opened.ok) {
      this.log('warn', `PAPER buy not booked: ${opened.message}`);
      return { ok: false, stage: 'validate', message: opened.message };
    }
    const tokensText = `${fill.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens`;
    this.log('info', `PAPER buy ${symbol || mint.slice(0, 8)}: ${tokensText} for ${fill.costSol.toFixed(5)} SOL (modelled fill — ${why})`);
    recorder.record('paper_buy_modelled', { mint, sol, price, tokens: fill.tokens, why });
    this.emit({ kind: 'paper', mint, side: 'buy' });
    return {
      ok: true,
      stage: 'done',
      message: `Paper position opened — ${tokensText} for ${fill.costSol.toFixed(4)} SOL (modelled from the live price, fees included; the chain was not simulated because ${why})`,
    };
  }

  /**
   * A paper buy on Robinhood Chain or BNB.
   *
   * The Solana path asks the chain to simulate the swap. Neither EVM rail has
   * that here, so the fill is MODELLED from the chain's own quoted price
   * through `modelledPaperFill` — the same helper, carrying the same 1.5 % a
   * side a real buy pays, so a paper record is never better than the trade it
   * stands for.
   *
   * No price means no fill. A simulated buy at an invented price is exactly
   * the number this product refuses to show, and it would go on to be sold
   * against a real quote and book an invented profit.
   */
  private evmPaperBuy(chain: EvmChainKind, token: string, native: number): { ok: boolean; message: string } {
    const price = this.evmCopy?.price(chain, token) ?? null;
    if (price === null || !(price > 0)) {
      return { ok: false, message: `no ${nativeSymbolOf(chain)} price for that token yet — paper needs a price to fill against` };
    }
    const fill = modelledPaperFill(native, price);
    if (!fill) return { ok: false, message: 'that amount does not produce a fill at the current price' };
    const r = paperBook.open({ mint: token, chain, symbol: '', tokens: fill.tokens, costSol: fill.costSol, decimalsKnown: true });
    if (!r.ok) return { ok: false, message: r.message };
    recorder.record('paper_buy', { chain, mint: token, native, priceSol: price, tokens: fill.tokens, by: 'script' });
    this.emit({ kind: 'paper', mint: token, side: 'buy' });
    return {
      ok: true,
      message: `Paper position opened on ${EVM_CHAIN_META[chain].name} — ${fill.tokens.toFixed(4)} tokens for ${fill.costSol.toFixed(4)} ${nativeSymbolOf(chain)} (modelled from the quoted price, fees included)`,
    };
  }

  /** The paper exit for the same book. Refuses without a price rather than
   *  realising a made-up number, exactly as the Solana paper sell does. */
  private evmPaperSell(chain: EvmChainKind, token: string, pct: number): { ok: boolean; message: string; realizedSol?: number | null } {
    const pos = paperBook.get(token, chain);
    if (!pos) return { ok: false, message: `no paper position in that token on ${EVM_CHAIN_META[chain].name}` };
    const price = this.evmCopy?.price(chain, token) ?? null;
    const r = paperBook.sell(token, pct, price, chain);
    recorder.record('paper_sell', { chain, mint: token, pct, ok: r.ok, priceSol: price, proceedsSol: r.proceedsSol, realizedSol: r.realizedSol, note: r.message.slice(0, 220), by: 'script' });
    if (r.ok) this.emit({ kind: 'paper', mint: token, side: 'sell' });
    return { ok: r.ok, message: r.message, realizedSol: typeof r.realizedSol === 'number' ? r.realizedSol : null };
  }

  private async paperFillPrice(mint: string): Promise<number | null> {
    const own = this.tokens.get(mint)?.row.priceSol ?? this.lastKnownPriceSol.get(mint) ?? null;
    if (own !== null && own > 0) return own;
    try {
      // A paper fill measures the strategy, so it is held to the same
      // freshness as a real one: a fill priced from a held-over number would
      // flatter or punish a strategy for a provider's outage.
      const sum = await market.freshSummary(mint);
      if (sum && sum.priceSol !== null && sum.priceSol > 0) {
        this.rememberPrice(mint, sum.priceSol);
        return sum.priceSol;
      }
    } catch {
      /* fall through: no price, no fill */
    }
    return null;
  }

  /** Sell from the paper book. Same result shape as a real sell so the UI's
   *  toasts work unchanged. Never fills at 0. */
  private async paperSell(mint: string, pct: number): Promise<import('./liveSigner').LiveTradeResult> {
    const pos = paperBook.get(mint);
    if (!pos) return { ok: false, stage: 'validate', message: 'No paper position in this token — switch to Live to sell real holdings' };
    const priceSol = pos.decimalsKnown ? await this.paperFillPrice(mint) : null;
    const r = paperBook.sell(mint, pct, priceSol);
    recorder.record('paper_sell', { mint, pct, ok: r.ok, priceSol, proceedsSol: r.proceedsSol, realizedSol: r.realizedSol, note: r.message.slice(0, 220) });
    if (r.ok) this.emit({ kind: 'paper', mint, side: 'sell' });
    this.log(r.ok ? 'info' : 'warn', `PAPER sell ${pct}% ${pos.symbol || mint.slice(0, 8)}: ${r.message}`);
    return { ok: r.ok, stage: r.ok ? 'done' : 'validate', message: r.message };
  }

  /**
   * Fan-out buy — several wallets buy the same token at once.
   *
   * Each wallet's buy runs the FULL executeTrade pipeline (build → fee inject →
   * per-wallet sign → simulate → loss guard → broadcast), so a fan-out gets no
   * safety shortcut: every wallet is bounded, fee'd and interlocked exactly like
   * a single buy. Gated by the same arm + liveEnabled checks. Only BUYS fan out.
   */
  /**
   * Why a fan-out buy of this shape would be refused right now, or null.
   *
   * The same gates `fanoutBuy` applies, without buying. The launcher asks
   * this BEFORE it creates a token, because a create whose first buy then
   * bounces off a gate is the one outcome it must never produce.
   */
  async fanoutPreflight(walletIds: string[], sizing: { mode: 'same' | 'total'; amountSol: number; jitter?: number }): Promise<string | null> {
    const s = this.getSettings();
    // ── The multi-wallet gate (2026-09-22) ────────────────────────────
    //
    // Only when MORE THAN ONE wallet is involved. One wallet buying one coin
    // is an ordinary buy, and the launcher comes through here with exactly
    // one — requiring the acknowledgement for that would break launching to
    // guard something that is not happening.
    //
    // Checked HERE, in main, rather than only in the form: the form's answer
    // is a courtesy and this one is the rule.
    if (walletIds.length > 1) {
      const { multiWalletProblem } = await import('@shared/multiWallet');
      const why = multiWalletProblem(walletIds.length, s.multiWallet);
      if (why) return why;
    }
    if (!this.armed) return 'Arm the engine before a fan-out buy';
    if (!s.execution.liveEnabled) return 'Enable live execution in settings first';
    const breaker = this.liveBreakerReason();
    if (breaker) {
      this.updateLiveBreakers();
      return `Live buys paused — ${breaker}`;
    }
    const { planFanout } = await import('@shared/fanout');
    const plan = planFanout(walletIds, { mode: sizing.mode, amountSol: sizing.amountSol, jitter: sizing.jitter, minSol: 0.002 });
    if (!plan.ok) return plan.message;
    if (plan.totalLamports / 1e9 > s.execution.maxLiveSol) {
      return `Fan-out total ${(plan.totalLamports / 1e9).toFixed(3)} SOL exceeds the ${s.execution.maxLiveSol} SOL live cap`;
    }
    return null;
  }

  async fanoutBuy(
    mint: string,
    walletIds: string[],
    sizing: { mode: 'same' | 'total'; amountSol: number; jitter?: number },
    /** The space BETWEEN buys, as a RANGE — each gap is drawn from it, so the
     *  spacing is irregular rather than a fixed beat. Floored and capped by
     *  shared/multiWallet.ts: asking for less, or for none, still gets the
     *  floor. */
    opts: { gapMinMs?: number; gapMaxMs?: number } = {},
  ): Promise<{ ok: boolean; message: string; results: Array<{ walletId: string; ok: boolean; stage: string; message: string; signature: string | null }> }> {
    const s = this.getSettings();
    // Every gate, in `fanoutPreflight` — armed, live, the breaker, the
    // per-buy floor, the live cap — so the launcher can ask the same
    // question before it creates anything.
    const refused = await this.fanoutPreflight(walletIds, sizing);
    if (refused) return { ok: false, message: refused, results: [] };

    const { executeTrade } = await import('./liveSigner');
    const { planFanout } = await import('@shared/fanout');
    // Floor each buy at a sane minimum and cap the TOTAL at the live ceiling so
    // a fan-out can never spend more than a single trade is allowed to.
    const plan = planFanout(walletIds, { mode: sizing.mode, amountSol: sizing.amountSol, jitter: sizing.jitter, minSol: 0.002 });
    if (!plan.ok) return { ok: false, message: plan.message, results: [] };

    const local = await this.localBuildParamsAsync(mint);
    const httpUrl = s.rpc.execHttpUrl ?? s.rpc.httpUrl;
    const run = async (walletId: string, sol: number) => {
      const res = await executeTrade({
        action: 'buy',
        mint,
        amount: sol,
        denominatedInSol: true,
        slippagePct: s.execution.liveSlippagePct,
        priorityFeeSol: this.priorityFeeSolFor('buy'),
        httpUrl,
        simulateOnly: false,
        local,
        exec: s.execution,
        walletId,
        wssUrl: this.confirmWssUrl(),
      });
      // A real buy that never reaches the ledger is invisible to cost basis,
      // realised PnL, trade history AND the live loss breakers — and the exit
      // reserve is computed from the ledger too, so an unrecorded fan-out
      // could spend the SOL its own exits were relying on. labBuy has always
      // recorded; this path never did. Pending counts: it is broadcast, and
      // reconciliation resolves the rest.
      const owner = wallet.publicKeyOf(walletId);
      if ((res.ok || res.stage === 'pending') && res.signature && owner) {
        ledger.recordFill(
          { mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'buy', requested: sol, signature: res.signature },
          { httpUrl, owner },
        );
      }
      return { walletId, ok: res.ok, stage: res.stage, message: res.message, signature: res.signature ?? null };
    };

    // ── Spaced, never simultaneous (2026-09-22) ───────────────────────
    //
    // This used to be `Promise.all` with a random delay of up to two seconds,
    // defaulting to ZERO — every wallet buying in the same slot. That is the
    // shape the whole feature was removed for on 2026-09-14, and it is the
    // one thing that separates splitting an entry from bundling.
    //
    // Now the buys are SEQUENTIAL and separated by a real gap, floored in
    // shared/multiWallet.ts so a caller cannot ask for less. Awaiting each
    // buy before starting the next also means the gap is measured between
    // buys that actually went out, not between when they were kicked off.
    //
    // One wallet is an ordinary buy and waits for nothing.
    const { gapRange, randomGap } = await import('@shared/multiWallet');
    const spread = gapRange(opts.gapMinMs ?? 0, opts.gapMaxMs ?? 0);
    const results: Array<{ walletId: string; ok: boolean; stage: string; message: string; signature: string | null }> = [];
    const gaps: number[] = [];
    for (const sh of plan.shares) {
      if (results.length > 0 && plan.shares.length > 1) {
        // A fresh draw each time, not one interval repeated — an exact beat
        // is its own signature.
        const g = randomGap(spread.minMs, spread.maxMs);
        gaps.push(g);
        await new Promise((r) => setTimeout(r, g));
      }
      results.push(await run(sh.wallet, sh.sol));
    }
    const landed = results.filter((r) => r.ok).length;
    // Pending = broadcast but unconfirmed; may still land. Counted apart so
    // nobody re-fires a fan-out over wallets that are about to be filled.
    const pending = results.filter((r) => !r.ok && r.stage === 'pending').length;
    // The gap is recorded too: a split entry and a bundle differ by exactly
    // this number, so the history should say which one happened.
    // The gaps are recorded too: a split entry and a bundle differ by exactly
    // these numbers, so the history should say which one happened.
    recorder.record('fanout_buy', { mint, wallets: results.length, landed, pending, total: plan.totalLamports / 1e9, gapsMs: gaps });
    this.log(landed === results.length ? 'info' : 'warn', `fan-out buy ${mint.slice(0, 8)}…: ${landed}/${results.length} landed${pending ? `, ${pending} pending` : ''}`);
    return { ok: landed > 0, message: `${landed}/${results.length} buys landed${pending ? `, ${pending} still pending` : ''}`, results };
  }

  /**
   * What a callout line's variables resolve to for a coin.
   *
   * Read from what the app ALREADY knows — the launch row and the cached
   * market summary — and never fetched. A callout goes out on the back of a
   * buy that just happened; making it wait on a provider would delay a public
   * post to fill in a word, and a field nobody knows renders as an em dash,
   * which is the honest version anyway.
   */
  private calloutFacts(mint: string): CalloutFacts {
    const row = this.tokens.get(mint)?.row ?? null;
    const sum = market.summaryIfCached(mint);
    return {
      ticker: sum?.symbol || row?.symbol || null,
      name: sum?.name || row?.name || null,
      mc: sum?.marketCapUsd ?? null,
      price: sum?.priceUsd ?? null,
      holders: sum?.holders ?? null,
      buyers: row?.flow?.uniqueBuyers ?? null,
      liq: sum?.liquidityUsd ?? null,
      mint,
    };
  }

  /**
   * A script trading with one of the user's OTHER wallets, by address.
   *
   * Since the Copier was removed (2026-09-22) this is the ONLY way several of
   * the user's wallets trade the same coin. There is no per-coin cap on it: a
   * script names one wallet per call, in code somebody wrote, and its own
   * budget is what bounds it. The acknowledgement applies: it is consent, not
   * a limit, and it is what says the user knows what trading several of their
   * own wallets is.
   *
   * The address must be one this app holds a key for. A script cannot name a
   * wallet id, and an address that is not the user's own is refused rather
   * than falling back to the active wallet.
   */
  private async scriptWalletTrade(
    side: 'buy' | 'sell',
    address: string,
    mint: string,
    amount: number,
    ownCapSol?: number,
  ): Promise<{ ok: boolean; message: string }> {
    const mine = wallet.list().find((w) => w.publicKey === address);
    if (!mine) return { ok: false, message: `no wallet of yours has the address ${address.slice(0, 8)}…` };
    const s = this.getSettings();
    const { multiWalletProblem } = await import('@shared/multiWallet');
    // Count 1: a script names one wallet per call, so this asks for the
    // acknowledgement without applying the per-coin ceiling.
    const why = multiWalletProblem(1, s.multiWallet);
    if (why) return { ok: false, message: why };
    if (side === 'buy') {
      const r = await this.labBuy(mine.id, mint, amount, ownCapSol);
      return { ok: r.ok, message: r.message };
    }
    const r = await this.labSell(mine.id, mint, amount);
    return { ok: r.ok, message: r.message };
  }

  /**
   * Which pump.fun account a script's post goes out as.
   *
   * Named accounts are matched against the ADDRESSES (or usernames) of
   * sessions this app holds — so a script can pick any of the user's own
   * accounts and can name nothing else. An unknown name is REFUSED rather
   * than quietly falling back to the active wallet, which would post under
   * somebody else's name.
   *
   * One resolver for both callout and reply: two copies of this would be two
   * places for that fallback to creep back in.
   */
  private pumpAccountFor(who: string): { walletId: string; address: string | undefined } | { error: string } {
    const { sessions } = pumpAuth.status();
    const active = wallet.list().find((w) => w.active)?.id ?? null;
    const picked = who ? sessions.find((x) => x.address === who || x.username === who) : null;
    if (who && !picked) return { error: `no signed-in pump.fun account matches "${who}"` };
    const walletId = picked?.walletId ?? active;
    if (!walletId) return { error: 'no active wallet to post as' };
    return { walletId, address: picked?.address ?? sessions.find((x) => x.walletId === walletId)?.address };
  }

  /**
   * Post a pump.fun callout on a coin just bought, if that is switched on.
   *
   * Deliberately fire-and-forget: this runs off the back of a trade that has
   * already succeeded, and a social post failing must never read as the trade
   * failing. Every outcome is logged; only a success toasts, because a user
   * who has not configured this does not need a notification per buy telling
   * them so.
   */
  private autoCallout(mint: string, boughtSol: number): void {
    const s = this.getSettings();
    if (!s.autoCallout.enabled) return;
    // The wallet that BOUGHT owns the position, so it is the only account
    // pump would accept and the honest author of the call.
    const walletId = wallet.list().find((w) => w.active)?.id ?? null;
    if (!walletId) return;
    void (async () => {
      const { postCallout } = await import('./autoCallout');
      const r = await postCallout(walletId, mint, s.autoCallout, boughtSol, this.calloutFacts(mint));
      recorder.record('auto_callout', { mint, ok: r.ok, verdict: r.verdict ?? null, note: r.message.slice(0, 160) });
      if (r.ok) {
        this.log('info', `auto-callout: ${r.message}${r.thesis ? ` — "${r.thesis}"` : ''}`);
        this.emit({ kind: 'toast', level: 'success', message: r.message });
        // And to Discord, when a webhook is set on the Auto-callout page.
        const hook = this.getSettings().autoCallout.discordWebhookUrl;
        if (hook) await this.postCalloutToDiscord(hook, mint, r.thesis ?? '', r.calloutId ?? null);
        return;
      }
      // Not a toast: pump refusing a call is ordinary (three per coin, a
      // cooldown, a position too small) and a popup per buy would be noise.
      this.log('info', `auto-callout: not posted — ${r.message}`);
    })().catch((e) => this.log('warn', `auto-callout failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  /**
   * Call out a coin you just LAUNCHED (2026-09-23), from the launch wallet's
   * pump account. Separate from the on-buy path above:
   *
   *  · gated on the `onLaunch` toggle, not `enabled` (the on-buy switch);
   *  · only when the dev buy is worth more than `launchMinUsd` (default $2),
   *    so a token-dust launch is not called;
   *  · posted after a short delay (LAUNCH_CALLOUT_DELAY_MS), because a call
   *    made the same second as the create is the kind pump was seen to drop.
   *
   * Fire-and-forget: the launch already succeeded, and a social post failing
   * must never read as a failed launch. Solana only — the caller checks that.
   */
  calloutAfterLaunch(walletId: string, mint: string, devBuySol: number): void {
    const a = this.getSettings().autoCallout;
    if (!a.onLaunch) return;
    void (async () => {
      const { pickThesis, fillCallout, LAUNCH_CALLOUT_DELAY_MS } = await import('@shared/calloutAuto');
      // The USD floor. An unknown SOL price is treated as "do not call" rather
      // than guessed past the gate.
      if (a.launchMinUsd > 0) {
        const solUsd = await market.solUsd().catch(() => null);
        const usd = solUsd !== null ? devBuySol * solUsd : null;
        if (usd === null) {
          this.log('info', `auto-callout (launch): SOL price unknown, not calling ${mint.slice(0, 8)}…`);
          return;
        }
        if (usd < a.launchMinUsd) {
          this.log('info', `auto-callout (launch): dev buy ~$${usd.toFixed(2)} is under the $${a.launchMinUsd} floor, not calling`);
          return;
        }
      }
      const chosen = pickThesis(a.text);
      if (!chosen) {
        this.log('info', 'auto-callout (launch): no callout text configured, nothing posted');
        return;
      }
      await new Promise((r) => setTimeout(r, LAUNCH_CALLOUT_DELAY_MS));
      const text = fillCallout(chosen, this.calloutFacts(mint));
      const { postNow } = await import('./autoCallout');
      const r = await postNow(walletId, mint, text, { likeOwn: a.likeOwn });
      recorder.record('auto_callout', { mint, ok: r.ok, verdict: r.verdict ?? null, note: `launch: ${r.message.slice(0, 150)}` });
      this.log('info', `auto-callout (launch) on ${mint.slice(0, 8)}…: ${r.message}`);
      if (r.ok) {
        this.emit({ kind: 'toast', level: 'success', message: r.message });
        const hook = this.getSettings().autoCallout.discordWebhookUrl;
        if (hook) await this.postCalloutToDiscord(hook, mint, r.thesis ?? text, r.calloutId ?? null);
      }
    })().catch((e) => this.log('warn', `auto-callout (launch) failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  /**
   * The Auto-callout page's Discord post: the same embed the scorenow script
   * posts its calls in. Best effort and never thrown — the call already went
   * out, and a Discord hiccup must not read as a failed callout. One market
   * summary for a fresh cap, holders and image, cached facts otherwise.
   */
  /** The most recently seen launch, for a sample post. Null before any. */
  newestLaunchMint(): string | null {
    let last: string | null = null;
    for (const k of this.tokens.keys()) last = k;
    return last;
  }

  async postCalloutToDiscord(hook: string, mint: string, thesis: string, calloutId: string | null, test = false): Promise<{ ok: boolean; message: string }> {
    try {
      const facts = this.calloutFacts(mint);
      const sum = await Promise.race([
        market.summary(mint).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 6_000)),
      ]);
      const row = this.tokens.get(mint)?.row ?? null;
      const [{ calloutEmbed, redactWebhook }, { postEmbed }, { calloutPageUrl }] = await Promise.all([
        import('@shared/webhook'),
        import('../system/discordWebhook'),
        import('@shared/calloutAuto'),
      ]);
      const embed = calloutEmbed({
        mint,
        name: sum?.name || facts.name || null,
        symbol: sum?.symbol || facts.ticker || null,
        thesis,
        link: calloutId ? calloutPageUrl(mint, calloutId) : null,
        mcUsd: sum?.marketCapUsd ?? facts.mc ?? null,
        holders: sum?.holders ?? facts.holders ?? null,
        buyers: facts.buyers ?? null,
        curvePct: sum?.bondingCurvePct ?? row?.flow?.curveProgressPct ?? null,
        imageUrl: sum?.imageUrl ?? null,
        test,
      });
      const r = await postEmbed(hook, embed);
      // Never the URL itself: its last segment is the webhook's password.
      this.log(r.ok ? 'info' : 'warn', `auto-callout → Discord ${redactWebhook(hook)}: ${r.message}`);
      return r;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log('warn', `auto-callout → Discord failed: ${message}`);
      return { ok: false, message };
    }
  }

  /** Run a live trade serialized behind any in-flight one (balance safety). */
  private runLive(fn: () => Promise<void>): void {
    this.liveChain = this.liveChain.then(fn).catch((err) => {
      this.log('error', `live trade error: ${(err as Error).message}`);
    });
  }

  /** Autonomous live firing was REMOVED on 2026-08-16: the product is manual
   *  execution only, and six months of swarms proved every autonomous strategy
   *  in this family negative-EV (docs/strat-swarm-2026-07-24.md,
   *  docs/farming-swarm-2026-08-15.md). Shipping one to users is the single
   *  outcome that cannot be walked back, so the gate is closed in code rather
   *  than left behind a setting. The live send machinery below stays for
   *  USER-INITIATED trades (live:testTrade, live:sellToken, live:sellAll). */
  private autoLiveActive(): boolean {
    return false;
  }

  /**
   * Is the app in Live mode for MANUAL trades — i.e. will a buy/sell the user
   * triggers actually broadcast? That is exactly "armed AND execution enabled",
   * the same gate testTrade() checks. This is what the Paper/Live toggle and
   * the status pill reflect; it is deliberately NOT autoLiveActive() (which is
   * the autonomous path and is permanently off). Reading autoLiveActive() here
   * was the bug that snapped the toggle back to Paper on every status poll.
   */
  private manualLiveActive(): boolean {
    return this.armed && this.getSettings().execution.liveEnabled;
  }

  /** AI opinions handed to scripts, per mint — see the host's `analyze`. */
  private readonly scriptAiCache = new Map<string, AiAnalysis>();

  /** How many OTHER launches in view link the same X account or post as
   *  `twitter` — the free half of the X-link check, for scripts. "In view"
   *  is every launch the scanner tracks whose provider summary is cached:
   *  the tracked row itself only knows WHETHER a link exists (metadata.ts),
   *  the URL lives in the summary. A launch with no cached summary is not
   *  counted, so the count is a floor. */
  private xReuseFor(twitter: string | null, selfMint: string): { handle: number; post: number } {
    const link = parseXLink(twitter);
    if (link.kind === 'none' || link.kind === 'not-x') return { handle: 0, post: 0 };
    const others: Array<{ mint: string; twitter: string | null }> = [];
    for (const t of this.tokens.values()) {
      if (t.row.mint === selfMint || !t.socials?.twitter) continue;
      const tw = market.summaryIfCached(t.row.mint)?.socials.twitter ?? null;
      if (tw) others.push({ mint: t.row.mint, twitter: tw });
    }
    return countReuse(link, others, selfMint);
  }

  /** Buy size + fee/rent headroom the wallet must hold before a live buy. */
  private static readonly LIVE_BALANCE_HEADROOM_SOL = 0.02;
  private static readonly MAX_LIVE_SEND_FAILS = 3;

  /** Block live buys for a pipeline (non-market) reason. Loud, once. */
  private blockLive(reason: string): void {
    if (this.liveBlockedReason !== null) return;
    this.liveBlockedReason = reason;
    recorder.record('live_blocked', { reason });
    this.log('error', `LIVE BUYS PAUSED: ${reason}`);
    this.emit({ kind: 'toast', level: 'error', message: `Live buys paused — ${reason}` });
  }

  /** Fire a real buy for a freshly-entered mint (autonomous path). */
  private autoLiveBuy(mint: string, symbol: string): void {
    // Balance preflight — the exact failure mode that silently killed live
    // trading for two days: buys that can never clear simulation. Self-heals
    // when the balance recovers (e.g. user tops up the wallet).
    const sol = Math.min(this.getSettings().strategy.positionSizeSol, this.getSettings().execution.maxLiveSol);
    const needLamports = (sol + SniperEngine.LIVE_BALANCE_HEADROOM_SOL) * 1e9;
    if (this.walletBalanceLamports !== null) {
      if (this.walletBalanceLamports < needLamports) {
        this.blockLive(
          `wallet ${(this.walletBalanceLamports / 1e9).toFixed(4)} SOL < ${sol} buy + ${SniperEngine.LIVE_BALANCE_HEADROOM_SOL} headroom — fund the wallet or lower the size`,
        );
        return;
      }
      if (this.liveBlockedReason?.startsWith('wallet ')) {
        // Balance recovered — lift a balance-type block automatically.
        this.liveBlockedReason = null;
        this.liveConsecutiveSendFails = 0;
        this.log('info', 'wallet balance recovered — live buys unblocked');
      }
    }
    if (!this.autoLiveActive() || this.liveMints.has(mint)) return;
    this.runLive(async () => {
      const { executeTrade } = await import('./liveSigner');
      const s = this.getSettings();
      const res = await executeTrade({
        action: 'buy',
        mint,
        amount: sol,
        denominatedInSol: true,
        slippagePct: s.execution.liveSlippagePct,
        priorityFeeSol: this.priorityFeeSolFor('buy'),
        httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
        simulateOnly: false,
        local: this.localBuildParams(mint),
        exec: s.execution,
        wssUrl: this.confirmWssUrl(),
      });
      recorder.record('live_buy', { mint, sol, ok: res.ok, stage: res.stage, signature: res.signature ?? null, note: res.message.slice(0, 220) });
      if (res.ok && res.signature) {
        this.liveBuys++;
        this.liveConsecutiveSendFails = 0;
        this.liveMints.add(mint);
        this.positions.markLive(mint);
        this.log('info', `LIVE BUY ${symbol}: ${res.message}`);
        this.emit({ kind: 'toast', level: 'success', message: `LIVE buy ${symbol} — ${res.signature.slice(0, 12)}…` });
      } else {
        this.log('warn', `live buy ${symbol} not placed (${res.stage}): ${res.message}`);
        this.emit({ kind: 'toast', level: 'warn', message: `Live buy ${symbol} skipped: ${res.message}` });
        // Pre-broadcast failures are pipeline problems, not market losses —
        // a streak means every future buy will fail the same way.
        if (res.stage === 'validate' || res.stage === 'simulate' || res.stage === 'relayer') {
          this.liveConsecutiveSendFails++;
          if (this.liveConsecutiveSendFails >= SniperEngine.MAX_LIVE_SEND_FAILS) {
            this.blockLive(
              `${this.liveConsecutiveSendFails} consecutive live-buy failures at ${res.stage} stage — check wallet balance and RPC, then re-arm`,
            );
          }
        }
      }
    });
  }

  /** Local-build params for a mint we still track — undefined (relayer path)
   *  for unknown mints or when local building is switched off. */
  private localBuildParams(mint: string): import('./liveSigner').LiveTradeParams['local'] {
    const s = this.getSettings();
    if (!s.execution.localTxBuild) return undefined;
    const t = this.tokens.get(mint);
    if (!t || t.virtualSolReserves <= 0n || t.virtualTokenReserves <= 0n) return undefined;
    return {
      creator: t.createEvent.creator,
      vSol: t.virtualSolReserves,
      vTok: t.virtualTokenReserves,
      computeUnitLimit: s.execution.computeUnitLimit,
    };
  }

  /**
   * Like localBuildParams, but for a mint the live feed never saw — a manual
   * test trade or a fan-out on a pasted address. The feed only tracks tokens
   * that traded while the engine was running, so an arbitrary mint has no curve
   * state; without it the trade falls to the relayer, which 400s on bonding
   * curves (pump's v2 change — the whole reason the local builder exists). This
   * fetches the curve reserves + creator from pump's own API on demand so a
   * curve buy can be built locally regardless of what the feed has seen.
   *
   * Returns undefined for graduated tokens (they route through an AMM via the
   * relayer, which handles them) and when the local builder is off.
   */
  private async localBuildParamsAsync(mint: string): Promise<import('./liveSigner').LiveTradeParams['local']> {
    const s = this.getSettings();
    if (!s.execution.localTxBuild) return undefined;
    const cached = this.localBuildParams(mint);
    if (cached) return cached;
    // Chain-first (2026-09-01). buildLocalTrade reads the bonding curve itself
    // — reserves, creator, completion — in its one batched account read, so
    // the pump.fun `/coins` lookup this used to make first was a redundant
    // HTTP hop (host gap + round trip, ~300 ms) on every buy of a mint the
    // feed had not tracked. A mint that is not an open pump curve now fails
    // the build in one RPC read (~85 ms warm) and falls to the relayer
    // exactly as before. The only thing worth skipping for is a token the
    // cached summary already says belongs to another launchpad.
    const known = market.summaryIfCached(mint);
    if (known && known.launchpad !== 'pumpfun' && known.launchpad !== 'unknown') {
      this.localUnavailable.set(mint, `${known.launchpad} token — the relayer routes it`);
      return undefined;
    }
    this.localUnavailable.delete(mint);
    return { creator: '', vSol: 0n, vTok: 0n, computeUnitLimit: s.execution.computeUnitLimit };
  }

  /** Local-builder params for a 100% SELL. Never throws — an exit must
   *  never be blocked by a failed curve lookup; undefined = relayer path. */
  private async localBuildParamsForSell(mint: string): Promise<import('./liveSigner').LiveTradeParams['local']> {
    try {
      return await this.localBuildParamsAsync(mint);
    } catch {
      return undefined;
    }
  }

  /** Execute a sell with one rebuild-retry when the broadcast provably did
   *  not land — 100% sells ONLY. A retried 100% sell of an already-sold
   *  position has nothing to sell and dies in simulation, so it can never
   *  double-spend. A partial sell is resolved against the balance at build
   *  time, so a retry after a late-landing first tx sells more than asked
   *  (50% twice = 75%); it returns the original result instead. A `pending`
   *  result (may still land) is never retried. See shared/liveBreakers.ts. */
  private async sellWithRetry(
    params: import('./liveSigner').LiveTradeParams,
  ): Promise<import('./liveSigner').LiveTradeResult> {
    const { executeTrade } = await import('./liveSigner');
    let res = await executeTrade(params);
    if (shouldRetryPreBroadcast(res)) {
      // Refused before anything was sent — by a host saying "slow down", not
      // by the chain. Nothing to double-spend; the same order goes again
      // after a pause. Without this a stop-loss died on "Simulation call
      // failed: RPC HTTP 429" and stayed dead (2026-09-06).
      this.log('warn', `sell ${params.mint.slice(0, 8)}… refused before broadcast by a rate limit (${res.stage}: ${res.message}) — retrying in 1.5 s`);
      await new Promise((r) => setTimeout(r, 1_500));
      res = await executeTrade(params);
    }
    if (shouldRetrySell(params.amount, res)) {
      // The retry goes out at a wider slippage than the first attempt. A
      // sell that failed to land means the price is moving faster than the
      // bound allowed, and being left in a position you asked to exit is
      // worse than a poor fill. Bounded, and logged, so a bad fill is never
      // a surprise.
      const retrySlippage = escalatedSellSlippagePct(params.slippagePct);
      this.log(
        'warn',
        `sell ${params.mint.slice(0, 8)}… did not land (${res.stage}) — retrying once at ${retrySlippage}% slippage (was ${params.slippagePct}%)`,
      );
      // Long enough for a fresh blockhash to differ; the old 1 s was arbitrary.
      await new Promise((r) => setTimeout(r, 250));
      res = await executeTrade({ ...params, slippagePct: retrySlippage });
      if (res.ok) this.log('info', `sell ${params.mint.slice(0, 8)}… landed on the wider retry (${retrySlippage}% slippage)`);
    }
    return res;
  }

  /** Fire a real 100% sell when a live position exits. */
  private autoLiveSell(mint: string, symbol: string, reason: string): void {
    if (!this.liveMints.has(mint)) return;
    this.liveMints.delete(mint);
    this.runLive(async () => {
      const s = this.getSettings();
      const res = await this.sellWithRetry({
        action: 'sell',
        mint,
        amount: '100%',
        denominatedInSol: false,
        slippagePct: Math.max(s.execution.liveSlippagePct, 15),
        priorityFeeSol: this.exitParams(s.execution).priorityFeeSol,
        httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
        simulateOnly: false,
        local: this.localBuildParams(mint),
        exec: s.execution,
        wssUrl: this.confirmWssUrl(),
      });
      recorder.record('live_sell', { mint, reason, ok: res.ok, stage: res.stage, signature: res.signature ?? null, note: res.message.slice(0, 220) });
      if (res.ok && res.signature) {
        this.liveSells++;
        // Measure this round-trip's REAL PnL by the wallet balance vs the
        // previous sell (trades are serialized, so this is the net effect).
        const bal = await getBalance(s.rpc.httpUrl, wallet.publicKey() ?? '');
        if (bal.ok && bal.data !== undefined) {
          // The streak is NOT counted here. It used to be, from this balance
          // delta — and that made one losing sell count as two, because the
          // ledger's `onSettled` hook counts the same sale again from the
          // reconciled fill's realised PnL. With the default limit of 2 that
          // disarmed live trading on the FIRST loser (user report,
          // 2026-09-13: "−0.0073 SOL appeared twice ... disarmed itself with
          // loss_limit"). The balance delta was the worse of the two rules
          // anyway: it compares the wallet against its level at the previous
          // sell, so any buy in between makes a PROFITABLE sell read as a
          // loss. `nextConsecutiveLosses` over the ledger is the one rule.
          this.liveBalanceAtLastSell = bal.data;
          this.walletBalanceLamports = bal.data;
        }
        this.log('info', `LIVE SELL ${symbol} (${reason}): ${res.message}`);
        this.emit({ kind: 'toast', level: 'info', message: `LIVE sell ${symbol} — ${res.signature.slice(0, 12)}…` });
        this.updateLiveBreakers();
      } else {
        // A failed live sell means the position is stuck (usually a rug with
        // no exit liquidity) — that is unambiguously a loss. Count it and trip
        // the breakers so we don't keep buying into a rug streak (the gap that
        // let it keep trading on 2026-07-19).
        this.liveConsecutiveLosses++;
        this.stuckMints.add(mint);
        this.log('error', `LIVE SELL ${symbol} FAILED (${res.stage}): ${res.message} — position stuck, counted as loss`);
        this.emit({ kind: 'toast', level: 'error', message: `Live sell ${symbol} failed (${res.stage}) — stuck, sell manually` });
        this.updateLiveBreakers();
      }
    });
  }

  /** Manually sell 100% of a held token (recover a leftover/dust position).
   *  Requires real broadcast enabled; does not require arming (selling
   *  recovers funds, so it should never be gated behind autonomous arming). */
  // ── Meteora DBC pool watching ────────────────────────────────────

  /**
   * Start taping a Meteora DBC token. Called when the token page opens a
   * mint whose launchpad is DBC-based and whose pool we know.
   *
   * `decimals` is required rather than assumed: DBC pools are not uniformly
   * 6-decimal, and the wrong value scales every price by 1000.
   */
  watchDbcPool(mint: string, pool: string, decimals: number): void {
    dbcWatcher.watch(mint, pool, decimals);
  }

  unwatchDbcPool(mint: string): void {
    dbcWatcher.unwatch(mint);
  }

  /** Tape a pump mint for the token page — scanner running or not. */
  watchPumpMint(mint: string): void {
    priorityFeed.watch(mint);
    // …and the curve account itself. `bonding-curve` is a PDA of the mint, so
    // this costs one derivation and no lookup, and it is right even for a
    // token no provider has ever heard of. A mint that turns out not to be a
    // pump coin simply never notifies: an account that does not exist yet is
    // a valid subscription, which is also what makes this safe to fire before
    // anything has identified the token.
    try {
      priorityFeed.watchAccount(mint, bondingCurveFor(mint));
    } catch {
      /* an address we cannot derive is one we do not follow */
    }
  }

  /** The page closed. A mint still held as a position stays on the socket. */
  unwatchPumpMint(mint: string): void {
    const held = this.positions.all().some((p) => p.state !== 'closed' && p.mint === mint);
    if (!held) {
      priorityFeed.unwatch(mint);
      priorityFeed.unwatchAccount(mint);
      this.lastCurveVSol.delete(mint);
    }
  }

  /**
   * The bonding curve moved. This is the price, stated by the chain.
   *
   * PRICE ONLY, deliberately. An account notification says what the reserves
   * are now; it does not say who traded, which side, or how much, and more
   * than one trade can land in a slot. So this moves the chart's last price
   * and the engine's last-known price, and touches nothing that counts:
   * not the tape, not the trades list, not volume. Those stay with the log
   * feed, which sees each trade individually. Feeding both into the tape
   * would double-count every trade that both feeds saw.
   *
   * What it buys: the price line keeps moving when a log notification is
   * dropped by the socket (measured at ~20 % under firehose load on a single
   * public endpoint), and it keeps moving on the day pump stops emitting
   * `emit!` altogether, because nothing here decodes an event.
   */
  private onCurveAccount(a: { mint: string; data: Buffer; slot: number; at: number }): void {
    const st = parseCurve(a.data);
    if (!st) return;
    // A completed curve stops moving; the token trades on PumpSwap from then
    // on and the AMM feed carries it. Holding the subscription open would be
    // paying for an account that will never change again.
    if (st.complete) {
      priorityFeed.unwatchAccount(a.mint);
      this.lastCurveVSol.delete(a.mint);
      return;
    }
    const priceSol = spotPriceSol(st.vSol, st.vTok);
    if (!Number.isFinite(priceSol) || priceSol <= 0) return;
    this.rememberPrice(a.mint, priceSol);
    // The side comes from the reserves MOVING, not from a guess: SOL going
    // into the curve is a buy. The first notification has nothing to compare
    // against, so it seeds and emits nothing - the page has just loaded a
    // full summary and chart, and inventing a direction to fill one tick is
    // exactly the kind of small lie this codebase does not tell.
    const prev = this.lastCurveVSol.get(a.mint);
    this.lastCurveVSol.set(a.mint, st.vSol);
    if (prev === undefined || st.vSol === prev) return;
    if (this.lastCurveVSol.size > 32) {
      const oldest = this.lastCurveVSol.keys().next().value;
      if (oldest !== undefined && oldest !== a.mint) this.lastCurveVSol.delete(oldest);
    }
    // Zero volume: this tick carries a price and makes no claim about size.
    this.chartTicks.push(a.mint, a.at, priceSol, 0, st.vSol > prev);
  }

  /** Virtual SOL reserves as of the last curve notification, per mint. The
   *  only state the account feed keeps: it is what turns two snapshots into
   *  a direction. Bounded with the tape's own subscription budget in mind. */
  private readonly lastCurveVSol = new Map<string, bigint>();

  /** Every curve the program feed hears trading, and every migration it
   *  hears — the Discover columns' local source while the scanner runs
   *  (engine/liveCurves.ts). Fed from onTrade / onComplete / the AMM
   *  migration event; read through the terminal context. */
  private readonly liveCurves = new LiveCurves();
  private readonly liveMigrations = new LiveMigrations();

  dbcWatchedMints(): string[] {
    return dbcWatcher.watchedMints();
  }

  // ── Copy trading (term.txt §11) ──────────────────────────────────

  /** The price the engine already knows for a mint, no lookups: the feed
   *  row, the last-known map, or the tape. Null when nothing local knows. */
  private cheapPriceSol(mint: string): number | null {
    const p = this.tokens.get(mint)?.row.priceSol ?? this.lastKnownPriceSol.get(mint) ?? tape.lastPriceSol(mint) ?? null;
    return typeof p === 'number' && p > 0 ? p : null;
  }

  /**
   * What a script may act on, in its mode, priced cheaply. Paper = the
   * paper book. Live = the wallet's holdings with the ledger's average
   * cost; a holding the ledger never saw bought has no cost, no PnL, and
   * a rule on either does not fire (honest null).
   */
  private async scriptPositions(mode: 'paper' | 'live', chain: ChainKind = 'solana'): Promise<ScriptPosition[]> {
    // A script sees ONLY its own chain's positions. Without this an EVM
    // script's "sell everything" enumerates Solana bags, and a Solana script
    // would count EVM ones against its open-position budget.
    if (chain !== 'solana') {
      if (mode === 'paper') {
        return paperBook
          .list()
          .filter((p) => (p.chain ?? 'solana') === chain)
          .map((p) => {
            const cur = this.evmCopy?.price(chain, p.mint) ?? null;
            const entry = p.tokens > 0 ? p.costSol / p.tokens : null;
            const { pnlSol, pnlPct } = positionPnl(p.costSol, p.tokens, cur);
            return { mint: p.mint, symbol: p.symbol, name: '', openedAt: p.openedAt, costSol: p.costSol, tokens: p.tokens, entryPriceSol: entry, currentPriceSol: cur, peakPriceSol: null, pnlSol, pnlPct };
          });
      }
      if (!this.evmCopy?.positions) return [];
      try {
        const rows = await this.evmCopy.positions(chain);
        return rows.map((h) => ({
          mint: h.token,
          symbol: h.symbol,
          name: '',
          openedAt: h.firstBuyAt ?? 0,
          // The EVM ledger DOES derive cost basis from reconciled on-chain
          // fills (evm/ledger.ts basisByToken). This used to read holdings(),
          // the raw balance underneath, and hard-code pnl to null — which made
          // a rule like `pnlPct <= -20` unable to fire on an EVM script, the
          // silent-never-fires failure the chain model exists to prevent.
          //
          // Null still means null: an unreconciled buy has no basis, and an
          // unknown never satisfies a rule. That is the honest case, not the
          // blanket one.
          costSol: h.basisKnown ? h.costNative : null,
          tokens: h.amount,
          entryPriceSol: h.avgEntryPriceNative,
          currentPriceSol: h.priceNative,
          peakPriceSol: null,
          pnlSol: h.basisKnown ? h.unrealizedPnlNative : null,
          pnlPct: h.basisKnown ? h.unrealizedPnlPct : null,
        }));
      } catch {
        return [];
      }
    }
    if (mode === 'paper') {
      return paperBook.list().filter((p) => (p.chain ?? 'solana') === 'solana').map((p) => {
        const tokens = p.decimalsKnown ? p.tokens : null;
        const cur = tokens !== null ? this.cheapPriceSol(p.mint) : null;
        const entry = tokens !== null && tokens > 0 ? p.costSol / tokens : null;
        const { pnlSol, pnlPct } = positionPnl(p.costSol, tokens, cur);
        return { mint: p.mint, symbol: p.symbol, name: '', openedAt: p.openedAt, costSol: p.costSol, tokens, entryPriceSol: entry, currentPriceSol: cur, peakPriceSol: null, pnlSol, pnlPct };
      });
    }
    const h = await this.holdings();
    if (!h.ok || !h.data) return [];
    const basis = ledger.basisByMint(wallet.publicKey());
    const out: ScriptPosition[] = [];
    for (const x of h.data) {
      if (x.mint === SniperEngine.WSOL_MINT || x.warning) continue;
      const b = basis.get(x.mint);
      const entry = b && b.tokensBought > 0 ? b.spentSol / b.tokensBought : null;
      const costSol = entry !== null ? entry * x.uiAmount : 0;
      const cur = this.cheapPriceSol(x.mint);
      const { pnlSol, pnlPct } = entry !== null ? positionPnl(costSol, x.uiAmount, cur) : { pnlSol: null, pnlPct: null };
      out.push({
        mint: x.mint,
        symbol: x.symbol ?? b?.symbol ?? '',
        name: '',
        openedAt: b?.firstAt ?? 0,
        costSol,
        tokens: x.uiAmount,
        entryPriceSol: entry,
        currentPriceSol: cur,
        peakPriceSol: null,
        pnlSol,
        pnlPct,
      });
    }
    return out;
  }

  copySnapshot(): import('@shared/copytrade').CopySnapshot {
    return copyTrade.snapshot();
  }

  upsertCopyConfig(
    input: Omit<import('@shared/copytrade').CopyConfig, 'id' | 'createdAt'> & { id?: string },
  ): { ok: boolean; message: string } {
    const r = copyTrade.upsert(input);
    this.syncCopyWatch();
    return r;
  }

  removeCopyConfig(id: string): { ok: boolean; message: string } {
    const r = copyTrade.remove(id);
    this.syncCopyWatch();
    return r;
  }

  /** Start a followed wallet's own record over. */
  resetCopyLeader(wallet: string): { ok: boolean; message: string } {
    return copyTrade.resetLeader(wallet);
  }

  /** Clear PAPER copy results — one config, or all of them. Settings, live
   *  history, leader records and real holdings are untouched. */
  resetCopyPaper(configId?: string): { ok: boolean; message: string } {
    const r = copyTrade.resetPaper(configId);
    return { ok: r.ok, message: r.message };
  }

  /** Point the wallet watcher at exactly the wallets with an enabled copy
   *  config. Called after every config change and once at boot, after the
   *  configs are loaded. */
  syncCopyWatch(): void {
    walletWatcher.setWallets([...copyTrade.activeWallets()]);
    // An EVM leader has no subscription of its own: it is seen through that
    // chain's scanner poll. Following one while the scanner is stopped is a
    // config that watches nothing and says nothing about it — so enabling one
    // starts the feed it needs. Idempotent, and it never STOPS a feed: the
    // user may have started that scanner themselves.
    for (const chain of copyTrade.activeChains()) {
      if (chain === 'solana') continue;
      const why = this.evmCopy?.ensureLeaderFeed?.(chain) ?? null;
      if (why) this.log('warn', `copy: following a wallet on ${chain} needs that chain's scanner, which will not start — ${why}`);
    }
    this.syncCopySweep();
  }

  /**
   * How often the $KRYPTO holding behind the holder rate is re-read.
   *
   * One `getMultipleAccounts` for every wallet, so the cost does not grow
   * with the trade rate — and the fee path never waits for it, it reads the
   * last answer. Two minutes keeps a wallet that just bought in from paying
   * fees for long, without polling a balance nobody is watching.
   */
  private kryptoTimer: NodeJS.Timeout | null = null;
  private kryptoHolder = false;

  /** Re-read the holding, and say so in the log when the answer changes. */
  private async refreshKrypto(): Promise<void> {
    if (!isValidMint(KRYPTO_TOKEN.mint)) return;
    // The price comes from the market layer's cache, so ask it to have one.
    // Failure is fine: an unpriceable token leaves the holding unknown, and
    // unknown does not qualify.
    try {
      await market.summary(KRYPTO_TOKEN.mint);
    } catch {
      /* the holding read below reports the missing price itself */
    }
    await kryptoHolding.refresh();
    const now = kryptoHolding.holderRateApplies();
    kryptoHolding.logState(this.kryptoHolder, now);
    this.kryptoHolder = now;
  }

  private copySweepTimer: NodeJS.Timeout | null = null;
  private copySweepBusy = false;

  /**
   * Run the copy balance sweep exactly while there is something to sweep.
   *
   * Not tied to `start()`: copy trading follows a wallet whether or not the
   * scanner is running, and a LIVE config comes back from a restart DISARMED
   * while its positions come back open — which is precisely where a leftover
   * would sit unnoticed.
   */
  private syncCopySweep(): void {
    const wanted = copyTrade.needsSweep();
    if (wanted && !this.copySweepTimer) {
      this.copySweepTimer = setInterval(() => void this.copySweepTick(), COPY_SWEEP_INTERVAL_MS);
      void this.copySweepTick();
    } else if (!wanted && this.copySweepTimer) {
      clearInterval(this.copySweepTimer);
      this.copySweepTimer = null;
    }
  }

  /** One pass: recover any quantity the book is missing, then compare what
   *  it thinks it holds against what the chains say. Never overlaps itself —
   *  a slow RPC must not stack passes on an endpoint already parked. */
  private async copySweepTick(): Promise<void> {
    if (this.copySweepBusy) return;
    this.copySweepBusy = true;
    try {
      await copyTrade.backfillQuantities();
      await copyTrade.sweepBalances();
    } catch (e) {
      this.log('warn', `copy balance sweep: ${(e as Error).message}`);
    } finally {
      this.copySweepBusy = false;
    }
    // Everything it was watching may have just closed. Stop rather than wake
    // every 90 s to find nothing.
    if (this.copySweepTimer && !copyTrade.needsSweep()) this.syncCopySweep();
  }

  // ── Alerts (term.txt §17) ────────────────────────────────────────

  /** Desktop notification. Injected by main so the engine stays testable. */
  private notifier: ((title: string, body: string, target?: NotifyTarget) => void) | null = null;

  setNotifier(fn: (title: string, body: string, target?: NotifyTarget) => void): void {
    this.notifier = fn;
  }

  /**
   * Copy trading on Robinhood Chain and BNB goes through the EVM rail, which
   * the engine does not import (it stays free of viem and testable in Node).
   * Main wires the rail in here; without it an EVM copy is refused, never
   * silently routed to Solana.
   */
  private evmCopy: EvmCopyBridge | null = null;
  setEvmCopy(bridge: EvmCopyBridge | null): void {
    this.evmCopy = bridge;
  }

  /**
   * A desktop notification, and whatever else is listening for one.
   *
   * `target` is what the notification is ABOUT. It carries the click through
   * to the router (main attaches the handler; see `requestOpenToken`) and it
   * is what a Discord webhook links to. Optional because not every
   * notification has a token behind it — an update notice does not.
   */
  private notify(title: string, body: string, target?: NotifyTarget): void {
    // Not gated on alerts.desktopNotifications here: that switch is the OS
    // pop-up only, checked in main's notifier. Chat pushes and runner
    // webhooks ride this same call and keep their own opt-ins.
    this.notifier?.(title, body, target);
  }

  /**
   * Someone clicked a desktop notification. Put its token on screen.
   *
   * Called from main, which owns the Notification and therefore the click.
   * Routed through the engine's own emit so it travels the one channel every
   * other UI push uses, rather than main reaching into ipc internals.
   */
  requestOpenToken(mint: string, chain: ChainKind): void {
    this.emit({ kind: 'openToken', mint, chain });
  }

  /**
   * Notify from outside the engine — today, the EVM scanner's runner calls.
   *
   * It goes through the same `notify` as everything else rather than reaching
   * for Electron directly, so the desktop-notification switch and the chat
   * push mean the same thing for a Robinhood runner as for a Solana one.
   */
  pushNotification(title: string, body: string, target?: NotifyTarget): void {
    this.notify(title, body, target);
  }

  alertsSnapshot(): import('@shared/alerts').AlertsSnapshot {
    return {
      alerts: alerts.all(),
      notificationsEnabled: this.getSettings().alerts.desktopNotifications,
    };
  }

  createAlert(req: import('@shared/alerts').NewAlertRequest): { ok: boolean; message: string } {
    const r = alerts.create(req);
    return { ok: r.ok, message: r.message };
  }

  removeAlert(id: string): { ok: boolean; message: string } {
    return alerts.remove(id);
  }

  muteAlert(id: string, muted: boolean): { ok: boolean; message: string } {
    return alerts.setMuted(id, muted);
  }

  clearFiredAlerts(): { ok: boolean; message: string } {
    const n = alerts.clearFired();
    this.emit({ kind: 'alerts', alerts: alerts.all() });
    return { ok: true, message: `Cleared ${n} fired alert${n === 1 ? '' : 's'}` };
  }

  // ── Portfolio (term.txt §13/§14) ─────────────────────────────────

  /**
   * Build the portfolio. Holdings come from the chain, cost basis from the
   * local fill ledger, prices from the market layer — three independent
   * sources, joined with every disagreement surfaced rather than smoothed.
   */
  /** One assembly at a time, shared for a moment: the position panel (20 s
   *  and on every fill), the Portfolio page (30 s) and the bots (30 s) each
   *  asked for their own, and every one re-priced every mint. */
  private portfolioShared: { at: number; p: Promise<import('@shared/portfolio').PortfolioSummary> } | null = null;

  /** The last build, kept: a page opens on it at once and the fresh build
   *  follows as a 'portfolio' event. Keyed by owner so a switched signer
   *  never sees another wallet's numbers. Measured 2026-09-08: without this
   *  Portfolio and Trades showed nothing for 5–7 s on every visit. */
  private lastPortfolio: { at: number; startedAt: number; owner: string; summary: import('@shared/portfolio').PortfolioSummary } | null = null;
  /** Set on every fill and paper fill; the fast path reports stale past it. */
  private portfolioDirtyAt = 0;
  private portfolioRebuildTimer: NodeJS.Timeout | null = null;

  /** The last build for the active wallet, or null — never a build. Marks
   *  the copy stale when older than 3 s or dirtied by a fill, and starts the
   *  rebuild that will replace it (shared with anyone else asking). */
  portfolioSummaryFast(): { summary: import('@shared/portfolio').PortfolioSummary; stale: boolean; generatedAt: number } | null {
    const lp = this.lastPortfolio;
    const owner = wallet.publicKey() ?? '';
    if (!lp || lp.owner !== owner) return null;
    const stale = Date.now() - lp.at > 3_000 || this.portfolioDirtyAt > lp.startedAt;
    if (stale) this.schedulePortfolioRebuild(0);
    return { summary: lp.summary, stale, generatedAt: lp.at };
  }

  /** A fill landed (real or paper): the kept build is out of date. One
   *  rebuild follows after a short trailing delay, so a fan-out of five
   *  buys does not start five builds. */
  markPortfolioDirty(): void {
    this.portfolioDirtyAt = Date.now();
    // With no build yet, a real fill while live starts one anyway: the
    // Observatory ledger and the Wallet panel read the kept build for their
    // realized and unrealized figures, and used to show "—" until some page
    // happened to ask for a portfolio.
    if (this.lastPortfolio || this.manualLiveActive()) this.schedulePortfolioRebuild(1_500);
  }

  private schedulePortfolioRebuild(delayMs: number): void {
    if (this.portfolioRebuildTimer) return;
    this.portfolioRebuildTimer = setTimeout(() => {
      this.portfolioRebuildTimer = null;
      void this.portfolioSummary().catch(() => undefined);
    }, delayMs);
  }

  /** The active signer changed: nothing kept may outlive it. */
  clearWalletCaches(): void {
    this.lastPortfolio = null;
    this.portfolioShared = null;
    this.lastHoldings = null;
    this.holdingsShared = null;
  }

  async portfolioSummary(): Promise<import('@shared/portfolio').PortfolioSummary> {
    const now = Date.now();
    // Share a build started in the last 3 s — unless a fill landed after it
    // started: that build read the holdings before the fill and would answer
    // the "Landed" toast with the position missing.
    if (this.portfolioShared && now - this.portfolioShared.at < 3_000 && this.portfolioShared.at >= this.portfolioDirtyAt) {
      return this.portfolioShared.p;
    }
    const p = this.buildPortfolioSummary(now);
    this.portfolioShared = { at: now, p };
    p.catch(() => {
      this.portfolioShared = null;
    });
    return p;
  }

  private async buildPortfolioSummary(startedAt = Date.now()): Promise<import('@shared/portfolio').PortfolioSummary> {
    const s = this.getSettings();
    const httpUrl = s.rpc.execHttpUrl ?? s.rpc.httpUrl;
    // The wallet this build is FOR. wallet:select cannot cancel a build in
    // flight; one that straddles the switch is returned to its caller but
    // never kept or broadcast as the new wallet's (review 2026-09-08).
    const owner = wallet.publicKey() ?? '';

    const held = await this.holdings();
    const holdings = held.ok && held.data ? held.data : [];
    // Opportunistically retry fills whose reconciliation failed earlier —
    // usually the RPC was rate-limited at the moment the trade landed. After
    // the holdings read, so it does not compete with it for the RPC bucket.
    void ledger.reconcilePending(httpUrl, owner || null).catch(() => undefined);
    // Liquidation quotes run alongside the price lookups below.
    const liquidationP = liquidationQuotes(holdings);

    const prices = new Map<string, {
      priceSol: number | null; priceUsd: number | null; marketCapUsd: number | null;
      name: string; symbol: string; imageUrl: string | null; circSupply: number | null;
    }>();
    const paperOpen = paperBook.list();
    const paperClosed = paperBook.closed();
    const basis = ledger.basisByMint(owner || null);
    const decimalsOf = new Map<string, number>();
    const take = (mint: string, sum: import('@shared/market').TokenSummary): void => {
      prices.set(mint, {
        priceSol: sum.priceSol, priceUsd: sum.priceUsd, marketCapUsd: sum.marketCapUsd,
        name: sum.name, symbol: sum.symbol, imageUrl: sum.imageUrl, circSupply: sum.circSupply,
      });
      decimalsOf.set(mint, sum.decimals);
    };
    // Only what is HELD is priced on the awaited path: open holdings and
    // open paper positions, batched (one Jupiter search + one Shield call
    // warm the set, then four lanes behind the per-host gate). Closed rows
    // only need a NAME, and every mint ever traded used to be priced here —
    // 22 mints, most of them dead, walking parked providers for 8–10 s on
    // every Portfolio visit (measured 2026-09-08).
    const open = [...new Set([...holdings.map((h) => h.mint), ...paperOpen.map((p) => p.mint)])].slice(0, 60);
    const sums = await market.summaryMany(open, 4);
    for (const [mint, sum] of sums) take(mint, sum);
    // Closed rows: the ledger's own symbol, the paper book's, or a cached
    // summary — free. Anything still nameless is named off the critical path
    // and found in the cache by the next build.
    const closedOnly = [...new Set([...basis.keys(), ...paperClosed.map((c) => c.mint)])].filter((m) => !prices.has(m));
    const unnamed: string[] = [];
    for (const m of closedOnly) {
      const cachedSum = market.summaryIfCached(m);
      if (cachedSum) {
        take(m, cachedSum);
        continue;
      }
      const sym = basis.get(m)?.symbol || paperClosed.find((c) => c.mint === m)?.symbol || '';
      if (sym) prices.set(m, { priceSol: null, priceUsd: null, marketCapUsd: null, name: '', symbol: sym, imageUrl: null, circSupply: null });
      else unnamed.push(m);
    }
    if (unnamed.length) {
      void market
        .summaryMany(unnamed.slice(0, 40), 2, { skipUnpriceable: true })
        .then((named) => {
          for (const [m, sum] of named) if (sum.symbol) paperBook.noteSymbol(m, sum.symbol);
        })
        .catch(() => undefined);
    }

    let solUsd: number | null = null;
    try {
      // A full `summary()` for wSOL is four provider calls to read one number
      // the Jupiter layer already holds on a 20 s cache. Null when Jupiter is
      // off, which the catch below already treats as the honest result.
      solUsd = await market.solUsd();
    } catch {
      /* null SOL price makes USD figures null, which is the honest result */
    }

    const info = wallet.info();
    const liquidation = await liquidationP;
    const out = portfolio.build({
      holdings,
      solBalance: info.balanceSol,
      solUsd,
      prices,
      wallet: wallet.publicKey(),
      liquidation,
    });
    // Paper positions ride alongside, priced by the same providers, and
    // contribute to none of the real totals above.
    // A paper trade booked before its symbol was known learns it here, and
    // the book is corrected so every later view agrees.
    for (const c of paperClosed) {
      const sym = c.symbol || prices.get(c.mint)?.symbol || '';
      if (sym && !c.symbol) paperBook.noteSymbol(c.mint, sym);
    }
    for (const p of paperOpen) {
      const sym = p.symbol || prices.get(p.mint)?.symbol || '';
      if (sym && !p.symbol) paperBook.noteSymbol(p.mint, sym);
    }
    out.paper = {
      positions: paperBook.list().map((p) => {
        const px = prices.get(p.mint);
        return paperToPosition(p, px ? { ...px, decimals: decimalsOf.get(p.mint) ?? 6 } : undefined, solUsd);
      }),
      realizedPnlSol: paperBook.realized(),
      closed: paperBook.closed(),
      model: PAPER_FILL_MODEL,
    };
    out.stale = false;
    if (owner !== (wallet.publicKey() ?? '')) return out; // switched mid-build: not the new wallet's
    this.lastPortfolio = { at: Date.now(), startedAt, owner, summary: out };
    this.emit({ kind: 'portfolio', summary: out });
    return out;
  }

  /**
   * What each holding would fetch if sold now — a Jupiter sell quote of the
   * whole balance, six at a time, each bounded to 2.5 s so a slow quote can
   * never hold the position panel. A mint that does not quote simply falls
   * back to spot × amount in build(), labelled as such.
   */

  /** Real fills from the ledger AND paper fills from the book, newest first.
   *  Paper rows carry `paper: true`; the Trades tab labels and filters them.
   *  Nothing about a paper row reaches the real totals — this is a list. */
  tradeHistory(): import('@shared/portfolio').TradeHistoryRow[] {
    const paper = paperHistoryRows({ version: 1, open: paperBook.list(), closed: paperBook.closed() }).map((r) =>
      r.symbol ? r : { ...r, symbol: this.tokens.get(r.mint)?.row.symbol ?? market.summaryIfCached(r.mint)?.symbol ?? '' },
    );
    if (!paper.length) return portfolio.history();
    return [...portfolio.history(), ...paper].sort((a, b) => b.at - a.at);
  }

  // ── What the chain says a position cost ──────────────────────────
  //
  // Three readers of the ledger's reconciled basis, all of them answering
  // the same question — what did THIS wallet really pay — and all of them
  // answering null rather than a guess. The house rule is that a cost basis
  // is the on-chain lamport delta and never the amount that was requested,
  // so an unreadable fill makes the answer unknown, not zero.

  /** The active wallet's reconciled basis for one mint, or null. */
  private basisFor(mint: string): import('./ledger').MintBasis | null {
    const owner = wallet.publicKey();
    if (!owner) return null;
    return ledger.basisByMint(owner).get(mint) ?? null;
  }

  /**
   * What the active wallet paid for everything it still holds of `mint`, SOL.
   *
   * copyTrade scales a mirrored sell by the copier's share of this, so that
   * "they sold 40 % of their bag" does not sell 40 % of a hand-bought bag and
   * of whatever an order ladder is still holding (copy-2).
   *
   * Null only when there is nothing to measure at all: no wallet, no
   * reconciled buy, or nothing left of the position.
   *
   * A basis built from SOME of the fills is deliberately still returned. It
   * reads as "we paid less than we did", so our share of it looks larger and
   * the ratio moves toward 1 — and 1 is exactly what copyTrade falls back to
   * when this answers null. A partial basis is therefore never worse than no
   * basis, and usually much better. Refusing on any unreadable fill would
   * also blind a mint PERMANENTLY, since `unreconciled` is a terminal state:
   * one failed transaction would restore the copy-2 bug for that token for
   * the life of the ledger.
   */
  private ourCostBasisSol(mint: string): number | null {
    const b = this.basisFor(mint);
    if (!b) return null;
    if (!(b.spentSol > 0) || !(b.tokensBought > 0)) return null;
    const held = b.tokensBought - b.tokensSold;
    if (!(held > 0)) return null;
    // Average cost of the tokens still held, not of everything ever bought.
    return (b.spentSol / b.tokensBought) * Math.min(held, b.tokensBought);
  }

  /**
   * The average price this wallet actually entered `mint` at, SOL per token,
   * or null when it holds none / the fills cannot be priced yet.
   */
  private positionEntryPriceSol(mint: string): number | null {
    const b = this.basisFor(mint);
    if (!b || !(b.spentSol > 0) || !(b.tokensBought > 0)) return null;
    if (!(b.tokensBought - b.tokensSold > 0)) return null;
    const avg = b.spentSol / b.tokensBought;
    return Number.isFinite(avg) && avg > 0 ? avg : null;
  }

  /**
   * One fill, priced from the chain — only once the ledger has reconciled it.
   * A fresh broadcast is `pending` for a few seconds, and this answers null
   * for the whole of that: an unreconciled fill has no cost and no fill price,
   * and inventing either is exactly the failure the ledger exists to prevent.
   */
  private reconciledFill(signature: string): { spentSol: number; priceSol: number | null } | null {
    const f = ledger.all().find((x) => x.signature === signature);
    if (!f || f.state !== 'reconciled' || f.solDeltaLamports === null) return null;
    const spentSol = Math.abs(f.solDeltaLamports) / 1e9;
    if (!(spentSol > 0)) return null;
    let priceSol: number | null = null;
    if (f.tokenDeltaRaw !== null && f.decimals !== null) {
      try {
        const tokens = Math.abs(Number(BigInt(f.tokenDeltaRaw)) / 10 ** f.decimals);
        if (tokens > 0) priceSol = spentSol / tokens;
      } catch {
        /* an unreadable raw delta leaves the price unknown, never zero */
      }
    }
    return { spentSol, priceSol };
  }

  /**
   * What share of a wallet's CURRENT balance `tokensRaw` base units are, as a
   * percentage to two decimals — or null when there is nothing to size
   * against, in which case the caller keeps the percentage it already had.
   *
   * The sell rail is percentage-of-balance all the way down (the local
   * builder, the Jupiter route and the relayer all take "NN%"), so this is
   * the join between a caller that knows a QUANTITY — copy trading, which
   * knows exactly how many tokens a copy holds — and a pipeline that takes a
   * share. Doing the conversion here, against a balance read at request
   * time, is the difference between selling the copy's tokens and selling
   * whatever fraction a cost-basis ratio happened to work out to.
   */
  private async pctForTokens(mint: string, tokensRaw?: string, walletId?: string): Promise<number | null> {
    if (!tokensRaw || !/^\d+$/.test(tokensRaw)) return null;
    let want: bigint;
    try {
      want = BigInt(tokensRaw);
    } catch {
      return null;
    }
    if (want <= 0n) return null;
    const owner = walletId ? wallet.publicKeyOf(walletId) : wallet.publicKey();
    if (!owner) return null;
    const s = this.getSettings();
    const r = await getTokenBalanceRawForMint(s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner, mint).catch(() => null);
    if (!r || !r.ok || !r.data || r.data.raw <= 0n) return null;
    if (want >= r.data.raw) return 100;
    // Rounded UP. The failure this exists to fix is systematically selling
    // short, and one basis point of overshoot is cheaper than a remainder.
    const bps = (want * 10_000n + r.data.raw - 1n) / r.data.raw;
    return Math.max(0.01, Math.min(100, Number(bps) / 100));
  }

  /**
   * Base units a signature's fill actually moved, waiting for the ledger to
   * reconcile it. Null when it never settles, or when the chain's delta
   * could not be read — never zero, and never a guess.
   */
  private awaitFillTokens(signature: string, timeoutMs = 30_000): Promise<{ raw: string; decimals: number } | null> {
    const readOf = (f: import('./ledger').Fill | undefined): { raw: string; decimals: number } | null => {
      if (!f || f.state !== 'reconciled' || f.tokenDeltaRaw === null) return null;
      try {
        const raw = BigInt(f.tokenDeltaRaw);
        const abs = raw < 0n ? -raw : raw;
        return abs > 0n ? { raw: abs.toString(), decimals: f.decimals ?? 0 } : null;
      } catch {
        return null;
      }
    };
    const known = ledger.all().find((x) => x.signature === signature);
    if (known && known.state !== 'pending') return Promise.resolve(readOf(known));
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      let done = false;
      const finish = (v: { raw: string; decimals: number } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off?.();
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      off = ledger.onSettled((f) => {
        if (f.signature === signature) finish(readOf(f));
      });
      // Settled between the read above and the subscription: the listener
      // would never fire, and the wait would run to its timeout for an
      // answer that is already on the shelf.
      const again = ledger.all().find((x) => x.signature === signature);
      if (again && again.state !== 'pending') finish(readOf(again));
    });
  }

  /**
   * The ledger's record of a BUY of `mint` this install made around `atMs`,
   * in base units — how a copy row opened before quantities were tracked
   * recovers its own size.
   *
   * The copy's buy IS a fill here: the ledger reconciled that transaction's
   * own token delta when it landed. Matching is deliberately strict, because
   * the number goes on to size a real sell:
   *
   *   • one reconciled buy of that mint by that wallet → that is the one;
   *   • several → the closest to `atMs`, and only if it is inside five
   *     minutes AND a clear minute closer than the runner-up;
   *   • anything else → null, which leaves the copy on the old percentage
   *     path rather than on a quantity from somebody else's trade.
   */
  private ledgerBuyFill(mint: string, atMs: number, walletId?: string): { raw: string; decimals: number } | null {
    const owner = walletId ? wallet.publicKeyOf(walletId) : wallet.publicKey();
    if (!owner) return null;
    const near = ledger
      .all()
      .filter(
        (f) =>
          f.mint === mint &&
          f.side === 'buy' &&
          f.state === 'reconciled' &&
          f.tokenDeltaRaw !== null &&
          f.decimals !== null &&
          // A fill from before multi-wallet carries no owner. It belongs to
          // whichever wallet was active then, which we cannot know, so it is
          // only trusted for the active signer.
          (f.wallet === owner || (f.wallet === null && owner === wallet.publicKey())),
      )
      .sort((a, b) => Math.abs(a.at - atMs) - Math.abs(b.at - atMs));
    if (!near.length) return null;
    if (near.length > 1) {
      const best = Math.abs(near[0].at - atMs);
      const next = Math.abs(near[1].at - atMs);
      if (best > 5 * 60_000 || next - best < 60_000) return null;
    }
    try {
      const raw = BigInt(near[0].tokenDeltaRaw as string);
      const abs = raw < 0n ? -raw : raw;
      return abs > 0n ? { raw: abs.toString(), decimals: near[0].decimals as number } : null;
    } catch {
      return null;
    }
  }

  // ── Advanced orders (term.txt §2) ────────────────────────────────
  //
  // The engine owns the two things advOrders cannot know for itself: whether
  // execution is currently permitted, and what a token is worth right now.

  /** Why an order cannot execute, in the user's words. Null = it can. */
  private executionBlockedReason(): string | null {
    const s = this.getSettings();
    if (!s.execution.liveEnabled) return 'live execution is off in settings';
    if (!this.armed) return 'the engine is not armed';
    if (!wallet.exists()) return 'there is no trading wallet';
    // NOTE: `entriesPauseReason` gates new STRATEGY entries (loss limit,
    // program upgrade, decoder drift). Those breakers should stop an
    // order-driven BUY for the same reasons they stop an automated entry —
    // but they must never block a SELL, because refusing to let someone out
    // during a breaker is how a protective stop becomes a trap. The
    // per-order check below only applies it to buys.
    return null;
  }

  ordersSnapshot(): import('@shared/orders').OrdersSnapshot {
    const blocked = this.executionBlockedReason();
    return {
      orders: advOrders.all(),
      executable: blocked === null,
      blockedReason: blocked,
      pausedCount: advOrders.pausedCount(),
    };
  }

  /**
   * Anchor a percentage order.
   *
   * `referencePriceSol` is what "30 % stop" is measured FROM, and
   * shared/orders.ts says what it is meant to be: "usually the user's entry,
   * or the spot price if there is no position". It was resolved from three
   * SPOT sources with no position lookup at all (ord-9) — so a stop written
   * on a token that had already halved armed 30 % below the halved price,
   * which is 65 % below the entry the user was thinking of, and nothing on
   * screen said so.
   *
   * So: the open position's average entry FIRST, from the ledger's reconciled
   * fills (the chain's lamport delta, not what was requested), and spot only
   * when the wallet holds none of it. Spot's own priority order is unchanged:
   *
   *   1. our own live tape (what the order is actually judged against);
   *   2. the last price this session observed for the mint;
   *   3. the market layer — the SAME number the token page is showing.
   *
   * Step 3 matters: without it the engine refused to anchor orders on any
   * token it had not personally watched launch, while the UI was displaying
   * a perfectly good price two inches away. Async for that reason.
   *
   * `describeOrder` appends the anchor to every percentage order, so whichever
   * one this picks is on the confirmation, the list and the chart label.
   */
  async createOrder(req: import('@shared/orders').NewOrderRequest): Promise<{ ok: boolean; message: string }> {
    // Only the percentage kinds are measured from an anchor; a limit order's
    // trigger is absolute and "entry" would be a meaningless thing to stamp.
    if (isPctKind(req.kind)) {
      const entry = this.positionEntryPriceSol(req.mint);
      if (entry !== null) {
        const r = advOrders.create(req, { referencePriceSol: entry });
        return { ok: r.ok, message: r.message };
      }
    }
    const tracked = this.tokens.get(req.mint);
    let referencePriceSol = tracked?.row.priceSol ?? this.lastKnownPriceSol.get(req.mint) ?? null;
    if (!(referencePriceSol !== null && referencePriceSol > 0)) {
      try {
        // freshSummary, not summary: an order's trigger is measured against
        // this number, and a price held over from a throttled provider would
        // set the trigger in the wrong place. No price is a refusal the user
        // can act on; a stale one is a fill they did not ask for.
        const sum = await market.freshSummary(req.mint);
        if (sum && sum.priceSol !== null && sum.priceSol > 0) {
          referencePriceSol = sum.priceSol;
          this.rememberPrice(req.mint, sum.priceSol);
        }
      } catch {
        /* fall through to the refusal below, which explains itself */
      }
    }
    const r = advOrders.create(req, { referencePriceSol });
    return { ok: r.ok, message: r.message };
  }

  cancelOrder(id: string): { ok: boolean; message: string } {
    return advOrders.cancel(id);
  }

  resumeOrders(): { ok: boolean; message: string } {
    const r = advOrders.resumePaused();
    this.emit({ kind: 'orders', snapshot: this.ordersSnapshot() });
    return { ok: r.ok, message: r.message };
  }

  clearCompletedOrders(): { ok: boolean; message: string } {
    const n = advOrders.clearCompleted();
    this.emit({ kind: 'orders', snapshot: this.ordersSnapshot() });
    return { ok: true, message: `Cleared ${n} finished order${n === 1 ? '' : 's'}` };
  }

  /** Last price seen per mint, for mints we are not actively tracking.
   *  Bounded — this is a convenience cache, not a store. */
  private lastKnownPriceSol = new Map<string, number>();
  private lastKnownPriceAt = new Map<string, number>();

  private rememberPrice(mint: string, priceSol: number): void {
    if (!(priceSol > 0)) return;
    this.lastKnownPriceSol.set(mint, priceSol);
    this.lastKnownPriceAt.set(mint, Date.now());
    if (this.lastKnownPriceSol.size > 500) {
      const oldest = this.lastKnownPriceSol.keys().next().value;
      if (oldest !== undefined) {
        this.lastKnownPriceSol.delete(oldest);
        this.lastKnownPriceAt.delete(oldest);
      }
    }
  }

  /** A remembered price is only usable for BILLING while it is fresh. A
   *  memecoin that has not traded for minutes can be worth a fraction of
   *  its last print, and the platform fee on a sell is charged against this
   *  estimate — an hour-old price would bill a fee against value that is no
   *  longer there. Reading a price for display has no such constraint. */
  private freshPriceSol(mint: string, maxAgeMs = 60_000): number | null {
    const at = this.lastKnownPriceAt.get(mint);
    if (at === undefined || Date.now() - at > maxAgeMs) return null;
    return this.lastKnownPriceSol.get(mint) ?? null;
  }

  /**
   * Poll prices for mints that have armed orders but are NOT on the live
   * tape — a migrated token, or any mint while the feed is stopped. Without
   * this a stop loss on a graduated coin would never evaluate, which is
   * protection the user thinks they have and does not.
   */
  /** Deliberately never cleared: orders and alerts must keep evaluating with
   *  the launch scanner stopped, so this runs for the process lifetime. */
  private ordersPollTimer: NodeJS.Timeout | null = null;

  private ordersPollBusy = false;
  /** Armed mints with no price right now: when the gap began, and whether
   *  the user has been told. */
  private priceGap = new Map<string, { since: number; warned: boolean }>();


  private startOrdersPoll(): void {
    if (this.ordersPollTimer) return;
    const tick = async (): Promise<void> => {
      // A slow provider must not stack ticks behind itself.
      if (this.ordersPollBusy) return;
      this.ordersPollBusy = true;
      try {
        // Orders AND alerts share this loop — both need prices for mints the
        // launch feed never carries (anything migrated, or everything when
        // the scanner is stopped). Mints on our own tape are already ticked
        // by onTrade at full rate.
        // Open copies ride the same poll: a copied Raydium token gets no
        // tick from any feed, so this is what marks it to market.
        const copyMints = new Set(copyTrade.openMints());
        const mints = [...new Set([...advOrders.armedMints(), ...alerts.armedMints(), ...copyMints])].filter(
          (m) => !this.curveFeedIsTicking(m),
        );
        if (!mints.length) {
          this.priceGap.clear();
          return;
        }
        // One batched, PRIORITY Jupiter search and Shield call for every
        // armed mint, then the per-mint assembly finds its Jupiter half in
        // memory. Priority because this is the price a stop-loss evaluates
        // against: it must not wait behind Discover, and it must not go
        // blind while a Discover-driven 429 has the provider parked —
        // before 2026-09-06 a park meant `priceSol: null`, `onTick` never
        // ran, and the stop could not fire, with nothing logged.
        const sums = await market.summaryMany(mints, 2, { priority: true });
        const withOrders = new Set(advOrders.armedMints());
        for (const mint of mints) {
          const sum = sums.get(mint) ?? null;
          if (sum && sum.priceSol !== null && sum.priceSol > 0) {
            this.priceGap.delete(mint);
            this.rememberPrice(mint, sum.priceSol);
            advOrders.onTick({ mint, priceSol: sum.priceSol, mcapUsd: sum.marketCapUsd });
            if (copyMints.has(mint)) copyTrade.markToMarket(mint, sum.priceSol);
          } else if (withOrders.has(mint)) {
            this.notePriceGap(mint, sum?.symbol ?? '');
          }
          if (!sum) continue;
          alerts.onTick({
            mint,
            symbol: sum.symbol,
            priceSol: sum.priceSol,
            mcapUsd: sum.marketCapUsd,
            volume5mUsd: sum.stats['5m']?.volumeUsd ?? null,
            liquidityUsd: sum.liquidityUsd,
            holders: sum.holders,
            curvePct: sum.bondingCurvePct,
          });
        }
      } catch {
        /* a provider being down must not stop the loop */
      } finally {
        this.ordersPollBusy = false;
      }
    };
    void tick();
    this.ordersPollTimer = setInterval(() => void tick(), 12_000);
  }

  /** When the order / alert / copy evaluation last threw for a mint. */
  private evalErrorAt = new Map<string, number>();

  /**
   * The per-trade evaluation threw. The trade handler has already recorded
   * the tape and carries on; this says what broke, at most once a minute per
   * mint, so a throwing order is a line in the Console and never a silent
   * chart. Before 2026-09-20 the same throw skipped the tape record itself.
   */
  private noteEvalError(what: string, mint: string, err: unknown): void {
    const now = Date.now();
    const last = this.evalErrorAt.get(mint) ?? 0;
    if (now - last < 60_000) return;
    this.evalErrorAt.set(mint, now);
    if (this.evalErrorAt.size > 500) {
      const oldest = this.evalErrorAt.keys().next().value;
      if (oldest !== undefined) this.evalErrorAt.delete(oldest);
    }
    const msg = err instanceof Error ? err.message : String(err);
    this.log('error', `${what} evaluation threw for ${mint.slice(0, 8)}… — ${msg}. The chart tape was recorded first and is unaffected.`);
  }

  /** An armed order whose mint has had no price for 20 s cannot evaluate.
   *  Say so once per gap, naming the parked provider, instead of leaving a
   *  stop-loss silently blind. */
  private notePriceGap(mint: string, symbol: string): void {
    const now = Date.now();
    const g = this.priceGap.get(mint) ?? { since: now, warned: false };
    this.priceGap.set(mint, g);
    if (g.warned || now - g.since < 20_000) return;
    g.warned = true;
    const name = symbol || `${mint.slice(0, 8)}…`;
    const parked = market.parkedProviders();
    const why = parked.length ? `${parked.join(', ')} rate limited` : 'no provider has a price';
    const secs = Math.round((now - g.since) / 1000);
    this.log('warn', `${name}: no price for ${secs}s (${why}) — the armed stop-loss / take-profit cannot evaluate until a provider answers`);
    this.emit({ kind: 'toast', level: 'warn', message: `${name}: no price for ${secs}s (${why}) — your armed order cannot evaluate until a provider answers` });
  }

  /**
   * Sell a held mint. `percent` defaults to the whole position.
   *
   * Partial sells use the local builder too (since 2026-09-07): it sizes the
   * sell as `sellPct` of the token-account balance and closes the ATA only at
   * 100% (`txBuilder.sellAmountFor`, pinned by test). Before that it
   * hardcoded the full balance, so partials were withheld from it — which
   * left every take-profit step on a mayhem-mode coin to Jupiter (no route)
   * and the relayer (reverts `Overflow`), i.e. unsellable.
   */
  /** Estimated proceeds of selling `pct`% of the held balance, lamports, for
   *  FEE billing on relayer-built sells (no quote exists there). Held balance
   *  and price fetched in parallel with the other pre-sell lookups; null when
   *  either is unknown — the sell then goes unbilled rather than misbilled. */
  private async estSellProceedsLamports(mint: string, pct: number): Promise<number | undefined> {
    try {
      const s = this.getSettings();
      const owner = wallet.publicKey();
      if (!owner) return undefined;
      // The engine already knows the price of any mint it has seen trade —
      // the feed row, the last-known map, or the tape. A provider summary
      // (five HTTP calls, non-priority, queued behind Discover's 2.1 s
      // GeckoTerminal gap) used to sit on EVERY exit purely to price this
      // fee. Now it is only asked when nothing local knows, and for at most
      // 250 ms — an unpriced sell goes unbilled, never late.
      const balP = getTokenBalanceForMint(s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner, mint);
      let priceSol: number | null =
        this.tokens.get(mint)?.row.priceSol ?? this.freshPriceSol(mint) ?? tape.lastPriceSol(mint) ?? null;
      if (priceSol === null || priceSol <= 0) {
        priceSol = await Promise.race([
          market.freshSummary(mint).then((sum) => sum?.priceSol ?? null).catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 250)),
        ]);
      }
      const bal = await balP;
      if (!bal.ok || bal.data === undefined || bal.data <= 0 || priceSol === null || priceSol <= 0) return undefined;
      const est = Math.floor(bal.data * (pct / 100) * priceSol * 1e9);
      return est > 0 ? est : undefined;
    } catch {
      return undefined;
    }
  }

  async manualSell(
    mint: string,
    percent = 100,
    opts: { slippagePct?: number } = {},
  ): Promise<import('./liveSigner').LiveTradeResult> {
    const s = this.getSettings();
    // Two decimals: a caller that knows a token QUANTITY (copy trading) has
    // already converted it to the share of the balance it really is, and
    // rounding that to a whole percent here would put up to 1 % of the
    // position back in the wallet. Whole-number callers are unchanged.
    const pct = Math.max(0.01, Math.min(100, Math.round(percent * 100) / 100));
    // Paper mode sells from the paper book at the current price. A real
    // sell needs Live; the two never cross.
    if (this.paperMode()) return this.paperSell(mint, pct);
    if (!s.execution.liveEnabled) return { ok: false, stage: 'validate', message: 'Enable real broadcast before selling' };
    // Both lookups run concurrently; neither blocks the other.
    const localParams = await this.localBuildParamsForSell(mint);
    // NOT awaited: only a relayer-built sell is billed from this estimate,
    // and the local builder (the default since 09-01) prices itself from its
    // own quote. Awaiting it here put a token-balance RPC in front of every
    // exit for a number the default path discards. It resolves while the
    // transaction is built, and the relayer branch awaits it if it gets that
    // far. Never rejects: the estimator already returns undefined on error.
    const estProceeds = this.estSellProceedsLamports(mint, pct).catch(() => undefined);
    // What this wallet can actually afford to spend getting out.
    const exit = this.exitParams(s.execution);
    const res = await this.sellWithRetry({
      action: 'sell',
      mint,
      amount: `${pct}%`,
      denominatedInSol: false,
      // A caller's own tolerance (copy trading's `maxSlippagePct`) replaces the
      // execution setting, but never the 15 % exit floor: an exit must not be
      // made impossible by a number someone typed into a follower's config.
      slippagePct: Math.max(
        opts.slippagePct !== undefined && opts.slippagePct > 0 ? opts.slippagePct : s.execution.liveSlippagePct,
        15,
      ),
      priorityFeeSol: exit.priorityFeeSol,
      httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
      simulateOnly: false,
      // Every sell gets the local builder (ATA close at 100%, no relayer fee, and the
      // only route that builds on a bonding curve the relayer 400s on); the
      // relayer stays as fallback; a partial is sized as its share of the balance.
      local: localParams,
      estProceedsLamports: estProceeds,
      exec: exit.exec,
      wssUrl: this.confirmWssUrl(),
      onProcessed: (sig) => this.emitFill(mint, 'sell', sig, 'landed'),
    });
    recorder.record('manual_sell', { mint, pct, ok: res.ok, stage: res.stage, signature: res.signature ?? null, note: res.message.slice(0, 220), timing: res.timing ?? null });
    if (res.signature) {
      if (res.ok) this.emitFill(mint, 'sell', res.signature, 'landed');
      else if (res.stage === 'confirm') this.emitFill(mint, 'sell', res.signature, 'failed');
    }
    if ((res.ok || res.stage === 'pending') && res.signature) {
      ledger.recordFill(
        { mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'sell', requested: pct, signature: res.signature },
        { httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner: wallet.publicKey() },
      );
    }
    this.log(res.ok ? 'info' : 'warn', `manual sell ${pct}% (${res.stage}): ${res.message}`);
    // Only a full exit clears the mint from live tracking — a partial sell
    // leaves a real position behind that the exit paths must keep watching.
    if (pct >= 100) {
      this.liveMints.delete(mint);
      if (res.ok) this.stuckMints.delete(mint);
    }
    return res;
  }

  private static readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';

  /** Every SPL token the wallet holds ON-CHAIN right now — the ground truth,
   *  independent of any session's position list. Symbols enriched from the
   *  current session's tracked tokens when known. */
  /** The last holdings read, shared for a moment: three pollers (position
   *  panel, Portfolio, Positions) each spent two getTokenAccountsByOwner —
   *  the heaviest public method in steady use — on the same answer. Short,
   *  so a fill's reload still sees the new token. */
  private holdingsShared: { at: number; owner: string; p: Promise<{ ok: boolean; message: string; data?: WalletHolding[] }> } | null = null;

  /** The last successful read, for the holdings panels to open on. Trade
   *  paths never read it — they call holdings() and wait for the chain. */
  private lastHoldings: { at: number; owner: string; data: WalletHolding[] } | null = null;

  /** The last read for the active wallet, or null — never a read. Older
   *  than 2 s = stale, and a fresh read is started; its result arrives as a
   *  'holdings' event when anything changed. */
  holdingsCached(): { data: WalletHolding[]; at: number; stale: boolean } | null {
    const owner = wallet.publicKey();
    const lh = this.lastHoldings;
    if (!owner || !lh || lh.owner !== owner) return null;
    const stale = Date.now() - lh.at > 2_000;
    if (stale) void this.holdings().catch(() => undefined);
    return { data: lh.data, at: lh.at, stale };
  }

  async holdings(): Promise<{ ok: boolean; message: string; data?: WalletHolding[] }> {
    const owner = wallet.publicKey();
    if (!owner) return { ok: false, message: 'No trading wallet' };
    const now = Date.now();
    if (this.holdingsShared && this.holdingsShared.owner === owner && now - this.holdingsShared.at < 2_000) {
      return this.holdingsShared.p;
    }
    const p = this.readHoldings(owner);
    this.holdingsShared = { at: now, owner, p };
    return p;
  }

  private async readHoldings(owner: string): Promise<{ ok: boolean; message: string; data?: WalletHolding[] }> {
    const s = this.getSettings();
    const httpUrl = s.rpc.execHttpUrl ?? s.rpc.httpUrl;
    const r = await getTokenAccountsByOwner(httpUrl, owner);
    if (!r.ok || !r.data) return { ok: false, message: r.message };
    const held = r.data.filter((h) => h.uiAmount > 0);
    await this.annotateMintWarnings(httpUrl, held.map((h) => ({ mint: h.mint, programId: h.programId })));
    const data: WalletHolding[] = held.map((h) => ({
      ...h,
      symbol: this.tokens.get(h.mint)?.row.symbol ?? null,
      // undefined = the mint could not be read this time; null = read, clean.
      warning: this.mintWarnings.get(h.mint),
    }));
    const at = Date.now();
    // Switched mid-read: answer the caller, but this is not the new
    // wallet's list — never keep or broadcast it as such.
    if (owner !== wallet.publicKey()) return { ok: true, message: 'ok', data };
    // A copy row is opened by a buy and closed by a mirrored sell, so a
    // manual sell — or a stop-loss, or a take-profit rung — used to leave it
    // "open" forever (user report, 2026-09-13: three fully sold positions
    // still showing open). Here, rather than in the portfolio build, because
    // this is the one place a SUCCESSFUL holdings read lands: it costs no
    // extra request, it runs for every caller, and it cannot fire on a read
    // that failed — a failed read is not an empty wallet.
    this.reconcileCopyRows(owner, data);
    const prev = this.lastHoldings;
    const changed =
      !prev || prev.owner !== owner || prev.data.length !== data.length || prev.data.some((h, i) => h.mint !== data[i].mint || h.amountRaw !== data[i].amountRaw);
    this.lastHoldings = { at, owner, data };
    if (changed) this.emit({ kind: 'holdings', data, at });
    return { ok: true, message: 'ok', data };
  }

  /** Close live copy rows whose tokens have left the wallet this read is
   *  for. Scoped to the configs that actually sign with it: a config pinned
   *  to another wallet is not described by these holdings. */
  private reconcileCopyRows(owner: string, data: WalletHolding[]): void {
    const mine = new Set<string>();
    for (const c of copyTrade.all()) {
      if ((c.chain ?? 'solana') !== 'solana') continue;
      const signer = c.walletId ? wallet.publicKeyOf(c.walletId) : wallet.publicKey();
      if (signer === owner) mine.add(c.id);
    }
    if (mine.size === 0) return;
    copyTrade.reconcileHoldings(new Set(data.filter((h) => h.uiAmount > 0).map((h) => h.mint)), { configIds: mine });
    // …and the other direction: a copy the book calls CLOSED that the wallet
    // still holds tokens for. A mirrored sell is a share of a balance and can
    // come back short, and until 2026-09-15 nothing compared the two — a user
    // had 83,236 NON sitting outside every position view because the record
    // said the copy was done (report, 2026-09-15). Same read, no extra cost.
    copyTrade.reconcileQuantities(
      new Map(data.filter((h) => h.uiAmount > 0).map((h) => [h.mint, { raw: h.amountRaw, decimals: h.decimals }])),
      { configIds: mine },
    );
  }

  /** What a held mint's own bytes say about its sellability — a Token-2022
   *  permanent delegate (spam airdrop), transfer hook, or non-transferable
   *  flag. Extensions are fixed at mint creation, so a mint is read ONCE per
   *  process; classic SPL mints have none and are never read. Airdropped
   *  advertisements otherwise sit in the holdings list as "previous run"
   *  with a Sell button that fails three routes deep (2026-09-07). */
  private mintWarnings = new Map<string, string | null>();

  private async annotateMintWarnings(httpUrl: string, held: Array<{ mint: string; programId: string }>): Promise<void> {
    const unread: string[] = [];
    for (const h of held) {
      if (this.mintWarnings.has(h.mint)) continue;
      if (h.programId !== TOKEN_2022_PROGRAM) this.mintWarnings.set(h.mint, null);
      else if (!unread.includes(h.mint)) unread.push(h.mint);
    }
    if (unread.length === 0) return;
    try {
      for (let i = 0; i < unread.length; i += 100) {
        const batch = unread.slice(i, i + 100);
        const r = await getMultipleAccountInfo(httpUrl, batch);
        if (!r.ok || !r.data) return; // unread stays unknown, never "clean"
        batch.forEach((mint, j) => {
          const acc = r.data?.[j];
          if (!acc) return;
          this.mintWarnings.set(mint, mintWarning(parseMintExtensions(acc.data)));
        });
      }
    } catch {
      /* unknown stays unknown */
    }
    // Bounded: the wallet lab can walk many wallets through here.
    while (this.mintWarnings.size > 4_096) {
      const oldest = this.mintWarnings.keys().next().value;
      if (oldest === undefined) break;
      this.mintWarnings.delete(oldest);
    }
  }

  /** Sell 100% of every token the wallet actually holds (except wSOL).
   *  Chained behind in-flight live trades, so it liquidates only what
   *  remains after per-position sells complete. */
  sellAllHeld(reason: string): { ok: boolean; message: string } {
    const s = this.getSettings();
    if (this.paperMode()) {
      // Paper: close every paper position at its current price. Positions
      // with no price are left open and named, never filled at 0.
      const open = paperBook.list();
      if (open.length === 0) return { ok: false, message: 'No paper positions to close' };
      void (async () => {
        let closed = 0;
        const skipped: string[] = [];
        for (const p of open) {
          const r = await this.paperSell(p.mint, 100);
          if (r.ok) closed += 1;
          else skipped.push(p.symbol || p.mint.slice(0, 6));
        }
        const msg = `Paper: closed ${closed} position(s)${skipped.length ? ` — no price for ${skipped.join(', ')}, left open` : ''} (${PAPER_FILL_MODEL})`;
        this.log('info', `PAPER sell-all (${reason}): ${msg}`);
        this.emit({ kind: 'toast', level: skipped.length ? 'warn' : 'info', message: msg });
      })();
      return { ok: true, message: `Closing ${open.length} paper position(s)` };
    }
    if (!s.execution.liveEnabled) return { ok: false, message: 'Enable real broadcast before selling' };
    if (!wallet.exists()) return { ok: false, message: 'No trading wallet' };
    this.runLive(async () => {
      const h = await this.holdings();
      if (!h.ok || !h.data) {
        this.log('warn', `sell-all (${reason}): holdings fetch failed: ${h.message}`);
        this.emit({ kind: 'toast', level: 'warn', message: `Sell-all could not read holdings: ${h.message}` });
        return;
      }
      const all = h.data.filter((x) => x.mint !== SniperEngine.WSOL_MINT);
      // Dust is not a position. A holding of a few base units has no route —
      // measured 2026-09-09, a balance of ONE raw unit spent a local build, a
      // Jupiter quote (HTTP 400 "cannot compute other amount threshold, with
      // amount 1") and three relayer retries before failing. Sell-all is the
      // panic button: the reordering below already keeps doomed holdings from
      // delaying a real exit, and dust belongs in the same bucket. It is left
      // in the wallet, where its rent is worth more than its balance and the
      // user can close the account deliberately.
      const dust = all.filter((x) => isDustHolding(x));
      const held = all.filter((x) => !isDustHolding(x));
      // Holdings the mint itself flags (permanent delegate, transfer hook,
      // non-transferable) go LAST: each one that turns out to be a spam
      // airdrop burns three build routes, and a real exit must never queue
      // behind that.
      const sellable = [...held.filter((x) => !x.warning), ...held.filter((x) => x.warning)];
      if (dust.length > 0) {
        this.log(
          'info',
          `sell-all (${reason}): skipping ${dust.length} dust holding(s) with nothing to sell — ${dust.map((x) => `${x.symbol ?? `${x.mint.slice(0, 8)}…`}: ${x.uiAmount}`).join('; ')}`,
        );
      }
      if (sellable.length === 0) {
        this.log('info', `sell-all (${reason}): wallet holds no tokens${dust.length > 0 ? ' beyond dust' : ''}`);
        return;
      }
      const flagged = held.filter((x) => x.warning);
      if (flagged.length > 0) {
        this.log('info', `sell-all (${reason}): ${flagged.length} holding(s) look unsellable and go last — ${flagged.map((x) => `${x.symbol ?? `${x.mint.slice(0, 8)}…`}: ${x.warning}`).join('; ')}`);
      }
      this.log('warn', `sell-all (${reason}): liquidating ${sellable.length} held token(s)`);
      this.emit({ kind: 'toast', level: 'warn', message: `Selling ${sellable.length} held token(s) — ${reason.replace(/_/g, ' ')}` });
      for (const tkn of sellable) {
        const label = tkn.symbol ?? `${tkn.mint.slice(0, 8)}…`;
        const e = this.getSettings();
        // Sell-all runs on the active wallet and is exactly the case the exit
        // budget exists for: a wallet being emptied has less SOL with every
        // leg, and the last few must still be able to leave. Without this the
        // extras were charged at full price all the way down.
        const exit = this.exitParams(e.execution);
        const res = await this.sellWithRetry({
          action: 'sell',
          mint: tkn.mint,
          amount: '100%',
          denominatedInSol: false,
          slippagePct: Math.max(e.execution.liveSlippagePct, 15),
          priorityFeeSol: exit.priorityFeeSol,
          httpUrl: e.rpc.execHttpUrl ?? e.rpc.httpUrl,
          simulateOnly: false,
          local: await this.localBuildParamsForSell(tkn.mint),
          estProceedsLamports: this.estSellProceedsLamports(tkn.mint, 100).catch(() => undefined),
          exec: exit.exec,
          wssUrl: this.confirmWssUrl(),
        });
        // A real exit that never reaches the ledger is invisible to cost
        // basis, realised PnL, trade history AND the live loss breakers —
        // the round trip simply vanishes. Record it exactly as the manual
        // sell path does.
        if ((res.ok || res.stage === 'pending') && res.signature) {
          ledger.recordFill(
            { mint: tkn.mint, symbol: tkn.symbol ?? '', side: 'sell', requested: 100, signature: res.signature },
            { httpUrl: e.rpc.execHttpUrl ?? e.rpc.httpUrl, owner: wallet.publicKey() },
          );
        }
        recorder.record('sell_all_item', { mint: tkn.mint, reason, ok: res.ok, stage: res.stage, signature: res.signature ?? null, note: res.message.slice(0, 220) });
        this.liveMints.delete(tkn.mint);
        if (res.ok) {
          this.stuckMints.delete(tkn.mint);
          this.log('info', `sell-all: sold ${label}: ${res.message}`);
          this.emit({ kind: 'toast', level: 'info', message: `Sold ${label}` });
        } else {
          this.stuckMints.add(tkn.mint);
          this.log('error', `sell-all: ${label} FAILED (${res.stage}): ${res.message}`);
          this.emit({ kind: 'toast', level: 'error', message: `Sell failed for ${label} (${res.stage}) — try manually` });
        }
      }
      // Relayer-path sells leave their ATA (and its rent) behind — reclaim
      // everything empty now that the book is (as) flat (as it gets).
      const { sweepAtaRent } = await import('./rentSweep');
      const swept = await sweepAtaRent(s.rpc.execHttpUrl ?? s.rpc.httpUrl);
      recorder.record('rent_sweep', { ok: swept.ok, closed: swept.closed, recoveredSolEst: swept.recoveredSolEst, note: swept.message.slice(0, 220) });
      if (swept.closed > 0) this.log('info', `rent sweep after sell-all: ${swept.message}`);
    });
    return { ok: true, message: 'Sell-all queued' };
  }

  /** Close all zero-balance token accounts and reclaim their rent
   *  (~0.00203 SOL each). Recovers funds, so like manualSell it needs
   *  liveEnabled but not arming. Chained behind in-flight live trades so
   *  it never closes an ATA a queued sell is about to use. */
  async sweepRent(): Promise<{ ok: boolean; message: string; closed: number; recoveredSolEst: number }> {
    const s = this.getSettings();
    if (!s.execution.liveEnabled) return { ok: false, message: 'Enable real broadcast before sweeping', closed: 0, recoveredSolEst: 0 };
    if (!wallet.exists()) return { ok: false, message: 'No trading wallet', closed: 0, recoveredSolEst: 0 };
    const { sweepAtaRent } = await import('./rentSweep');
    let result: { ok: boolean; message: string; closed: number; recoveredSolEst: number } = { ok: false, message: 'not run', closed: 0, recoveredSolEst: 0 };
    const done = new Promise<void>((resolve) => {
      this.runLive(async () => {
        result = await sweepAtaRent(s.rpc.execHttpUrl ?? s.rpc.httpUrl);
        recorder.record('rent_sweep', { ok: result.ok, closed: result.closed, recoveredSolEst: result.recoveredSolEst, note: result.message.slice(0, 220) });
        if (result.closed > 0) {
          this.log('info', `rent sweep: ${result.message}`);
          this.emit({ kind: 'toast', level: 'success', message: `Reclaimed rent from ${result.closed} empty token account(s)` });
        } else {
          this.log(result.ok ? 'info' : 'warn', `rent sweep: ${result.message}`);
        }
        resolve();
      });
    });
    await done;
    return result;
  }

  /**
   * User-initiated SOL withdrawal to a wallet's confirmed withdrawal address.
   *
   * Runs on the SAME promise chain as live trades (runLive), so a withdraw can
   * never race a buy for the same lamports: whichever was queued first sees
   * the balance, the other sees what is left. The balance is re-read from
   * chain inside the chain slot for the same reason — a figure the renderer
   * captured before a queued buy landed is stale by definition.
   *
   * The signer's sweep policy (signPolicy.ts) is the real gate: exactly one
   * SystemProgram transfer, to THAT wallet's stored home address, under the
   * cap. Nothing here relaxes it.
   */
  async withdraw(args: { walletId?: string; lamports: number | 'max' }): Promise<{
    ok: boolean;
    message: string;
    signature?: string;
    lamports: number;
    dest: string | null;
  }> {
    const s = this.getSettings();
    const walletId = args.walletId;
    const owner = walletId ? wallet.publicKeyOf(walletId) : wallet.publicKey();
    if (!owner) return { ok: false, message: walletId ? 'No such wallet' : 'No trading wallet', lamports: 0, dest: null };
    const summary = wallet.list().find((w) => w.publicKey === owner);
    const dest = summary?.homeAddress ?? null;
    if (!dest) return { ok: false, message: 'Set a withdrawal address first', lamports: 0, dest: null };
    if (args.lamports !== 'max' && !(Number.isFinite(args.lamports) && args.lamports > 0)) {
      return { ok: false, message: 'Amount must be a positive number of lamports', lamports: 0, dest };
    }

    let result: { ok: boolean; message: string; signature?: string; lamports: number; dest: string | null } = {
      ok: false, message: 'not run', lamports: 0, dest,
    };
    const done = new Promise<void>((resolve) => {
      this.runLive(async () => {
        try {
          const { sweepLamports, maxWithdrawableLamports } = await import('./sweep');
          const bal = await getBalance(s.rpc.httpUrl, owner);
          if (!bal.ok || bal.data === undefined) {
            result = { ok: false, message: `Balance unknown: ${bal.message}`, lamports: 0, dest };
            return;
          }
          const max = maxWithdrawableLamports(bal.data) ?? 0;
          const lamports = args.lamports === 'max' ? max : Math.floor(args.lamports);
          if (lamports <= 0) {
            result = { ok: false, message: 'Nothing withdrawable — the balance is at or below the rent-exempt minimum', lamports: 0, dest };
            return;
          }
          if (lamports > bal.data) {
            result = { ok: false, message: `Amount exceeds the wallet balance (${(bal.data / 1e9).toFixed(4)} SOL)`, lamports, dest };
            return;
          }
          if (lamports > max) {
            result = { ok: false, message: `Amount exceeds the withdrawable maximum of ${(max / 1e9).toFixed(4)} SOL (rent-exempt minimum + fee stay behind)`, lamports, dest };
            return;
          }
          const res = await sweepLamports(s.rpc.httpUrl, dest, lamports, walletId ? { walletId } : {});
          recorder.record('withdraw', { lamports, ok: res.ok, signature: res.signature ?? null, wallet: owner, note: res.message.slice(0, 220) });
          if (res.ok) {
            if (!walletId || walletId === wallet.info().id) {
              // Keep the live baseline honest: a manual withdrawal is not a loss.
              if (this.liveBaselineLamports !== null) this.liveBaselineLamports = Math.max(0, this.liveBaselineLamports - lamports);
              if (this.walletBalanceLamports !== null) this.walletBalanceLamports -= lamports;
            }
            this.log('info', `withdraw: sent ${(lamports / 1e9).toFixed(4)} SOL to ${dest.slice(0, 6)}… (${res.message})`);
          } else {
            this.log('error', `withdraw failed: ${res.message}`);
          }
          result = { ...res, lamports, dest };
        } finally {
          resolve();
        }
      });
    });
    await done;
    return result;
  }

  /** Startup check — a previous run may have crashed while holding tokens.
   *  If auto-sell-on-exit is on, liquidate them now. */
  async recoverAfterCrash(): Promise<void> {
    const s = this.getSettings();
    if (!s.execution.liveEnabled || !s.execution.autoSellOnExit || !wallet.exists()) return;
    const h = await this.holdings();
    if (!h.ok || !h.data) return;
    const held = h.data.filter((x) => x.mint !== SniperEngine.WSOL_MINT);
    if (held.length === 0) return;
    this.log('warn', `crash recovery: wallet still holds ${held.length} token(s) from a previous run — auto-selling`);
    this.emit({ kind: 'toast', level: 'warn', message: `Found ${held.length} token(s) left from a previous run — selling` });
    this.sellAllHeld('crash_recovery');
  }

  /** Wait for queued live trades (e.g. sell-all on quit) to finish, up to
   *  the timeout — lets before-quit drain without hanging shutdown. */
  async drainLive(timeoutMs: number): Promise<void> {
    await Promise.race([this.liveChain, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Sweep unswept live profit to the home address once it crosses the
   *  user's threshold. Runs off the 8s balance poll; 60s retry backoff. */
  private async maybeCashout(): Promise<void> {
    const e = this.getSettings().execution;
    if (!e.autoCashout || this.cashoutInFlight) return;
    if (this.liveBaselineLamports === null || this.walletBalanceLamports === null) return;
    if (Date.now() - this.lastCashoutAttemptAt < 60_000) return;
    const thresholdLamports = Math.max(0.01, e.cashoutThresholdSol) * 1e9;
    // The balance delta since arming is NOT profit: a deposit raises it just
    // as a winning trade does, and sweeping a deposit sends the user's own
    // trading capital to their cold wallet with a toast calling it profit.
    // Bound the sweep by what the ledger says was actually realised.
    const balanceDelta = this.walletBalanceLamports - this.liveBaselineLamports;
    const realisedLamports = Math.floor(this.liveRealisedSol() * 1e9);
    const unswept = Math.min(balanceDelta, realisedLamports - this.sweptLamports);
    if (unswept < thresholdLamports) return;
    const home = wallet.info().homeAddress;
    if (!home) {
      if (!this.cashoutWarned) {
        this.cashoutWarned = true;
        this.log('warn', 'auto-cashout: profit threshold reached but no withdrawal address is set (Wallet page)');
        this.emit({ kind: 'toast', level: 'warn', message: 'Profit ready to sweep — set a withdrawal address on the Wallet page' });
      }
      return;
    }
    this.cashoutInFlight = true;
    this.lastCashoutAttemptAt = Date.now();
    try {
      const amount = Math.floor(unswept - 0.001 * 1e9); // fee margin stays behind
      const { sweepLamports } = await import('./sweep');
      const s = this.getSettings();
      const res = await sweepLamports(s.rpc.httpUrl, home, amount);
      recorder.record('cashout', { lamports: amount, ok: res.ok, signature: res.signature ?? null, note: res.message.slice(0, 220) });
      if (res.ok) {
        this.sweptLamports += amount;
        this.walletBalanceLamports -= amount; // next poll corrects for the fee
        this.log('info', `auto-cashout: swept ${(amount / 1e9).toFixed(4)} SOL of realised profit to ${home.slice(0, 6)}… (${res.message})`);
        this.emit({ kind: 'toast', level: 'success', message: `Swept ${(amount / 1e9).toFixed(4)} SOL of realised profit to your wallet` });
      } else {
        this.log('error', `auto-cashout failed: ${res.message}`);
        this.emit({ kind: 'toast', level: 'error', message: `Profit sweep failed: ${res.message}` });
      }
    } finally {
      this.cashoutInFlight = false;
    }
  }

  // ── Wallet Lab ───────────────────────────────────────────────────

  /** A buy signed by a SPECIFIC wallet, through the full trade pipeline. */
  private async labBuy(
    walletId: string,
    mint: string,
    wantSol: number,
    /** The caller's own per-trade cap when it has one — a script's budget.
     *  Replaces the manual cap for that caller, exactly as in `testTrade`. */
    capSol?: number,
  ): Promise<{ ok: boolean; message: string; signature: string | null; costSol: number | null; stage?: string | null }> {
    const s = this.getSettings();
    if (!this.armed || !s.execution.liveEnabled) return { ok: false, message: 'live execution is not armed', signature: null, costSol: null, stage: 'validate' };
    // No click behind this buy, so the real-money breakers and the per-trade
    // cap apply exactly as they do to any other unattended buy.
    const breaker = this.liveBreakerReason();
    if (breaker) {
      this.updateLiveBreakers();
      return { ok: false, message: `live buys paused — ${breaker}`, signature: null, costSol: null, stage: 'validate' };
    }
    const cap = capSol ?? s.execution.maxLiveSol;
    const sol = Math.min(wantSol, cap);
    if (sol < wantSol) this.log('info', `lab buy sized down to the ${cap} SOL per-trade cap (asked ${wantSol})`);
    const { executeTrade } = await import('./liveSigner');
    const owner = wallet.publicKeyOf(walletId);
    if (!owner) return { ok: false, message: 'no such wallet', signature: null, costSol: null, stage: 'validate' };
    const res = await executeTrade({
      action: 'buy',
      mint,
      amount: sol,
      denominatedInSol: true,
      slippagePct: s.execution.liveSlippagePct,
      priorityFeeSol: this.priorityFeeSolFor('buy'),
      httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
      simulateOnly: false,
      local: await this.localBuildParamsAsync(mint),
      exec: s.execution,
      walletId,
      wssUrl: this.confirmWssUrl(),
    });
    if ((res.ok || res.stage === 'pending') && res.signature) {
      ledger.recordFill({ mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'buy', requested: sol, signature: res.signature }, { httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner });
    }
    recorder.record('lab_buy', { walletId, mint, sol, ok: res.ok, stage: res.stage, signature: res.signature ?? null });
    // `stage` travels with the result so the caller can tell "did not happen"
    // from "broadcast, not confirmed yet". The lab runner keyed its whole
    // bookkeeping off `ok` alone, so a PENDING buy took the failure branch —
    // no bag, no armSell, no hand-over — while the signature stayed in the
    // run and dragged realised down by the full cost of a position nothing
    // was watching (lab-3). Its own header says bags are never abandoned.
    //
    // `costSol` is DISPLAY ONLY and the field says so. `simulatedCostSol` is
    // set only on the simulateOnly branch, and this call is never that, so it
    // was null every single time (lab-11); the live result's own number is
    // `simulatedLossSol` — what the pre-broadcast simulation said the wallet
    // would be down. The loss cap ignores both and prices the bag from the
    // chain via `buySig`.
    return {
      ok: res.ok,
      message: res.message,
      signature: res.signature ?? null,
      costSol: res.simulatedLossSol ?? null,
      stage: res.stage ?? null,
    };
  }

  /** A sell (default the whole bag) signed by a SPECIFIC wallet. */
  private async labSell(walletId: string, mint: string, pct = 100): Promise<{ ok: boolean; message: string; signature: string | null; stage?: string | null }> {
    const s = this.getSettings();
    if (!this.armed || !s.execution.liveEnabled) return { ok: false, message: 'live execution is not armed', signature: null };
    const owner = wallet.publicKeyOf(walletId);
    if (!owner) return { ok: false, message: 'no such wallet', signature: null };
    // Two decimals, like `manualSell`: a copy config pinned to a lab wallet
    // exits through here, and it sizes from base units.
    const share = Math.max(0.01, Math.min(100, Math.round(pct * 100) / 100));
    // A lab wallet is not the active one, so the engine tracks no balance for
    // it — and a lab wallet is exactly the kind that runs down to dust. One
    // getBalance is affordable here (the Wallet Lab is a deliberate action,
    // not a snipe), and a failed read simply falls back to the unbudgeted
    // behaviour rather than blocking the exit.
    const labBal = await getBalance(s.rpc.httpUrl, owner).catch(() => null);
    const exit = this.exitParams(s.execution, labBal && labBal.ok && typeof labBal.data === 'number' ? labBal.data : null);
    const res = await this.sellWithRetry({
      action: 'sell',
      mint,
      amount: `${share}%`,
      denominatedInSol: false,
      slippagePct: Math.max(s.execution.liveSlippagePct, 15),
      priorityFeeSol: exit.priorityFeeSol,
      httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
      simulateOnly: false,
      local: await this.localBuildParamsForSell(mint),
      exec: exit.exec,
      walletId,
      wssUrl: this.confirmWssUrl(),
    });
    if ((res.ok || res.stage === 'pending') && res.signature) {
      ledger.recordFill({ mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'sell', requested: share, signature: res.signature }, { httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl, owner });
    }
    // Selling the ACTIVE wallet's own bag this way (a script naming it)
    // must leave the engine's position tracking as a manual sell would.
    if (owner === wallet.publicKey() && share >= 100) {
      this.liveMints.delete(mint);
      if (res.ok) this.stuckMints.delete(mint);
    }
    recorder.record('lab_sell', { walletId, mint, pct: share, ok: res.ok, stage: res.stage, signature: res.signature ?? null });
    // Same reason as labBuy: 'pending' is a broadcast sell that has not
    // confirmed. A retry must not read it as a failure — the bag may
    // already be gone — nor drop it from the run's accounting.
    return { ok: res.ok, message: res.message, signature: res.signature ?? null, stage: res.stage ?? null };
  }



  /** Say something on the desktop that did not originate there — a trade
   *  asked for from a paired chat, for instance. The user should never learn
   *  about a trade from their phone alone. */
  announce(level: 'info' | 'warn' | 'error', line: string): void {
    this.log(level, line);
    this.emit({ kind: 'toast', level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message: line });
    this.notify('Krypto Bot', line);
  }


  /** Read every wallet's SOL balance (public RPC, parallel) and note it in
   *  the store so the Lab pages can show what each wallet holds. */
  async refreshAllBalances(): Promise<number> {
    const url = this.getSettings().rpc.httpUrl;
    const list = wallet.list();
    if (!list.length) return 0;
    // ONE getMultipleAccounts for every wallet (lamports ride in the reply)
    // instead of one getBalance each: twenty wallets was a twenty-call burst
    // against the public endpoint's 40-per-method window, and two clicks in
    // ten seconds 429'd (rate-limit swarm, 2026-09-06). A missing account
    // holds nothing, which is what getBalance said too.
    const r = await getMultipleAccountInfo(url, list.map((w) => w.publicKey));
    if (!r.ok || !r.data) return 0;
    let noted = 0;
    r.data.forEach((acc, i) => {
      const lamports = acc?.lamports ?? 0;
      wallet.noteBalance(list[i].publicKey, lamports);
      if (list[i].publicKey === wallet.publicKey()) this.walletBalanceLamports = lamports;
      noted++;
    });
    return noted;
  }

  // ── Trade-path helpers ─────────────────────────────────────────────

  /** Socket for signatureSubscribe confirmation: the primary PUBLIC socket.
   *  It answered a confirmed signature in 130 ms when measured; the Helius
   *  key is kept for the per-mint priority feed and the trade's HTTP calls,
   *  because a second keyed socket helped push the key into 429 territory
   *  (2026-09-03). */
  private confirmWssUrl(): string {
    return this.getSettings().rpc.wssUrl;
  }

  private prewarmTargets(): tradePrewarm.PrewarmTargets | null {
    if (!this.armed) return null;
    const s = this.getSettings();
    return {
      httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
      wssUrl: this.confirmWssUrl(),
      useJito: !!s.execution.useJito,
      useHeliusSender: !!s.execution.useHeliusSender,
      useRelayer: !s.execution.localTxBuild,
      refreshBalance: () => this.refreshWalletBalance(),
    };
  }

  /** One chain read of the trading wallet's SOL, shared with the wallet
   *  cache the trade panel reads and pushed in the next status. Runs at arm
   *  and on the 30 s prewarm heartbeat while armed, so the balance is known
   *  whether or not the scanner or the Wallet page is up. */
  private async refreshWalletBalance(): Promise<void> {
    const owner = wallet.publicKey();
    if (!owner) return;
    const s = this.getSettings();
    // A balance read is not execution-critical — the public endpoint, so the
    // keyed one keeps its rate budget for the trade itself.
    const bal = await getBalance(s.rpc.httpUrl, owner);
    if (!bal.ok || bal.data === undefined) return;
    this.walletBalanceLamports = bal.data;
    wallet.noteBalance(owner, bal.data);
    this.pushStatus();
  }

  /**
   * Priority fee for a trade. The constants that used to be hardcoded here
   * (0.001 SOL buys / 0.002 sells) stay as FLOORS, so nothing gets cheaper
   * than it was; on top of that the fee follows the live estimate
   * (refreshed every 8 s, scoped to pump's writable accounts) at the user's
   * urgency — sells one notch higher — so a fee-market spike escalates the
   * price instead of leaving the tx queued behind everyone who paid it.
   */
  /**
   * An exit, fitted to the wallet.
   *
   * The base fee and the priority fee are charged when the transaction is
   * LOADED — before the swap can put SOL back — so a wallet that spent
   * almost everything on the buy could not afford to sell at all. Seen for
   * real on 2026-09-05: the sell asked for a 0.002 SOL priority fee against
   * a 0.00167 SOL balance and died with InsufficientFundsForFee every time.
   *
   * Tips are transfers appended after the swap, so proceeds normally pay
   * them, but a thin wallet drops them too: placement is worth nothing on a
   * trade that cannot go out.
   */
  /**
   * The speed extras an exit may pay for, budgeted against the balance that
   * will actually pay them.
   *
   * `balanceLamports` defaults to the ACTIVE wallet. A sell from another
   * wallet (the Wallet Lab) must pass that wallet's balance instead, or the
   * budget is computed against SOL the transaction cannot spend.
   */
  private exitParams(
    exec: import('@shared/types').ExecutionSettings,
    balanceLamports?: number | null,
  ): {
    priorityFeeSol: number;
    exec: import('@shared/types').ExecutionSettings;
    note: string | null;
  } {
    const wanted = this.priorityFeeSolFor('sell');
    const balance = balanceLamports === undefined ? this.walletBalanceLamports : balanceLamports;
    if (balance === null) return { priorityFeeSol: wanted, exec, note: null };
    const budget = planExitBudget(balance, Math.round(wanted * 1e9));
    if (budget.note) this.log('warn', `exit budget: ${budget.note}`);
    return {
      priorityFeeSol: budget.priorityLamports / 1e9,
      exec: budget.useTips ? exec : { ...exec, useJito: false, useHeliusSender: false },
      note: budget.note,
    };
  }

  /**
   * Place the active auto-sell template's orders for a position just opened.
   *
   * Deliberately quiet about failure modes that are not the user's problem:
   * no template selected does nothing, and an order the engine refuses (no
   * reference price yet, for instance) is logged rather than thrown, because
   * a failed stop must never take the buy's result with it. Anything already
   * armed for this mint is left alone — buying twice does not double the
   * ladder.
   */
  private armTemplateOrders(mint: string): void {
    const template = templateStore.active();
    if (!template) return;
    const symbol = this.tokens.get(mint)?.row.symbol ?? '';
    const existing = advOrders.all().filter((o) => o.mint === mint && (o.state === 'armed' || o.state === 'paused'));
    if (existing.length) {
      this.log('info', `auto-sell: ${mint.slice(0, 8)}… already has ${existing.length} armed order(s) — template not re-applied`);
      return;
    }
    const referencePriceSol = this.tokens.get(mint)?.row.priceSol ?? this.freshPriceSol(mint) ?? null;
    const requests = ordersForTemplate(template, mint, symbol);
    let placed = 0;
    const refused: string[] = [];
    for (const req of requests) {
      const r = advOrders.create(req, { referencePriceSol });
      if (r.ok) placed++;
      else refused.push(`${req.kind}: ${r.message}`);
    }
    if (placed) {
      this.log('info', `auto-sell: armed ${placed} order(s) on ${symbol || mint.slice(0, 8)}… from “${template.name}”`);
      this.emit({
        kind: 'toast',
        level: 'info',
        message: `Auto-sell armed on ${symbol || mint.slice(0, 6)}…: ${describeTemplate(template)}`,
      });
    }
    if (refused.length) {
      this.log('warn', `auto-sell: ${refused.length} order(s) could not be armed — ${refused.join('; ')}`);
      this.emit({
        kind: 'toast',
        level: 'warn',
        message: `Auto-sell could not arm ${refused.length} of ${requests.length} orders — see the Orders page`,
      });
    }
  }

  private priorityFeeSolFor(action: 'buy' | 'sell'): number {
    const floor = action === 'buy' ? 0.001 : 0.002;
    const est = this.feeEstimate;
    if (!est) return floor;
    const s = this.getSettings();
    const urgency = s.execution.feeUrgency ?? 'competitive';
    const bumped: import('@shared/types').FeeUrgency =
      action === 'sell'
        ? urgency === 'normal' ? 'competitive' : urgency === 'competitive' ? 'high' : 'emergency'
        : urgency;
    const microPerCu = feeEstimator.priceFor(est, bumped);
    const cu = Math.max(1, s.execution.computeUnitLimit || 120_000);
    const sol = (microPerCu * cu) / 1e6 / 1e9;
    if (!Number.isFinite(sol)) return floor;
    // Ceiling guards against a wild estimate — 0.01 SOL is already an
    // emergency-class fee.
    return Math.min(0.01, Math.max(floor, sol));
  }

  /** Once per (signature, state) — the processed hook and the final result
   *  can both report `landed`. */
  private fillEmitted = new Set<string>();
  private emitFill(mint: string, side: 'buy' | 'sell', signature: string, state: 'landed' | 'reconciled' | 'failed'): void {
    const key = `${signature}:${state}`;
    if (this.fillEmitted.has(key)) return;
    this.fillEmitted.add(key);
    if (this.fillEmitted.size > 2_000) {
      const oldest = this.fillEmitted.values().next().value;
      if (oldest !== undefined) this.fillEmitted.delete(oldest);
    }
    this.emit({ kind: 'fill', mint, side, signature, state });
  }

  /** Tape + chart tick for a trade on an OPEN mint (tape-subscribed). */
  private recordTapeTrade(ev: PumpTradeEvent, n: LogNotification): void {
    const priceSol = spotPriceSol(ev.virtualSolReserves, ev.virtualTokenReserves);
    tape.record(ev.mint, {
      at: n.receivedAt,
      wallet: ev.user,
      isBuy: ev.isBuy,
      sol: Number(ev.solAmount) / 1e9,
      tokens: Number(ev.tokenAmount) / 1e6,
      priceSol,
    });
    this.rememberPrice(ev.mint, priceSol);
    this.chartTicks.push(ev.mint, n.receivedAt, priceSol, Number(ev.solAmount) / 1e9, ev.isBuy);
  }

  // ── Position update throttle ───────────────────────────────────────
  // evaluate() reported EVERY pass — the 500 ms timer plus every decoded
  // trade of a held mint, with the whole events[] array each time — so a
  // position in a hot token pushed tens of IPC messages a second that the
  // renderer re-rendered on. Now: only when a rendered field moved, and at
  // most 4/s per position (the pending one flushes at the gap).
  private static readonly POS_EMIT_GAP_MS = 250;
  private posEmit = new Map<string, { at: number; sig: string; pending: PaperPosition | null; timer: NodeJS.Timeout | null }>();

  private static positionSig(p: PaperPosition): string {
    return `${p.state}|${p.currentPriceSol}|${p.pnlSol}|${p.peakPriceSol}|${p.remainingTokens}|${p.recoveredSol}|${p.events.length}`;
  }

  private emitPositionUpdate(p: PaperPosition): void {
    const sig = SniperEngine.positionSig(p);
    let st = this.posEmit.get(p.id);
    if (!st) {
      st = { at: 0, sig: '', pending: null, timer: null };
      this.posEmit.set(p.id, st);
    }
    if (st.sig === sig && !st.pending) return;
    st.pending = p; // the live object — the flush snapshots its CURRENT state
    if (st.timer) return;
    const wait = st.at + SniperEngine.POS_EMIT_GAP_MS - Date.now();
    if (wait <= 0) {
      this.flushPositionUpdate(p.id);
    } else {
      st.timer = setTimeout(() => {
        st!.timer = null;
        this.flushPositionUpdate(p.id);
      }, wait);
    }
  }

  private flushPositionUpdate(id: string): void {
    const st = this.posEmit.get(id);
    if (!st) return;
    const p = st.pending;
    st.pending = null;
    if (!p) return;
    st.at = Date.now();
    st.sig = SniperEngine.positionSig(p);
    this.emit({ kind: 'positionUpdate', position: { ...p } });
    if (p.state === 'closed') this.posEmit.delete(id);
  }

  arm(hasWallet: boolean): { ok: boolean; message: string } {
    if (!hasWallet) {
      this.disarm('no_wallet');
      return { ok: false, message: 'Generate and fund a trading wallet first' };
    }
    this.armed = true;
    this.armedAt = Date.now();
    // Re-arming is the deliberate human reset for a pipeline block — and for
    // the real-money breakers: the loss baseline is THIS wallet's balance
    // now, so maxLiveSessionLossSol measures this live session.
    this.liveBlockedReason = null;
    this.liveConsecutiveSendFails = 0;
    this.liveConsecutiveLosses = 0;
    this.sweptLamports = 0;
    this.liveBaselineLamports = this.walletBalanceLamports;
    this.liveBalanceAtLastSell = this.walletBalanceLamports;
    // Re-arming rebaselines the loss breakers on purpose (above). That also
    // zeroes what the session ledger shows, so the ledger is told why.
    this.liveSessionAt = Date.now();
    this.liveSessionWhy = 'live execution was armed';
    if (this.liveBaselineLamports === null) void this.captureLiveBaseline();
    this.log('warn', 'live trading ARMED — real transactions will be signed');
    recorder.record('armed', { available: LIVE_EXECUTION_AVAILABLE });
    // The top bar reads status.liveActive, and status is otherwise pushed only
    // by the scanner's 1s timer — with the scanner idle, a mode change would
    // never reach the UI (seen 2026-08-29: Paper highlighted while armed).
    this.pushStatus();
    // Open the sockets and fetch the constants a trade needs NOW, and keep
    // them warm while armed — see prewarm.ts. Fire-and-forget.
    tradePrewarm.start(() => this.prewarmTargets());
    return {
      ok: true,
      message: LIVE_EXECUTION_AVAILABLE
        ? 'Armed'
        : 'Armed — but live execution is not built yet, so nothing will be signed',
    };
  }

  /** Baseline for the live session-loss breaker when arm() had no balance
   *  yet (first arm after launch). Later polls only fill a null baseline. */
  private async captureLiveBaseline(): Promise<void> {
    const owner = wallet.publicKey();
    if (!owner) return;
    const bal = await getBalance(this.getSettings().rpc.httpUrl, owner);
    if (!bal.ok || bal.data === undefined || !this.armed) return;
    this.walletBalanceLamports = bal.data;
    wallet.noteBalance(owner, bal.data);
    if (this.liveBaselineLamports === null) {
      this.liveBaselineLamports = bal.data;
      this.liveBalanceAtLastSell = bal.data;
      this.log('info', `live PnL baseline set at ${(bal.data / 1e9).toFixed(4)} SOL`);
    }
  }

  disarm(reason: DisarmReason): { ok: boolean; message: string } {
    if (this.armed) {
      this.armed = false;
      this.lastDisarmReason = reason;
      tradePrewarm.stop();
      this.log('info', `live trading disarmed (${reason})`);
      recorder.record('disarmed', { reason });
      try {
        this.onDisarm?.(reason);
      } catch (e) {
        this.log('warn', `mode persist failed after disarm: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.pushStatus();
    }
    return { ok: true, message: `Disarmed (${reason})` };
  }

  executionSnapshot(): ExecutionSnapshot {
    const tf = jitoTips.current();
    return {
      feeEstimate: this.feeEstimate
        ? {
            p50: this.feeEstimate.p50,
            p75: this.feeEstimate.p75,
            p90: this.feeEstimate.p90,
            p95: this.feeEstimate.p95,
            source: this.feeEstimate.source,
          }
        : null,
      tipFloor: { p50Lamports: tf.p50Lamports, p75Lamports: tf.p75Lamports, p95Lamports: tf.p95Lamports, ok: tf.ok },
      recentPlans: this.shadowPlans,
    };
  }

  // ── Feed handling ─────────────────────────────────────────────────

  /** pump-amm capture + live decode.
   *
   *  The raw tape is still recorded verbatim — it remains the asset, and the
   *  other half of the capture work (persistent cross-day wallet ids) is not
   *  built yet, so nothing here may narrow what gets written.
   *
   *  On top of that we now decode: migrations give the pool→mint map (the
   *  swap events carry a pool, never a mint), and swaps on a known pool feed
   *  the strat lab so graduated positions can be marked at a real fill
   *  instead of sitting unresolved. See docs\amm-decoder-2026-07-25.md. */
  private onAmmLogs(n: LogNotification): void {
    const payloads: string[] = [];
    for (const l of n.logs) {
      if (l.startsWith('Program data: ')) payloads.push(l.slice(14));
    }
    // Prefer the CPI copy, never combine: a block-feed delivery already
    // carries the decoded inner events, and the same swap sits in the log.
    const inner = n.innerEvents?.length ? (n.innerEvents as AmmEvent[]).filter((e) => e.kind === 'amm_swap' || e.kind === 'amm_migration') : [];
    if (payloads.length === 0 && inner.length === 0) return;
    if (payloads.length > 0) recorder.record('tape_amm', { sig: n.signature, slot: n.slot, d: payloads });

    const sAmm = this.getSettings();
    // Previously this returned when both shadow modules were off. The
    // terminal tape needs AMM swaps regardless, so the gate now also asks
    // whether anything is subscribed.
    // ...and whether an armed order is waiting on a graduated token: those
    // evaluate below, and returning here would leave them to the 12 s poller
    // alone on a rail that moves in seconds.
    if (!sAmm.shadowStratLab && !sAmm.shadowMigration && tape.subscriptions().length === 0 && !advOrders.hasArmed()) return;
    const decoded: AmmEvent[] = inner;
    if (inner.length === 0) {
      for (const payload of payloads) {
        const { event, layoutError } = decodeAmmEventEx(payload);
        if (layoutError) this.ammLayoutErrors++;
        else if (event) decoded.push(event);
      }
    }
    for (const event of decoded) {
      if (event.kind === 'amm_migration') {
        this.rememberAmmPool(event.pool, event.mint);
        this.liveMigrations.note(event.mint, event.pool, event.solAmount, n.receivedAt);
        this.liveCurves.complete(event.mint);
        if (sAmm.shadowMigration) this.emitMigEvents(this.mig.onMigration(event.mint, event.pool, n.receivedAt));
        continue;
      }
      if (sAmm.shadowMigration) this.emitMigEvents(this.mig.onAmmSwap(event, n.receivedAt));
      const mint = this.ammPoolToMint.get(event.pool);
      if (mint === undefined) continue;
      // A graduated token keeps charting: the terminal tape follows the mint
      // onto PumpSwap via the pool map, which the token page seeds from the
      // pool DexScreener reports. Recorded FIRST, before the order
      // evaluation below, for the same reason as in onTrade (2026-09-20).
      if (tape.isSubscribed(mint)) {
        tape.record(mint, {
          at: n.receivedAt,
          wallet: event.user,
          isBuy: event.isBuy,
          sol: Number(event.quoteAmount) / 1e9,
          tokens: Number(event.baseAmount) / 1e6,
          priceSol: executedPriceSol(event),
        });
        this.chartTicks.push(mint, n.receivedAt, executedPriceSol(event), Number(event.quoteAmount) / 1e9, event.isBuy);
      }
      // Orders on a graduated token evaluate at feed rate here, the way
      // curve trades do in onTrade. The 12 s poller is the floor that always
      // covers them (see `curveFeedIsTicking`); this is the fast path for
      // the session that watched the token migrate, and it is what keeps a
      // trailing stop's peak honest across the seam. Fenced like onTrade's.
      try {
        const priceSol = executedPriceSol(event);
        if (Number.isFinite(priceSol) && priceSol > 0) {
          this.rememberPrice(mint, priceSol);
          advOrders.onTick({ mint, priceSol, mcapUsd: null });
          alerts.onTick({ mint, priceSol, curvePct: 100 });
          copyTrade.markToMarket(mint, priceSol);
        }
      } catch (err) {
        this.noteEvalError('orders/alerts/copy', mint, err);
      }
      if (!sAmm.shadowStratLab) continue;
      this.emitLabEvents(this.lab.onAmmTrade(mint, executedPriceSol(event), n.receivedAt));
    }
  }

  /** pool→mint, bounded. Only pools we saw migrate are tracked; a graduated
   *  position always has its migration in the same session, since the lab can
   *  only hold a mint it watched through the curve. */
  private ammPoolToMint = new Map<string, string>();
  private ammLayoutErrors = 0;

  private rememberAmmPool(pool: string, mint: string): void {
    if (this.ammPoolToMint.has(pool)) return;
    this.ammPoolToMint.set(pool, mint);
    while (this.ammPoolToMint.size > AMM_POOL_MAP_CAP) {
      const oldest = this.ammPoolToMint.keys().next().value;
      if (oldest === undefined) break;
      this.ammPoolToMint.delete(oldest);
    }
  }

  /**
   * Signature dedupe ACROSS FEEDS.
   *
   * Each FeedManager dedupes within its own pool, which was enough while
   * there was one pool. The priority feed (priorityFeed.ts) is a second
   * source carrying the same trades for held mints, deliberately arriving
   * ~150ms earlier — so without this, every one of those trades would be
   * counted twice: doubled volume, doubled buyer counts, and an exit rule
   * evaluated twice on one event.
   */
  /** signature → whether a delivery for it has decoded at least one trade.
   *  A second delivery passes only when the first decoded nothing and this
   *  one carries `innerEvents` (block feed / per-mint fill) — the day pump
   *  drops `emit!`, the log copy arrives first and empty, and the CPI copy
   *  ~200 ms later must not be thrown away as a duplicate. */
  private seenSignatures = new Map<string, boolean>();
  private seenOrder: string[] = [];

  // ── Feed-insurance watchdog (60 s window) ──
  /** Notifications whose logs show a pump Buy/Sell instruction. */
  private wdTradeIx = 0;
  /** ...of which nothing decoded to a trade (logs AND inner events). */
  private wdUndecoded = 0;
  private lastUndecodedPct: number | null = null;
  private emitDropped = false;
  private blockDelivering = false;
  private lastBlockEvents = 0;

  private onLogs(n: LogNotification): void {
    const hasInner = !!n.innerEvents?.length;
    // A per-mint priority notification is by construction for a HELD mint —
    // the only case the Helius fill is allowed to spend a credit on.
    const heldHint = n.provider === 'helius:priority';
    if (n.signature) {
      const prior = this.seenSignatures.get(n.signature);
      if (prior !== undefined) {
        if (prior || !hasInner) {
          // Dropped as a duplicate — but if the first copy decoded nothing
          // and this is the held mint's own socket, ask for the fill anyway.
          if (!prior && heldHint && !hasInner && logsMentionPumpTrade(n.logs)) priorityFeed.requestFill(n.signature);
          return;
        }
      } else {
        this.seenOrder.push(n.signature);
        if (this.seenOrder.length > 32_768) {
          const drop = this.seenOrder.splice(0, this.seenOrder.length - 32_768);
          for (const sig of drop) this.seenSignatures.delete(sig);
        }
      }
    }
    const decodeStart = Date.now();
    // Prefer CPI, never combine: during the double-emit transition a tx
    // carries the same trade in the log AND the inner instruction.
    let events: PumpEvent[];
    let layoutErrors = 0;
    if (hasInner) {
      events = (n.innerEvents as PumpEvent[]).filter((e) => e.kind === 'create' || e.kind === 'trade' || e.kind === 'complete');
    } else {
      const d = decodeLogsEx(n.logs);
      events = d.events;
      layoutErrors = d.layoutErrors;
    }
    const decodedTrade = events.some((e) => e.kind === 'trade');
    if (n.signature) this.seenSignatures.set(n.signature, decodedTrade);
    this.lastEventAt = n.receivedAt;
    if (layoutErrors > 0) this.trackDrift(layoutErrors, n.signature);
    if (!decodedTrade && logsMentionPumpTrade(n.logs)) {
      // A trade happened on chain and nothing decoded: the watchdog's unit.
      this.wdTradeIx += 1;
      this.wdUndecoded += 1;
      if (heldHint) priorityFeed.requestFill(n.signature);
    } else if (decodedTrade) {
      this.wdTradeIx += 1;
    }
    if (events.length === 0) return;
    this.eventTimes.push(n.receivedAt);
    // Latency accounting (research §1): local receive → decode finish.
    this.decodeLatencies.push(Date.now() - decodeStart + (Date.now() - n.receivedAt));
    if (this.decodeLatencies.length > 200) this.decodeLatencies.splice(0, 100);

    // Firehose: record the ENTIRE tape (every event of every token, all
    // wallets) regardless of whether we track/trade it. This is the raw data
    // for offline edge-mining — creators, buyers, sellers, price ticks.
    // The recorder decides what it wants: everything (firehose) or the first
    // 30 minutes of each launch (launch mode) — see launchRecorder.ts. Gating
    // on recordFirehose here starved launch mode of every tape_* row.
    if (recorder.wantsTape()) this.recordTape(events, n);

    const s = this.getSettings();
    const dipOn = s.shadowDipBuy;
    const labOn = s.shadowStratLab;
    const migOn = s.shadowMigration;
    for (const ev of events) {
      if (ev.kind === 'create') {
        if (dipOn || labOn) this.dipCreatedAt.set(ev.mint, n.receivedAt);
        if (labOn) {
          this.labCreator.set(ev.mint, ev.creator);
          if (this.labCreator.size > 20_000) {
            const oldest = this.labCreator.keys().next().value;
            if (oldest !== undefined) this.labCreator.delete(oldest);
          }
        }
        this.onCreate(ev, n);
      } else if (ev.kind === 'trade') {
        // Feed-health: every trade's reserve delta must match its SOL amount.
        // A mismatch means events between this one and the previous one for
        // this mint were dropped — the live version of the tape-analysis check.
        this.continuity.observe(ev.mint, ev.isBuy, ev.solAmount, ev.virtualSolReserves, n.slot);
        if (dipOn) this.observeDip(ev, n.receivedAt);
        if (labOn) this.observeLab(ev, n.receivedAt);
        // Migration shadow's lead clock: first tick at ≥95% curve progress.
        if (migOn) this.mig.onCurveTrade(ev.mint, ev.virtualSolReserves, n.receivedAt);
        this.onTrade(ev, n);
      } else if (ev.kind === 'complete') {
        // Graduations reach the lab too: held shadow positions migrate to the
        // AMM UNRESOLVED — never booked as curve-tick exits (swarm finding).
        if (labOn) this.emitLabEvents(this.lab.onComplete(ev.mint, n.receivedAt));
        this.onComplete(ev.mint);
      }
    }
  }

  /** Feed a trade to the shadow dip-buy detector and record any signal/exit.
   *  Purely observational — never opens a real or paper position. */
  private observeDip(ev: PumpTradeEvent, nowMs: number): void {
    const created = this.dipCreatedAt.get(ev.mint) ?? null;
    if (this.dipCreatedAt.size > 20_000) {
      // Bound the create-time map; the detector self-bounds its own state.
      const oldest = this.dipCreatedAt.keys().next().value;
      if (oldest !== undefined) this.dipCreatedAt.delete(oldest);
    }
    const out = this.dip.observe({
      mint: ev.mint,
      isBuy: ev.isBuy,
      vSol: ev.virtualSolReserves,
      vTok: ev.virtualTokenReserves,
      createdAtMs: created,
      nowMs,
    });
    for (const e of out) {
      recorder.record(e.kind === 'signal' ? 'dip_signal' : 'dip_exit', { mint: e.mint, ...e.detail });
    }
    // Per-exit console lines made the shadow research look like real losses
    // (2026-07-21 user report) — exits go to the recorder only; the console
    // gets a 5-minute rollup from shadowSummaryTick instead.
  }

  /** Feed a trade to the Strategy Lab (N tandem paper strategies) and record
   *  tagged signals/exits. Purely observational — never trades. */
  private observeLab(ev: PumpTradeEvent, nowMs: number): void {
    const out = this.lab.observe({
      mint: ev.mint,
      isBuy: ev.isBuy,
      user: ev.user,
      solLamports: ev.solAmount,
      vSol: ev.virtualSolReserves,
      vTok: ev.virtualTokenReserves,
      createdAtMs: this.dipCreatedAt.get(ev.mint) ?? null,
      creator: this.labCreator.get(ev.mint) ?? null,
      nowMs,
    });
    this.emitLabEvents(out);
  }

  private emitLabEvents(out: import('./stratLab').StratEvent[]): void {
    for (const e of out) {
      recorder.record(e.kind === 'signal' ? 'strat_signal' : 'strat_exit', { strat: e.strat, mint: e.mint, ...e.detail });
      if (e.kind === 'exit' && e.detail.reason === 'graduated') {
        // Graduations are rare and load-bearing (the probe exists for them).
        if (e.detail.resolved) {
          const pnl = e.detail.pnlSol as number;
          this.log(
            'info',
            `strat-lab [${e.strat}] held ${e.mint.slice(0, 8)} through GRADUATION — marked at AMM ` +
              `${pnl >= 0 ? '+' : ''}${pnl} SOL (${e.detail.markDelayMs}ms after migration)`,
          );
        } else {
          this.log('info', `strat-lab [${e.strat}] held ${e.mint.slice(0, 8)} through GRADUATION — unresolved, no AMM trade observed`);
        }
      }
    }
  }

  private emitMigEvents(out: import('./migShadow').MigEvent[]): void {
    for (const e of out) {
      recorder.record(e.kind === 'signal' ? 'mig_signal' : 'mig_exit', { mint: e.mint, ...e.detail });
    }
  }

  /** Every 5 minutes: one compact console line per shadow instrument instead
   *  of a line per exit. These are measurement tools expected to run at or
   *  below breakeven — the rollup keeps that visible without reading like
   *  real trading losses (the paper book's PnL lives on the dashboard). */
  private lastShadowSummaryAt = 0;
  private shadowSummaryTick(): void {
    const now = Date.now();
    // Cheap and must run on its own clock, not the summary's: give up on
    // migrated positions whose pool never traded, so they cannot sit open
    // forever holding a slot in the stats.
    this.emitLabEvents(this.lab.sweepMigrated(now));
    this.emitMigEvents(this.mig.sweep(now));
    if (now - this.lastShadowSummaryAt < 300_000) return;
    this.lastShadowSummaryAt = now;
    const parts: string[] = [];
    const d = this.dip.stats();
    if (d.trades > 0 || d.open > 0) parts.push(`dip ${d.trades}t ${d.pnlSol >= 0 ? '+' : ''}${d.pnlSol} SOL`);
    for (const s of this.lab.stats()) {
      if (s.trades === 0 && s.open === 0 && s.graduated === 0) continue;
      parts.push(`${s.key} ${s.trades}t ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol} SOL${s.graduated ? ` ${s.graduated}grad` : ''}${s.open ? ` ${s.open}open` : ''}`);
    }
    for (const m of this.mig.stats()) {
      if (m.fills === 0 && m.open === 0 && m.aborts === 0 && m.noFills === 0) continue;
      parts.push(`mig:${m.lane}@5SOL ${m.fills}t ${m.pnlSol >= 0 ? '+' : ''}${m.pnlSol} SOL ${m.aborts}cap${m.open ? ` ${m.open}open` : ''}`);
    }
    if (parts.length > 0) this.log('info', `shadow research (paper 0.05 SOL, not the dashboard PnL): ${parts.join(' | ')}`);
  }

  /** Once a minute: persist feed health to the recorder and alarm on
   *  sustained event loss. Corrupted flow features (from a lossy feed) are
   *  one of the ways the 2026-07 backtest edge turned out to be fake — this
   *  makes feed degradation loud instead of silent. */
  private feedHealthTick(): void {
    const now = Date.now();
    if (now - this.lastFeedHealthRecordAt < 60_000) return;
    this.lastFeedHealthRecordAt = now;
    const snap = this.continuity.snapshot();
    const sockets = this.feed?.getDetails() ?? [];
    this.insuranceWatchdog(sockets);
    recorder.record('feed_health', {
      checked: snap.checked,
      mismatched: snap.mismatched,
      lossPct: snap.lossPct,
      // Out-of-order arrivals, skipped rather than counted as loss. High
      // here with a low loss rate is the racing pool working.
      staleArrivals: snap.stale,
      sockets: sockets.map((s) => ({ host: s.host, state: s.state, events: s.events, wins: s.wins, fills: s.fills, blocks: s.blocks })),
      undecodedPct: this.lastUndecodedPct,
      emitDropped: this.emitDropped,
      fills: priorityFeed.fillStats(),
    });
    if (snap.lossPct !== null && snap.lossPct > 5 && snap.checked >= 500 && now - this.lastFeedLossWarnAt > 10 * 60_000) {
      this.lastFeedLossWarnAt = now;
      // Say what it affects and exactly what to do about it. The old wording
      // ("add a better WS endpoint in Settings") named no setting, no page
      // and no consequence, so users read it as an error they had caused and
      // opened tickets asking what it meant (2026-09-13). It is a data-
      // quality notice, not a fault: nothing about manual trading is broken.
      const rpc = this.getSettings().rpc;
      const fix = (rpc.heliusApiKey ?? '').trim()
        ? rpc.heliusFeedSocket
          ? 'Your Helius socket is already in the pool — this is public-endpoint loss on top of it and will pass.'
          : 'Settings → Solana RPC → turn on "Helius feed socket" to race your key’s socket alongside the free ones (paid-plan traffic — see the note there).'
        : 'Settings → Solana RPC → paste a free Helius API key, then turn on "Helius feed socket". Free public sockets drop events under load; a keyed one does not.';
      const msg =
        `feed losing ~${snap.lossPct}% of events (${snap.mismatched}/${snap.checked} continuity failures, 15m). ` +
        `Scanner flow numbers — buyers, net inflow, volume — read LOW while this lasts, so fewer launches pass their gates. ` +
        `Your wallet, orders and manual trades are unaffected. ${fix}`;
      this.log('warn', msg);
      this.emit({
        kind: 'toast',
        level: 'warn',
        message: `Feed degraded: ~${snap.lossPct}% event loss — scanner flow reads low. Trading is unaffected; see the Grimoire for the fix.`,
      });
    }
  }

  /**
   * Feed-insurance watchdog, once a minute. The unit is "a pump Buy/Sell
   * instruction ran and nothing decoded to a trade". Above 5% while the
   * block socket is delivering means pump dropped `emit!` and the block
   * path is carrying the feed — said ONCE, and once more if it flips back,
   * so the log does not fill with the same sentence every minute.
   */
  private insuranceWatchdog(sockets: ReturnType<FeedManager['getDetails']>): void {
    const blockEvents = sockets.filter((s) => s.kind === 'block').reduce((n, s) => n + s.events, 0);
    const blockLive = sockets.some((s) => s.kind === 'block' && s.state === 'live');
    this.blockDelivering = blockLive && blockEvents > this.lastBlockEvents;
    this.lastBlockEvents = blockEvents;
    const pct = this.wdTradeIx >= 20 ? Math.round((this.wdUndecoded / this.wdTradeIx) * 1000) / 10 : null;
    this.lastUndecodedPct = pct;
    this.wdTradeIx = 0;
    this.wdUndecoded = 0;
    const dropped = pct !== null && pct > 5 && this.blockDelivering;
    if (dropped && !this.emitDropped) {
      this.emitDropped = true;
      this.log('warn', `pump dropped emit! — block path active (${pct}% of Buy/Sell logs decoded no trade; block socket delivering ~200 ms behind)`);
      recorder.record('feed_insurance', { emitDropped: true, undecodedPct: pct });
    } else if (!dropped && this.emitDropped && pct !== null && pct <= 5) {
      this.emitDropped = false;
      this.log('info', `pump emit! logs decoding again (${pct}% undecoded) — log sockets primary`);
      recorder.record('feed_insurance', { emitDropped: false, undecodedPct: pct });
    }
  }

  /** Write every decoded event to the recorder as a raw tape entry. */
  private recordTape(events: ReturnType<typeof decodeLogsEx>['events'], n: LogNotification): void {
    for (const ev of events) {
      if (ev.kind === 'create') {
        recorder.record('tape_create', {
          mint: ev.mint, name: ev.name, symbol: ev.symbol, uri: ev.uri,
          creator: ev.creator, user: ev.user, bondingCurve: ev.bondingCurve,
          sig: n.signature, slot: n.slot, receivedAt: n.receivedAt,
        });
        // Social-link signal (research: 8.9–17.4x graduation lift). Resolved
        // off the hot path — fire-and-forget, recorded as its own tape row
        // keyed by mint so offline analysis can join it to outcomes.
        if (ev.uri) this.captureSocials(ev.mint, ev.uri);
      } else if (ev.kind === 'trade') {
        // Wallet Scout: every pump trade names its trader, so the leaderboard
        // is built from the feed the engine already decodes — no extra RPC,
        // and it works whether or not the token is one we are tracking.
        // The id lets a manual scan replaying these hours refuse the trades
        // this feed already recorded, instead of scoring them twice.
        scout.note('solana', ev.user, ev.mint, ev.isBuy, Number(ev.solAmount) / 1e9, Number(ev.tokenAmount) / 1e6, n.receivedAt, tradeId(n.signature, ev.mint, ev.user, ev.isBuy));
        recorder.record('tape_trade', {
          mint: ev.mint, user: ev.user, isBuy: ev.isBuy,
          sol: Number(ev.solAmount) / 1e9, tokens: Number(ev.tokenAmount) / 1e6,
          vSol: ev.virtualSolReserves.toString(), vTok: ev.virtualTokenReserves.toString(),
          price: spotPriceSol(ev.virtualSolReserves, ev.virtualTokenReserves),
          curvePct: curveProgressPct(ev.virtualSolReserves),
          isSmart: watchlist.has(ev.user),
          sig: n.signature, slot: n.slot, receivedAt: n.receivedAt,
        });
      } else if (ev.kind === 'complete') {
        recorder.record('tape_complete', { mint: ev.mint, user: ev.user, sig: n.signature, slot: n.slot, receivedAt: n.receivedAt });
      }
    }
  }

  /** Resolve a launch's off-chain socials and record them as a tape row.
   *  Fully async + fire-and-forget — the create path never waits on IPFS. */
  private captureSocials(mint: string, uri: string): void {
    void fetchSocials(uri)
      .then((s) => {
        if (!this.running) return;
        const tracked = this.tokens.get(mint);
        if (tracked) tracked.socials = s;
        recorder.record('tape_metadata', {
          mint,
          resolved: s.resolved,
          hasImage: s.hasImage,
          hasDescription: s.hasDescription,
          twitter: s.twitter,
          telegram: s.telegram,
          website: s.website,
          socialCount: s.socialCount,
          at: Date.now(),
        });
      })
      .catch(() => {
        /* fetchSocials never throws, but guard the promise chain regardless */
      });
  }

  /** Decoder-drift breaker: known events failing to parse means the
   *  program's event layout moved. Fail closed rather than guess. */
  private trackDrift(count: number, signature: string): void {
    const now = Date.now();
    this.layoutErrorTotal += count;
    for (let i = 0; i < count; i++) this.layoutErrorTimes.push(now);
    this.layoutErrorTimes = this.layoutErrorTimes.filter((t) => now - t < DRIFT_WINDOW_MS);
    this.log('warn', `layout parse failure in ${signature.slice(0, 12)}… (${this.layoutErrorTimes.length} in last minute)`);
    if (this.layoutErrorTimes.length >= DRIFT_LIMIT && !this.hardPauseReason) {
      this.hardPauseReason = 'Event layout drift detected — decoder must be re-verified';
      this.disarm('decoder_drift');
      this.log('error', 'decoder drift breaker tripped — entries paused, recording continues');
      this.emit({ kind: 'toast', level: 'error', message: 'Pump event layout changed — new entries paused (fail closed)' });
      recorder.record('decoder_drift', { recentErrors: this.layoutErrorTimes.length });
    }
  }

  private onCreate(ev: PumpCreateEvent, n: LogNotification): void {
    if (this.tokens.has(ev.mint)) return;
    const s = this.getSettings();
    // Curve variant, free off the create event's reserves — a mayhem coin
    // starts at hundreds of virtual SOL rather than the standard 30. Refused
    // BEFORE anything is tracked: a launch the user does not want to see
    // should not take a slot, a mint check, an eval window or a scorer pass.
    // 'all' is the default and this is then never reached.
    const isMayhem = mayhemFromReserves(ev.virtualSolReserves);
    if (!passesMayhemFilter(isMayhem, s.strategy.mayhemFilter)) {
      this.counters.seen++;
      this.counters.filtered++;
      return;
    }
    this.counters.seen++;
    creators.recordLaunch(ev.creator);
    const rec = creators.get(ev.creator);
    const flags = staticChecks(ev, creators.blacklist());
    const row: LaunchRow = {
      mint: ev.mint,
      name: ev.name,
      symbol: ev.symbol,
      uri: ev.uri,
      creator: ev.creator,
      bondingCurve: ev.bondingCurve,
      signature: n.signature,
      slot: n.slot,
      detectedAt: n.receivedAt,
      phase: 'detected',
      riskFlags: flags,
      flow: emptyFlow(),
      score: null,
      priceSol: 0,
      priceHistory: [],
      reason: null,
      creatorPriorLaunches: rec.launches - 1, // minus the one we just recorded
      creatorPriorRugs: rec.dumps,
      smartBuyerCount: 0,
      smartEarly: false,
    };
    const t: TrackedToken = {
      row,
      createEvent: ev,
      trades: [],
      buyersBySol: new Map(),
      tokensByUser: new Map(),
      firstBuyAtByUser: new Map(),
      smartBuyers: new Set(),
      virtualSolReserves: ev.virtualSolReserves ?? INITIAL_VIRTUAL_SOL,
      virtualTokenReserves: ev.virtualTokenReserves ?? INITIAL_VIRTUAL_TOKENS,
      mintChecked: false,
      evalDeadline: n.receivedAt + s.strategy.evalWindowSec * 1_000,
      oddsTrades: [],
      oddsTapeTruncated: false,
      oddsJudged: 0,
      flagged: false,
      socials: null,
      decided: false,
      curveComplete: false,
      dumpRecorded: false,
      // Derived BELOW, and only for a launch that survived the static
      // checks. MEASURED 2026-09-15: three PDAs cost 922 µs — forty-eight
      // times a whole log decode — and it was being paid on the synchronous
      // create path for every launch on the firehose, including the ones
      // rejected on the very next line. A hard-rejected launch is never
      // traded, so it never needs an address.
      addr: null,
    };
    this.tokens.set(ev.mint, t);
    this.launchOrder.push(ev.mint);
    this.evictOld();
    recorder.record('create', {
      mint: ev.mint,
      name: ev.name,
      symbol: ev.symbol,
      creator: ev.creator,
      signature: n.signature,
      slot: n.slot,
      receivedAt: n.receivedAt,
    });

    if (hasHardReject(flags)) {
      this.reject(t, flags.filter((f) => f.hard).map((f) => f.label).join('; '));
    } else {
      t.addr = safePrewarm(ev.mint, ev.creator);
      this.updatePhase(t, 'evaluating');
      // Async mint safety check — lands inside the evaluation window.
      void checkMint(s.rpc.httpUrl, ev.mint).then((safety) => {
        const cur = this.tokens.get(ev.mint);
        if (!cur || cur.decided) return;
        cur.mintChecked = safety.checked;
        cur.row.riskFlags = [...cur.row.riskFlags, ...safety.flags];
        recorder.record('risk', { mint: ev.mint, checked: safety.checked, flags: safety.flags.map((f) => f.id) });
        if (hasHardReject(safety.flags)) {
          this.reject(cur, safety.flags.filter((f) => f.hard).map((f) => f.label).join('; '));
        } else {
          this.pushLaunch(cur);
        }
      });
    }
    this.emit({ kind: 'launch', launch: { ...row } });
  }

  private onTrade(ev: PumpTradeEvent, n: LogNotification): void {
    // Every trade, tracked or not: the reserves on the event are the curve's
    // progress and price, which is what the Graduating column ranks by.
    this.liveCurves.note(ev.mint, ev.virtualSolReserves, ev.virtualTokenReserves, ev.creator, n.receivedAt);
    // FOMO: a wallet some crowd config is listening for, on any mint — a
    // set lookup for everyone else (2026-09-20).
    if (copyTrade.crowdWants('solana', ev.user, n.receivedAt)) {
      copyTrade.noteCrowdTrade({
        wallet: ev.user,
        mint: ev.mint,
        symbol: this.tokens.get(ev.mint)?.row.symbol ?? market.summaryIfCached(ev.mint)?.symbol ?? '',
        isBuy: ev.isBuy,
        sol: Number(ev.solAmount) / 1e9,
        priceSol: spotPriceSol(ev.virtualSolReserves, ev.virtualTokenReserves),
        at: n.receivedAt,
        signature: n.signature,
        tradeAt: ev.timestamp > 0 ? ev.timestamp * 1_000 : null,
      });
    }
    const t = this.tokens.get(ev.mint);
    if (!t) {
      // A token the terminal has OPEN but this session never saw launch —
      // opened from Discover, or evicted past LAUNCH_LIST_CAP — still gets
      // its tape and chart ticks. Before this, only mints created during the
      // session ever ticked, i.e. most charts never moved.
      if (tape.isSubscribed(ev.mint)) this.recordTapeTrade(ev, n);
      return;
    }
    // Odds tape: the first ~130 s of every launch, bounded, regardless of
    // whether the flow window has decided — the runner judge reads it.
    if (n.receivedAt - t.row.detectedAt <= 130_000) {
      if (t.oddsTrades.length >= ODDS_TAPE_CAP) {
        // Past the cap the last-10-s trade rate would read 0 for exactly the
        // hottest launches (a 600-trade cap did that to 16 % of would-be
        // 120 s flags on 07-27). A truncated tape is an unknown, not a zero.
        t.oddsTapeTruncated = true;
      } else {
        t.oddsTrades.push({
          slot: n.slot,
          ts: n.receivedAt,
          user: ev.user,
          isBuy: ev.isBuy,
          base: Number(ev.tokenAmount) / 1e6,
          sol: Number(ev.solAmount) / 1e9,
          program: 'pump',
          tx: n.signature,
        });
      }
    }
    // Every event here is a trade that LANDED, which makes its mint a good
    // source of successful transactions for the local builder's account-layout
    // sampling. Cheap: an array unshift on a 12-slot ring.
    noteActiveMint(ev.mint, t.createEvent.creator);
    // Reserves + price always update (a held position marks off these even
    // after the token is decided).
    t.virtualSolReserves = ev.virtualSolReserves;
    t.virtualTokenReserves = ev.virtualTokenReserves;
    // The feed drops 13–21 % of events; if the `complete` event is one of
    // them, the token-side floor still says the curve is sold out. The
    // judge must never flag a finished curve, so mark it here; the full
    // completion handler still runs when (if) the event arrives.
    if (!t.curveComplete && t.virtualTokenReserves <= CURVE_COMPLETE_VIRTUAL_TOKENS) {
      t.curveComplete = true;
      this.log('info', `${t.row.symbol || t.row.mint.slice(0, 6)}: curve sold out (token floor reached before any complete event)`);
    }
    const held = this.positions.hasOpenFor(ev.mint);

    // Terminal tape FIRST (2026-09-20). The chart and the trades list must
    // never depend on what the order, alert and copy evaluation below does:
    // it used to run after them, so a throw or a stall in that evaluation
    // skipped this record on every trade of the mint — a chart frozen for
    // exactly the token that had an order on it (user report). Runs before
    // the decided/unheld fast-path return below too, because the token page
    // is usually open on a mint the strategy already passed on — that is the
    // whole point of a terminal. Gated on an explicit subscription (a Set
    // lookup) so the firehose costs nothing when nobody is looking.
    if (tape.isSubscribed(ev.mint)) this.recordTapeTrade(ev, n);

    // Advanced orders evaluate on EVERY trade of a mint we are tracking, at
    // full feed rate — ahead of the decided/unheld fast-path below, because
    // a stop loss on a token the strategy passed on must still fire. The
    // creator-sell flag is read from the token's flow state, which onTrade
    // sets further down; using the pre-update value here is deliberate, so
    // an order sees the same event the flow does rather than one tick late.
    // Fenced: whatever goes wrong in here is logged (once a minute per mint)
    // and the trade handler carries on — the tape above is already recorded.
    try {
      const priceSol = spotPriceSol(ev.virtualSolReserves, ev.virtualTokenReserves);
      this.rememberPrice(ev.mint, priceSol);
      // The order poller skips mints this feed is already ticking. It has to
      // know that for a fact, not by assuming a tracked mint is a live one —
      // see `curveFeedIsTicking`.
      this.lastCurveTickAt.set(ev.mint, Date.now());
      const creatorSold = !ev.isBuy && ev.user === t.createEvent.creator;
      advOrders.onTick({
        mint: ev.mint,
        priceSol,
        mcapUsd: null, // curve tokens: no reliable USD supply basis in the hot path
        creatorSold,
      });
      alerts.onTick({
        mint: ev.mint,
        symbol: t.row.symbol,
        priceSol,
        curvePct: curveProgressPct(ev.virtualSolReserves),
        devSold: creatorSold,
      });
      copyTrade.markToMarket(ev.mint, priceSol);
      // Copy trading needs BOTH sides from a followed wallet — the
      // smart-money block further down only fires on first buys.
      if (copyTrade.activeWallets().has(ev.user)) {
        // The wallet watcher delivers this same trade a moment later from
        // the leader's own subscription; the signature dedupes the pair.
        copyTrade.onWalletTrade({
          wallet: ev.user,
          mint: ev.mint,
          symbol: t.row.symbol,
          isBuy: ev.isBuy,
          sol: Number(ev.solAmount) / 1e9,
          priceSol,
          // The token count the log DOES carry. `soldFraction` is still
          // unknown on this rail (a log has no pre-balance), but with the
          // count copyTrade can recover the fraction from one balance read
          // instead of waiting for the wallet watcher's getTransaction —
          // which always loses this race. On an exit that wait is the whole
          // cost (user report, 2026-09-13).
          tokens: Number(ev.tokenAmount) / 1e6,
          at: n.receivedAt,
          // The pump event carries the chain's own clock for the trade, so
          // this rail dates itself with no extra read at all. It was the last
          // one that could not, which left it the one path a stale delivery
          // could still enter on (2026-09-15).
          tradeAt: chainTimeMs(ev.timestamp),
          signature: n.signature,
        });
      }
    } catch (err) {
      this.noteEvalError('orders/alerts/copy', ev.mint, err);
    }

    // Smart-money signal runs even for decided/unheld tokens (a watched wallet
    // buying a launch we passed on is exactly the correlation we want). Just a
    // Set lookup — cheap enough for the trade firehose.
    if (ev.isBuy && !t.smartBuyers.has(ev.user) && watchlist.has(ev.user)) {
      t.smartBuyers.add(ev.user);
      const ageMs = n.receivedAt - t.row.detectedAt;
      const early = ageMs <= this.getSettings().strategy.earlyBuyerWindowMs * 3;
      t.row.smartBuyerCount = t.smartBuyers.size;
      if (early) t.row.smartEarly = true;
      recorder.record('smart_buy', {
        mint: ev.mint, wallet: ev.user, label: watchlist.labelFor(ev.user),
        ageMs, early, sol: Number(ev.solAmount) / 1e9, curvePct: curveProgressPct(ev.virtualSolReserves),
        phase: t.row.phase,
      });
      this.log('info', `smart wallet ${watchlist.labelFor(ev.user) ?? ev.user.slice(0, 8)} bought ${t.row.symbol} (${(ageMs / 1000).toFixed(1)}s in)`);
      alerts.onWalletActivity({
        wallet: ev.user,
        label: watchlist.labelFor(ev.user),
        mint: ev.mint,
        symbol: t.row.symbol,
        isBuy: true,
        sol: Number(ev.solAmount) / 1e9,
        mcapUsd: null,
      });
      this.emit({ kind: 'toast', level: 'info', message: `Smart money in ${t.row.symbol} — ${watchlist.labelFor(ev.user) ?? ev.user.slice(0, 6)}` });
      this.pushLaunch(t);
    }

    // Speed: once a token is decided AND we hold no position in it, there is
    // nothing left to compute — skip flow, scoring, per-trade recording and
    // buffer growth entirely. This is the bulk of the trade firehose.
    // A creator sell is a runner gate (shared/runners.ts: "a creator sell
    // never flags"), and the odds judge runs at +60/+120 s — long after the
    // +15 s decision. So it is detected HERE, before the fast-path return,
    // or a post-decision dump is invisible to the gate (the 09-11 tape had
    // a creator sell inside the scoring window on 20 % of live flags).
    if (!ev.isBuy && ev.user === t.createEvent.creator && !t.row.flow.creatorSold) {
      t.row.flow.creatorSold = true;
      // (creators.recordDump stays below the fast path: a "dump" in the
      // creator record means a sell inside the evaluation or while held, and
      // widening it would silently re-score every repeat creator.)
      // A flag whose creator then sells keeps its row but says so. Decided
      // 60 s after the flag on curves still open (07-27): flags whose creator
      // had not sold graduated 22 %, those whose creator had 5 %.
      if (t.flagged) {
        const marked = markCreatorSold(this.runners, t.row.mint, n.receivedAt);
        if (marked) {
          this.runners = marked;
          const flag = marked.find((r) => r.mint === t.row.mint);
          const afterS = flag ? Math.max(0, (n.receivedAt - flag.flaggedAt) / 1000) : null;
          this.log('info', `Runner ${t.row.symbol || t.row.mint.slice(0, 6)}: creator sold${afterS !== null ? ` ${afterS.toFixed(0)} s after the flag` : ''}`);
          recorder.record('runner_creator_sold', { mint: t.row.mint, at: n.receivedAt, afterS });
          this.emit({ kind: 'runners', runners: marked });
        }
      }
    }
    // Once the strategy has decided a launch (the evaluation window is 15 s
    // by default) its trades used to stop being read unless a position held
    // it: no flow, no score, no launchUpdate. Runner flags come at +60 s and
    // +120 s, so a script that subscribed to a flagged runner got price ticks
    // from the tape and never another launch update (user report,
    // 2026-09-20: "40 tick events, zero launchUpdate"). A launch stays fully
    // tracked while anyone still needs its metrics: a held position, a
    // runner flag inside its 15 min, or a tape subscription — the terminal
    // chart or a script's bot.subscribe/bot.watch. Bounded by those three
    // sets, so the firehose still costs one price write for everything else.
    const kept = held || this.runnerFlagged(ev.mint, n.receivedAt) || tape.isSubscribed(ev.mint);
    if (t.decided && !kept) {
      t.row.priceSol = spotPriceSol(t.virtualSolReserves, t.virtualTokenReserves);
      return;
    }

    const sol = Number(ev.solAmount) / 1e9;
    const tokens = Number(ev.tokenAmount) / 1e6;
    t.trades.push({ at: n.receivedAt, user: ev.user, isBuy: ev.isBuy, sol, tokens });
    // Trim the rolling window.
    const cutoff = n.receivedAt - TRADE_WINDOW_MS;
    while (t.trades.length > 0 && t.trades[0].at < cutoff && t.trades.length > 400) t.trades.shift();
    if (ev.isBuy) {
      t.buyersBySol.set(ev.user, (t.buyersBySol.get(ev.user) ?? 0) + sol);
      t.tokensByUser.set(ev.user, (t.tokensByUser.get(ev.user) ?? 0) + tokens);
      if (!t.firstBuyAtByUser.has(ev.user)) t.firstBuyAtByUser.set(ev.user, n.receivedAt);
    } else {
      t.tokensByUser.set(ev.user, (t.tokensByUser.get(ev.user) ?? 0) - tokens);
      if (ev.user === t.createEvent.creator && !t.dumpRecorded) {
        t.dumpRecorded = true;
        creators.recordDump(t.createEvent.creator);
      }
    }
    t.row.priceSol = spotPriceSol(t.virtualSolReserves, t.virtualTokenReserves);
    t.row.priceHistory.push(t.row.priceSol);
    if (t.row.priceHistory.length > 90) t.row.priceHistory.splice(0, t.row.priceHistory.length - 90);
    recorder.record('trade', {
      mint: ev.mint,
      user: ev.user,
      isBuy: ev.isBuy,
      sol,
      vSol: ev.virtualSolReserves.toString(),
      vTok: ev.virtualTokenReserves.toString(),
      // Explicit price + curve progress so the recording is a usable price
      // tick series without re-deriving from reserves.
      priceSol: t.row.priceSol,
      curvePct: curveProgressPct(ev.virtualSolReserves),
      receivedAt: n.receivedAt,
    });
    // Re-score + decide on every trade while evaluating; update positions
    // instantly when a held token trades.
    if (!t.decided) {
      this.refreshFlow(t);
      this.maybeDecide(t, n.receivedAt);
    } else {
      // Kept alive past the decision: the flow is re-read with the push so
      // the row a script or the Runners page sees carries current buyers,
      // inflow and curve progress, not the figures frozen at decision time.
      // The score stays what the decision computed.
      this.pushLaunchThrottled(t, true);
    }
    this.positions.onTradeFor(ev.mint);
  }

  private onComplete(mint: string): void {
    const t = this.tokens.get(mint);
    // Migration orders must fire even for a mint the tracker has already
    // dropped, so this runs before the early return.
    advOrders.onTick({
      mint,
      priceSol: t?.row.priceSol ?? this.lastKnownPriceSol.get(mint) ?? 0,
      mcapUsd: null,
      migrated: true,
    });
    alerts.onTick({ mint, symbol: t?.row.symbol, migrated: true, curvePct: 100 });
    this.liveCurves.complete(mint);
    if (!t) return;
    t.curveComplete = true;
    creators.recordCompletion(t.createEvent.creator);
    this.updatePhase(t, 'completed');
    recorder.record('complete', { mint });
    this.positions.onTradeFor(mint);
  }

  // ── Strategy: filtered early momentum (research §6, default) ──────

  private refreshFlow(t: TrackedToken): void {
    const now = Date.now();
    const windowStart = t.row.detectedAt;
    const trades = t.trades;
    const flow: LiveFlow = emptyFlow();
    flow.creatorSold = t.row.flow.creatorSold;
    let topBuyer = 0;
    let totalBuySol = 0;
    for (const [, solAmt] of t.buyersBySol) {
      totalBuySol += solAmt;
      if (solAmt > topBuyer) topBuyer = solAmt;
    }
    const half = windowStart + (Math.min(now, t.evalDeadline) - windowStart) / 2;
    const buyersFirstHalf = new Set<string>();
    const buyersSecondHalf = new Set<string>();
    const sellers = new Set<string>();
    for (const tr of trades) {
      if (tr.isBuy) {
        flow.buys++;
        flow.buyVolumeSol += tr.sol;
        if (tr.at <= half) buyersFirstHalf.add(tr.user);
        else buyersSecondHalf.add(tr.user);
      } else {
        flow.sells++;
        flow.sellVolumeSol += tr.sol;
        sellers.add(tr.user);
      }
    }
    flow.uniqueBuyers = t.buyersBySol.size;
    flow.netInflowSol = flow.buyVolumeSol - flow.sellVolumeSol;
    flow.buyerAcceleration =
      buyersFirstHalf.size > 0 ? buyersSecondHalf.size / buyersFirstHalf.size : buyersSecondHalf.size > 0 ? 2 : 0;
    flow.topBuyerShare = totalBuySol > 0 ? topBuyer / totalBuySol : 0;
    // SOL-side on purpose: the entry gates (entryCurveMin/MaxPct), the score's
    // timing band, user rules, alerts and the backtest history all read this
    // number on the SOL scale they were tuned on. The token-side share (the
    // real completion condition) is used by the odds judge and the runner
    // flag only, where it is labelled "supply sold".
    flow.curveProgressPct = curveProgressPct(t.virtualSolReserves);
    flow.distinctSellers = sellers.size;

    // Token-weighted concentration + early-buyer (bundle) share. Only positive
    // net balances count as "held"; the SOL-weighted top-buyer share proved
    // useless in the data, so we measure who actually holds the supply.
    const earlyCutoff = windowStart + this.getSettings().strategy.earlyBuyerWindowMs;
    let heldTotal = 0;
    let topHeld = 0;
    let earlyHeld = 0;
    for (const [user, bal] of t.tokensByUser) {
      if (bal <= 0) continue;
      heldTotal += bal;
      if (bal > topHeld) topHeld = bal;
      const firstAt = t.firstBuyAtByUser.get(user);
      if (firstAt !== undefined && firstAt <= earlyCutoff) earlyHeld += bal;
    }
    flow.topHolderTokenShare = heldTotal > 0 ? topHeld / heldTotal : 0;
    flow.earlyBuyerShare = heldTotal > 0 ? earlyHeld / heldTotal : 0;
    t.row.flow = flow;
  }

  private maybeDecide(t: TrackedToken, now: number): void {
    const s = this.getSettings().strategy;
    const f = t.row.flow;

    // Cheap hard rejects first — before the (relatively) expensive score.
    if (hasHardReject(t.row.riskFlags)) {
      this.reject(t, t.row.riskFlags.filter((ff) => ff.hard).map((ff) => ff.label).join('; '));
      return;
    }
    if (t.row.flow.creatorSold) {
      this.reject(t, 'Creator sold during evaluation');
      return;
    }

    // Data-driven gates (2026-07). These invert v1's momentum filters: the
    // recorded trades showed high buyers/inflow/acceleration marked LOSING
    // tops, and sells + late curve entry were the real loss signals. Cheap
    // boolean gates run first; the score is only computed once they pass or
    // the window has expired (speed: skip scoring the firehose of rejects).
    const passesGates =
      f.sells <= s.maxSellsInWindow &&
      f.sellVolumeSol <= s.maxSellVolumeSol &&
      f.uniqueBuyers >= s.minUniqueBuyers &&
      f.uniqueBuyers <= s.maxUniqueBuyers &&
      f.netInflowSol >= s.minNetInflowSol &&
      f.netInflowSol <= s.maxNetInflowSol &&
      f.curveProgressPct >= s.entryCurveMinPct &&
      f.curveProgressPct <= s.entryCurveMaxPct &&
      f.topBuyerShare <= s.maxTopBuyerShare &&
      f.topHolderTokenShare <= s.maxTopHolderShare &&
      f.earlyBuyerShare <= s.maxEarlyBuyerShare;

    const expired = now >= t.evalDeadline;
    if (!passesGates && !expired) {
      this.pushLaunchThrottled(t);
      return;
    }

    const score = computeScore({
      flags: t.row.riskFlags,
      mintChecked: t.mintChecked,
      creator: creators.get(t.createEvent.creator),
      flow: t.row.flow,
      hasUri: t.createEvent.uri.trim().length > 0,
      nameOk: t.createEvent.name.trim().length > 0 && t.createEvent.symbol.trim().length > 0,
      strategy: s,
    });
    t.row.score = score;

    const qualifies = passesGates && score.total >= s.minScore;

    if (qualifies) {
      // Circuit breakers + freshness gate — the one place entries happen.
      const pause = this.entriesPauseReason();
      if (pause) {
        t.decided = true;
        this.counters.evaluated++;
        this.counters.rejected++;
        t.row.reason = `Qualified, but entries paused: ${pause}`;
        recorder.record('decision', { mint: t.row.mint, action: 'blocked', reason: pause, score: score.total });
        this.updatePhase(t, 'rejected');
        return;
      }
      t.decided = true;
      this.counters.evaluated++;
      recorder.record('decision', { mint: t.row.mint, action: 'enter', score: score.total, flow: f, smartBuyers: t.row.smartBuyerCount, decidedAt: Date.now() });

      // Phase-2 discipline, live in shadow: every entry is an order intent
      // that must pass the policy gate before any fill. Exactly-once per
      // mint per session — the same pipeline the signer will sit behind.
      // Paper auto-entry is an opt-in research tool since 2026-09-02; the
      // scanner's output is the runner FLAG (judgeRunners), not a position.
      if (!s.paperEntries) {
        t.decided = true;
        this.counters.evaluated++;
        t.row.reason = 'Qualified — paper entries are off (Strategy → research). Runner alerts carry the signal.';
        recorder.record('decision', { mint: t.row.mint, action: 'qualified_no_entry', score: score.total, flow: f, decidedAt: Date.now() });
        this.updatePhase(t, t.flagged ? 'flagged' : 'stale');
        return;
      }
      const strat = this.getSettings().strategy;
      const quoteLamports = solToLamports(strat.positionSizeSol);
      const intent = orders.create(t.row.mint, t.row.symbol, quoteLamports, this.startedAt ?? 0);
      if (!intent) {
        this.counters.rejected++;
        t.row.reason = 'Duplicate intent for mint (exactly-once guard)';
        this.updatePhase(t, 'rejected');
        return;
      }
      const verdict = policy.validate({
        programId: PUMP_PROGRAM_ID,
        quoteMint: 'SOL',
        quoteLamports,
        dataAgeMs: Date.now() - this.lastEventAt,
        openPositions: this.positions.openCount(),
        maxOpenPositions: strat.maxOpenPositions,
        maxQuoteLamports: solToLamports(Math.max(strat.positionSizeSol, 10)),
      });
      if (!verdict.ok) {
        orders.transition(intent, 'policy_rejected', verdict.note);
        this.counters.rejected++;
        t.row.reason = `Policy rejected: ${verdict.note}`;
        this.updatePhase(t, 'rejected');
        return;
      }
      orders.transition(intent, 'policy_validated', verdict.note);
      orders.transition(intent, 'persisted');
      const pos = this.positions.open(t.row.mint, t.row.name, t.row.symbol);
      if (pos) {
        orders.transition(intent, 'filled_paper', `position ${pos.id}`);
        orders.transition(intent, 'reconciled');
        this.counters.entered++;
        this.buildShadowSend(t, quoteLamports);
        // No autonomous real buy — autoLiveActive() is permanently false
        // (manual execution only, 2026-08-16). Call retained so the shadow
        // send plan and its telemetry keep recording.
        this.autoLiveBuy(t.row.mint, t.row.symbol);
        this.updatePhase(t, 'entered');
        this.scheduleOrphanCheck(t);
      } else {
        orders.transition(intent, 'policy_rejected', 'position manager refused fill');
        this.counters.rejected++;
        t.row.reason = 'Qualified but position limit reached';
        this.updatePhase(t, 'rejected');
      }
      return;
    }

    // Window expired without qualifying.
    t.decided = true;
    this.counters.evaluated++;
    this.counters.rejected++;
    recorder.record('decision', { mint: t.row.mint, action: 'pass', score: score.total, flow: f, smartBuyers: t.row.smartBuyerCount, decidedAt: Date.now() });
    t.row.reason = this.explainPass(f, score.total, s);
    this.updatePhase(t, 'stale');
  }

  /** Explainable decisions (research §14): say exactly which gate failed. */
  private explainPass(f: LiveFlow, score: number, s: StrategySettings): string {
    const misses: string[] = [];
    if (f.sells > s.maxSellsInWindow) misses.push(`${f.sells} sells (max ${s.maxSellsInWindow})`);
    if (f.sellVolumeSol > s.maxSellVolumeSol) misses.push(`sell vol ${f.sellVolumeSol.toFixed(2)} SOL`);
    if (f.uniqueBuyers < s.minUniqueBuyers) misses.push(`buyers ${f.uniqueBuyers}/${s.minUniqueBuyers}`);
    if (f.uniqueBuyers > s.maxUniqueBuyers) misses.push(`too crowded (${f.uniqueBuyers} buyers)`);
    if (f.netInflowSol < s.minNetInflowSol) misses.push(`inflow ${f.netInflowSol.toFixed(2)} SOL low`);
    if (f.netInflowSol > s.maxNetInflowSol) misses.push(`inflow ${f.netInflowSol.toFixed(2)} SOL hot`);
    if (f.curveProgressPct < s.entryCurveMinPct) misses.push(`curve ${f.curveProgressPct.toFixed(1)}% early`);
    if (f.curveProgressPct > s.entryCurveMaxPct) misses.push(`curve ${f.curveProgressPct.toFixed(1)}% late`);
    if (f.topBuyerShare > s.maxTopBuyerShare) misses.push(`top buyer ${(f.topBuyerShare * 100).toFixed(0)}%`);
    if (f.topHolderTokenShare > s.maxTopHolderShare) misses.push(`top holder ${(f.topHolderTokenShare * 100).toFixed(0)}%`);
    if (f.earlyBuyerShare > s.maxEarlyBuyerShare) misses.push(`bundle ${(f.earlyBuyerShare * 100).toFixed(0)}%`);
    if (score < s.minScore) misses.push(`score ${score}/${s.minScore}`);
    return misses.length ? `Did not qualify: ${misses.join(', ')}` : 'Window expired';
  }

  /** Sweep tokens whose eval window expired without a qualifying trade. */
  private decideDue(): void {
    const now = Date.now();
    for (const t of this.tokens.values()) {
      if (!t.decided && now >= t.evalDeadline) {
        this.refreshFlow(t);
        this.maybeDecide(t, now);
      }
    }
    this.judgeRunners(now);
  }

  // ── Potential runners ─────────────────────────────────────────────
  //
  // The scanner's job since 2026-09-02. At +60 s and again at +120 s every
  // launch is scored with the graduation-odds model measured on 73,890
  // launches (shared/odds.ts); one in the top buckets, with no hard reject
  // and no creator sell, is FLAGGED: pushed to the renderer, a desktop
  // notification (and the paired chat bots) — never bought. See
  // shared/runners.ts for the verdict and the wording.
  private runners: RunnerFlag[] = [];

  /** Is this mint a runner flag still inside its 15 min? The list is short
   *  (a handful of flags an hour), so a scan beats keeping a second index. */
  private runnerFlagged(mint: string, now: number): boolean {
    for (const r of this.runners) if (r.mint === mint && now - r.flaggedAt < RUNNER_TTL_MS) return true;
    return false;
  }
  private runnerLimiter = new RunnerRateLimit();

  private judgeRunners(now: number): void {
    // Expire first: a flag older than the TTL is not a call any more, and
    // the scanner has usually stopped tracking that launch, so the row would
    // sit there with no live tape burying the flags that still matter.
    if (this.runners.length) {
      const kept = pruneRunners(this.runners, now);
      if (kept.length !== this.runners.length) {
        this.runners = kept;
        this.emit({ kind: 'runners', runners: kept });
      }
    }
    const cfg = this.getSettings().strategy.runnerAlerts;
    if (!cfg?.enabled) return;
    for (const t of this.tokens.values()) {
      if (t.flagged || t.curveComplete) continue;
      const age = now - t.row.detectedAt;
      const windowS: 60 | 120 | null = age >= 120_000 && t.oddsJudged < 120 ? 120 : age >= 60_000 && t.oddsJudged < 60 ? 60 : null;
      if (windowS === null) continue;
      t.oddsJudged = windowS;
      // A window the user turned off is not judged; the next one still is.
      if (!windowAllowed(cfg, windowS)) continue;
      if (t.oddsTrades.length < 3) continue;
      let report;
      try {
        const features = oddsFeaturesFromTrades(t.oddsTrades, {
          creator: t.createEvent.creator,
          supply: 1e9,
          curveProgress: curveProgressTokenPct(t.virtualTokenReserves) / 100,
          virtualSolReserves: Number(t.virtualSolReserves),
          virtualTokenReserves: Number(t.virtualTokenReserves),
          hasTwitter: t.socials && t.socials.resolved ? t.socials.twitter : null,
          createSlot: t.row.slot,
          windowS,
        });
        report = scoreOdds(features);
      } catch {
        continue;
      }
      const verdict = runnerVerdict(report, cfg, {
        hardRejected: hasHardReject(t.row.riskFlags),
        creatorSold: t.row.flow.creatorSold,
        alreadyFlagged: t.flagged,
        tapeTruncated: t.oddsTapeTruncated,
        nonSolQuote: t.virtualSolReserves === 0n,
        regime: report?.regime,
        // The user's own filters read the same facts the flag would carry.
        windowS,
        uniqueBuyers: t.row.flow.uniqueBuyers,
        netInflowSol: t.row.flow.netInflowSol,
        curvePct: curveProgressTokenPct(t.virtualTokenReserves),
        creatorPriorDumps: t.row.creatorPriorRugs,
      });
      if (!verdict.flag || !report?.graduate) continue;
      const flag: RunnerFlag = {
        mint: t.row.mint,
        name: t.row.name,
        symbol: t.row.symbol,
        creator: t.createEvent.creator,
        flaggedAt: now,
        windowS,
        bucket: report.graduate.bucket,
        observedPct: report.graduate.observedPct,
        basePct: report.graduate.basePct,
        n: report.graduate.n,
        line: report.graduate.line,
        mult3Line: report.mult3?.line ?? null,
        priceSol: t.row.priceSol,
        curvePct: curveProgressTokenPct(t.virtualTokenReserves),
        uniqueBuyers: t.row.flow.uniqueBuyers,
        netInflowSol: t.row.flow.netInflowSol,
        tradesSeen: report.tradesSeen,
        regime: report.regime,
        mayhem: mayhemFromReserves(t.createEvent.virtualSolReserves),
        creatorSoldAt: null,
      };
      t.flagged = true;
      this.runners.unshift(flag);
      if (this.runners.length > 50) this.runners.length = 50;
      recorder.record('runner', { mint: flag.mint, windowS, bucket: flag.bucket, observedPct: flag.observedPct, basePct: flag.basePct, curvePct: flag.curvePct, buyers: flag.uniqueBuyers, net: flag.netInflowSol, regime: flag.regime });
      if (t.row.phase !== 'entered') this.updatePhase(t, 'flagged');
      this.emit({ kind: 'runner', runner: flag });
      const { title, body } = runnerNotification(flag);
      this.log('info', `${title} — ${body}`);
      if (this.runnerLimiter.allow(now, cfg.maxPerHour)) {
        this.notify(title, body, { mint: flag.mint, chain: 'solana' });
        this.emit({ kind: 'toast', level: 'info', message: `${title} · ${flag.observedPct.toFixed(0)} % of this bucket graduated (base ${flag.basePct.toFixed(1)} %)` });
      }
    }
  }

  /**
   * A buy asked for by something that is not a hand on a button — a user
   * script, or an AI through the MCP connection.
   *
   * The ONLY entry point either of them has, and it goes nowhere special: it
   * routes to the same rails the app's own buttons use, so the fee, the
   * signer's outflow policy and the live breakers all apply exactly as they
   * do to a click. `mode` is the CALLER's paper/live, which is not always the
   * app's — a paper script on a live app must simulate.
   */
  async hostBuy(mint: string, sol: number, mode: 'paper' | 'live', chain?: ChainKind, ownCapSol?: number): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean }> {
    // Robinhood Chain / BNB go out on their own rail, the same one copy
    // trading uses. Routed BEFORE the Solana path on purpose: a caller on an
    // EVM chain whose buy fell through to `testTrade` would spend SOL on a
    // token address from another chain.
    if (chain && chain !== 'solana') {
      if (mode === 'paper') return this.evmPaperBuy(chain, mint, sol);
      if (!this.evmCopy) return { ok: false, message: 'EVM trading is not available in this build' };
      return this.evmCopy.buy(chain, mint, sol);
    }
    // Paper = the same simulation a paper buy by hand runs, booked into the
    // paper book from the simulated fill. Live = the real thing.
    const r = await this.testTrade(mint, sol, mode === 'paper', { ownCapSol });
    return { ok: r.ok, message: r.message, signature: r.signature, pending: r.stage === 'pending' };
  }

  /** The sell half of `hostBuy`. Same rule: the caller's mode, the app's rails. */
  async hostSell(mint: string, pct: number, mode: 'paper' | 'live', chain?: ChainKind): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean; realizedSol?: number | null }> {
    if (chain && chain !== 'solana') {
      if (mode === 'paper') return this.evmPaperSell(chain, mint, pct);
      if (!this.evmCopy) return { ok: false, message: 'EVM trading is not available in this build' };
      const r = await this.evmCopy.sell(chain, mint, pct);
      return { ok: r.ok, message: r.message, signature: r.signature, realizedSol: null };
    }
    if (mode === 'paper') {
      const pos = paperBook.get(mint);
      if (!pos) return { ok: false, message: 'no paper position in this token' };
      const priceSol = pos.decimalsKnown ? await this.paperFillPrice(mint) : null;
      const r = paperBook.sell(mint, pct, priceSol);
      recorder.record('paper_sell', { mint, pct, ok: r.ok, priceSol, proceedsSol: r.proceedsSol, realizedSol: r.realizedSol, note: r.message.slice(0, 220), by: 'script' });
      if (r.ok) this.emit({ kind: 'paper', mint, side: 'sell' });
      return { ok: r.ok, message: r.message, realizedSol: typeof r.realizedSol === 'number' ? r.realizedSol : null };
    }
    const r = await this.manualSell(mint, pct);
    return { ok: r.ok, message: r.message, signature: r.signature, pending: r.stage === 'pending', realizedSol: null };
  }

  /** A token's published links and what the app has read about them, for a
   *  caller that is not the Links panel. Cached facts only — no request. */
  linksFor(mint: string, chain?: ChainKind): ReturnType<typeof scriptLinksFromSummary> | null {
    if (chain && chain !== 'solana') return null;
    const s = market.summaryIfCached(mint);
    if (!s) return null;
    linkIntel.trigger(mint);
    return scriptLinksFromSummary('solana', s, this.xReuseFor(s.socials.twitter, mint), xStatsStore.get(mint), linkIntel.facts(mint), siteReadStore.get(mint));
  }

  runnersSnapshot(): RunnerFlag[] {
    // Never hand out a flag that has already expired, even if no tick has
    // run since (the engine may be stopped).
    this.runners = pruneRunners(this.runners, Date.now());
    return this.runners;
  }

  private reject(t: TrackedToken, reason: string): void {
    if (t.decided) return;
    t.decided = true;
    this.counters.evaluated++;
    this.counters.rejected++;
    t.row.reason = reason;
    recorder.record('decision', { mint: t.row.mint, action: 'reject', reason });
    this.updatePhase(t, 'rejected');
  }

  /**
   * Fork-awareness (wemissinshi §3): we act on `processed` events for
   * speed, but a processed tx can live on a dropped fork. After entry,
   * verify the launch signature is canonically visible; if it vanished,
   * the position is voided — a paper trade against a phantom launch is
   * not a real outcome and must not pollute PnL or strategy stats.
   */
  private scheduleOrphanCheck(t: TrackedToken): void {
    const signature = t.row.signature;
    const mint = t.row.mint;
    const timer = setTimeout(() => {
      this.orphanTimers.delete(timer);
      void (async () => {
        const s = this.getSettings();
        const r = await getSignatureStatuses(s.rpc.httpUrl, [signature]);
        if (!r.ok || !r.data) {
          this.log('warn', `orphan check for ${mint.slice(0, 8)}… inconclusive (${r.message})`);
          return; // RPC failure ≠ orphaned; never void on ambiguity
        }
        const st = r.data[0];
        if (st === null) {
          this.log('warn', `launch tx for ${mint.slice(0, 8)}… not found on canonical chain — voiding position`);
          recorder.record('orphaned', { mint, signature });
          this.positions.voidPosition(mint, `launch tx ${signature.slice(0, 12)}… never confirmed`);
        }
      })();
    }, ORPHAN_CHECK_DELAY_MS);
    this.orphanTimers.add(timer);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private marketFor(mint: string): TokenMarket | null {
    const t = this.tokens.get(mint);
    if (!t) return null;
    const now = Date.now();
    let recentBuy = 0;
    let recentSell = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i];
      if (now - tr.at > 5_000) break;
      if (tr.isBuy) recentBuy += tr.sol;
      else recentSell += tr.sol;
    }
    return {
      virtualSolReserves: t.virtualSolReserves,
      virtualTokenReserves: t.virtualTokenReserves,
      recentBuyVolSol: recentBuy,
      recentSellVolSol: recentSell,
      creatorSold: t.row.flow.creatorSold,
      curveComplete: t.curveComplete,
    };
  }

  private updatePhase(t: TrackedToken, phase: LaunchRow['phase']): void {
    t.row.phase = phase;
    this.pushLaunch(t);
  }

  private lastPush = new Map<string, number>();

  private pushLaunch(t: TrackedToken): void {
    this.lastPush.set(t.row.mint, Date.now());
    this.emit({ kind: 'launchUpdate', launch: { ...t.row, flow: { ...t.row.flow } } });
  }

  /** Trade streams are hot — cap UI updates per token at ~4/s. With
   *  `refresh`, the flow is recomputed just before a push that goes out. */
  private pushLaunchThrottled(t: TrackedToken, refresh = false): void {
    const last = this.lastPush.get(t.row.mint) ?? 0;
    if (Date.now() - last < 250) return;
    if (refresh) this.refreshFlow(t);
    this.pushLaunch(t);
  }

  /** mint -> when the pump curve feed last delivered a trade for it. */
  private lastCurveTickAt = new Map<string, number>();

  /** Is the curve feed carrying this mint right now? The rule — and why
   *  launch-list membership is not it — lives in feedHealth.ts, pure and
   *  pinned by test/feedhealth.test.mjs. */
  private curveFeedIsTicking(mint: string): boolean {
    const t = this.tokens.get(mint);
    return curveFeedIsTicking({
      tracked: t !== undefined,
      curveComplete: t?.curveComplete === true,
      lastTickAt: this.lastCurveTickAt.get(mint) ?? null,
      now: Date.now(),
    });
  }

  private evictOld(): void {
    while (this.launchOrder.length > LAUNCH_LIST_CAP) {
      const mint = this.launchOrder.shift()!;
      const t = this.tokens.get(mint);
      // Never evict a token backing an open position, nor a runner flag
      // still inside its window: a busy hour fills 300 launches in minutes,
      // and a flagged runner evicted here would lose its updates that way
      // instead (2026-09-20).
      if (t && (this.positions.hasOpenFor(mint) || this.runnerFlagged(mint, Date.now()))) {
        this.launchOrder.push(mint);
        if (this.launchOrder.length <= LAUNCH_LIST_CAP + 5) break;
        continue;
      }
      this.tokens.delete(mint);
      this.lastPush.delete(mint);
      this.lastCurveTickAt.delete(mint);
    }
  }

  /**
   * Bill the Helius socket and cut it off if the budget is spent.
   *
   * Measured 2026-08-24: the pump firehose delivers ~780,000 pushes an hour,
   * so a 1M-credit allowance is gone in about 1.3 hours. Leaving that to the
   * user to notice would mean noticing it on an invoice.
   */
  /**
   * Point the fast socket at exactly the mints we hold — no more, no less.
   *
   * Cheap to run every second: it is a set comparison over a handful of
   * mints, and subscribing/unsubscribing is one small frame each way.
   */
  private priorityTick(): void {
    // Held mints AND the ones open on screen (tape subscriptions, ≤8): the
    // fast socket is ~150 ms ahead of the public pool, which is exactly the
    // edge a chart the user is watching — and about to trade on — wants.
    const held = new Set([
      ...this.positions.all().filter((p) => p.state !== 'closed').map((p) => p.mint),
      ...tape.subscriptions(),
    ]);
    for (const mint of held) priorityFeed.watch(mint);
    for (const mint of priorityFeed.watchedMints()) {
      if (!held.has(mint)) priorityFeed.unwatch(mint);
    }
  }

  private creditTick(): void {
    const stats = this.feed?.getDetails() ?? [];
    heliusBudget.billFeed(stats.map((s) => ({ url: s.url, bytes: s.bytes })));
    // The priority feed is Helius when a key exists, and must be billed then —
    // it is cheap, not free, and a budget that ignored it would be a lie. On
    // the public fallback socket there is nothing to bill.
    if ((this.getSettings().rpc.heliusApiKey ?? '').trim()) {
      heliusBudget.billFeed([{ url: 'helius:priority', bytes: priorityFeed.byteCount() }]);
    }
    if (heliusBudget.shouldCutOff()) {
      const u = heliusBudget.current();
      this.log(
        'warn',
        `Helius credit budget spent (${u.used.toLocaleString()} of ${u.limit.toLocaleString()}) — feed socket disabled. Raise or clear the ceiling in Settings to continue.`,
      );
      // Persist the decision so a restart does not silently resume spending.
      this.disableHeliusFeed?.();
    }
    heliusBudget.flush();
  }

  /** Injected by the host so the engine does not import the settings store. */
  disableHeliusFeed: (() => void) | null = null;

  /** Re-push status to the renderer. The mode bit (execution.liveEnabled)
   *  lives in settings, outside the engine, and status.liveActive is armed
   *  AND that bit — so whoever flips the bit must announce afterwards, or
   *  the top bar keeps the value pushed by arm() a moment earlier (Paper
   *  shown while armed; seen 2026-08-29 after a breaker disarm + re-Live). */
  announceStatus(): void {
    this.pushStatus();
  }

  private pushStatus(): void {
    this.emit({ kind: 'status', status: this.status() });
  }

  private log(level: 'info' | 'warn' | 'error', line: string): void {
    this.emit({ kind: 'log', level, line, at: Date.now() });
  }
}

/** Prewarm PDAs without ever letting a bad pubkey crash the create path. */
function safePrewarm(mint: string, creator: string): PrewarmedAddresses | null {
  try {
    return prewarm(mint, creator);
  } catch {
    return null;
  }
}

function emptyFlow(): LiveFlow {
  return {
    uniqueBuyers: 0,
    buys: 0,
    sells: 0,
    buyVolumeSol: 0,
    sellVolumeSol: 0,
    netInflowSol: 0,
    buyerAcceleration: 0,
    topBuyerShare: 0,
    creatorSold: false,
    curveProgressPct: 0,
    distinctSellers: 0,
    topHolderTokenShare: 0,
    earlyBuyerShare: 0,
  };
}
