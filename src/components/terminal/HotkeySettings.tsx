import { useEffect, useRef, useState } from 'react';
import { Keyboard, TriangleAlert } from 'lucide-react';
import {
  comboFromEvent,
  describeAction,
  validateCombo,
  type HotkeyBinding,
} from '@shared/hotkeys';
import type { AppSettings } from '@shared/types';
import { Card, Section, Switch } from '../common';
import { cls } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

// Hotkey configuration (term.txt §22).
//
// Every control here can cause a real trade on one keypress, so the screen
// is built to be hard to arm by accident: the master switch is off, each
// binding is off, and the amounts are typed rather than defaulted to
// something large. The warning is not boilerplate — it names exactly what
// the keys will do.

function ComboCapture({
  binding,
  bindings,
  onChange,
}: {
  binding: HotkeyBinding;
  bindings: HotkeyBinding[];
  onChange: (combo: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(false);
        setError(null);
        return;
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const combo = comboFromEvent(e);
      const v = validateCombo(combo, bindings, binding.id);
      if (!v.ok) {
        setError(v.message);
        return;
      }
      onChange(combo);
      setCapturing(false);
      setError(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, binding.id, bindings, onChange]);

  return (
    <div className="flex flex-col items-end">
      <button
        ref={ref}
        onClick={() => {
          setCapturing((c) => !c);
          setError(null);
        }}
        className={cls(
          'rounded-md border px-2.5 py-1 font-mono text-[11px] transition min-w-[80px]',
          capturing
            ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white animate-pulse-slow'
            : 'border-white/12 bg-black/40 text-white/85 hover:border-white/25',
        )}
      >
        {capturing ? 'press a key…' : binding.combo}
      </button>
      {error && <span className="text-[9px] text-rose-300 mt-0.5">{error}</span>}
    </div>
  );
}

export function HotkeySettings({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const toast = useToast();
  const hk = settings.hotkeys;

  const patchBindings = (next: HotkeyBinding[]): void => {
    void updateSettings({ hotkeys: { ...hk, bindings: next } });
  };

  const setBinding = (id: string, patch: Partial<HotkeyBinding>): void => {
    patchBindings(hk.bindings.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  const setAmount = (id: string, raw: string): void => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const b = hk.bindings.find((x) => x.id === id);
    if (!b) return;
    if (b.action.kind === 'buy') {
      if (n <= 0 || n > 25) return;
      setBinding(id, { action: { kind: 'buy', sol: n } });
    } else if (b.action.kind === 'sell') {
      const p = Math.round(n);
      if (p < 1 || p > 100) return;
      setBinding(id, { action: { kind: 'sell', percent: p } });
    }
  };

  const armedCount = hk.bindings.filter((b) => b.enabled).length;
  const overCap = hk.bindings.filter(
    (b) => b.enabled && b.action.kind === 'buy' && b.action.sol > settings.execution.maxLiveSol,
  );

  return (
    <Section
      title="Trading hotkeys"
      description="One keypress, one real trade. Off by default; every key must be armed deliberately."
    >
      <Card className="space-y-4">
        <Switch
          label="Enable trading hotkeys"
          description={
            hk.enabled
              ? `On. ${armedCount} key${armedCount === 1 ? '' : 's'} armed. Keys act only on the token you have open, and are ignored while you are typing.`
              : 'Off. No key triggers a trade.'
          }
          checked={hk.enabled}
          onChange={(v) => {
            void updateSettings({ hotkeys: { ...hk, enabled: v } });
            if (v) toast.warn('Hotkeys armed — a single keypress can now spend real SOL');
          }}
        />

        <Switch
          label="Confirm before each hotkey trade"
          description={
            hk.confirm
              ? 'On. A hotkey opens a confirmation you must accept. Recommended.'
              : 'OFF. A keypress trades immediately with no confirmation. This is the fastest and the most dangerous setting in the app.'
          }
          checked={hk.confirm}
          disabled={!hk.enabled}
          onChange={(v) => {
            void updateSettings({ hotkeys: { ...hk, confirm: v } });
            if (!v) toast.warn('Confirmation off — hotkeys now trade instantly');
          }}
        />

        {hk.enabled && !hk.confirm && (
          <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2.5 flex items-start gap-2">
            <TriangleAlert className="h-4 w-4 text-rose-300 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-rose-200 leading-relaxed">
              With confirmation off, pressing an armed key on an open token buys or sells immediately. The keys are
              still ignored while a text field has focus, and still respect the live-execution switch and
              arming — but nothing else stands between the keystroke and the transaction. A key is a manual
              trade, so the {settings.execution.maxLiveSol} SOL per-trade cap does not apply to it.
            </p>
          </div>
        )}

        {overCap.length > 0 && (
          <div className="rounded-lg border border-arc-gold/35 bg-arc-gold/10 px-3 py-2 text-[11px] text-arc-gold/90">
            {overCap.length} armed buy key{overCap.length === 1 ? ' is' : 's are'} above your per-trade cap of{' '}
            {settings.execution.maxLiveSol} SOL. Keys are manual trades and are NOT capped — each press buys the
            full amount on the key. Lower the key if that is not what you want.
          </div>
        )}

        <div className="space-y-1.5">
          {hk.bindings.map((b) => (
            <div
              key={b.id}
              className={cls(
                'flex items-center gap-3 rounded-lg border px-3 py-2 transition',
                b.enabled && hk.enabled ? 'border-white/14 bg-white/[0.03]' : 'border-white/8 bg-black/20',
              )}
            >
              <Keyboard className={cls('h-3.5 w-3.5 flex-shrink-0', b.enabled ? 'text-krypt-purple' : 'text-krypt-muted/40')} />

              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-white/90">{describeAction(b.action)}</div>
                {b.action.kind === 'emergency_sell' && (
                  <div className="text-[10px] text-krypt-muted/70">Sells the whole position in the open token.</div>
                )}
              </div>

              {b.action.kind !== 'emergency_sell' && (
                <div className="flex items-center rounded-md border border-white/10 bg-black/40 overflow-hidden">
                  <input
                    type="number"
                    value={b.action.kind === 'buy' ? b.action.sol : b.action.percent}
                    onChange={(e) => setAmount(b.id, e.target.value)}
                    step={b.action.kind === 'buy' ? 0.05 : 5}
                    className="w-16 bg-transparent px-2 py-1 text-[11px] font-mono text-white outline-none text-right"
                  />
                  <span className="px-1.5 text-[9px] uppercase text-krypt-muted">
                    {b.action.kind === 'buy' ? 'SOL' : '%'}
                  </span>
                </div>
              )}

              <ComboCapture binding={b} bindings={hk.bindings} onChange={(combo) => setBinding(b.id, { combo })} />

              <button
                role="switch"
                aria-checked={b.enabled}
                disabled={!hk.enabled}
                onClick={() => setBinding(b.id, { enabled: !b.enabled })}
                className={cls(
                  'relative h-5 w-9 rounded-full transition flex-shrink-0',
                  !hk.enabled && 'opacity-40 cursor-not-allowed',
                  b.enabled ? 'bg-krypt-gradient shadow-[0_0_8px_rgba(139,124,232,0.45)]' : 'bg-white/10',
                )}
              >
                <span
                  className={cls(
                    'absolute top-0.5 h-4 w-4 rounded-full bg-white transition',
                    b.enabled ? 'left-[18px]' : 'left-0.5',
                  )}
                />
              </button>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-krypt-muted/55 leading-relaxed">
          Hotkeys act on the token currently open and nothing else — there is no key that trades whatever is
          highlighted in a list. They are ignored whenever an input, textarea or search box has focus, so typing a
          number into a filter can never buy.
        </p>
      </Card>
    </Section>
  );
}
