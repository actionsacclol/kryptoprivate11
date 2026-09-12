// Copy trading — paper by default, live only on deliberate opt-in.
//
// The shape mirrors `advOrders`: a host injects execution and gating, the
// module only notices things and decides. What is different is the default —
// a copy config starts in PAPER mode, and the paper record is kept with the
// same rigour as a real one so the switch to live is made against evidence.
//
// Paper fills here are priced from the tape at the moment we would have
// traded, INCLUDING the configured delay. That matters: copying is a latency
// game, and a paper record that fills at the follower's price rather than at
// the price N milliseconds later is the exact self-flattery that makes
// copy-trading look profitable when it is not.

import fs from 'node:fs';
import { type ChainKind } from '@shared/evm';
import { logger } from '../system/logger';
import path from 'node:path';
import {
  copySize,
  DEFAULT_COPIES_PER_MINUTE,
  emptyLeaderStats,
  validateConfig,
  type CopyConfig,
  type CopyMode,
  type CopySnapshot,
  type CopyStats,
  type CopyTrade,
  type CopyWatchStatus,
  type LeaderRoundTrip,
  type LeaderStats, chainOf } from '@shared/copytrade';
import { FEE_BPS } from '@shared/fees';
import * as recorder from './recorder';

const FILE = 'copytrade.json';
const MAX_TRADES = 2_000;
const MAX_CONFIGS = 25;

let configs: CopyConfig[] = [];
let trades: CopyTrade[] = [];
/** Per followed wallet: THEIR positions and round trips (see below). */
let leaders: Record<string, LeaderBook> = {};
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Set when the store existed but could not be read; persisting stays off. */
let loadFailure: string | null = null;

/** What a host may tell us about an execution it just ran. */
export interface CopyExecResult {
  ok: boolean;
  message: string;
  signature?: string;
  /** Broadcast, not yet confirmed. The position is real (copy-5). */
  pending?: boolean;
  /** SOL actually spent, when the host knows it. Trusted over the request. */
  spentSol?: number;
  /** The fill price in SOL per token, when the host knows it. */
  fillPriceSol?: number;
}

/** Per-execution overrides. A host free to ignore them still type-checks. */
export interface CopyExecOpts {
  /** This config's `maxSlippagePct`, which the host is asked to honour. */
  slippagePct?: number;
  /** The wallet this config signs with; absent = the active wallet. */
  walletId?: string;
  /** The chain the copy goes out on; absent = Solana. */
  chain?: ChainKind;
}

export interface CopyHost {
  /** Fire a real buy. Only called for a `live` config. */
  buy(mint: string, sol: number, opts?: CopyExecOpts): Promise<CopyExecResult>;
  /** Sell `pct`% of what THIS wallet holds of `mint`. Only called for a
   *  `live` config, and only a confirmed fill may answer `ok`. */
  sell(mint: string, pct: number, opts?: CopyExecOpts): Promise<CopyExecResult>;
  /** Why a LIVE copy cannot execute, or null. Paper ignores this. */
  liveBlockedReason(chain?: ChainKind): string | null;
  /**
   * Why a LIVE BUY specifically cannot execute, or null (copy-11).
   *
   * `liveBlockedReason` deliberately omits the entry breakers — an exit must
   * stay possible while entries are paused — so without this a copy would
   * open a position during a decoder hard-pause or on a stale feed. Optional:
   * a host that does not implement it is treated as "nothing extra to say".
   */
  buyBlockedReason?(chain?: ChainKind): string | null;
  /**
   * What THIS wallet paid for everything it holds of `mint`, SOL (copy-2).
   *
   * A sell is placed as a percentage of the whole token account, so mirroring
   * "they sold 40 %" as 40 % sells 40 % of a hand-bought bag too. With this,
   * the percentage is scaled by the copy's share of our own basis. Null or
   * absent means "unknown", and the percentage is used unscaled.
   */
  ourCostBasisSol?(mint: string, chain?: ChainKind): number | null;
  /** The live per-trade ceiling, SOL. A copy over it is REFUSED (copy-8). */
  maxLiveSol?(chain?: ChainKind): number | null;
  /** Current spot price in SOL for a mint, if known. */
  priceSol(mint: string, chain?: ChainKind): number | null;
  /** Token facts used by the filters. */
  tokenFacts(mint: string, chain?: ChainKind): Promise<{ liquidityUsd: number | null; marketCapUsd: number | null; kryptScore: number | null; isPumpfun: boolean }>;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void;
  changed(): void;
  /** The wallet watcher's per-wallet status, for the snapshot. */
  watchStatus?(): Record<string, CopyWatchStatus>;
}

let host: CopyHost | null = null;

export function attach(h: CopyHost): void {
  host = h;
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  configs = [];
  trades = [];
  leaders = {};

  // Fail CLOSED: "I could not read the file" is not "there is no file"
  // (copy-6). A missing file is a first run; anything else means configs,
  // history and the leaders' record may still be on disk, and overwriting
  // them with an empty document destroys them. When the read fails the file
  // becomes read-only for the session and every persist is a no-op — same
  // shape as `ledger.init`.
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      console.warn(`[sniper] copy: ${loadFailure} — copy trading is read-only this session`);
    }
    return;
  }
  try {
    const raw = JSON.parse(text) as {
      version: 1;
      configs: CopyConfig[];
      trades: CopyTrade[];
      leaders?: Record<string, LeaderBook>;
    };
    configs = Array.isArray(raw?.configs) ? raw.configs : [];
    trades = Array.isArray(raw?.trades) ? raw.trades : [];
    leaders = raw?.leaders && typeof raw.leaders === 'object' && !Array.isArray(raw.leaders) ? raw.leaders : {};
  } catch (e) {
    configs = [];
    trades = [];
    leaders = {};
    loadFailure = `${filePath} is corrupt (${(e as Error).message})`;
    console.warn(`[sniper] copy: ${loadFailure} — copy trading is read-only this session`);
  }

  // A LIVE config never survives a restart armed. Same reasoning as orders:
  // an app that was closed for a week must not resume spending on wake.
  // Paper configs do resume, because paper costs nothing and an interrupted
  // experiment is a useless one.
  let disarmed = 0;
  for (const c of configs) {
    if (c.mode === 'live' && c.enabled) {
      c.enabled = false;
      disarmed += 1;
    }
  }
  if (!loadFailure) {
    logger.info(
      `copy: loaded ${configs.length} config(s), ${trades.length} record(s)` +
        (disarmed > 0 ? ` — ${disarmed} LIVE config(s) disarmed on restart` : ''),
    );
  }
}

/** Why the store could not be read, or null. Persisting is off while set. */
export function failure(): string | null {
  return loadFailure;
}

function persist(): void {
  if (!filePath || loadFailure) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, configs, trades: trades.slice(0, MAX_TRADES), leaders }, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {
      /* memory stays authoritative */
    }
  }, 300);
}

let seq = 0;
const nextId = (p: string): string => {
  seq += 1;
  return `${p}_${Date.now().toString(36)}_${seq.toString(36)}`;
};

// ── Config CRUD ───────────────────────────────────────────────────────

export function upsert(input: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }): { ok: boolean; message: string } {
  if (chainOf(input) !== 'solana') input = { ...input, wallet: input.wallet.trim().toLowerCase() };
  const v = validateConfig(input);
  if (!v.ok) return { ok: false, message: v.message };

  if (input.id) {
    const existing = configs.find((c) => c.id === input.id);
    if (!existing) return { ok: false, message: 'Config not found' };
    const wasLive = existing.mode === 'live' && existing.enabled;
    // Moving to live always disarms first — the same rule scripts follow, and
    // the one the Wallets page has always claimed. Enforced HERE, in main, so
    // one `copy:save` call can never create an armed live follower.
    const toLive = existing.mode !== 'live' && input.mode === 'live';
    Object.assign(existing, input);
    if (toLive) existing.enabled = false;
    persist();
    host?.changed();
    if (!wasLive && existing.mode === 'live' && existing.enabled) {
      host?.toast('warn', `LIVE copy trading armed for ${existing.label || existing.wallet.slice(0, 6)} — real SOL will be spent`);
    }
    return { ok: true, message: toLive ? 'Saved as live — re-enable it to arm it' : 'Saved' };
  }

  if (configs.length >= MAX_CONFIGS) return { ok: false, message: `Limit of ${MAX_CONFIGS} configs reached` };
  // The same address on another chain is another leader (2026-09-11).
  if (configs.some((c) => c.wallet === input.wallet && chainOf(c) === chainOf(input))) {
    return { ok: false, message: 'You are already following that wallet on that chain' };
  }
  const c: CopyConfig = { ...input, id: nextId('cp'), createdAt: Date.now() };
  // A brand-new live follower is never born armed.
  const bornLive = c.mode === 'live' && c.enabled;
  if (bornLive) c.enabled = false;
  configs.unshift(c);
  persist();
  host?.changed();
  return {
    ok: true,
    message: bornLive
      ? `Following ${c.label || c.wallet.slice(0, 6)} — live, disarmed. Enable it when ready.`
      : `Following ${c.label || c.wallet.slice(0, 6)}`,
  };
}

export function remove(id: string): { ok: boolean; message: string } {
  const before = configs.length;
  const gone = configs.find((c) => c.id === id);
  configs = configs.filter((c) => c.id !== id);
  if (configs.length === before) return { ok: false, message: 'Config not found' };
  trades = trades.filter((t) => t.configId !== id);
  // Runtime state dies with the config (copy-9): an exit chain keyed to it
  // would otherwise pin the map forever, and a reservation it never released
  // would count against a config that no longer exists.
  for (const key of [...exitChains.keys()]) {
    if (key.startsWith(`${id}:`)) exitChains.delete(key);
  }
  pendingCopies.delete(id);
  recentCopies.delete(id);
  for (const key of [...supersededSkips.keys()]) {
    if (key.startsWith(`${id}:`)) supersededSkips.delete(key);
  }
  // Their record goes with the last config that followed them.
  if (gone && !configs.some((c) => c.wallet === gone.wallet)) delete leaders[gone.wallet];
  persist();
  host?.changed();
  return { ok: true, message: 'Stopped following' };
}

export function all(): CopyConfig[] {
  return configs.map((c) => ({ ...c }));
}

/** Wallets with an enabled config — the engine's watch list. */
export function activeWallets(chain?: ChainKind): Set<string> {
  return new Set(configs.filter((c) => c.enabled && (chain === undefined || chainOf(c) === chain)).map((c) => c.wallet));
}

// ── Stats ─────────────────────────────────────────────────────────────

function statsFor(c: CopyConfig): CopyStats {
  const mine = trades.filter((t) => t.configId === c.id);
  // A copy is a buy; its exits are slices of it. Realised PnL lives on the
  // slices (and on copies closed whole before slices existed) — a copy
  // closed through its slices carries none itself, so nothing counts twice.
  const copies = mine.filter((t) => t.kind !== 'exit');
  const closed = mine.filter((t) => t.state === 'closed' && t.pnlSol !== null);
  const open = copies.filter((t) => t.state === 'open');
  return {
    configId: c.id,
    mode: c.mode,
    trades: copies.filter((t) => t.state !== 'skipped').length,
    wins: closed.filter((t) => (t.pnlSol as number) > 0).length,
    losses: closed.filter((t) => (t.pnlSol as number) < 0).length,
    realizedPnlSol: closed.reduce((a, t) => a + (t.pnlSol as number), 0),
    openCount: open.length,
    openCostSol: open.reduce((a, t) => a + t.ourSol * ((t.remainingPct ?? 100) / 100), 0),
    skipped: copies.filter((t) => t.state === 'skipped' && t.reason !== null && !t.reason.startsWith('limit')).length,
    blocked: copies.filter((t) => t.state === 'skipped' && t.reason?.startsWith('limit')).length,
    firstAt: mine.length ? Math.min(...mine.map((t) => t.at)) : null,
    lastAt: mine.length ? Math.max(...mine.map((t) => t.at)) : null,
  };
}

export function snapshot(): CopySnapshot {
  const stats: Record<string, CopyStats> = {};
  for (const c of configs) stats[c.id] = statsFor(c);
  const leaderStats: Record<string, LeaderStats> = {};
  for (const w of new Set(configs.map((c) => c.wallet))) leaderStats[w] = leaderStatsFor(w);
  const blocked = host?.liveBlockedReason() ?? null;
  return {
    configs: all(),
    stats,
    recent: trades.slice(0, 100).map((t) => ({ ...t })),
    liveExecutable: blocked === null,
    liveBlockedReason: blocked,
    watch: host?.watchStatus?.() ?? {},
    leaders: leaderStats,
    loadFailure,
  };
}

// ── The leader's own record ───────────────────────────────────────────
//
// What the LEADER did, scored from every swap seen on their wallet since a
// config first followed it — whether or not a copy happened (2026-09-08).
// The copy scorecard answers "what did following them cost or make ME,
// through my filters and delay"; this answers "are they any good", which is
// what a user testing five wallets on paper is asking. Average cost per
// (wallet, mint): a position opens on the first buy seen and closes when a
// sell leaves nothing (their own fraction says so, or the tracked tokens are
// spent). A sell of tokens bought BEFORE we watched has no known cost and is
// counted, never scored.

interface LeaderPos {
  mint: string;
  symbol: string;
  /** Tracked tokens still held. */
  tokens: number;
  /** Cost of the tracked tokens still held. */
  costSol: number;
  /** Everything spent on this position. */
  costTotal: number;
  proceedsSol: number;
  realizedSol: number;
  openedAt: number;
  lastAt: number;
  buys: number;
  sells: number;
  /** Last price seen for the mint (their fill or a tape tick). */
  markPriceSol: number | null;
}

interface LeaderBook {
  positions: Record<string, LeaderPos>;
  /** Newest first. */
  trips: LeaderRoundTrip[];
  buys: number;
  sells: number;
  unscoredSells: number;
  firstAt: number | null;
  lastAt: number | null;
}

const MAX_TRIPS_PER_LEADER = 300;
const MAX_OPEN_PER_LEADER = 200;

function bookFor(wallet: string): LeaderBook {
  let b = leaders[wallet];
  if (!b) {
    b = { positions: {}, trips: [], buys: 0, sells: 0, unscoredSells: 0, firstAt: null, lastAt: null };
    leaders[wallet] = b;
  }
  return b;
}

function trackLeader(t: WalletTrade): void {
  const b = bookFor(t.wallet);
  b.firstAt = b.firstAt === null ? t.at : Math.min(b.firstAt, t.at);
  b.lastAt = b.lastAt === null ? t.at : Math.max(b.lastAt, t.at);
  // Token count from the transaction when the watcher gave it; else from
  // the fill price (the simulator and tests).
  const tokens = t.tokens !== undefined && t.tokens > 0 ? t.tokens : t.priceSol > 0 ? t.sol / t.priceSol : 0;

  if (t.isBuy) {
    b.buys += 1;
    if (!(tokens > 0) || !(t.sol > 0)) return;
    let p = b.positions[t.mint];
    if (!p) {
      p = {
        mint: t.mint,
        symbol: t.symbol,
        tokens: 0,
        costSol: 0,
        costTotal: 0,
        proceedsSol: 0,
        realizedSol: 0,
        openedAt: t.at,
        lastAt: t.at,
        buys: 0,
        sells: 0,
        markPriceSol: null,
      };
      b.positions[t.mint] = p;
      const open = Object.values(b.positions);
      if (open.length > MAX_OPEN_PER_LEADER) {
        const oldest = open.reduce((a, x) => (x.lastAt < a.lastAt ? x : a));
        delete b.positions[oldest.mint];
      }
    }
    p.tokens += tokens;
    p.costSol += t.sol;
    p.costTotal += t.sol;
    p.buys += 1;
    p.lastAt = t.at;
    if (t.priceSol > 0) p.markPriceSol = t.priceSol;
    if (t.symbol && !p.symbol) p.symbol = t.symbol;
    return;
  }

  b.sells += 1;
  const p = b.positions[t.mint];
  if (!p || !(p.tokens > 0) || !(tokens > 0)) {
    b.unscoredSells += 1;
    return;
  }
  const sold = Math.min(tokens, p.tokens);
  // The part of this sell whose cost is known; the rest was bought before
  // we watched and is counted, not scored.
  const share = sold / tokens;
  if (share < 0.999) b.unscoredSells += 1;
  const cost = p.costSol * (sold / p.tokens);
  const proceeds = t.sol * share;
  p.tokens -= sold;
  p.costSol -= cost;
  p.proceedsSol += proceeds;
  p.realizedSol += proceeds - cost;
  p.sells += 1;
  p.lastAt = t.at;
  if (t.priceSol > 0) p.markPriceSol = t.priceSol;
  const f = t.soldFraction;
  const flat = (f !== null && f !== undefined && f >= 0.995) || p.tokens <= 1e-9 || p.costSol <= 1e-9;
  if (!flat) return;
  b.trips.unshift({
    mint: p.mint,
    symbol: p.symbol,
    costSol: p.costTotal,
    proceedsSol: p.proceedsSol,
    pnlSol: p.realizedSol,
    openedAt: p.openedAt,
    closedAt: t.at,
    buys: p.buys,
    sells: p.sells,
  });
  if (b.trips.length > MAX_TRIPS_PER_LEADER) b.trips.length = MAX_TRIPS_PER_LEADER;
  delete b.positions[t.mint];
}

function leaderStatsFor(wallet: string): LeaderStats {
  const b = leaders[wallet];
  if (!b) return emptyLeaderStats(wallet);
  const open = Object.values(b.positions);
  const trips = b.trips;
  const tripCost = trips.reduce((a, x) => a + x.costSol, 0);
  const tripPnl = trips.reduce((a, x) => a + x.pnlSol, 0);
  let unrealized: number | null = null;
  for (const p of open) {
    const px = p.markPriceSol ?? host?.priceSol(p.mint) ?? null;
    if (px === null || !(px > 0)) continue;
    unrealized = (unrealized ?? 0) + (p.tokens * px - p.costSol);
  }
  const holds = trips.map((x) => x.closedAt - x.openedAt).filter((ms) => ms >= 0);
  const days = b.firstAt === null ? null : Math.max(1, (Date.now() - b.firstAt) / 86_400_000);
  return {
    wallet,
    watchedSince: b.firstAt,
    lastTradeAt: b.lastAt,
    buys: b.buys,
    sells: b.sells,
    roundTrips: trips.length,
    wins: trips.filter((x) => x.pnlSol > 0).length,
    losses: trips.filter((x) => x.pnlSol < 0).length,
    realizedPnlSol: tripPnl + open.reduce((a, p) => a + p.realizedSol, 0),
    volumeSol: tripCost + open.reduce((a, p) => a + p.costTotal, 0),
    openCount: open.length,
    openCostSol: open.reduce((a, p) => a + p.costSol, 0),
    unrealizedPnlSol: unrealized,
    avgHoldMs: holds.length ? holds.reduce((a, x) => a + x, 0) / holds.length : null,
    bestSol: trips.length ? Math.max(...trips.map((x) => x.pnlSol)) : null,
    worstSol: trips.length ? Math.min(...trips.map((x) => x.pnlSol)) : null,
    unscoredSells: b.unscoredSells,
    tradesPerDay: days === null ? null : (b.buys + b.sells) / days,
    returnPct: tripCost > 0 ? (tripPnl / tripCost) * 100 : null,
    recentTrips: trips.slice(0, 8).map((x) => ({ ...x })),
  };
}

/** Start a wallet's record over (the configs and copies stay). */
export function resetLeader(wallet: string): { ok: boolean; message: string } {
  if (!configs.some((c) => c.wallet === wallet)) return { ok: false, message: 'Not following that wallet' };
  delete leaders[wallet];
  persist();
  host?.changed();
  return { ok: true, message: 'Record cleared' };
}

// ── Daily limits ──────────────────────────────────────────────────────

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayFor(configId: string): CopyTrade[] {
  const from = startOfDay();
  return trades.filter((t) => t.configId === configId && t.at >= from && t.state !== 'skipped');
}

/**
 * Copies reserved but not yet recorded, per config (copy-1).
 *
 * A copy is only written to `trades` once the buy resolves, so a leader who
 * fires eight swaps into one slot used to pass the daily check eight times
 * before the first buy came back. A slot is now taken SYNCHRONOUSLY the
 * moment the limits pass and given back in a `finally`.
 */
const pendingCopies = new Map<string, number>();
/** When each slot was taken, per config — the rolling-minute wall. */
const recentCopies = new Map<string, number[]>();
const MINUTE = 60_000;

function perMinuteCap(c: CopyConfig): number {
  const v = c.maxCopiesPerMinute;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_COPIES_PER_MINUTE;
}

/** Timestamps inside the last minute, pruned in place. */
function recentFor(configId: string, now: number): number[] {
  const kept = (recentCopies.get(configId) ?? []).filter((at) => now - at < MINUTE);
  if (kept.length) recentCopies.set(configId, kept);
  else recentCopies.delete(configId);
  return kept;
}

/** Take a copy slot. Synchronous, and paired with exactly one `release`. */
function reserve(c: CopyConfig, now: number): void {
  pendingCopies.set(c.id, (pendingCopies.get(c.id) ?? 0) + 1);
  recentCopies.set(c.id, [...recentFor(c.id, now), now]);
}

function release(configId: string): void {
  const n = (pendingCopies.get(configId) ?? 0) - 1;
  if (n > 0) pendingCopies.set(configId, n);
  else pendingCopies.delete(configId);
}

function limitHit(c: CopyConfig): string | null {
  const today = todayFor(c.id);
  const now = Date.now();
  // Exits are not copies: a leader who scales out in four sells has not
  // used four of the day's copies. Their realised losses DO count below.
  // Copies still in flight count: they are already spending.
  const used = today.filter((t) => t.kind !== 'exit').length + (pendingCopies.get(c.id) ?? 0);
  if (used >= c.dailyTradeLimit) return `limit: ${c.dailyTradeLimit} copies today`;
  const cap = perMinuteCap(c);
  if (recentFor(c.id, now).length >= cap) return `limit: ${cap} copies per minute`;
  const realized = today
    .filter((t) => t.state === 'closed' && t.pnlSol !== null)
    .reduce((a, t) => a + (t.pnlSol as number), 0);
  if (realized <= -c.dailyLossLimitSol) return `limit: down ${Math.abs(realized).toFixed(3)} SOL today`;
  return null;
}

// ── The copy path ─────────────────────────────────────────────────────

function record(t: CopyTrade): void {
  trades.unshift(t);
  if (trades.length > MAX_TRADES) trades.length = MAX_TRADES;
  persist();
  host?.changed();
}

export interface WalletTrade {
  /** Absent = Solana. An EVM trade's wallet and mint are lower-cased on entry. */
  chain?: ChainKind;
  wallet: string;
  mint: string;
  symbol: string;
  isBuy: boolean;
  sol: number;
  priceSol: number;
  at: number;
  /** The transaction, when known. A leader's pump.fun trade arrives twice —
   *  from the curve firehose and from the wallet watcher — and must be
   *  evaluated once. */
  signature?: string;
  /** Sell: the share of their holding they sold, 0–1 (walletSwap). Null or
   *  absent = unknown, and an unknown share is NOT mirrored at all — the
   *  exit is recorded as skipped with that reason. */
  soldFraction?: number | null;
  /** Tokens moved, UI units (walletSwap). Absent = derived from the price. */
  tokens?: number;
}

/** Signatures already evaluated, newest last; bounded. */
const handled = new Set<string>();
const HANDLED_CAP = 1_000;

function alreadyHandled(signature: string | undefined): boolean {
  if (!signature) return false;
  if (handled.has(signature)) return true;
  handled.add(signature);
  if (handled.size > HANDLED_CAP) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
  return false;
}

/**
 * Sell signatures already routed, with the fraction each delivery carried
 * (copy-13).
 *
 * A pump.fun leader's sell arrives TWICE: from the curve firehose, which
 * reads a log and therefore has no pre-balance and no `soldFraction`, and
 * from the wallet watcher, which has both but must fetch the transaction
 * first and so always loses the race. Deduping on the signature alone threw
 * away the only delivery that could be mirrored, which left the whole pump
 * rail with the exact bug the mirrored sell was written to fix.
 *
 * So a sell signature is not simply "seen". It is remembered WITH its
 * fraction, and a later delivery is let through exactly once, and only when
 * it upgrades an unknown fraction to a known one.
 */
const handledSells = new Map<string, number | null>();

type SellRoute = 'new' | 'upgrade' | 'drop';

function routeSell(t: WalletTrade): SellRoute {
  const sig = t.signature;
  if (!sig) return 'new';
  const fraction = fractionOf(t);
  if (!handledSells.has(sig)) {
    handledSells.set(sig, fraction);
    if (handledSells.size > HANDLED_CAP) {
      const oldest = handledSells.keys().next().value;
      if (oldest !== undefined) handledSells.delete(oldest);
    }
    return 'new';
  }
  if ((handledSells.get(sig) ?? null) === null && fraction !== null) {
    handledSells.set(sig, fraction);
    return 'upgrade';
  }
  return 'drop';
}

/**
 * `${configId}:${leaderSignature}` → the id of the "could not tell how much
 * they sold" row that delivery wrote. When a later delivery of the SAME sell
 * carries the fraction, that row is removed: the exit did happen, and a skip
 * the history cannot explain is worse than no row at all.
 */
const supersededSkips = new Map<string, string>();

/** Mints with an open copy, paper or live — the engine keeps them priced. */
export function openMints(chain?: ChainKind): string[] {
  return [...new Set(trades.filter((t) => t.state === 'open' && (chain === undefined || (t.chain ?? 'solana') === chain)).map((t) => t.mint))];
}

/**
 * A followed wallet traded. Evaluate every enabled config for that wallet.
 *
 * Sells are handled first because closing a paper position is bookkeeping,
 * and it must not be blocked by the daily limits that gate opening one — the
 * same rule as orders, for the same reason.
 */
export function onWalletTrade(t: WalletTrade): void {
  const h = host;
  if (!h) return;
  // An EVM address is case-insensitive; a Solana one is not.
  const chain = t.chain ?? 'solana';
  if (chain !== 'solana') t = { ...t, wallet: t.wallet.toLowerCase(), mint: t.mint.toLowerCase() };
  const matching = configs.filter((c) => c.enabled && chainOf(c) === chain && c.wallet === t.wallet);
  if (!matching.length) return;

  const route: SellRoute = t.isBuy ? (alreadyHandled(t.signature) ? 'drop' : 'new') : routeSell(t);
  if (route === 'drop') return;

  if (route === 'new') {
    // Their record first: scored whatever the configs below decide. An
    // upgrade is the SAME sell arriving again, so it is not scored twice.
    trackLeader(t);
    persist();
    h.changed();
  }

  for (const c of matching) {
    if (!t.isBuy) {
      if (c.copySells) queueExit(c, t);
      continue;
    }
    if (route !== 'new') continue;
    void evaluateBuy(c, t);
  }
}

// ── Mirrored sells ────────────────────────────────────────────────────
//
// Until 2026-09-08 a leader's sell only marked the copy closed: no sell was
// placed, and the history said "closed" over a wallet that still held every
// token (a user's report — the one 40 % that DID leave was their own
// take-profit ladder). Now a live copy mirrors the sell as a share of what
// THIS wallet holds — "they sold 40 %" is "sell 40 % of ours" — through the
// same pipeline a manual sell uses, and the record moves only when the sell
// confirmed. Paper copies keep the same bookkeeping without the order.

/** A paper round trip pays what a real one would: pump's 1 % on each side,
 *  and Krypt's own fee on each side. Charging one side only (which is what
 *  a single 0.99 did) reports a profit the identical real trades would not
 *  have made. */
const SIDE_COST = 0.01 + FEE_BPS / 10_000;

/** One exit at a time per copy, in the order the leader sold. Two sells a
 *  second apart (a ladder) must not both size from the same remainder. */
const exitChains = new Map<string, Promise<void>>();

function queueExit(c: CopyConfig, t: WalletTrade): void {
  const key = `${c.id}:${t.mint}`;
  const prev = exitChains.get(key) ?? Promise.resolve();
  const next = prev.then(() => closeOpen(c, t)).catch((err) => host?.log('error', `copy exit failed: ${(err as Error).message}`));
  exitChains.set(key, next);
  void next.then(() => {
    if (exitChains.get(key) === next) exitChains.delete(key);
  });
}

/** The leader's fraction, clamped to (0, 1]; null when it is not known. An
 *  unknown fraction is NOT "all of it": a leader trimming 10 % must never
 *  turn into us dumping the whole bag because one RPC reply lacked owners. */
function fractionOf(t: WalletTrade): number | null {
  const f = t.soldFraction;
  if (f === null || f === undefined || !Number.isFinite(f) || f <= 0) return null;
  return Math.min(1, f);
}

/** One sell of `fraction` of what is left of copy `x`: the slice record,
 *  and the copy itself moved on (remainder, realised, closed when spent). */
function applyExit(x: CopyTrade, fraction: number, exit: number | null, t: WalletTrade, signature: string | null): CopyTrade {
  const remaining = x.remainingPct ?? 100;
  const slicePct = fraction >= 1 ? remaining : remaining * fraction;
  const cost = x.ourSol * (slicePct / 100);
  const pnl =
    exit !== null && x.entryPriceSol !== null && x.entryPriceSol > 0
      ? cost * ((exit / x.entryPriceSol) * (1 - SIDE_COST) - (1 + SIDE_COST))
      : null;
  const slice: CopyTrade = {
    id: nextId('cx'),
    configId: x.configId,
    mode: x.mode,
    wallet: x.wallet,
    mint: x.mint,
    symbol: x.symbol || t.symbol,
    at: t.at,
    theirSol: t.sol,
    ourSol: cost,
    entryPriceSol: x.entryPriceSol,
    exitPriceSol: exit,
    closedAt: t.at,
    pnlSol: pnl,
    state: 'closed',
    reason: null,
    kind: 'exit',
    parentId: x.id,
    soldPct: Math.round(fraction * 100),
    signature,
  };
  x.remainingPct = Math.max(0, remaining - slicePct);
  if (pnl !== null) x.realizedSol = (x.realizedSol ?? 0) + pnl;
  if (exit !== null) x.exitPriceSol = exit;
  if (x.remainingPct <= 0.5) {
    x.remainingPct = 0;
    x.state = 'closed';
    x.closedAt = t.at;
  }
  return slice;
}

/** The exit that did NOT happen, kept in the history with its reason. */
function exitSkipped(x: CopyTrade, t: WalletTrade, pct: number, reason: string): CopyTrade {
  return {
    id: nextId('cx'),
    configId: x.configId,
    mode: x.mode,
    wallet: x.wallet,
    mint: x.mint,
    symbol: x.symbol || t.symbol,
    at: t.at,
    theirSol: t.sol,
    ourSol: x.ourSol * ((x.remainingPct ?? 100) / 100) * (pct / 100),
    entryPriceSol: x.entryPriceSol,
    exitPriceSol: null,
    closedAt: null,
    pnlSol: null,
    state: 'skipped',
    reason,
    kind: 'exit',
    parentId: x.id,
    soldPct: pct,
    signature: null,
  };
}

/** Still followed? A config removed mid-flight must stop the copy (copy-9). */
function stillConfigured(id: string): boolean {
  return configs.some((c) => c.id === id);
}

/**
 * The percentage of OUR TOKEN ACCOUNT that mirrors the leader's fraction.
 *
 * `h.sell` sells a percentage of everything this wallet holds of the mint,
 * not a percentage of the copy. When the wallet also holds a hand-bought bag
 * of the same token, mirroring "40 %" as 40 % sells 40 % of that bag too —
 * SOL the copier was never given permission to spend (copy-2). Scaling by
 * this config's share of our own basis fixes it. A host that cannot say what
 * we paid leaves the ratio at 1, which is the old behaviour exactly.
 */
function walletPctFor(c: CopyConfig, open: CopyTrade[], mint: string, fraction: number): number {
  let ratio = 1;
  const basis = host?.ourCostBasisSol?.(mint) ?? null;
  if (typeof basis === 'number' && Number.isFinite(basis) && basis > 0) {
    const ours = open.reduce((a, x) => a + x.ourSol * ((x.remainingPct ?? 100) / 100), 0);
    if (ours > 0) ratio = Math.min(1, ours / basis);
  }
  return Math.max(1, Math.min(100, Math.round(fraction * ratio * 100)));
}

async function closeOpen(c: CopyConfig, t: WalletTrade): Promise<void> {
  const h = host;
  if (!h) return;
  const rows = trades.filter((x) => x.configId === c.id && x.mint === t.mint && x.state === 'open' && x.kind !== 'exit');
  if (!rows.length) return;
  // A row is governed by the mode it was OPENED in, not by what the config is
  // set to today (copy-3). Flipping a config from paper to live used to make
  // the leader's next sell broadcast a real order against a paper row, and
  // then label that broadcast "paper" in the history.
  const paperRows = rows.filter((x) => x.mode === 'paper');
  const liveRows = rows.filter((x) => x.mode === 'live');

  const who = c.label || c.wallet.slice(0, 6);
  const what = t.symbol || t.mint.slice(0, 8);
  const skipKey = t.signature ? `${c.id}:${t.signature}` : null;
  const fraction = fractionOf(t);
  if (fraction === null) {
    const row = exitSkipped(rows[0], t, 100, 'not executed — could not tell how much of their holding they sold');
    // The wallet watcher may deliver this same sell again WITH the fraction
    // (copy-13); if it does, this row is withdrawn rather than left standing.
    if (skipKey) {
      supersededSkips.set(skipKey, row.id);
      // Bounded like `handled`: most of these are never superseded, because
      // most leaders are not on a rail that delivers a sell twice.
      if (supersededSkips.size > HANDLED_CAP) {
        const oldest = supersededSkips.keys().next().value;
        if (oldest !== undefined) supersededSkips.delete(oldest);
      }
    }
    record(row);
    h.toast('warn', `Copy sell skipped — ${who} sold ${what}, but the share they sold could not be read`);
    return;
  }
  const pct = Math.max(1, Math.min(100, Math.round(fraction * 100)));
  const exit = t.priceSol > 0 ? t.priceSol : (h.priceSol(t.mint, chainOf(c)) ?? null);
  let signature: string | null = null;

  // Paper rows are booked whatever happens below: bookkeeping costs nothing,
  // needs no order, and is exactly what would have happened had the config
  // never been flipped.
  const booked: CopyTrade[] = [...paperRows];

  if (liveRows.length) {
    if (c.mode !== 'live') {
      // Flipped to paper with a REAL position still open. The wallet holds
      // those tokens; nothing may close them but a sell that happened.
      record(
        exitSkipped(
          liveRows[0],
          t,
          pct,
          'not executed — this config is in paper mode now, and the live position it opened is still held',
        ),
      );
      h.toast('warn', `${who} sold ${pct}% of ${what} — your live position from this config is still open`);
    } else {
      const blocked = h.liveBlockedReason(chainOf(c));
      if (blocked) {
        record(exitSkipped(liveRows[0], t, pct, `not executed — ${blocked}`));
        h.toast('warn', `Copy sell skipped — ${who} sold ${pct}% of ${what}, but ${blocked}`);
      } else {
        const sellPct = walletPctFor(c, liveRows, t.mint, fraction);
        const res = await h.sell(t.mint, sellPct, { slippagePct: c.maxSlippagePct, walletId: c.walletId ?? undefined, chain: chainOf(c) });
        if (!stillConfigured(c.id)) return;
        if (res.ok) {
          signature = res.signature ?? null;
          booked.push(...liveRows);
          h.toast('success', `Copied sell: ${pct}% of ${what} with ${who}`);
        } else if (/nothing to sell|zero token balance/i.test(res.message)) {
          // Our own orders already emptied the bag. Nothing to mirror — say
          // so on the record rather than invent a fill or leave it "open".
          for (const x of liveRows) {
            x.state = 'closed';
            x.closedAt = t.at;
            x.remainingPct = 0;
            x.reason = 'nothing left to sell — your own orders had already sold it';
          }
          persist();
          h.changed();
          h.log('info', `copy: ${who} sold ${what} but this wallet holds none — record closed`);
        } else {
          record(exitSkipped(liveRows[0], t, pct, res.message.slice(0, 160)));
          h.log('warn', `copy sell FAILED (${who} sold ${pct}% of ${what}): ${res.message}`);
          h.toast('error', `Copy sell failed — ${pct}% of ${what}: ${res.message}`);
        }
      }
    }
  }

  if (!booked.length) return;
  for (const x of booked) {
    const slice = applyExit(x, fraction, exit, t, x.mode === 'live' ? signature : null);
    trades.unshift(slice);
  }
  // This sell DID happen, so an earlier "could not tell how much" row for the
  // same leader transaction was never true (copy-13).
  if (skipKey) {
    const stale = supersededSkips.get(skipKey);
    if (stale) {
      trades = trades.filter((x) => x.id !== stale);
      supersededSkips.delete(skipKey);
    }
  }
  if (trades.length > MAX_TRADES) trades.length = MAX_TRADES;
  persist();
  h.changed();
  recorder.record('copy_close', { configId: c.id, mint: t.mint, mode: c.mode, pct, signature });
}

async function evaluateBuy(c: CopyConfig, t: WalletTrade): Promise<void> {
  const h = host;
  if (!h) return;

  const base: CopyTrade = {
    id: nextId('ct'),
    configId: c.id,
    mode: c.mode,
    chain: chainOf(c),
    wallet: c.wallet,
    mint: t.mint,
    symbol: t.symbol,
    at: t.at,
    theirSol: t.sol,
    ourSol: copySize(c, t.sol),
    entryPriceSol: null,
    exitPriceSol: null,
    closedAt: null,
    pnlSol: null,
    state: 'skipped',
    reason: null,
  };

  const limit = limitHit(c);
  if (limit) {
    record({ ...base, reason: limit });
    return;
  }
  // The slot is taken NOW, before the first await, so the next swap in this
  // same slot sees it (copy-1). Everything below runs inside the try.
  reserve(c, Date.now());
  try {
    await copyOnce(c, t, base, h);
  } finally {
    release(c.id);
  }
}

/**
 * A filter is a REFUSAL, so it fails closed: "I could not read the
 * liquidity" is not "the liquidity is fine" (copy-4).
 *
 * The engine must supply these facts for launch-feed tokens. While it
 * returns null for the whole pump rail, every copy under the default config
 * is refused rather than silently unfiltered — the safe half of the wrong
 * pair, and one the user can see on the record.
 */
function unknownReason(label: string): string {
  return `${label} unknown — the filter you set could not be checked`;
}

async function copyOnce(c: CopyConfig, t: WalletTrade, base: CopyTrade, h: CopyHost): Promise<void> {
  // Filters. A rejected copy is RECORDED as skipped with its reason — the
  // paper scorecard must show what the filters kept you out of, or it is
  // only measuring the trades you happened to like.
  let facts: Awaited<ReturnType<CopyHost['tokenFacts']>>;
  try {
    facts = await h.tokenFacts(t.mint, chainOf(c));
  } catch {
    record({ ...base, reason: 'could not read token' });
    return;
  }
  if (!stillConfigured(c.id)) return;
  if (c.onlyPumpfun && !facts.isPumpfun) {
    record({ ...base, reason: 'not a pump.fun token' });
    return;
  }
  if (c.minLiquidityUsd !== null) {
    if (facts.liquidityUsd === null) {
      record({ ...base, reason: unknownReason('liquidity') });
      return;
    }
    if (facts.liquidityUsd < c.minLiquidityUsd) {
      record({ ...base, reason: `liquidity below $${c.minLiquidityUsd.toLocaleString()}` });
      return;
    }
  }
  if (c.maxMarketCapUsd !== null) {
    if (facts.marketCapUsd === null) {
      record({ ...base, reason: unknownReason('market cap') });
      return;
    }
    if (facts.marketCapUsd > c.maxMarketCapUsd) {
      record({ ...base, reason: `market cap above $${c.maxMarketCapUsd.toLocaleString()}` });
      return;
    }
  }
  if (c.minKryptScore !== null) {
    if (facts.kryptScore === null) {
      record({ ...base, reason: unknownReason('score') });
      return;
    }
    if (facts.kryptScore < c.minKryptScore) {
      record({ ...base, reason: `score ${facts.kryptScore} below ${c.minKryptScore}` });
      return;
    }
  }

  // The configured delay is REAL, including in paper. Copy trading is a
  // latency game and a paper fill at their price is a fiction.
  if (c.delayMs > 0) await new Promise((r) => setTimeout(r, c.delayMs));
  if (!stillConfigured(c.id)) return;

  const entry = h.priceSol(t.mint, chainOf(c)) ?? t.priceSol;
  if (!(entry > 0)) {
    record({ ...base, reason: 'no price at copy time' });
    return;
  }

  if (c.mode === 'paper') {
    record({ ...base, state: 'open', entryPriceSol: entry });
    h.log('info', `paper-copy ${c.label || c.wallet.slice(0, 6)}: ${base.ourSol} SOL of ${t.symbol}`);
    recorder.record('copy_open', { configId: c.id, mint: t.mint, mode: 'paper', ourSol: base.ourSol, entry });
    return;
  }

  // Live.
  const blocked = h.liveBlockedReason(chainOf(c)) ?? h.buyBlockedReason?.(chainOf(c)) ?? null;
  if (blocked) {
    record({ ...base, reason: `not executed — ${blocked}` });
    h.toast('warn', `Copy skipped — ${blocked}`);
    return;
  }
  // House rule 2: a budget is a refusal, not a clamp. Automation refuses over
  // the live cap; a copy that silently shrank to fit would report a size it
  // never traded and score the experiment against the wrong number (copy-8).
  const cap = h.maxLiveSol?.(chainOf(c)) ?? null;
  if (cap !== null && Number.isFinite(cap) && cap > 0 && base.ourSol > cap) {
    record({ ...base, reason: `copy of ${base.ourSol} SOL is above your live cap of ${cap} SOL` });
    h.toast('warn', `Copy skipped — ${base.ourSol} SOL is above your live max per trade (${cap} SOL)`);
    return;
  }
  const res = await h.buy(t.mint, base.ourSol, { slippagePct: c.maxSlippagePct, walletId: c.walletId ?? undefined, chain: chainOf(c) });
  if (!stillConfigured(c.id)) return;
  if (res.ok || res.pending === true) {
    // What was actually spent and actually filled, when the host knows it —
    // the requested size is a wish, and scoring a copy against a wish makes
    // every derived number wrong by asked over spent (copy-8).
    const spent = typeof res.spentSol === 'number' && res.spentSol > 0 ? res.spentSol : base.ourSol;
    const fill = typeof res.fillPriceSol === 'number' && res.fillPriceSol > 0 ? res.fillPriceSol : entry;
    // A broadcast that has not confirmed still bought the token, so the
    // position is real and must be openable — with the caveat ON the record,
    // not hidden (copy-5).
    const unconfirmed = !res.ok && res.pending === true;
    record({
      ...base,
      ourSol: spent,
      state: 'open',
      entryPriceSol: fill,
      reason: unconfirmed ? 'broadcast — not confirmed yet' : null,
    });
    h.toast(
      unconfirmed ? 'info' : 'success',
      `Copied ${c.label || c.wallet.slice(0, 6)}: ${spent} SOL of ${t.symbol}${unconfirmed ? ' (unconfirmed)' : ''}`,
    );
    recorder.record('copy_open', {
      configId: c.id,
      chain: chainOf(c),
      mint: t.mint,
      mode: 'live',
      ourSol: spent,
      signature: res.signature ?? null,
      pending: unconfirmed,
    });
  } else {
    record({ ...base, reason: res.message.slice(0, 160) });
    h.toast('error', `Copy failed: ${res.message}`);
  }
}

/** Mark paper positions to market so open PnL is not stale. */
export function markToMarket(mint: string, priceSol: number, chain?: ChainKind): void {
  if (!(priceSol > 0)) return;
  for (const t of trades) {
    if (t.state !== 'open' || t.mint !== mint || t.entryPriceSol === null) continue;
    if (chain !== undefined && (t.chain ?? 'solana') !== chain) continue;
    t.exitPriceSol = priceSol;
  }
  for (const b of Object.values(leaders)) {
    const p = b.positions[mint];
    if (p) p.markPriceSol = priceSol;
  }
}

/** Test seam. */
export function _reset(): void {
  configs = [];
  trades = [];
  leaders = {};
  filePath = '';
  loadFailure = null;
  handled.clear();
  handledSells.clear();
  supersededSkips.clear();
  pendingCopies.clear();
  recentCopies.clear();
  exitChains.clear();
}

export function _load(c: CopyConfig[], t: CopyTrade[], l: Record<string, LeaderBook> = {}): void {
  configs = c;
  trades = t;
  leaders = l;
}

/** Test seam: the raw book, as persisted. */
export function _leaders(): Record<string, LeaderBook> {
  return leaders;
}
