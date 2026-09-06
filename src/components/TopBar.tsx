import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';
import { cls, shortAddr } from '../utils/format';

/**
 * The ONE trading-mode control. Paper (safe, simulated) or Live (real SOL).
 * This replaces the old arm + enable-broadcast + simulate toggles — there is
 * one switch, and it means exactly what it says.
 */
function ModeToggle() {
  const { status } = useAppState();
  const modal = useModal();
  const toast = useToast();
  const live = status.liveActive;

  const setMode = async (wantLive: boolean): Promise<void> => {
    if (wantLive === live) return;
    if (wantLive) {
      const yes = await modal.confirm({
        title: 'Switch to Live trading',
        message:
          'Live mode signs and broadcasts REAL transactions from your funded wallet. Every trade is still simulated and loss-bounded before it sends — but real SOL moves. Switch to Live?',
        confirmLabel: 'Go Live',
        destructive: true,
      });
      if (!yes) return;
    }
    const r = await window.krypt.live.setLive(wantLive);
    if (r.ok) toast[wantLive ? 'warn' : 'success'](r.message);
    else toast.error(r.message);
  };

  return (
    <div className="inline-flex rounded-lg border border-white/12 overflow-hidden text-[10px] font-bold uppercase tracking-[0.14em]">
      <button
        onClick={() => void setMode(false)}
        className={cls('px-3 py-1.5 transition', !live ? 'bg-emerald-500/20 text-emerald-200' : 'text-krypt-muted hover:text-white')}
      >
        Paper
      </button>
      <button
        onClick={() => void setMode(true)}
        className={cls('px-3 py-1.5 transition', live ? 'bg-rose-500/25 text-rose-200 shadow-crimson-glow' : 'text-krypt-muted hover:text-white')}
      >
        Live
      </button>
    </div>
  );
}

function Divider() {
  return <div className="h-6 w-px bg-gradient-to-b from-transparent via-white/15 to-transparent" aria-hidden="true" />;
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="text-right leading-tight" title={label}>
      <div className="text-[9px] font-display uppercase tracking-[0.24em] text-krypt-muted/70">{label}</div>
      <div className={cls(
        'text-xs font-mono tabular-nums',
        tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-white/90',
      )}>{value}</div>
    </div>
  );
}

export function TopBar({ search, onOpenAutomation, onOpenRunners }: { search?: ReactNode; onOpenAutomation: () => void; onOpenRunners?: () => void }) {
  const { status, runners } = useAppState();
  const recentRunners = runners.filter((r) => Date.now() - r.flaggedAt < 3_600_000).length;
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [walletSol, setWalletSol] = useState<number | null>(null);

  // Wallet identity + balance for the command rail; the engine status carries a
  // fresher balance while live trading is active.
  //
  // While the engine runs, `status.walletBalanceSol` arrives every second and
  // wins below — so the poll skips its RPC read then, and runs at 60 s
  // otherwise (it only has to notice a deposit, not a trade).
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    let alive = true;
    const refresh = (force = false): void => {
      const st = statusRef.current;
      // The ADDRESS is always re-read: it comes from the cached wallet info,
      // costs no RPC call, and showing the previous wallet after a switch is
      // worse than any saving. Only the BALANCE defers to the engine while it
      // is running and reporting one.
      const engineHasBalance = st.running && st.walletBalanceSol !== null && st.walletBalanceSol !== undefined;
      void window.krypt.wallet.info().then((r) => {
        if (!alive || !r.ok || !r.data) return;
        setWalletAddr(r.data.publicKey);
        if (force || !engineHasBalance) setWalletSol(r.data.balanceSol);
      });
    };
    refresh(true);
    const t = setInterval(() => refresh(), 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // The engine's figure is freshest while it is polling (running); once
  // stopped it goes stale and the direct wallet refresh should win.
  const balance = status.running ? status.walletBalanceSol ?? walletSol : walletSol ?? status.walletBalanceSol;

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-white/10 bg-krypt-void/95">
      <div className="flex items-center gap-2.5">
        {search}

        {/* Engine controls moved to AutomationBar — this is a terminal first,
            and a permanent "Start scanning" button above a chart is noise at
            best. What stays is AWARENESS: a chip whenever the automation is
            actually doing something, because a bot spending money must never
            be invisible. It navigates to where the controls now live. */}
        {(status.running || status.openPositions > 0) && (
          <>
            {search && <Divider />}
            <button
              onClick={onOpenAutomation}
              title="The scanner is watching launches and flags potential runners — it never trades. Open the Observatory."
              // This pill describes the SCANNER, which is paper by construction;
              // the Paper/Live switch beside it is the only real-money control.
              // It used to turn red and say "Live trading" whenever manual mode
              // was armed, which read as the scanner spending real SOL.
              className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-1.5 text-[12px] font-semibold text-krypt-pink transition hover:bg-krypt-purple/20"
            >
              <span className="h-1.5 w-1.5 rounded-full animate-pulse-slow bg-krypt-pink" />
              {status.running ? 'Scanning' : 'Paper positions'}
              {status.openPositions > 0 && <span className="font-mono text-white/80">{status.openPositions}</span>}
              {status.running && status.entriesPaused && (
                <span className="text-amber-300" title={status.pauseReason ?? ''}>
                  · paused
                </span>
              )}
            </button>
          </>
        )}
        {recentRunners > 0 && (
          <button
            onClick={onOpenRunners}
            title="Launches the scanner flagged as potential runners in the last hour — measured graduation odds, never a purchase. Open the list."
            className="inline-flex items-center gap-2 rounded-lg border border-arc-gold/40 bg-arc-gold/10 px-3 py-1.5 text-[12px] font-semibold text-arc-gold transition hover:bg-arc-gold/20"
          >
            <span className="h-1.5 w-1.5 rounded-full animate-pulse-slow bg-arc-gold" />
            {recentRunners} runner{recentRunners === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <ModeToggle />
        <Divider />
        <Readout label="Balance" value={balance != null ? `${balance.toFixed(3)} SOL` : '—'} />
        {walletAddr && <Readout label="Wallet" value={shortAddr(walletAddr, 4)} />}
      </div>
    </div>
  );
}
