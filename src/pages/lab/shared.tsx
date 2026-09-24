// Shared plumbing for the wallet pages under Automation — the Wallet list and
// the Funder. Both act on the same data: the wallet list (at most ten —
// groups and the Copier were removed 2026-09-22) and live state (armed or
// not). Everything real-money on those pages goes through the
// signer policy and the trade pipeline; the contract is shared/lab.ts and the
// engine owns the money.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveState, WalletSummary } from '@shared/types';
import { MAX_LAB_WALLETS_PER_CALL } from '@shared/lab';
import { cls } from '../../utils/format';

export const selectCls = 'rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-note text-white';
export const inputCls = 'rounded-md bg-black/40 border border-white/15 px-2 py-1.5 text-note text-white outline-none focus:border-krypt-purple/60';

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-white/10 bg-black/20 px-4 py-3">
      <div>
        <div className="text-sm font-semibold text-white">{label}</div>
        {hint && <div className="text-xs text-krypt-muted mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function countdown(ts: number | null): string {
  if (ts === null) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Re-render on a clock so countdowns and "ago" labels move; 0 = off. */
export function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (ms <= 0) return;
    const id = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** More wallets than one IPC call accepts — the pages disable above it. */
export function tooMany(n: number): string | null {
  return n > MAX_LAB_WALLETS_PER_CALL ? `At most ${MAX_LAB_WALLETS_PER_CALL} wallets per action — hand-pick fewer` : null;
}

export interface LabData {
  wallets: WalletSummary[];
  live: LiveState | null;
  armed: boolean;
  /** Why real-money actions are disabled, or null. */
  armedReason: string | null;
  active: WalletSummary | null;
  /** Every wallet except the active one. */
  others: WalletSummary[];
  balanceOf: Map<string, number | null>;
  labelOf: Map<string, string>;
  busy: string | null;
  setBusy: (b: string | null) => void;
  setWallets: (w: WalletSummary[]) => void;
  reload: () => Promise<void>;
  refreshBalances: () => Promise<void>;
}

export function useLabData(): LabData {
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const armedRef = useRef<boolean | null>(null);
  armedRef.current = live?.armed ?? null;

  const reload = useCallback(async () => {
    const [l, s] = await Promise.all([window.krypt.wallet.list(), window.krypt.live.state()]);
    if (l.ok && l.data) setWallets(l.data);
    if (s.ok && s.data) setLive(s.data);
  }, []);

  useEffect(() => {
    void reload();
    const off = window.krypt.engine.onEvent((ev) => {
      // Arming/disarming changes what these pages may do. The engine pushes
      // status every second; only an actual change is worth a round-trip,
      // and an unchanged answer keeps the same object so nothing re-renders.
      if (ev.kind === 'status') {
        const a = (ev as { status?: { armed?: unknown } }).status?.armed;
        if (typeof a === 'boolean' && a === armedRef.current) return;
        void window.krypt.live.state().then((s) => {
          if (s.ok && s.data) setLive((prev) => (prev && prev.armed === s.data!.armed ? prev : s.data!));
        });
      }
    });
    return () => off();
  }, [reload]);

  const refreshBalances = useCallback(async () => {
    setBusy('refresh');
    try {
      // Every wallet, not just the active one — these pages exist to show
      // what the OTHER wallets hold.
      const r = await window.krypt.wallet.refreshAll();
      if (r.ok && r.data) setWallets(r.data);
      else {
        const l = await window.krypt.wallet.list();
        if (l.ok && l.data) setWallets(l.data);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const armed = live?.armed === true;
  const active = useMemo(() => wallets.find((w) => w.active) ?? null, [wallets]);
  const others = useMemo(() => wallets.filter((w) => !w.active), [wallets]);
  const balanceOf = useMemo(() => new Map(wallets.map((w) => [w.id, w.balanceSol])), [wallets]);
  const labelOf = useMemo(() => new Map(wallets.map((w) => [w.id, w.label])), [wallets]);

  return {
    wallets,
    live,
    armed,
    armedReason: armed ? null : 'Arm live execution on the Wallet page first — this moves real SOL',
    active,
    others,
    balanceOf,
    labelOf,
    busy,
    setBusy,
    setWallets,
    reload,
    refreshBalances,
  };
}

/**
 * `kind` says what the page actually does, because the closing sentence used
 * to promise "the same trade pipeline, platform fee included" on EVERY lab
 * page — and that is false on Funder, where fund and collect are bare
 * SystemProgram transfers with intent 'fund': the signer policy applies, the
 * trade pipeline and the platform fee do not. Telling someone they paid a
 * platform fee they did not pay is the same class of lie as telling them they
 * did not pay one they did.
 */
export function RealMoneyBanner({ armed, what, kind = 'trade' }: { armed: boolean; what: string; kind?: 'trade' | 'transfer' }) {
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-note text-amber-200 leading-relaxed mb-4">
      <span className="font-semibold">Everything on this page moves real SOL between and from your own wallets.</span> {what}{' '}
      {kind === 'trade'
        ? 'Every action goes through the same signer policy and trade pipeline as a manual trade, platform fee included.'
        : 'Every action goes through the same signer policy as a manual trade. These are plain SOL transfers, not trades — no trade pipeline, no platform fee, only the network fee and rent.'}
      {!armed && <span className="block mt-1 text-arc-gold">Live execution is not armed — the actions here are disabled until it is.</span>}
    </div>
  );
}

/**
 * Which wallets a Funder action touches: every wallet but the active one, or
 * a hand-picked set. Returns the resolved wallet ids (never the active wallet).
 */
export function useScope(data: LabData) {
  const [mode, setMode] = useState<'all' | 'pick'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const walletIds = useMemo(() => {
    const activeId = data.active?.id;
    const pool = mode === 'pick' ? data.wallets.filter((w) => picked.has(w.id)) : data.wallets;
    return pool.map((w) => w.id).filter((id) => id !== activeId);
  }, [mode, picked, data.wallets, data.active]);
  const toggle = (id: string): void =>
    setPicked((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return { mode, setMode, picked, toggle, walletIds };
}

export function ScopePicker({
  data,
  scope,
  allLabel = 'All wallets except active',
}: {
  data: LabData;
  scope: ReturnType<typeof useScope>;
  allLabel?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={scope.mode} onChange={(e) => scope.setMode(e.target.value as 'all' | 'pick')} className={selectCls}>
          <option value="all">
            {allLabel} ({data.others.length})
          </option>
          <option value="pick">Pick wallets</option>
        </select>
        <span className="text-body font-mono text-krypt-muted">{scope.walletIds.length} wallet{scope.walletIds.length === 1 ? '' : 's'}</span>
      </div>
      {scope.mode === 'pick' && (
        <div className="flex flex-wrap gap-1.5">
          {data.others.length === 0 ? (
            <span className="text-body text-krypt-muted">No other wallets yet — make some on the Wallet list.</span>
          ) : (
            data.others.map((w) => (
              <label
                key={w.id}
                className={cls(
                  'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-body cursor-pointer transition',
                  scope.picked.has(w.id) ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                )}
              >
                <input type="checkbox" className="accent-krypt-purple" checked={scope.picked.has(w.id)} onChange={() => scope.toggle(w.id)} />
                {w.label}
                <span className="font-mono text-label opacity-70">{w.balanceSol != null ? `${w.balanceSol.toFixed(3)}` : '—'}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
