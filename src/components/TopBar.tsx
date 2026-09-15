import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Home } from 'lucide-react';
import { EVM_CHAIN_META, isEvmChain, nativeSymbolOf, type ChainKind, type EvmChainKind } from '@shared/evm';
import { useAppState } from '../state/AppStateProvider';
import { useTerminal } from '../state/TerminalProvider';
import { useEvmState } from '../state/useEvmState';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';
import { cls, shortAddr } from '../utils/format';
import { fmtNative } from '../utils/evm';

// The command rail. Left: search and the app-wide CHAIN SWITCH — Solana |
// Robinhood | BNB. Every terminal screen (Discover, the token page, the
// wallet readout, Paper/Live) follows it; each chain is its own instance
// with its own wallet balance, arm state and pages. Right: this chain's
// Paper/Live and this chain's wallet.
//
// Each piece subscribes to the terminal context ITSELF, so the bar as a
// whole does not re-render on every Discover poll — only the small
// components that read the chain do.

const CHAIN_LABEL: Record<ChainKind, string> = { solana: 'Solana', robinhood: 'Robinhood', bnb: 'BNB' };
const CHAIN_ON: Record<ChainKind, string> = {
  solana: 'bg-krypt-purple/25 text-white',
  robinhood: 'bg-emerald-500/20 text-emerald-200',
  bnb: 'bg-amber-400/20 text-amber-200',
};
const CHAIN_TITLE: Record<ChainKind, string> = {
  solana: 'Solana — pump.fun, LaunchLab, Meteora and the rest, priced in SOL',
  robinhood: 'Robinhood Chain — Pons launches and Uniswap pools, priced in ETH',
  bnb: 'BNB Smart Chain — four.meme launches and PancakeSwap pools, priced in BNB',
};

function ChainSwitch() {
  const { chain, setChain } = useTerminal();
  const { settings } = useAppState();
  const enabled = (c: ChainKind): boolean => (c === 'solana' ? true : settings.evm[c].enabled);
  const segments = (['solana', 'robinhood', 'bnb'] as ChainKind[]).filter(enabled);

  // A chain that was switched off in Settings while selected falls back to
  // Solana — a header for a chain that is hidden everywhere else is a trap.
  useEffect(() => {
    if (!enabled(chain)) setChain('solana');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, settings.evm.robinhood.enabled, settings.evm.bnb.enabled]);

  if (segments.length < 2) return null;
  return (
    <div className="inline-flex rounded-lg border border-white/12 overflow-hidden text-label font-bold uppercase tracking-label">
      {segments.map((c) => (
        <button
          key={c}
          onClick={() => setChain(c)}
          title={CHAIN_TITLE[c]}
          className={cls('px-3 py-1.5 transition', chain === c ? CHAIN_ON[c] : 'text-krypt-muted hover:text-white')}
        >
          {CHAIN_LABEL[c]}
        </button>
      ))}
    </div>
  );
}

/**
 * The ONE trading-mode control for the selected chain. On Solana it is the
 * engine's Paper/Live (arm + broadcast); on an EVM chain it arms that chain's
 * rail and nothing else. Switching the chain never arms or disarms anything.
 */
function ModeToggle() {
  const { chain } = useTerminal();
  const { status } = useAppState();
  const modal = useModal();
  const toast = useToast();
  const evmChain: EvmChainKind | null = isEvmChain(chain) ? chain : null;
  const { evm, refresh } = useEvmState(evmChain);
  const live = evmChain ? evm?.live.armed === true : status.liveActive;
  // On an EVM chain a null state means the rail has not answered yet — the
  // pills show it as "…" rather than asserting Paper.
  const evmLoading = evmChain !== null && evm === null;
  const unit = nativeSymbolOf(chain);

  const setMode = async (wantLive: boolean): Promise<void> => {
    if (wantLive === live) return;
    if (evmChain) {
      const meta = EVM_CHAIN_META[evmChain];
      if (evm === null) {
        toast.warn('Still reading the EVM wallet — try again in a moment.');
        return;
      }
      if (wantLive) {
        if (evm.wallet.exists !== true) {
          toast.warn(`Create an EVM wallet on the Wallet page before going Live on ${meta.name}.`);
          return;
        }
        const yes = await modal.confirm({
          title: `Go Live on ${meta.name}`,
          message: `Live signs and broadcasts REAL transactions from your EVM wallet on ${meta.name}. Every trade is still simulated and policy-checked before it sends — but real ${unit} moves. Switch to Live?`,
          confirmLabel: 'Go Live',
          destructive: true,
        });
        if (!yes) return;
        const r = await window.krypt.evm.arm(evmChain);
        r.ok ? toast.warn(r.message) : toast.error(r.message);
      } else {
        const r = await window.krypt.evm.disarm(evmChain);
        r.ok ? toast.success(r.message) : toast.error(r.message);
      }
      void refresh();
      return;
    }
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
    <div
      className="inline-flex rounded-lg border border-white/12 overflow-hidden text-label font-bold uppercase tracking-label"
      title={evmLoading ? `Reading the ${CHAIN_LABEL[chain]} rail…` : `Paper / Live for ${CHAIN_LABEL[chain]} — each chain is armed on its own`}
    >
      <button
        onClick={() => void setMode(false)}
        className={cls('px-3 py-1.5 transition', !live && !evmLoading ? 'bg-emerald-500/20 text-emerald-200' : 'text-krypt-muted hover:text-white')}
      >
        {evmLoading ? '…' : 'Paper'}
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
      <div className="text-micro font-display uppercase tracking-label text-krypt-muted/70">{label}</div>
      <div className={cls(
        'text-xs font-mono tabular-nums',
        tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-white/90',
      )}>{value}</div>
    </div>
  );
}

/** Balance + address of the selected chain's wallet. */
function WalletReadout() {
  const { chain } = useTerminal();
  const { status } = useAppState();
  const evmChain: EvmChainKind | null = isEvmChain(chain) ? chain : null;
  const { evm, refresh } = useEvmState(evmChain);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [walletSol, setWalletSol] = useState<number | null>(null);

  // Solana: identity + balance for the command rail; the engine status
  // carries a fresher balance while live trading is active.
  //
  // While the engine runs, `status.walletBalanceSol` arrives every second and
  // wins below — so the poll skips its RPC read then, and runs at 60 s
  // otherwise (it only has to notice a deposit, not a trade).
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    let alive = true;
    const refreshSol = (force = false): void => {
      const st = statusRef.current;
      const engineHasBalance = st.running && st.walletBalanceSol !== null && st.walletBalanceSol !== undefined;
      void window.krypt.wallet.info().then((r) => {
        if (!alive || !r.ok || !r.data) return;
        setWalletAddr(r.data.publicKey);
        if (force || !engineHasBalance) setWalletSol(r.data.balanceSol);
      });
    };
    refreshSol(true);
    const t = setInterval(() => refreshSol(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // EVM: the selected chain's balance, re-read every 30 s while it is
  // selected; `evmState` pushes for that chain land through the hook.
  useEffect(() => {
    if (!evmChain) return;
    let alive = true;
    const tick = (): void => {
      void window.krypt.evm.wallet.refreshBalance(evmChain).then(() => {
        if (alive) void refresh();
      });
    };
    tick();
    const t = setInterval(() => {
      if (!document.hidden) tick();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [evmChain, refresh]);

  if (evmChain) {
    const bal = evm?.wallet.balanceNative ?? null;
    const addr = evm?.wallet.address ?? null;
    // fmtNative keeps small balances honest: 0.00004 ETH is not "0.0000".
    return (
      <>
        <Readout label="Balance" value={evm === null ? '…' : fmtNative(bal, nativeSymbolOf(evmChain))} />
        {addr && <Readout label="Wallet" value={shortAddr(addr, 4)} />}
      </>
    );
  }

  // The engine's figure is freshest while it is polling (running); once
  // stopped it goes stale and the direct wallet refresh should win.
  const balance = status.running ? status.walletBalanceSol ?? walletSol : walletSol ?? status.walletBalanceSol;
  return (
    <>
      <Readout label="Balance" value={balance != null ? `${balance.toFixed(3)} SOL` : '—'} />
      {walletAddr && <Readout label="Wallet" value={shortAddr(walletAddr, 4)} />}
    </>
  );
}

export function TopBar({ search, onOpenAutomation, onOpenRunners, onHub }: { search?: ReactNode; onOpenAutomation: () => void; onOpenRunners?: () => void; onHub?: () => void }) {
  const { status, runners } = useAppState();
  const recentRunners = runners.filter((r) => Date.now() - r.flaggedAt < 3_600_000).length;

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-white/10 bg-krypt-void/95">
      <div className="flex items-center gap-2.5">
        {/* The way back, on every page. The sidebar has one too; this is the
            one a user finds without looking for it. */}
        {onHub && (
          <>
            <button
              onClick={onHub}
              title="Back to the Hub"
              className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-note font-medium text-krypt-muted transition hover:border-krypt-purple/40 hover:bg-krypt-purple/10 hover:text-white"
            >
              <Home className="h-3.5 w-3.5" />
              Hub
            </button>
            <Divider />
          </>
        )}
        {search}
        {search && <Divider />}
        <ChainSwitch />

        {/* Engine controls moved to AutomationBar — this is a terminal first,
            and a permanent "Start scanning" button above a chart is noise at
            best. What stays is AWARENESS: a chip whenever the automation is
            actually doing something, because a bot spending money must never
            be invisible. It navigates to where the controls now live. */}
        {(status.running || status.openPositions > 0) && (
          <>
            <Divider />
            <button
              onClick={onOpenAutomation}
              title="The scanner is watching launches and flags potential runners — it never trades. Open the Observatory."
              // This pill describes the SCANNER, which is paper by construction;
              // the Paper/Live switch beside it is the only real-money control.
              className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-1.5 text-note font-semibold text-krypt-pink transition hover:bg-krypt-purple/20"
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
            className="inline-flex items-center gap-2 rounded-lg border border-arc-gold/40 bg-arc-gold/10 px-3 py-1.5 text-note font-semibold text-arc-gold transition hover:bg-arc-gold/20"
          >
            <span className="h-1.5 w-1.5 rounded-full animate-pulse-slow bg-arc-gold" />
            {recentRunners} runner{recentRunners === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <ModeToggle />
        <Divider />
        <WalletReadout />
      </div>
    </div>
  );
}
