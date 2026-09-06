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
import { FeedManager, type LogNotification } from './feed';
import { ReserveContinuity } from './feedHealth';
import { DipShadow } from './dipShadow';
import { StratLab } from './stratLab';
import { MigShadow } from './migShadow';
import { decodeAmmEventEx, decodeCpiAmmEventData, executedPriceSol, PUMP_AMM_GLOBAL_CONFIG, type AmmEvent } from './ammDecoder';
import { fetchSocials } from './metadata';
import { decodeCpiEventData, decodeLogsEx, logsMentionPumpTrade, PUMP_PROGRAM_ID, type PumpCreateEvent, type PumpEvent, type PumpTradeEvent } from './pumpDecoder';
import { staticChecks, checkMint, hasHardReject } from './risk';
import { computeScore } from './scoring';
import { curveProgressPct, spotPriceSol, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS } from './curve';
import { oddsFeaturesFromTrades, scoreOdds } from '@shared/odds';
import type { LaunchTrade } from '@shared/launchintel';
import { runnerVerdict, runnerNotification, pruneRunners, RunnerRateLimit, type RunnerFlag } from '@shared/runners';
import { PositionManager, type TokenMarket } from './positions';
import { noteActiveMint } from './txBuilder';
import { getTokenBalanceForMint, getAccountInfo, getSignatureStatuses, getBalance, getTokenAccountsByOwner, getTokenSupply, setRpcFallback, isEndpointRejected } from './rpcClient';
import { solToLamports } from './curve';
import * as wallet from '../system/wallet';
import * as programWatch from './programWatch';
import { scanExtraDelayMs, detectedTamper, seized, seizeMessage } from '../system/integrityGuard';
import * as policy from './policy';
import * as orders from './orders';
import * as creators from './creators';
import * as watchlist from './watchlist';
import * as recorder from './recorder';
import * as feeEstimator from './feeEstimator';
import * as jitoTips from './jitoTips';
import * as tradePrewarm from './prewarm';
import * as randomLab from './randomLab';
import { between as labBetween, DEFAULT_FOLLOW, type FollowSettings } from '@shared/lab';
import { quoteSellLamports } from './jupiterRoute';
import { prewarm, type PrewarmedAddresses } from './addresses';
import * as tape from '../data/tape';
import * as market from '../data/market';
import * as advOrders from './advOrders';
import * as ledger from './ledger';
import * as paperBook from './paperBook';
import { PAPER_FILL_MODEL, paperToPosition, modelledPaperFill } from '@shared/paper';
import * as alerts from './alerts';
import * as copyTrade from './copyTrade';
import * as dbcWatcher from './dbcWatcher';
import * as launchLabWatcher from './launchLabWatcher';
import * as boopWatcher from './boopWatcher';
import * as heliusBudget from '../system/heliusBudget';
import * as priorityFeed from './priorityFeed';
import * as portfolio from './portfolio';
import { buildShadowPlan } from './sender';
import { shouldRetrySell, escalatedSellSlippagePct, nextConsecutiveLosses, liveBreakerReason } from '@shared/liveBreakers';
import { LEAN_EXIT_LAMPORTS, planBuySize, planExitBudget } from '@shared/exitBudget';
import { describeTemplate, ordersForTemplate } from '@shared/orderTemplates';
import * as templateStore from '../system/templateStore';
import type { DisarmReason, ExecutionSnapshot, LiveState, ShadowSendPlan } from '@shared/types';
import { DEFAULT_BLOCK_FEED_WSS_URL, LIVE_EXECUTION_AVAILABLE } from '@shared/types';

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
  /** Highest window already judged: 0, 60 or 120. */
  oddsJudged: 0 | 60 | 120;
  flagged: boolean;
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
const PROGRAM_CHECK_INTERVAL_MS = 10 * 60_000;

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
  private counters = { seen: 0, evaluated: 0, entered: 0, rejected: 0 };
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

  // ── Live chart ticks ────────────────────────────────────────────────
  // Per-mint throttle for `tick` events pushed to the renderer's chart. A
  // hot pump token trades 30×/s; the chart reads as live at 8 updates/s, so
  // within each 125 ms window volume is summed and the last price/side wins.
  // Gated on the tape subscription — the same "this mint is open" signal
  // that gates tape recording — so the firehose costs nothing otherwise.
  private static readonly CHART_TICK_GAP_MS = 125;
  private chartTicks = new Map<
    string,
    {
      lastEmitAt: number;
      pending: { time: number; priceSol: number; volSol: number; isBuy: boolean } | null;
      timer: NodeJS.Timeout | null;
    }
  >();

  /** Push a live trade to the renderer chart, throttled to ≤8/s per mint.
   *  `priceSol` is SOL per token; `volSol` is the SOL that changed hands. */
  private emitChartTick(mint: string, atMs: number, priceSol: number, volSol: number, isBuy: boolean): void {
    if (!tape.isSubscribed(mint)) return;
    if (!Number.isFinite(priceSol) || priceSol <= 0) return;
    let s = this.chartTicks.get(mint);
    if (!s) {
      // Drop state for mints no longer open before adding a new one, so the
      // map tracks the tape's small subscription budget rather than growing.
      if (this.chartTicks.size >= 16) {
        for (const [m, st] of this.chartTicks) {
          if (!tape.isSubscribed(m)) {
            if (st.timer) clearTimeout(st.timer);
            this.chartTicks.delete(m);
          }
        }
      }
      s = { lastEmitAt: 0, pending: null, timer: null };
      this.chartTicks.set(mint, s);
    }
    if (s.pending) {
      s.pending.time = Math.floor(atMs / 1000);
      s.pending.priceSol = priceSol;
      s.pending.volSol += volSol;
      s.pending.isBuy = isBuy;
    } else {
      s.pending = { time: Math.floor(atMs / 1000), priceSol, volSol, isBuy };
    }
    if (s.timer) return; // a flush is already scheduled and will carry this trade
    const wait = s.lastEmitAt + SniperEngine.CHART_TICK_GAP_MS - Date.now();
    if (wait <= 0) {
      this.flushChartTick(mint, s);
    } else {
      s.timer = setTimeout(() => {
        s.timer = null;
        this.flushChartTick(mint, s);
      }, wait);
    }
  }

  private flushChartTick(mint: string, s: { lastEmitAt: number; pending: { time: number; priceSol: number; volSol: number; isBuy: boolean } | null; timer: NodeJS.Timeout | null }): void {
    const p = s.pending;
    s.pending = null;
    s.lastEmitAt = Date.now();
    if (!p || !tape.isSubscribed(mint)) return;
    this.emit({ kind: 'tick', mint, time: p.time, priceSol: p.priceSol, volSol: p.volSol, isBuy: p.isBuy });
  }

  private clearChartTicks(): void {
    for (const s of this.chartTicks.values()) {
      if (s.timer) clearTimeout(s.timer);
    }
    this.chartTicks.clear();
  }

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
        return rpc.heliusHttpUrl && rpc.heliusHttpUrl !== rpc.httpUrl ? rpc.httpUrl : '';
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
      heliusHttpUrl: () => this.getSettings().rpc.heliusHttpUrl ?? '',
      commitment: () => this.getSettings().rpc.commitment,
      onLogs: (n) => {
        this.onLogs(n);
        // A per-mint subscription also carries the mint's PumpSwap trades.
        // While the scanner runs its own AMM socket delivers those; with it
        // stopped this is the only copy, so route it.
        if (!this.running && n.logs.some((l) => l.includes(PUMP_AMM_PROGRAM_ID))) this.onAmmLogs(n);
      },
      billHttp: (calls) => heliusBudget.billHttp(calls),
      log: (level, line) => this.log(level, line),
    });

    randomLab.attach({
      armed: () => this.armed && this.getSettings().execution.liveEnabled,
      config: (groupId) => wallet.groups().find((g) => g.id === groupId)?.lab ?? null,
      members: (groupId) => wallet.groups().find((g) => g.id === groupId)?.members ?? [],
      activePublicKey: () => wallet.publicKey(),
      balanceSol: async (publicKey) => {
        const r = await getBalance(this.getSettings().rpc.httpUrl, publicKey);
        return r.ok && r.data !== undefined ? r.data / 1e9 : null;
      },
      candidates: async (universe, minLiquidityUsd) => {
        try {
          const rows = await market.discover(universe, 40, '1h');
          return rows
            .filter((t) => (t.liquidityUsd ?? 0) >= minLiquidityUsd && !t.rug?.hide)
            .map((t) => ({ mint: t.mint, symbol: t.symbol }));
        } catch {
          return [];
        }
      },
      buy: (walletId, mint, sol) => this.labBuy(walletId, mint, sol),
      sell: (walletId, mint) => this.labSell(walletId, mint),
      realizedFor: (signatures) => ledger.cashDeltaFor(signatures),
      log: (level, line) => this.log(level, line),
      emit: (runs) => this.emit({ kind: 'lab', runs }),
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
        return rpc.heliusHttpUrl ?? rpc.httpUrl;
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
            const httpUrl = rpc.heliusHttpUrl ?? rpc.httpUrl;
            const info = await getAccountInfo(httpUrl, poolHint);
            if (!info.ok || !info.data) return;
            if (info.data.owner !== dbcWatcher.DBC_PROGRAM_ID) return; // not a DBC curve
            if (!tape.isSubscribed(mint)) return; // the page closed while we checked
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
    ledger.onSettled((f) => {
      if (f.side !== 'sell' || f.state !== 'reconciled') return;
      // Wallet Lab legs are owned by OTHER wallets; a warmer that loses fees
      // on purpose must never trip the active wallet's streak breaker.
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
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'orders', snapshot: this.ordersSnapshot() }),
    });
    alerts.attach({
      notify: (title, body) => this.notify(title, body),
      settings: () => this.getSettings().alerts,
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'alerts', alerts: alerts.all() }),
    });

    copyTrade.attach({
      buy: async (mint, sol) => {
        const r = await this.testTrade(mint, sol, false);
        return { ok: r.ok, message: r.message, signature: r.signature };
      },
      liveBlockedReason: () => this.executionBlockedReason(),
      priceSol: (mint) => this.tokens.get(mint)?.row.priceSol ?? this.lastKnownPriceSol.get(mint) ?? null,
      tokenFacts: async (mint) => {
        const t = this.tokens.get(mint);
        // Prefer our own live view; fall back to the market layer for mints
        // the launch feed never carried.
        if (t) {
          return {
            liquidityUsd: null,
            marketCapUsd: null,
            kryptScore: t.row.score?.total ?? null,
            isPumpfun: true,
          };
        }
        const sum = await market.summary(mint);
        return {
          liquidityUsd: sum.liquidityUsd,
          marketCapUsd: sum.marketCapUsd,
          kryptScore: sum.kryptScore,
          isPumpfun: sum.launchpad === 'pumpfun',
        };
      },
      log: (level, line) => this.log(level, line),
      toast: (level, message) => this.emit({ kind: 'toast', level, message }),
      changed: () => this.emit({ kind: 'copy', snapshot: copyTrade.snapshot() }),
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
        this.emitChartTick(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
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
        this.emitChartTick(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
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
        return rpc.heliusHttpUrl ?? rpc.httpUrl;
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
        this.emitChartTick(t.mint, t.at, t.priceSol, t.sol, t.isBuy);
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
      this.hardPauseReason = 'Pump program was redeployed — decoder must be re-verified';
      this.disarm('program_upgrade');
      this.log('error', `program watchdog: ${r.message} — entries paused, recording continues`);
      this.emit({ kind: 'toast', level: 'error', message: 'Pump program upgraded — new entries paused (fail closed)' });
      recorder.record('program_upgrade', { programId: PUMP_PROGRAM_ID, detail: r.message });
    } else if (!r.changed) {
      this.log('info', `program watchdog: ${r.message}`);
    }
  }

  stop(): { ok: boolean; message: string } {
    // DBC pool watches are independent of the launch scanner, but stopping
    // the engine should still release their sockets.
    dbcWatcher.stopAll();
    launchLabWatcher.stopAll();
    boopWatcher.stopAll();
    // The fast socket also carries the terminal's open-token tape, which is
    // not the scanner's to stop — release only the mints held for positions.
    for (const p of this.positions.all()) {
      if (!tape.isSubscribed(p.mint)) priorityFeed.unwatch(p.mint);
    }
    this.clearChartTicks();
    if (!this.running) return { ok: false, message: 'Engine is not running' };
    this.running = false;
    this.feed?.stop();
    this.ammFeed?.stop();
    this.ammFeed = null;
    this.feed = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.programCheckTimer) clearInterval(this.programCheckTimer);
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
      liveRealizedPnlSol:
        this.liveBaselineLamports !== null && this.walletBalanceLamports !== null
          ? Math.round((this.walletBalanceLamports + this.sweptLamports - this.liveBaselineLamports) / 1e3) / 1e6
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
    const feeUrl = this.autoLiveActive() ? (s.rpc.heliusHttpUrl ?? s.rpc.httpUrl) : s.rpc.httpUrl;
    const [fee] = await Promise.all([
      feeEstimator.estimate(feeUrl, scope),
      s.execution.useJito ? jitoTips.refresh() : Promise.resolve(jitoTips.current()),
    ]);
    this.feeEstimate = fee;

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
    opts: { manual?: boolean } = {},
  ): Promise<import('./liveSigner').LiveTradeResult> {
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
    let capped = opts.manual ? sol : Math.min(sol, s.execution.maxLiveSol);
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
    const httpUrl = s.rpc.heliusHttpUrl ?? s.rpc.httpUrl;
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
      slippagePct: s.execution.liveSlippagePct,
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
    // Wallet Lab: groups that FOLLOW the active wallet repeat a manual buy.
    if (opts.manual && !simulateOnly && res.ok) this.followManualTrade('buy', mint, capped);
    // Auto-sell template: arm the exit the user already decided on. These are
    // ordinary advanced orders — they appear on the Orders page and can be
    // cancelled — placed the moment there is a position to protect, rather
    // than typed out again per token.
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
        { httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl, owner: wallet.publicKey() },
      );
    }
    this.log(res.ok ? 'info' : 'warn', `live ${simulateOnly ? 'dry-run' : 'trade'} (${res.stage}): ${res.message}`);
    // PAPER: a successful dry run opens a paper position from the
    // simulation's own numbers (tokens the ATA would hold, SOL the wallet
    // would lose). Nothing is recorded in the ledger or the real portfolio.
    if (simulateOnly && res.ok && res.simulatedTokensReceived !== undefined && res.simulatedCostSol !== undefined) {
      const symbol = this.tokens.get(mint)?.row.symbol ?? '';
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
    return res;
  }

  /** Paper = the mode the top bar shows as Paper: not (armed AND liveEnabled).
   *  Matches the UI's `isLive` exactly so a button that says "Paper sell"
   *  can never reach the real signer. */
  private paperMode(): boolean {
    return !this.manualLiveActive();
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
    const symbol = this.tokens.get(mint)?.row.symbol ?? '';
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
    return {
      ok: true,
      stage: 'done',
      message: `Paper position opened — ${tokensText} for ${fill.costSol.toFixed(4)} SOL (modelled from the live price, fees included; the chain was not simulated because ${why})`,
    };
  }

  private async paperFillPrice(mint: string): Promise<number | null> {
    const own = this.tokens.get(mint)?.row.priceSol ?? this.lastKnownPriceSol.get(mint) ?? null;
    if (own !== null && own > 0) return own;
    try {
      const sum = await market.summary(mint);
      if (sum.priceSol !== null && sum.priceSol > 0) {
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
  async fanoutBuy(
    mint: string,
    walletIds: string[],
    sizing: { mode: 'same' | 'total'; amountSol: number; jitter?: number },
    opts: { staggerMaxMs?: number } = {},
  ): Promise<{ ok: boolean; message: string; results: Array<{ walletId: string; ok: boolean; stage: string; message: string; signature: string | null }> }> {
    const s = this.getSettings();
    if (!this.armed) return { ok: false, message: 'Arm the engine before a fan-out buy', results: [] };
    if (!s.execution.liveEnabled) return { ok: false, message: 'Enable live execution in settings first', results: [] };
    const breaker = this.liveBreakerReason();
    if (breaker) {
      this.updateLiveBreakers();
      return { ok: false, message: `Live buys paused — ${breaker}`, results: [] };
    }

    const { executeTrade } = await import('./liveSigner');
    const { planFanout } = await import('@shared/fanout');
    // Floor each buy at a sane minimum and cap the TOTAL at the live ceiling so
    // a fan-out can never spend more than a single trade is allowed to.
    const plan = planFanout(walletIds, { mode: sizing.mode, amountSol: sizing.amountSol, jitter: sizing.jitter, minSol: 0.002 });
    if (!plan.ok) return { ok: false, message: plan.message, results: [] };
    if (plan.totalLamports / 1e9 > s.execution.maxLiveSol) {
      return { ok: false, message: `Fan-out total ${(plan.totalLamports / 1e9).toFixed(3)} SOL exceeds the ${s.execution.maxLiveSol} SOL live cap`, results: [] };
    }

    const local = await this.localBuildParamsAsync(mint);
    const httpUrl = s.rpc.heliusHttpUrl ?? s.rpc.httpUrl;
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
      return { walletId, ok: res.ok, stage: res.stage, message: res.message, signature: res.signature ?? null };
    };

    const stagger = Math.max(0, Math.min(2000, opts.staggerMaxMs ?? 0));
    const results = await Promise.all(
      plan.shares.map(async (sh) => {
        // A small random delay per wallet so the buys do not all land in one
        // slot. Zero stagger = all at once.
        if (stagger > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * stagger)));
        return run(sh.wallet, sh.sol);
      }),
    );
    const landed = results.filter((r) => r.ok).length;
    // Pending = broadcast but unconfirmed; may still land. Counted apart so
    // nobody re-fires a fan-out over wallets that are about to be filled.
    const pending = results.filter((r) => !r.ok && r.stage === 'pending').length;
    recorder.record('fanout_buy', { mint, wallets: results.length, landed, pending, total: plan.totalLamports / 1e9 });
    this.log(landed === results.length ? 'info' : 'warn', `fan-out buy ${mint.slice(0, 8)}…: ${landed}/${results.length} landed${pending ? `, ${pending} pending` : ''}`);
    return { ok: landed > 0, message: `${landed}/${results.length} buys landed${pending ? `, ${pending} still pending` : ''}`, results };
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
        httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl,
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
        httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl,
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
          if (this.liveBalanceAtLastSell !== null) {
            if (bal.data < this.liveBalanceAtLastSell) this.liveConsecutiveLosses++;
            else this.liveConsecutiveLosses = 0;
          }
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
  }

  /** The page closed. A mint still held as a position stays on the socket. */
  unwatchPumpMint(mint: string): void {
    const held = this.positions.all().some((p) => p.state !== 'closed' && p.mint === mint);
    if (!held) priorityFeed.unwatch(mint);
  }

  dbcWatchedMints(): string[] {
    return dbcWatcher.watchedMints();
  }

  // ── Copy trading (term.txt §11) ──────────────────────────────────

  copySnapshot(): import('@shared/copytrade').CopySnapshot {
    return copyTrade.snapshot();
  }

  upsertCopyConfig(
    input: Omit<import('@shared/copytrade').CopyConfig, 'id' | 'createdAt'> & { id?: string },
  ): { ok: boolean; message: string } {
    return copyTrade.upsert(input);
  }

  removeCopyConfig(id: string): { ok: boolean; message: string } {
    return copyTrade.remove(id);
  }

  // ── Alerts (term.txt §17) ────────────────────────────────────────

  /** Desktop notification. Injected by main so the engine stays testable. */
  private notifier: ((title: string, body: string) => void) | null = null;

  setNotifier(fn: (title: string, body: string) => void): void {
    this.notifier = fn;
  }

  private notify(title: string, body: string): void {
    if (!this.getSettings().alerts.desktopNotifications) return;
    this.notifier?.(title, body);
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
  async portfolioSummary(): Promise<import('@shared/portfolio').PortfolioSummary> {
    const s = this.getSettings();
    const httpUrl = s.rpc.heliusHttpUrl ?? s.rpc.httpUrl;

    // Opportunistically retry fills whose reconciliation failed earlier —
    // usually the RPC was rate-limited at the moment the trade landed.
    void ledger.reconcilePending(httpUrl, wallet.publicKey()).catch(() => undefined);

    const held = await this.holdings();
    const holdings = held.ok && held.data ? held.data : [];
    // Liquidation quotes run alongside the price lookups below.
    const liquidationP = this.liquidationQuotes(holdings);

    const prices = new Map<string, {
      priceSol: number | null; priceUsd: number | null; marketCapUsd: number | null;
      name: string; symbol: string; imageUrl: string | null; circSupply: number | null;
    }>();
    // Price every mint we hold OR have ever traded, so closed rows can still
    // name their token. Capped so a large history cannot stall the page.
    const paperOpen = paperBook.list();
    const wanted = new Set<string>([
      ...holdings.map((h) => h.mint),
      ...ledger.basisByMint(wallet.publicKey()).keys(),
      ...paperOpen.map((p) => p.mint),
    ]);
    const decimalsOf = new Map<string, number>();
    // Six at a time: sequential lookups made the position tile lag the
    // "Landed" toast by the sum of every held mint's summary; the per-host
    // gate in http.ts still spaces the actual provider calls.
    const mints = [...wanted].slice(0, 60);
    const CONCURRENCY = 6;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, mints.length) }, async (_, lane) => {
        for (let i = lane; i < mints.length; i += CONCURRENCY) {
          const mint = mints[i];
          try {
            const sum = await market.summary(mint);
            prices.set(mint, {
              priceSol: sum.priceSol, priceUsd: sum.priceUsd, marketCapUsd: sum.marketCapUsd,
              name: sum.name, symbol: sum.symbol, imageUrl: sum.imageUrl, circSupply: sum.circSupply,
            });
            decimalsOf.set(mint, sum.decimals);
          } catch {
            /* an unpriced mint shows as unpriced, which the summary warns about */
          }
        }
      }),
    );

    let solUsd: number | null = null;
    try {
      const wsol = await market.summary('So11111111111111111111111111111111111111112');
      solUsd = wsol.priceUsd;
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
    out.paper = {
      positions: paperOpen.map((p) => {
        const px = prices.get(p.mint);
        return paperToPosition(p, px ? { ...px, decimals: decimalsOf.get(p.mint) ?? 6 } : undefined, solUsd);
      }),
      realizedPnlSol: paperBook.realized(),
      closed: paperBook.closed(),
      model: PAPER_FILL_MODEL,
    };
    return out;
  }

  /**
   * What each holding would fetch if sold now — a Jupiter sell quote of the
   * whole balance, six at a time, each bounded to 2.5 s so a slow quote can
   * never hold the position panel. A mint that does not quote simply falls
   * back to spot × amount in build(), labelled as such.
   */
  private async liquidationQuotes(holdings: WalletHolding[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const targets = holdings.filter((h) => {
      try {
        return BigInt(h.amountRaw) > 0n;
      } catch {
        return false;
      }
    });
    const CONCURRENCY = 6;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async (_, lane) => {
        for (let i = lane; i < targets.length; i += CONCURRENCY) {
          const h = targets[i];
          try {
            const q = await Promise.race([
              quoteSellLamports(h.mint, BigInt(h.amountRaw)),
              new Promise<null>((r) => setTimeout(() => r(null), 2_500)),
            ]);
            if (q) out.set(h.mint, q.lamports);
          } catch {
            /* no quote → spot fallback */
          }
        }
      }),
    );
    return out;
  }

  tradeHistory(): import('@shared/portfolio').TradeHistoryRow[] {
    return portfolio.history();
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
   * Anchor a percentage order to the best price available, in the same
   * priority order the evaluator will use:
   *
   *   1. our own live tape (what the order is actually judged against);
   *   2. the last price this session observed for the mint;
   *   3. the market layer — the SAME number the token page is showing.
   *
   * Step 3 matters: without it the engine refused to anchor orders on any
   * token it had not personally watched launch, while the UI was displaying
   * a perfectly good price two inches away. Async for that reason.
   */
  async createOrder(req: import('@shared/orders').NewOrderRequest): Promise<{ ok: boolean; message: string }> {
    const tracked = this.tokens.get(req.mint);
    let referencePriceSol = tracked?.row.priceSol ?? this.lastKnownPriceSol.get(req.mint) ?? null;
    if (!(referencePriceSol !== null && referencePriceSol > 0)) {
      try {
        const sum = await market.summary(req.mint);
        if (sum.priceSol !== null && sum.priceSol > 0) {
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

  private startOrdersPoll(): void {
    if (this.ordersPollTimer) return;
    const tick = async (): Promise<void> => {
      // Orders AND alerts share this loop — both need prices for mints the
      // launch feed never carries (anything migrated, or everything when the
      // scanner is stopped).
      const mints = [...new Set([...advOrders.armedMints(), ...alerts.armedMints()])];
      if (!mints.length) return;
      for (const mint of mints) {
        // Mints on our own tape are already ticked by onTrade at full rate.
        if (this.tokens.has(mint)) continue;
        try {
          const sum = await market.summary(mint);
          if (sum.priceSol !== null && sum.priceSol > 0) {
            this.rememberPrice(mint, sum.priceSol);
            advOrders.onTick({ mint, priceSol: sum.priceSol, mcapUsd: sum.marketCapUsd });
          }
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
        } catch {
          /* a provider being down must not stop the loop for other mints */
        }
      }
    };
    void tick();
    this.ordersPollTimer = setInterval(() => void tick(), 12_000);
  }

  /**
   * Sell a held mint. `percent` defaults to the whole position.
   *
   * PARTIAL SELLS GO THROUGH THE RELAYER, ALWAYS. `txBuilder.buildLocalTrade`
   * hardcodes sells to the full token-account balance (`txBuilder.ts:346`,
   * `:398`) and closes the ATA afterwards to reclaim rent. Handing it a
   * partial request would silently sell 100% — the single worst way to get
   * this wrong, because the user would see a "sold 25%" toast over an empty
   * bag. So anything under 100% never offers the local path, and pays the
   * relayer's 0.5% instead. That cost is stated in the trade panel.
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
      const balP = getTokenBalanceForMint(s.rpc.heliusHttpUrl ?? s.rpc.httpUrl, owner, mint);
      let priceSol: number | null =
        this.tokens.get(mint)?.row.priceSol ?? this.freshPriceSol(mint) ?? tape.lastPriceSol(mint) ?? null;
      if (priceSol === null || priceSol <= 0) {
        priceSol = await Promise.race([
          market.summary(mint).then((sum) => sum.priceSol).catch(() => null),
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

  async manualSell(mint: string, percent = 100): Promise<import('./liveSigner').LiveTradeResult> {
    const s = this.getSettings();
    const pct = Math.max(1, Math.min(100, Math.round(percent)));
    // Paper mode sells from the paper book at the current price. A real
    // sell needs Live; the two never cross.
    if (this.paperMode()) return this.paperSell(mint, pct);
    if (!s.execution.liveEnabled) return { ok: false, stage: 'validate', message: 'Enable real broadcast before selling' };
    // Both lookups run concurrently; neither blocks the other.
    const localParams = pct >= 100 ? await this.localBuildParamsForSell(mint) : undefined;
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
      slippagePct: Math.max(s.execution.liveSlippagePct, 15),
      priorityFeeSol: exit.priorityFeeSol,
      httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl,
      simulateOnly: false,
      // Full sells get the local builder (ATA close, no relayer fee, and the
      // only route that builds on a bonding curve the relayer 400s on); the
      // relayer stays as fallback. Partials never get it — see above.
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
        { httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl, owner: wallet.publicKey() },
      );
    }
    this.log(res.ok ? 'info' : 'warn', `manual sell ${pct}% (${res.stage}): ${res.message}`);
    if (res.ok) this.followManualTrade('sell', mint, null, pct);
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
  async holdings(): Promise<{ ok: boolean; message: string; data?: WalletHolding[] }> {
    const owner = wallet.publicKey();
    if (!owner) return { ok: false, message: 'No trading wallet' };
    const s = this.getSettings();
    const r = await getTokenAccountsByOwner(s.rpc.heliusHttpUrl ?? s.rpc.httpUrl, owner);
    if (!r.ok || !r.data) return { ok: false, message: r.message };
    const data: WalletHolding[] = r.data
      .filter((h) => h.uiAmount > 0)
      .map((h) => ({ ...h, symbol: this.tokens.get(h.mint)?.row.symbol ?? null }));
    return { ok: true, message: 'ok', data };
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
      const sellable = h.data.filter((x) => x.mint !== SniperEngine.WSOL_MINT);
      if (sellable.length === 0) {
        this.log('info', `sell-all (${reason}): wallet holds no tokens`);
        return;
      }
      this.log('warn', `sell-all (${reason}): liquidating ${sellable.length} held token(s)`);
      this.emit({ kind: 'toast', level: 'warn', message: `Selling ${sellable.length} held token(s) — ${reason.replace(/_/g, ' ')}` });
      for (const tkn of sellable) {
        const label = tkn.symbol ?? `${tkn.mint.slice(0, 8)}…`;
        const e = this.getSettings();
        const res = await this.sellWithRetry({
          action: 'sell',
          mint: tkn.mint,
          amount: '100%',
          denominatedInSol: false,
          slippagePct: Math.max(e.execution.liveSlippagePct, 15),
          priorityFeeSol: this.priorityFeeSolFor('sell'),
          httpUrl: e.rpc.heliusHttpUrl ?? e.rpc.httpUrl,
          simulateOnly: false,
          local: await this.localBuildParamsForSell(tkn.mint),
          estProceedsLamports: this.estSellProceedsLamports(tkn.mint, 100).catch(() => undefined),
          exec: e.execution,
          wssUrl: this.confirmWssUrl(),
        });
        // A real exit that never reaches the ledger is invisible to cost
        // basis, realised PnL, trade history AND the live loss breakers —
        // the round trip simply vanishes. Record it exactly as the manual
        // sell path does.
        if ((res.ok || res.stage === 'pending') && res.signature) {
          ledger.recordFill(
            { mint: tkn.mint, symbol: tkn.symbol ?? '', side: 'sell', requested: 100, signature: res.signature },
            { httpUrl: e.rpc.heliusHttpUrl ?? e.rpc.httpUrl, owner: wallet.publicKey() },
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
      const swept = await sweepAtaRent(s.rpc.heliusHttpUrl ?? s.rpc.httpUrl);
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
        result = await sweepAtaRent(s.rpc.heliusHttpUrl ?? s.rpc.httpUrl);
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
  private async labBuy(walletId: string, mint: string, wantSol: number): Promise<{ ok: boolean; message: string; signature: string | null; costSol: number | null }> {
    const s = this.getSettings();
    if (!this.armed || !s.execution.liveEnabled) return { ok: false, message: 'live execution is not armed', signature: null, costSol: null };
    // No click behind this buy, so the real-money breakers and the per-trade
    // cap apply exactly as they do to any other unattended buy.
    const breaker = this.liveBreakerReason();
    if (breaker) {
      this.updateLiveBreakers();
      return { ok: false, message: `live buys paused — ${breaker}`, signature: null, costSol: null };
    }
    const sol = Math.min(wantSol, s.execution.maxLiveSol);
    if (sol < wantSol) this.log('info', `lab buy sized down to the ${s.execution.maxLiveSol} SOL per-trade cap (asked ${wantSol})`);
    const { executeTrade } = await import('./liveSigner');
    const owner = wallet.publicKeyOf(walletId);
    if (!owner) return { ok: false, message: 'no such wallet', signature: null, costSol: null };
    const res = await executeTrade({
      action: 'buy',
      mint,
      amount: sol,
      denominatedInSol: true,
      slippagePct: s.execution.liveSlippagePct,
      priorityFeeSol: this.priorityFeeSolFor('buy'),
      httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl,
      simulateOnly: false,
      local: await this.localBuildParamsAsync(mint),
      exec: s.execution,
      walletId,
      wssUrl: this.confirmWssUrl(),
    });
    if ((res.ok || res.stage === 'pending') && res.signature) {
      ledger.recordFill({ mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'buy', requested: sol, signature: res.signature }, { httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl, owner });
    }
    recorder.record('lab_buy', { walletId, mint, sol, ok: res.ok, stage: res.stage, signature: res.signature ?? null });
    return { ok: res.ok, message: res.message, signature: res.signature ?? null, costSol: res.simulatedCostSol ?? null };
  }

  /** A sell (default the whole bag) signed by a SPECIFIC wallet. */
  private async labSell(walletId: string, mint: string, pct = 100): Promise<{ ok: boolean; message: string; signature: string | null }> {
    const s = this.getSettings();
    if (!this.armed || !s.execution.liveEnabled) return { ok: false, message: 'live execution is not armed', signature: null };
    const owner = wallet.publicKeyOf(walletId);
    if (!owner) return { ok: false, message: 'no such wallet', signature: null };
    const share = Math.max(1, Math.min(100, Math.round(pct)));
    const res = await this.sellWithRetry({
      action: 'sell',
      mint,
      amount: `${share}%`,
      denominatedInSol: false,
      slippagePct: Math.max(s.execution.liveSlippagePct, 15),
      priorityFeeSol: this.priorityFeeSolFor('sell'),
      httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl,
      simulateOnly: false,
      local: await this.localBuildParamsForSell(mint),
      exec: s.execution,
      walletId,
      wssUrl: this.confirmWssUrl(),
    });
    if ((res.ok || res.stage === 'pending') && res.signature) {
      ledger.recordFill({ mint, symbol: this.tokens.get(mint)?.row.symbol ?? '', side: 'sell', requested: share, signature: res.signature }, { httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl, owner });
    }
    // Selling the ACTIVE wallet's own bag this way (a group that includes it)
    // must leave the engine's position tracking as a manual sell would.
    if (owner === wallet.publicKey() && share >= 100) {
      this.liveMints.delete(mint);
      if (res.ok) this.stuckMints.delete(mint);
    }
    recorder.record('lab_sell', { walletId, mint, pct: share, ok: res.ok, stage: res.stage, signature: res.signature ?? null });
    return { ok: res.ok, message: res.message, signature: res.signature ?? null };
  }

  /**
   * Groups set to FOLLOW the active wallet repeat its manual trade: each
   * member (except the active wallet) buys at the configured size, or sells
   * the SAME share of its bag that the active wallet sold, after its own
   * random delay. Fire-and-forget; every leg is a normal signed trade with
   * the platform fee, a follower that cannot cover the size sits out, and
   * one summary toast reports how the legs went.
   */
  private followManualTrade(side: 'buy' | 'sell', mint: string, solSpent: number | null, pct = 100): void {
    const active = wallet.publicKey();
    const groups = wallet.groups().filter((g) => g.lab?.follow?.enabled);
    if (!groups.length || !active) return;
    const s = this.getSettings();
    const seen = new Set<string>();
    const tally = { ok: 0, failed: 0, skipped: 0, done: 0 };
    const finish = (): void => {
      tally.done++;
      if (tally.done < seen.size) return;
      const parts = [`${tally.ok} ${side === 'buy' ? 'bought' : 'sold'}`];
      if (tally.failed) parts.push(`${tally.failed} failed`);
      if (tally.skipped) parts.push(`${tally.skipped} sat out`);
      this.emit({ kind: 'toast', level: tally.failed ? 'warn' : 'info', message: `Followers on ${mint.slice(0, 6)}…: ${parts.join(', ')}` });
    };
    for (const g of groups) {
      const f: FollowSettings = { ...DEFAULT_FOLLOW, ...(g.lab?.follow ?? {}) };
      if (side === 'sell' && !f.followSells) continue;
      for (const m of g.members) {
        if (m.publicKey === active || seen.has(m.id)) continue;
        seen.add(m.id);
        const delay = Math.round(labBetween(f.delayMinMs, f.delayMaxMs));
        setTimeout(() => {
          void (async () => {
            if (side === 'buy') {
              const want = f.sizeMode === 'fixed' ? f.fixedSol : (solSpent ?? 0) * f.ratio;
              const size = Math.round(Math.min(want, f.maxTradeSol) * 10_000) / 10_000;
              if (!(size >= 0.001)) {
                tally.skipped++;
                return;
              }
              const bal = await getBalance(s.rpc.httpUrl, m.publicKey);
              if (bal.ok && bal.data !== undefined && bal.data / 1e9 < size + 0.02) {
                tally.skipped++;
                this.log('info', `follow: ${m.label} sits out — ${(bal.data / 1e9).toFixed(4)} SOL cannot cover ${size} SOL plus fees (${g.name})`);
                return;
              }
              const r = await this.labBuy(m.id, mint, size);
              if (r.ok) tally.ok++;
              else tally.failed++;
              this.log(r.ok ? 'info' : 'warn', `follow: ${m.label} ${r.ok ? 'bought' : 'buy failed'} ${size} SOL of ${mint.slice(0, 8)}… (${g.name})${r.ok ? '' : ` — ${r.message.slice(0, 100)}`}`);
            } else {
              const r = await this.labSell(m.id, mint, pct);
              if (r.ok) tally.ok++;
              else tally.failed++;
              this.log(r.ok ? 'info' : 'warn', `follow: ${m.label} ${r.ok ? 'sold' : 'sell failed'} ${Math.round(pct)}% of ${mint.slice(0, 8)}… (${g.name})${r.ok ? '' : ` — ${r.message.slice(0, 100)}`}`);
            }
          })()
            .catch((e) => {
              tally.failed++;
              this.log('warn', `follow: ${m.label} ${side} leg threw — ${e instanceof Error ? e.message : String(e)}`);
            })
            .finally(finish);
        }, delay);
      }
    }
    if (seen.size) {
      const what = side === 'buy' ? 'buy' : `sell ${Math.round(pct)}% of`;
      this.emit({ kind: 'toast', level: 'info', message: `${seen.size} follower wallet(s) will ${what} ${mint.slice(0, 6)}… after their delays` });
    }
  }

  /** Every listed wallet sells 100 % of `mint`, staggered a little so the
   *  sells do not all land in one slot. Copier "manual orders with a group". */
  async fanoutSell(
    mint: string,
    walletIds: string[],
    opts: { staggerMaxMs?: number } = {},
  ): Promise<{ ok: boolean; message: string; results: Array<{ walletId: string; ok: boolean; message: string; signature: string | null }> }> {
    const s = this.getSettings();
    if (!this.armed || !s.execution.liveEnabled) return { ok: false, message: 'Arm live execution first', results: [] };
    const stagger = Math.max(0, Math.min(3000, opts.staggerMaxMs ?? 500));
    const results = await Promise.all(
      walletIds.map(async (walletId) => {
        if (stagger > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * stagger)));
        const r = await this.labSell(walletId, mint);
        return { walletId, ok: r.ok, message: r.message, signature: r.signature };
      }),
    );
    const landed = results.filter((r) => r.ok).length;
    recorder.record('fanout_sell', { mint, wallets: results.length, landed });
    this.log(landed === results.length ? 'info' : 'warn', `fan-out sell ${mint.slice(0, 8)}…: ${landed}/${results.length} landed`);
    return { ok: landed === results.length, message: `${landed}/${results.length} sells landed${landed === results.length ? '' : ' — see the rows for what did not'}`, results };
  }

  /** Say something on the desktop that did not originate there — a trade
   *  asked for from a paired chat, for instance. The user should never learn
   *  about a trade from their phone alone. */
  announce(level: 'info' | 'warn' | 'error', line: string): void {
    this.log(level, line);
    this.emit({ kind: 'toast', level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message: line });
    this.notify('Krypto Bot', line);
  }

  labStatus(): import('@shared/lab').RandomRunStatus[] {
    return randomLab.status();
  }

  /** Read every wallet's SOL balance (public RPC, parallel) and note it in
   *  the store so the Lab pages can show what a group actually holds. */
  async refreshAllBalances(): Promise<number> {
    const url = this.getSettings().rpc.httpUrl;
    const list = wallet.list();
    const results = await Promise.all(list.map((w) => getBalance(url, w.publicKey)));
    let noted = 0;
    results.forEach((r, i) => {
      if (r.ok && r.data !== undefined) {
        wallet.noteBalance(list[i].publicKey, r.data);
        if (list[i].publicKey === wallet.publicKey()) this.walletBalanceLamports = r.data;
        noted++;
      }
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
      httpUrl: s.rpc.heliusHttpUrl ?? s.rpc.httpUrl,
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
  private exitParams(exec: import('@shared/types').ExecutionSettings): {
    priorityFeeSol: number;
    exec: import('@shared/types').ExecutionSettings;
    note: string | null;
  } {
    const wanted = this.priorityFeeSolFor('sell');
    const balance = this.walletBalanceLamports;
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
    this.emitChartTick(ev.mint, n.receivedAt, priceSol, Number(ev.solAmount) / 1e9, ev.isBuy);
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
      randomLab.stopAll(`live execution disarmed (${reason})`);
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
    if (!sAmm.shadowStratLab && !sAmm.shadowMigration && tape.subscriptions().length === 0) return;
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
        if (sAmm.shadowMigration) this.emitMigEvents(this.mig.onMigration(event.mint, event.pool, n.receivedAt));
        continue;
      }
      if (sAmm.shadowMigration) this.emitMigEvents(this.mig.onAmmSwap(event, n.receivedAt));
      const mint = this.ammPoolToMint.get(event.pool);
      if (mint === undefined) continue;
      // A graduated token keeps charting: the terminal tape follows the mint
      // onto PumpSwap via the pool map, which the token page seeds from the
      // pool DexScreener reports.
      if (tape.isSubscribed(mint)) {
        tape.record(mint, {
          at: n.receivedAt,
          wallet: event.user,
          isBuy: event.isBuy,
          sol: Number(event.quoteAmount) / 1e9,
          tokens: Number(event.baseAmount) / 1e6,
          priceSol: executedPriceSol(event),
        });
        this.emitChartTick(mint, n.receivedAt, executedPriceSol(event), Number(event.quoteAmount) / 1e9, event.isBuy);
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
        this.continuity.observe(ev.mint, ev.isBuy, ev.solAmount, ev.virtualSolReserves);
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
      sockets: sockets.map((s) => ({ host: s.host, state: s.state, events: s.events, wins: s.wins, fills: s.fills, blocks: s.blocks })),
      undecodedPct: this.lastUndecodedPct,
      emitDropped: this.emitDropped,
      fills: priorityFeed.fillStats(),
    });
    if (snap.lossPct !== null && snap.lossPct > 5 && snap.checked >= 500 && now - this.lastFeedLossWarnAt > 10 * 60_000) {
      this.lastFeedLossWarnAt = now;
      const msg = `feed losing ~${snap.lossPct}% of events (${snap.mismatched}/${snap.checked} continuity failures, 15m) — flow gates are undercounting; add a better WS endpoint in Settings`;
      this.log('warn', msg);
      this.emit({ kind: 'toast', level: 'error', message: `Feed degraded: ~${snap.lossPct}% event loss — flow data unreliable` });
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
      oddsJudged: 0,
      flagged: false,
      decided: false,
      curveComplete: false,
      dumpRecorded: false,
      addr: safePrewarm(ev.mint, ev.creator),
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
    if (t.oddsTrades.length < 600 && n.receivedAt - t.row.detectedAt <= 130_000) {
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
    // Every event here is a trade that LANDED, which makes its mint a good
    // source of successful transactions for the local builder's account-layout
    // sampling. Cheap: an array unshift on a 12-slot ring.
    noteActiveMint(ev.mint, t.createEvent.creator);
    // Reserves + price always update (a held position marks off these even
    // after the token is decided).
    t.virtualSolReserves = ev.virtualSolReserves;
    t.virtualTokenReserves = ev.virtualTokenReserves;
    const held = this.positions.hasOpenFor(ev.mint);

    // Advanced orders evaluate on EVERY trade of a mint we are tracking, at
    // full feed rate — ahead of the decided/unheld fast-path below, because
    // a stop loss on a token the strategy passed on must still fire. The
    // creator-sell flag is read from the token's flow state, which onTrade
    // sets further down; using the pre-update value here is deliberate, so
    // an order sees the same event the flow does rather than one tick late.
    {
      const priceSol = spotPriceSol(ev.virtualSolReserves, ev.virtualTokenReserves);
      this.rememberPrice(ev.mint, priceSol);
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
        copyTrade.onWalletTrade({
          wallet: ev.user,
          mint: ev.mint,
          symbol: t.row.symbol,
          isBuy: ev.isBuy,
          sol: Number(ev.solAmount) / 1e9,
          priceSol,
          at: n.receivedAt,
        });
      }
    }

    // Terminal tape. Runs BEFORE the decided/unheld fast-path return below,
    // because the token page is usually open on a mint the strategy already
    // passed on — that is the whole point of a terminal. Gated on an explicit
    // subscription (a Set lookup) so the firehose costs nothing when nobody
    // is looking.
    if (tape.isSubscribed(ev.mint)) this.recordTapeTrade(ev, n);

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
    if (t.decided && !held) {
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
      if (ev.user === t.createEvent.creator) {
        t.row.flow.creatorSold = true;
        if (!t.dumpRecorded) {
          t.dumpRecorded = true;
          creators.recordDump(t.createEvent.creator);
        }
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
      this.pushLaunchThrottled(t);
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
      if (t.oddsTrades.length < 3) continue;
      let report;
      try {
        const features = oddsFeaturesFromTrades(t.oddsTrades, {
          creator: t.createEvent.creator,
          supply: 1e9,
          curveProgress: curveProgressPct(t.virtualSolReserves) / 100,
          virtualSolReserves: Number(t.virtualSolReserves),
          virtualTokenReserves: Number(t.virtualTokenReserves),
          hasTwitter: null,
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
        curvePct: curveProgressPct(t.virtualSolReserves),
        uniqueBuyers: t.row.flow.uniqueBuyers,
        netInflowSol: t.row.flow.netInflowSol,
        tradesSeen: report.tradesSeen,
      };
      t.flagged = true;
      this.runners.unshift(flag);
      if (this.runners.length > 50) this.runners.length = 50;
      recorder.record('runner', { mint: flag.mint, windowS, bucket: flag.bucket, observedPct: flag.observedPct, basePct: flag.basePct, curvePct: flag.curvePct, buyers: flag.uniqueBuyers, net: flag.netInflowSol });
      if (t.row.phase !== 'entered') this.updatePhase(t, 'flagged');
      this.emit({ kind: 'runner', runner: flag });
      const { title, body } = runnerNotification(flag);
      this.log('info', `${title} — ${body}`);
      if (this.runnerLimiter.allow(now, cfg.maxPerHour)) {
        this.notify(title, body);
        this.emit({ kind: 'toast', level: 'info', message: `${title} · ${flag.observedPct.toFixed(0)} % of this bucket graduated (base ${flag.basePct.toFixed(1)} %)` });
      }
    }
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

  /** Trade streams are hot — cap UI updates per token at ~4/s. */
  private pushLaunchThrottled(t: TrackedToken): void {
    const last = this.lastPush.get(t.row.mint) ?? 0;
    if (Date.now() - last >= 250) this.pushLaunch(t);
  }

  private evictOld(): void {
    while (this.launchOrder.length > LAUNCH_LIST_CAP) {
      const mint = this.launchOrder.shift()!;
      const t = this.tokens.get(mint);
      // Never evict a token backing an open position.
      if (t && this.positions.hasOpenFor(mint)) {
        this.launchOrder.push(mint);
        if (this.launchOrder.length <= LAUNCH_LIST_CAP + 5) break;
        continue;
      }
      this.tokens.delete(mint);
      this.lastPush.delete(mint);
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
