// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — advanced orders contract (term.txt section 2).
//
// These are USER-DIRECTED automation: a limit order, a take-profit ladder, a
// stop loss, a trailing stop, or a trigger on something observable like the
// creator selling. That is a different thing from the autonomous strategy
// firing that was removed on 2026-08-16 — the app never decides to open a
// position, it only carries out an instruction the user wrote down.
//
// The distinction matters and is enforced structurally: every order names a
// mint the user chose, and an order can only be created from a screen the
// user is looking at.
// ──────────────────────────────────────────────────────────────────────

export type OrderKind =
  /** Buy when price/market cap falls to (or below) the trigger. */
  | 'limit_buy'
  /** Sell when price/market cap rises to (or above) the trigger. */
  | 'limit_sell'
  /** Sell a slice once up N% from the reference price. */
  | 'take_profit'
  /** Sell everything once down N% from the reference price. */
  | 'stop_loss'
  /** Sell once price falls N% from the highest price seen since arming. */
  | 'trailing_stop'
  /** Sell when the token's creator sells. */
  | 'sell_on_dev_sell'
  /** Sell when the bonding curve completes and the token migrates. */
  | 'sell_on_migration'
  /** Buy when the bonding curve completes and the token migrates. */
  | 'buy_on_migration';

export const ORDER_KINDS: OrderKind[] = [
  'limit_buy',
  'limit_sell',
  'take_profit',
  'stop_loss',
  'trailing_stop',
  'sell_on_dev_sell',
  'sell_on_migration',
  'buy_on_migration',
];

/** What the numeric trigger is measured in. */
export type TriggerBasis =
  /** Price in SOL per token. */
  | 'price_sol'
  /** Market cap in USD — how memecoin traders actually think. */
  | 'mcap_usd'
  /** Percentage move from the order's reference price. */
  | 'pct';

/** The whole set, so the renderer form, the IPC handler and the script bridge
 *  all check against ONE list. Each kept its own copy until 2026-09-09, and
 *  an unrecognised basis then silently behaved as `price_sol`. */
export const TRIGGER_BASES: TriggerBasis[] = ['price_sol', 'mcap_usd', 'pct'];

export type OrderState =
  /** Live and being evaluated. */
  | 'armed'
  /** Conditions met, execution in flight. Terminal for triggering purposes:
   *  an order can leave `armed` exactly once. */
  | 'triggered'
  /** Executed successfully. */
  | 'filled'
  /** Execution was attempted and failed. Carries the reason. */
  | 'failed'
  /** Cancelled by the user. */
  | 'cancelled'
  /** Conditions can no longer be met (position gone, token migrated past a
   *  curve-only trigger). */
  | 'expired'
  /** Survived a restart and is deliberately NOT evaluating until the user
   *  says so. See the note on `advOrders.ts` for why. */
  | 'paused';

export const ACTIVE_STATES: OrderState[] = ['armed', 'paused'];

export interface AdvOrder {
  id: string;
  mint: string;
  symbol: string;
  kind: OrderKind;
  state: OrderState;

  /** Numeric trigger. Null for the purely conditional kinds. */
  triggerValue: number | null;
  triggerBasis: TriggerBasis;

  /** Buy orders: SOL to spend. Sell orders: percent of the position (1..100). */
  amount: number;

  /**
   * Price the percentage kinds are measured against, in SOL per token.
   * Captured when the order is created — usually the user's entry, or the
   * spot price if there is no position. Null means the order could not be
   * anchored and will not evaluate.
   */
  referencePriceSol: number | null;

  /** Trailing stops only: highest price seen since arming, SOL per token. */
  peakPriceSol: number | null;

  /**
   * Public key of the wallet this order was written over.
   *
   * An order sells "N% of the position", and the position it means is the one
   * in the wallet the user was looking at. The active signer can change
   * (disarm → switch → re-arm), and with multi-wallet fan-out several wallets
   * hold the same mint — so an order that does not name its wallet would sell
   * whichever bag happens to be active when it fires. Null means unknown (an
   * order persisted before this field existed); those pause rather than fire.
   */
  owner: string | null;

  createdAt: number;
  updatedAt: number;
  triggeredAt: number | null;

  /** Last thing that happened, in plain language. Always user-facing. */
  note: string | null;
  /** Signature of the transaction this order produced, if it filled. */
  signature: string | null;

  /** Order expires (moves to `expired`) after this timestamp. Null = never. */
  expiresAt: number | null;

  /** Set when the condition is met but execution is blocked. The order stays
   *  armed — see advOrders.ts — and the UI shows this as an active warning,
   *  because it is protection the user currently does not have. */
  blockedSince?: number | null;
  /** Rate-limits the blocked warning to once a minute. */
  lastBlockedWarnAt?: number | null;
}

/** What a caller must supply to create one. Everything else is derived. */
export interface NewOrderRequest {
  mint: string;
  symbol: string;
  kind: OrderKind;
  triggerValue: number | null;
  triggerBasis: TriggerBasis;
  amount: number;
  expiresAt?: number | null;
}

/** Engine-side snapshot for the UI. */
export interface OrdersSnapshot {
  orders: AdvOrder[];
  /** True when orders can actually execute right now. */
  executable: boolean;
  /** Why not, when they cannot. */
  blockedReason: string | null;
  /** Orders restored from disk that are waiting for the user to resume. */
  pausedCount: number;
}

// ── Display helpers (shared so main and renderer word things identically) ──

export const ORDER_LABEL: Record<OrderKind, string> = {
  limit_buy: 'Limit buy',
  limit_sell: 'Limit sell',
  take_profit: 'Take profit',
  stop_loss: 'Stop loss',
  trailing_stop: 'Trailing stop',
  sell_on_dev_sell: 'Sell if dev sells',
  sell_on_migration: 'Sell on migration',
  buy_on_migration: 'Buy on migration',
};

export function isBuyKind(kind: OrderKind): boolean {
  return kind === 'limit_buy' || kind === 'buy_on_migration';
}

/** Kinds with no numeric trigger — they fire on an observed event. */
export function isConditional(kind: OrderKind): boolean {
  return kind === 'sell_on_dev_sell' || kind === 'sell_on_migration' || kind === 'buy_on_migration';
}

/** Kinds whose trigger is a percentage move from the reference price. */
export function isPctKind(kind: OrderKind): boolean {
  return kind === 'take_profit' || kind === 'stop_loss' || kind === 'trailing_stop';
}

/**
 * What a percentage order is measured FROM, spelled out.
 *
 * A "30% stop" is meaningless without saying 30% below what. The anchor is
 * captured once when the order is written, so a stop written after the token
 * has already halved is 30% below the halved price, not below the entry —
 * that is a very different instruction and the user has to be able to see it.
 * Appended, never prepended, so the leading text stays stable.
 */
function anchorText(o: AdvOrder): string {
  const ref = o.kind === 'trailing_stop' ? (o.peakPriceSol ?? o.referencePriceSol) : o.referencePriceSol;
  if (ref === null || !Number.isFinite(ref) || ref <= 0) return '';
  const shown = ref >= 0.0001 ? String(Number(ref.toPrecision(4))) : ref.toExponential(2);
  return ` (from ${shown} SOL)`;
}

/**
 * Human summary of what an order will do. Used in the orders list, the
 * confirmation dialog and the chart label, so all three always agree.
 */
export function describeOrder(o: AdvOrder): string {
  const amt = isBuyKind(o.kind) ? `${o.amount} SOL` : `${o.amount}%`;
  // An unknown trigger is an em dash, never 0: "$0 market cap" and "−0%"
  // both read as a real instruction the user never wrote.
  const num = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : String(v));
  switch (o.kind) {
    case 'limit_buy':
    case 'limit_sell': {
      const dir = o.kind === 'limit_buy' ? 'at or below' : 'at or above';
      const target =
        o.triggerBasis === 'mcap_usd'
          ? `${o.triggerValue === null || !Number.isFinite(o.triggerValue) ? '—' : `$${o.triggerValue.toLocaleString()}`} market cap`
          : `${num(o.triggerValue)} SOL`;
      return `${o.kind === 'limit_buy' ? 'Buy' : 'Sell'} ${amt} ${dir} ${target}`;
    }
    case 'take_profit':
      return `Sell ${amt} at +${num(o.triggerValue)}%${anchorText(o)}`;
    case 'stop_loss':
      return `Sell ${amt} at −${o.triggerValue === null || !Number.isFinite(o.triggerValue) ? '—' : Math.abs(o.triggerValue)}%${anchorText(o)}`;
    case 'trailing_stop':
      return `Sell ${amt} if it falls ${num(o.triggerValue)}% from its peak${anchorText(o)}`;
    case 'sell_on_dev_sell':
      return `Sell ${amt} if the creator sells`;
    case 'sell_on_migration':
      return `Sell ${amt} when it migrates to a DEX`;
    case 'buy_on_migration':
      return `Buy ${amt} when it migrates to a DEX`;
  }
}

/**
 * The absolute SOL price an order triggers at, where that is knowable.
 * Returns null for conditional kinds, for market-cap triggers (which need a
 * supply and a SOL/USD rate the caller has), and for unanchored percentages.
 * Used to draw the order line on the chart.
 */
export function triggerPriceSol(o: AdvOrder): number | null {
  if (isConditional(o.kind)) return null;
  if (o.triggerBasis === 'price_sol') return o.triggerValue;
  if (!isPctKind(o.kind)) return null;
  const ref = o.kind === 'trailing_stop' ? (o.peakPriceSol ?? o.referencePriceSol) : o.referencePriceSol;
  if (ref === null || o.triggerValue === null) return null;
  const move = o.kind === 'take_profit' ? 1 + o.triggerValue / 100 : 1 - Math.abs(o.triggerValue) / 100;
  return ref * move;
}

/** Validation shared by the renderer form and the main-process handler, so
 *  the UI can never offer something the engine will reject. */
export function validateOrder(req: NewOrderRequest): { ok: boolean; message: string } {
  if (!req.mint || req.mint.length < 32) return { ok: false, message: 'Invalid mint address' };
  if (!ORDER_KINDS.includes(req.kind)) return { ok: false, message: 'Unknown order type' };
  if (!TRIGGER_BASES.includes(req.triggerBasis)) {
    return { ok: false, message: `Trigger basis must be one of ${TRIGGER_BASES.join(', ')}` };
  }

  if (isBuyKind(req.kind)) {
    if (!(req.amount > 0)) return { ok: false, message: 'Buy amount must be greater than zero' };
  } else if (!(req.amount > 0 && req.amount <= 100)) {
    return { ok: false, message: 'Sell amount must be between 1% and 100%' };
  }

  if (isConditional(req.kind)) return { ok: true, message: 'ok' };

  if (req.triggerValue === null || !Number.isFinite(req.triggerValue)) {
    return { ok: false, message: 'This order type needs a trigger value' };
  }
  if (isPctKind(req.kind)) {
    if (req.kind === 'take_profit' && req.triggerValue <= 0) {
      return { ok: false, message: 'Take profit must be a positive percentage' };
    }
    if (req.kind === 'stop_loss' && (req.triggerValue <= 0 || req.triggerValue >= 100)) {
      return { ok: false, message: 'Stop loss must be between 0% and 100%' };
    }
    if (req.kind === 'trailing_stop' && (req.triggerValue <= 0 || req.triggerValue >= 100)) {
      return { ok: false, message: 'Trailing stop must be between 0% and 100%' };
    }
  } else if (req.triggerValue <= 0) {
    return { ok: false, message: 'Trigger must be greater than zero' };
  }
  return { ok: true, message: 'ok' };
}
