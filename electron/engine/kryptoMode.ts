// $Krypto Mode sessions — main process. The rules are in shared/kryptoMode.ts.
//
// ONE INVARIANT ABOVE ALL: a session starts only from a metadata upload this
// app stamped with the bot's disclosure (`declare` → `start`). There is no
// other door, so there is no way to run a Krypto Mode bot on a coin whose
// description does not name its wallet. `start` refuses a mint/uri pair it
// did not declare, and the tests pin it.
//
// Each session is one coin, one wallet made for it, one budget:
//   • paper — fills simulated at the live price, nothing signed;
//   • live  — the budget is funded from the launch wallet, and every trade is
//     an ordinary buy/sell signed by the bot wallet through the full trade
//     pipeline (fees, breakers, per-trade cap, ledger). Its book is read back
//     from the CHAIN after each trade: SOL and tokens by balance, never the
//     requested amount.
//
// State persists in userData/krypto-mode.json, tmp + rename. An unreadable
// file is NOT an empty one: the session runs read-only rather than write
// over it (the ledger.ts rule).

import fs from 'node:fs';
import path from 'node:path';
import {
  checkKryptoIntent,
  kryptoFacts,
  paperSellProceeds,
  parseKryptoIntent,
  strategyIntent,
  type KryptoDriver,
  type KryptoIntent,
  type KryptoOptions,
  type KryptoSession,
  type KryptoStatus,
  type KryptoTrade,
  type KryptoView,
} from '@shared/kryptoMode';
import { modelledPaperFill } from '@shared/paper';

export type { KryptoMode, KryptoStatus, KryptoTrade, KryptoSession } from '@shared/kryptoMode';

/** A pinned metadata file that declares a bot wallet, not yet launched. */
export interface KryptoDeclared {
  walletId: string;
  address: string;
  at: number;
  /** A session has run on this wallet. It is named in that coin's
   *  description forever, so it is never handed to another coin. */
  used?: boolean;
}

export interface KryptoHost {
  now(): number;
  /** Cheap price, SOL per token; may await one market read. Null = unknown. */
  priceSol(mint: string): Promise<number | null>;
  /** Public market facts for the AI driver. */
  market(mint: string): { symbol: string; ageSec: number | null; marketCapUsd: number | null; holders: number | null; change5mPct: number | null };
  /** Why a live trade cannot run now (not armed, breaker…), or null. */
  liveBlocked(): string | null;
  buy(walletId: string, mint: string, sol: number): Promise<{ ok: boolean; message: string; signature: string | null; stage?: string | null }>;
  sell(walletId: string, mint: string, pct: number): Promise<{ ok: boolean; message: string; signature: string | null; stage?: string | null }>;
  /** The bot wallet's SOL (lamports) and token balance (UI units); null = unread. */
  balances(address: string, mint: string): Promise<{ lamports: number | null; tokens: number | null }>;
  fund(fromWalletId: string, toAddress: string, lamports: number): Promise<{ ok: boolean; message: string }>;
  collect(walletId: string, toWalletId: string): Promise<{ ok: boolean; message: string }>;
  /** Ask the user's AI key. Null when no key is set. */
  ask(facts: string): Promise<{ ok: boolean; message: string; text?: string } | null>;
  /** Keep live ticks flowing for this mint. */
  watch(mint: string): void;
  emit(sessions: KryptoSession[]): void;
  log(level: 'info' | 'warn', line: string): void;
}

const FILE = 'krypto-mode.json';
const MAX_TRADES_KEPT = 100;
const MAX_SESSIONS = 50;
/** SOL left in the bot wallet on top of the budget, for fees and rent. */
export const FEE_HEADROOM_LAMPORTS = 15_000_000;
const TICK_MS = 5_000;
const AI_EVERY_MS = 60_000;
const AI_PER_HOUR = 30;
const SYNC_EVERY_MS = 30_000;

let host: KryptoHost | null = null;
let filePath = '';
let loadFailure: string | null = null;
let sessions: KryptoSession[] = [];
let declared: Record<string, KryptoDeclared> = {};
let timer: NodeJS.Timeout | null = null;
const busy = new Set<string>();

// ─── persistence ───────────────────────────────────────────────────────────

export function init(userDataDir: string, h: KryptoHost): void {
  host = h;
  filePath = userDataDir ? path.join(userDataDir, FILE) : '';
  loadFailure = null;
  sessions = [];
  declared = {};
  if (!filePath) return;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      h.log('warn', `krypto mode: ${loadFailure} — sessions are read-only this run`);
    }
    return;
  }
  try {
    const raw = JSON.parse(text) as { sessions?: KryptoSession[]; declared?: Record<string, KryptoDeclared> };
    sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    declared = raw.declared && typeof raw.declared === 'object' ? raw.declared : {};
  } catch (e) {
    loadFailure = `${filePath} is corrupt (${(e as Error).message})`;
    h.log('warn', `krypto mode: ${loadFailure} — sessions are read-only this run`);
    sessions = [];
    declared = {};
  }
}

export function failure(): string | null {
  return loadFailure;
}

function save(): void {
  if (!filePath || loadFailure) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions, declared }, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* memory stays authoritative this run */
  }
}

function changed(): void {
  save();
  host?.emit(list());
}

// ─── the one door ──────────────────────────────────────────────────────────

/** Record that this metadata file declares this bot wallet. Called by the
 *  upload handler right after it pinned the stamped description. */
export function declare(metadataUri: string, walletId: string, address: string): void {
  if (!metadataUri) return;
  declared[metadataUri] = { walletId, address, at: host?.now() ?? Date.now() };
  // Old unused declarations are only wallets waiting for a launch; keep 20.
  const keys = Object.keys(declared).sort((a, b) => declared[a]!.at - declared[b]!.at);
  while (keys.length > 20) delete declared[keys.shift()!];
  save();
}

export function declaredFor(metadataUri: string): KryptoDeclared | null {
  return declared[metadataUri] ?? null;
}

/** A declared wallet no session uses yet — reused on a re-upload so editing
 *  the draft does not mint a new wallet every time. */
export function unusedDeclaredWallet(): KryptoDeclared | null {
  const used = new Set([...sessions.map((s) => s.walletId), ...Object.values(declared).filter((d) => d.used).map((d) => d.walletId)]);
  const free = Object.values(declared).filter((d) => !used.has(d.walletId));
  free.sort((a, b) => b.at - a.at);
  return free[0] ?? null;
}

export async function start(p: {
  mint: string;
  symbol: string;
  metadataUri: string;
  launchWalletId: string;
  options: KryptoOptions;
}): Promise<{ ok: boolean; message: string; session?: KryptoSession }> {
  if (!host) return { ok: false, message: 'Krypto Mode is not ready.' };
  if (loadFailure) return { ok: false, message: `Krypto Mode is read-only this run: ${loadFailure}` };
  const d = declared[p.metadataUri];
  if (!d) {
    return { ok: false, message: 'This coin’s metadata does not declare a Krypto Mode wallet, so no bot runs on it. Upload the metadata again with Krypto Mode on.' };
  }
  if (sessions.some((s) => s.mint === p.mint)) return { ok: false, message: 'A Krypto Mode session already runs on this coin.' };
  if (sessions.length >= MAX_SESSIONS) return { ok: false, message: `At most ${MAX_SESSIONS} Krypto Mode sessions are kept. Remove a stopped one first.` };
  const now = host.now();
  const s: KryptoSession = {
    id: `km_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    mint: p.mint,
    symbol: p.symbol,
    walletId: d.walletId,
    address: d.address,
    launchWalletId: p.launchWalletId,
    metadataUri: p.metadataUri,
    driver: p.options.driver,
    strategy: p.options.strategy,
    budgetSol: p.options.budgetSol,
    mode: 'paper',
    status: 'running',
    createdAt: now,
    ...freshBook(),
    trades: [],
    note: null,
    lastAiAt: null,
    aiCalls: [],
  };
  sessions.unshift(s);
  for (const x of Object.values(declared)) if (x.walletId === d.walletId) x.used = true;
  host.watch(p.mint);
  changed();
  if (p.options.live) {
    const r = await goLive(s.id);
    if (!r.ok) {
      s.note = `Started on paper: ${r.message}`;
      changed();
      return { ok: true, message: s.note, session: s };
    }
  }
  host.log('info', `krypto mode: ${s.symbol} started (${s.mode}, ${s.driver === 'strategy' ? s.strategy : s.driver}, budget ${s.budgetSol} SOL, bot ${s.address})`);
  return { ok: true, message: `Krypto Mode is running on ${s.symbol} (${s.mode}).`, session: s };
}

function freshBook(): Pick<KryptoSession, 'tokensHeld' | 'netSpentSol' | 'entered' | 'lots' | 'rungsDone' | 'peakPriceSol' | 'lastPriceSol' | 'lastTradeAt' | 'lastSide' | 'recentTrades' | 'fundedLamports'> {
  return { tokensHeld: 0, netSpentSol: 0, entered: false, lots: [], rungsDone: [], peakPriceSol: null, lastPriceSol: null, lastTradeAt: null, lastSide: null, recentTrades: [], fundedLamports: null };
}

// ─── controls ──────────────────────────────────────────────────────────────

export function list(): KryptoSession[] {
  return sessions.map((s) => ({ ...s, trades: s.trades.slice(0, 30) }));
}

function find(id: string): KryptoSession | null {
  return sessions.find((s) => s.id === id) ?? null;
}

export function setStatus(id: string, status: KryptoStatus): { ok: boolean; message: string } {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  s.status = status;
  s.note = null;
  changed();
  return { ok: true, message: `${s.symbol}: ${status}.` };
}

/** Paper → live: fund the budget from the launch wallet and start a fresh book. */
export async function goLive(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  if (s.mode === 'live') return { ok: false, message: 'Already live.' };
  const blocked = host.liveBlocked();
  if (blocked) return { ok: false, message: blocked };
  const lamports = Math.round(s.budgetSol * 1e9) + FEE_HEADROOM_LAMPORTS;
  const before = await host.balances(s.address, s.mint);
  const f = await host.fund(s.launchWalletId, s.address, lamports);
  if (!f.ok) return { ok: false, message: `Could not fund the bot wallet: ${f.message}` };
  const after = await host.balances(s.address, s.mint);
  Object.assign(s, freshBook());
  s.mode = 'live';
  s.status = 'running';
  // The base net spend is measured against: whatever the wallet held after
  // funding (it may hold leftovers), read from the chain when possible.
  s.fundedLamports = after.lamports ?? (before.lamports ?? 0) + lamports;
  s.tokensHeld = after.tokens ?? 0;
  s.note = null;
  changed();
  host.log('info', `krypto mode: ${s.symbol} is live — funded ${(lamports / 1e9).toFixed(4)} SOL into ${s.address}`);
  return { ok: true, message: `${s.symbol} is live.` };
}

/** Sell the whole bag and stop. */
export async function sellAll(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  s.status = 'stopped';
  if (s.tokensHeld <= 0) {
    changed();
    return { ok: true, message: `${s.symbol}: stopped, nothing was held.` };
  }
  const r = await execute(s, { action: 'sell', pct: 100, reason: 'sold by you', exit: true }, 'strategy', true);
  changed();
  return r;
}

/** Stopped live session: send the bot wallet's SOL back to the launch wallet. */
export async function withdraw(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  if (s.status !== 'stopped') return { ok: false, message: 'Stop the session first.' };
  if (s.mode !== 'live') return { ok: false, message: 'A paper session has nothing to withdraw.' };
  const r = await host.collect(s.walletId, s.launchWalletId);
  s.note = r.ok ? 'SOL sent back to the launch wallet.' : `Withdraw failed: ${r.message}`;
  changed();
  return r;
}

export function remove(id: string): { ok: boolean; message: string } {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  if (s.status !== 'stopped') return { ok: false, message: 'Stop the session first.' };
  if (s.mode === 'live' && s.tokensHeld > 0) return { ok: false, message: 'The bot still holds tokens. Sell them first.' };
  sessions = sessions.filter((x) => x.id !== id);
  changed();
  return { ok: true, message: 'Removed. The wallet stays on your Wallet page.' };
}

// ─── the loop ──────────────────────────────────────────────────────────────

export function startLoop(): void {
  if (timer) return;
  for (const s of sessions) if (s.status === 'running') host?.watch(s.mint);
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
}

export function stopLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick(): Promise<void> {
  if (!host || loadFailure) return;
  for (const s of sessions) {
    if (s.status !== 'running' || busy.has(s.id)) continue;
    busy.add(s.id);
    try {
      await step(s);
    } catch (e) {
      s.note = `error: ${(e as Error).message}`;
    } finally {
      busy.delete(s.id);
    }
  }
}

function viewOf(s: KryptoSession, now: number): KryptoView {
  const held = s.lots.reduce((a, l) => a + l.tokens, 0);
  const cost = s.lots.reduce((a, l) => a + l.sol, 0);
  return {
    now,
    priceSol: s.lastPriceSol,
    tokensHeld: s.tokensHeld,
    netSpentSol: s.netSpentSol,
    budgetSol: s.budgetSol,
    entered: s.entered || s.strategy === 'dip' || s.driver !== 'strategy',
    entryPriceSol: held > 0 && cost > 0 ? cost / held : null,
    peakPriceSol: s.peakPriceSol,
    lots: s.lots,
    rungsDone: s.rungsDone,
    lastTradeAt: s.lastTradeAt,
    lastSide: s.lastSide,
    recentTrades: s.recentTrades,
  };
}

async function step(s: KryptoSession): Promise<void> {
  const h = host!;
  const now = h.now();
  const px = await h.priceSol(s.mint);
  if (px) {
    s.lastPriceSol = px;
    s.peakPriceSol = s.peakPriceSol === null ? px : Math.max(s.peakPriceSol, px);
  }
  let intent: KryptoIntent | null = null;
  if (s.driver === 'strategy') {
    intent = strategyIntent(s.strategy, viewOf(s, now));
  } else if (s.driver === 'ai') {
    s.aiCalls = s.aiCalls.filter((t) => now - t < 3_600_000);
    if ((s.lastAiAt === null || now - s.lastAiAt >= AI_EVERY_MS) && s.aiCalls.length < AI_PER_HOUR && px) {
      s.lastAiAt = now;
      s.aiCalls.push(now);
      const r = await h.ask(kryptoFacts(viewOf(s, now), h.market(s.mint)));
      if (!r) s.note = 'No AI key is set (Settings → AI), so the bot holds.';
      else if (!r.ok || !r.text) s.note = `AI: ${r.message}`;
      else {
        intent = parseKryptoIntent(r.text);
        if (!intent) s.note = 'The AI reply was not usable; holding.';
      }
    }
  }
  // A live book is re-read from the chain every half minute, so a trade whose
  // balances could not be read right after it (or one that was still pending)
  // is caught up rather than leaving the budget miscounted.
  if (s.mode === 'live' && s.fundedLamports !== null && (s.lastSyncAt === undefined || now - s.lastSyncAt >= SYNC_EVERY_MS)) {
    s.lastSyncAt = now;
    const b = await h.balances(s.address, s.mint);
    if (b.tokens !== null) s.tokensHeld = b.tokens;
    if (b.lamports !== null) s.netSpentSol = (s.fundedLamports - b.lamports) / 1e9;
  }
  // 'mcp' sessions trade only when a tool call asks (tradeFromMcp).
  if (intent && intent.action !== 'hold') {
    await execute(s, intent, s.driver, false);
  } else if (intent) {
    s.note = intent.reason;
  }
  h.emit(list());
}

/**
 * Run one intent through the guard and then for real (or on paper).
 * `force` skips the pacing checks — only for "sell everything" by the user.
 */
async function execute(s: KryptoSession, raw: KryptoIntent, by: KryptoDriver, force: boolean): Promise<{ ok: boolean; message: string }> {
  const h = host!;
  const now = h.now();
  const view = viewOf(s, now);
  let intent = raw;
  if (!force) {
    const c = checkKryptoIntent(raw, view);
    if (!c.ok) {
      s.note = `${raw.action} refused: ${c.reason}`;
      return { ok: false, message: s.note };
    }
    intent = c.intent;
  }
  if (intent.action === 'hold') return { ok: true, message: intent.reason };
  const px = s.lastPriceSol;

  const trade: KryptoTrade = {
    at: now,
    side: intent.action,
    sol: null,
    pct: intent.action === 'sell' ? intent.pct : null,
    tokens: null,
    priceSol: px,
    mode: s.mode,
    ok: false,
    message: '',
    signature: null,
    reason: intent.reason,
    by,
  };

  if (s.mode === 'paper') {
    if (!px) return { ok: false, message: 'price unknown' };
    if (intent.action === 'buy') {
      const f = modelledPaperFill(intent.sol, px);
      if (!f) return { ok: false, message: 'could not price the paper fill' };
      trade.sol = f.costSol;
      trade.tokens = f.tokens;
      s.tokensHeld += f.tokens;
      s.netSpentSol += f.costSol;
      s.lots.push({ priceSol: f.costSol / f.tokens, tokens: f.tokens, sol: f.costSol, at: now });
    } else {
      const p = paperSellProceeds(s.tokensHeld, intent.pct, px);
      trade.sol = p.sol;
      trade.tokens = p.tokens;
      s.tokensHeld = Math.max(0, s.tokensHeld - p.tokens);
      s.netSpentSol -= p.sol;
      shrinkLots(s, intent, p.tokens);
    }
    trade.ok = true;
    trade.message = 'paper fill';
  } else {
    const blocked = h.liveBlocked();
    if (blocked && !force) {
      s.note = `live trade waiting: ${blocked}`;
      return { ok: false, message: s.note };
    }
    const before = await h.balances(s.address, s.mint);
    const r = intent.action === 'buy' ? await h.buy(s.walletId, s.mint, intent.sol) : await h.sell(s.walletId, s.mint, intent.pct);
    trade.ok = r.ok;
    trade.message = r.message;
    trade.signature = r.signature;
    if (r.ok || r.stage === 'pending') {
      // The book from the CHAIN, not from what was asked.
      const after = await h.balances(s.address, s.mint);
      if (after.tokens !== null) {
        const dTok = before.tokens !== null ? after.tokens - before.tokens : null;
        s.tokensHeld = after.tokens;
        trade.tokens = dTok === null ? null : Math.abs(dTok);
      }
      if (after.lamports !== null && s.fundedLamports !== null) {
        s.netSpentSol = (s.fundedLamports - after.lamports) / 1e9;
      }
      if (after.lamports !== null && before.lamports !== null) trade.sol = Math.abs(after.lamports - before.lamports) / 1e9;
      if (intent.action === 'buy' && trade.tokens && trade.sol) {
        s.lots.push({ priceSol: trade.sol / trade.tokens, tokens: trade.tokens, sol: trade.sol, at: now });
      } else if (intent.action === 'sell') {
        shrinkLots(s, intent, trade.tokens ?? 0);
      }
    }
  }

  s.trades.unshift(trade);
  if (s.trades.length > MAX_TRADES_KEPT) s.trades.length = MAX_TRADES_KEPT;
  if (trade.ok || trade.signature) {
    s.lastTradeAt = now;
    s.lastSide = intent.action;
    s.recentTrades = [...s.recentTrades.filter((t) => now - t < 3_600_000), now];
    if (intent.action === 'buy') s.entered = true;
    if (intent.action === 'sell' && intent.rung !== undefined) s.rungsDone = [...s.rungsDone, intent.rung];
    // An exit ends a strategy's round: the next one opens fresh.
    if (intent.action === 'sell' && (intent.exit || s.tokensHeld <= 0) && s.strategy !== 'dip') {
      s.entered = false;
      s.rungsDone = [];
      s.lots = [];
      if (!force && s.driver === 'strategy') s.status = 'stopped';
    }
  }
  s.note = `${trade.ok ? '' : 'failed: '}${intent.action} — ${intent.reason}${trade.ok ? '' : ` (${trade.message})`}`;
  h.log(trade.ok ? 'info' : 'warn', `krypto mode ${s.symbol} (${s.mode}): ${s.note}`);
  changed();
  return { ok: trade.ok, message: s.note };
}

/** Take sold tokens out of the lots: the named lot first, then oldest-first. */
function shrinkLots(s: KryptoSession, intent: KryptoIntent, sold: number): void {
  if (intent.action !== 'sell') return;
  if (intent.pct >= 100 || s.tokensHeld <= 0) {
    s.lots = [];
    return;
  }
  let left = sold;
  const order = intent.lot !== undefined && s.lots[intent.lot] ? [intent.lot, ...s.lots.map((_, i) => i).filter((i) => i !== intent.lot)] : s.lots.map((_, i) => i);
  for (const i of order) {
    const lot = s.lots[i]!;
    if (left <= 0) break;
    const take = Math.min(lot.tokens, left);
    const share = lot.tokens > 0 ? take / lot.tokens : 0;
    lot.sol -= lot.sol * share;
    lot.tokens -= take;
    left -= take;
  }
  s.lots = s.lots.filter((l) => l.tokens > 1e-9);
}

// ─── MCP ───────────────────────────────────────────────────────────────────

/**
 * A trade asked for by an AI over MCP. Only sessions set to the MCP driver,
 * and only in the mode the connection allows: a paper connection cannot move
 * a live session's money.
 */
export async function tradeFromMcp(
  mint: string,
  side: 'buy' | 'sell',
  amount: number,
  connectionLive: boolean,
): Promise<{ ok: boolean; message: string; session?: KryptoSession }> {
  const s = sessions.find((x) => x.mint === mint);
  if (!s) return { ok: false, message: 'No Krypto Mode session runs on that coin.' };
  if (s.driver !== 'mcp') return { ok: false, message: `That session is driven by ${s.driver === 'strategy' ? 'a built-in strategy' : 'the AI key'}, not MCP.` };
  if (s.status !== 'running') return { ok: false, message: `That session is ${s.status}.` };
  if (s.mode === 'live' && !connectionLive) return { ok: false, message: 'That session is live and this connection is paper-only.' };
  const px = await host!.priceSol(mint);
  if (px) {
    s.lastPriceSol = px;
    s.peakPriceSol = s.peakPriceSol === null ? px : Math.max(s.peakPriceSol, px);
  }
  const intent: KryptoIntent = side === 'buy' ? { action: 'buy', sol: amount, reason: 'asked over MCP' } : { action: 'sell', pct: amount, reason: 'asked over MCP' };
  const r = await execute(s, intent, 'mcp', false);
  return { ...r, session: list().find((x) => x.id === s.id) };
}

/** For the tests. */
export function _reset(): void {
  stopLoop();
  host = null;
  sessions = [];
  declared = {};
  loadFailure = null;
  filePath = '';
  busy.clear();
}
