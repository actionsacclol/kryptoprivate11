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
//
// 6. ONE SELL PER POSITION AT A TIME. §2 makes each ORDER fire once; that is
//    not enough, because several orders can name the same mint (the shipped
//    "Runner" template arms five). Every sell is sized as a share of the token
//    balance READ AT BUILD TIME, so two that overlap both size off the same
//    undiminished bag: a 40% + 50% ladder sells 90% of the whole position
//    instead of 40% and then 50% of what is left. So a mint with a sell in
//    flight holds its other sell orders ARMED — they take the next tick, and
//    size against the balance the first one actually left behind.
//
// 7. AN ORDER BELONGS TO THE WALLET IT WAS WRITTEN ON. "Sell 100%" means the
//    position the user was looking at. Switching the active signer must not
//    silently repoint an order at a different bag, so an order whose owner is
//    not the current signer pauses instead of firing.

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
import { mentionsRateLimit } from '@shared/rpcErrors';

const FILE = 'adv-orders.json';
const MAX_ORDERS = 200;

let orders: AdvOrder[] = [];
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Why the saved orders could not be read, or null. `init` runs before the
 *  engine exists, so the toast inside `failClosed` reaches nobody — this is
 *  what the startup dialog reads. Same shape as ledger's. */
let loadFailure: string | null = null;

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
  /** Public key of the wallet that would sign right now, or null if none.
   *  Orders are stamped with it and refuse to fire for a different one. */
  owner?(): string | null;
  /**
   * Raw token units of `mint` the signing wallet still holds, or null when it
   * could not be read.
   *
   * Null means UNKNOWN and must never stop a sell — see the pre-flight check
   * in `execute`. Only a confirmed zero does anything.
   */
  heldTokensRaw?(mint: string): Promise<bigint | null>;
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
  loadFailure = null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // No file is a first run — start empty and stay writable.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      orders = [];
      return;
    }
    // Anything else means the file EXISTS and we could not read it. Treating
    // that as "no orders" would let the next write destroy a user's stop
    // losses, so this session serves nothing and refuses to persist.
    failClosed(`could not be read (${(err as Error)?.message ?? 'unknown error'})`);
    return;
  }
  try {
    const raw = JSON.parse(text) as { version: 1; orders: AdvOrder[] };
    const loaded = Array.isArray(raw?.orders) ? raw.orders : [];
    // Anything that was live when we shut down comes back PAUSED. See §3.
    orders = loaded.map((o) => ({
      ...o,
      // Orders written before owners existed have an unknown wallet. §7 makes
      // those pause rather than fire, so null is the fail-closed value.
      owner: o.owner ?? null,
      state: o.state === 'armed' || o.state === 'triggered' ? ('paused' as OrderState) : o.state,
      note:
        o.state === 'armed'
          ? 'Paused when the app restarted — review and resume.'
          : o.state === 'triggered'
            ? 'The app closed while this order was executing. Check your wallet before resuming.'
            : o.note,
    }));
  } catch (err) {
    failClosed(`is not readable JSON (${(err as Error)?.message ?? 'parse error'})`);
  }
}

/** The file exists but we cannot use it: set it aside, serve nothing, and
 *  make every write a no-op so the damaged copy survives for inspection. */
function failClosed(why: string): void {
  const bad = filePath;
  orders = [];
  filePath = '';
  loadFailure = `${bad} ${why}`;
  try {
    fs.renameSync(bad, `${bad}.corrupt-${Date.now()}`);
  } catch {
    /* if it cannot even be renamed, blanking filePath already protects it */
  }
  host?.log('error', `orders file ${why} — set aside, not overwritten`);
  host?.toast('error', 'Your saved orders could not be read. They have been set aside, not overwritten — no orders are armed.');
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

/** Flush a pending debounced write NOW. Called on quit: `cancel` and `create`
 *  use the 200 ms debounce, so closing the app inside that window would lose
 *  the change and bring a cancelled order back as `paused`. */
export function flushSync(): void {
  if (!filePath || !saveTimer) return;
  persistNow();
}

// ── CRUD ──────────────────────────────────────────────────────────────

/** Why the saved orders could not be read, or null. Nothing is persisted
 *  while this is set, and no order is armed. */
export function failure(): string | null {
  return loadFailure;
}

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
    owner: host?.owner?.() ?? null,
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
  // A `triggered` order that never reported a result and is not currently
  // executing is stranded: nothing will ever move it, but it still counts
  // against MAX_ORDERS and still shows as Active. Let the user clear it.
  // One that IS in flight stays refused — cancelling cannot recall a
  // transaction that is already being signed or broadcast.
  const stranded = o.state === 'triggered' && !o.signature && !inFlight.has(o.id);
  if (!ACTIVE_STATES.includes(o.state) && !stranded) {
    return { ok: false, message: o.state === 'triggered' ? 'Order is executing' : `Order is already ${o.state}` };
  }
  o.state = 'cancelled';
  o.note = stranded
    ? 'Cancelled by you. It never reported a result — check your wallet in case the trade landed.'
    : 'Cancelled by you.';
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
  let resumed = 0;
  let needsCheck = 0;
  for (const o of paused) {
    // A `triggered` order that got paused was mid-flight when the app died.
    // Resuming it would re-send a transaction that may already have landed,
    // so those are NOT re-armed — they need a human to check the wallet.
    if (o.note?.startsWith('The app closed while this order was executing')) {
      needsCheck += 1;
      continue;
    }
    // §7: re-arming an order written on another wallet would only pause it
    // again on the next tick. Leave it, and say so in the count.
    const signer = host?.owner?.() ?? null;
    if (signer !== null && (o.owner ?? null) !== signer) {
      needsCheck += 1;
      continue;
    }
    o.state = 'armed';
    o.note = 'Resumed.';
    o.updatedAt = Date.now();
    // A trailing stop's peak is meaningless across a gap in observation. It
    // cannot restart from the reference either: that was captured when the
    // order was WRITTEN, so on a token that fell while the app was closed the
    // reference IS the stale high, and the first tick back would sell into
    // the fall the stop was supposed to have caught. Null means "no peak seen
    // yet" — onTick adopts the first price it actually observes.
    if (o.kind === 'trailing_stop') o.peakPriceSol = null;
    resumed += 1;
  }
  persistNow();
  host?.changed();
  const tail = needsCheck > 0 ? `; ${needsCheck} still need${needsCheck === 1 ? 's' : ''} your check` : '';
  return { ok: true, message: `Resumed ${resumed} order${resumed === 1 ? '' : 's'}${tail}`, resumed };
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
 * Mints with a SELL in flight. See §6: sells are sized as a share of the
 * balance read when the transaction is built, so two overlapping sells on one
 * mint both size off the same undiminished bag and together take more than
 * either was meant to. Buys are not affected — they spend a stated amount of
 * SOL, not a share of something — so this is deliberately sell-only.
 */
const sellInFlightMints = new Set<string>();

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

    // §7: an order sells a share of "the position", and which position that
    // is depends on who signs. A mismatch pauses rather than skips, so the
    // paused banner tells the user their protection is not running instead of
    // it going quiet. An unknown owner (an order written before this field
    // existed) pauses too — fail closed, because the one thing we must not do
    // is sell an unknown bag. Nothing to compare against (a host that cannot
    // name the signer) leaves the order alone.
    const signer = host?.owner?.() ?? null;
    if (signer !== null && (o.owner ?? null) !== signer) {
      o.state = 'paused';
      o.note =
        (o.owner ?? null) === null
          ? 'Paused — this order does not say which wallet it was written on. Check the wallet, then resume.'
          : 'Paused — created on a different wallet than the one now active.';
      o.updatedAt = now;
      dirty = true;
      continue;
    }

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
    // §6: another sell on this mint is already building against a balance
    // this one would double-count. Leave it ARMED — the same shape as a
    // blocked order — so it fires on the next tick, sized against what the
    // first sell actually left. Silent by design: nothing is lost or spent,
    // and the delay is one tick.
    if (!isBuyKind(o.kind) && sellInFlightMints.has(o.mint)) continue;

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
    if (!isBuyKind(o.kind)) sellInFlightMints.add(o.mint);
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

/** Re-arms granted to an order whose execution was refused by a rate limit
 *  before broadcast. In memory only: a restart starts the count over. */
const rateLimitRearms = new Map<string, number>();
const MAX_RATE_LIMIT_REARMS = 5;

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

    // ── Is there anything left to sell? ────────────────────────────────
    //
    // A sell order fired on an empty bag reaches the chain and reverts with
    // pump's `SellZeroAmount (6022)` or `Truncation (6025)` — verified against
    // pump's on-chain IDL. The user then sees a red FAILED order quoting a
    // custom error code, when what actually happened is that the position was
    // already gone (sold by hand, dusted, or closed by an earlier order).
    //
    // A CONFIRMED zero expires the order — "conditions can no longer be met"
    // is exactly what that state is for, and it stops the order retrying
    // against nothing. A balance we could not READ changes nothing: unknown
    // is not zero, and a failed RPC read must never block an exit.
    if (!isBuyKind(o.kind) && h.heldTokensRaw) {
      let held: bigint | null = null;
      try {
        held = await h.heldTokensRaw(o.mint);
      } catch {
        held = null; // unreadable — proceed, exactly as if we had never asked
      }
      if (held === 0n) {
        finish(o, 'expired', 'Nothing left to sell — the position is already gone.', null);
        h.toast('warn', `${o.symbol || 'Order'}: nothing left to sell — the position is gone`);
        return;
      }
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
    } else if (!res.signature && mentionsRateLimit(res.message) && (rateLimitRearms.get(o.id) ?? 0) < MAX_RATE_LIMIT_REARMS) {
      // Refused BEFORE broadcast by a rate limit — no signature exists, so
      // there is no post-broadcast state and §5 does not apply. Re-arm: a
      // stop-loss that dies because an RPC said "slow down" is a stop-loss
      // that silently never fired (2026-09-06). Bounded, so a host that is
      // down for an hour ends in `failed` with the reason, not a loop.
      const n = (rateLimitRearms.get(o.id) ?? 0) + 1;
      rateLimitRearms.set(o.id, n);
      o.state = 'armed';
      o.triggeredAt = null;
      o.note = `Condition met but NOT executed — rate limited (${res.message}). Still armed (attempt ${n}/${MAX_RATE_LIMIT_REARMS}).`;
      o.updatedAt = Date.now();
      persistNow();
      h.changed();
      h.log('warn', `order re-armed after a rate limit: ${describeOrder(o)} on ${o.symbol || o.mint.slice(0, 8)} — ${res.message}`);
      h.toast('warn', `${o.symbol || 'Order'}: not executed, rate limited — still armed`);
    } else {
      // Deliberately NOT retried. See the header, §5.
      finish(o, 'failed', res.message, res.signature ?? null);
      h.toast('error', `${o.symbol || 'Order'} failed: ${res.message}`);
    }
  } catch (err) {
    finish(o, 'failed', (err as Error)?.message ?? 'unknown error', null);
  } finally {
    inFlight.delete(o.id);
    if (!isBuyKind(o.kind)) sellInFlightMints.delete(o.mint);
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

/** Is anything armed at all? Cheap enough for a hot feed path to ask on
 *  every notification, unlike `armedMints()` which allocates. */
export function hasArmed(): boolean {
  return orders.some((o) => o.state === 'armed');
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
  sellInFlightMints.clear();
}

export function _load(list: AdvOrder[]): void {
  loadFailure = null;
  orders = list;
}
