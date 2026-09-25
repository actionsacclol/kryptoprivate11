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
//   5. a script that errors five times in a row is disabled, and a handler
//      that runs past the watchdog is killed and counted as an error;
//   6. every refusal is logged on the script with its reason.
//
// What a script can react to: launches and their updates, runner flags, its
// positions, price ticks on what it holds or subscribed to, trades by the
// wallets followed on Copy Trading, its own advanced orders changing state,
// alerts firing, a daily time, and a timer. What it can do: buy, sell, sell
// everything, place and cancel advanced orders, apply an order template,
// create alerts, watch/unwatch, notify, log, and turn itself off.

import type { AiAnalysis } from '@shared/ai';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../system/logger';
import {
  contextFromEvmLaunch,
  contextFromLaunch,
  contextFromRunner,
  describeAction,
  describeRules,
  emptyContext,
  evaluateRules,
  validateScript,
  withAlert,
  withGlobals,
  withLeader,
  withLaunchLinks,
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
  type RuleAction,
  type RuleContext,
  type ScriptLogLine,
  type ScriptMode,
  type ScriptPosition,
  type ScriptSnapshot,
  type ScriptStats,
  type UserScript,
} from '@shared/automation';
import { MAX_STAT_KEYS, MIN_INTERVAL_S, type SandboxToMain, type ScriptStatValue } from '@shared/scriptProtocol';
import { REPLY_BUDGET, THESIS_BUDGET, calloutPageUrl } from '@shared/calloutAuto';
import { redactWebhook, scriptEmbed, type ScriptEmbed } from '@shared/webhook';
import type { EngineEvent, LaunchRow } from '@shared/types';
import { nativeSymbolOf } from '@shared/evm';
import type { ChainKind } from '@shared/evm';
import type { EvmScanLaunch } from '@shared/evmScan';
import type { RunnerFlag } from '@shared/runners';
import { TRIGGER_BASES } from '@shared/orders';
import type { NewOrderRequest, OrderKind, TriggerBasis } from '@shared/orders';
import type { AlertKind, NewAlertRequest } from '@shared/alerts';
import * as recorder from './recorder';

const FILE = 'automation.json';
const LOG_CAP = 200;
const SNAPSHOT_LOG_LINES = 100;
const LAUNCH_UPDATE_THROTTLE_MS = 2_000;
const TICK_THROTTLE_MS = 1_000;
const POSITION_POLL_MS = 5_000;
const ERRORS_TO_DISABLE = 5;
const QUEUE_CAP = 50;
const MAX_SUBSCRIBED = 50;

export interface OrderView {
  id: string;
  mint: string;
  symbol: string;
  kind: string;
  state: string;
  triggerBasis: string;
  triggerValue: number | null;
  amount: number;
}

export interface LeaderView {
  wallet: string;
  label: string;
  enabled: boolean;
  mode: string;
}

/** A followed wallet's swap, as the engine reports it (copy trading's feed). */
export interface LeaderTrade extends LeaderFacts {
  mint: string;
  symbol: string;
  /** The chain the leader traded on; absent = Solana. Only scripts on that
   *  chain hear it. */
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
  buy(mint: string, sol: number, mode: ScriptMode, chain?: ChainKind, ownCapSol?: number): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean }>;
  /** A sell of `pct`% of what is held, in the script's mode. `realizedSol`
   *  when the fill can say (paper: exact). */
  sell(mint: string, pct: number, mode: ScriptMode, chain?: ChainKind): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean; realizedSol?: number | null }>;
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
  /** The AI second opinion. Spends the user's own key on an uncached call;
   *  throws with the reason when AI is off. Solana only. */
  analyze(mint: string, chain?: ChainKind): Promise<AiAnalysis>;
  /** Open positions in a mode. */
  positions(mode: ScriptMode, chain?: ChainKind): Promise<ScriptPosition[]>;
  /**
   * The mints the active wallet (or the paper book) holds, or NULL when the
   * read failed. `positions` answers a failed read with an empty list, which
   * is fine for display and wrong for deciding a script sold something.
   * Optional so a test host can leave it out; `reconcileOpened` then skips.
   */
  heldMints?(mode: ScriptMode, chain?: ChainKind): Promise<Set<string> | null>;
  wallet(chain?: ChainKind): { sol: number | null; address: string | null };
  orders(mint?: string): OrderView[];
  placeOrder(req: NewOrderRequest): Promise<{ ok: boolean; message: string }>;
  cancelOrders(mint: string): { ok: boolean; message: string; cancelled: number };
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
  intervalTimer: NodeJS.Timeout | null;
  /** Consecutive failed starts, and the timer for the next attempt. A start
   *  can fail for reasons that have nothing to do with the script (a slow
   *  machine, a provider parked behind a 429), and disarming on the first one
   *  made the user re-arm by hand for a stall that would have cleared. */
  startFails: number;
  startRetry: NodeJS.Timeout | null;
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
  subscribed?: string[];
  kv: Record<string, unknown>;
}

let host: AutomationHost | null = null;
let scripts: UserScript[] = [];
const runtimes = new Map<string, Runtime>();
let killSwitch = false;
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
let positionTimer: NodeJS.Timeout | null = null;
/** Order id → last state seen, to turn snapshots into events. */
const orderStates = new Map<string, string>();
/** Alert id → last fired-at seen. */
const alertFires = new Map<string, number | null>();

export function attach(h: AutomationHost): void {
  host = h;
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
    };
    scripts = Array.isArray(raw?.scripts) ? raw.scripts : [];
    killSwitch = raw?.killSwitch === true;
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

function persist(): void {
  if (!filePath || loadFailure) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
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
      subscribed: [...rt.subscribed],
      kv: rt.kv,
    };
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, scripts, runtime, killSwitch }, null, 2), 'utf8');
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
    subscribed: new Set(),
    calledOut: new Map(),
    kv: {},
    lastUpdateAt: new Map(),
    lastTickAt: new Map(),
    intervalSec: null,
    intervalTimer: null,
    startFails: 0,
    startRetry: null,
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
    Object.assign(existing, input, { id: existing.id, createdAt: existing.createdAt, updatedAt: now });
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
      host?.toast('warn', `LIVE script armed: "${existing.name}" — real SOL will be spent within its budget`);
    }
    changed();
    return { ok: true, message: toLive ? 'Saved — switched to live, re-enable to arm it' : 'Saved', id: existing.id };
  }
  if (scripts.length >= MAX_SCRIPTS) return { ok: false, message: `Limit of ${MAX_SCRIPTS} scripts reached` };
  const s: UserScript = { ...input, id: nextId(), createdAt: now, updatedAt: now, enabled: false };
  scripts.unshift(s);
  runtimes.set(s.id, freshRuntime());
  persist();
  changed();
  return { ok: true, message: `Saved "${s.name}" — paper, disabled. Enable it when ready.`, id: s.id };
}

export function remove(id: string): { ok: boolean; message: string } {
  const s = scripts.find((x) => x.id === id);
  if (!s) return { ok: false, message: 'Script not found' };
  void stopCode(s, 'removed');
  clearSchedules(rtFor(s));
  scripts = scripts.filter((x) => x.id !== id);
  const rt = runtimes.get(id);
  if (rt?.intervalTimer) clearInterval(rt.intervalTimer);
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
    if (s.mode === 'live') host?.toast('warn', `LIVE script armed: "${s.name}" — real SOL will be spent within its budget`);
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
    errorsInARow: rt.errorsInARow,
    lastRunAt: rt.lastRunAt,
    lastError: rt.lastError,
    lastErrorAt: rt.lastErrorAt,
    openCount: rt.opened.size,
    firedMints: rt.firedMints.size,
    running: s.kind === 'code' ? rt.running && (host?.sandbox.isRunning(s.id) ?? false) : s.enabled,
  };
}

export function snapshot(): ScriptSnapshot {
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
    scripts: all(),
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
async function ctxFor(s: UserScript, mint: string, base?: RuleContext): Promise<RuleContext> {
  const h = host;
  const now = Date.now();
  if (!h) return base ?? emptyContext(mint);
  const row = h.launch(mint);
  const pos = (await h.positions(s.mode, scriptChain(s))).find((p) => p.mint === mint) ?? null;
  // A bag the user opened by hand still lends its name to the context — the
  // script can watch it and log about it — but it is not this script's
  // POSITION. `held` means "held by this script": that is what the field guide
  // says, what the open-position cap counts, and what the script may sell.
  const mine = rtFor(s).opened.has(mint);
  let c = base ?? (row ? contextFromLaunch(row, now) : emptyContext(mint, pos?.symbol, pos?.name));
  c = withMarket(c, h.marketCached(mint, scriptChain(s)));
  c = withLaunchLinks(c, scriptChain(s) === 'solana' ? (h.launchLinks?.(mint) ?? null) : null);
  c = withPosition(c, mine && pos ? withPeak(s.mode, pos) : null, now);
  c = withGlobals(c, { walletSol: h.wallet().sol, now });
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

type ActResult = { ok: boolean; message: string; count?: number };

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
    rt.opened.delete(mint);
  }
}

function refuse(s: UserScript, why: string): ActResult {
  slog(s, 'warn', `refused — ${why}`);
  return { ok: false, message: why };
}

/** The budget gate every BUY-like action passes: caps, live gates, size. */
async function buyGate(s: UserScript, rt: Runtime, mint: string, sol: number, what: string): Promise<ActResult | null> {
  const h = host as AutomationHost;
  if (!Number.isFinite(sol) || sol <= 0) return refuse(s, `buy ${what}: amount must be a positive number of SOL`);
  if (sol > s.budget.maxSolPerTrade) return refuse(s, `buy ${what}: ${sol} SOL is over the script's max per trade (${s.budget.maxSolPerTrade})`);
  if (rt.buysToday >= s.budget.maxBuysPerDay) return refuse(s, `buy ${what}: ${s.budget.maxBuysPerDay} buys today already`);
  if (rt.realizedToday <= -s.budget.maxLossSolPerDay) {
    disable(s, `down ${Math.abs(rt.realizedToday).toFixed(3)} SOL today, past the ${s.budget.maxLossSolPerDay} SOL loss limit`);
    return { ok: false, message: 'daily loss limit' };
  }
  await reconcileOpened(s, rt);
  if (!rt.opened.has(mint) && rt.opened.size >= s.budget.maxOpenPositions) return refuse(s, `buy ${what}: already holding ${rt.opened.size} positions (max ${s.budget.maxOpenPositions})`);
  if (s.mode === 'live') {
    // The master switch still applies — armed, execution on, no breaker. That
    // is not a rule a script gets to have its own version of; it is the app
    // being off.
    const blocked = h.liveBlockedReason(scriptChain(s)) ?? h.buyBlockedReason(scriptChain(s));
    if (blocked) return refuse(s, `buy ${what}: not executed — ${blocked}`);
    // The app's MANUAL per-trade cap deliberately does NOT apply (2026-09-22).
    // `maxSolPerTrade` above is this script's own, set on the same screen as
    // its code, and it is the authority on its size. Two caps for one decision
    // meant keeping them in step, with the smaller winning silently to whoever
    // set the other. `testTrade` is told the script's number so the backstop
    // there enforces that one instead of the manual cap.
  }
  return null;
}

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

function act(s: UserScript, action: RuleAction, ctx: RuleContext | null): Promise<ActResult> {
  return chain(s, () => actInner(s, action, ctx));
}

async function actInner(s: UserScript, action: RuleAction, ctx: RuleContext | null): Promise<ActResult> {
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
      const gate = await buyGate(s, rt, mint, sol, what);
      if (gate) return gate;
      // The gate awaited: re-read the arm bit before spending. The kill switch
      // says "every script is off" and must not be overtaken by a buy that was
      // already past its checks.
      if (!s.enabled || killSwitch) return { ok: false, message: 'script is disabled' };
      const r = await h.buy(mint, sol, s.mode, scriptChain(s), s.budget.maxSolPerTrade);
      if (r.ok || r.pending) {
        rt.buysToday += 1;
        const prev = rt.opened.get(mint);
        rt.opened.set(mint, { costSol: (prev?.costSol ?? 0) + sol, at: now });
        h.subscribeTicks(mint);
        slog(s, 'info', `${s.mode === 'paper' ? 'PAPER ' : ''}buy ${what} ${sol} SOL: ${r.message}${r.pending ? ' (pending)' : ''}`);
        recorder.record('script_buy', { scriptId: s.id, name: s.name, mode: s.mode, mint, sol, ok: r.ok, signature: r.signature ?? null });
        persist();
        changed();
        return { ok: true, message: r.message };
      }
      slog(s, 'warn', `buy ${what} ${sol} SOL failed: ${r.message}`);
      return { ok: false, message: r.message };
    }
    case 'sell': {
      const pct = Math.round(Number(action.pct));
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return refuse(s, 'sell: percent must be 1–100');
      return sellOne(s, rt, mint, pct, what);
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
      const r = await h.placeOrder({ mint, symbol: ctx?.symbol ?? '', kind, triggerBasis: basis, triggerValue, amount: Number(amount) });
      if (r.ok && isBuy) {
        rt.buysToday += 1;
        rt.opened.set(mint, { costSol: (rt.opened.get(mint)?.costSol ?? 0) + Number(amount), at: now });
      }
      // "armed" / "NOT armed" up front: "take profit +100% sell 50% on X" read as a
      // sale that happened (09-24) when it was only the order being placed.
      slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'armed' : 'NOT armed'} ${describeAction(action)} on ${what}: ${r.message}`);
      recorder.record('script_order', { scriptId: s.id, name: s.name, mint, kind, basis, triggerValue, amount, ok: r.ok });
      if (r.ok) changed();
      return r;
    }
    case 'cancel_orders': {
      const r = h.cancelOrders(mint);
      slog(s, 'info', `cancel orders on ${what}: ${r.message}`);
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

async function sellOne(s: UserScript, rt: Runtime, mint: string, pct: number, what: string): Promise<ActResult> {
  const h = host as AutomationHost;
  // Only what this script opened — the same rule as sell_all. `h.positions`
  // is the whole wallet; a script must never be able to exit a position the
  // user opened by hand.
  if (!rt.opened.has(mint)) return refuse(s, `sell ${what}: this script does not hold it`);
  const held = await h.positions(s.mode, scriptChain(s));
  const before = held.find((p) => p.mint === mint);
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
  const ourCost = rt.opened.get(mint)?.costSol ?? 0;
  let pctOfWallet = pct;
  // An UNKNOWN wallet basis means the script cannot work out its own share, so
  // it sells the percentage it asked for rather than guessing a ratio — the
  // same branch an unreconciled Solana position already took.
  const walletCost = before ? before.costSol : null;
  if (walletCost !== null && Number.isFinite(walletCost) && walletCost > 0 && ourCost > 0) {
    const ratio = Math.min(1, ourCost / walletCost);
    pctOfWallet = Math.max(1, Math.min(100, Math.round(pct * ratio)));
  }
  const r = await h.sell(mint, pctOfWallet, s.mode, scriptChain(s));
  if (r.ok || r.pending) {
    rt.sellsToday += 1;
    // Paper says exactly what it realised. A live fill's own number is not
    // known here, so the position's PnL at the moment of the sell stands
    // in — an estimate, and the loss limit counts it.
    const realized =
      typeof r.realizedSol === 'number' && Number.isFinite(r.realizedSol)
        ? r.realizedSol
        : typeof before?.pnlSol === 'number'
          ? before.pnlSol * (pct / 100)
          : null;
    if (realized !== null) rt.realizedToday += realized;
    if (pct >= 100) rt.opened.delete(mint);
    slog(s, 'info', `${s.mode === 'paper' ? 'PAPER ' : ''}sell ${pct}% ${what}: ${r.message}${realized !== null ? ` (realised ${realized >= 0 ? '+' : ''}${realized.toFixed(4)} SOL${typeof r.realizedSol === 'number' ? '' : ', estimated'})` : ''}`);
    recorder.record('script_sell', { scriptId: s.id, name: s.name, mode: s.mode, mint, pct, ok: r.ok, realizedSol: realized, signature: r.signature ?? null });
    persist();
    changed();
    if (rt.realizedToday <= -s.budget.maxLossSolPerDay) {
      disable(s, `down ${Math.abs(rt.realizedToday).toFixed(3)} SOL today, past the ${s.budget.maxLossSolPerDay} SOL loss limit`);
    }
    return { ok: true, message: r.message };
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

function armAt(s: UserScript, rt: Runtime, hhmm: string): boolean {
  const wait = msUntil(hhmm);
  if (wait === null) return false;
  const prev = rt.atTimers.get(hhmm);
  if (prev) clearTimeout(prev);
  rt.atTimers.set(
    hhmm,
    setTimeout(() => {
      rt.atTimers.delete(hhmm);
      if (!s.enabled) return;
      void fireSchedule(s, hhmm).finally(() => {
        if (s.enabled) armAt(s, rt, hhmm);
      });
    }, wait),
  );
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
  rt.running = false;
  clearSchedules(rt);
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
    disable(s, rt.startFails > 0 ? `could not start after ${rt.startFails + 1} attempts: ${r.message}` : `could not start: ${r.message}`);
    return;
  }
  rt.startFails = 0;
  rt.running = true;
  slog(s, 'info', 'sandbox running');
  changed();
}

async function stopCode(s: UserScript, reason: string): Promise<void> {
  const rt = rtFor(s);
  // A pending start retry is a start: stopping the script must cancel it, or
  // a disarmed script comes back a few seconds later.
  if (rt.startRetry) {
    clearTimeout(rt.startRetry);
    rt.startRetry = null;
  }
  rt.startFails = 0;
  if (rt.intervalTimer) {
    clearInterval(rt.intervalTimer);
    rt.intervalTimer = null;
  }
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

function noteError(s: UserScript, line: string): void {
  const rt = rtFor(s);
  rt.errorsInARow += 1;
  rt.lastError = line;
  rt.lastErrorAt = Date.now();
  slog(s, 'error', line);
  if (rt.errorsInARow >= ERRORS_TO_DISABLE) {
    disable(s, `${ERRORS_TO_DISABLE} errors in a row (last: ${line.slice(0, 120)})`);
    return; // disable() pushes its own snapshot
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
      const r = await host?.sandbox.dispatch(s.id, ev.name, ev.payload);
      rt.lastRunAt = Date.now();
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
  if (!s.enabled) return; // noteError may have disabled it
  // A handler that never returns is killed by the watchdog, comes back, and
  // runs again — so without a ceiling the five-error wall is never reached and
  // the loop is endless. Count restarts, not just errors.
  const now = Date.now();
  const recent = (restartWindow.get(scriptId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  restartWindow.set(scriptId, recent);
  if (recent.length > RESTARTS_PER_MIN) {
    restartWindow.delete(scriptId);
    disable(s, `restarted ${recent.length} times in a minute (last: ${reason}) — stopping it`);
    return;
  }
  // Killed by the watchdog or crashed: come back, unless the errors said stop.
  void startCode(s);
}

const isMint = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
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
  const who = address.slice(0, 8);
  if (scriptChain(s) !== 'solana') return refuse(s, `${side}: naming a wallet is Solana-only`);
  if (rateLimited(s, rt, Date.now())) return refuse(s, `${side} ${label}: over ${s.budget.maxActionsPerMinute} actions in a minute`);

  if (side === 'buy') {
    const gate = await buyGate(s, rt, mint, amount, label);
    if (gate) return gate;
    if (s.mode === 'paper') {
      slog(s, 'info', `PAPER buy ${amount} SOL of ${label} as ${who}… — nothing spent`);
      return { ok: true, message: 'paper: nothing was bought' };
    }
    const r = await h.walletBuy(address, mint, amount, s.budget.maxSolPerTrade);
    if (r.ok) {
      // Counted like any other buy this script made: the budget is about what
      // the SCRIPT spends, not about which key signed it.
      rt.buysToday += 1;
      const prev = rt.opened.get(mint);
      rt.opened.set(mint, { costSol: (prev?.costSol ?? 0) + amount, at: Date.now(), wallet: address });
      persist();
    }
    slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'bought' : 'buy failed'} ${amount} SOL of ${label} as ${who}…: ${r.message}`);
    return { ok: r.ok, message: r.message };
  }

  // A script may only sell a mint it opened — the same rule as bot.sell. It is
  // what separates the script's own bags from bags bought by hand.
  if (!rt.opened.has(mint)) return refuse(s, `sell ${label}: this script does not hold it`);
  if (s.mode === 'paper') {
    slog(s, 'info', `PAPER sell ${Math.round(amount)}% of ${label} as ${who}… — nothing sold`);
    return { ok: true, message: 'paper: nothing was sold' };
  }
  const r = await h.walletSell(address, mint, amount);
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
  const result = (r: ActResult): void => answer(true, { ok: r.ok, message: r.message, ...(r.count !== undefined ? { count: r.count, sold: r.count, cancelled: r.count } : {}) });
  // A disabled script answers nothing. Its sandbox may still be draining a
  // handler that started before the switch moved, and every read below costs
  // something — `positions` walks the book, `market` hits a live provider.
  if (!s.enabled || killSwitch) return answer(false, undefined, 'script is disabled');
  try {
    switch (method) {
      case 'buy': {
        const [mint, sol, who] = args;
        if (!isMint(mint)) return answer(false, undefined, 'buy: bad mint');
        const addr = typeof who === 'string' ? who.trim() : '';
        if (!addr) return result(await act(s, { type: 'buy', sol: Number(sol) }, await ctxFor(s, mint)));
        return result(await chain(s, () => walletTrade(s, 'buy', addr, mint, Number(sol))));
      }
      case 'sell': {
        const [mint, pct, who] = args;
        if (!isMint(mint)) return answer(false, undefined, 'sell: bad mint');
        const addr = typeof who === 'string' ? who.trim() : '';
        if (!addr) return result(await act(s, { type: 'sell', pct: Number(pct) }, await ctxFor(s, mint)));
        return result(await chain(s, () => walletTrade(s, 'sell', addr, mint, Number(pct))));
      }
      case 'wallets':
        return answer(true, h.wallets());
      case 'sellAll':
        return result(await act(s, { type: 'sell_all' }, null));
      case 'order': {
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
        const value = Number(req.triggerValue);
        const amount = Number(req.amount);
        let action: RuleAction | null = null;
        if (kind === 'stop_loss') action = { type: 'stop_loss', pct: value };
        else if (kind === 'trailing_stop') action = { type: 'trailing_stop', pct: value };
        else if (kind === 'take_profit') action = { type: 'take_profit', gainPct: value, sellPct: amount };
        else if (kind === 'limit_buy') action = { type: 'limit_buy', basis: basis as 'price_sol' | 'mcap_usd', value, sol: amount };
        else if (kind === 'limit_sell') action = { type: 'limit_sell', basis: basis as 'price_sol' | 'mcap_usd', value, pct: amount };
        if (action) return result(await act(s, action, await ctxFor(s, req.mint)));
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
          const r = await h.placeOrder({ mint: orderMint, symbol: ctx.symbol, kind, triggerBasis: basis, triggerValue: Number.isFinite(value) ? value : null, amount });
          // An armed buy_on_migration is a buy this script has committed to:
          // reserve it now, or the budget counts it only once it fires.
          if (r.ok && kind === 'buy_on_migration') {
          rt.buysToday += 1;
          const prev = rt.opened.get(orderMint);
          rt.opened.set(orderMint, { costSol: (prev?.costSol ?? 0) + amount, at: Date.now() });
          persist();
          }
          slog(s, r.ok ? 'info' : 'warn', `${r.ok ? 'armed' : 'NOT armed'} order ${kind} on ${ctx.symbol || orderMint.slice(0, 8)}: ${r.message}`);
          return result(r);
        });
      }
      case 'cancelOrders': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'cancelOrders: bad mint');
        return result(await act(s, { type: 'cancel_orders' }, await ctxFor(s, mint)));
      }
      case 'clearCompletedOrders':
        // Housekeeping, not an action — no budget cost, safe to call every tick.
        return answer(true, h.clearCompletedOrders());
      case 'templates':
        return answer(true, h.templates());
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
        persist();
        return result({ ok: true, message: 'subscribed' });
      }
      case 'unsubscribe': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'unsubscribe: bad mint');
        rtFor(s).subscribed.delete(mint);
        persist();
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
        return answer(true, h.pumpAccounts());
      case 'price': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'price: bad mint');
        return answer(true, h.priceSol(mint));
      }
      case 'token': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'token: bad mint');
        if (!h.launch(mint) && !h.marketCached(mint, scriptChain(s))) return answer(true, null);
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
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `security: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.security(mint, scriptChain(s)));
      }
      case 'creator': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'creator: bad mint');
        if (rateLimited(s, rtFor(s), Date.now())) return answer(false, undefined, `creator: over ${s.budget.maxActionsPerMinute} actions in a minute`);
        return answer(true, await h.creator(mint, scriptChain(s)));
      }
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
        for (const p of (await h.positions(s.mode, scriptChain(s))).filter((x) => rtp.opened.has(x.mint))) {
          const row = h.launch(p.mint);
          let c = row ? contextFromLaunch(row, now) : emptyContext(p.mint, p.symbol, p.name);
          c = withMarket(c, h.marketCached(p.mint, scriptChain(s)));
          c = withLaunchLinks(c, scriptChain(s) === 'solana' ? (h.launchLinks?.(p.mint) ?? null) : null);
          c = withPosition(c, withPeak(s.mode, p), now);
          out.push(withGlobals(c, { walletSol: h.wallet().sol, now }));
        }
        return answer(true, out);
      }
      case 'orders': {
        const [mint] = args;
        if (mint !== undefined && !isMint(mint)) return answer(false, undefined, 'orders: bad mint');
        return answer(true, h.orders(mint));
      }
      case 'runners': {
        const now = Date.now();
        return answer(true, h.runners().map((f) => contextFromRunner(f, h.launch(f.mint), now)));
      }
      case 'leaders':
        return answer(true, h.leaders());
      case 'wallet':
        return answer(true, h.wallet());
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
        persist();
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
        rt.intervalSec = sec;
        if (rt.intervalTimer) clearInterval(rt.intervalTimer);
        rt.intervalTimer = setInterval(() => enqueue(s, 'interval', { at: Date.now() }), sec * 1000);
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
    if (s.kind === 'code') {
      const rt = rtFor(s);
      if (!rt.running) continue;
      if (throttle && mint) {
        const m = throttle.map(rt);
        const last = m.get(mint) ?? 0;
        if (now - last < throttle.ms) continue;
        m.set(mint, now);
        if (m.size > 2_000) m.delete(m.keys().next().value as string);
      }
    }
    void build(s).then((ctx) => {
      if (s.kind === 'rules') return runRules(s, ctx);
      enqueue(s, eventName, ctx);
      return undefined;
    });
  }
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
      fanOut('runner', 'runner', f.mint, 'solana', (s) => ctxFor(s, f.mint, contextFromRunner(f, h.launch(f.mint), Date.now())));
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
        void ctxFor(s, mint).then((c) => {
          if (price > 0) c.priceSol = price;
          if (s.kind === 'rules') return runRules(s, c);
          enqueue(s, 'tick', c);
          return undefined;
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
      c = withPosition(c, withPeak(s.mode, p), now);
      c = withGlobals(c, { walletSol: h.wallet().sol, now });
      if (s.kind === 'rules') await runRules(s, c);
      else enqueue(s, 'position', c);
    }
  }
}

export function startTimers(): void {
  if (positionTimer) return;
  positionTimer = setInterval(() => void pollPositions(), POSITION_POLL_MS);
}

export function stopTimers(): void {
  if (positionTimer) clearInterval(positionTimer);
  positionTimer = null;
  for (const rt of runtimes.values()) {
    if (rt.intervalTimer) clearInterval(rt.intervalTimer);
    rt.intervalTimer = null;
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
  stopTimers();
  scripts = [];
  runtimes.clear();
  orderStates.clear();
  alertFires.clear();
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

export function _runtimeOf(id: string): { opened: string[]; firedMints: string[]; realizedToday: number; buysToday: number; kv: Record<string, unknown>; subscribed: string[]; atTimers: string[] } | null {
  const rt = runtimes.get(id);
  if (!rt) return null;
  return { opened: [...rt.opened.keys()], firedMints: [...rt.firedMints], realizedToday: rt.realizedToday, buysToday: rt.buysToday, kv: rt.kv, subscribed: [...rt.subscribed], atTimers: [...rt.atTimers.keys()] };
}

/** Test seam: fire a schedule now. */
export async function _fireSchedule(id: string, hhmm: string): Promise<void> {
  const s = scripts.find((x) => x.id === id);
  if (s) await fireSchedule(s, hhmm);
}
