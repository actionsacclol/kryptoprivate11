import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Home } from 'lucide-react';
import { EVM_CHAIN_META, isEvmChain, nativeSymbolOf, type ChainKind, type EvmChainKind } from '@shared/evm';
import { useAppState } from '../state/AppStateProvider';
import { useTerminal } from '../state/TerminalProvider';
import { useEvmState } from '../state/useEvmState';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';
import { cls, fmtAgo, fmtUsd, shortAddr } from '../utils/format';
import { useLocale } from '../state/useLocale';
import { fmtNative } from '../utils/evm';
import { AIO_CHAIN_LABEL, type AioBalances } from '@shared/aio';
import { ProfileBadge } from './terminal/ProfilesPanel';

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
  const { chain, setChain, allChains, setAllChains } = useTerminal();
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
    <div className="glass-btn inline-flex rounded-lg border border-white/12 text-label font-bold uppercase tracking-label">
      {segments.map((c) => (
        <button
          key={c}
          onClick={() => {
            setAllChains(false);
            setChain(c);
          }}
          title={CHAIN_TITLE[c]}
          className={cls('px-3 py-1.5 transition', !allChains && chain === c ? CHAIN_ON[c] : 'text-krypt-muted hover:text-white')}
        >
          {CHAIN_LABEL[c]}
        </button>
      ))}
      <button
        onClick={() => setAllChains(true)}
        title="Every chain at once — the All-in-One wallet's total in dollars, and one Paper/Live for all of them"
        className={cls(
          'px-3 py-1.5 transition',
          allChains ? 'bg-gradient-to-r from-violet-500/25 via-amber-400/20 to-emerald-400/25 text-white' : 'text-krypt-muted hover:text-white',
        )}
      >
        All
      </button>
    </div>
  );
}

/**
 * The ONE trading-mode control for the selected chain. On Solana it is the
 * engine's Paper/Live (arm + broadcast); on an EVM chain it arms that chain's
 * rail and nothing else. Switching the chain never arms or disarms anything.
 */
function ModeToggle() {
  const { allChains } = useTerminal();
  return allChains ? <AllModeToggle /> : <ChainModeToggle />;
}

/**
 * Paper/Live for EVERY chain at once — what "ALL" means for the one control
 * that moves money. Each chain still arms on its own rail with its own rules
 * (and its own wallet check); this only presses all of them, and the label
 * says plainly when they disagree ("Live 2/3").
 */
function AllModeToggle() {
  const { t } = useLocale();
  const { status, settings } = useAppState();
  const modal = useModal();
  const toast = useToast();
  const hood = useEvmState('robinhood');
  const bsc = useEvmState('bnb');
  const evmOf = { robinhood: hood, bnb: bsc } as const;
  const enabledEvm = (['robinhood', 'bnb'] as EvmChainKind[]).filter((c) => settings.evm[c].enabled);
  const states = [
    { name: 'Solana', live: status.liveActive },
    ...enabledEvm.map((c) => ({ name: EVM_CHAIN_META[c].shortName, live: evmOf[c].evm?.live.armed === true })),
  ];
  const liveCount = states.filter((s) => s.live).length;
  const allLive = liveCount === states.length;
  const loading = enabledEvm.some((c) => evmOf[c].evm === null);
  // Whether the All-in-One wallet is the one signing everywhere: "All" shows
  // its total, so going Live must say when another wallet would trade.
  const [aioEverywhere, setAioEverywhere] = useState<boolean | null>(null);
  useEffect(() => {
    const load = (): void => {
      void window.krypt.aio.info().then((r) => setAioEverywhere(r.ok && r.data?.exists ? r.data.activeEverywhere : null));
    };
    load();
    return window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'aioChanged' || ev.kind === 'walletSwitched') load();
    });
  }, []);

  const setMode = async (wantLive: boolean): Promise<void> => {
    if (wantLive && allLive) return;
    if (wantLive) {
      // A chain whose state has not been read yet cannot be judged, so Live
      // waits for it rather than reporting a success it did not check.
      const unread = enabledEvm.filter((c) => evmOf[c].evm === null).map((c) => EVM_CHAIN_META[c].shortName);
      if (unread.length) {
        toast.warn(`Still reading ${unread.join(' and ')} — try again in a moment.`);
        return;
      }
      const yes = await modal.confirm({
        title: 'Go Live on every chain',
        message:
          `Live signs and broadcasts REAL transactions on ${states.map((s) => s.name).join(', ')}. Every trade is still simulated and checked before it sends — but real money moves on all of them.` +
          (aioEverywhere === false
            ? ' Note: the All-in-One wallet is NOT the signer on every chain — each chain trades with the wallet that signs there (All-in-One Wallet → Use it on every chain).'
            : '') +
          ' Switch every chain to Live?',
        confirmLabel: 'Go Live everywhere',
        destructive: true,
      });
      if (!yes) return;
    }
    const failed: string[] = [];
    // Paper is pressed on EVERY chain, unconditionally — both calls are
    // idempotent, and a chain whose state was unread or stale used to be
    // skipped and left live under a "Paper on every chain" toast (review
    // 2026-10-02). Live presses only what is not live yet.
    if (!wantLive || status.liveActive !== wantLive) {
      const r = await window.krypt.live.setLive(wantLive);
      if (!r.ok) failed.push(`Solana: ${r.message}`);
    }
    for (const c of enabledEvm) {
      const st = evmOf[c].evm;
      if (!wantLive) {
        const r = await window.krypt.evm.disarm(c);
        if (!r.ok) failed.push(`${EVM_CHAIN_META[c].shortName}: ${r.message}`);
        continue;
      }
      if (!st) {
        failed.push(`${EVM_CHAIN_META[c].shortName}: not read yet`);
        continue;
      }
      if (st.live.armed) continue;
      if (st.wallet.exists !== true) {
        failed.push(`${EVM_CHAIN_META[c].shortName}: no wallet yet`);
        continue;
      }
      const r = await window.krypt.evm.arm(c);
      if (!r.ok) failed.push(`${EVM_CHAIN_META[c].shortName}: ${r.message}`);
    }
    void hood.refresh();
    void bsc.refresh();
    if (failed.length) toast.error(`Not every chain switched — ${failed.join(' · ')}`);
    else toast[wantLive ? 'warn' : 'success'](wantLive ? 'Live on every chain' : 'Paper on every chain');
  };

  return (
    <div
      className="glass-btn inline-flex rounded-lg border border-white/12 text-label font-bold uppercase tracking-label"
      title={states.map((s) => `${s.name}: ${s.live ? 'Live' : 'Paper'}`).join(' · ')}
    >
      <button
        onClick={() => void setMode(false)}
        className={cls('px-3 py-1.5 transition', liveCount === 0 && !loading ? 'bg-emerald-500/20 text-emerald-200' : 'text-krypt-muted hover:text-white')}
      >
        {loading ? '…' : t('mode.paper')}
      </button>
      <button
        onClick={() => void setMode(true)}
        className={cls(
          'px-3 py-1.5 transition',
          allLive ? 'bg-rose-500/25 text-rose-200 shadow-crimson-glow' : liveCount > 0 ? 'bg-amber-500/20 text-amber-200' : 'text-krypt-muted hover:text-white',
        )}
      >
        {t('mode.live')}
        {liveCount > 0 && !allLive ? ` ${liveCount}/${states.length}` : ''}
      </button>
    </div>
  );
}

function ChainModeToggle() {
  const { t } = useLocale();
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
      className="glass-btn inline-flex rounded-lg border border-white/12 text-label font-bold uppercase tracking-label"
      title={evmLoading ? `Reading the ${CHAIN_LABEL[chain]} rail…` : `Paper / Live for ${CHAIN_LABEL[chain]} — each chain is armed on its own`}
    >
      <button
        onClick={() => void setMode(false)}
        className={cls('px-3 py-1.5 transition', !live && !evmLoading ? 'bg-emerald-500/20 text-emerald-200' : 'text-krypt-muted hover:text-white')}
      >
        {evmLoading ? '…' : t('mode.paper')}
      </button>
      <button
        onClick={() => void setMode(true)}
        className={cls('px-3 py-1.5 transition', live ? 'bg-rose-500/25 text-rose-200 shadow-crimson-glow' : 'text-krypt-muted hover:text-white')}
      >
        {t('mode.live')}
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

/** "12.34 USD", a floor marked "+" when a chain was unread or a holding is
 *  unpriced; an em dash when nothing was measured. */
function aioTotalText(bal: AioBalances | null): string {
  if (!bal) return '…';
  if (bal.totalUsd === null) return '—';
  return `${bal.totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${bal.partial || bal.unpriced ? '+' : ''} USD`;
}

/** A coin amount people can read: 0.0227, 0.00838, 43,379. */
function aioAmountText(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return Number(v.toPrecision(3)).toString();
}

/**
 * ALL: the All-in-One wallet's total in dollars, every chain. Clicking it
 * opens what that total IS — each chain, each token, the amount and its USD —
 * read fresh, not from the 20 s cache (2026-10-03: the user saw "0.11 USD"
 * with no way to see what it held).
 */
function AllWalletReadout({ onOpenWallet }: { onOpenWallet?: () => void }) {
  const [exists, setExists] = useState<boolean | null>(null);
  const [bal, setBal] = useState<AioBalances | null>(null);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);

  const load = (force: boolean): void => {
    if (!force && document.hidden) return;
    void window.krypt.aio.info().then((r) => {
      if (!aliveRef.current) return;
      const has = r.ok && r.data ? r.data.exists : false;
      setExists(has);
      if (!has) {
        setBal(null);
        return;
      }
      if (force) setReading(true);
      void window.krypt.aio
        .balances(force)
        .then((b) => {
          if (aliveRef.current && b.ok && b.data) setBal(b.data);
        })
        .finally(() => {
          if (aliveRef.current && force) setReading(false);
        });
    });
  };

  useEffect(() => {
    aliveRef.current = true;
    load(false);
    const t = setInterval(() => load(false), 30_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'aioChanged') load(false);
    });
    return () => {
      aliveRef.current = false;
      clearInterval(t);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open: read fresh, and close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    load(true);
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (exists === false) return <Readout label="All chains" value="No All-in-One wallet" />;

  // Chains in the order the balances list them; a chain that was read and
  // holds nothing is one quiet line, an unread one says why.
  const groups = (bal?.chains ?? []).map((c) => ({
    read: c,
    assets: (bal?.assets ?? []).filter((a) => a.chain === c.chain && !a.dust && (a.amount > 0 || a.kind !== 'native')),
  }));
  const holding = groups.filter((g) => !g.read.ok || g.assets.length > 0);
  const empty = groups.filter((g) => g.read.ok && g.assets.length === 0).map((g) => AIO_CHAIN_LABEL[g.read.chain]);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="What the All-in-One wallet holds"
        className="-mx-1.5 rounded-md px-1.5 py-0.5 transition hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      >
        <Readout label="All-in-One" value={aioTotalText(bal)} />
      </button>
      {open && (
        <div role="dialog" aria-label="All-in-One wallet holdings" className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)]">
          {/* Solid .glass, never the lens: the top bar is on screen for the life
              of the app and carries no filter (test/glass.test.mjs). */}
          <div className="glass rounded-xl border border-white/10">
            <div className="flex items-baseline justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div>
                <div className="text-micro font-display uppercase tracking-label text-krypt-muted/70">All-in-One total</div>
                <div className="font-mono text-base tabular-nums text-white">{aioTotalText(bal)}</div>
              </div>
              <div className="text-right text-micro text-krypt-muted">
                {reading ? 'reading…' : bal ? (Date.now() - bal.at < 5_000 ? 'updated just now' : `updated ${fmtAgo(bal.at)} ago`) : ''}
              </div>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-4 py-2">
              {!bal && <div className="py-3 text-xs text-krypt-muted">Reading every chain…</div>}
              {holding.map((g) => (
                <div key={g.read.chain} className="py-2">
                  <div className="flex items-baseline justify-between text-micro uppercase tracking-label text-krypt-muted/80">
                    <span>{AIO_CHAIN_LABEL[g.read.chain]}</span>
                    {/* A subtotal only adds something when the chain holds two or more coins. */}
                    <span className="font-mono normal-case">{!g.read.ok ? 'not read' : g.assets.length > 1 ? fmtUsd(g.read.usd) : ''}</span>
                  </div>
                  {!g.read.ok && <div className="mt-1 text-xs text-amber-200/80">{g.read.message ?? 'This chain did not answer — its holdings are missing, not zero.'}</div>}
                  {g.assets.map((a) => (
                    <div key={`${a.chain}:${a.token ?? 'native'}`} className="mt-1 flex items-baseline justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-white/90" title={a.name ?? a.symbol}>
                        <span className="font-mono tabular-nums">{aioAmountText(a.amount)}</span> {a.symbol}
                      </span>
                      <span className="flex-shrink-0 font-mono tabular-nums text-white/80" title={a.usd === null ? 'No price for this token — shown, not counted in the total' : undefined}>
                        {a.usd === null ? '—' : fmtUsd(a.usd)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {bal && holding.length === 0 && <div className="py-3 text-xs text-krypt-muted">Nothing on any chain yet.</div>}
              {bal && empty.length > 0 && <div className="pb-2 pt-1 text-micro text-krypt-muted/70">Nothing on {empty.join(', ')}.</div>}
              {bal && bal.unpriced > 0 && <div className="pb-2 text-micro text-krypt-muted/70">{bal.unpriced} holding{bal.unpriced === 1 ? '' : 's'} with no price — listed, not counted.</div>}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-white/10 px-4 py-2.5">
              <button type="button" onClick={() => load(true)} disabled={reading} className="text-xs text-krypt-muted transition hover:text-white disabled:opacity-50">
                Refresh
              </button>
              {onOpenWallet && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenWallet();
                  }}
                  className="glass-btn rounded-lg border border-white/12 px-3 py-1 text-xs text-white/90 transition hover:text-white"
                >
                  Open wallet
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Balance + address of the selected chain's wallet — or, under ALL, the
 *  All-in-One total. */
function WalletReadout({ onOpenAioWallet }: { onOpenAioWallet?: () => void }) {
  const { allChains } = useTerminal();
  return allChains ? <AllWalletReadout onOpenWallet={onOpenAioWallet} /> : <ChainWalletReadout />;
}

function ChainWalletReadout() {
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

export function TopBar({ search, onOpenAutomation, onOpenRunners, onOpenProfiles, onOpenAioWallet, onHub }: { search?: ReactNode; onOpenAutomation: () => void; onOpenRunners?: () => void; onOpenProfiles?: () => void; onOpenAioWallet?: () => void; onHub?: () => void }) {
  const { status, runners } = useAppState();
  const recentRunners = runners.filter((r) => Date.now() - r.flaggedAt < 3_600_000).length;

  return (
    // `.glass-chrome`: a lit top edge on the same dark fill, no filter. The
    // frame is on screen for the life of the app, and a frosted bar over the
    // backdrop looked worse than this one (user, 2026-09-28).
    <div className="glass-chrome flex items-center justify-between gap-4 px-5 py-2.5 border-b border-white/10 bg-krypt-void/95">
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
        {/* Which profile this window is, beside the money controls it
            governs — two instances side by side must never be confused. */}
        <ProfileBadge onManage={onOpenProfiles} />
        <ModeToggle />
        <Divider />
        <WalletReadout onOpenAioWallet={onOpenAioWallet} />
      </div>
    </div>
  );
}
