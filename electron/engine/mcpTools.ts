// What an MCP tool call actually does.
//
// The server (electron/system/mcpServer.ts) owns the wire; this owns the
// meaning. Split so the protocol can be tested against a socket and the
// behaviour against a fake host, and so the one interesting rule lives in one
// readable place:
//
//   EVERY TRADE GOES THROUGH THE HOST, AND THE HOST IS THE ENGINE.
//
// `buy` and `sell` below do not build anything. They validate an intent,
// check it against the user's budget, and hand it to the same engine methods
// the app's own buttons reach — which is where the fee is injected, the
// treasury pin checked, the signer's outflow policy applied and the live
// breakers consulted. An agent cannot route around any of that from here,
// because there is nothing here to route around: no transaction, no fee
// number, no endpoint, no settings.
//
// Reads are equally narrow. Each returns what a user looking at the same page
// would see, with the honesty rules intact — a number the app does not have
// comes back null and is described as unknown, never filled in.
//
// THREE CHAINS, where the app has three. Trades go through `engine.hostBuy` /
// `hostSell`, the same pair user scripts reach, which route Robinhood Chain
// and BNB onto their own rails before the Solana path — a caller on an EVM
// chain whose buy fell through to the Solana builder would spend SOL on an
// address from another chain. Four tools stay Solana because the thing behind
// them is: advanced orders, the chart's tape, the Links panel and the
// pump.fun callouts feed. Each says so in its own description rather than
// taking a `chain` it cannot honour.

import { canSpend, canTrade, checkMcpTrade, toolByName, type McpAccess, type McpBudget, type McpTradeAttempt } from '@shared/mcp';
import type { McpToolOutcome } from '../system/mcpServer';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const CHAINS = ['solana', 'robinhood', 'bnb'] as const;
type Chain = (typeof CHAINS)[number];
const LISTS = ['new', 'graduating', 'migrated'] as const;
const WINDOWS = ['day', 'week', 'month', 'all'] as const;
const INTERVALS = ['1s', '15s', '1m', '5m', '15m', '1h'] as const;
const ORDER_KINDS = ['stop_loss', 'take_profit', 'trailing_stop', 'limit_buy', 'limit_sell'] as const;
const TRIGGER_BASES = ['pct', 'price_sol', 'mcap_usd'] as const;

/** Attempts kept for the rolling caps. An hour of trading, bounded. */
const ATTEMPT_CAP = 500;

export interface McpOrderRequest {
  mint: string;
  kind: (typeof ORDER_KINDS)[number];
  triggerBasis: (typeof TRIGGER_BASES)[number];
  triggerValue: number;
  amount: number;
}

export interface McpToolsHost {
  access(): McpAccess;
  budget(): McpBudget;
  /** Active wallet, balance, and whether the APP is in paper or live. */
  walletInfo(): Promise<Record<string, unknown>>;
  /** Open positions — the paper book when this connection is in paper. */
  positions(paper: boolean, chain: Chain): Promise<unknown>;
  token(mint: string, chain: Chain): Promise<unknown>;
  discover(list: (typeof LISTS)[number], limit: number, chain: Chain): Promise<unknown>;
  /** Candles, newest last. Solana. */
  chart(mint: string, interval: (typeof INTERVALS)[number], limit: number): Promise<unknown>;
  /** Cached link facts, or null when the app has never read the token. Solana. */
  tokenLinks(mint: string): Promise<unknown>;
  /** Runner flags this session, newest first. */
  runnerAlerts(chain: Chain, limit: number): Promise<unknown>;
  /** pump.fun's public callouts feed, or null when it is not answering. */
  callouts(limit: number): Promise<unknown>;
  scoutBoard(chain: Chain, window: (typeof WINDOWS)[number], limit: number, onlyWorthALook: boolean): Promise<unknown>;
  scoutWallet(address: string, chain: Chain): Promise<unknown>;
  copyConfigs(): Promise<unknown>;
  orders(): Promise<unknown>;
  trades(limit: number): Promise<unknown>;
  buy(mint: string, amount: number, paper: boolean, chain: Chain): Promise<{ ok: boolean; message: string }>;
  sell(mint: string, percent: number, paper: boolean, chain: Chain): Promise<{ ok: boolean; message: string }>;
  placeOrder(req: McpOrderRequest, paper: boolean): Promise<{ ok: boolean; message: string }>;
  cancelOrders(mint: string): Promise<{ ok: boolean; message: string; cancelled?: number }>;
  /** The chain the Scout tools default to when a call names none. */
  defaultChain(): Chain;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

let host: McpToolsHost | null = null;
let attempts: McpTradeAttempt[] = [];

export function attach(h: McpToolsHost): void {
  host = h;
}

/**
 * Forget the rolling caps.
 *
 * Called when the access level changes: a level change is a new arrangement,
 * and carrying an hour of spending across it would let a switch to live
 * inherit an hour of paper "spending" that never cost anything — or, worse,
 * a switch from live to paper and back reset nothing while the user believed
 * it had.
 */
export function resetBudget(): void {
  attempts = [];
}

/** Test seam. */
export function _reset(): void {
  host = null;
  attempts = [];
}

/** What the caps have seen. For the panel and the test. */
export function recentAttempts(): readonly McpTradeAttempt[] {
  return attempts;
}

function note(kind: 'buy' | 'sell', sol: number, now: number): void {
  attempts.push({ at: now, kind, sol });
  if (attempts.length > ATTEMPT_CAP) attempts = attempts.slice(-ATTEMPT_CAP);
}

const fail = (text: string): McpToolOutcome => ({ ok: false, text });
const done = (text: string, data?: unknown): McpToolOutcome => ({ ok: true, text, data });

// ── Argument reading ──────────────────────────────────────────────────
//
// Every reader refuses rather than coerces. An agent that sends a string
// where a number belongs has made a mistake it can fix, and being told is
// more useful than trading on `Number('0.1abc')`.

function readMint(args: Record<string, unknown>, chain: Chain): { ok: true; mint: string } | { ok: false; why: string } {
  const v = args.mint;
  if (typeof v !== 'string' || !v.trim()) return { ok: false, why: 'mint is required' };
  const mint = v.trim();
  if (chain === 'solana') {
    if (!BASE58.test(mint)) return { ok: false, why: `"${mint.slice(0, 12)}…" is not a Solana mint address` };
    return { ok: true, mint };
  }
  // EVM addresses are case-insensitive and the app keys them lower-cased.
  if (!EVM.test(mint)) return { ok: false, why: `"${mint.slice(0, 12)}…" is not a contract address on ${chainLabel(chain)}` };
  return { ok: true, mint: mint.toLowerCase() };
}

function readChain(args: Record<string, unknown>, fallback: Chain): { ok: true; chain: Chain } | { ok: false; why: string } {
  const v = args.chain;
  if (v === undefined || v === null) return { ok: true, chain: fallback };
  if (typeof v === 'string' && (CHAINS as readonly string[]).includes(v)) return { ok: true, chain: v as Chain };
  return { ok: false, why: `chain must be one of ${CHAINS.join(', ')}` };
}

function readNumber(
  args: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; required?: boolean; dflt?: number },
): { ok: true; value: number } | { ok: false; why: string } {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts.required) return { ok: false, why: `${key} is required` };
    return { ok: true, value: opts.dflt ?? 0 };
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, why: `${key} must be a number` };
  if (opts.min !== undefined && v < opts.min) return { ok: false, why: `${key} must be at least ${opts.min}` };
  if (opts.max !== undefined && v > opts.max) return { ok: false, why: `${key} must be at most ${opts.max}` };
  return { ok: true, value: v };
}

function readEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  dflt: T | null,
): { ok: true; value: T } | { ok: false; why: string } {
  const v = args[key];
  if (v === undefined || v === null) {
    if (dflt === null) return { ok: false, why: `${key} is required and must be one of ${allowed.join(', ')}` };
    return { ok: true, value: dflt };
  }
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return { ok: true, value: v as T };
  return { ok: false, why: `${key} must be one of ${allowed.join(', ')}` };
}

/**
 * Unknown argument names are refused, not ignored.
 *
 * The schemas say `additionalProperties: false`; that is a claim about what
 * we accept, and this is the check behind it. An agent that misspells a field
 * should be told rather than quietly given a default, and a field nobody
 * agreed to read must never reach a trade.
 */
function unexpected(name: string, args: Record<string, unknown>): string | null {
  const spec = toolByName(name);
  if (!spec) return null;
  const known = Object.keys(spec.inputSchema.properties);
  const extra = Object.keys(args).filter((k) => !known.includes(k));
  if (!extra.length) return null;
  return `${name} does not take ${extra.join(', ')}. It takes: ${known.join(', ') || 'no arguments'}.`;
}

// ── The tools ─────────────────────────────────────────────────────────

export async function call(name: string, args: Record<string, unknown>): Promise<McpToolOutcome> {
  const h = host;
  if (!h) return fail('The app is not ready.');
  const access = h.access();
  // The tier check comes FIRST, before the arguments are even looked at: a
  // read-only connection should not learn a trade tool's schema from the
  // refusal it gets for misspelling one of its fields.
  const spec = toolByName(name);
  if (spec && spec.tier === 'trade' && !canTrade(access)) return fail('This connection is read only. Trading is switched off in the app under Settings → AI connection.');
  const extra = unexpected(name, args);
  if (extra) return fail(extra);
  /** This connection's mode. Live access spends; everything else simulates. */
  const paper = !canSpend(access);
  // Every tool that takes one reads it the same way, and a tool whose schema
  // has no `chain` never sees the argument at all — `unexpected` above has
  // already refused it.
  const chainR = readChain(args, h.defaultChain());
  if (!chainR.ok) return fail(chainR.why);
  const chain = chainR.chain;

  switch (name) {
    case 'get_wallet': {
      const info = await h.walletInfo();
      // Three states, not two: a read-only connection is not "paper mode",
      // it cannot trade at all, and telling an agent it is in paper would
      // invite it to try.
      const mode = !canTrade(access) ? 'read-only' : paper ? 'paper' : 'live';
      const said =
        mode === 'read-only'
          ? 'This connection is READ ONLY — you cannot trade from it at all. The user can change that in the app under Settings → AI connection.'
          : mode === 'paper'
            ? 'This connection is in PAPER mode — trades are simulated into a paper record and nothing is bought. Say so when you report a trade.'
            : 'This connection is in LIVE mode — trades spend real funds. Say so when you report a trade.';
      return done(said, { ...info, mode, access });
    }
    case 'get_positions':
      return done(
        `Open ${paper ? 'paper ' : ''}positions on ${chainLabel(chain)}. A null value is one the app cannot price right now, not zero.`,
        await h.positions(paper, chain),
      );
    case 'get_token': {
      const m = readMint(args, chain);
      if (!m.ok) return fail(m.why);
      const t = await h.token(m.mint, chain);
      if (!t) return fail('The app could not read that token. It may not exist, or no provider answered.');
      return done(
        'What the app knows about this token. Null fields are unknown, not zero, and the security checks report what was verifiable — not a view on whether it will go up.',
        t,
      );
    }
    case 'find_tokens': {
      const list = readEnum(args, 'list', LISTS, null);
      if (!list.ok) return fail(list.why);
      const limit = readNumber(args, 'limit', { min: 1, max: 50, dflt: 20 });
      if (!limit.ok) return fail(limit.why);
      return done(
        `The ${list.value} list on ${chainLabel(chain)}, as the app's Discover page shows it. This is what the app is watching, not a recommendation.`,
        await h.discover(list.value, Math.round(limit.value), chain),
      );
    }
    case 'get_chart': {
      const m = readMint(args, 'solana');
      if (!m.ok) return fail(m.why);
      const interval = readEnum(args, 'interval', INTERVALS, '1m');
      if (!interval.ok) return fail(interval.why);
      const limit = readNumber(args, 'limit', { min: 10, max: 500, dflt: 120 });
      if (!limit.ok) return fail(limit.why);
      const bars = await h.chart(m.mint, interval.value, Math.round(limit.value));
      if (!bars || (Array.isArray(bars) && bars.length === 0)) return fail('No price history for that token yet. The app builds candles from what it has seen and from its providers; a brand new coin may have none.');
      return done(`${interval.value} candles, oldest first. Prices are in SOL.`, bars);
    }
    case 'get_token_links': {
      const m = readMint(args, 'solana');
      if (!m.ok) return fail(m.why);
      const links = await h.tokenLinks(m.mint);
      if (!links) return fail('The app has no cached facts for that token. Look it up with get_token first, which is what fills them in.');
      return done(
        'Where this token points, and what the app has already read. A null is something nobody has looked at yet — the app never visits a link on its own, so absence here is not evidence of anything.',
        links,
      );
    }
    case 'get_runner_alerts': {
      const limit = readNumber(args, 'limit', { min: 1, max: 50, dflt: 20 });
      if (!limit.ok) return fail(limit.why);
      const rows = await h.runnerAlerts(chain, Math.round(limit.value));
      return done(
        `Potential runners flagged on ${chainLabel(chain)} this session. A flag says the early buying matched a bucket that graduated more often on a measured day — most flagged launches still do not graduate, and nothing was bought.`,
        rows,
      );
    }
    case 'get_callouts': {
      const limit = readNumber(args, 'limit', { min: 1, max: 50, dflt: 20 });
      if (!limit.ok) return fail(limit.why);
      const rows = await h.callouts(Math.round(limit.value));
      if (!rows) return fail('pump.fun’s callouts feed is not answering right now.');
      return done('pump.fun’s public callouts feed, newest first. Each caller’s position is what THEY report about themselves, not something this app verified.', rows);
    }
    case 'get_wallet_scores': {
      const win = readEnum(args, 'window', WINDOWS, 'week');
      if (!win.ok) return fail(win.why);
      const limit = readNumber(args, 'limit', { min: 1, max: 50, dflt: 20 });
      if (!limit.ok) return fail(limit.why);
      const rows = await h.scoutBoard(chain, win.value, Math.round(limit.value), args.onlyWorthALook === true);
      return done(
        'Wallets ranked by Copy score — what a FOLLOWER would have realised mirroring them, not what they made themselves. Measured across 9.3 million trades, no group of wallets was profitable to copy, so this ranks least-bad to follow and is not an edge.',
        rows,
      );
    }
    case 'get_wallet_record': {
      const a = args.address;
      if (typeof a !== 'string' || !a.trim()) return fail('address is required');
      const address = a.trim();
      const shapeOk = chain === 'solana' ? BASE58.test(address) : EVM.test(address);
      if (!shapeOk) return fail(`"${address.slice(0, 12)}…" is not an address on ${chainLabel(chain)}`);
      const rec = await h.scoutWallet(chain === 'solana' ? address : address.toLowerCase(), chain);
      if (!rec) {
        return fail(
          'The app has no record for that wallet. Records are built from trades the app has seen — open the Wallet Scout in the app, paste the address and press "Read from the chain" to fill one in.',
        );
      }
      return done('This wallet’s record, and what a copier would have realised on its recent trips. Past results, not a forecast.', rec);
    }
    case 'get_copy_configs':
      return done(
        'Copy trading setup and how each config is doing. Read only — arming one starts unattended spending and stays something the user does in the app.',
        await h.copyConfigs(),
      );
    case 'get_orders':
      return done('Advanced orders waiting to fire.', await h.orders());
    case 'get_trade_history': {
      const limit = readNumber(args, 'limit', { min: 1, max: 100, dflt: 25 });
      if (!limit.ok) return fail(limit.why);
      return done(
        'Fills this install has made, newest first. The cost basis is the on-chain amount, so these figures already include fees, tips and slippage.',
        await h.trades(Math.round(limit.value)),
      );
    }

    // ── Trades ─────────────────────────────────────────────────────
    case 'buy_token': {
      if (!canTrade(access)) return fail('This connection is read only.');
      const m = readMint(args, chain);
      if (!m.ok) return fail(m.why);
      const amt = readNumber(args, 'amount', { required: true, min: 0 });
      if (!amt.ok) return fail(amt.why);
      const now = Date.now();
      const gate = checkMcpTrade({ kind: 'buy', amount: amt.value }, access, h.budget(), attempts, now);
      if (!gate.ok) return fail(gate.reason);
      // Recorded BEFORE the call, so two calls in flight cannot both read a
      // budget neither has spent yet — the reservation rule copy trading
      // learned the hard way (docs/copy-trade-audit-2026-09-13.md).
      note('buy', amt.value, now);
      const r = await h.buy(m.mint, amt.value, paper, chain);
      h.log(r.ok ? 'info' : 'warn', `MCP ${paper ? 'paper ' : ''}buy ${amt.value} of ${m.mint.slice(0, 8)}… on ${chainLabel(chain)}: ${r.message}`);
      return r.ok ? done(`${paper ? 'Paper buy' : 'Buy'} placed. ${r.message}`) : fail(`The ${paper ? 'paper ' : ''}buy was not placed. ${r.message}`);
    }
    case 'sell_token': {
      if (!canTrade(access)) return fail('This connection is read only.');
      const m = readMint(args, chain);
      if (!m.ok) return fail(m.why);
      const pct = readNumber(args, 'percent', { required: true, min: 1, max: 100 });
      if (!pct.ok) return fail(pct.why);
      const now = Date.now();
      const gate = checkMcpTrade({ kind: 'sell', amount: pct.value }, access, h.budget(), attempts, now);
      if (!gate.ok) return fail(gate.reason);
      note('sell', 0, now);
      const r = await h.sell(m.mint, pct.value, paper, chain);
      h.log(r.ok ? 'info' : 'warn', `MCP ${paper ? 'paper ' : ''}sell ${pct.value}% of ${m.mint.slice(0, 8)}… on ${chainLabel(chain)}: ${r.message}`);
      return r.ok ? done(`${paper ? 'Paper sell' : 'Sell'} placed. ${r.message}`) : fail(`The ${paper ? 'paper ' : ''}sell was not placed. ${r.message}`);
    }
    case 'place_order': {
      if (!canTrade(access)) return fail('This connection is read only.');
      // Advanced orders are Solana-only in this app, so the schema takes no
      // chain and the address is read as a Solana one whatever the app is on.
      const m = readMint(args, 'solana');
      if (!m.ok) return fail(m.why);
      const kind = readEnum(args, 'kind', ORDER_KINDS, null);
      if (!kind.ok) return fail(kind.why);
      const basis = readEnum(args, 'triggerBasis', TRIGGER_BASES, null);
      if (!basis.ok) return fail(basis.why);
      // A limit order is a LEVEL, and a percent is not one. Reading it as a
      // market cap armed a limit buy at $20 and reported success — the trap
      // the scripting surface hit first.
      if (basis.value === 'pct' && (kind.value === 'limit_buy' || kind.value === 'limit_sell')) {
        return fail(`${kind.value} needs an absolute level — triggerBasis must be price_sol or mcap_usd.`);
      }
      const value = readNumber(args, 'triggerValue', { required: true });
      if (!value.ok) return fail(value.why);
      const amount = readNumber(args, 'amount', { required: true, min: 0 });
      if (!amount.ok) return fail(amount.why);
      // A limit BUY commits funds when it fires, so it meets the same caps a
      // buy does. The sell kinds are exits and are never value-capped — but
      // arming ANY order still counts against the per-minute rate limit, or a
      // live agent could arm unlimited stop_loss/take_profit/limit_sell orders
      // in a burst (only limit_buy was throttled before — audit 2026-09-23).
      {
        const now = Date.now();
        const isBuy = kind.value === 'limit_buy';
        const gate = checkMcpTrade({ kind: isBuy ? 'buy' : 'sell', amount: amount.value }, access, h.budget(), attempts, now);
        if (!gate.ok) return fail(gate.reason);
        note(isBuy ? 'buy' : 'sell', amount.value, now);
      }
      const r = await h.placeOrder({ mint: m.mint, kind: kind.value, triggerBasis: basis.value, triggerValue: value.value, amount: amount.value }, paper);
      h.log(r.ok ? 'info' : 'warn', `MCP order ${kind.value} on ${m.mint.slice(0, 8)}…: ${r.message}`);
      return r.ok ? done(r.message) : fail(r.message);
    }
    case 'cancel_orders': {
      if (!canTrade(access)) return fail('This connection is read only.');
      const m = readMint(args, 'solana');
      if (!m.ok) return fail(m.why);
      const r = await h.cancelOrders(m.mint);
      return r.ok ? done(r.message, { cancelled: r.cancelled ?? 0 }) : fail(r.message);
    }
    default:
      return fail(`No such tool: ${name}`);
  }
}

const chainLabel = (c: Chain): string => (c === 'solana' ? 'Solana' : c === 'bnb' ? 'BNB Smart Chain' : 'Robinhood Chain');
