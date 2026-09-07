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
import path from 'node:path';
import {
  copySize,
  validateConfig,
  type CopyConfig,
  type CopyMode,
  type CopySnapshot,
  type CopyStats,
  type CopyTrade,
  type CopyWatchStatus,
} from '@shared/copytrade';
import { FEE_BPS } from '@shared/fees';
import * as recorder from './recorder';

const FILE = 'copytrade.json';
const MAX_TRADES = 2_000;
const MAX_CONFIGS = 25;

let configs: CopyConfig[] = [];
let trades: CopyTrade[] = [];
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;

export interface CopyHost {
  /** Fire a real buy. Only called for a `live` config. */
  buy(mint: string, sol: number): Promise<{ ok: boolean; message: string; signature?: string }>;
  /** Why a LIVE copy cannot execute, or null. Paper ignores this. */
  liveBlockedReason(): string | null;
  /** Current spot price in SOL for a mint, if known. */
  priceSol(mint: string): number | null;
  /** Token facts used by the filters. */
  tokenFacts(mint: string): Promise<{ liquidityUsd: number | null; marketCapUsd: number | null; kryptScore: number | null; isPumpfun: boolean }>;
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
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version: 1; configs: CopyConfig[]; trades: CopyTrade[] };
    configs = Array.isArray(raw?.configs) ? raw.configs : [];
    trades = Array.isArray(raw?.trades) ? raw.trades : [];
  } catch {
    configs = [];
    trades = [];
  }
  // A LIVE config never survives a restart armed. Same reasoning as orders:
  // an app that was closed for a week must not resume spending on wake.
  // Paper configs do resume, because paper costs nothing and an interrupted
  // experiment is a useless one.
  for (const c of configs) {
    if (c.mode === 'live' && c.enabled) {
      c.enabled = false;
    }
  }
}

function persist(): void {
  if (!filePath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, configs, trades: trades.slice(0, MAX_TRADES) }, null, 2), 'utf8');
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
  const v = validateConfig(input);
  if (!v.ok) return { ok: false, message: v.message };

  if (input.id) {
    const existing = configs.find((c) => c.id === input.id);
    if (!existing) return { ok: false, message: 'Config not found' };
    const wasLive = existing.mode === 'live' && existing.enabled;
    Object.assign(existing, input);
    persist();
    host?.changed();
    if (!wasLive && existing.mode === 'live' && existing.enabled) {
      host?.toast('warn', `LIVE copy trading armed for ${existing.label || existing.wallet.slice(0, 6)} — real SOL will be spent`);
    }
    return { ok: true, message: 'Saved' };
  }

  if (configs.length >= MAX_CONFIGS) return { ok: false, message: `Limit of ${MAX_CONFIGS} configs reached` };
  if (configs.some((c) => c.wallet === input.wallet)) {
    return { ok: false, message: 'You are already following that wallet' };
  }
  const c: CopyConfig = { ...input, id: nextId('cp'), createdAt: Date.now() };
  configs.unshift(c);
  persist();
  host?.changed();
  return { ok: true, message: `Following ${c.label || c.wallet.slice(0, 6)}` };
}

export function remove(id: string): { ok: boolean; message: string } {
  const before = configs.length;
  configs = configs.filter((c) => c.id !== id);
  if (configs.length === before) return { ok: false, message: 'Config not found' };
  trades = trades.filter((t) => t.configId !== id);
  persist();
  host?.changed();
  return { ok: true, message: 'Stopped following' };
}

export function all(): CopyConfig[] {
  return configs.map((c) => ({ ...c }));
}

/** Wallets with an enabled config — the engine's watch list. */
export function activeWallets(): Set<string> {
  return new Set(configs.filter((c) => c.enabled).map((c) => c.wallet));
}

// ── Stats ─────────────────────────────────────────────────────────────

function statsFor(c: CopyConfig): CopyStats {
  const mine = trades.filter((t) => t.configId === c.id);
  const closed = mine.filter((t) => t.state === 'closed' && t.pnlSol !== null);
  const open = mine.filter((t) => t.state === 'open');
  return {
    configId: c.id,
    mode: c.mode,
    trades: mine.filter((t) => t.state !== 'skipped').length,
    wins: closed.filter((t) => (t.pnlSol as number) > 0).length,
    losses: closed.filter((t) => (t.pnlSol as number) < 0).length,
    realizedPnlSol: closed.reduce((a, t) => a + (t.pnlSol as number), 0),
    openCount: open.length,
    openCostSol: open.reduce((a, t) => a + t.ourSol, 0),
    skipped: mine.filter((t) => t.state === 'skipped' && t.reason !== null && !t.reason.startsWith('limit')).length,
    blocked: mine.filter((t) => t.state === 'skipped' && t.reason?.startsWith('limit')).length,
    firstAt: mine.length ? Math.min(...mine.map((t) => t.at)) : null,
    lastAt: mine.length ? Math.max(...mine.map((t) => t.at)) : null,
  };
}

export function snapshot(): CopySnapshot {
  const stats: Record<string, CopyStats> = {};
  for (const c of configs) stats[c.id] = statsFor(c);
  const blocked = host?.liveBlockedReason() ?? null;
  return {
    configs: all(),
    stats,
    recent: trades.slice(0, 100).map((t) => ({ ...t })),
    liveExecutable: blocked === null,
    liveBlockedReason: blocked,
    watch: host?.watchStatus?.() ?? {},
  };
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

function limitHit(c: CopyConfig): string | null {
  const today = todayFor(c.id);
  if (today.length >= c.dailyTradeLimit) return `limit: ${c.dailyTradeLimit} copies today`;
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

/** Mints with an open copy, paper or live — the engine keeps them priced. */
export function openMints(): string[] {
  return [...new Set(trades.filter((t) => t.state === 'open').map((t) => t.mint))];
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
  const matching = configs.filter((c) => c.enabled && c.wallet === t.wallet);
  if (!matching.length) return;
  if (alreadyHandled(t.signature)) return;

  for (const c of matching) {
    if (!t.isBuy) {
      if (c.copySells) closeOpen(c, t);
      continue;
    }
    void evaluateBuy(c, t);
  }
}

function closeOpen(c: CopyConfig, t: WalletTrade): void {
  const open = trades.filter((x) => x.configId === c.id && x.mint === t.mint && x.state === 'open');
  if (!open.length) return;
  for (const x of open) {
    const exit = t.priceSol > 0 ? t.priceSol : (host?.priceSol(t.mint) ?? null);
    if (exit === null || x.entryPriceSol === null || x.entryPriceSol <= 0) {
      x.state = 'closed';
      x.closedAt = t.at;
      x.pnlSol = null;
      continue;
    }
    x.exitPriceSol = exit;
    x.closedAt = t.at;
    // A paper round trip pays what a real one would: pump's 1 % on each
    // side, and Krypt's own fee on each side. Charging one side only (which
    // is what a single 0.99 did) reports a profit the identical real trades
    // would not have made.
    const sideCost = 0.01 + FEE_BPS / 10_000;
    const gross = x.ourSol * (exit / x.entryPriceSol);
    x.pnlSol = gross * (1 - sideCost) - x.ourSol * (1 + sideCost);
    x.state = 'closed';
  }
  persist();
  host?.changed();
  recorder.record('copy_close', { configId: c.id, mint: t.mint, mode: c.mode });
}

async function evaluateBuy(c: CopyConfig, t: WalletTrade): Promise<void> {
  const h = host;
  if (!h) return;

  const base: CopyTrade = {
    id: nextId('ct'),
    configId: c.id,
    mode: c.mode,
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

  // Filters. A rejected copy is RECORDED as skipped with its reason — the
  // paper scorecard must show what the filters kept you out of, or it is
  // only measuring the trades you happened to like.
  let facts: Awaited<ReturnType<CopyHost['tokenFacts']>>;
  try {
    facts = await h.tokenFacts(t.mint);
  } catch {
    record({ ...base, reason: 'could not read token' });
    return;
  }
  if (c.onlyPumpfun && !facts.isPumpfun) {
    record({ ...base, reason: 'not a pump.fun token' });
    return;
  }
  if (c.minLiquidityUsd !== null && facts.liquidityUsd !== null && facts.liquidityUsd < c.minLiquidityUsd) {
    record({ ...base, reason: `liquidity below $${c.minLiquidityUsd.toLocaleString()}` });
    return;
  }
  if (c.maxMarketCapUsd !== null && facts.marketCapUsd !== null && facts.marketCapUsd > c.maxMarketCapUsd) {
    record({ ...base, reason: `market cap above $${c.maxMarketCapUsd.toLocaleString()}` });
    return;
  }
  if (c.minKryptScore !== null && facts.kryptScore !== null && facts.kryptScore < c.minKryptScore) {
    record({ ...base, reason: `score ${facts.kryptScore} below ${c.minKryptScore}` });
    return;
  }

  // The configured delay is REAL, including in paper. Copy trading is a
  // latency game and a paper fill at their price is a fiction.
  if (c.delayMs > 0) await new Promise((r) => setTimeout(r, c.delayMs));

  const entry = h.priceSol(t.mint) ?? t.priceSol;
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
  const blocked = h.liveBlockedReason();
  if (blocked) {
    record({ ...base, reason: `not executed — ${blocked}` });
    h.toast('warn', `Copy skipped — ${blocked}`);
    return;
  }
  const res = await h.buy(t.mint, base.ourSol);
  if (res.ok) {
    record({ ...base, state: 'open', entryPriceSol: entry });
    h.toast('success', `Copied ${c.label || c.wallet.slice(0, 6)}: ${base.ourSol} SOL of ${t.symbol}`);
    recorder.record('copy_open', { configId: c.id, mint: t.mint, mode: 'live', ourSol: base.ourSol, signature: res.signature ?? null });
  } else {
    record({ ...base, reason: res.message.slice(0, 160) });
    h.toast('error', `Copy failed: ${res.message}`);
  }
}

/** Mark paper positions to market so open PnL is not stale. */
export function markToMarket(mint: string, priceSol: number): void {
  if (!(priceSol > 0)) return;
  for (const t of trades) {
    if (t.state !== 'open' || t.mint !== mint || t.entryPriceSol === null) continue;
    t.exitPriceSol = priceSol;
  }
}

/** Test seam. */
export function _reset(): void {
  configs = [];
  trades = [];
  filePath = '';
  handled.clear();
}

export function _load(c: CopyConfig[], t: CopyTrade[]): void {
  configs = c;
  trades = t;
}
