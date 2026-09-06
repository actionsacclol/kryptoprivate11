// Advanced orders — the evaluation and execution engine for term.txt §2.
//
// ─── The safety model, because this signs real transactions ───────────
//
// 1. NOTHING HERE DECIDES TO TRADE. Every order is an instruction the user
//    wrote on a token they were looking at. This module only notices that a
//    condition the user named has become true. That is what separates it
//    from the autonomous strategy firing removed on 2026-08-16.
//
// 2. EXACTLY ONCE. An order leaves `armed` exactly one time, and the state
//    transition is written to disk BEFORE the transaction is built. A crash
//    mid-flight leaves a `triggered` order that never re-fires — the user
//    reconciles it. The failure mode is "did not sell", never "sold twice".
//
// 3. PAUSED AFTER RESTART. Persisted orders come back `paused`, not `armed`.
//    Both directions here are dangerous: silently forgetting a stop loss
//    leaves the user unprotected, and silently resuming one lets an app that
//    was closed for a week fire into a market it never watched. So the
//    orders survive, the UI shows a loud banner, and one click resumes them.
//    This mirrors the engine's own auto-disarm-on-restart invariant.
//
// 4. GATED ON THE SAME SWITCHES AS MANUAL TRADING. liveEnabled, armed, a
//    funded wallet and the per-trade cap. An order whose amount exceeds
//    `maxLiveSol` fails loudly instead of being silently clamped.
//
// 5. NO SILENT RETRY. A failed order goes to `failed` with the reason. It is
//    not retried, because a retry against an unknown post-broadcast state is
//    how you double-spend.

import fs from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_STATES,
  describeOrder,
  isBuyKind,
  isConditional,
  isPctKind,
  validateOrder,
  type AdvOrder,
  type NewOrderRequest,
  type OrderState,
} from '@shared/orders';
import * as recorder from './recorder';

const FILE = 'adv-orders.json';
const MAX_ORDERS = 200;

let orders: AdvOrder[] = [];
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;

/** Injected by the engine so this module never imports it (cycle). */
export interface OrderHost {
  /** Fire a real buy. Returns the signature on success. `pending` = it was
   *  broadcast and is unconfirmed but NOT provably dead: it may still land. */
  buy(mint: string, sol: number): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean }>;
  /** Fire a real sell of `percent` of the position. */
  sell(mint: string, percent: number): Promise<{ ok: boolean; message: string; signature?: string; pending?: boolean }>;
  /** Why NO order can execute right now, or null if they can. */
  blockedReason(): string | null;
  /**
   * Why a BUY specifically cannot execute — the circuit breakers that pause
   * new entries. Deliberately not applied to sells: a breaker that stops
   * someone closing a position turns a stop loss into a trap.
   */
  buyBlockedReason(): string | null;
  /** Per-trade SOL cap from execution settings. */
  maxLiveSol(): number;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void;
  /** Notify the renderer that the order list changed. */
  changed(): void;
}

let host: OrderHost | null = null;

export function attach(h: OrderHost): void {
  host = h;
}

// ── Persistence ───────────────────────────────────────────────────────

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version: 1; orders: AdvOrder[] };
    const loaded = Array.isArray(raw?.orders) ? raw.orders : [];
    // Anything that was live when we shut down comes back PAUSED. See §3.
    orders = loaded.map((o) => ({
      ...o,
      state: o.state === 'armed' || o.state === 'triggered' ? ('paused' as OrderState) : o.state,
      note:
        o.state === 'armed'
          ? 'Paused when the app restarted — review and resume.'
          : o.state === 'triggered'
            ? 'The app closed while this order was executing. Check your wallet before resuming.'
            : o.note,
    }));
  } catch {
    orders = [];
  }
}

function persist(): void {
  if (!filePath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, orders }, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {
      /* memory state stays authoritative for this session */
    }
  }, 200);
}

/** Write synchronously. Used before signing, where a crash must not lose the
 *  state transition that makes the order exactly-once. */
function persistNow(): void {
  if (!filePath) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, orders }, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* best effort */
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────

export function all(): AdvOrder[] {
  return orders.map((o) => ({ ...o }));
}

export function pausedCount(): number {
  return orders.filter((o) => o.state === 'paused').length;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `ord_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function create(
  req: NewOrderRequest,
  ctx: { referencePriceSol: number | null },
): { ok: boolean; message: string; order?: AdvOrder } {
  const v = validateOrder(req);
  if (!v.ok) return { ok: false, message: v.message };
  if (orders.length >= MAX_ORDERS) {
    return { ok: false, message: `Order limit reached (${MAX_ORDERS}). Cancel some first.` };
  }
  // A percentage order with nothing to measure against would sit armed
  // forever and never fire — which reads as protection the user does not
  // actually have. Refuse it at creation instead.
  if (isPctKind(req.kind) && ctx.referencePriceSol === null) {
    return {
      ok: false,
      message: 'No reference price available for this token, so a percentage order cannot be anchored.',
    };
  }
  if (isBuyKind(req.kind) && host && req.amount > host.maxLiveSol()) {
    return { ok: false, message: `Amount exceeds your per-trade cap of ${host.maxLiveSol()} SOL.` };
  }

  const now = Date.now();
  const order: AdvOrder = {
    id: nextId(),
    mint: req.mint,
    symbol: req.symbol,
    kind: req.kind,
    state: 'armed',
    triggerValue: req.triggerValue,
    triggerBasis: req.triggerBasis,
    amount: req.amount,
    referencePriceSol: ctx.referencePriceSol,
    peakPriceSol: req.kind === 'trailing_stop' ? ctx.referencePriceSol : null,
    createdAt: now,
    updatedAt: now,
    triggeredAt: null,
    note: null,
    signature: null,
    expiresAt: req.expiresAt ?? null,
  };
  orders.unshift(order);
  persist();
  recorder.record('order_create', { id: order.id, mint: order.mint, kind: order.kind, trigger: order.triggerValue, basis: order.triggerBasis, amount: order.amount });
  host?.log('info', `order created: ${describeOrder(order)} on ${order.symbol || order.mint.slice(0, 8)}`);
  host?.changed();
  return { ok: true, message: describeOrder(order), order: { ...order } };
}

export function cancel(id: string): { ok: boolean; message: string } {
  const o = orders.find((x) => x.id === id);
  if (!o) return { ok: false, message: 'Order not found' };
  if (!ACTIVE_STATES.includes(o.state)) return { ok: false, message: `Order is already ${o.state}` };
  o.state = 'cancelled';
  o.note = 'Cancelled by you.';
  o.updatedAt = Date.now();
  persist();
  recorder.record('order_cancel', { id: o.id, mint: o.mint, kind: o.kind });
  host?.changed();
  return { ok: true, message: 'Order cancelled' };
}

/** Clear terminal orders out of the list. */
export function clearCompleted(): number {
  const before = orders.length;
  orders = orders.filter((o) => ACTIVE_STATES.includes(o.state) || o.state === 'triggered');
  persist();
  host?.changed();
  return before - orders.length;
}

/** Re-arm everything that came back paused after a restart. */
export function resumePaused(): { ok: boolean; message: string; resumed: number } {
  const paused = orders.filter((o) => o.state === 'paused');
  if (!paused.length) return { ok: true, message: 'Nothing to resume', resumed: 0 };
  for (const o of paused) {
    // A `triggered` order that got paused was mid-flight when the app died.
    // Resuming it would re-send a transaction that may already have landed,
    // so those are NOT re-armed — they need a human to check the wallet.
    if (o.note?.startsWith('The app closed while this order was executing')) continue;
    o.state = 'armed';
    o.note = 'Resumed.';
    o.updatedAt = Date.now();
    // A trailing stop's peak is meaningless across a gap in observation:
    // whatever happened while the app was closed was not seen, so the peak
    // restarts from the current reference rather than a stale high.
    if (o.kind === 'trailing_stop') o.peakPriceSol = o.referencePriceSol;
  }
  const resumed = orders.filter((o) => o.state === 'armed').length;
  persistNow();
  host?.changed();
  return { ok: true, message: `Resumed ${resumed} order${resumed === 1 ? '' : 's'}`, resumed };
}

// ── Evaluation ────────────────────────────────────────────────────────

export interface MarketTick {
  mint: string;
  /** SOL per token. */
  priceSol: number;
  /** USD market cap, when derivable. Null skips market-cap triggers. */
  mcapUsd: number | null;
  /** True on the tick where the creator sold. */
  creatorSold?: boolean;
  /** True on the tick where the curve completed / the token migrated. */
  migrated?: boolean;
}

/** Does this order's condition hold on this tick? */
function shouldTrigger(o: AdvOrder, t: MarketTick): boolean {
  switch (o.kind) {
    case 'sell_on_dev_sell':
      return t.creatorSold === true;
    case 'sell_on_migration':
    case 'buy_on_migration':
      return t.migrated === true;

    case 'limit_buy':
    case 'limit_sell': {
      if (o.triggerValue === null) return false;
      const value = o.triggerBasis === 'mcap_usd' ? t.mcapUsd : t.priceSol;
      // A market-cap trigger with no market cap must NOT fire. Falling back
      // to the SOL price would compare a number against the wrong scale and
      // fire instantly.
      if (value === null || !Number.isFinite(value)) return false;
      return o.kind === 'limit_buy' ? value <= o.triggerValue : value >= o.triggerValue;
    }

    case 'take_profit': {
      if (o.referencePriceSol === null || o.triggerValue === null) return false;
      return t.priceSol >= o.referencePriceSol * (1 + o.triggerValue / 100);
    }
    case 'stop_loss': {
      if (o.referencePriceSol === null || o.triggerValue === null) return false;
      return t.priceSol <= o.referencePriceSol * (1 - Math.abs(o.triggerValue) / 100);
    }
    case 'trailing_stop': {
      if (o.peakPriceSol === null || o.triggerValue === null) return false;
      return t.priceSol <= o.peakPriceSol * (1 - Math.abs(o.triggerValue) / 100);
    }
  }
}

const inFlight = new Set<string>();

/**
 * Feed a price observation in. Called from the engine's trade handler for
 * taped mints, and from a slower poll for everything else.
 *
 * Synchronous up to the point of firing so that the armed → triggered
 * transition cannot interleave with another tick for the same order.
 */
export function onTick(t: MarketTick): void {
  // A tick carrying an observed EVENT is meaningful even with no usable
  // price — a token migrating out of the tracker has no spot price left,
  // and dropping the tick would silently strand every migration order.
  // Price-based kinds still need a real price and are skipped below.
  const hasEvent = t.creatorSold === true || t.migrated === true;
  const priceOk = Number.isFinite(t.priceSol) && t.priceSol > 0;
  if (!priceOk && !hasEvent) return;
  const now = Date.now();
  let dirty = false;

  for (const o of orders) {
    if (o.mint !== t.mint || o.state !== 'armed') continue;

    if (o.expiresAt !== null && now >= o.expiresAt) {
      o.state = 'expired';
      o.note = 'Expired before its condition was met.';
      o.updatedAt = now;
      dirty = true;
      continue;
    }

    // Price-based kinds cannot be judged without a price.
    if (!priceOk && !isConditional(o.kind)) continue;

    // Track the high-water mark before testing, so a tick that makes a new
    // peak can never also trigger the stop on that same tick.
    if (o.kind === 'trailing_stop') {
      if (o.peakPriceSol === null || t.priceSol > o.peakPriceSol) {
        o.peakPriceSol = t.priceSol;
        o.updatedAt = now;
        dirty = true;
        continue;
      }
    }

    if (!shouldTrigger(o, t)) continue;
    if (inFlight.has(o.id)) continue;

    // ── Blocked execution does NOT consume the order ───────────────────
    //
    // If the condition is met but we cannot trade (live execution off,
    // engine disarmed, no wallet), the wrong move is to burn the order and
    // mark it failed: a stop loss that "already fired" while disarmed is
    // protection the user no longer has and does not know they lost. So the
    // order stays armed and we say so, loudly, once per minute. It will
    // fire the moment execution is possible — which may be at a much worse
    // price, and that is exactly what the warning is for.
    const blocked = host?.blockedReason() ?? null;
    if (blocked) {
      const since = o.blockedSince ?? now;
      o.blockedSince = since;
      const shouldWarn = !o.lastBlockedWarnAt || now - o.lastBlockedWarnAt > 60_000;
      if (shouldWarn) {
        o.lastBlockedWarnAt = now;
        o.note = `Condition met but NOT executed — ${blocked}. Still armed.`;
        o.updatedAt = now;
        dirty = true;
        host?.log('warn', `order condition met but blocked: ${describeOrder(o)} — ${blocked}`);
        host?.toast('warn', `${o.symbol || 'Order'}: ${describeOrder(o)} — condition met but ${blocked}`);
        recorder.record('order_blocked', { id: o.id, mint: o.mint, kind: o.kind, reason: blocked });
      }
      continue;
    }
    o.blockedSince = null;

    // ── The exactly-once boundary ──────────────────────────────────────
    // State moves to `triggered` and is flushed to disk BEFORE anything is
    // built or signed. Everything after this point is allowed to fail; what
    // is not allowed is for this order to be evaluated as `armed` again.
    inFlight.add(o.id);
    o.state = 'triggered';
    o.triggeredAt = now;
    o.updatedAt = now;
    o.note = 'Condition met — executing.';
    persistNow();
    dirty = true;

    recorder.record('order_trigger', {
      id: o.id, mint: o.mint, kind: o.kind, priceSol: t.priceSol, mcapUsd: t.mcapUsd,
      trigger: o.triggerValue, basis: o.triggerBasis,
    });

    void execute(o);
  }

  if (dirty) {
    persist();
    host?.changed();
  }
}

async function execute(o: AdvOrder): Promise<void> {
  const h = host;
  if (!h) return;
  try {
    // The global block was checked before the order was consumed; re-check
    // in case it changed in the microtask gap, and put the order BACK to
    // armed rather than failing it — same reasoning as in onTick.
    const blocked = h.blockedReason();
    if (blocked) {
      o.state = 'armed';
      o.triggeredAt = null;
      o.note = `Condition met but NOT executed — ${blocked}. Still armed.`;
      o.updatedAt = Date.now();
      persistNow();
      h.changed();
      return;
    }
    if (isBuyKind(o.kind)) {
      const buyBlocked = h.buyBlockedReason();
      if (buyBlocked) {
        finish(o, 'failed', `Buy not executed — ${buyBlocked}`, null);
        h.toast('warn', `${o.symbol || 'Order'}: buy blocked — ${buyBlocked}`);
        return;
      }
    }
    if (isBuyKind(o.kind) && o.amount > h.maxLiveSol()) {
      finish(o, 'failed', `Amount ${o.amount} SOL is over your per-trade cap of ${h.maxLiveSol()} SOL.`, null);
      return;
    }

    h.log('info', `order firing: ${describeOrder(o)} on ${o.symbol || o.mint.slice(0, 8)}`);
    const res = isBuyKind(o.kind)
      ? await h.buy(o.mint, o.amount)
      : await h.sell(o.mint, o.amount);

    if (res.ok) {
      finish(o, 'filled', res.message, res.signature ?? null);
      h.toast('success', `${o.symbol || 'Order'} filled: ${describeOrder(o)}`);
    } else if (res.pending && res.signature) {
      // Broadcast but unconfirmed, and not provably dead. NOT a failure: the
      // tx may land, and the ledger is watching the signature. The order stays
      // `triggered` (terminal for firing — it can never fire again) with the
      // signature on it, rather than claiming a fill or a failure it has no
      // evidence for.
      finish(o, 'triggered', `Broadcast, awaiting confirmation — ${res.message}`, res.signature);
      h.toast('warn', `${o.symbol || 'Order'} sent, unconfirmed — may still land`);
    } else {
      // Deliberately NOT retried. See the header, §5.
      finish(o, 'failed', res.message, res.signature ?? null);
      h.toast('error', `${o.symbol || 'Order'} failed: ${res.message}`);
    }
  } catch (err) {
    finish(o, 'failed', (err as Error)?.message ?? 'unknown error', null);
  } finally {
    inFlight.delete(o.id);
  }
}

function finish(o: AdvOrder, state: OrderState, note: string, signature: string | null): void {
  o.state = state;
  o.note = note;
  o.signature = signature;
  o.updatedAt = Date.now();
  persistNow();
  recorder.record('order_result', { id: o.id, mint: o.mint, kind: o.kind, state, signature, note: note.slice(0, 200) });
  host?.log(state === 'filled' ? 'info' : 'warn', `order ${state}: ${o.id} — ${note}`);
  host?.changed();
}

/** Mints with at least one armed order — the poller's work list. */
export function armedMints(): string[] {
  return [...new Set(orders.filter((o) => o.state === 'armed').map((o) => o.mint))];
}

/** Test seam. */
export function _reset(): void {
  orders = [];
  filePath = '';
  inFlight.clear();
}

export function _load(list: AdvOrder[]): void {
  orders = list;
}
