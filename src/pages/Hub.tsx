// The Hub — what the app opens on.
//
// Before this, a stranger's first screen was Discover with twenty-five items
// in one sidebar, and no way to tell that "Warmer" and "Orders" belong to
// completely different jobs. The Hub asks one question instead: what are you
// here to do. Each card is a workspace, and each card says what is actually
// true about it right now rather than a static blurb — an engine that is not
// running says so, and copy trading with nothing set up says that too.
//
// Status lines are honest: unknown renders as an em dash, never 0, and a
// number is only shown when it was actually read.

import { useEffect, useState } from 'react';
import { Compass, Cpu, Gauge, Gift, LayoutGrid, Rocket, Settings as SettingsIcon, Users, Wallet, ZapOff, type LucideIcon } from 'lucide-react';
import { WORKSPACES, type WorkspaceId, type WorkspaceSpec } from '../workspaces';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { KryptoCard } from '../components/KryptoCard';

const ICONS: Record<WorkspaceSpec['icon'], LucideIcon> = {
  compass: Compass,
  users: Users,
  cpu: Cpu,
  wallet: Wallet,
  gift: Gift,
  scout: Users,
  launch: Rocket,
  layout: LayoutGrid,
  settings: SettingsIcon,
};

interface CardStatus {
  /** Short line under the title. Null = nothing worth saying. */
  line: string | null;
  tone: 'live' | 'idle' | 'warn';
}

export function Hub({ onOpen, onOpenToken }: { onOpen: (id: WorkspaceId) => void; onOpenToken: (mint: string) => void }) {
  const { status, positions, settings, updateSettings } = useAppState();
  const toast = useToast();
  const [copyCount, setCopyCount] = useState<number | null>(null);
  const [walletCount, setWalletCount] = useState<number | null>(null);
  const [liteBusy, setLiteBusy] = useState(false);

  // "Laggy?" — Lite mode. The same switch as Settings › Display "Reduce
  // effects", put where someone on a slow machine will actually look: the
  // first screen, bottom right, before they have found Settings.
  const lite = settings.reduceEffects;
  const toggleLite = async (): Promise<void> => {
    setLiteBusy(true);
    try {
      await updateSettings({ reduceEffects: !lite });
      toast.success(!lite ? 'Lite mode on — animations, blur and the 3D scenes are off.' : 'Lite mode off — effects are back.');
    } catch (err) {
      toast.error(`Could not save: ${(err as Error).message}`);
    } finally {
      setLiteBusy(false);
    }
  };

  // Read once on mount. These are cheap main-process reads and the Hub is not
  // a live surface — a stale count here is not worth a subscription.
  useEffect(() => {
    let alive = true;
    // `copy.list()` answers with a CopySnapshot OBJECT, not an array — the
    // followed wallets are in `configs`. Guarding on Array.isArray was never
    // true, so this card showed an em dash forever: the dash is supposed to
    // mean "we could not read it", and here it meant "read fine, guarded
    // wrong". tsc cannot see it because Array.isArray narrows any[].
    void window.krypt.copy
      .list()
      .then((r) => {
        if (alive && r.ok && r.data && Array.isArray(r.data.configs)) setCopyCount(r.data.configs.length);
      })
      .catch(() => undefined);
    void window.krypt.wallet
      .list()
      .then((r) => {
        if (alive && r.ok && Array.isArray(r.data)) setWalletCount(r.data.length);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const statusFor = (w: WorkspaceSpec): CardStatus => {
    switch (w.id) {
      case 'terminal': {
        // The engine emits a positionUpdate with state 'closed' on every close
        // and the provider keeps the row, so `positions` is open AND closed for
        // the session. Counting it raw made "N open positions" climb all day
        // and never come down. Positions.tsx and Dashboard.tsx both filter;
        // this was the only reader that did not.
        const open = positions.filter((p) => p.state !== 'closed').length;
        return { line: open > 0 ? `${open} open position${open === 1 ? '' : 's'}` : 'Ready', tone: open > 0 ? 'live' : 'idle' };
      }
      case 'copy':
        if (copyCount === null) return { line: '—', tone: 'idle' };
        return copyCount > 0
          ? { line: `${copyCount} wallet${copyCount === 1 ? '' : 's'} followed`, tone: 'live' }
          : { line: 'Not set up', tone: 'idle' };
      case 'engine':
        return status.running
          ? { line: `Scanning — ${status.launchesSeen} launches seen`, tone: 'live' }
          : { line: 'Stopped', tone: 'idle' };
      case 'wallets':
        if (walletCount === null) return { line: '—', tone: 'idle' };
        return { line: `${walletCount} wallet${walletCount === 1 ? '' : 's'}`, tone: walletCount > 0 ? 'live' : 'idle' };
      default:
        return { line: null, tone: 'idle' };
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          <span className="text-krypt-purple">$Krypto</span> Bot
        </h1>
        <p className="mt-2 text-[13px] text-krypt-muted">Pick what you are here to do.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {WORKSPACES.map((w) => {
          const Icon = ICONS[w.icon];
          const st = statusFor(w);
          return (
            <button
              key={w.id}
              onClick={() => w.ready && onOpen(w.id)}
              disabled={!w.ready}
              className="group flex flex-col items-start gap-3 rounded-xl border border-white/10 bg-krypt-panel p-5 text-left shadow-krypt-card transition hover:border-krypt-purple/50 hover:shadow-krypt-glow disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex w-full items-start justify-between">
                <span className="rounded-lg border border-white/10 bg-white/5 p-2 text-krypt-pink">
                  <Icon className="h-5 w-5" />
                </span>
                {w.ready ? (
                  st.line && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] ${
                        st.tone === 'live'
                          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                          : st.tone === 'warn'
                            ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                            : 'border-white/10 bg-white/5 text-krypt-muted'
                      }`}
                    >
                      {st.line}
                    </span>
                  )
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-krypt-muted">soon</span>
                )}
              </div>
              <div>
                <div className="text-[15px] font-semibold text-white">{w.title}</div>
                <div className="mt-1 text-[12px] leading-relaxed text-krypt-muted">{w.blurb}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Renders only once shared/krypto.ts carries a real mint. */}
      <KryptoCard onOpenToken={onOpenToken} />

      {/* Bottom right, fixed: findable from the first screen without knowing
          Settings exists. It says what it will do, not just "performance". */}
      <button
        onClick={() => void toggleLite()}
        disabled={liteBusy}
        title={
          lite
            ? 'Lite mode is on: no animations, blur or 3D scenes. Click to turn effects back on. Also in Settings › Display.'
            : 'Slow or stuttering? Lite mode turns off every animation, blur and the 3D scenes so the app is as light as it gets. Also in Settings › Display.'
        }
        className={`fixed bottom-4 right-4 z-20 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${
          lite
            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:border-emerald-400/60'
            : 'border-white/10 bg-krypt-panel text-krypt-muted hover:border-krypt-purple/50 hover:text-white'
        }`}
      >
        {lite ? <ZapOff className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
        {lite ? 'Lite mode on' : 'Laggy? Lite mode'}
      </button>
    </div>
  );
}
