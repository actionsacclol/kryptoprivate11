// $Krypto Mode sessions — the bots running on coins this install launched.
//
// Every card shows the bot's wallet in full: it is the same address written
// into the coin's description, and the point of showing it is that anyone can
// check it. Numbers the app has not read are a dash, never 0.

import { useCallback, useEffect, useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import {
  DEFAULT_KRYPTO_LIMITS,
  KRYPTO_DRIVER_TEXT,
  KRYPTO_GOAL_TEXT,
  KRYPTO_LIMIT_BOUNDS,
  KRYPTO_LIMIT_TEXT,
  KRYPTO_STRATEGY_TEXT,
  kryptoUnpaced,
  type KryptoDriver,
  type KryptoGoal,
  type KryptoLimits,
  type KryptoSession,
} from '@shared/kryptoMode';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';
import { Empty } from '../common';

const sol = (n: number | null | undefined, dp = 4): string => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(dp)} SOL` : '—');

export function KryptoSessions() {
  const toast = useToast();
  const [sessions, setSessions] = useState<KryptoSession[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.krypt.kryptoMode.list().then((r) => {
      if (!alive) return;
      if (r.ok && r.data) {
        setSessions(r.data.sessions);
        setFailure(r.data.failure);
      } else setSessions([]);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'krypto') setSessions(ev.sessions);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const act = useCallback(
    async (id: string, what: 'pause' | 'resume' | 'goLive' | 'sellAll' | 'withdraw' | 'remove') => {
      setBusy(`${id}:${what}`);
      try {
        const r = await window.krypt.kryptoMode[what](id);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        const l = await window.krypt.kryptoMode.list();
        if (l.ok && l.data) setSessions(l.data.sessions);
      } finally {
        setBusy('');
      }
    },
    [toast],
  );

  if (sessions === null) return <div className="text-body text-krypt-muted">Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-body leading-relaxed text-krypt-muted">
        A Krypto Mode bot trades one coin you launched, from its own wallet, and that wallet is written into the coin’s
        description — anyone can look up what it does. Paper sessions simulate; live sessions trade real SOL from their
        budget through the normal trade path.
      </p>
      {failure && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-body text-rose-200">{failure}</div>}
      {sessions.length === 0 ? (
        <Empty title="No Krypto Mode bots" message="Turn on Krypto Mode on the Launch tab before you pin the metadata, then launch." />
      ) : (
        sessions.map((s) => {
          const value = s.lastPriceSol ? s.tokensHeld * s.lastPriceSol : null;
          const pnl = value !== null ? value - s.netSpentSol : null;
          const b = (w: string) => busy === `${s.id}:${w}`;
          return (
            <div key={s.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-krypt-purple" />
                  <span className="text-note font-semibold text-white">{s.symbol || s.mint.slice(0, 6)}</span>
                  <span className={cls('rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wider', s.mode === 'live' ? 'border-krypt-pink/40 bg-krypt-pink/15 text-white' : 'border-white/15 bg-white/5 text-krypt-muted')}>
                    {s.mode}
                  </span>
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-micro uppercase tracking-wider text-krypt-muted">{s.status}</span>
                </div>
                <span className="text-label text-krypt-muted">
                  {KRYPTO_DRIVER_TEXT[s.driver].label}
                  {s.driver === 'strategy' ? ` · ${KRYPTO_STRATEGY_TEXT[s.strategy].label}` : ` · ${KRYPTO_GOAL_TEXT[s.goal ?? 'position'].label}`}
                  {kryptoUnpaced(s.limits ?? DEFAULT_KRYPTO_LIMITS) ? ' · unpaced' : ''}
                </span>
              </div>
              <div className="mt-1.5 select-all break-all font-mono text-label text-krypt-muted">bot wallet {s.address}</div>
              <div className="select-all break-all font-mono text-label text-krypt-muted/70">coin {s.mint}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-body sm:grid-cols-4">
                <div>
                  <div className="text-label text-krypt-muted">Budget</div>
                  <div className="text-white/90">{sol(s.budgetSol, 3)}</div>
                </div>
                <div>
                  <div className="text-label text-krypt-muted">In use</div>
                  <div className="text-white/90">{sol(s.netSpentSol)}</div>
                </div>
                <div>
                  <div className="text-label text-krypt-muted">Holding worth</div>
                  <div className="text-white/90">{sol(value)}</div>
                </div>
                <div>
                  <div className="text-label text-krypt-muted">Result</div>
                  <div className={cls(pnl === null ? 'text-white/90' : pnl >= 0 ? 'text-emerald-300' : 'text-rose-300')}>{pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`}</div>
                </div>
              </div>
              {s.note && <div className="mt-2 text-label text-krypt-muted">{s.note}</div>}
              {s.trades.length > 0 && (
                <div className="mt-2 max-h-36 space-y-0.5 overflow-auto rounded-lg border border-white/5 bg-black/20 p-2 font-mono text-label">
                  {s.trades.slice(0, 12).map((t) => (
                    <div key={`${t.at}-${t.side}`} className={t.ok ? 'text-white/80' : 'text-rose-300/80'}>
                      {new Date(t.at).toLocaleTimeString()} {t.mode === 'paper' ? 'paper ' : ''}
                      {t.side} {t.side === 'buy' ? sol(t.sol) : `${t.pct ?? '—'}%${t.sol !== null ? ` → ${sol(t.sol)}` : ''}`} · {t.reason}
                      {t.ok ? '' : ` · ${t.message}`}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.status === 'running' && <Btn onClick={() => void act(s.id, 'pause')} busy={b('pause')}>Pause</Btn>}
                {s.status !== 'running' && <Btn onClick={() => void act(s.id, 'resume')} busy={b('resume')}>{s.status === 'stopped' ? 'Start again' : 'Resume'}</Btn>}
                {s.mode === 'paper' && (
                  <Btn onClick={() => void act(s.id, 'goLive')} busy={b('goLive')} strong>
                    Go live (funds {s.budgetSol} SOL from the launch wallet)
                  </Btn>
                )}
                {s.tokensHeld > 0 && <Btn onClick={() => void act(s.id, 'sellAll')} busy={b('sellAll')}>Sell all &amp; stop</Btn>}
                {s.status === 'stopped' && s.mode === 'live' && <Btn onClick={() => void act(s.id, 'withdraw')} busy={b('withdraw')}>Send SOL back to launch wallet</Btn>}
                {s.status === 'stopped' && <Btn onClick={() => void act(s.id, 'remove')} busy={b('remove')}>Remove</Btn>}
                <Btn onClick={() => setEditing(editing === s.id ? null : s.id)} busy={false}>
                  {editing === s.id ? 'Close settings' : 'Settings'}
                </Btn>
              </div>
              {editing === s.id && (
                <SessionSettings
                  key={s.id}
                  s={s}
                  onSaved={() => void window.krypt.kryptoMode.list().then((l) => l.ok && l.data && setSessions(l.data.sessions))}
                />
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * The creator's pacing and goal. Every limit is theirs; 0 turns a pacing
 * limit off. Used on the Launch form and on a running bot.
 */
export function KryptoLimitsFields({
  limits,
  goal,
  driver,
  onChange,
}: {
  limits: KryptoLimits;
  goal: KryptoGoal;
  driver: KryptoDriver;
  onChange: (patch: { limits?: KryptoLimits; goal?: KryptoGoal }) => void;
}) {
  const keys = (Object.keys(KRYPTO_LIMIT_BOUNDS) as (keyof KryptoLimits)[]).filter((k) => k !== 'aiEverySec' || driver === 'ai');
  return (
    <div className="space-y-2">
      {driver !== 'strategy' && (
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(KRYPTO_GOAL_TEXT) as KryptoGoal[]).map((g) => (
            <button
              key={g}
              onClick={() => onChange({ goal: g })}
              className={cls('rounded-lg border px-3 py-2 text-left transition', goal === g ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-white/[0.02] hover:bg-white/5')}
            >
              <span className="block text-body font-semibold text-white/90">{KRYPTO_GOAL_TEXT[g].label}</span>
              <span className="block text-label leading-relaxed text-krypt-muted">{KRYPTO_GOAL_TEXT[g].help}</span>
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {keys.map((k) => (
          <label key={k} className="block">
            <span className="block text-label text-krypt-muted">{KRYPTO_LIMIT_TEXT[k].label}</span>
            <input
              type="number"
              min={KRYPTO_LIMIT_BOUNDS[k][0]}
              max={KRYPTO_LIMIT_BOUNDS[k][1]}
              value={limits[k]}
              onChange={(e) => onChange({ limits: { ...limits, [k]: Math.max(KRYPTO_LIMIT_BOUNDS[k][0], Math.round(Number(e.target.value) || 0)) } })}
              className="mt-0.5 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-body text-white/90 outline-none focus:border-krypt-purple/50"
            />
            <span className="block text-micro text-krypt-muted/70">{KRYPTO_LIMIT_TEXT[k].help}</span>
          </label>
        ))}
      </div>
      {kryptoUnpaced(limits) && (
        <p className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-2 text-label leading-relaxed text-amber-100/85">
          No pacing: the bot can trade as fast as it decides. The wallet is still named in the description, but trading
          at that speed to move the price is what regulators and pump.fun&apos;s terms treat as manipulation, and that
          risk is the launcher&apos;s. Your call.
        </p>
      )}
    </div>
  );
}

function SessionSettings({ s, onSaved }: { s: KryptoSession; onSaved: () => void }) {
  const toast = useToast();
  const [limits, setLimits] = useState<KryptoLimits>(s.limits ?? DEFAULT_KRYPTO_LIMITS);
  const [goal, setGoal] = useState<KryptoGoal>(s.goal ?? 'position');
  const [budget, setBudget] = useState<number>(s.budgetSol);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await window.krypt.kryptoMode.setLimits(s.id, { limits, goal, budgetSol: budget });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-white/10 bg-black/20 p-2.5">
      <label className="block">
        <span className="block text-label text-krypt-muted">Budget (SOL)</span>
        <input
          type="number"
          step="0.01"
          value={budget}
          onChange={(e) => setBudget(Number(e.target.value))}
          className="mt-0.5 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-body text-white/90 outline-none focus:border-krypt-purple/50"
        />
        {s.mode === 'live' && <span className="block text-micro text-krypt-muted/70">Live: the wallet only holds what was funded; a bigger budget reaches as far as its SOL does.</span>}
      </label>
      <KryptoLimitsFields
        limits={limits}
        goal={goal}
        driver={s.driver}
        onChange={(p) => {
          if (p.limits) setLimits(p.limits);
          if (p.goal) setGoal(p.goal);
        }}
      />
      <Btn onClick={() => void save()} busy={saving} strong>
        Save settings
      </Btn>
    </div>
  );
}

function Btn({ children, onClick, busy, strong }: { children: React.ReactNode; onClick: () => void; busy: boolean; strong?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={cls(
        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-body transition disabled:opacity-40',
        strong ? 'border-krypt-pink/40 bg-krypt-pink/15 text-white hover:bg-krypt-pink/25' : 'border-white/10 bg-white/5 text-white/90 hover:bg-white/10',
      )}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}
