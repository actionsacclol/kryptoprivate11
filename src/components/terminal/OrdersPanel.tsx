import { useState } from 'react';
import { AlertTriangle, Ban, Check, Clock, Loader2, Plus, X, Zap } from 'lucide-react';
import {
  ORDER_LABEL,
  describeOrder,
  isBuyKind,
  isConditional,
  isPctKind,
  validateOrder,
  type AdvOrder,
  type NewOrderRequest,
  type OrderKind,
  type OrderState,
  type TriggerBasis,
} from '@shared/orders';
import type { TokenSummary } from '@shared/market';
import { cls, fmtAgo, fmtUsd } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

// Order creation + the per-token order list (term.txt §2).
//
// The form is driven off the same `validateOrder` the main process uses, so
// the button is disabled for exactly the inputs the engine would reject —
// the UI can never offer something that fails on submit.

const STATE_STYLE: Record<OrderState, string> = {
  armed: 'border-emerald-400/35 bg-emerald-500/10 text-emerald-300',
  paused: 'border-arc-gold/40 bg-arc-gold/10 text-arc-gold',
  triggered: 'border-krypt-purple/40 bg-krypt-purple/15 text-krypt-pink',
  filled: 'border-white/15 bg-white/5 text-white/70',
  failed: 'border-rose-400/35 bg-rose-500/10 text-rose-300',
  cancelled: 'border-white/10 bg-white/5 text-krypt-muted',
  expired: 'border-white/10 bg-white/5 text-krypt-muted',
};

const STATE_ICON: Record<OrderState, typeof Check> = {
  armed: Zap,
  paused: Clock,
  triggered: Loader2,
  filled: Check,
  failed: AlertTriangle,
  cancelled: Ban,
  expired: Clock,
};

/** The kinds offered, grouped the way a trader thinks about them. */
const KIND_GROUPS: Array<{ label: string; kinds: OrderKind[] }> = [
  { label: 'Protect', kinds: ['stop_loss', 'trailing_stop', 'take_profit'] },
  { label: 'Limit', kinds: ['limit_buy', 'limit_sell'] },
  { label: 'Trigger', kinds: ['sell_on_dev_sell', 'sell_on_migration', 'buy_on_migration'] },
];

export function OrderRow({
  order,
  onCancel,
  showSymbol,
}: {
  order: AdvOrder;
  onCancel: (id: string) => void;
  showSymbol?: boolean;
}) {
  const Icon = STATE_ICON[order.state];
  const cancellable = order.state === 'armed' || order.state === 'paused';
  const blockedWarning = order.state === 'armed' && order.note?.includes('NOT executed');

  return (
    <div
      className={cls(
        'rounded-lg border px-3 py-2 transition',
        blockedWarning ? 'border-rose-400/40 bg-rose-500/10' : 'border-white/10 bg-black/20',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cls(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wider',
            STATE_STYLE[order.state],
          )}
        >
          <Icon className={cls('h-2.5 w-2.5', order.state === 'triggered' && 'animate-spin')} />
          {order.state}
        </span>
        {showSymbol && <span className="text-note font-semibold text-white">{order.symbol || order.mint.slice(0, 6)}</span>}
        <span className="text-body text-krypt-muted uppercase tracking-wider">{ORDER_LABEL[order.kind]}</span>
        <div className="flex-1" />
        <span className="text-label text-krypt-muted/50">{fmtAgo(order.createdAt)} ago</span>
        {cancellable && (
          <button
            onClick={() => onCancel(order.id)}
            title="Cancel order"
            className="text-krypt-muted/60 hover:text-rose-300 transition"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="text-note text-white/90 mt-1">{describeOrder(order)}</div>

      {order.note && (
        <div
          className={cls(
            'text-label mt-1 leading-relaxed',
            blockedWarning ? 'text-rose-200' : order.state === 'failed' ? 'text-rose-300/80' : 'text-krypt-muted/70',
          )}
        >
          {order.note}
        </div>
      )}

      {order.signature && (
        <button
          onClick={() => void window.krypt.app.openExternal(`https://solscan.io/tx/${order.signature}`)}
          className="text-label font-mono text-krypt-purple hover:text-krypt-pink mt-1"
        >
          {order.signature.slice(0, 16)}… ↗
        </button>
      )}
    </div>
  );
}

export function OrdersPanel({
  token,
  orders,
  executable,
  blockedReason,
  maxLiveSol = null,
  onChanged,
}: {
  token: TokenSummary;
  orders: AdvOrder[];
  executable: boolean;
  blockedReason: string | null;
  /** The execution per-trade cap; a buy order above it is refused by the
   *  engine, so the form defaults under it and says so before the click. */
  maxLiveSol?: number | null;
  onChanged: () => void;
}) {
  const buyDefault = String(maxLiveSol !== null && maxLiveSol < 0.1 ? maxLiveSol : 0.1);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<OrderKind>('stop_loss');
  const [triggerValue, setTriggerValue] = useState<string>('30');
  const [basis, setBasis] = useState<TriggerBasis>('pct');
  const [amount, setAmount] = useState<string>('100');
  const [busy, setBusy] = useState(false);

  const active = orders.filter((o) => o.state === 'armed' || o.state === 'paused' || o.state === 'triggered');
  const done = orders.filter((o) => !active.includes(o));

  const pickKind = (k: OrderKind): void => {
    setKind(k);
    // Sensible defaults per kind, so the form is never in a nonsense state.
    if (isPctKind(k)) {
      setBasis('pct');
      setTriggerValue(k === 'take_profit' ? '50' : k === 'stop_loss' ? '30' : '15');
      setAmount(k === 'take_profit' ? '25' : '100');
    } else if (isConditional(k)) {
      setBasis('pct');
      setTriggerValue('');
      setAmount(isBuyKind(k) ? buyDefault : '100');
    } else {
      setBasis('mcap_usd');
      setTriggerValue(token.marketCapUsd ? String(Math.round(token.marketCapUsd)) : '');
      setAmount(isBuyKind(k) ? buyDefault : '50');
    }
  };

  // The engine anchors percentage orders to a reference price and refuses to
  // create one without it. The renderer knows that price too, so gate the
  // form here rather than letting the user fill it in and be rejected —
  // this panel's contract is that it never offers what the engine will
  // refuse, and finding out after the click breaks it.
  // Paper is not a fault, it is the mode the user picked. The engine's
  // "why can nothing execute" answer is the SAME predicate as paper mode, so
  // in Paper this panel would otherwise show a gold "will fire when it is
  // fixed" warning forever and happily arm orders that can never fire —
  // advanced orders have no paper path. Say so plainly and refuse instead.
  const paperBlocked = !executable && (blockedReason?.includes('live execution is off') ?? false);

  const anchorable = token.priceSol !== null && token.priceSol > 0;
  const needsAnchor = isPctKind(kind);
  const anchorProblem =
    needsAnchor && !anchorable
      ? 'No price is available for this token yet, so a percentage order has nothing to measure against. Use a limit order on market cap, or wait for a price.'
      : null;

  const req: NewOrderRequest = {
    mint: token.mint,
    symbol: token.symbol,
    kind,
    triggerValue: isConditional(kind) ? null : triggerValue.trim() === '' ? null : Number(triggerValue),
    triggerBasis: basis,
    amount: Number(amount),
  };
  const capProblem =
    isBuyKind(kind) && maxLiveSol !== null && Number(amount) > maxLiveSol
      ? `Above your per-trade cap of ${maxLiveSol} SOL — raise it on the Wallet page or buy less.`
      : null;
  const validity = paperBlocked
    ? { ok: false, message: 'Orders are live-only — switch to Live to arm them.' }
    : anchorProblem
      ? { ok: false, message: anchorProblem }
      : capProblem
        ? { ok: false, message: capProblem }
        : validateOrder(req);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.orders.create(req);
      if (r.ok) {
        toast.success(`Order created — ${r.message}`);
        setOpen(false);
        onChanged();
      } else {
        toast.error(r.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string): Promise<void> => {
    const r = await window.krypt.orders.cancel(id);
    if (r.ok) toast.info(r.message);
    else toast.error(r.message);
    onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-label font-semibold uppercase tracking-heading text-krypt-muted whitespace-nowrap">
          Orders
        </h3>
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        <button
          onClick={() => {
            // Open on a kind the token can actually support, so the form is
            // never in a refused state the moment it appears.
            if (!open) pickKind(anchorable ? kind : 'limit_sell');
            setOpen((o) => !o);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-krypt-purple/40 bg-krypt-purple/15 px-2 py-1 text-label font-semibold text-white hover:bg-krypt-purple/25 transition"
        >
          <Plus className="h-3 w-3" />
          New
        </button>
      </div>

      {paperBlocked ? (
        <div className="rounded-md border border-arc-gold/30 bg-arc-gold/10 px-2.5 py-2">
          <p className="text-label text-arc-gold/90 leading-relaxed">
            Orders are live-only — switch to Live to arm them. There is no paper version of a stop loss, so nothing
            created here would fire while you are in Paper.
          </p>
        </div>
      ) : (
        !executable &&
        blockedReason && (
          <div className="rounded-md border border-arc-gold/30 bg-arc-gold/10 px-2.5 py-2">
            <p className="text-label text-arc-gold/90 leading-relaxed">
              Orders will not execute right now — {blockedReason}. They stay armed and will fire when it is fixed,
              which may be at a much worse price.
            </p>
          </div>
        )
      )}

      {open && (
        <div className="rounded-lg border border-white/12 bg-black/30 p-3 space-y-2.5 animate-ink">
          {KIND_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="text-micro uppercase tracking-label text-krypt-muted/60 mb-1">{g.label}</div>
              <div className="grid grid-cols-3 gap-1">
                {g.kinds.map((k) => {
                  const unavailable = isPctKind(k) && !anchorable;
                  return (
                    <button
                      key={k}
                      onClick={() => pickKind(k)}
                      disabled={unavailable}
                      title={unavailable ? 'Needs a price to measure against' : undefined}
                      className={cls(
                        'rounded-md border px-1.5 py-1.5 text-label font-semibold transition leading-tight',
                        unavailable
                          ? 'border-white/8 bg-white/[0.02] text-krypt-muted/35 cursor-not-allowed line-through'
                          : kind === k
                            ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white'
                            : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                      )}
                    >
                      {ORDER_LABEL[k]}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {!isConditional(kind) && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-micro uppercase tracking-label text-krypt-muted/60">Trigger</span>
                {!isPctKind(kind) && (
                  <div className="flex rounded border border-white/10 overflow-hidden">
                    {(['mcap_usd', 'price_sol'] as TriggerBasis[]).map((b) => (
                      <button
                        key={b}
                        onClick={() => setBasis(b)}
                        className={cls(
                          'px-1.5 py-0.5 text-micro font-semibold transition',
                          basis === b ? 'bg-arc-gold/20 text-arc-gold' : 'text-krypt-muted hover:text-white',
                        )}
                      >
                        {b === 'mcap_usd' ? 'MC $' : 'SOL'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center rounded-md border border-white/10 bg-black/40 overflow-hidden">
                <input
                  type="number"
                  value={triggerValue}
                  onChange={(e) => setTriggerValue(e.target.value)}
                  className="flex-1 bg-transparent px-2 py-1.5 text-note font-mono text-white outline-none"
                />
                <span className="px-2 text-label uppercase text-krypt-muted">
                  {isPctKind(kind) ? '%' : basis === 'mcap_usd' ? 'USD' : 'SOL'}
                </span>
              </div>
              {basis === 'mcap_usd' && token.marketCapUsd !== null && (
                <div className="text-label text-krypt-muted/60 mt-1">
                  Now: {fmtUsd(token.marketCapUsd)}
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-micro uppercase tracking-label text-krypt-muted/60 mb-1">
              {isBuyKind(kind) ? 'Buy amount' : 'Sell amount'}
            </div>
            {!isBuyKind(kind) && (
              <div className="grid grid-cols-5 gap-1 mb-1">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    onClick={() => setAmount(String(p))}
                    className={cls(
                      'rounded border py-1 text-label font-mono transition',
                      Number(amount) === p
                        ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white'
                        : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                    )}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center rounded-md border border-white/10 bg-black/40 overflow-hidden">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1 bg-transparent px-2 py-1.5 text-note font-mono text-white outline-none"
              />
              <span className="px-2 text-label uppercase text-krypt-muted">{isBuyKind(kind) ? 'SOL' : '%'}</span>
            </div>
          </div>

          {!validity.ok && <p className="text-label text-rose-300">{validity.message}</p>}

          <button
            onClick={() => void submit()}
            disabled={!validity.ok || busy}
            className={cls(
              'w-full rounded-md border py-2 text-body font-bold uppercase tracking-wider transition',
              validity.ok && !busy
                ? 'border-krypt-purple/50 bg-krypt-gradient text-white hover:brightness-110'
                : 'border-white/8 bg-white/5 text-krypt-muted/50 cursor-not-allowed',
            )}
          >
            {busy ? 'Creating…' : 'Create order'}
          </button>
          <p className="text-label text-krypt-muted/55 leading-relaxed">
            Orders survive a restart but come back <span className="text-arc-gold">paused</span> — you resume them
            deliberately, so a stop loss can never fire into a market the app was not watching.
          </p>
        </div>
      )}

      {active.length === 0 && done.length === 0 ? (
        <p className="text-body text-krypt-muted/60">
          No orders on this token. Use <span className="text-white">New</span> for a stop loss, take profit,
          trailing stop or limit order.
        </p>
      ) : (
        <div className="space-y-1.5">
          {active.map((o) => (
            <OrderRow key={o.id} order={o} onCancel={(id) => void cancel(id)} />
          ))}
          {done.slice(0, 5).map((o) => (
            <OrderRow key={o.id} order={o} onCancel={(id) => void cancel(id)} />
          ))}
        </div>
      )}
    </div>
  );
}
