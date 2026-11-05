// The wallet panel (2026-11-04): click the balance in the top bar and a square
// opens in the middle of the window, with the current wallet's balance, a manual
// refresh, its deposit address, and withdrawing.
//
// Nothing here moves money on its own. Withdrawing and sending use the same cards
// as the wallet pages, through the same channels, so main's confirmations and the
// security checks (shared/securityPolicy.ts) apply exactly as they do there.
//
// It stays out of the top bar's chunk: the bar is on screen for the life of the
// app, and this loads on the first click.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowRight, RefreshCw, X } from 'lucide-react';
import { LiquidGlass } from '../LiquidGlass';
import { Copyable, GhostButton } from '../common';
import { SendCard } from './SendCard';
import { WithdrawPanel } from './WithdrawPanel';
import { useAppState } from '../../state/AppStateProvider';
import { useEvmState } from '../../state/useEvmState';
import { useToast } from '../../state/ToastProvider';
import { approxUsd, useSolUsd } from '../../state/useSolUsd';
import { AIO_CHAINS, AIO_CHAIN_LABEL, aioTotalText, type AioBalances, type AioChain, type AioWalletInfo } from '@shared/aio';
import { EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';
import { qrEncode } from '@shared/qr';
import type { WalletInfo } from '@shared/types';
import { cls, fmtAgo, fmtClock, fmtUsd } from '../../utils/format';
import { fmtNative } from '../../utils/evm';

export type WalletPanelChain = 'solana' | EvmChainKind | 'all';

/** The wallet page each view links to. */
export type WalletPageRoute = 'wallet' | 'walletrobinhood' | 'walletbnb' | 'walletaio';

// ── The frame ────────────────────────────────────────────────────────────

/** The scrim neither blurs nor fades (see ModalProvider): either would make it
 *  the backdrop root for the glass inside. Above drawers and below the confirm
 *  dialog (z-[1100]) that the withdrawal cards open on top of it. */
function Frame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/70 p-4"
      // Press and release on the scrim only: dragging a selection out of the
      // address field must not close the panel.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <LiquidGlass surface="sheet" className="h-[min(560px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] animate-pop-in rounded-2xl border border-white/10">
        <div
          ref={box}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          // Trade hotkeys listen on the window: they must not fire behind this.
          data-swallows-keys
          data-testid="wallet-panel"
          // On this box, not the document: Escape in a confirm dialog on top of
          // the panel answers that dialog and leaves the panel open.
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          className="flex h-full flex-col outline-none"
        >
          <div className="flex items-center justify-between gap-3 px-5 pt-4">
            <h2 className="min-w-0 truncate font-display text-note font-semibold uppercase tracking-heading text-krypt-muted">{title}</h2>
            <button type="button" onClick={onClose} title="Close" className="text-krypt-muted transition hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
          {children}
        </div>
      </LiquidGlass>
    </div>,
    document.body,
  );
}

function Balance({ value, usd, checked, reading, error, onRefresh, warning }: {
  value: string;
  usd?: string | null;
  checked: string | null;
  reading: boolean;
  error: string | null;
  onRefresh: () => void;
  warning?: string | null;
}) {
  return (
    <div className="px-5 pb-3 pt-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-2xl font-bold tabular-nums text-white" data-testid="wallet-panel-balance">
            {value}
            {usd && <span className="ml-2 text-sm font-normal text-krypt-muted">{usd}</span>}
          </div>
          <div className="text-label text-krypt-muted/70">{reading ? 'Reading…' : checked ?? ' '}</div>
        </div>
        <GhostButton onClick={onRefresh} disabled={reading} className="flex-shrink-0 !px-3 !py-1.5 text-xs">
          <RefreshCw className={cls('h-3.5 w-3.5', reading && 'animate-spin')} /> Refresh
        </GhostButton>
      </div>
      {/* The figure above is the last one read, and this says it may be old. */}
      {error && <div className="mt-1.5 text-xs text-amber-300/90">Could not read the balance: {error}</div>}
      {warning && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" /> {warning}
        </div>
      )}
    </div>
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-white/10 px-5">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cls(
            '-mb-px border-b-2 px-3 py-2 text-note font-medium transition',
            value === t.id ? 'border-krypt-purple text-white' : 'border-transparent text-krypt-muted hover:text-white',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const Body = ({ children }: { children: ReactNode }) => <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">{children}</div>;

function Footer({ note, onOpenPage }: { note?: string | null; onOpenPage: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-2.5">
      <span className="min-w-0 truncate text-label text-krypt-muted/80">{note}</span>
      <button type="button" onClick={onOpenPage} className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-krypt-muted transition hover:text-white">
        Open wallet page <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NoWallet({ text, onOpenPage }: { text: string; onOpenPage: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
      <div className="text-sm text-krypt-muted">{text}</div>
      <GhostButton onClick={onOpenPage} className="!px-3 !py-1.5 text-xs">
        Open wallet page <ArrowRight className="h-3.5 w-3.5" />
      </GhostButton>
    </div>
  );
}

// ── Deposit ──────────────────────────────────────────────────────────────

/** Black on white with a quiet zone: what phone wallets scan reliably, whatever
 *  the app's theme. */
function QrCode({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const modules = qrEncode(text);
    let d = '';
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
      });
    });
    return { path: d, size: modules.length + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={176} height={176} shapeRendering="crispEdges" role="img" aria-label={`QR code of ${text}`} className="rounded-lg" data-testid="wallet-panel-qr">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function Deposit({ address, note }: { address: string; note: string }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <QrCode text={address} />
      </div>
      <Copyable value={address} label="deposit address" />
      <div className="text-xs text-krypt-muted">{note}</div>
    </div>
  );
}

// ── Solana ───────────────────────────────────────────────────────────────

function SolanaView({ onChanged, onOpenPage }: { onChanged: () => void; onOpenPage: () => void }) {
  const toast = useToast();
  const solUsd = useSolUsd();
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'deposit' | 'withdraw' | 'send'>('deposit');
  const [editingHome, setEditingHome] = useState(false);
  const [homeInput, setHomeInput] = useState('');
  const alive = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const read = useCallback(async (): Promise<void> => {
    setReading(true);
    setError(null);
    const r = await window.krypt.wallet.refreshBalance();
    if (!alive.current) return;
    setReading(false);
    if (r.ok && r.data) setInfo(r.data);
    else setError(r.message);
    changed.current();
  }, []);

  useEffect(() => {
    alive.current = true;
    // The last figure at once, then a fresh read.
    void window.krypt.wallet.info().then((r) => {
      if (!alive.current || !r.ok || !r.data) return;
      setInfo(r.data);
      if (r.data.exists) void read();
    });
    return () => {
      alive.current = false;
    };
  }, [read]);

  if (info === null) return <div className="flex-1" />;
  if (!info.exists || !info.publicKey) return <NoWallet text="No Solana wallet yet." onOpenPage={onOpenPage} />;

  const saved = info.homeAddress ?? '';
  const showEditor = editingHome || !info.homeAddress;
  // The withdrawal goes to the SAVED address, so the card refuses while this
  // differs (user report 2026-10-03: 0.1 SOL went to the old address).
  const homeUnsaved = showEditor && homeInput.trim() !== saved;

  const saveHome = async (): Promise<void> => {
    const r = await window.krypt.wallet.setHome(homeInput.trim());
    if (!alive.current) return;
    if (r.ok && r.data) {
      setInfo(r.data);
      setEditingHome(false);
      setHomeInput('');
      toast.success('Withdrawal address saved');
    } else toast.error(r.message);
  };

  return (
    <>
      <Balance
        value={info.balanceSol != null ? `${info.balanceSol.toFixed(4)} SOL` : '—'}
        usd={approxUsd(info.balanceSol, solUsd, fmtUsd)}
        checked={info.balanceCheckedAt ? `Checked ${fmtClock(info.balanceCheckedAt)}` : null}
        reading={reading}
        error={error}
        onRefresh={() => void read()}
        warning={info.balanceSol != null && info.balanceSol > info.maxBalanceSol ? `Above your ${info.maxBalanceSol} SOL cap. Consider moving some out.` : null}
      />
      <Tabs
        tabs={[
          { id: 'deposit', label: 'Deposit' },
          { id: 'withdraw', label: 'Withdraw' },
          { id: 'send', label: 'Send' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Body>
        {tab === 'deposit' && <Deposit address={info.publicKey} note="Send SOL or Solana tokens here, on the Solana network only. Coins sent from another network will not arrive." />}
        {tab === 'withdraw' && (
          <>
            {showEditor && (
              <div className="space-y-1.5">
                <div className="text-xs text-krypt-muted">{info.homeAddress ? 'New withdrawal address' : 'Where should withdrawals go? Your own main wallet, usually.'}</div>
                <div className="flex gap-2">
                  <input
                    value={homeInput}
                    onChange={(e) => setHomeInput(e.target.value)}
                    placeholder="Your main wallet address"
                    spellCheck={false}
                    autoFocus
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60"
                  />
                  <GhostButton onClick={() => void saveHome()} disabled={!homeInput.trim() || !homeUnsaved} className="!px-3 !py-1.5 text-xs">
                    Save
                  </GhostButton>
                  {info.homeAddress && (
                    <GhostButton onClick={() => { setEditingHome(false); setHomeInput(''); }} className="!px-3 !py-1.5 text-xs">
                      Cancel
                    </GhostButton>
                  )}
                </div>
              </div>
            )}
            <WithdrawPanel
              bare
              info={info}
              unsavedHome={homeUnsaved}
              onChangeAddress={() => {
                setHomeInput(saved);
                setEditingHome(true);
              }}
              onDone={() => void read()}
            />
          </>
        )}
        {tab === 'send' && <SendCard chain="solana" bare onSent={() => void read()} />}
      </Body>
      <Footer note={info.walletCount > 1 ? `${info.label ?? 'Active wallet'}, the active one of ${info.walletCount} wallets` : info.label} onOpenPage={onOpenPage} />
    </>
  );
}

// ── Robinhood and BNB ────────────────────────────────────────────────────

function EvmView({ chain, onChanged, onOpenPage }: { chain: EvmChainKind; onChanged: () => void; onOpenPage: () => void }) {
  const { evm, refresh } = useEvmState(chain);
  const meta = EVM_CHAIN_META[chain];
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const alive = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const read = useCallback(async (): Promise<void> => {
    setReading(true);
    setError(null);
    const r = await window.krypt.evm.wallet.refreshBalance(chain);
    if (!alive.current) return;
    setReading(false);
    if (!r.ok) setError(r.message);
    await refresh();
    changed.current();
  }, [chain, refresh]);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);

  const w = evm?.wallet ?? null;
  if (w === null) return <div className="flex-1" />;
  // An unreadable wallet file is not "no wallet".
  if (w.failure) return <NoWallet text={w.failure} onOpenPage={onOpenPage} />;
  if (!w.exists || !w.address) return <NoWallet text={`No ${meta.name} wallet yet.`} onOpenPage={onOpenPage} />;

  return (
    <>
      <Balance
        value={fmtNative(w.balanceNative, meta.nativeSymbol, 5)}
        usd={approxUsd(w.balanceNative, evm?.nativeUsd, fmtUsd)}
        checked={w.balanceCheckedAt ? `Checked ${fmtClock(w.balanceCheckedAt)}` : null}
        reading={reading}
        error={error}
        onRefresh={() => void read()}
      />
      <Tabs
        tabs={[
          { id: 'deposit', label: 'Deposit' },
          { id: 'withdraw', label: 'Withdraw' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Body>
        {tab === 'deposit' && <Deposit address={w.address} note={`Send ${meta.nativeSymbol} here, on ${meta.name} only. Coins sent on another network will not show up in this balance.`} />}
        {tab === 'withdraw' && <SendCard chain={chain} bare onSent={() => void read()} />}
      </Body>
      <Footer note={w.walletCount > 1 ? `${w.label ?? 'Active wallet'}, the active one of ${w.walletCount} wallets` : w.label} onOpenPage={onOpenPage} />
    </>
  );
}

// ── All chains: the All-in-One wallet ────────────────────────────────────

/** A coin amount people can read: 0.0227, 0.00838, 43,379. */
function amountText(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return Number(v.toPrecision(3)).toString();
}

function ChainChips({ chains, value, onChange }: { chains: AioChain[]; value: AioChain; onChange: (c: AioChain) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chains.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cls('rounded-full border px-2.5 py-0.5 text-label transition', value === c ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white')}
        >
          {AIO_CHAIN_LABEL[c]}
        </button>
      ))}
    </div>
  );
}

function Holdings({ bal }: { bal: AioBalances | null }) {
  if (!bal) return <div className="text-xs text-krypt-muted">Reading every chain…</div>;
  // A chain that was read and holds nothing is one quiet line; an unread one
  // says why, because its holdings are missing rather than zero.
  const groups = bal.chains.map((c) => ({
    read: c,
    assets: bal.assets.filter((a) => a.chain === c.chain && !a.dust && (a.amount > 0 || a.kind !== 'native')),
  }));
  const holding = groups.filter((g) => !g.read.ok || g.assets.length > 0);
  const empty = groups.filter((g) => g.read.ok && g.assets.length === 0).map((g) => AIO_CHAIN_LABEL[g.read.chain]);
  return (
    <div className="space-y-3">
      {holding.map((g) => (
        <div key={g.read.chain}>
          <div className="flex items-baseline justify-between text-micro uppercase tracking-label text-krypt-muted/80">
            <span>{AIO_CHAIN_LABEL[g.read.chain]}</span>
            {/* A subtotal only adds something when the chain holds two or more coins. */}
            <span className="font-mono normal-case">{!g.read.ok ? 'not read' : g.assets.length > 1 ? fmtUsd(g.read.usd) : ''}</span>
          </div>
          {!g.read.ok && <div className="mt-1 text-xs text-amber-200/80">{g.read.message ?? 'This chain did not answer. Its holdings are missing, not zero.'}</div>}
          {g.assets.map((a) => (
            <div key={`${a.chain}:${a.token ?? 'native'}`} className="mt-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-white/90" title={a.name ?? a.symbol}>
                <span className="font-mono tabular-nums">{amountText(a.amount)}</span> {a.symbol}
              </span>
              <span className="flex-shrink-0 font-mono tabular-nums text-white/80" title={a.usd === null ? 'No price for this token. Shown, not counted in the total.' : undefined}>
                {a.usd === null ? '—' : fmtUsd(a.usd)}
              </span>
            </div>
          ))}
        </div>
      ))}
      {holding.length === 0 && <div className="text-xs text-krypt-muted">Nothing on any chain yet.</div>}
      {empty.length > 0 && holding.length > 0 && <div className="text-micro text-krypt-muted/70">Nothing on {empty.join(', ')}.</div>}
      {bal.unpriced > 0 && <div className="text-micro text-krypt-muted/70">{bal.unpriced} holding{bal.unpriced === 1 ? '' : 's'} with no price: listed, not counted.</div>}
    </div>
  );
}

function AllView({ onChanged, onOpenPage }: { onChanged: () => void; onOpenPage: () => void }) {
  const { settings } = useAppState();
  // Only chains switched on in Settings: money sent to a switched-off chain sits
  // where this app neither trades nor reads it.
  const chains = AIO_CHAINS.filter((c) => c === 'solana' || settings.evm[c].enabled);
  const [info, setInfo] = useState<AioWalletInfo | null>(null);
  const [bal, setBal] = useState<AioBalances | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'holdings' | 'deposit' | 'send'>('holdings');
  const [picked, setPicked] = useState<AioChain>('solana');
  const alive = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const chain = chains.includes(picked) ? picked : 'solana';

  const read = useCallback(async (): Promise<void> => {
    setReading(true);
    setError(null);
    const r = await window.krypt.aio.balances(true);
    if (!alive.current) return;
    setReading(false);
    if (r.ok && r.data) setBal(r.data);
    else setError(r.message);
    changed.current();
  }, []);

  useEffect(() => {
    alive.current = true;
    void window.krypt.aio.info().then((r) => {
      if (!alive.current) return;
      if (r.ok && r.data) {
        setInfo(r.data);
        if (r.data.exists) void read();
      } else setError(r.message);
    });
    return () => {
      alive.current = false;
    };
  }, [read]);

  if (info === null) return <div className="flex-1">{error && <div className="px-5 py-4 text-xs text-amber-300/90">{error}</div>}</div>;
  if (!info.exists) return <NoWallet text={info.failure ?? 'No All-in-One wallet yet.'} onOpenPage={onOpenPage} />;

  const address = chain === 'solana' ? info.solanaAddress : info.evmAddress;
  const ready = info.activeEverywhere && info.missing.length === 0;

  return (
    <>
      <Balance
        value={aioTotalText(bal)}
        checked={bal ? (Date.now() - bal.at < 5_000 ? 'Checked just now' : `Checked ${fmtAgo(bal.at)} ago`) : null}
        reading={reading}
        error={error}
        onRefresh={() => void read()}
      />
      <Tabs
        tabs={[
          { id: 'holdings', label: 'Holdings' },
          { id: 'deposit', label: 'Deposit' },
          { id: 'send', label: 'Withdraw' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Body>
        {tab === 'holdings' && <Holdings bal={bal} />}
        {tab === 'deposit' && (
          <>
            <ChainChips chains={chains} value={chain} onChange={setPicked} />
            {address ? (
              <Deposit address={address} note={`Send coins here on ${AIO_CHAIN_LABEL[chain]} only. Pick the network you are sending from above.`} />
            ) : (
              <div className="text-xs text-amber-300/90">This wallet has no key for {AIO_CHAIN_LABEL[chain]} right now. The wallet page can put it back from the recovery phrase.</div>
            )}
          </>
        )}
        {tab === 'send' && (
          <>
            <ChainChips chains={chains} value={chain} onChange={setPicked} />
            <SendCard
              key={chain}
              chain={chain}
              bare
              onSent={() => void read()}
              blocked={ready ? null : 'Press “Use it on every chain” on the wallet page first. A send signs as each chain’s active wallet, and this one is not active everywhere yet.'}
            />
          </>
        )}
      </Body>
      <Footer note={info.label} onOpenPage={onOpenPage} />
    </>
  );
}

// ── The panel ────────────────────────────────────────────────────────────

const PAGE_OF: Record<WalletPanelChain, WalletPageRoute> = {
  solana: 'wallet',
  robinhood: 'walletrobinhood',
  bnb: 'walletbnb',
  all: 'walletaio',
};

const TITLE_OF: Record<WalletPanelChain, string> = {
  solana: 'Solana wallet',
  robinhood: `${EVM_CHAIN_META.robinhood.name} wallet`,
  bnb: `${EVM_CHAIN_META.bnb.name} wallet`,
  all: 'All-in-One wallet',
};

export function WalletPanel({ chain, onClose, onChanged, onOpenPage }: {
  chain: WalletPanelChain;
  onClose: () => void;
  /** A balance was read: the top bar should show the same figure. */
  onChanged: () => void;
  onOpenPage: (route: WalletPageRoute) => void;
}) {
  const open = (): void => {
    onClose();
    onOpenPage(PAGE_OF[chain]);
  };
  return (
    <Frame title={TITLE_OF[chain]} onClose={onClose}>
      {chain === 'solana' && <SolanaView onChanged={onChanged} onOpenPage={open} />}
      {chain === 'all' && <AllView onChanged={onChanged} onOpenPage={open} />}
      {chain !== 'solana' && chain !== 'all' && <EvmView key={chain} chain={chain} onChanged={onChanged} onOpenPage={open} />}
    </Frame>
  );
}
