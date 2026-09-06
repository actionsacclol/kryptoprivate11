import { useState } from 'react';
import { Bell, BellOff, Plus, Trash2 } from 'lucide-react';
import {
  ALERT_LABEL,
  describeAlert,
  isEventKind,
  isTokenScoped,
  validateAlert,
  type Alert,
  type AlertKind,
  type NewAlertRequest,
} from '@shared/alerts';
import type { TokenSummary } from '@shared/market';
import { cls, fmtAgo, fmtUsd } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

// Per-token alert creation + list (term.txt §17).
//
// Alerts are the safe sibling of orders: they never spend anything, so they
// stay armed across restarts and can repeat. The UI leans on that — no
// warnings, no arming, no confirmation.

const TOKEN_KINDS: AlertKind[] = [
  'mcap_above', 'mcap_below', 'price_above', 'price_below',
  'volume_above', 'liquidity_below', 'holders_above', 'curve_above',
  'dev_sold', 'migrated',
];

function suggestedThreshold(kind: AlertKind, t: TokenSummary): string {
  switch (kind) {
    case 'mcap_above':
      return t.marketCapUsd ? String(Math.round(t.marketCapUsd * 2)) : '';
    case 'mcap_below':
      return t.marketCapUsd ? String(Math.round(t.marketCapUsd * 0.5)) : '';
    case 'price_above':
      return t.priceSol ? String(t.priceSol * 2) : '';
    case 'price_below':
      return t.priceSol ? String(t.priceSol * 0.5) : '';
    case 'volume_above':
      return '25000';
    case 'liquidity_below':
      return t.liquidityUsd ? String(Math.round(t.liquidityUsd * 0.5)) : '5000';
    case 'holders_above':
      return t.holders ? String(Math.round(t.holders * 1.5)) : '500';
    case 'curve_above':
      return '90';
    default:
      return '';
  }
}

export function AlertRow({
  alert,
  onRemove,
  onMute,
  showSymbol,
}: {
  alert: Alert;
  onRemove: (id: string) => void;
  onMute: (id: string, muted: boolean) => void;
  showSymbol?: boolean;
}) {
  const muted = alert.state === 'muted';
  return (
    <div
      className={cls(
        'rounded-lg border px-3 py-2 flex items-center gap-2 transition',
        alert.state === 'fired'
          ? 'border-krypt-purple/35 bg-krypt-purple/10'
          : muted
            ? 'border-white/8 bg-black/20 opacity-60'
            : 'border-white/10 bg-black/20',
      )}
    >
      <span
        className={cls(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider flex-shrink-0',
          alert.state === 'armed'
            ? 'border-emerald-400/35 bg-emerald-500/10 text-emerald-300'
            : alert.state === 'fired'
              ? 'border-krypt-purple/40 bg-krypt-purple/15 text-krypt-pink'
              : 'border-white/10 bg-white/5 text-krypt-muted',
        )}
      >
        {muted ? <BellOff className="h-2.5 w-2.5" /> : <Bell className="h-2.5 w-2.5" />}
        {alert.state}
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-white/90 truncate">
          {showSymbol && alert.symbol && <span className="font-semibold mr-1.5">{alert.symbol}</span>}
          {describeAlert(alert)}
        </div>
        {alert.fireCount > 0 && (
          <div className="text-[10px] text-krypt-muted/70">
            Fired {alert.fireCount}× · last {alert.lastFiredAt ? fmtAgo(alert.lastFiredAt) : '—'} ago
          </div>
        )}
      </div>

      {alert.repeat && (
        <span className="text-[9px] uppercase tracking-wider text-krypt-muted/50 flex-shrink-0">repeat</span>
      )}
      <button
        onClick={() => onMute(alert.id, !muted)}
        title={muted ? 'Re-arm' : 'Mute'}
        className="text-krypt-muted/60 hover:text-white transition flex-shrink-0"
      >
        {muted ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
      </button>
      <button
        onClick={() => onRemove(alert.id)}
        title="Delete"
        className="text-krypt-muted/60 hover:text-rose-300 transition flex-shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function AlertsPanel({
  token,
  alerts,
  onChanged,
}: {
  token: TokenSummary;
  alerts: Alert[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AlertKind>('mcap_above');
  const [threshold, setThreshold] = useState<string>('');
  const [repeat, setRepeat] = useState(false);

  const pick = (k: AlertKind): void => {
    setKind(k);
    setThreshold(suggestedThreshold(k, token));
  };

  const req: NewAlertRequest = {
    kind,
    mint: isTokenScoped(kind) ? token.mint : '',
    symbol: token.symbol,
    threshold: isEventKind(kind) ? null : threshold.trim() === '' ? null : Number(threshold),
    repeat,
  };
  const validity = validateAlert(req);

  const submit = async (): Promise<void> => {
    const r = await window.krypt.alerts.create(req);
    if (r.ok) {
      toast.success(`Alert set — ${r.message}`);
      setOpen(false);
      onChanged();
    } else {
      toast.error(r.message);
    }
  };

  const remove = async (id: string): Promise<void> => {
    const r = await window.krypt.alerts.remove(id);
    if (!r.ok) toast.error(r.message);
    onChanged();
  };

  const mute = async (id: string, muted: boolean): Promise<void> => {
    await window.krypt.alerts.mute(id, muted);
    onChanged();
  };

  const unit =
    kind === 'price_above' || kind === 'price_below' ? 'SOL'
    : kind === 'curve_above' ? '%'
    : kind === 'holders_above' ? 'holders'
    : 'USD';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-[10px] font-semibold uppercase tracking-[0.28em] text-krypt-muted whitespace-nowrap">
          Alerts
        </h3>
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        <button
          onClick={() => {
            if (!open) pick(kind);
            setOpen((o) => !o);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[10px] font-semibold text-krypt-muted hover:text-white transition"
        >
          <Plus className="h-3 w-3" />
          New
        </button>
      </div>

      {open && (
        <div className="rounded-lg border border-white/12 bg-black/30 p-3 space-y-2.5 animate-ink">
          <div className="grid grid-cols-2 gap-1">
            {TOKEN_KINDS.map((k) => (
              <button
                key={k}
                onClick={() => pick(k)}
                className={cls(
                  'rounded-md border px-2 py-1.5 text-[10px] font-semibold transition text-left leading-tight',
                  kind === k
                    ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white'
                    : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                )}
              >
                {ALERT_LABEL[k]}
              </button>
            ))}
          </div>

          {!isEventKind(kind) && (
            <div>
              <div className="flex items-center rounded-md border border-white/10 bg-black/40 overflow-hidden">
                <input
                  type="number"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  className="flex-1 bg-transparent px-2 py-1.5 text-[12px] font-mono text-white outline-none"
                />
                <span className="px-2 text-[10px] uppercase text-krypt-muted">{unit}</span>
              </div>
              {kind.startsWith('mcap') && token.marketCapUsd !== null && (
                <div className="text-[10px] text-krypt-muted/60 mt-1">Now: {fmtUsd(token.marketCapUsd)}</div>
              )}
            </div>
          )}

          <button
            onClick={() => setRepeat((r) => !r)}
            className={cls(
              'w-full rounded-md border px-2 py-1.5 text-[10px] font-semibold transition',
              repeat
                ? 'border-krypt-purple/45 bg-krypt-purple/15 text-white'
                : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            {repeat ? 'Repeating — fires every time (rate-limited)' : 'Fires once, then stops'}
          </button>

          {!validity.ok && <p className="text-[10px] text-rose-300">{validity.message}</p>}

          <button
            onClick={() => void submit()}
            disabled={!validity.ok}
            className={cls(
              'w-full rounded-md border py-2 text-[11px] font-bold uppercase tracking-wider transition',
              validity.ok
                ? 'border-krypt-purple/50 bg-krypt-gradient text-white hover:brightness-110'
                : 'border-white/8 bg-white/5 text-krypt-muted/50 cursor-not-allowed',
            )}
          >
            Set alert
          </button>
        </div>
      )}

      {alerts.length === 0 ? (
        <p className="text-[11px] text-krypt-muted/60">
          No alerts on this token. Alerts only notify — they never trade.
        </p>
      ) : (
        <div className="space-y-1.5">
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} onRemove={(id) => void remove(id)} onMute={(id, m) => void mute(id, m)} />
          ))}
        </div>
      )}
    </div>
  );
}
