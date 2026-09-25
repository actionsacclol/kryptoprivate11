// $Krypto Mode — a launched coin's own trading bot, DECLARED IN PUBLIC.
//
// pump's mayhem mode is an agent trading a coin, and it is honest because it
// is public: the flag is on the chain and every scanner can read it. Krypto
// Mode is the same idea with the creator's choice of driver (a built-in
// strategy, their own AI key, or an AI over MCP) — and it is honest the same
// way. The bot trades from ONE wallet made for it, and that wallet's address
// is written into the coin's metadata description before the coin exists.
// The description is pinned and pointed at by the mint forever, so anyone
// can look up exactly what the bot did.
//
// THE RULE THIS FILE EXISTS TO KEEP: a bot wallet never trades a coin whose
// metadata does not name it. A hidden creator bot is how a chart is faked
// (the 09-25 rugs were exactly that), and this app will not sell that tool.
// Main enforces it: a session only starts from a metadata upload this app
// stamped with the disclosure (see electron/engine/kryptoMode.ts).
//
// What it will not do either, whatever the driver asks: churn. A buy right
// after a sell, or trades faster than a person could read the chart, exist to
// print volume — `checkKryptoIntent` refuses them.
//
// Pure: no I/O. The session manager lives in main.

import { MAX_DESCRIPTION, withWatermark } from './launch';
import { PAPER_SIDE_COST } from './paper';

// ─── Options chosen on the Launch page ─────────────────────────────────────

/** Who decides the trades. */
export type KryptoDriver = 'strategy' | 'ai' | 'mcp';
/** The built-in strategies. */
export type KryptoStrategy = 'ladder' | 'trail' | 'dip';

export interface KryptoOptions {
  enabled: boolean;
  driver: KryptoDriver;
  strategy: KryptoStrategy;
  /** SOL the bot may have at risk at once. Funded into its wallet on live. */
  budgetSol: number;
  /** Start live (funded, real trades) instead of paper. */
  live: boolean;
}

export const DEFAULT_KRYPTO_OPTIONS: KryptoOptions = {
  enabled: false,
  driver: 'strategy',
  strategy: 'ladder',
  budgetSol: 0.1,
  live: false,
};

export const KRYPTO_DRIVERS: readonly KryptoDriver[] = ['strategy', 'ai', 'mcp'];
export const KRYPTO_STRATEGIES: readonly KryptoStrategy[] = ['ladder', 'trail', 'dip'];

export const KRYPTO_MIN_BUDGET_SOL = 0.02;
export const KRYPTO_MAX_BUDGET_SOL = 10;

export const KRYPTO_DRIVER_TEXT: Record<KryptoDriver, { label: string; help: string }> = {
  strategy: { label: 'Built-in strategy', help: 'One of the strategies below trades by fixed rules. Nothing leaves your machine.' },
  ai: { label: 'Your AI key', help: 'Your AI key (Settings → AI) is asked what to do about once a minute. It sees only public facts about the coin and the bot’s own position.' },
  mcp: { label: 'AI over MCP', help: 'An AI connected over MCP (Settings → AI connection) trades it with the krypto_mode_trade tool. Paper connections trade paper sessions only.' },
};

export const KRYPTO_STRATEGY_TEXT: Record<KryptoStrategy, { label: string; help: string }> = {
  ladder: { label: 'Take profit in steps', help: 'Buys half the budget at the start, then sells a quarter of the bag at 2x, 3x, 5x and the rest at 10x. Sells everything if it halves.' },
  trail: { label: 'Trailing exit', help: 'Buys half the budget at the start. Sells everything if it falls 40% before reaching +30%, or 25% off its high after that.' },
  dip: { label: 'Buy dips', help: 'Holds cash. Buys a quarter of the budget each time the coin is 25% or more off its high (up to four), and sells each piece at +30%.' },
};

/** Everything wrong with these options, for the form and for main alike. */
export function kryptoOptionProblems(o: KryptoOptions): string[] {
  if (!o.enabled) return [];
  const out: string[] = [];
  if (!KRYPTO_DRIVERS.includes(o.driver)) out.push('Pick who drives the Krypto Mode bot.');
  if (o.driver === 'strategy' && !KRYPTO_STRATEGIES.includes(o.strategy)) out.push('Pick a Krypto Mode strategy.');
  if (!Number.isFinite(o.budgetSol) || o.budgetSol < KRYPTO_MIN_BUDGET_SOL || o.budgetSol > KRYPTO_MAX_BUDGET_SOL) {
    out.push(`The Krypto Mode budget must be between ${KRYPTO_MIN_BUDGET_SOL} and ${KRYPTO_MAX_BUDGET_SOL} SOL.`);
  }
  return out;
}

/** Options from an untrusted object (IPC). Anything malformed is the default. */
export function kryptoOptionsOf(raw: unknown): KryptoOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const driver = KRYPTO_DRIVERS.includes(r.driver as KryptoDriver) ? (r.driver as KryptoDriver) : DEFAULT_KRYPTO_OPTIONS.driver;
  const strategy = KRYPTO_STRATEGIES.includes(r.strategy as KryptoStrategy) ? (r.strategy as KryptoStrategy) : DEFAULT_KRYPTO_OPTIONS.strategy;
  const budget = Number(r.budgetSol);
  return {
    enabled: r.enabled === true,
    driver,
    strategy,
    budgetSol: Number.isFinite(budget) ? budget : DEFAULT_KRYPTO_OPTIONS.budgetSol,
    live: r.live === true,
  };
}

// ─── The disclosure ────────────────────────────────────────────────────────

const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const ADDRESS_RE = new RegExp(`^${B58}$`);

/** The public line. Names the wallet in full — a shortened address is not a
 *  disclosure anyone can check. */
export function kryptoDisclosure(address: string): string {
  return `Krypto Mode: this coin has a public trading bot, wallet ${address}. It buys and sells this coin.`;
}

const DISCLOSURE_RE = new RegExp(`Krypto Mode: [^\\n]*?wallet (${B58})[^\\n]*`);
/** Longest possible line, so the form can reserve room for it. */
export const KRYPTO_DISCLOSURE_MAX = kryptoDisclosure('1'.repeat(44)).length + 1;

/**
 * The description as written with the bot declared: the user's words, the
 * disclosure on its own line, then the ordinary launch mark. Idempotent — any
 * earlier disclosure is removed first, so a re-upload never carries two (or
 * an old wallet's).
 */
export function withKryptoDisclosure(description: string, address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error('not a wallet address');
  const stamped = withWatermark(description ?? '');
  // withWatermark put the mark on the last line; split it back off.
  const cut = stamped.lastIndexOf('\n');
  const mark = cut >= 0 ? stamped.slice(cut + 1) : stamped;
  let body = cut >= 0 ? stamped.slice(0, cut) : '';
  body = body.replace(new RegExp(`\\n?${DISCLOSURE_RE.source}`, 'g'), '').trim();
  const line = kryptoDisclosure(address);
  // Over pump's limit, the USER'S words give way — never the disclosure or
  // the mark, which are the two lines this function exists to guarantee.
  const room = MAX_DESCRIPTION - line.length - mark.length - 2;
  if (body.length > room) body = body.slice(0, Math.max(0, room)).trim();
  return [body, line, mark].filter((x) => x).join('\n');
}

/** The bot wallet a description declares, or null. */
export function parseKryptoDisclosure(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  const m = DISCLOSURE_RE.exec(description);
  return m ? m[1]! : null;
}

// ─── What the bot knows, and what it may do ────────────────────────────────

export interface KryptoLot {
  /** SOL per token paid, fees included. */
  priceSol: number;
  tokens: number;
  sol: number;
  at: number;
}

export interface KryptoView {
  now: number;
  /** SOL per token now. Null = unknown, and nothing trades on an unknown. */
  priceSol: number | null;
  tokensHeld: number;
  /** SOL out on buys minus SOL back on sells, fees included. */
  netSpentSol: number;
  budgetSol: number;
  /** The strategy has made its opening move. */
  entered: boolean;
  /** Average SOL per token of the bag, or null with no bag. */
  entryPriceSol: number | null;
  /** Highest price seen since the session started. */
  peakPriceSol: number | null;
  lots: KryptoLot[];
  /** Ladder rungs already sold (their multiples). */
  rungsDone: number[];
  lastTradeAt: number | null;
  lastSide: 'buy' | 'sell' | null;
  /** Times of the trades in the last hour. */
  recentTrades: number[];
}

export type KryptoIntent =
  | { action: 'hold'; reason: string }
  | { action: 'buy'; sol: number; reason: string }
  | { action: 'sell'; pct: number; reason: string; rung?: number; lot?: number; exit?: boolean };

const HOLD = (reason: string): KryptoIntent => ({ action: 'hold', reason });

export const LADDER_RUNGS = [2, 3, 5, 10];
const OPEN_SHARE = 0.5;
const LADDER_STOP = 0.5;
const TRAIL_ARM = 1.3;
const TRAIL_STOP = 0.4;
const TRAIL_GIVEBACK = 0.25;
const DIP_LOTS = 4;
const DIP_DEPTH = 0.25;
const DIP_TAKE = 1.3;
const DIP_DEAD = 0.2;

/** What the chosen built-in strategy wants now. */
export function strategyIntent(strategy: KryptoStrategy, v: KryptoView): KryptoIntent {
  const px = v.priceSol;
  if (!px) return HOLD('price unknown');
  const room = v.budgetSol - v.netSpentSol;

  if (strategy === 'dip') {
    // Sell first: a lot that made its target.
    for (let i = 0; i < v.lots.length; i++) {
      const lot = v.lots[i]!;
      if (px >= lot.priceSol * DIP_TAKE && v.tokensHeld > 0) {
        const pct = Math.min(100, (lot.tokens / v.tokensHeld) * 100);
        return { action: 'sell', pct, reason: `piece bought at ${fmt(lot.priceSol)} is up ${pctOf(px / lot.priceSol)}`, lot: i };
      }
    }
    const peak = v.peakPriceSol;
    if (!peak) return HOLD('waiting for a high to measure dips from');
    if (px < peak * DIP_DEAD) return HOLD('down 80% or more from its high — not catching this');
    if (px > peak * (1 - DIP_DEPTH)) return HOLD('no dip');
    if (v.lots.length >= DIP_LOTS) return HOLD('all four pieces are in');
    const lowest = v.lots.reduce<number | null>((m, l) => (m === null ? l.priceSol : Math.min(m, l.priceSol)), null);
    if (lowest !== null && px > lowest * 0.85) return HOLD('not far enough below the last piece');
    const slice = v.budgetSol / DIP_LOTS;
    if (room < slice * 0.5) return HOLD('budget in use');
    return { action: 'buy', sol: Math.min(slice, room), reason: `${pctOf(1 - px / peak)} off its high` };
  }

  // ladder and trail open with half the budget.
  if (!v.entered) {
    return { action: 'buy', sol: Math.min(v.budgetSol * OPEN_SHARE, room), reason: 'opening position' };
  }
  if (v.tokensHeld <= 0 || !v.entryPriceSol) return HOLD('nothing held');
  const x = px / v.entryPriceSol;

  if (strategy === 'ladder') {
    if (x <= LADDER_STOP) return { action: 'sell', pct: 100, reason: `down ${pctOf(1 - x)} — stop`, exit: true };
    const left = LADDER_RUNGS.filter((r) => !v.rungsDone.includes(r));
    const due = left.filter((r) => x >= r);
    if (due.length === 0) return HOLD(`at ${x.toFixed(2)}x, next step ${left[0] ?? '—'}x`);
    const rung = due[due.length - 1]!;
    // Each remaining rung takes an equal share of what is left; the last takes all.
    const after = left.filter((r) => r > rung).length;
    const pct = after === 0 ? 100 : 100 / (after + 1);
    return { action: 'sell', pct, reason: `reached ${rung}x`, rung };
  }

  // trail
  const peakX = v.peakPriceSol ? v.peakPriceSol / v.entryPriceSol : x;
  if (peakX < TRAIL_ARM) {
    if (x <= 1 - TRAIL_STOP) return { action: 'sell', pct: 100, reason: `down ${pctOf(1 - x)} before the trail armed — stop`, exit: true };
    return HOLD(`at ${x.toFixed(2)}x, trail arms at ${TRAIL_ARM}x`);
  }
  const off = 1 - px / v.peakPriceSol!;
  if (off >= TRAIL_GIVEBACK) return { action: 'sell', pct: 100, reason: `${pctOf(off)} off its high — trail`, exit: true };
  return HOLD(`${pctOf(off)} off its high`);
}

// ─── The guard every driver passes through ─────────────────────────────────

export const KRYPTO_LIMITS = {
  /** Smallest buy worth the fees. */
  minBuySol: 0.005,
  /** No two trades closer than this. */
  minGapMs: 15_000,
  /** No buy this soon after a sell: buying back what was just sold is churn. */
  noRebuyMs: 60_000,
  maxTradesPerHour: 20,
};

export type KryptoCheck = { ok: true; intent: KryptoIntent } | { ok: false; reason: string };

/**
 * Whether an intent may run, and at what size. Every driver — strategy, AI
 * key, MCP — goes through this one function.
 */
export function checkKryptoIntent(intent: KryptoIntent, v: KryptoView): KryptoCheck {
  if (intent.action === 'hold') return { ok: true, intent };
  if (!v.priceSol) return { ok: false, reason: 'price unknown' };
  const recent = v.recentTrades.filter((t) => v.now - t < 3_600_000);
  if (recent.length >= KRYPTO_LIMITS.maxTradesPerHour) return { ok: false, reason: `${KRYPTO_LIMITS.maxTradesPerHour} trades in the last hour — that is the cap` };
  if (v.lastTradeAt !== null && v.now - v.lastTradeAt < KRYPTO_LIMITS.minGapMs) {
    return { ok: false, reason: 'too soon after the last trade' };
  }
  if (intent.action === 'buy') {
    if (v.lastSide === 'sell' && v.lastTradeAt !== null && v.now - v.lastTradeAt < KRYPTO_LIMITS.noRebuyMs) {
      return { ok: false, reason: 'no buying back within a minute of a sell' };
    }
    const room = v.budgetSol - v.netSpentSol;
    const sol = Math.min(intent.sol, room);
    if (!Number.isFinite(sol) || sol < KRYPTO_LIMITS.minBuySol) {
      return { ok: false, reason: room < KRYPTO_LIMITS.minBuySol ? 'the budget is in use' : `under the ${KRYPTO_LIMITS.minBuySol} SOL minimum` };
    }
    return { ok: true, intent: { ...intent, sol: round(sol, 6) } };
  }
  if (v.tokensHeld <= 0) return { ok: false, reason: 'nothing to sell' };
  const pct = Math.max(0.01, Math.min(100, intent.pct));
  if (!Number.isFinite(pct)) return { ok: false, reason: 'bad sell size' };
  return { ok: true, intent: { ...intent, pct: round(pct, 2) } };
}

// ─── Paper fills ───────────────────────────────────────────────────────────

/** A simulated sell of `pct` of the bag at `priceSol`: SOL back after costs. */
export function paperSellProceeds(tokens: number, pct: number, priceSol: number): { tokens: number; sol: number } {
  const sold = tokens * (pct / 100);
  return { tokens: sold, sol: sold * priceSol * (1 - PAPER_SIDE_COST) };
}

// ─── The AI driver ─────────────────────────────────────────────────────────

export const KRYPTO_AI_SYSTEM_PROMPT = `You manage a PUBLICLY DECLARED trading bot for a memecoin its creator launched. The bot's wallet is written in the coin's description, so everyone can see its trades.

Your job is the bot's own position: when to buy with its budget, when to take profit, when to cut a loss. It is NOT to make the chart look busy. Never trade to create volume, never buy back what you just sold, and prefer "hold" when unsure.

Reply with ONLY one JSON object:
{"action": "buy" | "sell" | "hold", "sol": number (buy only, SOL to spend), "percent": number (sell only, 1-100 of the bag), "reason": "one short sentence"}

Rules: never spend more than the remaining budget; a value you are not given is unknown, not zero; no other text.`;

/** The facts block sent to the model: public market facts + the bot's own book. */
export function kryptoFacts(v: KryptoView, market: { symbol: string; ageSec: number | null; marketCapUsd: number | null; holders: number | null; change5mPct: number | null }): string {
  const u = (n: number | null | undefined, f: (n: number) => string) => (typeof n === 'number' && Number.isFinite(n) ? f(n) : 'unknown');
  const value = v.priceSol ? v.tokensHeld * v.priceSol : null;
  return [
    `Coin: ${market.symbol || 'unknown'}`,
    `Age: ${u(market.ageSec, (n) => `${Math.round(n / 60)} min`)}`,
    `Price: ${u(v.priceSol, (n) => `${n.toExponential(3)} SOL per token`)}`,
    `High since the bot started: ${u(v.peakPriceSol, (n) => `${n.toExponential(3)} SOL`)}`,
    `Market cap: ${u(market.marketCapUsd, (n) => `$${Math.round(n)}`)}`,
    `Holders: ${u(market.holders, (n) => String(n))}`,
    `5 min price change: ${u(market.change5mPct, (n) => `${n.toFixed(1)}%`)}`,
    `Bot budget: ${v.budgetSol} SOL, of which ${round(Math.max(0, v.budgetSol - v.netSpentSol), 4)} SOL is free`,
    `Bot holds: ${v.tokensHeld > 0 ? `${Math.round(v.tokensHeld)} tokens worth ${u(value, (n) => `${n.toFixed(4)} SOL`)}, average cost ${u(v.entryPriceSol, (n) => `${n.toExponential(3)} SOL per token`)}` : 'nothing'}`,
    `Last trade: ${v.lastTradeAt ? `${v.lastSide} ${Math.round((v.now - v.lastTradeAt) / 1000)} s ago` : 'none yet'}`,
  ].join('\n');
}

/** A model reply → an intent. Null when it is not usable (treated as hold). */
export function parseKryptoIntent(raw: string): KryptoIntent | null {
  const m = /\{[\s\S]*\}/.exec(raw ?? '');
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const reason = typeof j.reason === 'string' ? j.reason.slice(0, 160) : '';
  if (j.action === 'hold') return { action: 'hold', reason: reason || 'model says hold' };
  if (j.action === 'buy') {
    const sol = Number(j.sol);
    return Number.isFinite(sol) && sol > 0 ? { action: 'buy', sol, reason: reason || 'model says buy' } : null;
  }
  if (j.action === 'sell') {
    const pct = Number(j.percent);
    return Number.isFinite(pct) && pct > 0 && pct <= 100 ? { action: 'sell', pct, reason: reason || 'model says sell' } : null;
  }
  return null;
}

// ─── A session, as main keeps it and the page shows it ─────────────────────

export type KryptoMode = 'paper' | 'live';
export type KryptoStatus = 'running' | 'paused' | 'stopped';

export interface KryptoTrade {
  at: number;
  side: 'buy' | 'sell';
  /** SOL spent (buy) or received (sell), fees included. Null if unread. */
  sol: number | null;
  /** Sell size asked for, percent of the bag. */
  pct: number | null;
  tokens: number | null;
  priceSol: number | null;
  mode: KryptoMode;
  ok: boolean;
  message: string;
  signature: string | null;
  reason: string;
  by: KryptoDriver;
}

export interface KryptoSession {
  id: string;
  mint: string;
  symbol: string;
  walletId: string;
  address: string;
  launchWalletId: string;
  metadataUri: string;
  driver: KryptoDriver;
  strategy: KryptoStrategy;
  budgetSol: number;
  mode: KryptoMode;
  status: KryptoStatus;
  createdAt: number;
  // The book, for the current mode (going live starts it fresh).
  tokensHeld: number;
  netSpentSol: number;
  entered: boolean;
  lots: KryptoLot[];
  rungsDone: number[];
  peakPriceSol: number | null;
  lastPriceSol: number | null;
  lastTradeAt: number | null;
  lastSide: 'buy' | 'sell' | null;
  recentTrades: number[];
  /** Live: lamports funded into the bot wallet, the base net spend is read against. */
  fundedLamports: number | null;
  trades: KryptoTrade[];
  note: string | null;
  lastAiAt: number | null;
  aiCalls: number[];
  /** Live: when the book was last re-read from the chain. */
  lastSyncAt?: number;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function round(n: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
}
function pctOf(f: number): string {
  return `${Math.round(f * 100)}%`;
}
function fmt(px: number): string {
  return px.toExponential(2);
}
