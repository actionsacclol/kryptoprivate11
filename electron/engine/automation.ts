// User automation — rules and scripts, under budget, through the pipeline.
//
// The shape mirrors advOrders and copyTrade: the engine injects execution
// and gating, this module notices things and decides. What it adds is a
// wall around each script — a budget checked on EVERY action, in this
// process, whatever the script asked for — and, for code scripts, the
// bridge to a sandbox that can do nothing but ask.
//
// Rules of the house, each pinned by a test:
//   1. paper by default; a live script never comes back armed after a restart;
//   2. every buy and sell goes through the host — fees, signer policy,
//      breakers and the loss guard are the engine's, not the script's;
//   3. a buy over the script's cap is refused, never clamped; a day's buys,
//      open positions and actions per minute are capped; a day's realised
//      loss past the cap DISABLES the script;
//   4. an unknown fact never satisfies a rule;
//   5. a script that errors five times in a row (or crash-loops) is PAUSED
//      and restarts by itself, at most three times in 24 h, then disabled —
//      loudly each time; a handler that runs past the watchdog is killed
//      and counted as an error;
//   6. every refusal is logged on the script with its reason.
//
// What a script can react to: launches and their updates, runner flags, its
// positions, price ticks on what it holds or subscribed to, trades by the
// wallets followed on Copy Trading, its own advanced orders changing state,
// alerts firing, a daily time, and a timer. What it can do: buy, sell, sell
// everything, place and cancel advanced orders, apply an order template,
// create alerts, watch/unwatch, notify, log, and turn itself off.

import type { AiAnalysis } from '@shared/ai';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../system/logger';
import {
  contextFromEvmLaunch,
  defaultScript,
  contextFromLaunch,
  contextFromRunner,
  contextFromEvmRunner,
  describeAction,
  describeRules,
  emptyContext,
  evaluateRules,
  validateScript,
  withAlert,
  withGlobals,
  withLeader,
  withLaunchLinks,
  withLaunchIntel,
  withMarket,
  withOrder,
  withPosition,
  ALERT_KINDS,
  actionAvailableOn,
  chainLabel,
  scriptChain,
  MAX_SCRIPTS,
  MAX_STATE_BYTES,
  RULE_ACTIONS,
  type LeaderFacts,
  type LaunchLinks,
  type MarketFacts,
  type ScriptLinks,
  type ScriptSecurity,
  type ScriptCreator,
  type ScriptLaunchIntel,
  type ScriptHolding,
  type ScriptSettingsView,
  scriptHoldingFromWallet,
  type RuleAction,
  type RuleContext,
  type ScriptLogLine,
  type ScriptMode,
  type ScriptPosition,
  type ScriptSnapshot,
  type ScriptStats,
  type UserScript,
  type BundledScript,
} from '@shared/automation';
import { DEFAULT_LOSS_PCT_OF_WALLET } from '@shared/automation';
import { migrateInputDefaults, parseInputs as parseInputSpecs } from '@shared/scriptInputs';
import { FEE_LANES, MAX_UNATTENDED_FEE_SHARE, minUnattendedBuySol, roundTripFeeShare, type FeeLane } from '@shared/exitBudget';
import { MAX_STAT_KEYS, MIN_INTERVAL_S, type SandboxToMain, type ScriptStatValue } from '@shared/scriptProtocol';
import { REPLY_BUDGET, THESIS_BUDGET, calloutPageUrl } from '@shared/calloutAuto';
import { redactWebhook, scriptEmbed, type ScriptEmbed } from '@shared/webhook';
import type { EngineEvent, LaunchRow } from '@shared/types';
import { CANDLE_INTERVALS, DISCOVER_COLUMNS, type CandleInterval, type CandleSeries, type DiscoverColumn, type HolderReport, type TokenSummary, type TradeRow } from '@shared/market';
import type { Callout } from '@shared/callouts';
import type { TradeHistoryRow } from '@shared/portfolio';
import type { ScoutRow, ScoutWallet, ScoutWindow } from '@shared/walletScout';
import type { CopySnapshot } from '@shared/copytrade';
import type { Alert } from '@shared/alerts';
import type { OrderTemplate } from '@shared/orderTemplates';
import type { CopyTrade } from '@shared/copytrade';
import { nativeSymbolOf } from '@shared/evm';
import type { ChainKind } from '@shared/evm';
import type { EvmScanLaunch } from '@shared/evmScan';
import type { EvmRunnerFlag } from '@shared/evmRunners';
import type { EvmChainKind } from '@shared/evm';
import type { RunnerFlag } from '@shared/runners';
import { TRIGGER_BASES, isPctKind } from '@shared/orders';
import type { NewOrderRequest, OrderKind, TriggerBasis } from '@shared/orders';
import type { AlertKind, NewAlertRequest } from '@shared/alerts';
import * as recorder from './recorder';
import { traderClaimFor } from './traderClaims';
// Re-exported for the test bundle, which has its own copy of the module.
export { setTraderClaimCheck } from './traderClaims';

const FILE = 'automation.json';
const LOG_CAP = 200;
const SNAPSHOT_LOG_LINES = 100;
const LAUNCH_UPDATE_THROTTLE_MS = 2_000;
const TICK_THROTTLE_MS = 1_000;
const POSITION_POLL_MS = 5_000;
const ERRORS_TO_DISABLE = 5;
const QUEUE_CAP = 50;
const MAX_SUBSCRIBED = 50;
/** bot.every timers one script may run at once. */
const MAX_INTERVAL_TIMERS = 8;

function clearIntervals(rt: { intervalTimers: Map<number, NodeJS.Timeout> }): void {
  for (const t of rt.intervalTimers.values()) clearInterval(t);
  rt.intervalTimers.clear();
}

export interface OrderView {
  id: string;
  mint: string;
  symbol: string;
  kind: string;
  state: string;
  triggerBasis: string;
  triggerValue: number | null;
  amount: number;
  /** Paused because the app stopped while it was EXECUTING — its trade may
   *  have landed. Never re-place one without checking the wallet. */
  interrupted?: boolean;
}

export interface LeaderView {
  wallet: string;
  label: string;
  enabled: boolean;
  mode: string;
  /** The chain the config follows; absent = Solana. */
  chain?: ChainKind;
}

/** A followed wallet's swap, as the engine reports it (copy trading's feed). */
export interface LeaderTrade extends LeaderFacts {
  mint: string;
  symbol: string;
  /** The chain the leader traded on; absent = Solana. Only scripts on that
   *  chain hear it. */
  chain?: ChainKind;
}

/** A fill the ledger reconciled against the chain (host.onFillSettled). */
export interface SettledFill {
  mint: string;
  side: 'buy' | 'sell';
  at: number;
  wallet: string | null;
  /** SOL asked for on a buy; PERCENT sold on a sell. */
  requested: number;
  /** A sell's realised result against the wallet's own average cost, fees
   *  included; null when the basis is unknown. Always null for a buy. */
  realizedSol: number | null;
  /** The chain the fill settled on; absent = Solana. Only that chain's
   *  scripts count it (an EVM token never matches a Solana mint anyway). */
  chain?: ChainKind;
}

export interface AutomationHost {
  /** A buy in the script's mode: paper = simulated fill into the paper book;
   *  live = the real pipeline. */
  /**
   * `ownCapSol` is the script's OWN per-trade cap, which it has already
   * enforced. It replaces the app's manual per-trade cap for this buy rather
   * than adding to it — a script's budget is the authority on its own size.
   */
  buy(mint: string, sol: number, mode: ScriptMode, chain?: ChainKind, ownCapSol?: number, opts?: ScriptTradeOpts): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean }>;
  /** A sell of `pct`% of what is held, in the script's mode. `realizedSol`
   *  when the fill can say (paper: exact). */
  sell(mint: string, pct: number, mode: ScriptMode, chain?: ChainKind, opts?: ScriptTradeOpts): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean; realizedSol?: number | null }>;
  /** Why NO live action can execute right now, or null. Paper ignores it. */
  liveBlockedReason(chain?: ChainKind): string | null;
  /** Why a live BUY specifically cannot (entry breakers). Never blocks a sell. */
  buyBlockedReason(chain?: ChainKind): string | null;
  /** Per-trade SOL cap from execution settings; a live buy may not exceed it. */
  maxLiveSol(chain?: ChainKind): number;
  priceSol(mint: string, chain?: ChainKind): number | null;
  /** The launch feed's row for a mint, if it has one. */
  launch(mint: string): LaunchRow | null;
  /** Which links the launch's own metadata file published, as the scanner
   *  read it at create time — free. Null until that read resolves. */
  launchLinks?(mint: string): LaunchLinks | null;
  /** Whether the launch is a mayhem-mode curve, from its create event —
   *  free. Null when the app could not tell or never saw the launch. */
  launchMayhem?(mint: string): boolean | null;
  /** Provider facts already cached — free. */
  marketCached(mint: string, chain?: ChainKind): MarketFacts | null;
  /** Provider facts, fetched — a round trip. */
  market(mint: string, chain?: ChainKind): Promise<MarketFacts | null>;
  /** The token's links and what its X link is, from cached facts — free.
   *  Null when nothing is cached. Solana only. */
  links(mint: string, chain?: ChainKind): ScriptLinks | null;
  /** The token page's security report — a round trip. Solana only. */
  security(mint: string, chain?: ChainKind): Promise<ScriptSecurity | null>;
  /** The creator's launch record — a round trip. Solana only. */
  creator(mint: string, chain?: ChainKind): Promise<ScriptCreator | null>;
  /**
   * The Launch tab's cohorts — a round trip (1–2 pump swap-api calls plus one
   * RPC batch, memoised 45 s by the data layer). Solana only. (2026-09-27)
   */
  launchIntel(mint: string, chain?: ChainKind): Promise<ScriptLaunchIntel | null>;
  /** The same report from the memo alone — free, null when nothing is
   *  cached. This is how the cohorts ride into every facts object without a
   *  launch event ever buying a scan. Optional so a test host can leave it out. */
  launchIntelCached?(mint: string, chain?: ChainKind): ScriptLaunchIntel | null;
  // ── Every other read the app has (2026-09-27) ─────────────────────────
  // Each is what the matching panel or MCP tool shows, unchanged. The
  // network ones are charged as actions by the dispatcher; the in-memory
  // ones are free. Solana-only ones answer null off Solana.
  /** The Holders panel. */
  holders(mint: string, limit: number, chain?: ChainKind): Promise<HolderReport | null>;
  /** The Trades panel: the app's own tape when it has one, else a provider's. */
  trades(mint: string, limit: number, chain?: ChainKind): Promise<{ rows: TradeRow[]; source: string; note: string | null } | null>;
  /** The chart's candles, tape merged with providers. */
  candles(mint: string, interval: CandleInterval, limit: number, chain?: ChainKind): Promise<CandleSeries | null>;
  /** Token search (Jupiter). */
  search(query: string, chain?: ChainKind): Promise<TokenSummary[]>;
  /** A Discover column, on the script's chain. */
  discover(column: DiscoverColumn, limit: number, chain?: ChainKind): Promise<TokenSummary[]>;
  /** pump.fun's public callouts feed, newest first. Null when pump is not answering. */
  callouts(limit: number, chain?: ChainKind): Promise<Callout[] | null>;
  /** Every callout on one pump.fun coin, newest first. Null when pump is not answering. */
  coinCallouts(mint: string, chain?: ChainKind): Promise<Callout[] | null>;
  /** Every fill this install made, newest first. */
  history(limit: number, chain?: ChainKind): TradeHistoryRow[];
  /** Every token the active wallet holds on the chain. Null when the wallet could not be read. */
  holdings(chain?: ChainKind): Promise<ScriptHolding[] | null>;
  /** SOL in USD from the cached price provider. */
  solUsd(): Promise<number | null>;
  /** The Wallet Scout board on a chain. */
  walletScores(chain: ChainKind, window: ScoutWindow, limit: number, onlyWorthALook: boolean): { onRecord: number; filtered: boolean; rows: ScoutRow[] };
  /** One wallet's Scout record on a chain. */
  walletRecord(address: string, chain: ChainKind): { wallet: ScoutWallet; saved: boolean } | null;
  /** The Copy Trading configs and their records — never the recent-rows firehose. */
  copyConfigs(): Pick<CopySnapshot, 'configs' | 'stats' | 'liveExecutable' | 'liveBlockedReason'>;
  /** Every alert on the Alerts page. */
  alerts(): Alert[];
  // ── Housekeeping the pages have (2026-09-27) ───────────────────────────
  cancelOrder(id: string): { ok: boolean; message: string };
  resumeOrders(): { ok: boolean; message: string };
  removeAlert(id: string): { ok: boolean; message: string };
  muteAlert(id: string, muted: boolean): { ok: boolean; message: string };
  clearFiredAlerts(): { ok: boolean; message: string };
  saveTemplate(t: OrderTemplate): { ok: boolean; message: string };
  deleteTemplate(id: string): { ok: boolean; message: string };
  setActiveTemplate(id: string | null): { ok: boolean; message: string };
  /** The app's settings, scrubbed of every key and URL (shared/automation.ts). */
  settings(): ScriptSettingsView;
  /** The AI second opinion. Spends the user's own key on an uncached call;
   *  throws with the reason when AI is off. Solana only. */
  analyze(mint: string, chain?: ChainKind): Promise<AiAnalysis>;
  /** Open positions in a mode. */
  /** maxWaitMs: answer from the last wallet read (≤ 60 s old) when a fresh one is slower than this — context reads only. */
  positions(mode: ScriptMode, chain?: ChainKind, opts?: { maxWaitMs?: number }): Promise<ScriptPosition[]>;
  /** All-in SOL the chain says these buy signatures spent (fees and rent
   *  included, the same measure as a live position's `costSol`), or null
   *  when any of them is not reconciled yet. */
  spentSolFor?(signatures: string[]): number | null;
  /**
   * The mints the active wallet (or the paper book) holds, or NULL when the
   * read failed. `positions` answers a failed read with an empty list, which
   * is fine for display and wrong for deciding a script sold something.
   * Optional so a test host can leave it out; `reconcileOpened` then skips.
   */
  heldMints?(mode: ScriptMode, chain?: ChainKind): Promise<Set<string> | null>;
  /**
   * Every fill the ledger settles against the chain, as it settles. This is
   * how a script's loss stop counts the exits it did not make itself — a
   * stop-loss or take-profit order selling its bag (2026-09-28). Optional
   * so a test host can leave it out; the stop then counts paper sells only.
   */
  onFillSettled?(fn: (f: SettledFill) => void): () => void;
  wallet(chain?: ChainKind): { sol: number | null; address: string | null };
  orders(mint?: string): OrderView[];
  placeOrder(req: NewOrderRequest): Promise<{ ok: boolean; message: string }>;
  /** Every open order on the mint, or only the given kinds. */
  cancelOrders(mint: string, kinds?: OrderKind[]): { ok: boolean; message: string; cancelled: number };
  clearCompletedOrders(): { ok: boolean; message: string; cleared: number };
  templates(): Array<{ id: string; name: string }>;
  applyTemplate(mint: string, templateId: string): Promise<{ ok: boolean; message: string }>;
  createAlert(req: NewAlertRequest): { ok: boolean; message: string };
  /** Stream ticks for a mint (idempotent; never unsubscribes — the chart may be on it). */
  subscribeTicks(mint: string): void;
  /** Pin / unpin on the renderer's Watchlist. */
  pin(mint: string, on: boolean): void;
  runners(): RunnerFlag[];
  leaders(): LeaderView[];
  notify(title: string, body: string): void;
  /**
   * Post a pump.fun callout on a coin, as one of the user's pump accounts.
   *
   * `thesis` empty means "use a random line from the Auto-callout settings".
   * `wallet` empty means the active trading wallet; otherwise it is matched
   * against the ADDRESSES of signed-in accounts, so a caller can only ever
   * name an account this app already holds a session for.
   *
   * Never throws: pump refusing a call is ordinary and comes back as ok:false.
   */
  callout(
    mint: string,
    thesis: string,
    wallet: string,
  ): Promise<{ ok: boolean; message: string; thesis?: string; address?: string; calloutId?: string | null }>;
  /** Reply to the callout this account already made on the coin. */
  calloutReply(
    mint: string,
    content: string,
    wallet: string,
  ): Promise<{ ok: boolean; message: string; thesis?: string; address?: string; calloutId?: string | null; replyId?: string | null }>;
  /** POST one embed to a Discord webhook. The URL comes from the script's own
   *  `webhook` answer, resolved in this module, never from the sandbox. */
  discord(webhookUrl: string, embed: ScriptEmbed): Promise<{ ok: boolean; message: string; messageId?: string }>;
  /** Replace the embed on a message this webhook posted (a call's outcome). */
  discordEdit(webhookUrl: string, messageId: string, embed: ScriptEmbed): Promise<{ ok: boolean; message: string }>;
  /** Follow / unfollow a pump user, like / unlike a callout, as one of the
   *  user's accounts. Same `wallet` rule as callout. Never throws. */
  pumpSocial(
    action: 'follow' | 'unfollow' | 'like' | 'unlike',
    target: string,
    wallet: string,
  ): Promise<{ ok: boolean; message: string; address?: string }>;
  /** The user's own wallets on this chain: address, label, which is active. */
  wallets(): Array<{ address: string; label: string; active: boolean }>;
  /**
   * Buy / sell with one of the user's OTHER wallets, named by address.
   *
   * There is no per-coin wallet cap on this — it is the only multi-wallet
   * path left (the Copier was removed 2026-09-22), and the script's own
   * budget bounds it. Here a script names one per call and its own budget bounds it. The
   * multi-wallet acknowledgement still applies.
   */
  walletBuy(address: string, mint: string, sol: number, ownCapSol?: number): Promise<{ ok: boolean; message: string }>;
  walletSell(address: string, mint: string, pct: number): Promise<{ ok: boolean; message: string }>;
  /** The signed-in pump.fun accounts, newest first. A free read. */
  pumpAccounts(): Array<{ address: string; username: string | null; active: boolean }>;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void;
  changed(): void;
  sandbox: {
    start(scriptId: string, code: string, info?: { chain?: string; nativeSymbol?: string; inputs?: Record<string, unknown> }): Promise<{ ok: boolean; message: string; retryable?: boolean }>;
    dispatch(scriptId: string, name: string, payload: unknown): Promise<{ ok: boolean; error?: string }>;
    reply(scriptId: string, id: number, ok: boolean, value?: unknown, error?: string): void;
    stop(scriptId: string, reason?: string): Promise<void>;
    isRunning(scriptId: string): boolean;
    /** The sandbox renderer's working set, MB, or null. For the hourly
     *  health line only; optional so a test host can leave it out. */
    memoryMB?(scriptId: string): number | null;
  };
}

/** AI analyses a script may run per rolling hour — each uncached one spends
 *  the user's own key. Fixed rather than a budget field: the point is that
 *  a runaway script cannot raise its own ceiling. */
const AI_ANALYSES_PER_HOUR = 20;

/** A position this script opened. `wallet` is set when it was bought with one
 *  of the user's OTHER wallets (by address): the active wallet's holdings say
 *  nothing about it, so it is never pruned against them. */
interface OpenedEntry {
  costSol: number;
  at: number;
  wallet?: string;
  /**
   * Signatures of this script's buys of the mint, so its share of the bag can
   * be priced from the CHAIN like the wallet's (see `sellOne`). `sigless`
   * is set once any buy — a limit/migration order's fill, a buy that returned
   * no signature — joined the entry without one: the signatures then no
   * longer cover everything the script paid, and the requested SOL is used.
   */
  sigs?: string[];
  sigless?: boolean;
  /** Realised so far on this bag from settled sells (partial exits). */
  realized?: number;
}

/** A bag the script opened and no longer holds: what it came to. */
interface ClosedEntry {
  at: number;
  costSol: number;
  realized: number;
  /** Set once the episode has been counted toward the losing streak. */
  judged?: boolean;
}

/** Keep the signature list bounded; past this the entry counts as sigless. */
const MAX_OPENED_SIGS = 20;

/** Add one buy to an opened entry, keeping the signature bookkeeping honest. */
function openedWithBuy(prev: OpenedEntry | undefined, sol: number, at: number, signature: string | null | undefined, wallet?: string): OpenedEntry {
  const sigs = [...(prev?.sigs ?? [])];
  let sigless = prev ? prev.sigless === true || !prev.sigs?.length : false;
  if (signature && sigs.length < MAX_OPENED_SIGS) sigs.push(signature);
  else sigless = true;
  const e: OpenedEntry = { costSol: (prev?.costSol ?? 0) + sol, at, sigs, sigless };
  if (wallet) e.wallet = wallet;
  return e;
}

interface Runtime {
  dayKey: string;
  buysToday: number;
  sellsToday: number;
  realizedToday: number;
  errorsInARow: number;
  lastRunAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  firedMints: Set<string>;
  lastFireAt: Map<string, number>;
  /** Timestamps of actions in the last minute. */
  actions: number[];
  /** Timestamps of AI analyses in the last hour — they spend the user's key. */
  analyses: number[];
  /** Positions this script opened (or placed a limit buy for): mint → cost. */
  opened: Map<string, OpenedEntry>;
  /** Bags this script opened that are gone, newest last — a fill that
   *  settles after the position poll noticed the sale still finds its bag. */
  closed: Map<string, ClosedEntry>;
  /** Losing exits in a row (live). */
  lossStreak: number;
  /** While set and in the future, buys are refused: the cool-off. */
  coolOffUntil: number | null;
  /** Mints the script asked to stream ticks for. */
  subscribed: Set<string>;
  /**
   * Accounts this script has already called each coin from: mint → addresses.
   *
   * A dedupe, not a limit: pump allows exactly one callout per coin per
   * account, so a second attempt from the same one is a request that would be
   * refused. Skipping it costs nothing and saves a round trip.
   *
   * In memory only. A restart clears it, and pump's own "you have already
   * called this coin" is what catches the repeat after that.
   */
  calledOut: Map<string, Set<string>>;
  kv: Record<string, unknown>;
  lastUpdateAt: Map<string, number>;
  lastTickAt: Map<string, number>;
  intervalSec: number | null;
  /** One per bot.every call, keyed by the sandbox's timer id (2026-09-29:
   *  a single timer shared by every call made the LAST interval win, so a
   *  bot.every(3600) stopped every shorter timer in the script). */
  intervalTimers: Map<number, NodeJS.Timeout>;
  /** Consecutive failed starts, and the timer for the next attempt. A start
   *  can fail for reasons that have nothing to do with the script (a slow
   *  machine, a provider parked behind a 429), and disarming on the first one
   *  made the user re-arm by hand for a stall that would have cleared. */
  startFails: number;
  startRetry: NodeJS.Timeout | null;
  /** When a script paused for its own errors restarts (see pauseForErrors);
   *  null when it is not paused. In memory: an app restart ends the pause. */
  pausedUntil: number | null;
  /** When this script was paused for errors, the last 24 h. */
  recoveries: number[];
  /** The hourly health line's counters (see logHealth). */
  health: Health;
  /** Event contexts being built right now (see BUILD_CAP). */
  building: number;
  /** Daily schedules: "HH:MM" → timer to the next occurrence. */
  atTimers: Map<string, NodeJS.Timeout>;
  log: ScriptLogLine[];
  /** The script's own widget stats (bot.stat), insertion-ordered. */
  metrics: Map<string, { value: ScriptStatValue; at: number }>;
  running: boolean;
  queue: Array<{ name: string; payload: unknown }>;
  busy: boolean;
}

interface PersistedRuntime {
  dayKey: string;
  buysToday: number;
  sellsToday: number;
  realizedToday: number;
  firedMints: string[];
  /** Per-mint cooldown clocks. Without these a restart is a free reset of
   *  every `cooldownSec`, which is a wall the user set. */
  lastFireAt?: Record<string, number>;
  opened: Record<string, OpenedEntry>;
  closed?: Record<string, ClosedEntry>;
  lossStreak?: number;
  coolOffUntil?: number | null;
  subscribed?: string[];
  kv: Record<string, unknown>;
}

let host: AutomationHost | null = null;
let scripts: UserScript[] = [];
const runtimes = new Map<string, Runtime>();
let killSwitch = false;
/** The automation kill switch, for main's other unattended money movers (the
 *  All-in-One float stops with the rest, v6 audit 2026-10-03). */
export function killSwitchOn(): boolean {
  return killSwitch;
}
/** Keys of shipped scripts ever seeded here. A user who deletes one keeps it deleted. */
let bundledSeen: string[] = [];
let shipped: BundledScript[] = [];
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
let positionTimer: NodeJS.Timeout | null = null;
/** Order id → last state seen, to turn snapshots into events. */
const orderStates = new Map<string, string>();
/** Alert id → last fired-at seen. */
const alertFires = new Map<string, number | null>();
/** Runner flags seen, so an expiry can be told from a list that never had
 *  the mint (2026-09-27). Bounded: pruned to what the last list still held. */
let knownRunners = new Set<string>();
/** Copy trade id → last state seen, to diff snapshots into copyFill events. */
const copyStates = new Map<string, string>();
/** False until the first copy snapshot has seeded the map (it is history). */
let copySeeded = false;
/** Most copyFill events one snapshot may raise — a real burst is a few. */
const COPY_FILLS_PER_SNAPSHOT = 10;

let offSettled: (() => void) | null = null;

export function attach(h: AutomationHost): void {
  host = h;
  offSettled?.();
  offSettled = h.onFillSettled?.((f) => onFillSettled(f)) ?? null;
}

// ── Persistence ───────────────────────────────────────────────────────

/** Set when automation.json exists but could not be read or parsed. While it
 *  is set NOTHING is written: an unreadable file is not an empty one, and the
 *  next save would otherwise destroy every script the user wrote. `shutdown()`
 *  persists unconditionally, so without this simply closing the app is enough
 *  to lose them. Same rule as the wallet file (2026-09-03) and the ledger. */
let loadFailure: string | null = null;

export function failure(): string | null {
  return loadFailure;
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    // Absent is a first run. Anything else is a file we must not overwrite.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      scripts = [];
      bundledSeen = [];
      return;
    }
    loadFailure = `${filePath} could not be read (${(e as Error).message})`;
    logger.error(`automation: ${loadFailure}`);
    scripts = [];
    return;
  }
  try {
    const raw = JSON.parse(text) as {
      version: 1;
      scripts: UserScript[];
      runtime: Record<string, PersistedRuntime>;
      killSwitch?: boolean;
      bundledSeen?: unknown;
    };
    scripts = Array.isArray(raw?.scripts) ? raw.scripts : [];
    killSwitch = raw?.killSwitch === true;
    const seen = (raw as { bundledSeen?: unknown }).bundledSeen;
    bundledSeen = Array.isArray(seen) ? seen.filter((k): k is string => typeof k === 'string') : [];
    for (const s of scripts) {
      const rt = freshRuntime();
      const p = raw.runtime?.[s.id];
      if (p) {
        rt.dayKey = p.dayKey;
        rt.buysToday = p.buysToday ?? 0;
        rt.sellsToday = p.sellsToday ?? 0;
        rt.realizedToday = p.realizedToday ?? 0;
        rt.firedMints = new Set(Array.isArray(p.firedMints) ? p.firedMints : []);
        rt.lastFireAt = new Map(Object.entries(p.lastFireAt ?? {}).filter(([, v]) => typeof v === 'number'));
        rt.opened = new Map(Object.entries(p.opened ?? {}));
        rt.closed = new Map(Object.entries(p.closed ?? {}));
        rt.lossStreak = typeof p.lossStreak === 'number' ? p.lossStreak : 0;
        rt.coolOffUntil = typeof p.coolOffUntil === 'number' ? p.coolOffUntil : null;
        rt.subscribed = new Set(Array.isArray(p.subscribed) ? p.subscribed : []);
        rt.kv = p.kv && typeof p.kv === 'object' ? p.kv : {};
      }
      runtimes.set(s.id, rt);
      // A LIVE script never survives a restart armed — same rule as orders
      // and copy configs. Paper scripts resume: paper costs nothing and an
      // interrupted experiment is a useless one.
      if (s.mode === 'live' && s.enabled) {
        s.enabled = false;
        pushLog(rt, 'warn', 'Disabled on restart — a live script must be re-armed by hand.');
      }
    }
  } catch (e) {
    loadFailure = `${filePath} is not readable JSON (${(e as Error).message})`;
    logger.error(`automation: ${loadFailure}`);
    scripts = [];
  }
}

/**
 * Every save rewrites the WHOLE file — every script's source included, a
 * quarter of a megabyte with two big scripts — and a script's own
 * bot.setState can ask for one several times a pass. Money-path changes (a
 * buy, a sell, the registry) are saved within 300 ms; a script's own state
 * and its subscriptions within 3 s, so one pass's
 * several setStates are one write (2026-09-27: the soak measured ~17 writes a
 * minute, ~2 MB a minute, from one script). Either way a save already due
 * sooner carries the change; shutdown writes at once.
 */
const HARD_SAVE_MS = 300;
const SOFT_SAVE_MS = 3_000;
let saveDue = 0;

function persist(soft = false): void {
  if (!filePath || loadFailure) return;
  const due = Date.now() + (soft ? SOFT_SAVE_MS : HARD_SAVE_MS);
  if (saveTimer && saveDue <= due) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveDue = due;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, due - Date.now());
}

function persistNow(): void {
  if (!filePath) return;
  if (loadFailure) {
    logger.warn(`automation: not saving — ${loadFailure}`);
    return;
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const runtime: Record<string, PersistedRuntime> = {};
  for (const s of scripts) {
    const rt = runtimes.get(s.id);
    if (!rt) continue;
    runtime[s.id] = {
      dayKey: rt.dayKey,
      buysToday: rt.buysToday,
      sellsToday: rt.sellsToday,
      realizedToday: rt.realizedToday,
      firedMints: [...rt.firedMints].slice(-5_000),
      lastFireAt: Object.fromEntries([...rt.lastFireAt].slice(-5_000)),
      opened: Object.fromEntries(rt.opened),
      closed: Object.fromEntries([...rt.closed].slice(-CLOSED_KEEP)),
      lossStreak: rt.lossStreak,
      coolOffUntil: rt.coolOffUntil,
      subscribed: [...rt.subscribed],
      kv: rt.kv,
    };
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, scripts, runtime, killSwitch, bundledSeen }, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* memory stays authoritative */
  }
}

let seq = 0;
const nextId = (): string => {
  seq += 1;
  return `scr_${Date.now().toString(36)}_${seq.toString(36)}`;
};

// LOCAL, not UTC: the schedule trigger, `hourLocal` and `weekday` are all
// local, so a UTC day key rolled the buy counter in the middle of the user's
// evening and handed them a second day-budget.
const dayKeyNow = (): string => new Date().toLocaleDateString('en-CA');

// Every snapshot carries every script's source, so one `changed()` is a real
// cost — a chatty `bot.log` loop measured 8.6 GB of serialisation and 8.4 s of
// main-process time over 20,000 lines, and main is where stop-losses are
// evaluated. Broadcasts are coalesced: the first is immediate so the UI stays
// live, the rest ride a trailing 200 ms timer.
const CHANGED_MIN_GAP_MS = 200;
let changedAt = 0;
let changedTimer: NodeJS.Timeout | null = null;

function changed(): void {
  const now = Date.now();
  if (changedTimer) return;
  if (now - changedAt >= CHANGED_MIN_GAP_MS) {
    changedAt = now;
    host?.changed();
    return;
  }
  changedTimer = setTimeout(() => {
    changedTimer = null;
    changedAt = Date.now();
    host?.changed();
  }, CHANGED_MIN_GAP_MS - (now - changedAt));
  if (typeof changedTimer.unref === 'function') changedTimer.unref();
}

/**
 * What a script did since its last health line. A script is left running for
 * days; until 2026-09-27 app.log said nothing about how it was doing between
 * its own lines — no event count, no handler time, no memory — so a slow
 * degradation could not be seen after the fact.
 */
interface Health {
  since: number;
  /** When the current sandbox came up (a restart resets it). */
  upSince: number | null;
  events: number;
  /** Launch/tick chatter dropped because the queue was full. */
  dropped: number;
  failed: number;
  /** Handler times, ms; bounded — a sample, not every one. */
  lat: number[];
  restarts: number;
}
const HEALTH_LAT_CAP = 4_000;
let HEALTH_EVERY_MS = 3_600_000;
let healthTimer: NodeJS.Timeout | null = null;
function freshHealth(upSince: number | null = null): Health {
  return { since: Date.now(), upSince, events: 0, dropped: 0, failed: 0, lat: [], restarts: 0 };
}
/** Test seam: a shorter health interval (restart the timers after). */
export function _setHealthEvery(ms: number | null): void {
  HEALTH_EVERY_MS = ms ?? 3_600_000;
}

function pctOf(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function span(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/** One line per running code script: is it keeping up, and is it growing? */
function logHealth(): void {
  const h = host;
  if (!h) return;
  const now = Date.now();
  for (const s of scripts) {
    if (!s.enabled || s.kind !== 'code') continue;
    const rt = rtFor(s);
    const x = rt.health;
    const lat = [...x.lat].sort((a, b) => a - b);
    const mem = h.sandbox.memoryMB?.(s.id) ?? null;
    let kv = 0;
    try {
      kv = JSON.stringify(rt.kv).length;
    } catch {
      kv = -1;
    }
    const state = rt.pausedUntil ? `PAUSED until ${clock(rt.pausedUntil)}` : rt.running ? `up ${x.upSince ? span(now - x.upSince) : '?'}` : 'NOT running';
    h.log(
      'info',
      `script "${s.name}" health (${span(now - x.since)}): ${state} · ${x.events} events, ${x.failed} failed, ${x.dropped} dropped (queue full) · handler p50 ${pctOf(lat, 50) ?? '—'} ms, p95 ${pctOf(lat, 95) ?? '—'} ms, max ${lat.length ? lat[lat.length - 1] : '—'} ms · ${x.restarts} restart(s) · sandbox ${mem ?? '—'} MB · state ${(kv / 1024).toFixed(1)} KB · watching ${rt.subscribed.size}, holding ${rt.opened.size}`,
    );
    rt.health = freshHealth(x.upSince);
  }
}

function freshRuntime(): Runtime {
  return {
    dayKey: dayKeyNow(),
    buysToday: 0,
    sellsToday: 0,
    realizedToday: 0,
    errorsInARow: 0,
    lastRunAt: null,
    lastError: null,
    lastErrorAt: null,
    firedMints: new Set(),
    lastFireAt: new Map(),
    actions: [],
    analyses: [],
    opened: new Map(),
    closed: new Map(),
    lossStreak: 0,
    coolOffUntil: null,
    subscribed: new Set(),
    calledOut: new Map(),
    kv: {},
    lastUpdateAt: new Map(),
    lastTickAt: new Map(),
    intervalSec: null,
    intervalTimers: new Map(),
    startFails: 0,
    startRetry: null,
    pausedUntil: null,
    recoveries: [],
    health: freshHealth(),
    building: 0,
    atTimers: new Map(),
    log: [],
    metrics: new Map(),
    running: false,
    queue: [],
    busy: false,
  };
}

function rtFor(s: UserScript): Runtime {
  let rt = runtimes.get(s.id);
  if (!rt) {
    rt = freshRuntime();
    runtimes.set(s.id, rt);
  }
  const today = dayKeyNow();
  if (rt.dayKey !== today) {
    rt.dayKey = today;
    rt.buysToday = 0;
    rt.sellsToday = 0;
    rt.realizedToday = 0;
  }
  return rt;
}

function pushLog(rt: Runtime, level: ScriptLogLine['level'], line: string): void {
  rt.log.push({ at: Date.now(), level, line: line.slice(0, 400) });
  if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
}

/**
 * A script's OWN bot.log / bot.warn / bot.error lines, into app.log.
 *
 * Until 2026-09-23 only bot.error reached the file; info and warn lived in the
 * script panel's memory and died with a restart — so a support bundle could
 * not show what a script was doing, and a script that logs results for later
 * analysis (scorenow's "SCORE {…}" lines) had nowhere durable to put them.
 *
 * Capped per script, because a script can log in a loop and the file is
 * 5 MB with one rotation: past SCRIPT_FILE_LINES_PER_MIN in a minute, lines
 * go to the panel only, and the next line that is written says how many
 * were skipped. The panel itself is unchanged.
 */
const SCRIPT_FILE_LINES_PER_MIN = 120;
const fileLogBudget = new Map<string, { windowStart: number; n: number; dropped: number }>();

function scriptFileLog(s: UserScript, level: ScriptLogLine['level'], line: string): void {
  const now = Date.now();
  let b = fileLogBudget.get(s.id);
  if (!b || now - b.windowStart >= 60_000) {
    const dropped = b?.dropped ?? 0;
    b = { windowStart: now, n: 0, dropped: 0 };
    fileLogBudget.set(s.id, b);
    if (dropped > 0) host?.log('warn', `script "${s.name}": ${dropped} log line(s) not written to the file (over ${SCRIPT_FILE_LINES_PER_MIN} a minute; they are in the script panel)`);
  }
  if (b.n >= SCRIPT_FILE_LINES_PER_MIN) {
    b.dropped += 1;
    return;
  }
  b.n += 1;
  host?.log(level === 'info' ? 'info' : 'warn', `script "${s.name}": ${line.slice(0, 2000)}`);
}

function slog(s: UserScript, level: ScriptLogLine['level'], line: string): void {
  pushLog(rtFor(s), level, line);
  host?.log(level === 'error' ? 'warn' : 'info', `script "${s.name}": ${line}`);
}

// ── CRUD ──────────────────────────────────────────────────────────────

// ── Scripts that ship with the app ─────────────────────────────────────
//
// 2026-09-27: one script ships to every user (bundled/scripts/*.js, read at
// build time by bundledScripts.ts). Seeded ONCE per key — switched off, in
// paper — so deleting it keeps it deleted. A new app version replaces the
// code only while the user has not edited it; resetBundled brings it back.
// Never on an unreadable file (nothing is written over a file we could not
// read), never past MAX_SCRIPTS, never code that fails validateScript.

const shaOf = (code: string): string => crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 16);

export function seedBundled(list: BundledScript[]): void {
  shipped = list;
  if (loadFailure || !filePath) return;
  let touched = false;
  for (const b of list) {
    const draft = { ...defaultScript('code'), name: b.name.slice(0, 60) || 'Script', code: b.code };
    const v = validateScript(draft);
    if (!v.ok) {
      logger.error(`automation: shipped script "${b.key}" is invalid (${v.message}) — not installed`);
      continue;
    }
    const sha = shaOf(b.code);
    const have = scripts.find((s) => s.bundled?.key === b.key);
    if (have) {
      if (have.bundled!.sha === sha) continue;
      // An EDITED copy follows the app too (2026-09-28): a shipped script
      // that turned out broken must be fixed for everyone, and an edit on
      // top of a broken base is not worth keeping in place. Nobody loses
      // work over it — the edit is kept as a script of its own, off and in
      // paper, when there is room for one.
      if (have.bundled!.edited) {
        if (scripts.length < MAX_SCRIPTS) {
          const now = Date.now();
          const keep: UserScript = {
            ...have,
            id: nextId(),
            name: `${have.name} (your edit)`.slice(0, 60),
            enabled: false,
            mode: 'paper',
            rules: { ...have.rules, conditions: [...have.rules.conditions], actions: [...have.rules.actions] },
            budget: { ...have.budget },
            inputs: { ...(have.inputs ?? {}) },
            createdAt: now,
            updatedAt: now,
          };
          delete keep.bundled;
          scripts.push(keep);
          runtimes.set(keep.id, freshRuntime());
          slog(have, 'warn', `your edited copy is kept as "${keep.name}" (off, paper); this one now follows the version shipped with the app`);
        } else {
          slog(have, 'warn', `your edits were replaced by the version shipped with this app (${MAX_SCRIPTS} scripts already, so the edit could not be kept as its own script)`);
        }
      }
      // Settings still at the old version's default follow the new default;
      // anything the user changed stays (shared/scriptInputs.ts).
      if (have.inputs && Object.keys(have.inputs).length) {
        const oldSpecs = parseInputSpecs(have.code).specs;
        const newSpecs = parseInputSpecs(b.code).specs;
        const mig = migrateInputDefaults(oldSpecs, newSpecs, have.inputs);
        if (mig.moved.length) {
          have.inputs = mig.values;
          slog(have, 'info', `settings still at their old defaults moved to the new ones: ${mig.moved.join(', ')}`);
        }
      }
      have.code = b.code;
      have.bundled = { key: b.key, sha };
      have.updatedAt = Date.now();
      slog(have, 'info', 'updated to the version shipped with this app');
      touched = true;
      if (have.enabled && have.kind === 'code') void startCode(have);
      continue;
    }
    if (bundledSeen.includes(b.key)) continue; // the user deleted it
    if (scripts.length >= MAX_SCRIPTS) {
      logger.warn(`automation: shipped script "${b.key}" not installed — ${MAX_SCRIPTS} scripts already`);
      continue;
    }
    const now = Date.now();
    const s: UserScript = { ...draft, id: nextId(), createdAt: now, updatedAt: now, enabled: false, mode: 'paper', bundled: { key: b.key, sha } };
    scripts.push(s);
    runtimes.set(s.id, freshRuntime());
    bundledSeen.push(b.key);
    touched = true;
  }
  if (touched) {
    persist();
    changed();
  }
}

export function resetBundled(id: string): { ok: boolean; message: string } {
  const s = scripts.find((x) => x.id === id);
  if (!s?.bundled) return { ok: false, message: 'Not a script that ships with the app' };
  const b = shipped.find((x) => x.key === s.bundled!.key);
  if (!b) return { ok: false, message: 'This app version no longer ships that script' };
  s.code = b.code;
  s.bundled = { key: b.key, sha: shaOf(b.code) };
  s.updatedAt = Date.now();
  slog(s, 'info', 'reset to the version shipped with this app');
  persist();
  if (s.enabled && s.kind === 'code') void startCode(s);
  changed();
  return { ok: true, message: `"${s.name}" is back to the shipped version` };
}

export function all(): UserScript[] {
  return scripts.map((s) => ({ ...s, rules: { ...s.rules, conditions: [...s.rules.conditions], actions: [...s.rules.actions] }, budget: { ...s.budget } }));
}

export function upsert(input: Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): { ok: boolean; message: string; id?: string } {
  const v = validateScript(input);
  if (!v.ok) return { ok: false, message: v.message };
  const now = Date.now();
  if (input.id) {
    const existing = scripts.find((s) => s.id === input.id);
    if (!existing) return { ok: false, message: 'Script not found' };
    const wasLiveArmed = existing.mode === 'live' && existing.enabled;
    const codeChanged = existing.code !== input.code || existing.kind !== input.kind;
    const toLive = existing.mode !== 'live' && input.mode === 'live';
    const modeChanged = existing.mode !== input.mode;
    // Moving a script to another chain is the same hazard as changing its
    // mode: the mints in `opened` are addresses on the chain it LEFT, and a
    // sell routes to the chain it is on now.
    const chainChanged = scriptChain(existing) !== scriptChain(input);
    const bundled = existing.bundled
      ? { ...existing.bundled, edited: existing.bundled.edited === true || existing.code !== input.code }
      : undefined;
    Object.assign(existing, input, { id: existing.id, createdAt: existing.createdAt, updatedAt: now });
    // Only this module decides what is a shipped script.
    if (bundled) existing.bundled = bundled;
    else delete existing.bundled;
    // Switching to live disarms: arming live is a separate, confirmed act.
    if (toLive) existing.enabled = false;
    // `opened` is the script's authority to SELL — it is what separates its own
    // bags from bags the user bought by hand. Those sets are per mode and do
    // not transfer: a mint the script "opened" in paper is a simulated fill,
    // and carrying it into live would let a script that only ever rehearsed
    // market-sell a real hand-bought bag on its first live action. Clear it in
    // BOTH directions — the live→paper case strands nothing, because a live
    // bag is still in the wallet and still sellable by hand.
    if (modeChanged || chainChanged) {
      const rt = runtimes.get(existing.id);
      if (rt && rt.opened.size) {
        slog(existing, 'info', `${chainChanged ? `chain changed to ${chainLabel(scriptChain(existing))}` : `mode changed to ${existing.mode}`} — dropping ${rt.opened.size} position(s) opened before it; this script can no longer sell them`);
        rt.opened.clear();
      }
    }
  // The kill switch is this module's invariant, not its caller's.
  if (killSwitch) existing.enabled = false;
    persist();
    if (existing.enabled && existing.kind === 'code' && codeChanged) void startCode(existing);
    if (!existing.enabled) void stopCode(existing, 'edited');
    if (existing.enabled && existing.kind === 'rules') armSchedules(existing);
    if (!wasLiveArmed && existing.mode === 'live' && existing.enabled) {
      host?.toast('warn', `LIVE script armed: "${existing.name}" — real ${nativeSymbolOf(scriptChain(existing))} will be spent within its budget`);
    }
    changed();
    return { ok: true, message: toLive ? 'Saved — switched to live, re-enable to arm it' : 'Saved', id: existing.id };
  }
  if (scripts.length >= MAX_SCRIPTS) return { ok: false, message: `Limit of ${MAX_SCRIPTS} scripts reached` };
  const s: UserScript = { ...input, id: nextId(), createdAt: now, updatedAt: now, enabled: false };
  delete s.bundled;
  scripts.unshift(s);
  runtimes.set(s.id, freshRuntime());
  persist();
  changed();
  return { ok: true, message: `Saved "${s.name}" — ${s.mode}, disabled. Enable it when ready.`, id: s.id };
}

export function remove(id: string): { ok: boolean; message: string } {
  const s = scripts.find((x) => x.id === id);
  if (!s) return { ok: false, message: 'Script not found' };
  void stopCode(s, 'removed');
  clearSchedules(rtFor(s));
  scripts = scripts.filter((x) => x.id !== id);
  const rt = runtimes.get(id);
  if (rt) clearIntervals(rt);
  runtimes.delete(id);
  persist();
  changed();
  return { ok: true, message: `Removed "${s.name}"` };
}

export function setEnabled(id: string, enabled: boolean): { ok: boolean; message: string } {
  const s = scripts.find((x) => x.id === id);
  if (!s) return { ok: false, message: 'Script not found' };
  if (enabled && killSwitch) return { ok: false, message: 'The kill switch is on — turn it off first' };
  if (enabled) {
    const v = validateScript(s);
    if (!v.ok) return { ok: false, message: v.message };
  }
  s.enabled = enabled;
  s.updatedAt = Date.now();
  const rt = rtFor(s);
  rt.errorsInARow = 0;
  persist();
  if (enabled) {
    slog(s, 'info', `enabled (${s.mode})`);
    if (s.mode === 'live') host?.toast('warn', `LIVE script armed: "${s.name}" — real ${nativeSymbolOf(scriptChain(s))} will be spent within its budget`);
    if (s.kind === 'code') void startCode(s);
    else armSchedules(s);
  } else {
    slog(s, 'info', 'disabled');
    void stopCode(s, 'disabled');
    clearSchedules(rt);
  }
  changed();
  return { ok: true, message: enabled ? `"${s.name}" is on (${s.mode})` : `"${s.name}" is off` };
}

/** Everything off at once, and nothing may be enabled until it is lifted. */
export function setKillSwitch(on: boolean): { ok: boolean; message: string } {
  killSwitch = on;
  if (on) {
    for (const s of scripts) {
      if (!s.enabled) continue;
      s.enabled = false;
      slog(s, 'warn', 'disabled by the kill switch');
      void stopCode(s, 'kill switch');
      clearSchedules(rtFor(s));
    }
  }
  persist();
  changed();
  return { ok: true, message: on ? 'Every script is off' : 'Kill switch lifted — enable scripts one by one' };
}

function disable(s: UserScript, why: string): void {
  if (!s.enabled) return;
  s.enabled = false;
  slog(s, 'error', `DISABLED — ${why}`);
  host?.toast('error', `Script "${s.name}" disabled: ${why}`);
  // A desktop notification too: a script is left running for days, and a
  // toast only reaches someone looking at the window (2026-09-27).
  host?.notify(`Script stopped: ${s.name}`, why.slice(0, 200));
  void stopCode(s, why);
  clearSchedules(rtFor(s));
  persist();
  changed();
}

// ── Snapshot ──────────────────────────────────────────────────────────

function statsFor(s: UserScript): ScriptStats {
  const rt = rtFor(s);
  return {
    buysToday: rt.buysToday,
    sellsToday: rt.sellsToday,
    realizedSolToday: rt.realizedToday,
    lossCapSol: effectiveLossCap(s, rt).cap,
    lossStreak: rt.lossStreak,
    coolOffUntil: rt.coolOffUntil,
    errorsInARow: rt.errorsInARow,
    lastRunAt: rt.lastRunAt,
    lastError: rt.lastError,
    lastErrorAt: rt.lastErrorAt,
    openCount: rt.opened.size,
    firedMints: rt.firedMints.size,
    running: s.kind === 'code' ? rt.running && (host?.sandbox.isRunning(s.id) ?? false) : s.enabled,
    pausedUntil: rt.pausedUntil,
  };
}

export function snapshot(withCode = true): ScriptSnapshot {
  const stats: Record<string, ScriptStats> = {};
  const logs: Record<string, ScriptLogLine[]> = {};
  const metrics: NonNullable<ScriptSnapshot['metrics']> = {};
  for (const s of scripts) {
    stats[s.id] = statsFor(s);
    const rt = rtFor(s);
    logs[s.id] = rt.log.slice(-SNAPSHOT_LOG_LINES);
    metrics[s.id] = [...rt.metrics].map(([name, m]) => ({ name, value: m.value, at: m.at }));
  }
  return {
    // Live updates go out on every script log line; the code is left out of
    // them (it is only needed to edit, and a full read carries it).
    scripts: withCode ? all() : all().map((s) => ({ ...s, code: '' })),
    ...(withCode ? {} : { codeOmitted: true }),
    stats,
    logs,
    metrics,
    liveBlockedReason: host?.liveBlockedReason() ?? null,
    // Per chain: a script only ever runs on one, and the reason it cannot
    // execute is that chain's. Asking Solana on behalf of a Robinhood script
    // is how an unarmed EVM rail looked like a page with nothing wrong.
    blockedByChain: {
      solana: host?.liveBlockedReason('solana') ?? null,
      robinhood: host?.liveBlockedReason('robinhood') ?? null,
      bnb: host?.liveBlockedReason('bnb') ?? null,
    },
    killSwitch,
    templates: host?.templates() ?? [],
  };
}

// ── Facts ─────────────────────────────────────────────────────────────

/** The full honest view of a token for a script: launch feed, cached
 *  market facts, its position (if held in the script's mode), globals. */
const CTX_POSITIONS_WAIT_MS = 1_500;

async function ctxFor(s: UserScript, mint: string, base?: RuleContext): Promise<RuleContext> {
  const h = host;
  const now = Date.now();
  if (!h) return base ?? emptyContext(mint);
  const row = h.launch(mint);
  // Context only, so a slow wallet read (a VPN, a 429ing endpoint) does not
  // hold bot.token for 15 s: after 1.5 s the last read (≤ 60 s old) answers.
  // Budget checks and sells still wait for a fresh read (user report 09-30).
  const pos = (await h.positions(s.mode, scriptChain(s), { maxWaitMs: CTX_POSITIONS_WAIT_MS })).find((p) => p.mint === mint) ?? null;
  // A bag the user opened by hand still lends its name to the context — the
  // script can watch it and log about it — but it is not this script's
  // POSITION. `held` means "held by this script": that is what the field guide
  // says, what the open-position cap counts, and what the script may sell.
  const mine = rtFor(s).opened.has(mint);
  c0: {
    // An EVM token's own scanner window, when there is one (2026-10-03): a
    // Robinhood/BNB script's bot.token used to be null for everything.
    if (base || row || scriptChain(s) === 'solana') break c0;
    const l = evmHooks?.launch(scriptChain(s) as EvmChainKind, mint) ?? null;
    if (l) base = contextFromEvmLaunch(l, now);
  }
  // A coin the scanner never saw launch (a graduated one) still has a name.
  const evmId = !base && !row && scriptChain(s) !== 'solana' && !pos?.symbol ? (evmHooks?.identity?.(scriptChain(s) as EvmChainKind, mint) ?? null) : null;
  let c = base ?? (row ? contextFromLaunch(row, now) : emptyContext(mint, pos?.symbol || evmId?.symbol, pos?.name || evmId?.name));
  c = withMarket(c, h.marketCached(mint, scriptChain(s)));
  c = withLaunchLinks(c, scriptChain(s) === 'solana' ? (h.launchLinks?.(mint) ?? null) : null);
  c = withLaunchIntel(c, scriptChain(s) === 'solana' ? (h.launchIntelCached?.(mint) ?? null) : null);
  c = withPosition(c, mine && pos ? withPeak(s.mode, pos) : null, now);
  // The chain's OWN wallet: an EVM script's walletSol is its chain's coin.
  c = withGlobals(c, { walletSol: h.wallet(scriptChain(s)).sol, now });
  if (scriptChain(s) !== 'solana' && (c.priceSol === null || c.priceSol === undefined)) c.priceSol = h.priceSol(mint, scriptChain(s));
  return c;
}

/** Peak price since a position was first seen, per mode — what a drawdown
 *  rule measures from. The paper book and the ledger keep no peak. */
const peaks = new Map<string, number>();

function withPeak(mode: ScriptMode, p: ScriptPosition): ScriptPosition {
  const key = `${mode}:${p.mint}`;
  const cur = p.currentPriceSol;
  const prev = peaks.get(key) ?? p.peakPriceSol ?? p.entryPriceSol ?? null;
  const peak = cur !== null && cur > 0 ? Math.max(prev ?? 0, cur) : prev;
  if (peak !== null && peak > 0) peaks.set(key, peak);
  if (peaks.size > 4_000) peaks.delete(peaks.keys().next().value as string);
  return { ...p, peakPriceSol: peak };
}

// ── Actions under budget ──────────────────────────────────────────────

/** `realizedSol`: what a sell realised — paper says exactly, a live sell
 *  answers null until its fill settles on the chain (2026-09-29). */
type ActResult = { ok: boolean; message: string; count?: number; realizedSol?: number | null };

function rateLimited(s: UserScript, rt: Runtime, now: number): boolean {
  rt.actions = rt.actions.filter((t) => now - t < 60_000);
  if (rt.actions.length >= s.budget.maxActionsPerMinute) return true;
  rt.actions.push(now);
  return false;
}

/**
 * How long a fresh buy is kept in the registry without the wallet showing it.
 *
 * The holdings read is plain HTTP, shared for 2 s, and can trail a buy that
 * the exec lane has already seen land. Pruning on the first read that missed
 * the coin is exactly the orphan a user reported (2026-09-24): the buy landed,
 * the next position poll ran before the RPC caught up, the script forgot the
 * mint, and every sell after that — named wallet and sellAll included — was
 * refused with "this script does not hold it" while the tokens sat in the
 * wallet.
 */
export const OPEN_GRACE_MS = 90_000;

/** Drop positions the script opened that are no longer held (sold by hand,
 *  stopped out by an order) so the open-position cap reflects reality.
 *
 *  Only on a read that WORKED, only after the grace, and never for a bag in
 *  another wallet. A failed read is not an empty wallet: before this, one
 *  refused getTokenAccountsByOwner cleared every script's registry at once. */
async function reconcileOpened(s: UserScript, rt: Runtime): Promise<void> {
  const h = host;
  if (!h?.heldMints || rt.opened.size === 0) return;
  const held = await h.heldMints(s.mode, scriptChain(s));
  if (!held) return;
  const now = Date.now();
  for (const [mint, e] of [...rt.opened]) {
    if (held.has(mint) || e.wallet || now - e.at < OPEN_GRACE_MS) continue;
    if (h.orders(mint).some((o) => o.kind === 'limit_buy' && (o.state === 'armed' || o.state === 'paused'))) continue;
    closeEntry(rt, mint);
  }
}

// ── The loss stop, the cool-off, and what a settled fill teaches ──────
//
// 2026-09-28: a live script ran a wallet from ~0.36 SOL to 0.013 overnight
// under a 0.5 SOL daily loss stop that read −0.0088. The stop only counted
// the script's OWN sells; 61 of its 65 exits were stop-loss and take-profit
// orders, which it never heard about. Now every reconciled sell of a bag
// the script opened is counted from the chain (host.onFillSettled), the
// stop is also a share of the wallet so it can never exceed the money in
// play, and three losing exits in a row pause buys for an hour.

/** Losing exits in a row that start the cool-off, and how long it lasts. */
export const COOL_OFF_AFTER_LOSSES = 3;
export const COOL_OFF_MS = 60 * 60_000;
/** Closed episodes remembered, so a late-settling fill still finds its bag. */
const CLOSED_KEEP = 300;

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The bag is gone from `opened`; remember what it came to. */
function closeEntry(rt: Runtime, mint: string): void {
  const e = rt.opened.get(mint);
  rt.opened.delete(mint);
  const prev = rt.closed.get(mint);
  // Re-inserted last so the map stays ordered by close time for pruning.
  rt.closed.delete(mint);
  rt.closed.set(mint, { at: Date.now(), costSol: e?.costSol ?? prev?.costSol ?? 0, realized: (prev?.realized ?? 0) + (e?.realized ?? 0), judged: prev?.judged === true && !e });
  while (rt.closed.size > CLOSED_KEEP) rt.closed.delete(rt.closed.keys().next().value as string);
}

/** The loss stop in force: the SOL figure, or the wallet share, whichever is smaller. */
function effectiveLossCap(s: UserScript, rt: Runtime): { cap: number; why: string } {
  const abs = s.budget.maxLossSolPerDay;
  const pct = s.budget.maxLossPctOfWallet ?? DEFAULT_LOSS_PCT_OF_WALLET;
  const sol = host?.wallet(scriptChain(s)).sol ?? null;
  if (typeof sol === 'number' && Number.isFinite(sol) && sol > 0 && pct > 0) {
    // What the wallet held before today's realised losses came out of it.
    const start = sol - Math.min(0, rt.realizedToday);
    const share = Math.max(0.001, (start * pct) / 100);
    if (share < abs) return { cap: Math.round(share * 1e6) / 1e6, why: `${pct}% of the ${start.toFixed(3)} ${nativeSymbolOf(scriptChain(s))} wallet` };
  }
  return { cap: abs, why: `the ${abs} ${nativeSymbolOf(scriptChain(s))} loss limit` };
}

/** Disable the script when today's realised loss has reached the stop. True when it did. */
function checkLossCap(s: UserScript, rt: Runtime): boolean {
  const { cap, why } = effectiveLossCap(s, rt);
  if (rt.realizedToday > -cap) return false;
  disable(s, `down ${Math.abs(rt.realizedToday).toFixed(3)} ${nativeSymbolOf(scriptChain(s))} today, past ${why}`);
  return true;
}

/** A bag the script opened has been fully sold: count the streak (live only). */
function noteEpisodeClosed(s: UserScript, rt: Runtime, mint: string, realized: number): void {
  if (s.mode !== 'live') return;
  if (realized < 0) rt.lossStreak += 1;
  else if (realized > 0) rt.lossStreak = 0;
  if (rt.lossStreak < COOL_OFF_AFTER_LOSSES) return;
  if (rt.coolOffUntil !== null && Date.now() < rt.coolOffUntil) return;
  rt.coolOffUntil = Date.now() + COOL_OFF_MS;
  rt.lossStreak = 0;
  const why = `${COOL_OFF_AFTER_LOSSES} losing exits in a row (last: ${mint.slice(0, 8)}) — buys are paused until ${hhmm(rt.coolOffUntil)}; sells and orders still run`;
  slog(s, 'warn', `COOLING OFF — ${why}`);
  host?.toast('warn', `Script "${s.name}" cooling off: ${why}`);
  host?.notify(`Script cooling off: ${s.name}`, why.slice(0, 200));
}

/**
 * A reconciled EVM sell (ipc.ts, from the EVM ledger) — so a Robinhood or BNB
 * script's daily loss stop and cool-off count live exits too. Until
 * 2026-10-03 only paper EVM sells reached them, and a live EVM script could
 * lose without limit.
 */
export function onEvmFillSettled(f: SettledFill & { chain: ChainKind }): void {
  onFillSettled(f);
}

/** A reconciled fill from the chain (host.onFillSettled). */
function onFillSettled(f: SettledFill): void {
  if (f.side !== 'sell' || f.realizedSol === null || !Number.isFinite(f.realizedSol)) return;
  for (const s of scripts) {
    if (s.mode !== 'live') continue;
    if (scriptChain(s) !== (f.chain ?? 'solana')) continue;
    const rt = rtFor(s);
    const open = rt.opened.get(f.mint);
    const closed = rt.closed.get(f.mint);
    if (!open && !closed) continue;
    // Another wallet's fill of the same mint is not this script's exit.
    const owner = open?.wallet ?? null;
    if (owner && f.wallet && f.wallet !== owner) continue;
    rt.realizedToday += f.realizedSol;
    if (open) open.realized = (open.realized ?? 0) + f.realizedSol;
    else if (closed) closed.realized += f.realizedSol;
    slog(
      s,
      f.realizedSol < 0 ? 'warn' : 'info',
      `exit on ${f.mint.slice(0, 8)} realised ${f.realizedSol >= 0 ? '+' : ''}${f.realizedSol.toFixed(4)} ${nativeSymbolOf(scriptChain(s))} (from the chain, ${f.requested}% sold) — today ${rt.realizedToday >= 0 ? '+' : ''}${rt.realizedToday.toFixed(4)} ${nativeSymbolOf(scriptChain(s))}`,
    );
    // A full sell ends the episode; judge it once.
    if (f.requested >= 100) {
      if (open) closeEntry(rt, f.mint);
      const e = rt.closed.get(f.mint);
      if (e && !e.judged) {
        e.judged = true;
        noteEpisodeClosed(s, rt, f.mint, e.realized);
      }
    }
    checkLossCap(s, rt);
    persist();
    changed();
  }
}

function refuse(s: UserScript, why: string): ActResult {
  slog(s, 'warn', `refused — ${why}`);
  return { ok: false, message: why };
}

/** The budget gate every BUY-like action passes: caps, live gates, size. */
async function buyGate(s: UserScript, rt: Runtime, mint: string, sol: number, what: string, wallet: { address?: string | null } = {}, lane: FeeLane = 'fast', topUp = false): Promise<ActResult | null> {
  const h = host as AutomationHost;
  if (!Number.isFinite(sol) || sol <= 0) return refuse(s, `buy ${what}: amount must be a positive number of SOL`);
  if (sol > s.budget.maxSolPerTrade) return refuse(s, `buy ${what}: ${sol} ${nativeSymbolOf(scriptChain(s))} is over the script's max per trade (${s.budget.maxSolPerTrade})`);
  if (rt.buysToday >= s.budget.maxBuysPerDay) return refuse(s, `buy ${what}: ${s.budget.maxBuysPerDay} buys today already`);
  if (checkLossCap(s, rt)) return { ok: false, message: 'daily loss limit' };
  if (rt.coolOffUntil !== null) {
    if (Date.now() < rt.coolOffUntil) return refuse(s, `buy ${what}: cooling off after ${COOL_OFF_AFTER_LOSSES} losing exits in a row, until ${hhmm(rt.coolOffUntil)}`);
    rt.coolOffUntil = null;
    rt.lossStreak = 0;
  }
  await reconcileOpened(s, rt);
  if (!rt.opened.has(mint) && rt.opened.size >= s.budget.maxOpenPositions) return refuse(s, `buy ${what}: already holding ${rt.opened.size} positions (max ${s.budget.maxOpenPositions})`);
  if (s.mode === 'live') {
    // The master switch still applies — armed, execution on, no breaker. That
    // is not a rule a script gets to have its own version of; it is the app
    // being off.
    const blocked = h.liveBlockedReason(scriptChain(s)) ?? h.buyBlockedReason(scriptChain(s));
    if (blocked) return refuse(s, `buy ${what}: not executed — ${blocked}`);
    // A live Krypto Trader session holds this coin in this wallet (the active
    // one unless a wallet was named): a script buying into it would mix its
    // bag with the session's, and the session would pause on the fill.
    // Orders are refused in engine.createOrder, which every order path uses.
    // On BNB / Robinhood the pair is (chain, the chain's signer, coin) — a
    // claim there is not a claim on Solana, and the reverse (stage 4).
    const chain = scriptChain(s);
    const claim =
      chain === 'solana'
        ? traderClaimFor(wallet.address ? { address: wallet.address } : { walletId: null }, mint)
        : traderClaimFor({ walletId: null, address: wallet.address ?? null, chain }, mint);
    if (claim) return refuse(s, `buy ${what}: not executed — ${claim}`);
    // The two priority-fee floors are a fixed cost of every live Solana round
    // trip; on a 0.016 SOL bag they were 19 % (2026-09-28). A script may not
    // size a real buy so that they take more than a tenth of it. Paper pays
    // no fee and rehearses any size. Last of the live checks: an engine that
    // is not armed says so before a size is judged.
    // Keep the gas to SELL (EVM, 2026-10-03). A Solana buy is trimmed by the
    // engine (planBuySize); the EVM rail spent to the last wei, leaving a bag
    // it could not pay gas to exit. A buy being topped up is funded with this
    // reserve already (aioConvert fundedTarget).
    if (chain !== 'solana' && !topUp) {
      const named = wallet.address ? evmHooks?.wallets(chain as EvmChainKind).find((w) => w.address.toLowerCase() === wallet.address?.toLowerCase()) : undefined;
      const held = wallet.address ? (named?.native ?? null) : h.wallet(chain).sol;
      const keep = EXIT_GAS[chain] ?? 0;
      if (held !== null && sol * 1.005 + keep > held) {
        return refuse(s, `buy ${what}: ${sol} would leave less than ${keep} ${nativeSymbolOf(chain)} to pay gas to sell it (the wallet holds ${held.toPrecision(4)})${aioHooks?.active() ? ' — pass {topUp: true} to fund it from your other chains' : ''}`);
      }
    }
    if (chain === 'solana') {
      const share = roundTripFeeShare(sol, lane);
      if (share > MAX_UNATTENDED_FEE_SHARE) {
        return refuse(s, `buy ${what}: ${sol} SOL would pay ${Math.round(share * 100)}% of itself in priority fees on the round trip — the smallest live buy is ${minUnattendedBuySol(lane)} SOL on the ${lane} lane${lane === 'fast' ? ` (${minUnattendedBuySol('lean')} SOL with {lane: 'lean'})` : ''}`);
      }
    }
    // The app's MANUAL per-trade cap deliberately does NOT apply (2026-09-22).
    // `maxSolPerTrade` above is this script's own, set on the same screen as
    // its code, and it is the authority on its size. Two caps for one decision
    // meant keeping them in step, with the smaller winning silently to whoever
    // set the other. `testTrade` is told the script's number so the backstop
    // there enforces that one instead of the manual cap.
  }
  return null;
}

/** What `bot.cancelOrders(mint, kinds)` may name. */
const CANCEL_KINDS: readonly OrderKind[] = [
  'stop_loss',
  'take_profit',
  'trailing_stop',
  'limit_buy',
  'limit_sell',
  'sell_on_dev_sell',
  'sell_on_migration',
  'buy_on_migration',
];

function orderKindOf(a: RuleAction): OrderKind | null {
  switch (a.type) {
    case 'stop_loss':
      return 'stop_loss';
    case 'take_profit':
      return 'take_profit';
    case 'trailing_stop':
      return 'trailing_stop';
    case 'limit_buy':
      return 'limit_buy';
    case 'limit_sell':
      return 'limit_sell';
    default:
      return null;
  }
}

/**
 * Every action from one script runs strictly after the previous one.
 *
 * Without this the budget is not a budget: `buyGate` reads the counters, then
 * awaits (positions, then the buy itself), and only then increments — so every
 * action that starts while an earlier buy is on the wire sees the pre-increment
 * numbers. The engine drives scripts fire-and-forget (ipc.ts calls
 * `onEngineEvent` from the emit callback, and `fanOut` dispatches one detached
 * promise per event), and the DEFAULT rule is `launch_update` → buy, so this is
 * the shipped configuration, not an adversarial one: measured 2026-09-09, a
 * budget of 2 buys of 0.05 SOL executed 14 buys for 0.700 SOL.
 */
const actChains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after everything else this script has in flight.
 *
 * Anything that reads a budget counter and later increments it must go through
 * here, not just `act()`. `bot.order()`'s migration kinds place directly and
 * were the one spending path left outside the chain: measured 2026-09-09, a
 * budget of 1 buy/day and 0.05 SOL armed 36 `buy_on_migration` orders and
 * committed 1.80 SOL, while `bot.buy` on the identical budget executed once.
 */
function chain<T>(s: UserScript, fn: () => Promise<T>): Promise<T> {
  const prev = actChains.get(s.id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  actChains.set(s.id, next.catch(() => undefined));
  return next;
}

/** Per-trade options a script may pass (2026-09-27). `slippagePct` replaces
 *  the execution setting for this one trade; the host bounds it. */
export interface ScriptTradeOpts {
  slippagePct?: number;
  /** 'lean' = live-median priority, no floor, no tips (2026-09-29). */
  feeLane?: FeeLane;
}

/** What a call may add to an action that the rule form has no field for:
 *  an order's expiry (epoch ms; null / absent = never expires), a trade's
 *  slippage, a sell sized in TOKENS rather than percent. */
interface ActOpts {
  expiresAt?: number | null;
  slippagePct?: number;
  /** The fee lane for this one trade; absent = 'fast'. */
  feeLane?: FeeLane;
  /** Sell this many tokens (UI units) — converted to a percent of the
   *  position the app can see, in sellOne. */
  tokens?: number;
  /** Fund this buy from the All-in-One wallet's other chains when its own
   *  chain is short (live only). */
  topUp?: boolean;
}

/** Slippage a script may ask for on one trade: a percent from 0.1 to 50. */
const SLIPPAGE_MIN = 0.1;
const SLIPPAGE_MAX = 50;

/**
 * The trailing argument of bot.buy / bot.sell: an ADDRESS (a string) or an
 * options object {wallet, slippagePct}. Anything else is a bad call, never
 * "the trading wallet with defaults" — a typo in a wallet address must not
 * quietly spend from the main wallet.
 */
function tradeExtras(v: unknown, what: string): { ok: true; wallet: string; slippagePct?: number; feeLane?: FeeLane; topUp?: boolean } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, wallet: '' };
  if (typeof v === 'string') return { ok: true, wallet: v.trim() };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `${what}: the last argument is a wallet address or an options object` };
  const o = v as Record<string, unknown>;
  const wallet = o.wallet === undefined || o.wallet === null ? '' : typeof o.wallet === 'string' ? o.wallet.trim() : null;
  if (wallet === null) return { ok: false, error: `${what}: wallet must be an address` };
  let slippagePct: number | undefined;
  if (o.slippagePct !== undefined && o.slippagePct !== null) {
    const n = Number(o.slippagePct);
    if (!Number.isFinite(n) || n < SLIPPAGE_MIN || n > SLIPPAGE_MAX) return { ok: false, error: `${what}: slippagePct must be ${SLIPPAGE_MIN}–${SLIPPAGE_MAX}` };
    slippagePct = n;
  }
  let feeLane: FeeLane | undefined;
  if (o.lane !== undefined && o.lane !== null) {
    if (typeof o.lane !== 'string' || !(FEE_LANES as readonly string[]).includes(o.lane)) return { ok: false, error: `${what}: lane must be one of ${FEE_LANES.join(', ')}` };
    feeLane = o.lane as FeeLane;
  }
  if (o.topUp !== undefined && typeof o.topUp !== 'boolean') return { ok: false, error: `${what}: topUp must be true or false` };
  return { ok: true, wallet, slippagePct, ...(feeLane ? { feeLane } : {}), ...(o.topUp === true ? { topUp: true } : {}) };
}

function act(s: UserScript, action: RuleAction, ctx: RuleContext | null, opts: ActOpts = {}): Promise<ActResult> {
  return chain(s, () => actInner(s, action, ctx, opts));
}

async function actInner(s: UserScript, action: RuleAction, ctx: RuleContext | null, opts: ActOpts = {}): Promise<ActResult> {
  const h = host;
  if (!h) return { ok: false, message: 'no host' };
  const rt = rtFor(s);
  const now = Date.now();
  const mint = ctx?.mint ?? '';
  const what = ctx?.symbol || mint.slice(0, 8);
  const spec = RULE_ACTIONS.find((x) => x.id === action.type);
  if (!s.enabled) return { ok: false, message: 'script is disabled' };
  if (!spec) return refuse(s, 'unknown action');
  // Chain gate, second of two. `validateScript` already refuses a RULES script
  // built on a Solana-only action, but a CODE script picks its action at
  // runtime and never passed that check — and advanced orders and alerts have
  // no EVM implementation at all, so attempting one would place a Solana order
  // against a token on another chain. Refused with the reason, never ignored.
  if (!actionAvailableOn(action.type, scriptChain(s))) {
    return refuse(s, `${spec.label.toLowerCase()}: not available on ${chainLabel(scriptChain(s))} — advanced orders and alerts are Solana-only`);
  }
  if (spec.needsMint && !mint) return refuse(s, `${action.type}: no token`);
  if (rateLimited(s, rt, now)) {
    const msg = `refused ${action.type}: over ${s.budget.maxActionsPerMinute} actions in a minute`;
    slog(s, 'warn', msg);
    return { ok: false, message: msg };
  }

  switch (action.type) {
    case 'buy': {
      const sol = Number(action.sol);
      const topUp = opts.topUp === true && s.mode === 'live';
      const gate = await buyGate(s, rt, mint, sol, what, {}, opts.feeLane ?? 'fast', topUp);
      if (gate) return gate;
      // The gate awaited: re-read the arm bit before spending. The kill switch
      // says "every script is off" and must not be overtaken by a buy that was
      // already past its checks.
      if (!s.enabled || killSwitch) return { ok: false, message: 'script is disabled' };
      // All-in-One: fund this chain from the others first — never a costly
      // top-up unattended, never a buy on money that has not arrived. Paper
      // spends nothing, so it needs no money moved.
      let funded: unknown | null = null;
      if (topUp) {
        if (!aioHooks || !aioHooks.active()) return refuse(s, `buy ${what}: {topUp} needs the All-in-One wallet signing on every chain`);
        const f = await aioHooks.fund(scriptChain(s), sol);
        if (!f.ok) return refuse(s, `buy ${what}: not funded — ${f.message}`);
        funded = f.funded;
        if (funded) slog(s, 'info', `buy ${what}: ${f.message}`);
        if (!s.enabled || killSwitch) return { ok: false, message: 'script is disabled' };
      }
      const tradeOpts: ScriptTradeOpts = { ...(opts.slippagePct !== undefined ? { slippagePct: opts.slippagePct } : {}), ...(opts.feeLane ? { feeLane: opts.feeLane } : {}) };
      const r = await h.buy(mint, sol, s.mode, scriptChain(s), s.budget.maxSolPerTrade, Object.keys(tradeOpts).length ? tradeOpts : undefined);
      if (!(r.ok || r.pending) && funded && aioHooks) {
        // The owner's rule: a top-up no buy paid for is billed as a move.
        const billed = await aioHooks.bill(funded).catch(() => '');
        slog(s, 'warn', `buy ${what} failed after its top-up: ${r.message}${billed}`);
        return { ok: false, message: r.message };
      }
      if (r.ok || r.pending) {
        rt.buysToday += 1;
        rt.opened.set(mint, openedWithBuy(rt.opened.get(mint), sol, now, r.signature));
        h.subscribeTicks(mint);
        slog(s, 'info', `${s.mode === 'paper' ? 'PAPER ' : ''}buy ${what} ${sol} ${nativeSymbolOf(scriptChain(s))}: ${r.message}${r.pending ? ' (pending)' : ''}`);
        recorder.record('script_buy', { scriptId: s.id, name: s.name, mode: s.mode, mint, sol, ok: r.ok, signature: r.signature ?? null });
        persist();
        changed();
        return { ok: true, message: r.message };
      }
      slog(s, 'warn', `buy ${what} ${sol} ${nativeSymbolOf(scriptChain(s))} failed: ${r.message}`);
      return { ok: false, message: r.message };
    }
    case 'sell': {
      // A sell sized in TOKENS carries a placeholder percent; sellOne turns
      // the quantity into the share it really is against the position it can
      // see, and refuses when it cannot see one.
      if (opts.tokens !== undefined) return sellOne(s, rt, mint, 100, what, { slippagePct: opts.slippagePct, tokens: opts.tokens, feeLane: opts.feeLane });
      const pct = Math.round(Number(action.pct));
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return refuse(s, 'sell: percent must be 1–100');
      return sellOne(s, rt, mint, pct, what, { slippagePct: opts.slippagePct, feeLane: opts.feeLane });
    }
    case 'sell_all': {
      // "Everything THIS SCRIPT holds" — which is what the action's own label,
      // the `held` fact and the shipped example all promise. `h.positions`
      // returns the whole wallet, so a schedule rule armed from the built-in
      // "Daily housekeeping" example would otherwise market-sell every bag the
      // user bought by hand.
      const held = (await h.positions(s.mode, scriptChain(s))).filter((p) => rt.opened.has(p.mint));
      if (!held.length) return refuse(s, 'sell everything: this script holds nothing');
      let sold = 0;
      for (const p of held) {
        const r = await sellOne(s, rt, p.mint, 100, p.symbol || p.mint.slice(0, 8));
        if (r.ok) sold += 1;
        if (!s.enabled) break;
      }
      return { ok: sold > 0, message: `sold ${sold} of ${held.length} positions`, count: sold };
    }
    case 'stop_loss':
    case 'take_profit':
    case 'trailing_stop':
    case 'limit_buy':
    case 'limit_sell': {
      const kind = orderKindOf(action) as OrderKind;
      const isBuy = kind === 'limit_buy';
      const amount = action.type === 'limit_buy' ? action.sol : action.type === 'take_profit' ? action.sellPct : action.type === 'limit_sell' ? action.pct : 100;
      const basis: TriggerBasis = action.type === 'limit_buy' || action.type === 'limit_sell' ? action.basis : 'pct';
      const triggerValue = action.type === 'limit_buy' || action.type === 'limit_sell' ? action.value : action.type === 'take_profit' ? action.gainPct : action.pct;
      if (isBuy) {
        const gate = await buyGate(s, rt, mint, Number(amount), what);
        if (gate) return gate;
      } else if (!(await h.positions(s.mode, scriptChain(s))).some((p) => p.mint === mint)) {
        return refuse(s, `${spec.label.toLowerCase()} ${what}: nothing held in ${s.mode} mode`);
      }
      if (s.mode === 'paper') {
        // Advanced orders execute for real. A paper script keeps its paper.
        slog(s, 'info', `PAPER ${describeAction(action)} on ${what} — recorded, not placed (orders execute for real; switch the script to live to place them)`);
        return { ok: true, message: 'paper: order noted, not placed' };
      }
      const r = await h.placeOrder({ mint, symbol: ctx?.symbol ?? '', kind, triggerBasis: basis, triggerValue, amount: Number(amount), expiresAt: opts.expiresAt ?? null });
      if (r.ok && isBuy) {
        rt.buysToday += 1;
        rt.opened.set(mint, openedWithBuy(rt.opened.get(mint), Number(amount), now, null));
      }
      // "armed" / "NOT armed" up front: "take profit +100% sell 50% on X" read as a
      // sale that happened (09-24) when it was only the order being placed.
      slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'armed' : 'NOT armed'} ${describeAction(action)} on ${what}: ${r.message}`);
      recorder.record('script_order', { scriptId: s.id, name: s.name, mint, kind, basis, triggerValue, amount, ok: r.ok });
      if (r.ok) changed();
      return r;
    }
    case 'cancel_orders': {
      const r = h.cancelOrders(mint, action.kinds);
      slog(s, 'info', `cancel ${action.kinds?.length ? `${action.kinds.join('/')} ` : ''}orders on ${what}: ${r.message}`);
      return { ok: r.ok, message: r.message, count: r.cancelled };
    }
    case 'apply_template': {
      if (!(await h.positions(s.mode, scriptChain(s))).some((p) => p.mint === mint)) return refuse(s, `apply template ${what}: nothing held in ${s.mode} mode`);
      if (s.mode === 'paper') {
        slog(s, 'info', `PAPER apply template on ${what} — noted, not placed (orders execute for real)`);
        return { ok: true, message: 'paper: template noted, not placed' };
      }
      const r = await h.applyTemplate(mint, action.templateId);
      slog(s, r.ok ? 'info' : 'warn', `apply template on ${what}: ${r.message}`);
      return r;
    }
    case 'alert': {
      if (!ALERT_KINDS.includes(action.kind)) return refuse(s, 'alert: unknown kind');
      const r = h.createAlert({ kind: action.kind, mint, symbol: ctx?.symbol ?? '', threshold: Number(action.threshold), repeat: false });
      slog(s, r.ok ? 'info' : 'warn', `alert ${action.kind} ${action.threshold} on ${what}: ${r.message}`);
      return r;
    }
    case 'watch': {
      h.pin(mint, true);
      h.subscribeTicks(mint);
      subscribe(rt, mint);
      slog(s, 'info', `watch ${what}`);
      persist();
      return { ok: true, message: 'watching' };
    }
    case 'unwatch': {
      h.pin(mint, false);
      rt.subscribed.delete(mint);
      slog(s, 'info', `unwatch ${what}`);
      persist();
      return { ok: true, message: 'unwatched' };
    }
    case 'notify': {
      const text = fill(action.message, ctx);
      h.notify(`Script: ${s.name}`, text);
      h.toast('info', `${s.name}: ${text}`);
      slog(s, 'info', `notify: ${text}`);
      return { ok: true, message: 'sent' };
    }
    case 'log': {
      slog(s, 'info', fill(action.message, ctx));
      return { ok: true, message: 'logged' };
    }
    case 'disable_self': {
      disable(s, 'turned itself off');
      return { ok: true, message: 'disabled' };
    }
    default:
      return refuse(s, 'unknown action');
  }
}

async function sellOne(s: UserScript, rt: Runtime, mint: string, pct: number, what: string, extra: { slippagePct?: number; tokens?: number; feeLane?: FeeLane } = {}): Promise<ActResult> {
  const h = host as AutomationHost;
  // Only what this script opened — the same rule as sell_all. `h.positions`
  // is the whole wallet; a script must never be able to exit a position the
  // user opened by hand.
  if (!rt.opened.has(mint)) return refuse(s, `sell ${what}: this script does not hold it`);
  const held = await h.positions(s.mode, scriptChain(s));
  const before = held.find((p) => p.mint === mint);
  // A quantity, not a share (2026-09-27). Converted here against the position
  // the app can SEE, so the sell rail — percentage-of-balance all the way
  // down — gets the share the tokens really are. Unknown size = refused, not
  // guessed: a buy seconds old has no holdings row yet and would otherwise
  // read as "sell 100 %". The share-of-cost cap further down still applies,
  // so a script cannot sell hand-bought tokens by naming a big enough number.
  if (extra.tokens !== undefined) {
    const want = Number(extra.tokens);
    if (!Number.isFinite(want) || want <= 0) return refuse(s, `sell ${what}: tokens must be a positive number`);
    const size = before?.tokens ?? null;
    if (size === null || !Number.isFinite(size) || size <= 0) return refuse(s, `sell ${what}: the position's size is not known yet — sell a percent, or try again next pass`);
    // Rounded UP to a hundredth of a percent: selling short and leaving dust
    // is the failure this exists to avoid; one basis point over is not.
    pct = Math.max(0.01, Math.min(100, Math.ceil((want / size) * 10_000) / 100));
  }
  // A live buy this script made moments ago may not be in the holdings read
  // yet. The sell reads the balance itself when it builds, so let it go and
  // let the chain answer; it sells the percentage asked for, the same branch
  // an unknown basis takes below. Past the grace, absence means gone.
  const fresh = s.mode === 'live' && Date.now() - (rt.opened.get(mint)?.at ?? 0) < OPEN_GRACE_MS;
  if (!before && !fresh) return refuse(s, `sell ${what}: nothing held in ${s.mode} mode`);
  if (s.mode === 'live') {
    const blocked = h.liveBlockedReason(scriptChain(s));
    if (blocked) return refuse(s, `sell ${what}: not executed — ${blocked}`);
  }
  // `pct` is a percentage of the WHOLE wallet holding, and the guard above is
  // only mint-granular: it proves the script opened this mint, not that it
  // owns all of it. A script that bought 0.01 SOL of a bag the user then
  // hand-added 5.0 SOL to would sell all 5.01 on a `sell 100%`.
  //
  // So scale by the script's share of the cost basis — the same construction
  // copyTrade.ts `walletPctFor` already uses, and the reason `opened` carries
  // costSol at all. `Math.max(1, …)` because a share that rounds to zero must
  // still be able to exit; this only ever shrinks the sell, never grows it.
  //
  // Both sides of the ratio must be the same kind of number. The wallet's
  // cost is the ledger's ALL-IN spend (priority fee, tip, token-account rent
  // included); the script's used to be the SOL it asked to spend. On a 0.016
  // SOL buy that is ~0.0027 SOL apart, so every "sell 100%" of a bag only the
  // script ever bought sold 92–99% and left dust that later cost more to sell
  // than it was worth (09-25: FOMOFY 96%, Gavel 92%, LIABCAT 94%…). So price
  // the script's own buys from the chain too, when every one of them is known.
  const entry = rt.opened.get(mint);
  let ourCost = entry?.costSol ?? 0;
  if (entry?.sigs?.length && !entry.sigless && h.spentSolFor) {
    const chainCost = h.spentSolFor(entry.sigs);
    if (chainCost !== null && Number.isFinite(chainCost) && chainCost > 0) ourCost = chainCost;
  }
  // EVM: the ledger prices the wallet's basis with gas and fee legs, and the
  // script only knows what it asked to spend, so the ratio came out at 97–99 %
  // and "sell 100 %" left dust (the 09-25 Solana bug again). When every buy of
  // this bag was the script's own, its share IS the whole bag (2026-10-03).
  if (scriptChain(s) !== 'solana' && entry?.sigs?.length && before) {
    const whole = evmHooks?.ownsWholeBag(scriptChain(s) as EvmChainKind, mint, entry.sigs) ?? null;
    const wc = before.costSol;
    if (whole === true && wc !== null && Number.isFinite(wc) && wc > 0) ourCost = wc;
  }
  let pctOfWallet = pct;
  // An UNKNOWN wallet basis means the script cannot work out its own share, so
  // it sells the percentage it asked for rather than guessing a ratio — the
  // same branch an unreconciled Solana position already took.
  const walletCost = before ? before.costSol : null;
  if (walletCost !== null && Number.isFinite(walletCost) && walletCost > 0 && ourCost > 0) {
    const ratio = Math.min(1, ourCost / walletCost);
    // A PERCENT is a share of the script's own part of the bag, so it scales
    // by the share. A QUANTITY is already an absolute share of the whole
    // holding, so the script's share is a CEILING on it, not a multiplier —
    // scaling it sold want × ratio tokens (audit 2026-09-27: 500 of a 2,000
    // bag the script half-owns came out as 250). Two decimals for a quantity,
    // or a 250-token sell of a 100,000-token bag rounds to 0.
    pctOfWallet =
      extra.tokens !== undefined
        ? Math.max(0.01, Math.min(pct, Math.round(ratio * 10_000) / 100))
        : Math.max(1, Math.min(100, Math.round(pct * ratio)));
  }
  const sellOpts: ScriptTradeOpts = { ...(extra.slippagePct !== undefined ? { slippagePct: extra.slippagePct } : {}), ...(extra.feeLane ? { feeLane: extra.feeLane } : {}) };
  const r = await h.sell(mint, pctOfWallet, s.mode, scriptChain(s), Object.keys(sellOpts).length ? sellOpts : undefined);
  if (r.ok || r.pending) {
    rt.sellsToday += 1;
    // Paper says exactly what it realised, and the stop counts it here. A
    // LIVE sell is counted when its fill settles on the chain
    // (onFillSettled) — the same path a stop-loss order's sell takes — so
    // nothing is booked twice and nothing is an estimate. Until 2026-09-28
    // the position's PnL at the moment of the sell stood in, which under-
    // counted every exit and missed the orders' entirely.
    const realized = typeof r.realizedSol === 'number' && Number.isFinite(r.realizedSol) ? r.realizedSol : null;
    if (realized !== null) rt.realizedToday += realized;
    if (pct >= 100) {
      closeEntry(rt, mint);
      if (realized !== null) noteEpisodeClosed(s, rt, mint, realized);
    }
    slog(s, 'info', `${s.mode === 'paper' ? 'PAPER ' : ''}sell ${pct}% ${what}: ${r.message}${realized !== null ? ` (realised ${realized >= 0 ? '+' : ''}${realized.toFixed(4)} ${nativeSymbolOf(scriptChain(s))}${typeof r.realizedSol === 'number' ? '' : ', estimated'})` : ''}`);
    recorder.record('script_sell', { scriptId: s.id, name: s.name, mode: s.mode, mint, pct, ok: r.ok, realizedSol: realized, signature: r.signature ?? null });
    persist();
    changed();
    checkLossCap(s, rt);
    return { ok: true, message: r.message, realizedSol: realized };
  }
  slog(s, 'warn', `sell ${pct}% ${what} failed: ${r.message}`);
  return { ok: false, message: r.message };
}

function subscribe(rt: Runtime, mint: string): void {
  rt.subscribed.add(mint);
  while (rt.subscribed.size > MAX_SUBSCRIBED) rt.subscribed.delete(rt.subscribed.values().next().value as string);
}

/** `{symbol}`, `{mint}`, `{score}`, `{pnlPct}`… in a message. */
function fill(template: string, ctx: RuleContext | null): string {
  if (!ctx) return template;
  return template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = (ctx as unknown as Record<string, unknown>)[key];
    if (v === undefined) return m;
    if (v === null) return '—';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : Math.abs(v) < 0.001 ? v.toPrecision(4) : v.toFixed(3);
    return Array.isArray(v) ? v.join(',') : String(v);
  });
}

// ── Rules ─────────────────────────────────────────────────────────────

async function runRules(s: UserScript, ctx: RuleContext): Promise<void> {
  const r = s.rules;
  const rt = rtFor(s);
  const now = Date.now();
  const key = ctx.mint || `@${r.atHHMM ?? 'schedule'}`;
  if (r.oncePerMint && ctx.mint && rt.firedMints.has(key)) return;
  const last = rt.lastFireAt.get(key);
  if (last !== undefined && now - last < r.cooldownSec * 1000) return;
  const ev = evaluateRules(r, ctx);
  if (!ev.fire) return;
  if (ctx.mint) rt.firedMints.add(key);
  rt.lastFireAt.set(key, now);
  rt.lastRunAt = now;
  slog(s, 'info', `fired${ctx.mint ? ` on ${ctx.symbol || ctx.mint.slice(0, 8)}` : ''} — ${describeRules(r)}`);
  for (const a of r.actions) {
    const res = await act(s, a, ctx);
    if (!s.enabled) break;
    // A refused or failed trade ends the firing: the actions after a buy
    // are written assuming it happened ("log bought", "place stop").
    if (!res.ok && TRADE_ACTIONS.has(a.type)) break;
  }
  persist();
}

const TRADE_ACTIONS = new Set<RuleAction['type']>(['buy', 'sell', 'sell_all', 'stop_loss', 'take_profit', 'trailing_stop', 'limit_buy', 'limit_sell', 'apply_template']);

// ── Schedules ─────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function msUntil(hhmm: string, now = Date.now()): number | null {
  const m = HHMM.exec(hhmm);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 3_600_000;
  return t - now;
}

/**
 * A daily time is checked against the WALL CLOCK in short steps rather than
 * one timer for up to 24 h (2026-09-27). One long timer runs on the
 * process's own clock, which does not follow the wall: a laptop that slept,
 * a clock the OS corrected, a daylight-saving change — each left `bot.at`
 * firing at the wrong local time, or hours late, with nothing said.
 */
let AT_STEP_MS = 60_000;
/** Test seam: check schedules every `ms` instead of every minute. */
export function _setAtStep(ms: number | null): void {
  AT_STEP_MS = ms ?? 60_000;
}
/** Woken this long after the time (asleep through it): skip the day, say so. */
export const AT_LATE_MS = 5 * 60_000;

/** What a schedule check should do at `now` for a time due at `target`. */
export function scheduleStep(target: number, now: number): 'wait' | 'fire' | 'missed' {
  if (now < target) return 'wait';
  return now - target <= AT_LATE_MS ? 'fire' : 'missed';
}

function armAt(s: UserScript, rt: Runtime, hhmm: string): boolean {
  const wait = msUntil(hhmm);
  if (wait === null) return false;
  // Kept as a LOCAL date and time, turned into a timestamp at every check, so
  // a daylight-saving change in between moves the moment with the clock.
  const d = new Date(Date.now() + wait);
  const due = (): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0).getTime();
  const prev = rt.atTimers.get(hhmm);
  if (prev) clearTimeout(prev);
  const check = (): void => {
    rt.atTimers.delete(hhmm);
    if (!s.enabled) return;
    const now = Date.now();
    const target = due();
    const step = scheduleStep(target, now);
    if (step === 'wait') {
      rt.atTimers.set(hhmm, setTimeout(check, Math.min(AT_STEP_MS, Math.max(0, target - now))));
      return;
    }
    if (step === 'missed') {
      slog(s, 'warn', `daily ${hhmm} missed — the app was not running at that time (the computer slept, or the clock moved); next one tomorrow`);
      armAt(s, rt, hhmm);
      return;
    }
    void fireSchedule(s, hhmm).finally(() => {
      if (s.enabled) armAt(s, rt, hhmm);
    });
  };
  rt.atTimers.set(hhmm, setTimeout(check, Math.min(AT_STEP_MS, wait)));
  return true;
}

async function fireSchedule(s: UserScript, hhmm: string): Promise<void> {
  const h = host;
  if (!h) return;
  if (s.kind === 'rules') {
    const c = withGlobals(emptyContext(''), { walletSol: h.wallet().sol, now: Date.now() });
    await runRules(s, c);
  } else {
    enqueue(s, 'schedule', { at: hhmm });
  }
}

function armSchedules(s: UserScript): void {
  const rt = rtFor(s);
  clearSchedules(rt);
  if (s.kind === 'rules' && s.rules.trigger === 'schedule' && s.rules.atHHMM) armAt(s, rt, s.rules.atHHMM);
}

function clearSchedules(rt: Runtime): void {
  for (const t of rt.atTimers.values()) clearTimeout(t);
  rt.atTimers.clear();
}

// ── Code scripts ──────────────────────────────────────────────────────

/** One start at a time per script. Saving a script while its sandbox is still
 *  coming up used to race: the first start's failure path fired against the
 *  second start's healthy box and disabled the script with the wrong reason. */
const startChains = new Map<string, Promise<void>>();

function startCode(s: UserScript): Promise<void> {
  const prev = startChains.get(s.id) ?? Promise.resolve();
  const run = (): Promise<void> => startCodeInner(s);
  const next = prev.then(run, run);
  startChains.set(
    s.id,
    next.catch(() => undefined),
  );
  return next;
}

async function startCodeInner(s: UserScript): Promise<void> {
  const h = host;
  if (!h) return;
  // A script can reach here from a restart or from startup without ever
  // passing the save path's validation — an oversized or empty body would
  // start a renderer only to fail in the harness.
  // The arm bit is re-read here, not where the start was queued: a kill
  // switch or a disable that landed while this call waited its turn wins.
  if (!s.enabled || killSwitch) return;
  const v = validateScript(s);
  if (!v.ok) {
    disable(s, `will not start: ${v.message}`);
    return;
  }
  const rt = rtFor(s);
  // Any start supersedes a pending one — a pause's timed restart or a retry.
  // Without this, arming a paused script by hand started it now AND again
  // when the pause ran out, wiping the fresh run's memory.
  if (rt.startRetry) {
    clearTimeout(rt.startRetry);
    rt.startRetry = null;
  }
  rt.pausedUntil = null;
  rt.running = false;
  clearSchedules(rt);
  // The last run's bot.every too: a restart (watchdog, crash, an edit) goes
  // through here without stopCode, and a new run that no longer calls
  // bot.every kept receiving the old one's timer for the life of the app.
  clearIntervals(rt);
  rt.intervalSec = null;
  const chain = scriptChain(s);
  // Coerced against the code being STARTED, so a script whose @inputs block
  // was edited without re-answering the form gets the declared shape rather
  // than yesterday's answers in yesterday's shape.
  // Webhook answers go in redacted: the URL is a credential the script has
  // no use for (bot.discord names the field, see 'discord' below).
  const { inputsForScript, parseInputs } = await import('@shared/scriptInputs');
  const inputs = inputsForScript(parseInputs(s.code).specs, s.inputs ?? {});
  const r = await h.sandbox.start(s.id, s.code, { chain, nativeSymbol: nativeSymbolOf(chain), inputs });
  if (!r.ok) {
    rt.running = false;
    rt.lastError = r.message;
    // A start that lost to a newer one is not a fault of the script. Saving
    // an armed script restarts it, and disabling it for that would be a wall
    // the user never asked for.
    if (/superseded by a newer start/.test(r.message)) return;
    // Neither is a stall. A start can fail because the machine was busy or a
    // provider the script's first line asked for was parked; disarming on the
    // first of those left the user re-arming by hand for something that had
    // already cleared. A body that throws is NOT retryable and still disarms
    // at once, because it will throw identically every time.
    if (r.retryable && rt.startFails < START_RETRIES) {
      rt.startFails += 1;
      const wait = START_BACKOFF_MS[Math.min(rt.startFails - 1, START_BACKOFF_MS.length - 1)];
      slog(s, 'warn', `could not start (${r.message}) — trying again in ${Math.round(wait / 1000)} s (attempt ${rt.startFails} of ${START_RETRIES})`);
      if (rt.startRetry) clearTimeout(rt.startRetry);
      rt.startRetry = setTimeout(() => {
        rt.startRetry = null;
        if (s.enabled && !killSwitch) void startCode(s);
      }, wait);
      rt.startRetry.unref?.();
      changed();
      return;
    }
    // Retries used up on a failure that was retryable (a stall, not a body
    // that throws): pause and come back later rather than off for good.
    if (r.retryable) {
      rt.startFails = 0;
      pauseForErrors(s, `could not start after ${START_RETRIES + 1} attempts: ${r.message}`);
      return;
    }
    disable(s, rt.startFails > 0 ? `could not start after ${rt.startFails + 1} attempts: ${r.message}` : `could not start: ${r.message}`);
    return;
  }
  rt.startFails = 0;
  rt.running = true;
  if (rt.health.upSince !== null) rt.health.restarts += 1;
  rt.health.upSince = Date.now();
  slog(s, 'info', 'sandbox running');
  announcePausedOrders(s, rt);
  changed();
}

/**
 * Tell a freshly started script about orders on ITS coins that came back
 * `paused` from a restart.
 *
 * Restart → paused is deliberate (advOrders §3: never resume a live order
 * silently) and stays so — nothing here resumes anything. But the script
 * placed those stops and rungs, remembers them as placed, and was never told:
 * the `orders` diff treats the first sighting of an order as a baseline, so a
 * restored-paused order produced no event at all. The script went on
 * believing its stop and take-profits were armed while nothing could fire
 * (WAIFU/PGPU, 09-25 10:36). Now it gets the same `order` event with
 * orderState 'paused' that a wallet-switch pause already sends, and the log
 * says so; re-placing (cancel + order) is the script's own decision.
 */
function announcePausedOrders(s: UserScript, rt: Runtime): void {
  const h = host;
  if (!h || s.kind !== 'code' || scriptChain(s) !== 'solana' || s.mode !== 'live') return;
  const paused = h.orders().filter((o) => o.state === 'paused' && rt.opened.has(o.mint));
  if (!paused.length) return;
  const mints = new Set(paused.map((o) => o.mint));
  slog(
    s,
    'warn',
    `${paused.length} order(s) on ${mints.size} coin(s) this script holds came back PAUSED after the restart — they will not fire until resumed or re-placed (sent to the script as 'order' events, state 'paused')`,
  );
  for (const o of paused) {
    void ctxFor(s, o.mint).then((c) => {
      if (!c.symbol && o.symbol) c.symbol = o.symbol;
      enqueue(s, 'order', withOrder(c, { kind: o.kind, state: o.state, amount: o.amount }));
    });
  }
}

async function stopCode(s: UserScript, reason: string): Promise<void> {
  const rt = rtFor(s);
  // A pending start retry is a start: stopping the script must cancel it, or
  // a disarmed script comes back a few seconds later.
  if (rt.startRetry) {
    clearTimeout(rt.startRetry);
    rt.startRetry = null;
  }
  rt.pausedUntil = null;
  rt.startFails = 0;
  clearIntervals(rt);
  rt.intervalSec = null;
  rt.queue = [];
  // Unconditional: a start queued behind this call has not created its box
  // yet, so `isRunning` would say no and the kill switch would miss it. Stop
  // is idempotent, and the start itself re-checks the arm bit.
  rt.running = false;
  if (s.kind === 'code') await host?.sandbox.stop(s.id, reason);
}

/** How many times a RETRYABLE start failure is tried again before the script
 *  is disarmed, and how long to wait between attempts. */
const START_RETRIES = 3;
const START_BACKOFF_MS = [2_000, 5_000, 15_000];

/** Restart enabled scripts (app start). */
export async function startEnabled(): Promise<void> {
  for (const s of scripts) {
    if (!s.enabled) continue;
    if (s.kind === 'code') await startCode(s);
    else armSchedules(s);
  }
}

/**
 * A code script that stopped on its OWN errors — five in a row, or a crash
 * loop — is paused and restarted by itself, a few times a day, before it is
 * turned off for good (2026-09-27).
 *
 * Why not straight off, as before: scripts run for days, and the errors that
 * trip these walls are mostly not the script's code. A provider parked for
 * twenty minutes, an hour without network, a machine that slept — every
 * handler fails for a while and then everything works again. Turning the
 * script off for that left it off until someone noticed, often the next day.
 *
 * What stays a hard stop: the daily loss limit, the kill switch, a script
 * turning itself off, a body that throws at load, validation — those are
 * rules or broken code, and none of them goes through here. The pause is
 * never silent: the log, a toast and a desktop notification say when it
 * restarts, and again when it does; turning the script off cancels it. The
 * script's budget, the live master switch and every breaker apply to the
 * restarted run exactly as before — a restart is not a re-arm of anything
 * the app itself has switched off. The pause is in memory only: a LIVE script
 * still never survives an app restart armed.
 */
let RECOVER_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const RECOVERIES_PER_DAY = 3;
const DAY_MS = 24 * 3_600_000;

/** Test seam: shorter pauses. */
export function _setRecoveryBackoff(ms: number[] | null): void {
  RECOVER_BACKOFF_MS = ms && ms.length ? ms : [5 * 60_000, 15 * 60_000, 60 * 60_000];
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pauseForErrors(s: UserScript, why: string): void {
  if (!s.enabled) return;
  const rt = rtFor(s);
  const now = Date.now();
  rt.recoveries = rt.recoveries.filter((t) => now - t < DAY_MS);
  if (s.kind !== 'code' || rt.recoveries.length >= RECOVERIES_PER_DAY) {
    disable(s, rt.recoveries.length >= RECOVERIES_PER_DAY ? `${why} — paused and restarted ${rt.recoveries.length} times in 24 h already, so it stays off` : why);
    return;
  }
  rt.recoveries.push(now);
  const n = rt.recoveries.length;
  const wait = RECOVER_BACKOFF_MS[Math.min(n - 1, RECOVER_BACKOFF_MS.length - 1)];
  void stopCode(s, `paused: ${why}`);
  rt.pausedUntil = now + wait;
  rt.lastError = `paused until ${clock(rt.pausedUntil)} — ${why}`;
  rt.lastErrorAt = now;
  const msg = `PAUSED — ${why}. It restarts by itself at ${clock(rt.pausedUntil)} (pause ${n} of ${RECOVERIES_PER_DAY} in 24 h; the next one after that turns it off). Turn it off to keep it off.`;
  slog(s, 'error', msg);
  host?.toast('warn', `Script "${s.name}" paused until ${clock(rt.pausedUntil)}: ${why}`);
  host?.notify(`Script paused: ${s.name}`, `${why.slice(0, 160)} — restarts at ${clock(rt.pausedUntil)}${s.mode === 'live' ? ' (LIVE)' : ''}`);
  rt.startRetry = setTimeout(() => {
    rt.startRetry = null;
    rt.pausedUntil = null;
    if (!s.enabled || killSwitch) return;
    rt.errorsInARow = 0;
    slog(s, 'warn', `restarting after its pause${s.mode === 'live' ? ' — LIVE, on the same budget' : ''}`);
    host?.toast(s.mode === 'live' ? 'warn' : 'info', `Script "${s.name}" restarted after its pause${s.mode === 'live' ? ' (LIVE)' : ''}`);
    void startCode(s);
  }, wait);
  rt.startRetry.unref?.();
  changed();
}

function noteError(s: UserScript, line: string): void {
  const rt = rtFor(s);
  rt.errorsInARow += 1;
  rt.lastError = line;
  rt.lastErrorAt = Date.now();
  slog(s, 'error', line);
  if (rt.errorsInARow >= ERRORS_TO_DISABLE) {
    pauseForErrors(s, `${ERRORS_TO_DISABLE} errors in a row (last: ${line.slice(0, 120)})`);
    return; // pause/disable push their own snapshot
  }
  // The Scripts page reads errorsInARow and lastError from pushed snapshots
  // only, so without this a script climbs 1→4 errors invisibly and then jumps
  // straight to "disabled".
  changed();
}

function enqueue(s: UserScript, name: string, payload: unknown): void {
  const rt = rtFor(s);
  if (!rt.running) return;
  if (rt.queue.length >= QUEUE_CAP) {
    // Drop the oldest launch or tick chatter, never a position, order or fill.
    const i = rt.queue.findIndex((q) => q.name === 'launchUpdate' || q.name === 'launch' || q.name === 'tick');
    if (i >= 0) rt.queue.splice(i, 1);
    else rt.queue.shift();
    rt.health.dropped += 1;
  }
  rt.queue.push({ name, payload });
  void pump(s, rt);
}

async function pump(s: UserScript, rt: Runtime): Promise<void> {
  if (rt.busy) return;
  rt.busy = true;
  try {
    while (rt.queue.length && rt.running && s.enabled) {
      const ev = rt.queue.shift() as { name: string; payload: unknown };
      const t0 = Date.now();
      const r = await host?.sandbox.dispatch(s.id, ev.name, ev.payload);
      rt.lastRunAt = Date.now();
      const hl = rt.health;
      hl.events += 1;
      if (r && !r.ok) hl.failed += 1;
      if (hl.lat.length < HEALTH_LAT_CAP) hl.lat.push(rt.lastRunAt - t0);
      else hl.lat[Math.floor(Math.random() * HEALTH_LAT_CAP)] = rt.lastRunAt - t0;
      if (!r) break;
      if (r.ok) rt.errorsInARow = 0;
      else if (!s.enabled || /sandbox stopped/.test(r.error ?? '')) break; // stopped on purpose mid-handler
      else noteError(s, `${ev.name} handler: ${r.error ?? 'failed'}`);
    }
  } finally {
    rt.busy = false;
  }
}

/** A validated message from the sandbox of `scriptId`. */
export function onSandboxMessage(scriptId: string, msg: SandboxToMain): void {
  const s = scripts.find((x) => x.id === scriptId);
  if (!s) return;
  const rt = rtFor(s);
  switch (msg.t) {
    case 'alive':
      // The bridge is up. The script's own code has not run yet, so this is
      // not "running" — it only tells main the sandbox is not broken.
      // A new run starts with an empty widget: a stat from the last run
      // shown as current would be a number nobody measured.
      if (rt.metrics.size) {
        rt.metrics.clear();
        changed();
      }
      return;
    case 'ready':
      rt.running = true;
      return;
    case 'log':
      pushLog(rt, msg.level, msg.line);
      scriptFileLog(s, msg.level, msg.line);
      changed();
      return;
    case 'stats': {
      if (msg.clear) rt.metrics.clear();
      const at = Date.now();
      for (const [name, value] of Object.entries(msg.values)) {
        // A name already shown is updated in place; a new one only while
        // there is room, so a script cannot grow the widget without bound.
        if (!rt.metrics.has(name) && rt.metrics.size >= MAX_STAT_KEYS) continue;
        rt.metrics.set(name, { value, at });
      }
      changed();
      return;
    }
    case 'error':
      noteError(s, msg.line);
      return;
    case 'call':
      void handleCall(s, msg.id, msg.method, msg.args);
      return;
    case 'done':
      return;
  }
}

/** The sandbox died on its own. */
/** Restarts per script in the last minute — a crash loop must not spawn a
 *  renderer every three seconds for the life of the app. */
const restartWindow = new Map<string, number[]>();
const RESTARTS_PER_MIN = 5;

export function onSandboxGone(scriptId: string, reason: string): void {
  const s = scripts.find((x) => x.id === scriptId);
  if (!s) return;
  const rt = rtFor(s);
  rt.running = false;
  rt.queue = [];
  if (!s.enabled) return;
  noteError(s, `sandbox gone (${reason})`);
  if (!s.enabled || rt.pausedUntil) return; // noteError may have disabled or paused it
  // A handler that never returns is killed by the watchdog, comes back, and
  // runs again — so without a ceiling the five-error wall is never reached and
  // the loop is endless. Count restarts, not just errors.
  const now = Date.now();
  const recent = (restartWindow.get(scriptId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  restartWindow.set(scriptId, recent);
  if (recent.length > RESTARTS_PER_MIN) {
    restartWindow.delete(scriptId);
    pauseForErrors(s, `restarted ${recent.length} times in a minute (last: ${reason})`);
    return;
  }
  // Killed by the watchdog or crashed: come back, unless the errors said stop.
  void startCode(s);
}

const isMint = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
/** An optional count from a script, held to [lo, hi]; absent or unusable = the default. */
const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};
const SCOUT_WINDOWS = ['day', 'week', 'month', 'all'] as const;
const ORDER_KINDS: OrderKind[] = ['limit_buy', 'limit_sell', 'take_profit', 'stop_loss', 'trailing_stop', 'sell_on_dev_sell', 'sell_on_migration', 'buy_on_migration'];


/**
 * A script trading with one of the user's OTHER wallets, named by address.
 *
 * Every gate `act()` applies to an ordinary buy applies here — the script's
 * own budget, its per-minute rate, the live master switch — because they are
 * the script's rules and naming a different wallet does not change them. What
 * does NOT apply is any per-coin wallet cap: nothing touches a coin here
 * without a line of code saying so. Here it is a line of code.
 *
 * Paper spends nothing and says what it would have done. There is no paper
 * book per wallet, and booking the position under the active wallet would
 * report a holding in the wrong place.
 */
async function walletTrade(
  s: UserScript,
  side: 'buy' | 'sell',
  address: string,
  mint: string,
  amount: number,
): Promise<ActResult> {
  const h = host as AutomationHost;
  const rt = rtFor(s);
  const label = mint.slice(0, 8);
  const chain = scriptChain(s);
  // On Robinhood / BNB an address is compared lower-case, as the rail stores it.
  if (chain !== 'solana') address = address.toLowerCase();
  const who = address.slice(0, 8);
  const unit = nativeSymbolOf(chain);
  if (chain !== 'solana' && !evmHooks?.walletTrade) return refuse(s, `${side}: naming a wallet is not available on this chain in this build`);
  if (rateLimited(s, rt, Date.now())) return refuse(s, `${side} ${label}: over ${s.budget.maxActionsPerMinute} actions in a minute`);

  if (side === 'buy') {
    const gate = await buyGate(s, rt, mint, amount, label, { address });
    if (gate) return gate;
    if (s.mode === 'paper') {
      slog(s, 'info', `PAPER buy ${amount} ${unit} of ${label} as ${who}… — nothing spent`);
      return { ok: true, message: 'paper: nothing was bought' };
    }
    const r =
      chain === 'solana'
        ? await h.walletBuy(address, mint, amount, s.budget.maxSolPerTrade)
        : await (evmHooks as EvmScriptHooks).walletTrade!(chain as EvmChainKind, 'buy', address, mint, amount);
    if (r.ok) {
      // Counted like any other buy this script made: the budget is about what
      // the SCRIPT spends, not about which key signed it.
      rt.buysToday += 1;
      const prev = rt.opened.get(mint);
      rt.opened.set(mint, { costSol: (prev?.costSol ?? 0) + amount, at: Date.now(), wallet: address });
      persist();
    }
    slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'bought' : 'buy failed'} ${amount} ${unit} of ${label} as ${who}…: ${r.message}`);
    return { ok: r.ok, message: r.message };
  }

  // A script may only sell a mint it opened — the same rule as bot.sell. It is
  // what separates the script's own bags from bags bought by hand.
  if (!rt.opened.has(mint)) return refuse(s, `sell ${label}: this script does not hold it`);
  // …and only from the wallet it bought it WITH: the claim is (wallet, coin),
  // not the coin alone, or a named sell could dump a bag the user bought by
  // hand in another of their wallets (v6 audit 2026-10-03).
  const claimed = rt.opened.get(mint)?.wallet ?? h.wallet(chain).address ?? null;
  const same = (a: string | null | undefined, b: string): boolean => !!a && (chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase());
  if (!same(claimed, address)) return refuse(s, `sell ${label}: this script did not buy it with ${who}…`);
  if (s.mode === 'paper') {
    slog(s, 'info', `PAPER sell ${Math.round(amount)}% of ${label} as ${who}… — nothing sold`);
    return { ok: true, message: 'paper: nothing was sold' };
  }
  const r =
    chain === 'solana'
      ? await h.walletSell(address, mint, amount)
      : await (evmHooks as EvmScriptHooks).walletTrade!(chain as EvmChainKind, 'sell', address, mint, amount);
  // A full exit from the wallet that bought it ends the script's claim; the
  // active-wallet prune never sees this bag, so nothing else would.
  if (r.ok && amount >= 100 && rt.opened.get(mint)?.wallet === address) {
    rt.opened.delete(mint);
    persist();
  }
  slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'sold' : 'sell failed'} ${Math.round(amount)}% of ${label} as ${who}…: ${r.message}`);
  return { ok: r.ok, message: r.message };
}

async function handleCall(s: UserScript, id: number, method: string, args: unknown[]): Promise<void> {
  const h = host;
  if (!h) return;
  const answer = (ok: boolean, value?: unknown, error?: string): void => h.sandbox.reply(s.id, id, ok, value, error);
  const result = (r: ActResult): void =>
    answer(true, {
      ok: r.ok,
      message: r.message,
      ...(r.realizedSol !== undefined ? { realizedSol: r.realizedSol } : {}),
      ...(r.count !== undefined ? { count: r.count, sold: r.count, cancelled: r.count } : {}),
    });
  // A disabled script answers nothing. Its sandbox may still be draining a
  // handler that started before the switch moved, and every read below costs
  // something — `positions` walks the book, `market` hits a live provider.
  if (!s.enabled || killSwitch) return answer(false, undefined, 'script is disabled');
  // A token on Robinhood or BNB is a 0x address (2026-10-03): the old check
  // was base58-only, so EVERY token method failed "bad mint" on an EVM
  // script. Compared lower-case, as the scanner and the ledger store it.
  const evm = scriptChain(s) !== 'solana';
  if (evm && args.length) {
    const low = (v: unknown): unknown => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v);
    const a0 = args[0];
    args = [a0 !== null && typeof a0 === 'object' && !Array.isArray(a0) && 'mint' in a0 ? { ...(a0 as Record<string, unknown>), mint: low((a0 as Record<string, unknown>).mint) } : low(a0), ...args.slice(1)];
  }
  const isMint = (v: unknown): v is string =>
    typeof v === 'string' && (evm ? /^0x[0-9a-f]{40}$/.test(v) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v));
  try {
    switch (method) {
      case 'buy': {
        const [mint, sol, who] = args;
        if (!isMint(mint)) return answer(false, undefined, 'buy: bad mint');
        const x = tradeExtras(who, 'buy');
        if (!x.ok) return answer(false, undefined, x.error);
        if (evm && x.feeLane !== undefined) return answer(false, undefined, 'buy: lane is Solana-only — gas on this chain is set by the chain');
        if (!x.wallet) return result(await act(s, { type: 'buy', sol: Number(sol) }, await ctxFor(s, mint), { slippagePct: x.slippagePct, feeLane: x.feeLane, ...(x.topUp ? { topUp: true } : {}) }));
        if (x.topUp) return answer(false, undefined, 'buy: topUp funds the trading wallet only — drop it, or the wallet');
        // Another wallet trades at the execution setting's slippage; a value
        // that would be dropped on the floor is refused (audit 2026-09-27).
        if (x.slippagePct !== undefined) return answer(false, undefined, 'buy: slippagePct applies to the trading wallet only — drop it, or the wallet');
        if (x.feeLane !== undefined) return answer(false, undefined, 'buy: lane applies to the trading wallet only — drop it, or the wallet');
        return result(await chain(s, () => walletTrade(s, 'buy', x.wallet, mint, Number(sol))));
      }
      case 'sell': {
        const [mint, how, who] = args;
        if (!isMint(mint)) return answer(false, undefined, 'sell: bad mint');
        // The second argument is a percent, or {pct | tokens, slippagePct,
        // wallet}; the third an address or the same options (2026-09-27).
        let pct: unknown = how;
        let tokens: number | undefined;
        let extras: unknown = who;
        if (typeof how === 'object' && how !== null && !Array.isArray(how)) {
          const o = how as Record<string, unknown>;
          if (o.tokens !== undefined && o.pct !== undefined) return answer(false, undefined, 'sell: pass pct or tokens, not both');
          if (o.tokens !== undefined) {
            // A number, not anything Number() would coerce ({tokens: true} is 1).
            if (typeof o.tokens !== 'number' || !Number.isFinite(o.tokens) || o.tokens <= 0) return answer(false, undefined, 'sell: tokens must be a positive number');
            tokens = o.tokens;
          }
          pct = o.pct;
          const named = o.wallet !== undefined && o.wallet !== null && o.wallet !== '';
          // The wallet is named ONCE. Until the audit of 2026-09-27 a third
          // argument silently won over the options' wallet and slippage.
          if (who !== undefined && named) return answer(false, undefined, 'sell: name the wallet once — in the options or as the third argument, not both');
          extras = who === undefined ? { wallet: o.wallet, slippagePct: o.slippagePct, lane: o.lane } : typeof who === 'string' ? { wallet: who, slippagePct: o.slippagePct, lane: o.lane } : who;
        }
        const x = tradeExtras(extras, 'sell');
        if (!x.ok) return answer(false, undefined, x.error);
        if (evm && x.feeLane !== undefined) return answer(false, undefined, 'sell: lane is Solana-only — gas on this chain is set by the chain');
        if (!x.wallet) {
          return result(await act(s, { type: 'sell', pct: tokens !== undefined ? 100 : Number(pct) }, await ctxFor(s, mint), { slippagePct: x.slippagePct, tokens, feeLane: x.feeLane }));
        }
        if (tokens !== undefined) return answer(false, undefined, 'sell: a sell from another wallet is a percent, not a token count');
        // The other wallets trade at the execution setting; a slippage that
        // would be dropped on the floor is refused instead (audit 2026-09-27).
        if (x.slippagePct !== undefined) return answer(false, undefined, 'sell: slippagePct applies to the trading wallet only — drop it, or the wallet');
        if (x.feeLane !== undefined) return answer(false, undefined, 'sell: lane applies to the trading wallet only — drop it, or the wallet');
        return result(await chain(s, () => walletTrade(s, 'sell', x.wallet, mint, Number(pct))));
      }
      case 'wallets':
        // The chain's OWN list: an EVM script was handed Solana's wallets.
        return answer(true, evm ? (evmHooks?.wallets(scriptChain(s) as EvmChainKind) ?? []) : h.wallets());
      case 'sellAll':
        return result(await act(s, { type: 'sell_all' }, null));
      case 'order': {
        // Advanced orders are Solana's (advOrders). Gated FIRST: three kinds
        // below go straight to the engine and would have placed a Solana
        // order against an EVM address (latent behind the old mint check).
        if (evm) return answer(false, undefined, `order: advanced orders are Solana-only — on ${chainLabel(scriptChain(s))} sell with bot.sell from a tick or position handler`);
        const req = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
        if (!isMint(req.mint)) return answer(false, undefined, 'order: bad mint');
        if (!ORDER_KINDS.includes(req.kind as OrderKind)) return answer(false, undefined, `order: kind must be one of ${ORDER_KINDS.join(', ')}`);
        if (!TRIGGER_BASES.includes(req.triggerBasis as TriggerBasis)) return answer(false, undefined, `order: triggerBasis must be one of ${TRIGGER_BASES.join(', ')}`);
        const kind = req.kind as OrderKind;
        const basis = req.triggerBasis as TriggerBasis;
        // A limit order is a level, and 'pct' is not one. Silently reading it
        // as a market cap armed a limit buy at $20 and reported success.
        if (basis === 'pct' && (kind === 'limit_buy' || kind === 'limit_sell')) {
          return answer(false, undefined, `order: ${kind} needs an absolute level — triggerBasis must be price_sol or mcap_usd`);
        }
        // The mirror image (2026-09-27): the percent kinds are measured from
        // a reference price and nothing else — the engine's trigger test and
        // the Orders form both know only 'pct' for them. A stop_loss sent
        // with mcap_usd was silently armed as a PERCENT stop at that number
        // and reported success: a "$20,000 market-cap stop" became "sell
        // when 20,000 % down", which is never.
        if (basis !== 'pct' && isPctKind(kind)) {
          return answer(false, undefined, `order: ${kind} is measured in percent from the reference price — triggerBasis must be 'pct' (for an absolute level use limit_sell or limit_buy with price_sol or mcap_usd)`);
        }
        // Optional expiry, epoch ms — the Orders form has had it since
        // orders existed; a script's request dropped it on the floor until
        // 2026-09-27. Same rule as the form: unknown is null, never a NaN that
        // quietly means "never expires"; a time already past is a bad call.
        let expiresAt: number | null = null;
        if (req.expiresAt !== undefined && req.expiresAt !== null) {
          const e = Number(req.expiresAt);
          if (!Number.isFinite(e)) return answer(false, undefined, 'order: expiresAt must be a time in epoch milliseconds (e.g. bot.now() + 3600000)');
          if (e <= Date.now()) return answer(false, undefined, 'order: expiresAt is already in the past');
          expiresAt = e;
        }
        const value = Number(req.triggerValue);
        const amount = Number(req.amount);
        let action: RuleAction | null = null;
        if (kind === 'stop_loss') action = { type: 'stop_loss', pct: value };
        else if (kind === 'trailing_stop') action = { type: 'trailing_stop', pct: value };
        else if (kind === 'take_profit') action = { type: 'take_profit', gainPct: value, sellPct: amount };
        else if (kind === 'limit_buy') action = { type: 'limit_buy', basis: basis as 'price_sol' | 'mcap_usd', value, sol: amount };
        else if (kind === 'limit_sell') action = { type: 'limit_sell', basis: basis as 'price_sol' | 'mcap_usd', value, pct: amount };
        if (action) return result(await act(s, action, await ctxFor(s, req.mint), { expiresAt }));
        // The migration / dev-sell kinds have no rule form; place directly,
        // same gates — and on the SAME per-script chain act() uses, or the
        // gates below read counters that a call already on the wire has not
        // incremented yet. See `chain`.
        // `req` is a bag of unknowns; isMint() narrowed it above, but that
        // narrowing does not survive into the closure. Capture it once.
        const orderMint: string = req.mint;
        return chain(s, async () => {
          const ctx = await ctxFor(s, orderMint);
          if (s.mode === 'paper') {
          slog(s, 'info', `PAPER order ${kind} on ${ctx.symbol || orderMint.slice(0, 8)} — noted, not placed`);
          return result({ ok: true, message: 'paper: order noted, not placed' });
          }
          // These three kinds have no rule form, so they do not pass through
          // act() — and therefore skipped the arm bit, the rate limit and the
          // buy reservation. An armed order spends through the real pipeline
          // with no knowledge of this script's budget, so the gates have to be
          // applied here by hand.
          const rt = rtFor(s);
          const label = ctx.symbol || orderMint.slice(0, 8);
          if (!s.enabled || killSwitch) return result({ ok: false, message: 'script is disabled' });
          if (rateLimited(s, rt, Date.now())) {
          const msg = `refused order ${kind}: over ${s.budget.maxActionsPerMinute} actions in a minute`;
          slog(s, 'warn', msg);
          return result({ ok: false, message: msg });
          }
          if (kind === 'sell_on_migration' || kind === 'sell_on_dev_sell') {
          if (!rt.opened.has(orderMint)) return result(refuse(s, `order ${kind} on ${label}: this script does not hold it`));
          }
          if (kind === 'buy_on_migration') {
          const gate = await buyGate(s, rt, orderMint, amount, label);
          if (gate) return result(gate);
          }
          const r = await h.placeOrder({ mint: orderMint, symbol: ctx.symbol, kind, triggerBasis: basis, triggerValue: Number.isFinite(value) ? value : null, amount, expiresAt });
          // An armed buy_on_migration is a buy this script has committed to:
          // reserve it now, or the budget counts it only once it fires.
          if (r.ok && kind === 'buy_on_migration') {
          rt.buysToday += 1;
          rt.opened.set(orderMint, openedWithBuy(rt.opened.get(orderMint), amount, Date.now(), null));
          persist();
          }
          slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'armed' : 'NOT armed'} order ${kind} on ${ctx.symbol || orderMint.slice(0, 8)}: ${r.message}`);
          return result(r);
        });
      }
      case 'cancelOrders': {
        const [mint, kindsArg] = args;
        if (!isMint(mint)) return answer(false, undefined, 'cancelOrders: bad mint');
        // An optional list of kinds (2026-09-27): a moonbag drops its stop
        // and keeps its take-profit rungs. A list that is not a list of
        // kinds is a bad call, never "cancel everything".
        let kinds: OrderKind[] | undefined;
        if (kindsArg !== undefined) {
          const ok = Array.isArray(kindsArg) && kindsArg.length > 0 && kindsArg.every((k) => typeof k === 'string' && (CANCEL_KINDS as readonly string[]).includes(k));
          if (!ok) return answer(false, undefined, `cancelOrders: kinds must be a list of ${CANCEL_KINDS.join(' | ')}`);
          kinds = kindsArg as OrderKind[];
        }
        return result(await act(s, kinds ? { type: 'cancel_orders', kinds } : { type: 'cancel_orders' }, await ctxFor(s, mint)));
      }
      case 'clearCompletedOrders':
        // Housekeeping, not an action — no budget cost, safe to call every tick.
        // Solana's order list only; an EVM script has none to clear.
        if (evm) return answer(true, 0);
        return answer(true, h.clearCompletedOrders());
      case 'templates':
        return answer(true, evm ? [] : h.templates());
      case 'applyTemplate': {
        const [mint, templateId] = args;
        if (!isMint(mint)) return answer(false, undefined, 'applyTemplate: bad mint');
        if (typeof templateId !== 'string' || !templateId) return answer(false, undefined, 'applyTemplate: bad template id');
        return result(await act(s, { type: 'apply_template', templateId }, await ctxFor(s, mint)));
      }
      case 'alert': {
        const req = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
        if (!isMint(req.mint)) return answer(false, undefined, 'alert: bad mint');
        if (!ALERT_KINDS.includes(req.kind as AlertKind)) return answer(false, undefined, `alert: kind must be one of ${ALERT_KINDS.join(', ')}`);
        return result(await act(s, { type: 'alert', kind: req.kind as AlertKind, threshold: Number(req.threshold) }, await ctxFor(s, req.mint)));
      }
      case 'watch':
      case 'unwatch': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, `${method}: bad mint`);
        return result(await act(s, { type: method }, await ctxFor(s, mint)));
      }
      case 'subscribe': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'subscribe: bad mint');
        h.subscribeTicks(mint);
        subscribe(rtFor(s), mint);
        persist(true);
        return result({ ok: true, message: 'subscribed' });
      }
      case 'unsubscribe': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'unsubscribe: bad mint');
        rtFor(s).subscribed.delete(mint);
        persist(true);
        return result({ ok: true, message: 'unsubscribed' });
      }
      case 'notify': {
        const text = String(args[0] ?? '').slice(0, 200);
        if (!text) return answer(false, undefined, 'notify: empty');
        return result(await act(s, { type: 'notify', message: text }, null));
      }
      // A PUBLIC post, under the trading wallet's name, on a coin the script
      // is holding. It is an action like any other spend: it costs the budget,
      // it is refused on paper, and pump's own eligibility check decides
      // whether it happens at all. The watermark is applied in main, so a
      // script cannot post an unmarked one.
      // A PUBLIC post, under a wallet's name, on a coin it holds. It is an
      // action like any other spend: it costs the budget, it is refused on
      // paper, and pump's own eligibility check decides whether it happens at
      // all. The watermark is applied in main, so a script cannot post an
      // unmarked one.
      //
      // A script may name WHICH of the user's accounts posts — that is what
      // makes a group of wallets scriptable rather than needing a switch that
      // fans one buy out into N posts.
      //
      // There was a ceiling of five accounts per coin here until 2026-09-22,
      // by analogy with the wallets-per-coin cap. That analogy was ours, not
      // the user's: pump already allows exactly one callout per coin per
      // account, so the real limit is how many accounts someone has, and a
      // second rule on top of it only governed their own accounts. What is
      // left is a dedupe, which is not a limit — it skips a request pump
      // would refuse anyway.
      case 'callout': {
        const [mint, text, who] = args;
        if (!isMint(mint)) return answer(false, undefined, 'callout: bad mint');
        if (scriptChain(s) !== 'solana') return answer(false, undefined, 'callout: pump.fun callouts are Solana only');
        const words = typeof text === 'string' ? text.trim().slice(0, THESIS_BUDGET) : '';
        const wallet = typeof who === 'string' ? who.trim().slice(0, 64) : '';
        const label = mint.slice(0, 8);
        // Paper posts nothing. A callout is public whichever mode the script
        // is in, so there is no paper version of it to run — saying what it
        // WOULD have said is the rehearsal.
        if (s.mode === 'paper') {
          slog(s, 'info', `PAPER callout on ${label} — nothing posted${words ? `; would have said "${words}"` : ''}`);
          return answer(true, { ok: true, message: 'paper: nothing was posted', thesis: words || null });
        }
        const rt = rtFor(s);
        if (rateLimited(s, rt, Date.now())) {
          return answer(false, undefined, `callout: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        }
        const called = rt.calledOut.get(mint) ?? new Set<string>();
        if (wallet && called.has(wallet)) {
          return answer(true, { ok: false, message: 'this script has already called that coin from that account', thesis: null });
        }
        const r = await h.callout(mint, words, wallet);
        if (r.ok) {
          called.add(r.address ?? wallet);
          rt.calledOut.set(mint, called);
        }
        slog(s, r.ok ? 'info' : 'warn', `callout on ${label}${r.address ? ` as ${r.address.slice(0, 8)}…` : ''}: ${r.message}`);
        return answer(true, {
          ok: r.ok,
          message: r.message,
          thesis: r.thesis ?? null,
          address: r.address ?? null,
          calloutId: r.calloutId ?? null,
          // pump's own public page for it — what a share button or a Discord
          // post links to. Null when the id could not be learned.
          link: r.calloutId ? calloutPageUrl(mint, r.calloutId) : null,
        });
      }
      // Following up a call that already exists. NOT capped by the per-coin
      // ceiling above: that one limits how many of your accounts may call one
      // coin, and a reply adds no new caller. pump's own reply cooldown is
      // what paces these, and its refusal is reported rather than retried.
      case 'calloutReply': {
        const [mint, text, who] = args;
        if (!isMint(mint)) return answer(false, undefined, 'calloutReply: bad mint');
        if (scriptChain(s) !== 'solana') return answer(false, undefined, 'calloutReply: pump.fun callouts are Solana only');
        const words = typeof text === 'string' ? text.trim().slice(0, REPLY_BUDGET) : '';
        if (!words) return answer(false, undefined, 'calloutReply: no text');
        const wallet = typeof who === 'string' ? who.trim().slice(0, 64) : '';
        const label = mint.slice(0, 8);
        if (s.mode === 'paper') {
          slog(s, 'info', `PAPER callout reply on ${label} — nothing posted; would have said "${words}"`);
          return answer(true, { ok: true, message: 'paper: nothing was posted', thesis: words });
        }
        if (rateLimited(s, rtFor(s), Date.now())) {
          return answer(false, undefined, `calloutReply: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        }
        const r = await h.calloutReply(mint, words, wallet);
        slog(s, r.ok ? 'info' : 'warn', `callout reply on ${label}${r.address ? ` as ${r.address.slice(0, 8)}…` : ''}: ${r.message}`);
        return answer(true, {
          ok: r.ok,
          message: r.message,
          thesis: r.thesis ?? null,
          address: r.address ?? null,
          calloutId: r.calloutId ?? null,
          replyId: r.replyId ?? null,
          // The reply's own link when pump said its id, else the callout's.
          link: r.ok && r.calloutId ? calloutPageUrl(mint, r.calloutId, r.replyId) : null,
        });
      }
      // A Discord post (asked 09-23, to share callouts). The script names one
      // of ITS OWN `webhook` settings — never a URL — and the URL is looked
      // up here from the answers the user typed, already held to Discord's
      // hosts by coerceInputs. The embed is rebuilt field by field by
      // scriptEmbed.
      case 'discord': {
        const [field, embedIn] = args;
        const key = typeof field === 'string' ? field.trim() : '';
        const { coerceInputs, parseInputs } = await import('@shared/scriptInputs');
        const specs = parseInputs(s.code).specs;
        if (!key || specs[key]?.type !== 'webhook') {
          return answer(false, undefined, `discord: "${key.slice(0, 40)}" is not one of this script's webhook settings — declare it in @inputs with "type": "webhook" and pass its name`);
        }
        // A Discord post is a public, outside-the-app side effect, so a PAPER
        // script does not send it — the same rule as callout/reply/follow/like
        // (a paper run rehearsing filters must not spam a real, possibly
        // shared, channel). It says what it would have done and nothing goes
        // out. (audit 2026-09-23)
        if (s.mode === 'paper') {
          slog(s, 'info', `PAPER discord — nothing posted${typeof embedIn === 'object' && embedIn && 'title' in embedIn ? `; would have posted "${String((embedIn as { title?: unknown }).title ?? '').slice(0, 80)}"` : ''}`);
          return answer(true, { ok: true, message: 'paper: nothing was posted' });
        }
        const url = String(coerceInputs(specs, s.inputs ?? {})[key] ?? '');
        if (!url) return answer(true, { ok: false, message: `${specs[key].label} is not set` });
        const built = scriptEmbed(embedIn, s.name, false);
        if ('error' in built) return answer(false, undefined, `discord: ${built.error}`);
        if (rateLimited(s, rtFor(s), Date.now())) {
          return answer(false, undefined, `discord: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        }
        const r = await h.discord(url, built.embed);
        // Never the URL: its last segment is the webhook's password.
        slog(s, r.ok ? 'info' : 'warn', `discord → ${redactWebhook(url)}: ${r.ok ? (built.embed.title ?? 'posted') : r.message}`);
        // The id lets the script edit this post later — to show how a call
        // ended ON the call (2026-09-25). Null when Discord did not say.
        return answer(true, { ok: r.ok, message: r.message, messageId: r.messageId ?? null });
      }
      case 'discordEdit': {
        // Edit, never delete (2026-09-25): a call that went badly is updated to
        // SAY so, not removed — a channel that only keeps its winners misleads
        // everyone reading it. Same webhook-setting rule and paper rule as a post.
        const [field, messageId, embedIn] = args;
        const key = typeof field === 'string' ? field.trim() : '';
        const { coerceInputs, parseInputs } = await import('@shared/scriptInputs');
        const specs = parseInputs(s.code).specs;
        if (!key || specs[key]?.type !== 'webhook') {
          return answer(false, undefined, `discordEdit: "${key.slice(0, 40)}" is not one of this script's webhook settings`);
        }
        const { isMessageId } = await import('@shared/webhook');
        if (!isMessageId(messageId)) return answer(false, undefined, 'discordEdit: that is not a Discord message id (use the messageId bot.discord returned)');
        if (s.mode === 'paper') {
          slog(s, 'info', 'PAPER discord edit — nothing changed');
          return answer(true, { ok: true, message: 'paper: nothing was edited' });
        }
        const url = String(coerceInputs(specs, s.inputs ?? {})[key] ?? '');
        if (!url) return answer(true, { ok: false, message: `${specs[key].label} is not set` });
        const built = scriptEmbed(embedIn, s.name, false);
        if ('error' in built) return answer(false, undefined, `discordEdit: ${built.error}`);
        if (rateLimited(s, rtFor(s), Date.now())) {
          return answer(false, undefined, `discordEdit: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        }
        const r = await h.discordEdit(url, messageId, built.embed);
        slog(s, r.ok ? 'info' : 'warn', `discord edit → ${redactWebhook(url)}: ${r.ok ? (built.embed.title ?? 'edited') : r.message}`);
        return answer(true, { ok: r.ok, message: r.message });
      }
      // Follows and likes (asked 09-22, for scripting). Public, like a
      // callout, so paper does nothing and says what it would have done. The
      // target's shape is checked in main (shared/pumpSocial.ts); pump's own
      // refusal comes back as ok:false.
      case 'follow':
      case 'unfollow':
      case 'like':
      case 'unlike': {
        const [target, who] = args;
        if (scriptChain(s) !== 'solana') return answer(false, undefined, `${method}: pump.fun is Solana only`);
        const t = typeof target === 'string' ? target.trim().slice(0, 200) : '';
        if (!t) return answer(false, undefined, `${method}: nothing to ${method}`);
        const wallet = typeof who === 'string' ? who.trim().slice(0, 64) : '';
        if (s.mode === 'paper') {
          slog(s, 'info', `PAPER ${method} ${t.slice(0, 12)} — nothing sent`);
          return answer(true, { ok: true, message: `paper: nothing was sent` });
        }
        if (rateLimited(s, rtFor(s), Date.now())) {
          return answer(false, undefined, `${method}: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        }
        const r = await h.pumpSocial(method, t, wallet);
        slog(s, r.ok ? 'info' : 'warn', `${method}${r.address ? ` as ${r.address.slice(0, 8)}…` : ''}: ${r.message}`);
        return answer(true, { ok: r.ok, message: r.message, address: r.address ?? null });
      }
      // A free read: which pump.fun accounts are signed in, so a script can
      // post from each in turn. Addresses and names only — never a token.
      case 'pumpAccounts':
        return answer(true, evm ? [] : h.pumpAccounts());
      case 'price': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'price: bad mint');
        // The chain's own price (an EVM script read Solana's cache: always null).
        return answer(true, h.priceSol(mint, scriptChain(s)));
      }
      case 'token': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'token: bad mint');
        const known = evm
          ? !!evmHooks?.launch(scriptChain(s) as EvmChainKind, mint) || h.marketCached(mint, scriptChain(s)) !== null || h.priceSol(mint, scriptChain(s)) !== null
          : !!h.launch(mint) || !!h.marketCached(mint, scriptChain(s));
        if (!known) return answer(true, null);
        return answer(true, await ctxFor(s, mint));
      }
      case 'market': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'market: bad mint');
        // The only read that leaves the machine: it goes to the shared provider
        // queue, so an un-awaited loop of these starves the whole app and trips
        // its 429 parks. It costs an action like anything else does.
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `market: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.market(mint, scriptChain(s)));
      }
      case 'links': {
        // Cached facts only — no request, no action charged.
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'links: bad mint');
        return answer(true, h.links(mint, scriptChain(s)));
      }
      case 'security': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'security: bad mint');
        // Nothing to read on EVM: unknown, and not charged an action for it.
        if (evm) return answer(true, null);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `security: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.security(mint, scriptChain(s)));
      }
      case 'creator': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'creator: bad mint');
        if (evm) return answer(true, null);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `creator: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.creator(mint, scriptChain(s)));
      }
      // ── Every other read the app has (2026-09-27) ──────────────────────
      // The Launch tab's cohorts, then the rest of the token page and the
      // app: holders, tape, candles, search, Discover, callouts, this
      // install's fills, the wallet's bags, SOL/USD, Wallet Scout, the copy
      // configs, the alerts. A read that leaves the machine costs an action,
      // exactly like market; one answered from memory is free. A Solana-only
      // read on an EVM script answers null (or an empty list) rather than
      // rejecting, so one script body can run on any chain.
      case 'launchIntel': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'launchIntel: bad mint');
        if (scriptChain(s) !== 'solana') return answer(true, null);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `launchIntel: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.launchIntel(mint, scriptChain(s)));
      }
      case 'holders':
      case 'trades': {
        const [mint, limitArg] = args;
        if (!isMint(mint)) return answer(false, undefined, `${method}: bad mint`);
        if (scriptChain(s) !== 'solana') return answer(true, null);
        const limit = method === 'holders' ? clampInt(limitArg, 1, 100, 50) : clampInt(limitArg, 1, 200, 60);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `${method}: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, method === 'holders' ? await h.holders(mint, limit, scriptChain(s)) : await h.trades(mint, limit, scriptChain(s)));
      }
      case 'candles': {
        const [mint, intervalArg, limitArg] = args;
        if (!isMint(mint)) return answer(false, undefined, 'candles: bad mint');
        if (scriptChain(s) !== 'solana') return answer(true, null);
        const interval = intervalArg === undefined ? '1m' : intervalArg;
        if (!(CANDLE_INTERVALS as readonly unknown[]).includes(interval)) return answer(false, undefined, `candles: interval must be one of ${CANDLE_INTERVALS.join(', ')}`);
        const limit = clampInt(limitArg, 10, 500, 120);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `candles: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.candles(mint, interval as CandleInterval, limit, scriptChain(s)));
      }
      case 'search': {
        const q = typeof args[0] === 'string' ? args[0].trim().slice(0, 100) : '';
        if (!q) return answer(false, undefined, 'search: pass some text or a mint');
        if (scriptChain(s) !== 'solana') return answer(true, []);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `search: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.search(q, scriptChain(s)));
      }
      case 'discover': {
        const [listArg, limitArg] = args;
        const list = listArg === undefined ? 'new' : listArg;
        if (!(DISCOVER_COLUMNS as readonly unknown[]).includes(list)) return answer(false, undefined, `discover: list must be one of ${DISCOVER_COLUMNS.join(', ')}`);
        const limit = clampInt(limitArg, 1, 80, 20);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `discover: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.discover(list as DiscoverColumn, limit, scriptChain(s)));
      }
      case 'callouts': {
        const limit = clampInt(args[0], 1, 50, 20);
        if (scriptChain(s) !== 'solana') return answer(true, null);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `callouts: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.callouts(limit, scriptChain(s)));
      }
      case 'coinCallouts': {
        const mint = typeof args[0] === 'string' ? args[0].trim() : '';
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return answer(false, undefined, 'coinCallouts: a Solana mint address is required');
        if (scriptChain(s) !== 'solana') return answer(true, null);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `coinCallouts: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.coinCallouts(mint, scriptChain(s)));
      }
      case 'history':
        // This install's own record — free, like orders. On EVM, the chain's
        // own ledger (it answered [] while that ledger sat there).
        if (evm) return answer(true, evmHooks?.history(scriptChain(s) as EvmChainKind, clampInt(args[0], 1, 200, 50)) ?? []);
        return answer(true, h.history(clampInt(args[0], 1, 200, 50), scriptChain(s)));
      case 'holdings': {
        // A chain read unless one landed in the last two seconds, so it is
        // charged like market. NULL when the wallet could not be read: the
        // same "unknown is not empty" rule positions learned (2026-09-27).
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `holdings: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        const rows = await h.holdings(scriptChain(s));
        if (rows === null) return answer(false, undefined, 'holdings: the wallet could not be read just now — unknown, not empty; try again next pass');
        return answer(true, rows);
      }
      case 'solUsd':
        return answer(true, await h.solUsd());
      case 'nativeUsd':
        // The script's own chain coin in dollars: SOL, ETH or BNB.
        return answer(true, evm ? ((await evmHooks?.nativeUsd(scriptChain(s))) ?? null) : await h.solUsd());
      // ── All-in-One (2026-10-03) ────────────────────────────────────────
      case 'aioInfo':
        return answer(true, aioHooks ? aioHooks.info() : null);
      case 'aioBalances': {
        if (!aioHooks) return answer(true, null);
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `aio.balances: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await aioHooks.balances());
      }
      case 'aioMove': {
        const [from, to, amt] = args;
        const chains = ['solana', 'bnb', 'robinhood'];
        if (typeof from !== 'string' || !chains.includes(from) || typeof to !== 'string' || !chains.includes(to) || from === to) {
          return answer(false, undefined, "aio.move: name two different chains of 'solana', 'bnb', 'robinhood'");
        }
        const amount = Number(amt);
        if (!Number.isFinite(amount) || amount <= 0) return answer(false, undefined, 'aio.move: amount must be a positive number (in the FROM chain\'s coin)');
        const rtm = rtFor(s);
        if (rateLimited(s, rtm, Date.now())) return answer(false, undefined, `aio.move: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        if (s.mode === 'paper') {
          slog(s, 'info', `PAPER move ${amount} ${nativeSymbolOf(from as ChainKind)} ${from} → ${to} — nothing moved`);
          return result({ ok: true, message: 'paper: nothing was moved' });
        }
        if (!aioHooks || !aioHooks.active()) return answer(false, undefined, 'aio.move: needs the All-in-One wallet signing on every chain');
        // The master switch is the app being off, not a script's rule — a
        // move is real money like a buy (v6 audit 2026-10-03: moves went on
        // with every chain in Paper).
        const off = h.liveBlockedReason(from as ChainKind) ?? h.liveBlockedReason(to as ChainKind);
        if (off) return result(refuse(s, `aio.move: not moved — ${off}`));
        // …and bounded by the script's own size: one move is worth at most one
        // max trade, in dollars. No price, no move: unknown is never fine.
        const [fromUsd, ownUsd] = await Promise.all([evmHooks?.nativeUsd(from as ChainKind) ?? null, evmHooks?.nativeUsd(scriptChain(s)) ?? null]);
        if (fromUsd === null || ownUsd === null) return result(refuse(s, "aio.move: no price right now to check it against this script's max per trade"));
        const moveUsd = amount * fromUsd;
        const capUsd = s.budget.maxSolPerTrade * ownUsd;
        if (moveUsd > capUsd * 1.0001) {
          return result(refuse(s, `aio.move: about $${moveUsd.toFixed(2)} is over this script's max per trade (${s.budget.maxSolPerTrade} ${nativeSymbolOf(scriptChain(s))}, about $${capUsd.toFixed(2)})`));
        }
        const day = new Date().toISOString().slice(0, 10);
        const m = aioMoves.get(s.id);
        const used = m && m.day === day ? m.n : 0;
        if (used >= AIO_MOVES_PER_DAY) return answer(false, undefined, `aio.move: ${AIO_MOVES_PER_DAY} moves today already — every move pays Relay and Krypt's fee`);
        aioMoves.set(s.id, { day, n: used + 1 });
        const r = await chain(s, () => aioHooks!.move(from as 'solana', to as 'solana', amount));
        slog(s, r.ok ? 'info' : 'warn', `move ${amount} ${nativeSymbolOf(from as ChainKind)} ${from} → ${to}: ${r.message}${r.txHash ? ` (${r.txHash.slice(0, 12)}…)` : ''}`);
        return result({ ok: r.ok, message: r.message });
      }
      case 'walletScores': {
        const o = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
        const window = o.window === undefined ? 'week' : o.window;
        if (!(SCOUT_WINDOWS as readonly unknown[]).includes(window)) return answer(false, undefined, `walletScores: window must be one of ${SCOUT_WINDOWS.join(', ')}`);
        return answer(true, h.walletScores(scriptChain(s), window as ScoutWindow, clampInt(o.limit, 1, 50, 20), o.onlyWorthALook === true));
      }
      case 'walletRecord': {
        const address = typeof args[0] === 'string' ? args[0].trim().slice(0, 64) : '';
        if (!address) return answer(false, undefined, 'walletRecord: pass a wallet address');
        return answer(true, h.walletRecord(address, scriptChain(s)));
      }
      case 'copyConfigs':
        return answer(true, h.copyConfigs());
      case 'alerts':
        // Alerts are a Solana-side feature (shared/alerts.ts carries no chain).
        return answer(true, scriptChain(s) === 'solana' ? h.alerts() : []);
      // ── Housekeeping the pages have (2026-09-27) ─────────────────────────
      // Each is the matching page button. Side effects, so they are charged
      // as actions and refused off Solana (orders, alerts and templates are
      // Solana-side features); the fired-alerts sweep is free like
      // clearCompletedOrders.
      case 'cancelOrder':
      case 'removeAlert': {
        const id = typeof args[0] === 'string' ? args[0].trim().slice(0, 64) : '';
        if (!id) return answer(false, undefined, `${method}: pass an id`);
        if (scriptChain(s) !== 'solana') return answer(false, undefined, `${method}: Solana only`);
        // Orders are live-only, and this cancels ANY order by id — a paper
        // script must not be able to pull a hand-placed live stop
        // (audit 2026-09-27). Alerts are neither paper nor live.
        if (method === 'cancelOrder' && s.mode === 'paper') return answer(true, { ok: false, message: 'paper: orders are live-only, nothing was cancelled' });
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `${method}: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        const r = method === 'cancelOrder' ? h.cancelOrder(id) : h.removeAlert(id);
        slog(s, r.ok ? 'info' : 'warn', `${method} ${id.slice(0, 12)}: ${r.message}`);
        return answer(true, r);
      }
      case 'muteAlert': {
        const id = typeof args[0] === 'string' ? args[0].trim().slice(0, 64) : '';
        if (!id) return answer(false, undefined, 'muteAlert: pass an id');
        if (scriptChain(s) !== 'solana') return answer(false, undefined, 'muteAlert: Solana only');
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `muteAlert: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        const r = h.muteAlert(id, args[1] !== false);
        slog(s, r.ok ? 'info' : 'warn', `${args[1] !== false ? 'mute' : 'unmute'} alert ${id.slice(0, 12)}: ${r.message}`);
        return answer(true, r);
      }
      case 'clearFiredAlerts':
        if (scriptChain(s) !== 'solana') return answer(false, undefined, 'clearFiredAlerts: Solana only');
        return answer(true, h.clearFiredAlerts());
      case 'resumeOrders': {
        if (scriptChain(s) !== 'solana') return answer(false, undefined, 'resumeOrders: Solana only');
        // Re-arming spends for real when an order fires: a paper script keeps
        // its paper, and live has to be possible, the same gates an order
        // placed by this script passes.
        if (s.mode === 'paper') return answer(true, { ok: false, message: 'paper: orders are live-only, nothing was resumed' });
        const blocked = h.liveBlockedReason('solana');
        if (blocked) return answer(true, { ok: false, message: `not resumed — ${blocked}` });
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `resumeOrders: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        const r = h.resumeOrders();
        slog(s, r.ok ? 'info' : 'warn', `resume paused orders: ${r.message}`);
        return answer(true, r);
      }
      case 'saveTemplate': {
        if (scriptChain(s) !== 'solana') return answer(false, undefined, 'saveTemplate: Solana only');
        // Templates arm REAL orders on the user's manual buys: a paper script
        // rehearses trading, not the user's live setup (audit 2026-09-27).
        if (s.mode === 'paper') return answer(true, { ok: false, message: 'paper: templates arm live orders, nothing was saved' });
        const t = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
        const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
        const tps = Array.isArray(t.takeProfits) ? t.takeProfits : [];
        if (tps.length > 3) return answer(false, undefined, 'saveTemplate: at most 3 take-profit rungs');
        const clean: OrderTemplate = {
          id: typeof t.id === 'string' && t.id.trim() ? t.id.trim().slice(0, 64) : `t_${Date.now().toString(36)}`,
          // Not cut to 40 here: validateTemplate refuses an over-long name
          // with its reason, which the doc promises; a silent trim would not.
          name: String(t.name ?? '').trim().slice(0, 200),
          stopLossPct: num(t.stopLossPct),
          takeProfits: tps.map((x) => {
            const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
            return { gainPct: Number(o.gainPct), sellPct: Number(o.sellPct) };
          }),
          trailingPct: num(t.trailingPct),
          sellOnDevSell: t.sellOnDevSell === true,
        };
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `saveTemplate: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        const r = h.saveTemplate(clean);
        slog(s, r.ok ? 'info' : 'warn', `save template "${clean.name}": ${r.message}`);
        return answer(true, { ...r, templates: h.templates() });
      }
      case 'deleteTemplate':
      case 'setActiveTemplate': {
        if (scriptChain(s) !== 'solana') return answer(false, undefined, `${method}: Solana only`);
        if (s.mode === 'paper') return answer(true, { ok: false, message: 'paper: templates arm live orders, nothing was changed' });
        const raw = args[0];
        if (method === 'deleteTemplate' && (typeof raw !== 'string' || !raw.trim())) return answer(false, undefined, 'deleteTemplate: pass a template id');
        if (method === 'setActiveTemplate' && raw !== null && (typeof raw !== 'string' || !raw.trim())) return answer(false, undefined, 'setActiveTemplate: pass a template id, or null for off');
        const id = typeof raw === 'string' ? raw.trim().slice(0, 64) : null;
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `${method}: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        const r = method === 'deleteTemplate' ? h.deleteTemplate(id as string) : h.setActiveTemplate(id);
        slog(s, r.ok ? 'info' : 'warn', `${method} ${id ?? 'null'}: ${r.message}`);
        return answer(true, method === 'deleteTemplate' ? { ...r, templates: h.templates() } : r);
      }
      case 'settings':
        return answer(true, h.settings());
      case 'analyze': {
        // The one read that spends the user's own money: their AI key, per
        // uncached call. Rate-limited as an action AND capped per hour, so a
        // script that asks on every launch cannot run a bill up unnoticed.
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'analyze: bad mint');
        const rt = rtFor(s);
        const now = Date.now();
        if (rateLimited(s, rt, now)) return answer(false, undefined, `analyze: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        rt.analyses = rt.analyses.filter((t) => now - t < 3_600_000);
        if (rt.analyses.length >= AI_ANALYSES_PER_HOUR) return answer(false, undefined, `analyze: over ${AI_ANALYSES_PER_HOUR} AI analyses in an hour (it spends your key)`);
        // The slot is taken BEFORE the await: twenty-one calls fired in one
        // tick would otherwise all see an empty hour and all spend. A call
        // the host refuses (AI off, no key) gives its slot back.
        rt.analyses.push(now);
        try {
          const a = await h.analyze(mint, scriptChain(s));
          return answer(true, a);
        } catch (err) {
          const i = rt.analyses.indexOf(now);
          if (i >= 0) rt.analyses.splice(i, 1);
          return answer(false, undefined, `analyze: ${(err as Error).message}`);
        }
      }
      case 'positions': {
        const now = Date.now();
        const out: RuleContext[] = [];
        const rtp = rtFor(s);
        // An unreadable wallet is not an empty one (2026-09-27). The host
        // answers a failed holdings read with [], and a script that believed
        // it — an RPC outage, an hour without network — decided every bag it
        // held was "no longer held", cancelled its stops and take-profits and
        // stopped managing real positions. heldMints says null on exactly
        // that failure (same shared read, no extra request), so the script
        // gets a rejection it can treat as "unknown, try again".
        const [list, held] = await Promise.all([h.positions(s.mode, scriptChain(s)), h.heldMints ? h.heldMints(s.mode, scriptChain(s)) : Promise.resolve(undefined)]);
        if (held === null) return answer(false, undefined, 'positions: the wallet could not be read just now — unknown, not empty; try again next pass');
        for (const p of list.filter((x) => rtp.opened.has(x.mint))) {
          const row = h.launch(p.mint);
          let c = row ? contextFromLaunch(row, now) : emptyContext(p.mint, p.symbol, p.name);
          c = withMarket(c, h.marketCached(p.mint, scriptChain(s)));
          c = withLaunchLinks(c, scriptChain(s) === 'solana' ? (h.launchLinks?.(p.mint) ?? null) : null);
          c = withLaunchIntel(c, scriptChain(s) === 'solana' ? (h.launchIntelCached?.(p.mint) ?? null) : null);
          c = withPosition(c, withPeak(s.mode, p), now);
          out.push(withGlobals(c, { walletSol: h.wallet(scriptChain(s)).sol, now }));
        }
        return answer(true, out);
      }
      case 'orders': {
        const [mint] = args;
        if (mint !== undefined && !isMint(mint)) return answer(false, undefined, 'orders: bad mint');
        // Solana's advanced orders; an EVM script has none (it was handed Solana's).
        return answer(true, evm ? [] : h.orders(mint));
      }
      case 'runners': {
        const now = Date.now();
        const c = scriptChain(s);
        // A Robinhood or BNB script reads its OWN chain's flags (2026-09-29:
        // it was handed Solana's list — base58 mints it could not trade).
        if (c !== 'solana') return answer(true, (evmRunnerSource?.(c as EvmChainKind) ?? []).map((f) => contextFromEvmRunner(f, evmHooks?.launch(c as EvmChainKind, f.token) ?? null, now)));
        return answer(true, h.runners().map((f) => contextFromRunner(f, h.launch(f.mint), now)));
      }
      case 'leaders':
        // This chain's followed wallets only (they came mixed, with no chain).
        return answer(true, h.leaders().filter((l) => (l.chain ?? 'solana') === scriptChain(s)));
      case 'wallet':
        // The script's OWN chain wallet — an EVM script read Solana's.
        return answer(true, h.wallet(scriptChain(s)));
      case 'getState':
        return answer(true, rtFor(s).kv);
      case 'setState': {
        const obj = args[0];
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return answer(false, undefined, 'setState: pass an object');
        let bytes = 0;
        try {
          bytes = JSON.stringify(obj).length;
        } catch {
          return answer(false, undefined, 'setState: not serialisable');
        }
        if (bytes > MAX_STATE_BYTES) return answer(false, undefined, `setState: over ${MAX_STATE_BYTES / 1024} KB`);
        rtFor(s).kv = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
        persist(true);
        return answer(true, true);
      }
      case 'disable': {
        const reason = String(args[0] ?? 'disabled by the script').slice(0, 120);
        answer(true, true);
        disable(s, reason);
        return;
      }
      case 'every': {
        const sec = Math.max(MIN_INTERVAL_S, Math.min(3_600, Math.round(Number(args[0]) || 0)));
        const rt = rtFor(s);
        // The sandbox numbers each bot.every call; an older harness sends no
        // id and keeps the old single-timer behaviour under id 0.
        const rawId = Number(args[1]);
        const id = Number.isInteger(rawId) && rawId > 0 && rawId < 1_000 ? rawId : 0;
        if (!rt.intervalTimers.has(id) && rt.intervalTimers.size >= MAX_INTERVAL_TIMERS) {
          return answer(false, undefined, `every: at most ${MAX_INTERVAL_TIMERS} timers per script`);
        }
        const old = rt.intervalTimers.get(id);
        if (old) clearInterval(old);
        rt.intervalTimers.set(id, setInterval(() => enqueue(s, 'interval', { at: Date.now(), id: id || undefined }), sec * 1000));
        // The fastest timer, for the monitor's "every N s".
        rt.intervalSec = rt.intervalSec === null ? sec : Math.min(rt.intervalSec, sec);
        slog(s, 'info', `timer every ${sec} s`);
        return answer(true, sec);
      }
      case 'at': {
        const hhmm = String(args[0] ?? '');
        if (!HHMM.test(hhmm)) return answer(false, undefined, "at: pass 'HH:MM'");
        if (rtFor(s).atTimers.size >= 12 && !rtFor(s).atTimers.has(hhmm)) return answer(false, undefined, 'at: at most 12 daily times');
        armAt(s, rtFor(s), hhmm);
        slog(s, 'info', `daily at ${hhmm}`);
        return answer(true, hhmm);
      }
      default:
        return answer(false, undefined, `unknown method ${method}`);
    }
  } catch (err) {
    answer(false, undefined, (err as Error).message);
  }
}

// ── Event feed ────────────────────────────────────────────────────────

/**
 * `chain` is the chain the EVENT happened on. A script only ever sees its own
 * chain's events: the same mint string can exist on two of them, the facts
 * behind a rule differ per chain, and a buy fired from a Solana launch onto a
 * BNB wallet would be a real trade on the wrong rail. So this is a safety
 * filter, not a tidiness one.
 */
function fanOut(trigger: string, eventName: string, mint: string, chain: ChainKind, build: (s: UserScript) => Promise<RuleContext>, throttle?: { map: (rt: Runtime) => Map<string, number>; ms: number }): void {
  const now = Date.now();
  for (const s of scripts) {
    if (!s.enabled) continue;
    if (scriptChain(s) !== chain) continue;
    if (s.kind === 'rules' && s.rules.trigger !== trigger) continue;
    const rt = rtFor(s);
    if (s.kind === 'code') {
      if (!rt.running) continue;
      if (throttle && mint) {
        const m = throttle.map(rt);
        const last = m.get(mint) ?? 0;
        if (now - last < throttle.ms) continue;
        m.set(mint, now);
        if (m.size > 2_000) m.delete(m.keys().next().value as string);
      }
    }
    if (rt.building >= BUILD_CAP && CHATTER.has(eventName)) {
      rt.health.dropped += 1;
      continue;
    }
    rt.building += 1;
    void bounded(build(s))
      .then((ctx) => {
        if (s.kind === 'rules') return runRules(s, ctx);
        enqueue(s, eventName, ctx);
        return undefined;
      })
      // A host read that throws must not become an unhandled rejection in
      // main (the crash guard would shout "check your position" for a
      // script's context build).
      .catch(() => undefined)
      .finally(() => {
        rt.building -= 1;
      });
  }
}

/**
 * Contexts being built per script, and the ceiling on them (2026-09-27).
 * Each build awaits the positions read before the event is even queued, so a
 * stalled wallet read (an RPC that hangs, a network hour) left one pending
 * build per launch, update and tick — hundreds a second, all retained until
 * the read came back and then dumped into a queue that keeps fifty. Past the
 * ceiling, launch and tick chatter is dropped before any work (and counted on
 * the health line); runner flags, orders, positions and fills never are.
 */
const BUILD_CAP = 200;
/**
 * A build that has not settled by then is given up (the event is dropped).
 * The soak's hung read never settled at all, and without this the 200 it
 * left behind held the ceiling shut for good: launch and tick events for
 * that script stopped for the life of the app (2026-09-27).
 */
let BUILD_TIMEOUT_MS = 15_000;
/** Test seam. */
export function _setBuildTimeout(ms: number | null): void {
  BUILD_TIMEOUT_MS = ms ?? 15_000;
}
function bounded<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('context build timed out')), BUILD_TIMEOUT_MS);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
const CHATTER = new Set(['launch', 'launchUpdate', 'tick']);

/**
 * One payload to every RUNNING code script on a chain (2026-09-27). Rules
 * have no trigger for these events — the rule editor's triggers are a fixed
 * list — so only scripts hear them. Same back-pressure as fanOut: a script
 * already building BUILD_CAP payloads drops this one and counts it.
 */
function toCodeScripts(eventName: string, chain: ChainKind, build: (s: UserScript) => Promise<unknown>, only?: (s: UserScript, rt: Runtime) => boolean): void {
  for (const s of scripts) {
    if (!s.enabled || s.kind !== 'code') continue;
    if (scriptChain(s) !== chain) continue;
    const rt = rtFor(s);
    if (!rt.running) continue;
    if (only && !only(s, rt)) continue;
    if (rt.building >= BUILD_CAP) {
      rt.health.dropped += 1;
      continue;
    }
    rt.building += 1;
    void bounded(build(s))
      .then((payload) => enqueue(s, eventName, payload))
      .catch(() => undefined)
      .finally(() => {
        rt.building -= 1;
      });
  }
}

function copyFillPayload(t: CopyTrade): Record<string, unknown> {
  return {
    id: t.id,
    configId: t.configId,
    wallet: t.wallet,
    mint: t.mint,
    symbol: t.symbol,
    side: t.kind === 'exit' ? 'sell' : 'buy',
    mode: t.mode,
    state: t.state,
    theirSol: t.theirSol,
    ourSol: t.ourSol,
    pnlSol: t.pnlSol,
    reason: t.reason,
    direction: t.direction ?? 'copy',
    at: t.at,
  };
}

/**
 * A coin's curve completed and it migrated (pump.fun, Meteora DBC). Every
 * Solana script hears it: graduations are a few a minute, and the coins a
 * script cares about are often ones it does not hold yet.
 */
export function onMigration(mint: string): void {
  if (!host || !scripts.some((s) => s.enabled)) return;
  // isMayhem rides along (2026-09-29): a script buying graduations has to
  // tell a classic curve from a mayhem one at the moment it hears this, and
  // the launch context only carries the flag on runner events.
  const isMayhem = host.launchMayhem?.(mint) ?? null;
  toCodeScripts('migration', 'solana', async (s) => ({ ...(await ctxFor(s, mint)), migrated: true, isMayhem }));
}

/** The curve levels a script hears (curveHigh). Each fires once per coin. */
export const CURVE_HIGH_LEVELS = [90, 93, 95, 97] as const;
/** mint -> the highest level already announced. Bounded: oldest dropped. */
const curveFired = new Map<string, number>();
const CURVE_FIRED_CAP = 5_000;

/**
 * A pump trade moved a curve (every trade on the feed, tracked or not). The
 * first time a coin reaches each of 90/93/95/97 %, every enabled Solana code
 * script hears `curveHigh` — the coins that are about to complete, which a
 * script could not see before (launchUpdate stops ~15 s after launch unless
 * something holds the coin). A jump over several levels announces the
 * highest once. Cheap on the hot path: two comparisons when nothing listens.
 */
export function onCurveTrade(mint: string, curvePct: number, priceSol: number): void {
  if (!(curvePct >= CURVE_HIGH_LEVELS[0]) || !host) return;
  if (!scripts.some((s) => s.enabled && s.kind === 'code')) return;
  let level = 0;
  for (const l of CURVE_HIGH_LEVELS) if (curvePct >= l) level = l;
  const prev = curveFired.get(mint) ?? 0;
  if (level <= prev) return;
  curveFired.delete(mint);
  curveFired.set(mint, level);
  if (curveFired.size > CURVE_FIRED_CAP) curveFired.delete(curveFired.keys().next().value as string);
  const isMayhem = host.launchMayhem?.(mint) ?? null;
  const pct = Math.round(curvePct * 100) / 100;
  toCodeScripts('curveHigh', 'solana', async (s) => {
    const c = await ctxFor(s, mint);
    return { ...c, curvePct: pct, curveLevel: level, priceSol: priceSol > 0 ? priceSol : c.priceSol, isMayhem };
  });
}

/**
 * The creator wallet sold on a pump curve. Only scripts that hold or
 * subscribed to the coin hear it — dev sells happen on most launches, and a
 * script screening the firehose has creatorSold on every launchUpdate.
 */
export function onDevSell(mint: string, facts: { sol: number; tokens: number; priceSol: number }): void {
  if (!host || !scripts.some((s) => s.enabled)) return;
  toCodeScripts(
    'devSell',
    'solana',
    async (s) => {
      const c = await ctxFor(s, mint);
      c.creatorSold = true;
      if (facts.priceSol > 0) c.priceSol = facts.priceSol;
      return { ...c, devSoldSol: facts.sol, devSoldTokens: facts.tokens };
    },
    (_s, rt) => rt.opened.has(mint) || rt.subscribed.has(mint),
  );
}

/** The engine's events, as they happen. Cheap on the hot path: nothing is
 *  built for a script that is not listening. */
export function onEngineEvent(ev: EngineEvent): void {
  if (!host || !scripts.some((s) => s.enabled)) return;
  const h = host;
  switch (ev.kind) {
    case 'launch':
    case 'launchUpdate': {
      const row = ev.launch;
      const trigger = ev.kind === 'launch' ? 'launch' : 'launch_update';
      fanOut(trigger, ev.kind, row.mint, 'solana', (s) => ctxFor(s, row.mint, contextFromLaunch(row, Date.now())), ev.kind === 'launchUpdate' ? { map: (rt) => rt.lastUpdateAt, ms: LAUNCH_UPDATE_THROTTLE_MS } : undefined);
      return;
    }
    case 'runner': {
      const f = ev.runner;
      knownRunners.add(f.mint);
      fanOut('runner', 'runner', f.mint, 'solana', (s) => ctxFor(s, f.mint, contextFromRunner(f, h.launch(f.mint), Date.now())));
      return;
    }
    // The whole list, pushed when expiry removed some of it: every mint that
    // was flagged and is no longer listed has expired (2026-09-27).
    case 'runners': {
      const still = new Set(ev.runners.map((r) => r.mint));
      const gone = [...knownRunners].filter((m) => !still.has(m));
      knownRunners = still;
      for (const mint of gone) toCodeScripts('runnerExpired', 'solana', (s) => ctxFor(s, mint));
      return;
    }
    // The trading wallet's token accounts changed — the same rows
    // bot.holdings answers, pushed rather than polled (2026-09-27).
    case 'holdings': {
      const rows = ev.data.map(scriptHoldingFromWallet);
      const at = ev.at;
      toCodeScripts('holdings', 'solana', async () => ({ at, holdings: rows }));
      return;
    }
    // Copy trading's rows, diffed into "this copy changed state": opened,
    // closed (a mirrored exit), skipped (2026-09-27). The leader's own
    // trade is `leaderTrade`; this is what the app did about it.
    case 'copy': {
      // The FIRST snapshot is history — copy trading reloads its persisted
      // rows and puts the newest 100 in `recent` — so it seeds the diff and
      // announces nothing (audit 2026-09-27: it would have pushed 100 stale
      // copyFill events into every script's 50-slot queue). From then on a
      // new row or a changed state is an event, at most a handful a snapshot.
      let announced = 0;
      for (const t of ev.snapshot.recent) {
        const prev = copyStates.get(t.id);
        copyStates.set(t.id, t.state);
        if (copyStates.size > 4_000) copyStates.delete(copyStates.keys().next().value as string);
        if (!copySeeded || prev === t.state) continue;
        if (++announced > COPY_FILLS_PER_SNAPSHOT) continue;
        const row = t;
        toCodeScripts('copyFill', row.chain ?? 'solana', async () => copyFillPayload(row));
      }
      copySeeded = true;
      return;
    }
    case 'tick': {
      const mint = ev.mint;
      const price = ev.priceSol;
      for (const s of scripts) {
        if (!s.enabled) continue;
        const rt = rtFor(s);
        if (!rt.opened.has(mint) && !rt.subscribed.has(mint)) continue;
        const last = rt.lastTickAt.get(mint) ?? 0;
        const now = Date.now();
        if (now - last < TICK_THROTTLE_MS) continue;
        rt.lastTickAt.set(mint, now);
        if (rt.lastTickAt.size > 2_000) rt.lastTickAt.delete(rt.lastTickAt.keys().next().value as string);
        if (s.kind === 'rules' && s.rules.trigger !== 'tick') continue;
        if (s.kind === 'code' && !rt.running) continue;
        if (rt.building >= BUILD_CAP) {
          rt.health.dropped += 1;
          continue;
        }
        rt.building += 1;
        void bounded(ctxFor(s, mint))
          .then((c) => {
            if (price > 0) c.priceSol = price;
            if (s.kind === 'rules') return runRules(s, c);
            enqueue(s, 'tick', c);
            return undefined;
          })
          .catch(() => undefined)
          .finally(() => {
            rt.building -= 1;
          });
      }
      return;
    }
    case 'orders': {
      // Snapshots, not events — diff them into "this order changed state".
      for (const o of ev.snapshot.orders) {
        const prev = orderStates.get(o.id);
        orderStates.set(o.id, o.state);
        if (prev === undefined || prev === o.state) continue;
        if (!['triggered', 'filled', 'failed', 'cancelled', 'expired', 'paused'].includes(o.state)) continue;
        fanOut('order', 'order', o.mint, 'solana', async (s) => {
          const c = await ctxFor(s, o.mint);
          if (!c.symbol && o.symbol) c.symbol = o.symbol;
          return withOrder(c, { kind: o.kind, state: o.state, amount: o.amount });
        });
      }
      if (orderStates.size > 5_000) orderStates.delete(orderStates.keys().next().value as string);
      return;
    }
    case 'alerts': {
      for (const a of ev.alerts) {
        const prev = alertFires.get(a.id);
        alertFires.set(a.id, a.lastFiredAt);
        if (prev === undefined || a.lastFiredAt === null || prev === a.lastFiredAt) continue;
        fanOut('alert', 'alert', a.mint, 'solana', async (s) => {
          const c = await ctxFor(s, a.mint);
          if (!c.symbol && a.symbol) c.symbol = a.symbol;
          return withAlert(c, { kind: a.kind, threshold: a.threshold });
        });
      }
      if (alertFires.size > 5_000) alertFires.delete(alertFires.keys().next().value as string);
      return;
    }
    case 'evmFill': {
      // A LIVE fill on Robinhood or BNB (2026-10-03: only paper EVM fills
      // reached scripts). To the scripts on that chain that hold the token.
      const f = ev.fill;
      if (ev.state === 'landed') return;
      for (const s of scripts) {
        if (!s.enabled || s.kind !== 'code' || scriptChain(s) !== f.chain) continue;
        if (!rtFor(s).opened.has(f.token)) continue;
        enqueue(s, 'fill', { mint: f.token, side: f.side, ok: ev.state !== 'failed' });
      }
      void pollPositions();
      return;
    }
    case 'fill':
    case 'paper': {
      for (const s of scripts) {
        if (!s.enabled) continue;
        const rt = rtFor(s);
        if (!rt.opened.has(ev.mint)) continue;
        if (s.kind === 'code') enqueue(s, 'fill', { mint: ev.mint, side: ev.side, ok: ev.kind === 'paper' || ev.state !== 'failed' });
      }
      void pollPositions();
      return;
    }
    default:
      return;
  }
}

/**
 * An EVM chain's measurement window closed on a tracked launch.
 *
 * This is the EVM counterpart of `launch` / `launchUpdate`, and it only ever
 * reaches scripts on that same chain. The first window a launch produces is
 * its `launch`; every later one is a `launch_update`, which keeps the two
 * rails' triggers meaning the same thing to a rule.
 */
/**
 * EVM reads a script on Robinhood or BNB needs and the engine host does not
 * carry (2026-10-03, parity with Solana): the scanner's launch for a token,
 * whether the script made every buy of a bag, this install's EVM trades, the
 * chain coin's USD price, and the chain's wallet list. Wired in ipc.ts.
 */
export interface EvmScriptHooks {
  launch(chain: EvmChainKind, token: string): EvmScanLaunch | null;
  /** True when every reconciled buy of `token` in the chain's signer is one
   *  of `hashes`; null when that cannot be told. */
  ownsWholeBag(chain: EvmChainKind, token: string, hashes: string[]): boolean | null;
  history(chain: EvmChainKind, limit: number): unknown[];
  nativeUsd(chain: ChainKind): Promise<number | null>;
  /** `native` = that wallet's last-read balance on this chain; null unknown. */
  wallets(chain: EvmChainKind): Array<{ address: string; label: string; active: boolean; native?: number | null }>;
  /** A trade by one of the user's OTHER wallets on this chain, by address —
   *  the same rules as Solana's (own wallet only, the multi-wallet
   *  acknowledgement). Optional: a build without it refuses. */
  walletTrade?(chain: EvmChainKind, side: 'buy' | 'sell', address: string, token: string, amount: number): Promise<{ ok: boolean; message: string }>;
  /** A token's symbol and name from the last market read, or null. */
  identity?(chain: EvmChainKind, token: string): { symbol: string; name: string } | null;
}
let evmHooks: EvmScriptHooks | null = null;
export function setEvmScriptHooks(h: EvmScriptHooks | null): void {
  evmHooks = h;
}

/** Coins an ENABLED script holds on a chain — Compress leaves them to their
 *  script rather than selling a running bot's bag (v6 audit 2026-10-03). */
export function heldByScripts(chain: ChainKind): Set<string> {
  const out = new Set<string>();
  for (const s of scripts) {
    if (!s.enabled || scriptChain(s) !== chain) continue;
    for (const m of rtFor(s).opened.keys()) out.add(chain === 'solana' ? m : m.toLowerCase());
  }
  return out;
}

/**
 * The All-in-One wallet, for scripts (2026-10-03): read it, move money
 * between its chains, and fund a buy from the other chains. Wired in ipc.ts
 * to the same code the AIO page uses — the same quotes, signer rules and
 * Krypt fee. Null = no wallet support in this build (tests).
 */
export interface AioScriptHooks {
  /** The All-in-One wallet exists and signs on every chain. */
  active(): boolean;
  info(): unknown;
  balances(): Promise<unknown>;
  move(from: 'solana' | 'bnb' | 'robinhood', to: 'solana' | 'bnb' | 'robinhood', amount: number): Promise<{ ok: boolean; message: string; txHash?: string }>;
  /** Make `chain` hold enough for a buy of `amount`, topping it up from the
   *  other chains if needed (unattended: a costly top-up is refused). */
  fund(chain: 'solana' | 'bnb' | 'robinhood', amount: number): Promise<{ ok: boolean; message: string; funded: unknown | null }>;
  /** A top-up whose buy then failed is billed as a move; the sentence to log. */
  bill(funded: unknown): Promise<string>;
}
let aioHooks: AioScriptHooks | null = null;
export function setAioScriptHooks(h: AioScriptHooks | null): void {
  aioHooks = h;
}
/** Moves a script may make in a day — every one pays Relay and Krypt's fee. */
const AIO_MOVES_PER_DAY = 20;
const aioMoves = new Map<string, { day: string; n: number }>();

/** What each chain keeps back to pay for selling (aioConvert CHAIN_RESERVE). */
const EXIT_GAS: Record<string, number> = { bnb: 0.0005, robinhood: 0.0001 };

/** Where an EVM chain's runner flags are read (the chain scanner, wired in
 *  ipc.ts beside its launch hook). Null = none (tests, a build without it). */
let evmRunnerSource: ((chain: EvmChainKind) => EvmRunnerFlag[]) | null = null;
export function setEvmRunnerSource(fn: ((chain: EvmChainKind) => EvmRunnerFlag[]) | null): void {
  evmRunnerSource = fn;
}

/**
 * The chain scanner flagged a runner on Robinhood or BNB (2026-09-29). Scripts
 * on that chain hear the same `runner` event a Solana script does; until now
 * they heard nothing, and bot.runners() gave them Solana's list.
 */
export function onEvmRunner(chain: ChainKind, flag: EvmRunnerFlag, launch: EvmScanLaunch | null): void {
  if (!host || !scripts.some((s) => s.enabled && scriptChain(s) === chain)) return;
  const base = contextFromEvmRunner(flag, launch, Date.now());
  fanOut('runner', 'runner', flag.token, chain, async (s) => ctxFor(s, flag.token, base));
}

export function onEvmLaunch(chain: ChainKind, launch: EvmScanLaunch): void {
  if (!host || !scripts.some((s) => s.enabled && scriptChain(s) === chain)) return;
  const first = (launch.windows?.length ?? 0) <= 1;
  const trigger = first ? 'launch' : 'launch_update';
  const base = contextFromEvmLaunch(launch, Date.now());
  fanOut(
    trigger,
    trigger === 'launch' ? 'launch' : 'launchUpdate',
    launch.token,
    chain,
    async (s) => ctxFor(s, launch.token, base),
    first ? undefined : { map: (rt) => rt.lastUpdateAt, ms: LAUNCH_UPDATE_THROTTLE_MS },
  );
}

/**
 * A price print on Robinhood or BNB (the chain scanner, 2026-10-03), as the
 * same `tick` a Solana script hears — for the tokens a script holds or
 * subscribed to. Until now an EVM script had no price stream at all.
 */
export function onEvmTick(chain: ChainKind, token: string, priceNative: number): void {
  if (!host || !(priceNative > 0)) return;
  const mint = token.toLowerCase();
  for (const s of scripts) {
    if (!s.enabled || scriptChain(s) !== chain) continue;
    const rt = rtFor(s);
    if (!rt.opened.has(mint) && !rt.subscribed.has(mint)) continue;
    const now = Date.now();
    if (now - (rt.lastTickAt.get(mint) ?? 0) < TICK_THROTTLE_MS) continue;
    rt.lastTickAt.set(mint, now);
    if (s.kind === 'rules' && s.rules.trigger !== 'tick') continue;
    if (s.kind === 'code' && !rt.running) continue;
    if (rt.building >= BUILD_CAP) {
      rt.health.dropped += 1;
      continue;
    }
    rt.building += 1;
    void bounded(ctxFor(s, mint))
      .then((c) => {
        c.priceSol = priceNative;
        if (s.kind === 'rules') return runRules(s, c);
        enqueue(s, 'tick', c);
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        rt.building -= 1;
      });
  }
}

/** A followed wallet traded (copy trading's watcher). */
export function onLeaderTrade(t: LeaderTrade): void {
  if (!host || !scripts.some((s) => s.enabled)) return;
  fanOut('leader_trade', 'leaderTrade', t.mint, t.chain ?? 'solana', async (s) => {
    const c = await ctxFor(s, t.mint);
    if (!c.symbol && t.symbol) c.symbol = t.symbol;
    return withLeader(c, t);
  });
}

/** Position rules and `position` events, over what each script holds. */
export async function pollPositions(): Promise<void> {
  const h = host;
  if (!h) return;
  const now = Date.now();
  for (const s of scripts) {
    if (!s.enabled) continue;
    const rt = rtFor(s);
    if (s.kind === 'rules' && s.rules.trigger !== 'position') {
      await reconcileOpened(s, rt);
      continue;
    }
    if (s.kind === 'code' && !rt.running) continue;
    await reconcileOpened(s, rt);
    // Only this script's own positions. A position rule over the whole wallet
    // would fire, log and notify about bags it can neither own nor sell.
    const held = (await h.positions(s.mode, scriptChain(s))).filter((p) => rt.opened.has(p.mint));
    for (const p of held) {
      h.subscribeTicks(p.mint);
      const row = h.launch(p.mint);
      let c = row ? contextFromLaunch(row, now) : emptyContext(p.mint, p.symbol, p.name);
      c = withMarket(c, h.marketCached(p.mint, scriptChain(s)));
      c = withLaunchLinks(c, scriptChain(s) === 'solana' ? (h.launchLinks?.(p.mint) ?? null) : null);
      c = withLaunchIntel(c, scriptChain(s) === 'solana' ? (h.launchIntelCached?.(p.mint) ?? null) : null);
      c = withPosition(c, withPeak(s.mode, p), now);
      c = withGlobals(c, { walletSol: h.wallet(scriptChain(s)).sol, now });
      if (s.kind === 'rules') await runRules(s, c);
      else enqueue(s, 'position', c);
    }
  }
}

export function startTimers(): void {
  if (positionTimer) return;
  positionTimer = setInterval(() => void pollPositions(), POSITION_POLL_MS);
  healthTimer = setInterval(logHealth, HEALTH_EVERY_MS);
  healthTimer.unref?.();
}

export function stopTimers(): void {
  if (positionTimer) clearInterval(positionTimer);
  positionTimer = null;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  for (const rt of runtimes.values()) {
    clearIntervals(rt);
    if (rt.startRetry) clearTimeout(rt.startRetry);
    rt.startRetry = null;
    clearSchedules(rt);
  }
}

/** Shutdown: persist and stop every sandbox. */
export async function shutdown(): Promise<void> {
  stopTimers();
  persistNow();
  for (const s of scripts) await stopCode(s, 'shutdown');
}

// ── Test seams ────────────────────────────────────────────────────────

export function _reset(): void {
  offSettled?.();
  offSettled = null;
  stopTimers();
  scripts = [];
  bundledSeen = [];
  shipped = [];
  runtimes.clear();
  orderStates.clear();
  alertFires.clear();
  knownRunners = new Set();
  copyStates.clear();
  copySeeded = false;
  peaks.clear();
  restartWindow.clear();
  startChains.clear();
  actChains.clear();
  if (changedTimer) {
    clearTimeout(changedTimer);
    changedTimer = null;
  }
  changedAt = 0;
  loadFailure = null;
  killSwitch = false;
  filePath = '';
}

/**
 * The paper record was reset: every PAPER script forgets the positions it
 * opened and starts its day over (buys, sells, realised), so its budget and
 * loss stop measure the fresh record rather than the one just cleared. Live
 * scripts are not touched.
 */
export function forgetPaper(): number {
  let n = 0;
  for (const s of scripts) {
    if (s.mode !== 'paper') continue;
    const rt = rtFor(s);
    rt.opened.clear();
    rt.buysToday = 0;
    rt.sellsToday = 0;
    rt.realizedToday = 0;
    n += 1;
  }
  for (const k of [...peaks.keys()]) if (k.startsWith('paper:')) peaks.delete(k);
  if (n) {
    persist();
    changed();
  }
  return n;
}

/**
 * Start one script's record over (user ask, 2026-09-24: "everytime i run it
 * it shows the total stats and past stuff"). That history is mostly the
 * script's OWN: it keeps running totals in bot.setState and paints them back
 * into the widget on every start, so clearing the widget alone changes
 * nothing. Cleared: saved state (bot.getState), the widget, the log, the
 * last error, once-per-token and cooldown memory, and this run's callout
 * memory. A running code script is restarted so its in-memory variables go
 * too.
 *
 * Paper and live differ on purpose:
 *   - paper also forgets its positions and starts its day over;
 *   - live KEEPS the positions it still holds — forgetting them is exactly
 *     the orphan that made sells fail with "this script does not hold it" —
 *     and keeps today's buys and realised loss, because those are what its
 *     daily buy cap and loss stop count. A reset must not buy a second day.
 */
export function resetScript(id: string): { ok: boolean; message: string } {
  const s = scripts.find((x) => x.id === id);
  if (!s) return { ok: false, message: 'Script not found' };
  const rt = rtFor(s);
  rt.kv = {};
  rt.metrics.clear();
  rt.log = [];
  rt.lastError = null;
  rt.lastErrorAt = null;
  rt.errorsInARow = 0;
  rt.firedMints.clear();
  rt.lastFireAt.clear();
  rt.calledOut.clear();
  if (s.mode === 'paper') {
    rt.opened.clear();
    rt.buysToday = 0;
    rt.sellsToday = 0;
    rt.realizedToday = 0;
    for (const k of [...peaks.keys()]) if (k.startsWith('paper:')) peaks.delete(k);
  }
  slog(s, 'info', s.mode === 'paper' ? 'reset — saved state, stats, log and paper positions cleared' : 'reset — saved state, stats and log cleared; open live positions and today’s budget kept');
  if (s.kind === 'code' && s.enabled && rt.running) {
    void stopCode(s, 'reset').then(() => {
      if (s.enabled && !killSwitch) void startCode(s);
    });
  }
  persist();
  changed();
  return {
    ok: true,
    message:
      s.mode === 'paper'
        ? `"${s.name}" reset — its stats, saved state, log and paper positions are cleared.`
        : `"${s.name}" reset — its stats, saved state and log are cleared. Open live positions and today’s budget (${rt.buysToday} buys, ${rt.realizedToday.toFixed(4)} realised) are kept.`,
  };
}

/**
 * Scripts holding an opened position in `mint`: the script's name and the
 * wallet it bought with (null = the active wallet). Krypto Trader refuses a
 * (wallet, mint) pair a script already trades — a script "sell all" would
 * otherwise sell the session's tokens.
 */
/**
 * Does any armed script want this mint's live ticks — subscribed to it, or
 * holding a position it opened? Read on the trade hot path (engine
 * ticksWanted), so a lookup per script and nothing else.
 */
export function wantsTicks(mint: string): boolean {
  for (const s of scripts) {
    if (!s.enabled) continue;
    const rt = runtimes.get(s.id);
    if (rt && (rt.subscribed.has(mint) || rt.opened.has(mint))) return true;
  }
  return false;
}

/**
 * Does any armed script want live ticks for anything at all — a subscription
 * or a position it opened? Mint-agnostic: asked before the pump-amm feed
 * decodes a delivery, where the mint is not known yet (2026-09-27).
 */
export function wantsAnyTicks(): boolean {
  for (const s of scripts) {
    if (!s.enabled) continue;
    const rt = runtimes.get(s.id);
    if (rt && (rt.subscribed.size > 0 || rt.opened.size > 0)) return true;
  }
  return false;
}

export function openedOn(mint: string): { script: string; wallet: string | null }[] {
  const out: { script: string; wallet: string | null }[] = [];
  for (const s of scripts) {
    const e = runtimes.get(s.id)?.opened.get(mint);
    if (e) out.push({ script: s.name, wallet: e.wallet ?? null });
  }
  return out;
}

export function _runtimeOf(id: string): { opened: string[]; firedMints: string[]; realizedToday: number; buysToday: number; kv: Record<string, unknown>; subscribed: string[]; atTimers: string[] } | null {
  const rt = runtimes.get(id);
  if (!rt) return null;
  return { opened: [...rt.opened.keys()], firedMints: [...rt.firedMints], realizedToday: rt.realizedToday, buysToday: rt.buysToday, kv: rt.kv, subscribed: [...rt.subscribed], atTimers: [...rt.atTimers.keys()] };
}

/**
 * Sizes of everything this module keeps in memory, per script and global —
 * what a multi-day soak watches for growth (test/scriptsoak.live.mjs).
 * Numbers only; nothing here names a mint or a secret.
 */
export function _diag(): { global: Record<string, number>; scripts: Record<string, Record<string, number>> } {
  const per: Record<string, Record<string, number>> = {};
  for (const [id, rt] of runtimes) {
    let kvBytes = 0;
    try {
      kvBytes = JSON.stringify(rt.kv).length;
    } catch {
      kvBytes = -1;
    }
    per[id] = {
      firedMints: rt.firedMints.size,
      lastFireAt: rt.lastFireAt.size,
      actions: rt.actions.length,
      analyses: rt.analyses.length,
      opened: rt.opened.size,
      subscribed: rt.subscribed.size,
      calledOut: rt.calledOut.size,
      lastUpdateAt: rt.lastUpdateAt.size,
      lastTickAt: rt.lastTickAt.size,
      atTimers: rt.atTimers.size,
      log: rt.log.length,
      metrics: rt.metrics.size,
      queue: rt.queue.length,
      building: rt.building,
      intervalSec: rt.intervalSec ?? 0,
      intervalTimers: rt.intervalTimers.size,
      errorsInARow: rt.errorsInARow,
      kvBytes,
    };
  }
  return {
    global: {
      scripts: scripts.length,
      runtimes: runtimes.size,
      orderStates: orderStates.size,
      alertFires: alertFires.size,
      peaks: peaks.size,
      restartWindow: restartWindow.size,
      fileLogBudget: fileLogBudget.size,
      actChains: actChains.size,
      startChains: startChains.size,
    },
    scripts: per,
  };
}

/** Test seam: fire a schedule now. */
export async function _fireSchedule(id: string, hhmm: string): Promise<void> {
  const s = scripts.find((x) => x.id === id);
  if (s) await fireSchedule(s, hhmm);
}
