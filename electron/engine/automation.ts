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

import fs from 'node:fs';
import path from 'node:path';
import {
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
  withMarket,
  withOrder,
  withPosition,
  ALERT_KINDS,
  MAX_SCRIPTS,
  MAX_STATE_BYTES,
  RULE_ACTIONS,
  type LeaderFacts,
  type MarketFacts,
  type RuleAction,
  type RuleContext,
  type ScriptLogLine,
  type ScriptMode,
  type ScriptPosition,
  type ScriptSnapshot,
  type ScriptStats,
  type UserScript,
} from '@shared/automation';
import { MIN_INTERVAL_S, type SandboxToMain } from '@shared/scriptProtocol';
import type { EngineEvent, LaunchRow } from '@shared/types';
import type { RunnerFlag } from '@shared/runners';
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
}

export interface AutomationHost {
  /** A buy in the script's mode: paper = simulated fill into the paper book;
   *  live = the real pipeline. */
  buy(mint: string, sol: number, mode: ScriptMode): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean }>;
  /** A sell of `pct`% of what is held, in the script's mode. `realizedSol`
   *  when the fill can say (paper: exact). */
  sell(mint: string, pct: number, mode: ScriptMode): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean; realizedSol?: number | null }>;
  /** Why NO live action can execute right now, or null. Paper ignores it. */
  liveBlockedReason(): string | null;
  /** Why a live BUY specifically cannot (entry breakers). Never blocks a sell. */
  buyBlockedReason(): string | null;
  /** Per-trade SOL cap from execution settings; a live buy may not exceed it. */
  maxLiveSol(): number;
  priceSol(mint: string): number | null;
  /** The launch feed's row for a mint, if it has one. */
  launch(mint: string): LaunchRow | null;
  /** Provider facts already cached — free. */
  marketCached(mint: string): MarketFacts | null;
  /** Provider facts, fetched — a round trip. */
  market(mint: string): Promise<MarketFacts | null>;
  /** Open positions in a mode. */
  positions(mode: ScriptMode): Promise<ScriptPosition[]>;
  wallet(): { sol: number | null; address: string | null };
  orders(mint?: string): OrderView[];
  placeOrder(req: NewOrderRequest): Promise<{ ok: boolean; message: string }>;
  cancelOrders(mint: string): { ok: boolean; message: string; cancelled: number };
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
  log(level: 'info' | 'warn' | 'error', line: string): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void;
  changed(): void;
  sandbox: {
    start(scriptId: string, code: string): Promise<{ ok: boolean; message: string }>;
    dispatch(scriptId: string, name: string, payload: unknown): Promise<{ ok: boolean; error?: string }>;
    reply(scriptId: string, id: number, ok: boolean, value?: unknown, error?: string): void;
    stop(scriptId: string, reason?: string): Promise<void>;
    isRunning(scriptId: string): boolean;
  };
}

interface Runtime {
  dayKey: string;
  buysToday: number;
  sellsToday: number;
  realizedToday: number;
  errorsInARow: number;
  lastRunAt: number | null;
  lastError: string | null;
  firedMints: Set<string>;
  lastFireAt: Map<string, number>;
  /** Timestamps of actions in the last minute. */
  actions: number[];
  /** Positions this script opened (or placed a limit buy for): mint → cost. */
  opened: Map<string, { costSol: number; at: number }>;
  /** Mints the script asked to stream ticks for. */
  subscribed: Set<string>;
  kv: Record<string, unknown>;
  lastUpdateAt: Map<string, number>;
  lastTickAt: Map<string, number>;
  intervalSec: number | null;
  intervalTimer: NodeJS.Timeout | null;
  /** Daily schedules: "HH:MM" → timer to the next occurrence. */
  atTimers: Map<string, NodeJS.Timeout>;
  log: ScriptLogLine[];
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
  opened: Record<string, { costSol: number; at: number }>;
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

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
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
  } catch {
    scripts = [];
  }
}

function persist(): void {
  if (!filePath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}

function persistNow(): void {
  if (!filePath) return;
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

const dayKeyNow = (): string => new Date().toISOString().slice(0, 10);

function freshRuntime(): Runtime {
  return {
    dayKey: dayKeyNow(),
    buysToday: 0,
    sellsToday: 0,
    realizedToday: 0,
    errorsInARow: 0,
    lastRunAt: null,
    lastError: null,
    firedMints: new Set(),
    lastFireAt: new Map(),
    actions: [],
    opened: new Map(),
    subscribed: new Set(),
    kv: {},
    lastUpdateAt: new Map(),
    lastTickAt: new Map(),
    intervalSec: null,
    intervalTimer: null,
    atTimers: new Map(),
    log: [],
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

function slog(s: UserScript, level: ScriptLogLine['level'], line: string): void {
  pushLog(rtFor(s), level, line);
  host?.log(level === 'error' ? 'warn' : 'info', `script "${s.name}": ${line}`);
}

// ── CRUD ──────────────────────────────────────────────────────────────

export function all(): UserScript[] {
  return scripts.map((s) => ({ ...s, rules: { ...s.rules, conditions: [...s.rules.conditions], actions: [...s.rules.actions] }, budget: { ...s.budget } }));
}

export function upsert(input: Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): { ok: boolean; message: string; id?: string } {
  const v = validateScript(input, { maxLiveSol: host?.maxLiveSol() });
  if (!v.ok) return { ok: false, message: v.message };
  const now = Date.now();
  if (input.id) {
    const existing = scripts.find((s) => s.id === input.id);
    if (!existing) return { ok: false, message: 'Script not found' };
    const wasLiveArmed = existing.mode === 'live' && existing.enabled;
    const codeChanged = existing.code !== input.code || existing.kind !== input.kind;
    const toLive = existing.mode !== 'live' && input.mode === 'live';
    Object.assign(existing, input, { id: existing.id, createdAt: existing.createdAt, updatedAt: now });
    // Switching to live disarms: arming live is a separate, confirmed act.
    if (toLive) existing.enabled = false;
    persist();
    if (existing.enabled && existing.kind === 'code' && codeChanged) void startCode(existing);
    if (!existing.enabled) void stopCode(existing, 'edited');
    if (existing.enabled && existing.kind === 'rules') armSchedules(existing);
    if (!wasLiveArmed && existing.mode === 'live' && existing.enabled) {
      host?.toast('warn', `LIVE script armed: "${existing.name}" — real SOL will be spent within its budget`);
    }
    host?.changed();
    return { ok: true, message: toLive ? 'Saved — switched to live, re-enable to arm it' : 'Saved', id: existing.id };
  }
  if (scripts.length >= MAX_SCRIPTS) return { ok: false, message: `Limit of ${MAX_SCRIPTS} scripts reached` };
  const s: UserScript = { ...input, id: nextId(), createdAt: now, updatedAt: now, enabled: false };
  scripts.unshift(s);
  runtimes.set(s.id, freshRuntime());
  persist();
  host?.changed();
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
  host?.changed();
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
  host?.changed();
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
  host?.changed();
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
  host?.changed();
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
    openCount: rt.opened.size,
    firedMints: rt.firedMints.size,
    running: s.kind === 'code' ? rt.running && (host?.sandbox.isRunning(s.id) ?? false) : s.enabled,
  };
}

export function snapshot(): ScriptSnapshot {
  const stats: Record<string, ScriptStats> = {};
  const logs: Record<string, ScriptLogLine[]> = {};
  for (const s of scripts) {
    stats[s.id] = statsFor(s);
    logs[s.id] = rtFor(s).log.slice(-SNAPSHOT_LOG_LINES);
  }
  return {
    scripts: all(),
    stats,
    logs,
    liveBlockedReason: host?.liveBlockedReason() ?? null,
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
  let c = base ?? (h?.launch(mint) ? contextFromLaunch(h.launch(mint) as LaunchRow, now) : emptyContext(mint));
  if (h) {
    c = withMarket(c, h.marketCached(mint));
    const pos = (await h.positions(s.mode)).find((p) => p.mint === mint) ?? null;
    c = withPosition(c, pos ? withPeak(s.mode, pos) : null, now);
    c = withGlobals(c, { walletSol: h.wallet().sol, now });
  }
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

/** Drop positions the script opened that are no longer held (sold by hand,
 *  stopped out by an order) so the open-position cap reflects reality. */
async function reconcileOpened(s: UserScript, rt: Runtime): Promise<void> {
  const h = host;
  if (!h) return;
  const held = new Set((await h.positions(s.mode)).map((p) => p.mint));
  for (const mint of [...rt.opened.keys()]) if (!held.has(mint) && !host?.orders(mint).some((o) => o.kind === 'limit_buy' && (o.state === 'armed' || o.state === 'paused'))) rt.opened.delete(mint);
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
    const blocked = h.liveBlockedReason() ?? h.buyBlockedReason();
    if (blocked) return refuse(s, `buy ${what}: not executed — ${blocked}`);
    if (sol > h.maxLiveSol()) return refuse(s, `buy ${what}: ${sol} SOL is over the execution cap (${h.maxLiveSol()} SOL per trade)`);
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

async function act(s: UserScript, action: RuleAction, ctx: RuleContext | null): Promise<ActResult> {
  const h = host;
  if (!h) return { ok: false, message: 'no host' };
  const rt = rtFor(s);
  const now = Date.now();
  const mint = ctx?.mint ?? '';
  const what = ctx?.symbol || mint.slice(0, 8);
  const spec = RULE_ACTIONS.find((x) => x.id === action.type);
  if (!s.enabled) return { ok: false, message: 'script is disabled' };
  if (!spec) return refuse(s, 'unknown action');
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
      const r = await h.buy(mint, sol, s.mode);
      if (r.ok || r.pending) {
        rt.buysToday += 1;
        const prev = rt.opened.get(mint);
        rt.opened.set(mint, { costSol: (prev?.costSol ?? 0) + sol, at: now });
        h.subscribeTicks(mint);
        slog(s, 'info', `${s.mode === 'paper' ? 'PAPER ' : ''}buy ${what} ${sol} SOL: ${r.message}${r.pending ? ' (pending)' : ''}`);
        recorder.record('script_buy', { scriptId: s.id, name: s.name, mode: s.mode, mint, sol, ok: r.ok, signature: r.signature ?? null });
        persist();
        h.changed();
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
      const held = await h.positions(s.mode);
      if (!held.length) return refuse(s, 'sell everything: nothing held');
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
      } else if (!(await h.positions(s.mode)).some((p) => p.mint === mint)) {
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
      slog(s, r.ok ? 'info' : 'warn', `${describeAction(action)} on ${what}: ${r.message}`);
      recorder.record('script_order', { scriptId: s.id, name: s.name, mint, kind, basis, triggerValue, amount, ok: r.ok });
      if (r.ok) h.changed();
      return r;
    }
    case 'cancel_orders': {
      const r = h.cancelOrders(mint);
      slog(s, 'info', `cancel orders on ${what}: ${r.message}`);
      return { ok: r.ok, message: r.message, count: r.cancelled };
    }
    case 'apply_template': {
      if (!(await h.positions(s.mode)).some((p) => p.mint === mint)) return refuse(s, `apply template ${what}: nothing held in ${s.mode} mode`);
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
  const held = await h.positions(s.mode);
  const before = held.find((p) => p.mint === mint);
  if (!before) return refuse(s, `sell ${what}: nothing held in ${s.mode} mode`);
  if (s.mode === 'live') {
    const blocked = h.liveBlockedReason();
    if (blocked) return refuse(s, `sell ${what}: not executed — ${blocked}`);
  }
  const r = await h.sell(mint, pct, s.mode);
  if (r.ok || r.pending) {
    rt.sellsToday += 1;
    // Paper says exactly what it realised. A live fill's own number is not
    // known here, so the position's PnL at the moment of the sell stands
    // in — an estimate, and the loss limit counts it.
    const realized =
      typeof r.realizedSol === 'number' && Number.isFinite(r.realizedSol)
        ? r.realizedSol
        : typeof before.pnlSol === 'number'
          ? before.pnlSol * (pct / 100)
          : null;
    if (realized !== null) rt.realizedToday += realized;
    if (pct >= 100) rt.opened.delete(mint);
    slog(s, 'info', `${s.mode === 'paper' ? 'PAPER ' : ''}sell ${pct}% ${what}: ${r.message}${realized !== null ? ` (realised ${realized >= 0 ? '+' : ''}${realized.toFixed(4)} SOL${typeof r.realizedSol === 'number' ? '' : ', estimated'})` : ''}`);
    recorder.record('script_sell', { scriptId: s.id, name: s.name, mode: s.mode, mint, pct, ok: r.ok, realizedSol: realized, signature: r.signature ?? null });
    persist();
    h.changed();
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

async function startCode(s: UserScript): Promise<void> {
  const h = host;
  if (!h) return;
  const rt = rtFor(s);
  rt.running = false;
  clearSchedules(rt);
  const r = await h.sandbox.start(s.id, s.code);
  if (!r.ok) {
    rt.running = false;
    rt.lastError = r.message;
    disable(s, `could not start: ${r.message}`);
    return;
  }
  rt.running = true;
  rt.errorsInARow = 0;
  slog(s, 'info', 'sandbox running');
  host?.changed();
}

async function stopCode(s: UserScript, reason: string): Promise<void> {
  const rt = rtFor(s);
  if (rt.intervalTimer) {
    clearInterval(rt.intervalTimer);
    rt.intervalTimer = null;
  }
  rt.intervalSec = null;
  rt.queue = [];
  if (rt.running || host?.sandbox.isRunning(s.id)) await host?.sandbox.stop(s.id, reason);
  rt.running = false;
}

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
  slog(s, 'error', line);
  if (rt.errorsInARow >= ERRORS_TO_DISABLE) disable(s, `${ERRORS_TO_DISABLE} errors in a row (last: ${line.slice(0, 120)})`);
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
    case 'ready':
      rt.running = true;
      return;
    case 'log':
      pushLog(rt, msg.level, msg.line);
      if (msg.level === 'error') host?.log('warn', `script "${s.name}": ${msg.line}`);
      host?.changed();
      return;
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
export function onSandboxGone(scriptId: string, reason: string): void {
  const s = scripts.find((x) => x.id === scriptId);
  if (!s) return;
  const rt = rtFor(s);
  rt.running = false;
  rt.queue = [];
  if (!s.enabled) return;
  noteError(s, `sandbox gone (${reason})`);
  // Killed by the watchdog or crashed: come back, unless the errors said stop.
  if (s.enabled) void startCode(s);
}

const isMint = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const ORDER_KINDS: OrderKind[] = ['limit_buy', 'limit_sell', 'take_profit', 'stop_loss', 'trailing_stop', 'sell_on_dev_sell', 'sell_on_migration', 'buy_on_migration'];
const BASES: TriggerBasis[] = ['price_sol', 'mcap_usd', 'pct'];

async function handleCall(s: UserScript, id: number, method: string, args: unknown[]): Promise<void> {
  const h = host;
  if (!h) return;
  const answer = (ok: boolean, value?: unknown, error?: string): void => h.sandbox.reply(s.id, id, ok, value, error);
  const result = (r: ActResult): void => answer(true, { ok: r.ok, message: r.message, ...(r.count !== undefined ? { count: r.count, sold: r.count, cancelled: r.count } : {}) });
  try {
    switch (method) {
      case 'buy': {
        const [mint, sol] = args;
        if (!isMint(mint)) return answer(false, undefined, 'buy: bad mint');
        return result(await act(s, { type: 'buy', sol: Number(sol) }, await ctxFor(s, mint)));
      }
      case 'sell': {
        const [mint, pct] = args;
        if (!isMint(mint)) return answer(false, undefined, 'sell: bad mint');
        return result(await act(s, { type: 'sell', pct: Number(pct) }, await ctxFor(s, mint)));
      }
      case 'sellAll':
        return result(await act(s, { type: 'sell_all' }, null));
      case 'order': {
        const req = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>;
        if (!isMint(req.mint)) return answer(false, undefined, 'order: bad mint');
        if (!ORDER_KINDS.includes(req.kind as OrderKind)) return answer(false, undefined, `order: kind must be one of ${ORDER_KINDS.join(', ')}`);
        if (!BASES.includes(req.triggerBasis as TriggerBasis)) return answer(false, undefined, `order: triggerBasis must be one of ${BASES.join(', ')}`);
        const kind = req.kind as OrderKind;
        const basis = req.triggerBasis as TriggerBasis;
        const value = Number(req.triggerValue);
        const amount = Number(req.amount);
        let action: RuleAction | null = null;
        if (kind === 'stop_loss') action = { type: 'stop_loss', pct: value };
        else if (kind === 'trailing_stop') action = { type: 'trailing_stop', pct: value };
        else if (kind === 'take_profit') action = { type: 'take_profit', gainPct: value, sellPct: amount };
        else if (kind === 'limit_buy') action = { type: 'limit_buy', basis: basis === 'pct' ? 'mcap_usd' : basis, value, sol: amount };
        else if (kind === 'limit_sell') action = { type: 'limit_sell', basis: basis === 'pct' ? 'mcap_usd' : basis, value, pct: amount };
        if (action) return result(await act(s, action, await ctxFor(s, req.mint)));
        // The migration / dev-sell kinds have no rule form; place directly, same gates.
        const ctx = await ctxFor(s, req.mint);
        if (s.mode === 'paper') {
          slog(s, 'info', `PAPER order ${kind} on ${ctx.symbol || req.mint.slice(0, 8)} — noted, not placed`);
          return result({ ok: true, message: 'paper: order noted, not placed' });
        }
        if (kind === 'buy_on_migration') {
          const gate = await buyGate(s, rtFor(s), req.mint, amount, ctx.symbol || req.mint.slice(0, 8));
          if (gate) return result(gate);
        }
        const r = await h.placeOrder({ mint: req.mint, symbol: ctx.symbol, kind, triggerBasis: basis, triggerValue: Number.isFinite(value) ? value : null, amount });
        slog(s, r.ok ? 'info' : 'warn', `order ${kind} on ${ctx.symbol || req.mint.slice(0, 8)}: ${r.message}`);
        return result(r);
      }
      case 'cancelOrders': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'cancelOrders: bad mint');
        return result(await act(s, { type: 'cancel_orders' }, await ctxFor(s, mint)));
      }
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
      case 'price': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'price: bad mint');
        return answer(true, h.priceSol(mint));
      }
      case 'token': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'token: bad mint');
        if (!h.launch(mint) && !h.marketCached(mint)) return answer(true, null);
        return answer(true, await ctxFor(s, mint));
      }
      case 'market': {
        const [mint] = args;
        if (!isMint(mint)) return answer(false, undefined, 'market: bad mint');
        return answer(true, await h.market(mint));
      }
      case 'positions': {
        const now = Date.now();
        const out: RuleContext[] = [];
        for (const p of await h.positions(s.mode)) {
          const row = h.launch(p.mint);
          let c = row ? contextFromLaunch(row, now) : emptyContext(p.mint, p.symbol, p.name);
          c = withMarket(c, h.marketCached(p.mint));
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

function fanOut(trigger: string, eventName: string, mint: string, build: (s: UserScript) => Promise<RuleContext>, throttle?: { map: (rt: Runtime) => Map<string, number>; ms: number }): void {
  const now = Date.now();
  for (const s of scripts) {
    if (!s.enabled) continue;
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
      fanOut(trigger, ev.kind, row.mint, (s) => ctxFor(s, row.mint, contextFromLaunch(row, Date.now())), ev.kind === 'launchUpdate' ? { map: (rt) => rt.lastUpdateAt, ms: LAUNCH_UPDATE_THROTTLE_MS } : undefined);
      return;
    }
    case 'runner': {
      const f = ev.runner;
      fanOut('runner', 'runner', f.mint, (s) => ctxFor(s, f.mint, contextFromRunner(f, h.launch(f.mint), Date.now())));
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
        fanOut('order', 'order', o.mint, async (s) => {
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
        fanOut('alert', 'alert', a.mint, async (s) => {
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

/** A followed wallet traded (copy trading's watcher). */
export function onLeaderTrade(t: LeaderTrade): void {
  if (!host || !scripts.some((s) => s.enabled)) return;
  fanOut('leader_trade', 'leaderTrade', t.mint, async (s) => {
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
    const held = await h.positions(s.mode);
    for (const p of held) {
      h.subscribeTicks(p.mint);
      const row = h.launch(p.mint);
      let c = row ? contextFromLaunch(row, now) : emptyContext(p.mint, p.symbol, p.name);
      c = withMarket(c, h.marketCached(p.mint));
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
  killSwitch = false;
  filePath = '';
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
