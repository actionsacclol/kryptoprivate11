// Shared plumbing for the four wallet pages under Automation — Wallet
// Creator, Funder, Warmer, Copier (2026-09-03). Each page acts on the same
// data: the wallet list, the groups (with their lab settings), live state
// (armed or not) and the warmer runs. Everything real-money on those pages
// goes through the signer policy and the trade pipeline; the contract is
// shared/lab.ts and the engine owns the money.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveState, WalletGroupView, WalletSummary } from '@shared/types';
import { MAX_LAB_WALLETS_PER_CALL, type RandomRunStatus } from '@shared/lab';
import { cls } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

export const selectCls = 'rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white';
export const inputCls = 'rounded-md bg-black/40 border border-white/15 px-2 py-1.5 text-[12px] text-white outline-none focus:border-krypt-purple/60';

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
  return n > MAX_LAB_WALLETS_PER_CALL ? `At most ${MAX_LAB_WALLETS_PER_CALL} wallets per action — pick a smaller group or hand-pick` : null;
}

export interface LabData {
  wallets: WalletSummary[];
  groups: WalletGroupView[];
  live: LiveState | null;
  runs: RandomRunStatus[];
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
  setRuns: React.Dispatch<React.SetStateAction<RandomRunStatus[]>>;
  /** Apply an IPC result that carries the group list; toast on failure. */
  applyGroups: (r: { ok: boolean; message: string; data?: WalletGroupView[] }) => void;
  reload: () => Promise<void>;
  refreshBalances: () => Promise<void>;
}

export function useLabData(): LabData {
  const toast = useToast();
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [groups, setGroups] = useState<WalletGroupView[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [runs, setRuns] = useState<RandomRunStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const armedRef = useRef<boolean | null>(null);
  armedRef.current = live?.armed ?? null;

  const reload = useCallback(async () => {
    const [l, g, s, r] = await Promise.all([
      window.krypt.wallet.list(),
      window.krypt.wallet.groups(),
      window.krypt.live.state(),
      window.krypt.lab.status(),
    ]);
    if (l.ok && l.data) setWallets(l.data);
    if (g.ok && g.data) setGroups(g.data);
    if (s.ok && s.data) setLive(s.data);
    if (r.ok && r.data) setRuns(r.data);
  }, []);

  useEffect(() => {
    void reload();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'lab') setRuns(ev.runs);
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

  const applyGroups = useCallback(
    (r: { ok: boolean; message: string; data?: WalletGroupView[] }): void => {
      if (r.ok && r.data) setGroups(r.data);
      else if (!r.ok) toast.error(r.message);
    },
    [toast],
  );

  const armed = live?.armed === true;
  const active = useMemo(() => wallets.find((w) => w.active) ?? null, [wallets]);
  const others = useMemo(() => wallets.filter((w) => !w.active), [wallets]);
  const balanceOf = useMemo(() => new Map(wallets.map((w) => [w.id, w.balanceSol])), [wallets]);
  const labelOf = useMemo(() => new Map(wallets.map((w) => [w.id, w.label])), [wallets]);

  return {
    wallets,
    groups,
    live,
    runs,
    armed,
    armedReason: armed ? null : 'Arm live execution on the Wallet page first — this moves real SOL',
    active,
    others,
    balanceOf,
    labelOf,
    busy,
    setBusy,
    setWallets,
    setRuns,
    applyGroups,
    reload,
    refreshBalances,
  };
}

/** Group balance = sum of known member balances; null when none is known. */
export function groupBalance(g: WalletGroupView, balanceOf: Map<string, number | null>): number | null {
  let sum = 0;
  let known = false;
  for (const m of g.members) {
    const b = balanceOf.get(m.id);
    if (typeof b === 'number') {
      sum += b;
      known = true;
    }
  }
  return known ? sum : null;
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
    <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200 leading-relaxed mb-4">
      <span className="font-semibold">Everything on this page moves real SOL between and from your own wallets.</span> {what}{' '}
      {kind === 'trade'
        ? 'Every action goes through the same signer policy and trade pipeline as a manual trade, platform fee included.'
        : 'Every action goes through the same signer policy as a manual trade. These are plain SOL transfers, not trades — no trade pipeline, no platform fee, only the network fee and rent.'}
      {!armed && <span className="block mt-1 text-arc-gold">Live execution is not armed — the actions here are disabled until it is.</span>}
    </div>
  );
}

/**
 * Scope picker used by Funder and Copier: a group, or a hand-picked set of
 * wallets. Returns the resolved wallet ids (never the active wallet).
 */
export function useScope(data: LabData) {
  const [mode, setMode] = useState<'group' | 'pick'>('group');
  const [groupId, setGroupId] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const walletIds = useMemo(() => {
    const activeId = data.active?.id;
    if (mode === 'pick') return [...picked].filter((id) => id !== activeId && data.wallets.some((w) => w.id === id));
    // '' means every wallet; a group id that no longer resolves (deleted
    // meanwhile) means NOTHING, never silently everything.
    const g = data.groups.find((x) => x.id === groupId);
    const ids = groupId ? (g ? g.members.map((m) => m.id) : []) : data.wallets.map((w) => w.id);
    return ids.filter((id) => id !== activeId);
  }, [mode, groupId, picked, data.groups, data.wallets, data.active]);
  const toggle = (id: string): void =>
    setPicked((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return { mode, setMode, groupId, setGroupId, picked, toggle, walletIds };
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
  const activeId = data.active?.id;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={scope.mode} onChange={(e) => scope.setMode(e.target.value as 'group' | 'pick')} className={selectCls}>
          <option value="group">By group</option>
          <option value="pick">Pick wallets</option>
        </select>
        {scope.mode === 'group' && (
          <select value={scope.groupId} onChange={(e) => scope.setGroupId(e.target.value)} className={selectCls}>
            <option value="">{allLabel} ({data.others.length})</option>
            {data.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.members.filter((m) => m.id !== activeId).length})
              </option>
            ))}
          </select>
        )}
        <span className="text-[11px] font-mono text-krypt-muted">{scope.walletIds.length} wallet{scope.walletIds.length === 1 ? '' : 's'}</span>
      </div>
      {scope.mode === 'pick' && (
        <div className="flex flex-wrap gap-1.5">
          {data.others.length === 0 ? (
            <span className="text-[11px] text-krypt-muted">No other wallets yet — create some in Group Wallets.</span>
          ) : (
            data.others.map((w) => (
              <label
                key={w.id}
                className={cls(
                  'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] cursor-pointer transition',
                  scope.picked.has(w.id) ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                )}
              >
                <input type="checkbox" className="accent-krypt-purple" checked={scope.picked.has(w.id)} onChange={() => scope.toggle(w.id)} />
                {w.label}
                <span className="font-mono text-[10px] opacity-70">{w.balanceSol != null ? `${w.balanceSol.toFixed(3)}` : '—'}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
