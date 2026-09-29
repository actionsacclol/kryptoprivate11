import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Link2, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { LiquidGlass } from '../LiquidGlass';
import { Card, GhostButton, PrimaryButton, Switch, TextInput } from '../common';
import { useModal } from '../../state/ModalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';
import type { ProfilesView } from '../../../electron/system/profiles';

// Profiles — isolated copies of the app (2026-09-26). Each is its own folder:
// its own settings, wallets, scripts, ledgers and logs. Open one and it runs
// as a separate window beside this one. See shared/profiles.ts.

/** Badge colours by the id the registry stores (PROFILE_COLOURS). */
const COLOUR_CLASS: Record<string, string> = {
  violet: 'border-violet-400/50 bg-violet-500/15 text-violet-200',
  emerald: 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200',
  amber: 'border-amber-400/50 bg-amber-500/15 text-amber-200',
  sky: 'border-sky-400/50 bg-sky-500/15 text-sky-200',
  rose: 'border-rose-400/50 bg-rose-500/15 text-rose-200',
  lime: 'border-lime-400/50 bg-lime-500/15 text-lime-200',
  orange: 'border-orange-400/50 bg-orange-500/15 text-orange-200',
  teal: 'border-teal-400/50 bg-teal-500/15 text-teal-200',
};
const NEUTRAL = 'border-white/15 bg-white/[0.04] text-krypt-muted';
export const profileBadgeClass = (colour: string | null): string => (colour && COLOUR_CLASS[colour]) || NEUTRAL;

/** Fired after this window changes the list, so the top-bar badge follows. */
const PROFILES_CHANGED = 'krypt:profiles-changed';

/** The profiles view, re-read on demand. Null until the first answer. */
export function useProfiles(): { view: ProfilesView | null; refresh: () => Promise<void>; set: (v: ProfilesView) => void } {
  const [view, setView] = useState<ProfilesView | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await window.krypt.profiles.list();
      if (r.ok && r.data) setView(r.data);
    } catch {
      /* an older preload: the panel stays empty rather than throwing */
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Another panel changed the list (create, rename, delete): follow it.
    const on = (): void => void refresh();
    window.addEventListener(PROFILES_CHANGED, on);
    return () => window.removeEventListener(PROFILES_CHANGED, on);
  }, [refresh]);
  return { view, refresh, set: setView };
}

export function ProfilesPanel() {
  const { view, refresh, set } = useProfiles();
  const modal = useModal();
  const toast = useToast();
  const [name, setName] = useState('');
  const [copyWallets, setCopyWallets] = useState(false);
  const [busy, setBusy] = useState(false);

  // Running state changes when another window opens or closes.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (fn: () => Promise<{ ok: boolean; message: string; data?: ProfilesView }>): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      if (r.data) {
        set(r.data);
        window.dispatchEvent(new Event(PROFILES_CHANGED));
      } else void refresh();
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  if (!view) return <Card>Reading profiles…</Card>;
  const locked = view.registryError !== null;
  const full = view.profiles.length - 1 >= view.max;

  const create = async (duplicate: boolean): Promise<void> => {
    const n = name.trim();
    if (!n) {
      toast.warn('Give the new profile a name first.');
      return;
    }
    if (duplicate && copyWallets) {
      const yes = await modal.confirm({
        title: 'Copy your wallets too?',
        message:
          'The new profile will hold the SAME wallets as this one. If both run at once and trade the same wallet, their orders can collide — and each keeps its own ledger, so neither shows the other’s trades. Only do this if you know you want two instances on one wallet.',
        confirmLabel: 'Copy wallets',
        destructive: true,
      });
      if (!yes) return;
    }
    const ok = await run(() => (duplicate ? window.krypt.profiles.duplicate(n, copyWallets) : window.krypt.profiles.create(n)));
    if (ok) {
      setName('');
      setCopyWallets(false);
    }
  };

  const rename = async (id: string, current: string): Promise<void> => {
    const next = await modal.prompt({
      title: 'Rename profile',
      initialValue: current,
      confirmLabel: 'Rename',
      validate: (v) => (v.trim() ? null : 'Give it a name'),
    });
    if (next === null || next.trim() === current) return;
    await run(() => window.krypt.profiles.rename(id, next.trim()));
  };

  const remove = async (id: string, label: string, hasWallets: boolean): Promise<void> => {
    const yes = await modal.confirm({
      title: `Delete "${label}"?`,
      message: hasWallets
        ? `This profile HOLDS WALLETS. Its whole folder — wallets, settings, scripts, history — goes to the Recycle Bin. If any wallet there has funds and no backup elsewhere, export its key first.`
        : 'Its whole folder — settings, scripts, history — goes to the Recycle Bin, where you can still restore it.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    await run(() => window.krypt.profiles.remove(id));
  };

  return (
    <div className="space-y-3">
      {locked && (
        <Card className="text-body text-rose-300">
          The list of profiles could not be read, so nothing can be created, renamed or deleted until it is fixed. Nothing has been overwritten. {view.registryError}
        </Card>
      )}
      <Card className="space-y-2" padded>
        {view.profiles.map((p) => (
          <div key={p.id} className={cls('flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2', p.isCurrent ? 'border-krypt-purple/40 bg-krypt-purple/[0.06]' : 'border-white/8')}>
            <span className={cls('rounded-md border px-2 py-0.5 text-label font-bold uppercase tracking-label', profileBadgeClass(p.colour))}>{p.name}</span>
            <span className="flex-1 text-note text-krypt-muted">
              {p.isCurrent ? 'This window' : p.running ? 'Running' : 'Not running'}
              {p.hasWallets ? ' · has wallets' : ' · no wallets'}
              {!p.isDefault && <span className="font-mono text-krypt-muted/70"> · --profile={p.id}</span>}
            </span>
            {!p.isCurrent && (
              <GhostButton disabled={busy} onClick={() => void run(() => window.krypt.profiles.open(p.id))} className="!py-1 !px-2 text-note">
                <span className="inline-flex items-center gap-1">
                  <ExternalLink className="h-3.5 w-3.5" /> {p.running ? 'Show' : 'Open'}
                </span>
              </GhostButton>
            )}
            {view.canShortcut && (
              <GhostButton disabled={busy} onClick={() => void run(() => window.krypt.profiles.shortcut(p.id))} className="!py-1 !px-2 text-note">
                <span className="inline-flex items-center gap-1" title="Put a shortcut on the desktop that opens this profile directly">
                  <Link2 className="h-3.5 w-3.5" /> Shortcut
                </span>
              </GhostButton>
            )}
            {!p.isDefault && (
              <GhostButton disabled={busy || locked} onClick={() => void rename(p.id, p.name)} className="!py-1 !px-2 text-note">
                <span className="inline-flex items-center gap-1">
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </span>
              </GhostButton>
            )}
            {!p.isDefault && !p.isCurrent && (
              <GhostButton destructive disabled={busy || locked || p.running} onClick={() => void remove(p.id, p.name, p.hasWallets)} className="!py-1 !px-2 text-note">
                <span className="inline-flex items-center gap-1" title={p.running ? 'Close its window first' : 'Move its folder to the Recycle Bin'}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </span>
              </GhostButton>
            )}
          </div>
        ))}
      </Card>

      <Card className="space-y-3">
        <div className="text-body font-semibold text-white">New profile</div>
        <TextInput value={name} onChange={setName} placeholder="Name, e.g. Paper tests" mono={false} />
        <Switch
          checked={copyWallets}
          onChange={setCopyWallets}
          label="When duplicating, also copy wallets"
          description="Off by default. Two instances trading the same wallet can collide, and each keeps its own ledger. Chat-bot tokens and the AI connection are never copied; a copy starts in Paper with every script switched off."
        />
        <div className="flex flex-wrap gap-2">
          <PrimaryButton disabled={busy || locked || full} onClick={() => void create(true)}>
            <span className="inline-flex items-center gap-1.5">
              <Copy className="h-4 w-4" /> Duplicate this profile
            </span>
          </PrimaryButton>
          <GhostButton disabled={busy || locked || full} onClick={() => void create(false)}>
            <span className="inline-flex items-center gap-1.5">
              <Plus className="h-4 w-4" /> Create blank
            </span>
          </GhostButton>
        </div>
        <p className="text-note text-krypt-muted">
          Duplicate copies settings, scripts, order templates, watchlist, alerts and layout. A blank profile starts from scratch, terms and first-run included. Give each profile its own Telegram or Discord bot — one bot can only be read by one of them.
          {full ? ` You have the maximum of ${view.max} profiles.` : ''}
        </p>
      </Card>
    </div>
  );
}

/**
 * The top-bar badge: which profile this window is, and a quick switcher.
 * Hidden entirely while the Default is the only profile, so nothing changes
 * for someone who never makes one.
 */
export function ProfileBadge({ onManage }: { onManage?: () => void }) {
  const { view, refresh } = useProfiles();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, refresh]);

  if (!view || (view.current.isDefault && view.profiles.length <= 1)) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Which profile this window is — click to switch"
        className={cls('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-label font-bold uppercase tracking-label', profileBadgeClass(view.current.colour))}
      >
        <Users className="h-3.5 w-3.5" />
        {view.current.name}
      </button>
      {open && (
        <LiquidGlass surface="sheet" className="absolute right-0 z-50 mt-1 w-60 rounded-lg border border-white/12 p-1">
          {view.profiles.map((p) => (
            <button
              key={p.id}
              disabled={p.isCurrent}
              onClick={() => {
                setOpen(false);
                void window.krypt.profiles.open(p.id).then((r) => (r.ok ? toast.success(r.message) : toast.error(r.message)));
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-note text-white/90 hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-60"
            >
              <span className="truncate">{p.name}</span>
              <span className="text-micro text-krypt-muted">{p.isCurrent ? 'this window' : p.running ? 'running' : 'open'}</span>
            </button>
          ))}
          {onManage && (
            <button
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="mt-1 w-full rounded-md border-t border-white/10 px-2 py-1.5 text-left text-note text-krypt-muted hover:text-white"
            >
              Manage profiles…
            </button>
          )}
        </LiquidGlass>
      )}
    </div>
  );
}
