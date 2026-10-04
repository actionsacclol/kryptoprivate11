// All-in-One wallet — one recovery phrase, one wallet on every chain.
//
// The page is deliberately plain about what the wallet IS: the same two keys
// any wallet page holds (a Solana key, an EVM key that is one address on BNB,
// Robinhood and every other EVM chain), made from one phrase that also opens
// it in Phantom and MetaMask. What it adds is the one total, in dollars, and
// — next — buying on any chain from whatever it holds.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, Eye, Globe2, KeyRound, Layers, Loader2, PlayCircle, RefreshCw, ShieldAlert, Trash2, Wrench } from 'lucide-react';
import { AIO_WALLET_VIDEO_URL } from '../guideVideos';
import { TransferQuote, useQuoteClock } from '../components/terminal/TransferQuote';
import { STATUS_LABEL, nativeSymbolOf, type BridgeQuote, type InFlight } from '@shared/bridge';
import { Badge, Card, Copyable, GhostButton, Page, PrimaryButton, Section, Switch } from '../components/common';
import { AIO_SPEEDS, AIO_SPEED_LABEL, AIO_SPEED_NOTE } from '@shared/aioSpeed';
import { LiquidGlass } from '../components/LiquidGlass';
import { useToast } from '../state/ToastProvider';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { AIO_CHAIN_LABEL, AIO_CHAINS, DEFAULT_AIO_PATHS, type AioAsset, type AioBalances, type AioChain, type AioScanRow, type AioWalletInfo } from '@shared/aio';
import { COMPRESS_COIN, COMPRESS_TARGETS, type CompressPlan } from '@shared/aioCompress';
import { useEvmState } from '../state/useEvmState';
import { cls, fmtAgo } from '../utils/format';
import { SendCard } from '../components/terminal/SendCard';

/** Full dollars for a wallet total — "$1.2K" is fine for a market cap and
 *  wrong for what someone owns. */
function dollars(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function amount(v: number): string {
  if (v === 0) return '0';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return v.toPrecision(4).replace(/\.?0+$/, '');
}

const CHAIN_TONE: Record<string, string> = {
  solana: 'text-violet-300 border-violet-400/30 bg-violet-500/10',
  bnb: 'text-amber-300 border-amber-400/30 bg-amber-500/10',
  robinhood: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10',
  ethereum: 'text-sky-300 border-sky-400/30 bg-sky-500/10',
  base: 'text-blue-300 border-blue-400/30 bg-blue-500/10',
  arbitrum: 'text-cyan-300 border-cyan-400/30 bg-cyan-500/10',
};

/** The phrase on screen. Only ever held in this component's state, dropped
 *  on close. No copy button: a phrase on the clipboard is a phrase any app
 *  can read. */
function PhraseSheet({ phrase, firstTime, onDone, onClose }: { phrase: string; firstTime: boolean; onDone: () => void; onClose: () => void }) {
  const [ticked, setTicked] = useState(false);
  const words = phrase.split(' ');
  // Escape closes, like every other dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // No clipboard, by design: the words go on paper. Selecting, copying,
  // cutting and the context menu are all refused on the sheet (swarm 2026-10-03).
  const noCopy = (e: { preventDefault: () => void }): void => e.preventDefault();
  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/75"
      role="dialog"
      aria-modal="true"
      aria-labelledby="aio-phrase-title"
      onCopy={noCopy}
      onCut={noCopy}
      onContextMenu={noCopy}
    >
      <LiquidGlass surface="sheet" className="w-full max-w-lg rounded-2xl border border-white/10 animate-pop-in">
        <div className="p-6 space-y-4">
          <div id="aio-phrase-title" className="flex items-center gap-2 text-lg font-semibold text-white">
            <KeyRound className="h-5 w-5 text-arc-gold" /> {firstTime ? 'Write down your recovery phrase' : 'Your recovery phrase'}
          </div>
          <p className="text-xs text-krypt-muted leading-relaxed">
            These {words.length} words ARE the wallet — on every chain. Write them on paper, in order, and keep them offline.
            They also open this wallet in Phantom and MetaMask. Anyone who sees them can take everything in it; nobody, including
            Krypt, can recover it without them.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {words.map((w, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-sm text-white select-none">
                <span className="w-5 text-right text-label text-krypt-muted/60">{i + 1}</span>
                {w}
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-xs text-white cursor-pointer">
            <input type="checkbox" autoFocus checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5" />
            I have written all {words.length} words down, in this order, somewhere offline.
          </label>
          <div className="flex justify-end gap-2">
            <GhostButton onClick={onClose}>{firstTime ? 'Later' : 'Close'}</GhostButton>
            <PrimaryButton onClick={onDone} disabled={!ticked}>
              <Check className="h-4 w-4" /> Done
            </PrimaryButton>
          </div>
        </div>
      </LiquidGlass>
    </div>
  );
}

/**
 * Move between the wallet's own chains — the Bridge engine on Relay, from
 * one of its addresses to another. Quote, check (the chain simulates the
 * signed transfer), then move after a confirmation. Nothing leaves until
 * the last click.
 */
/**
 * Speed tier + the float. Honest about what money buys here: on these chains
 * a fee buys almost no time, so the tiers mostly change fees and waits, and
 * the float — money already where the buy is — is what makes a buy instant.
 */
function AioSpeedCard() {
  const { settings, updateSettings } = useAppState();
  const aio = settings.aio;
  const [usd, setUsd] = useState(String(aio.floatUsd));
  useEffect(() => setUsd(String(aio.floatUsd)), [aio.floatUsd]);
  const set = (patch: Partial<typeof aio>): void => void updateSettings({ aio: { ...aio, ...patch } });
  const typed = Number(usd);
  const usdBad = !(typed >= 5 && typed <= 1_000);
  return (
    <Card className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-white">Speed</div>
        <div role="group" aria-label="Speed" className="mt-2 inline-flex overflow-hidden rounded-lg border border-white/10">
          {AIO_SPEEDS.map((sp) => (
            <button
              key={sp}
              aria-pressed={aio.speed === sp}
              onClick={() => set({ speed: sp })}
              className={cls('px-3 py-1.5 text-xs', aio.speed === sp ? 'bg-krypt-purple/30 text-white' : 'text-krypt-muted hover:text-white')}
            >
              {AIO_SPEED_LABEL[sp]}
            </button>
          ))}
        </div>
        <div className="mt-1.5 text-label text-krypt-muted">
          {AIO_SPEED_NOTE[aio.speed]} On these chains fees buy very little time; the float below is what makes a buy instant.
        </div>
      </div>
      <div className="space-y-2 border-t border-white/10 pt-3">
        <Switch
          checked={aio.floatEnabled}
          onChange={(v) => set({ floatEnabled: v })}
          label="Keep money ready on every chain (float)"
          description={`Keeps about $${aio.floatUsd} on each chain, so a buy there needs no conversion (about 1.5 s instead of about 5 s). Refills come from the chain holding the most, as ordinary moves (Relay's cost plus Krypt's 0.5%), at most once per chain every 10 minutes.`}
        />
        <div className="flex items-center gap-2 text-xs text-krypt-muted">
          <span>Amount per chain</span>
          <span className="text-white/80">$</span>
          <input
            aria-label="Float amount per chain, in dollars"
            value={usd}
            onChange={(e) => setUsd(e.target.value.replace(/,/g, '.').replace(/[^0-9.]/g, ''))}
            onBlur={() => {
              if (!usdBad && typed !== aio.floatUsd) set({ floatUsd: Math.round(typed * 100) / 100 });
            }}
            inputMode="decimal"
            className={cls('w-20 rounded-lg border bg-black/40 px-2 py-1 font-mono text-white outline-none', usdBad ? 'border-rose-500/50' : 'border-white/10')}
          />
          {usdBad && <span className="text-rose-300/90">Between $5 and $1,000.</span>}
        </div>
      </div>
    </Card>
  );
}

/** Send to any address, from this wallet on the chain picked here. Sends
 *  sign as each chain's ACTIVE wallet, so it is only offered once this wallet
 *  is active everywhere — the same rule as moving between chains. */
function AioSendCard({ info, onSent }: { info: AioWalletInfo; onSent: () => void }) {
  const { settings } = useAppState();
  const chains = AIO_CHAINS.filter((c) => c === 'solana' || settings.evm[c].enabled);
  const [chain, setChain] = useState<AioChain>('solana');
  const ready = info.activeEverywhere && info.missing.length === 0;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {chains.map((c) => (
          <button
            key={c}
            onClick={() => setChain(c)}
            className={cls('rounded-full border px-2.5 py-0.5 text-label', chain === c ? CHAIN_TONE[c] : 'border-white/10 text-krypt-muted hover:text-white')}
          >
            {AIO_CHAIN_LABEL[c]}
          </button>
        ))}
      </div>
      <SendCard
        key={chain}
        chain={chain}
        bare
        onSent={onSent}
        blocked={ready ? null : 'Press “Use it on every chain” above first — a send signs as each chain’s active wallet, and this one is not active everywhere yet.'}
      />
    </Card>
  );
}

function MoveCard({ info, bal, onMoved }: { info: AioWalletInfo; bal: AioBalances | null; onMoved: () => void }) {
  const toast = useToast();
  const modal = useModal();
  // Only chains switched on in Settings: money moved to a switched-off chain
  // would sit where this app neither trades nor reads it.
  const { settings } = useAppState();
  const chains = AIO_CHAINS.filter((c) => c === 'solana' || settings.evm[c].enabled);
  const [from, setFrom] = useState<AioChain>('solana');
  const [to, setTo] = useState<AioChain>(() => chains.find((c) => c !== 'solana') ?? 'bnb');
  // A chain switched off in Settings while the card is open drops out of
  // both ends — the card once read "Solana → Solana" and quoted to BNB.
  useEffect(() => {
    if (!chains.includes(from)) setFrom(chains[0] ?? 'solana');
    if (!chains.includes(to) || to === from) {
      const next = chains.find((c) => c !== from);
      if (next) setTo(next);
    }
  }, [chains.join(','), from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  // A quote lives 30 s from when it was quoted (main refuses an older one):
  // past that, Check and Move step aside for a new quote.
  const clock = useQuoteClock(quote, quotedAt);
  const [busy, setBusy] = useState<'' | 'quote' | 'check' | 'send'>('');
  const [recent, setRecent] = useState<InFlight[]>([]);

  const loadRecent = useCallback(async () => {
    const r = await window.krypt.bridge.state();
    if (r.ok && r.data) {
      const all = [...(r.data.inFlight ?? []), ...(r.data.history ?? [])];
      const seen = new Set<string>();
      setRecent(all.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))).slice(0, 5));
    }
  }, []);
  useEffect(() => {
    void loadRecent();
    const t = setInterval(() => void loadRecent(), 15_000);
    return () => clearInterval(t);
  }, [loadRecent]);

  const held = bal?.assets.find((a) => a.chain === from && a.kind === 'native')?.amount ?? null;
  const draft = { from, to, amount: Number(amount) };
  const reset = (): void => {
    setQuote(null);
    setQuotedAt(null);
    setChecked(false);
  };
  const ready = info.activeEverywhere && info.missing.length === 0;

  const doQuote = async (): Promise<void> => {
    reset();
    setBusy('quote');
    const r = await window.krypt.aio.moveQuote(draft);
    setBusy('');
    if (r.ok && r.data) {
      setQuote(r.data);
      setQuotedAt(Date.now());
    } else toast.error(r.message);
  };
  const doCheck = async (): Promise<void> => {
    setBusy('check');
    const r = await window.krypt.aio.moveSend(draft, true, quote?.quoteId);
    setBusy('');
    if (r.ok) {
      setChecked(true);
      toast.success(r.message);
    } else toast.error(r.message);
  };
  const doSend = async (): Promise<void> => {
    if (!quote) return;
    const yes = await modal.confirm({
      title: `Move ${amount} ${nativeSymbolOf(from)} to ${AIO_CHAIN_LABEL[to]}`,
      message:
        'This sends real money through Relay to the same wallet on the other chain. It usually arrives in seconds; if Relay cannot fill it, it is refunded on the chain it left. A transfer that has left cannot be called back.',
      confirmLabel: 'Move it',
      destructive: true,
    });
    if (!yes) return;
    setBusy('send');
    const r = await window.krypt.aio.moveSend(draft, false, quote.quoteId);
    setBusy('');
    // A real send spends its quote whatever happened (main took it). On a
    // failure that may have reached the chain, the record below says so —
    // never a second click on the same quote.
    reset();
    void loadRecent();
    if (r.ok) {
      toast.success('On its way — it usually lands in seconds');
      setAmount('');
      for (const ms of [6_000, 20_000]) setTimeout(onMoved, ms);
    } else toast.error(`${r.message} Check Recent transfers before trying again.`);
  };

  const select = 'rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60';
  return (
    <Card className="space-y-3">
      {!ready && (
        <div className="text-xs text-amber-300/90">
          {info.missing.length ? 'Repair the wallet first.' : 'Make it the signer on every chain first (above) — a move goes from its own address to its own address.'}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Move from" value={from} onChange={(e) => { setFrom(e.target.value as AioChain); if (e.target.value === to) setTo(from); reset(); }} className={select}>
          {chains.map((c) => <option key={c} value={c}>{AIO_CHAIN_LABEL[c]}</option>)}
        </select>
        <button onClick={() => { setFrom(to); setTo(from); reset(); }} title="Swap direction" aria-label="Swap direction" className="rounded-lg border border-white/10 p-1.5 text-krypt-muted hover:text-white">
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <select aria-label="Move to" value={to} onChange={(e) => { setTo(e.target.value as AioChain); if (e.target.value === from) setFrom(to); reset(); }} className={select}>
          {chains.map((c) => <option key={c} value={c}>{AIO_CHAIN_LABEL[c]}</option>)}
        </select>
        <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5">
          <input
            aria-label="Amount to move"
            value={amount}
            onChange={(e) => { setAmount(e.target.value.replace(/,/g, '.').replace(/[^0-9.]/g, '')); reset(); }}
            placeholder="0.0"
            inputMode="decimal"
            className="w-24 bg-transparent text-sm font-mono text-white outline-none"
          />
          <span className="text-label text-krypt-muted">{nativeSymbolOf(from)}</span>
        </div>
        {held !== null && (
          <span className="text-label text-krypt-muted">
            holds {held.toLocaleString('en-US', { maximumFractionDigits: 6 })} {nativeSymbolOf(from)}
          </span>
        )}
        <GhostButton onClick={() => void doQuote()} disabled={!ready || busy !== '' || !(Number(amount) > 0) || from === to}>
          {busy === 'quote' && <Loader2 className="h-4 w-4 animate-spin" />} Get a quote
        </GhostButton>
      </div>
      {quote && <TransferQuote quote={quote} />}
      {quote && (
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => void doCheck()} disabled={busy !== '' || clock.expired}>
            {busy === 'check' && <Loader2 className="h-4 w-4 animate-spin" />} {checked ? <Check className="h-4 w-4 text-emerald-300" /> : null} Check it first
          </GhostButton>
          <PrimaryButton onClick={() => void doSend()} disabled={busy !== '' || !checked || clock.expired}>
            {busy === 'send' && <Loader2 className="h-4 w-4 animate-spin" />} Move it
          </PrimaryButton>
          {clock.expired ? (
            <span className="text-label text-amber-300/90">This quote has expired — press Get a quote for a fresh one.</span>
          ) : (
            <span className="text-label text-krypt-muted">
              {checked ? '' : 'The chain simulates the signed transfer before Move unlocks. '}Quote good for {clock.secondsLeft}s.
            </span>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <div className="pt-2 border-t border-white/5 space-y-1">
          <div className="text-label uppercase tracking-label text-krypt-muted/70">Recent transfers</div>
          {recent.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-label">
              <span className="text-white/80">{AIO_CHAIN_LABEL[t.from]} → {AIO_CHAIN_LABEL[t.to]}</span>
              <span className="font-mono text-krypt-muted">{(Number(t.fromAmountRaw) / 10 ** (t.from === 'solana' ? 9 : 18)).toLocaleString('en-US', { maximumFractionDigits: 6 })} {nativeSymbolOf(t.from)}</span>
              <span className={cls(t.status === 'done' ? 'text-emerald-300' : t.status === 'pending' || t.status === 'unknown' ? 'text-amber-300' : 'text-rose-300')}>{STATUS_LABEL[t.status]}</span>
              <span className="text-krypt-muted/60">{fmtAgo(t.startedAt)} ago</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const isAioChain = (c: string): c is AioChain => c === 'solana' || c === 'bnb' || c === 'robinhood';

/** Live per chain, as the top bar shows it: a sell elsewhere is only simulated. */
function useLiveByChain(): Record<AioChain, boolean> {
  const { status } = useAppState();
  const hood = useEvmState('robinhood');
  const bsc = useEvmState('bnb');
  return { solana: status.liveActive === true, bnb: bsc.evm?.live.armed === true, robinhood: hood.evm?.live.armed === true };
}

/**
 * Everything the wallet holds, one row per coin or token: the chain, the
 * amount, the dollars, and Sell for tokens (2026-10-03). Empty chains fold
 * into one line; balances under a cent sit behind a toggle instead of
 * vanishing — "where did my token go" was the question this answers.
 */
function HoldingsCard({ info, bal, balErr, onChanged }: { info: AioWalletInfo; bal: AioBalances | null; balErr: string | null; onChanged: () => void }) {
  const toast = useToast();
  const modal = useModal();
  const live = useLiveByChain();
  const [showDust, setShowDust] = useState(false);
  const [selling, setSelling] = useState<string | null>(null);
  const keyOf = (a: AioAsset): string => `${a.chain}:${a.token ?? 'native'}`;

  const sellBlocked = (a: AioAsset): string | null => {
    if (!isAioChain(a.chain)) return `${AIO_CHAIN_LABEL[a.chain]} is read for the total only — the app does not trade there`;
    if (!info.signingOn[a.chain]) return `The All-in-One wallet is not the signer on ${AIO_CHAIN_LABEL[a.chain]} — press "Use it on every chain" first`;
    if (!live[a.chain]) return `${AIO_CHAIN_LABEL[a.chain]} is in Paper — switch it to Live in the top bar to sell for real`;
    return null;
  };

  const sell = async (a: AioAsset): Promise<void> => {
    if (!a.token || !isAioChain(a.chain) || sellBlocked(a)) return;
    const chain = a.chain;
    const yes = await modal.confirm({
      title: `Sell all ${a.symbol}`,
      message: `Sell ${amount(a.amount)} ${a.symbol} on ${AIO_CHAIN_LABEL[chain]} for ${COMPRESS_COIN[chain]}${a.usd !== null ? ` (about ${dollars(a.usd)})` : ' (no price right now)'}? This is a real sale; Krypt's 0.5 % fee applies.`,
      confirmLabel: 'Sell 100%',
      destructive: true,
    });
    if (!yes) return;
    setSelling(keyOf(a));
    try {
      const r = chain === 'solana' ? await window.krypt.live.sellToken(a.token) : await window.krypt.evm.sell(chain, a.token, 100, false);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } finally {
      setSelling(null);
      onChanged();
    }
  };

  if (!bal) return <Card><div className="text-xs text-krypt-muted">{balErr ?? 'Reading every chain…'}</div></Card>;
  const held = bal.assets.filter((a) => a.amount > 0);
  const main = held.filter((a) => !a.dust);
  const dust = held.filter((a) => a.dust);
  const emptyChains = bal.chains.filter((c) => c.ok && !held.some((a) => a.chain === c.chain)).map((c) => AIO_CHAIN_LABEL[c.chain]);
  const rows = showDust ? [...main, ...dust] : main;

  return (
    <Card padded={false}>
      {held.length === 0 ? (
        <div className="px-4 py-6 text-xs text-krypt-muted">Nothing yet. Send any coin to one of the addresses above.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-label uppercase tracking-label text-krypt-muted/70">
              <th className="px-4 py-2 font-normal">Chain</th>
              <th className="py-2 font-normal">Coin</th>
              <th className="py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 text-right font-normal">Value</th>
              <th className="py-2 pr-4 w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const blocked = a.kind === 'native' ? null : sellBlocked(a);
              return (
                <tr key={keyOf(a)} className={cls('border-b border-white/5 last:border-0', a.dust && 'opacity-70')}>
                  <td className="px-4 py-2 w-28">
                    <span className={cls('rounded-full border px-2 py-0.5 text-label', CHAIN_TONE[a.chain])}>{AIO_CHAIN_LABEL[a.chain]}</span>
                  </td>
                  <td className="py-2 text-white font-semibold">
                    {a.symbol}
                    {a.name && a.name !== a.symbol && <span className="ml-2 font-normal text-krypt-muted">{a.name}</span>}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-white">{amount(a.amount)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums w-32" title={a.priceSource === 'stable' ? 'A dollar stablecoin, counted at $1' : a.dust ? 'Under a cent — listed, not counted in the total' : undefined}>
                    {a.usd === null ? <span className="text-krypt-muted">no price</span> : a.dust ? <span className="text-krypt-muted">&lt; $0.01</span> : dollars(a.usd)}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {a.kind !== 'native' && a.token && isAioChain(a.chain) && (
                      <span title={blocked ?? undefined}>
                        <GhostButton
                          destructive
                          onClick={() => void sell(a)}
                          disabled={blocked !== null || selling !== null}
                          className="!py-1 !px-2 text-label"
                        >
                          {selling === keyOf(a) ? 'Selling…' : 'Sell'}
                        </GhostButton>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(dust.length > 0 || emptyChains.length > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 px-4 py-2 text-label text-krypt-muted/80">
          <span>{emptyChains.length > 0 ? `Nothing on ${emptyChains.join(', ')}.` : ''}</span>
          {dust.length > 0 && (
            <button type="button" onClick={() => setShowDust((v) => !v)} className="text-krypt-muted hover:text-white transition">
              {showDust ? 'Hide' : 'Show'} {dust.length} tiny balance{dust.length === 1 ? '' : 's'} (under $0.01)
            </button>
          )}
        </div>
      )}
      {bal.chains.some((c) => !c.ok) && (
        <div className="px-4 py-2 border-t border-white/5 text-label text-amber-300/80">
          Not read: {bal.chains.filter((c) => !c.ok).map((c) => `${AIO_CHAIN_LABEL[c.chain]} (${c.message})`).join(' · ')}
        </div>
      )}
      <div className="px-4 py-2 border-t border-white/5 text-label text-krypt-muted/70">
        Solana lists every token the wallet holds. On BNB and Robinhood the list is the coin itself, the major tokens, everything bought here, and tokens sent to the wallet (Robinhood: found automatically; BNB: found when you use your own BNB RPC in Settings).
      </div>
    </Card>
  );
}

type CompressStep = { step: string; state: 'running' | 'done' | 'failed'; message: string };

/**
 * Compress (2026-10-03): everything into SOL, ETH or BNB. Review shows the
 * plan from a fresh read — what is sold, what is moved, what stays and why,
 * and about what it costs; Compress runs it after main's native
 * confirmation, with each step reported as it happens.
 */
function CompressCard({ info, onDone }: { info: AioWalletInfo; onDone: () => void }) {
  const toast = useToast();
  const modal = useModal();
  const [target, setTarget] = useState<AioChain>('solana');
  const [plan, setPlan] = useState<CompressPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<CompressStep[]>([]);

  useEffect(() => setPlan(null), [target]);
  useEffect(
    () =>
      window.krypt.engine.onEvent((ev) => {
        if (ev.kind !== 'aioCompress') return;
        setSteps((prev) => {
          const i = prev.findIndex((x) => x.step === ev.step);
          const next = { step: ev.step, state: ev.state, message: ev.message };
          return i < 0 ? [...prev, next] : prev.map((x, j) => (j === i ? next : x));
        });
      }),
    [],
  );

  const review = async (): Promise<void> => {
    setPlanning(true);
    try {
      const r = await window.krypt.aio.compressPlan(target);
      if (r.ok && r.data) setPlan(r.data);
      else toast.error(r.message);
    } finally {
      setPlanning(false);
    }
  };

  const goLive = async (chains: AioChain[]): Promise<void> => {
    const names = chains.map((c) => AIO_CHAIN_LABEL[c]).join(' and ');
    const yes = await modal.confirm({
      title: `Go Live on ${names}`,
      message: `Live signs and broadcasts REAL transactions on ${names} — for this and for anything else that trades there (your scripts and copy trading included) until you switch back to Paper in the top bar. Switch to Live?`,
      confirmLabel: 'Go Live',
      destructive: true,
    });
    if (!yes) return;
    const failed: string[] = [];
    for (const c of chains) {
      const r = c === 'solana' ? await window.krypt.live.setLive(true) : await window.krypt.evm.arm(c);
      if (!r.ok) failed.push(`${AIO_CHAIN_LABEL[c]}: ${r.message}`);
    }
    if (failed.length) toast.error(`Not switched — ${failed.join(' · ')}`);
    await review();
  };

  const run = async (): Promise<void> => {
    setRunning(true);
    setSteps([]);
    try {
      const r = await window.krypt.aio.compress(target);
      // A run with a failed step is not a success (v6 audit 2026-10-03).
      if (r.ok && r.data && r.data.steps.every((x) => x.ok)) toast.success(r.message);
      else toast.warn(r.message);
    } finally {
      setRunning(false);
      setPlan(null);
      onDone();
    }
  };

  if (!info.activeEverywhere) {
    return <Card><div className="text-xs text-krypt-muted">Make the All-in-One wallet the signer on every chain first (Use it on every chain, above).</div></Card>;
  }
  const todoSells = plan?.sells.filter((x) => !x.blocked) ?? [];
  const todoMoves = plan?.moves.filter((x) => !x.blocked) ?? [];
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label uppercase tracking-label text-krypt-muted">Into</span>
        <div className="inline-flex rounded-lg border border-white/12 text-label font-bold uppercase tracking-label">
          {COMPRESS_TARGETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setTarget(c)}
              aria-pressed={target === c}
              disabled={running}
              className={cls('px-3 py-1.5 transition', target === c ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white')}
            >
              {COMPRESS_COIN[c]} <span className="font-normal normal-case text-krypt-muted">· {AIO_CHAIN_LABEL[c]}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <GhostButton onClick={() => void review()} disabled={planning || running}>
          {planning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Review
        </GhostButton>
      </div>

      {plan && (
        <div className="space-y-2 text-xs">
          {plan.sells.length > 0 && (
            <div>
              <div className="text-label uppercase tracking-label text-krypt-muted/80">Sell</div>
              {plan.sells.map((x) => (
                <div key={`${x.chain}:${x.token}`} className="mt-1 flex items-baseline justify-between gap-3">
                  <span className={cls(x.blocked ? 'text-krypt-muted line-through' : 'text-white/90')}>
                    {amount(x.amount)} {x.symbol} <span className="text-krypt-muted">on {AIO_CHAIN_LABEL[x.chain]}</span>
                  </span>
                  <span className={cls('text-right', x.blocked ? 'text-amber-300/80' : 'font-mono text-white/80')}>{x.blocked ?? (x.usd === null ? 'no price' : dollars(x.usd))}</span>
                </div>
              ))}
            </div>
          )}
          {plan.moves.length > 0 && (
            <div>
              <div className="text-label uppercase tracking-label text-krypt-muted/80">Move</div>
              {plan.moves.map((m) => (
                <div key={m.from} className="mt-1 flex items-baseline justify-between gap-3">
                  <span className={cls(m.blocked ? 'text-krypt-muted' : 'text-white/90')}>
                    {m.estAmount !== null ? `about ${amount(m.estAmount)} ` : ''}{COMPRESS_COIN[m.from]} <span className="text-krypt-muted">{AIO_CHAIN_LABEL[m.from]} → {AIO_CHAIN_LABEL[m.to]}</span>
                  </span>
                  <span className={cls('text-right', m.blocked ? 'text-amber-300/80' : 'font-mono text-white/80')}>{m.blocked ?? dollars(m.estUsd)}</span>
                </div>
              ))}
            </div>
          )}
          {plan.unread.length > 0 && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              Not read just now: {plan.unread.map((c) => AIO_CHAIN_LABEL[c]).join(', ')} — whatever is there is not in this plan. Review again in a moment to include it.
            </div>
          )}
          {plan.stays.filter((x) => !plan.unread.includes(x.chain) || x.symbol !== '—').length > 0 && (
            <div className="text-label text-krypt-muted/80">
              Stays where it is: {plan.stays.filter((x) => x.symbol !== '—').map((x) => `${x.symbol} on ${AIO_CHAIN_LABEL[x.chain]}`).join(', ')} — reasons above.
            </div>
          )}
          {plan.needsLive.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              <span>{plan.needsLive.map((c) => AIO_CHAIN_LABEL[c]).join(' and ')} {plan.needsLive.length === 1 ? 'is' : 'are'} in Paper, so {plan.needsLive.length === 1 ? 'its' : 'their'} tokens would only be sold on paper.</span>
              <GhostButton onClick={() => void goLive(plan.needsLive)} disabled={running} className="!py-1 !px-2 text-label">Go Live on {plan.needsLive.map((c) => AIO_CHAIN_LABEL[c]).join(' + ')}</GhostButton>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-2">
            <div className="text-krypt-muted">
              {plan.nothingToDo
                ? `Nothing to do — it is already all ${plan.coin}, or what is left is too small to move.`
                : `${todoSells.length} sell${todoSells.length === 1 ? '' : 's'}, ${todoMoves.length} move${todoMoves.length === 1 ? '' : 's'}` +
                  (plan.estCostUsd !== null ? ` · about ${dollars(plan.estCostUsd)} in fees` : '') +
                  (plan.estFinalUsd !== null ? ` · about ${dollars(plan.estFinalUsd)} of ${plan.coin} at the end` : '')}
            </div>
            <PrimaryButton onClick={() => void run()} disabled={plan.nothingToDo || running}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />} Compress to {plan.coin}
            </PrimaryButton>
          </div>
        </div>
      )}

      {steps.length > 0 && (
        <div className="space-y-1 border-t border-white/10 pt-2 text-xs">
          {steps.map((x) => (
            <div key={x.step} className="flex items-baseline justify-between gap-3">
              <span className="text-white/90">
                {x.state === 'running' ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : x.state === 'done' ? <Check className="mr-1 inline h-3 w-3 text-emerald-300" /> : <AlertTriangle className="mr-1 inline h-3 w-3 text-rose-300" />}
                {x.step}
              </span>
              <span className={cls('truncate text-right', x.state === 'failed' ? 'text-rose-300/90' : 'text-krypt-muted')} title={x.message}>{x.message}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AioWalletPage() {
  const toast = useToast();
  const modal = useModal();
  const { settings } = useAppState();
  const [info, setInfo] = useState<AioWalletInfo | null>(null);
  const [bal, setBal] = useState<AioBalances | null>(null);
  const [balErr, setBalErr] = useState<string | null>(null);
  const [loadingBal, setLoadingBal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [sheet, setSheet] = useState<{ phrase: string; firstTime: boolean } | null>(null);

  const loadInfo = useCallback(async () => {
    const r = await window.krypt.aio.info();
    if (r.ok && r.data) setInfo(r.data as AioWalletInfo);
  }, []);

  const loadBalances = useCallback(async (refresh = false) => {
    setLoadingBal(true);
    const r = await window.krypt.aio.balances(refresh);
    setLoadingBal(false);
    if (r.ok && r.data) {
      setBal(r.data as AioBalances);
      setBalErr(null);
    } else setBalErr(r.message);
  }, []);

  useEffect(() => {
    void loadInfo();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'aioChanged' || ev.kind === 'walletSwitched') void loadInfo();
    });
    return off;
  }, [loadInfo]);

  useEffect(() => {
    if (!info?.exists) return;
    void loadBalances();
    const t = setInterval(() => void loadBalances(), 30_000);
    return () => clearInterval(t);
  }, [info?.exists, loadBalances]);

  const doCreate = async (): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.aio.create();
    setBusy(false);
    if (r.ok && r.data) {
      const d = r.data as { info: AioWalletInfo; phrase?: string };
      setInfo(d.info);
      if (d.phrase) setSheet({ phrase: d.phrase, firstTime: true });
      toast.success('All-in-One wallet created — write down its recovery phrase now');
    } else if (r.message !== 'Cancelled') toast.error(r.message);
  };

  // Where the phrase holds money, per derivation path (read-only scan).
  const [scan, setScan] = useState<{ solana: AioScanRow[]; evm: AioScanRow[] } | null>(null);
  const [choice, setChoice] = useState<{ solana: string; evm: string }>({ ...DEFAULT_AIO_PATHS });
  const held = (r: AioScanRow): number => Object.values(r.balances).reduce<number>((a, v) => a + (v ?? 0), 0);
  const funded = (rows: AioScanRow[]): AioScanRow[] => rows.filter((r) => held(r) > 0);
  /** A balance main could not read is null — unknown, never an empty account. */
  const unreadRow = (r: AioScanRow): boolean => Object.values(r.balances).some((v) => v === null || v === undefined);

  const finishImport = async (paths: { solana: string; evm: string } | null): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.aio.import(importText, '', paths);
    setBusy(false);
    if (r.ok && r.data) {
      setInfo(r.data as AioWalletInfo);
      setImportText('');
      setShowImport(false);
      setScan(null);
      toast.success(r.message);
    } else if (r.message !== 'Import cancelled') toast.error(r.message);
  };

  const doImport = async (): Promise<void> => {
    // Look first: wallets derive different paths, and a phrase read the
    // wrong way shows an EMPTY wallet (Trust Wallet, MetaMask account 2…).
    setBusy(true);
    const sc = await window.krypt.aio.scanPhrase(importText);
    setBusy(false);
    if (!sc.ok || !sc.data) {
      toast.error(sc.message);
      return;
    }
    const sol = funded(sc.data.solana);
    const evm = funded(sc.data.evm);
    const elsewhere = sol.some((r) => r.id !== DEFAULT_AIO_PATHS.solana) || evm.some((r) => r.id !== DEFAULT_AIO_PATHS.evm);
    // An account that could not be read is not "empty": the picker is shown
    // so nobody silently gets the default while their money sits on another
    // account (v6 audit 2026-10-03).
    const unread = [...sc.data.solana, ...sc.data.evm].some(unreadRow);
    if (!elsewhere && !unread) {
      await finishImport(null); // money only on the usual accounts (or none): as before
      return;
    }
    // Pre-pick the account holding the most on each chain.
    const pick = (rows: AioScanRow[], dflt: string): string => (rows.length ? [...rows].sort((a, b) => held(b) - held(a))[0]!.id : dflt);
    setChoice({ solana: pick(sol, DEFAULT_AIO_PATHS.solana), evm: pick(evm, DEFAULT_AIO_PATHS.evm) });
    setScan(sc.data);
  };

  // The confirmation is a native dialog in main (page content cannot press
  // it), so the page asks nothing itself — one prompt, not two.
  const doReveal = async (): Promise<void> => {
    const r = await window.krypt.aio.reveal();
    if (r.ok && typeof r.data === 'string') setSheet({ phrase: r.data, firstTime: false });
    else if (r.message !== 'Cancelled') toast.error(r.message);
  };

  const doBackedUp = async (): Promise<void> => {
    setSheet(null);
    const r = await window.krypt.aio.backedUp();
    if (r.ok && r.data) setInfo(r.data as AioWalletInfo);
    else toast.error(r.message);
  };

  const doActivate = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Use it on every chain',
      message:
        'Solana, BNB Chain and Robinhood will all sign with the All-in-One wallet. The wallets that sign there now keep their own coins and positions, and any orders made on them pause until you switch back. To bring money over first, use Send on those wallet pages.',
      confirmLabel: 'Use it everywhere',
    });
    if (!yes) return;
    setBusy(true);
    const r = await window.krypt.aio.activate();
    setBusy(false);
    if (r.ok && r.data) {
      setInfo(r.data as AioWalletInfo);
      toast.success(r.message);
    } else toast.error(r.message);
  };

  const doRepair = async (): Promise<void> => {
    const r = await window.krypt.aio.repair();
    if (r.ok && r.data) {
      setInfo(r.data as AioWalletInfo);
      toast.success(r.message);
    } else toast.error(r.message);
  };

  const doRemove = async (): Promise<void> => {
    // Main checks every reason to refuse first, then asks in a native dialog
    // that page content cannot press — one question, after the refusals.
    const r = await window.krypt.aio.remove();
    if (r.ok && r.data) {
      setInfo(r.data as AioWalletInfo);
      setBal(null);
      toast.info(r.message);
    } else if (r.message !== 'Remove cancelled') toast.error(r.message);
  };

  const signsEverywhere = info?.activeEverywhere === true;
  // Re-render every few seconds so "read N ago" never freezes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Page
      title="All-in-One Wallet"
      subtitle="One wallet on Solana, BNB Chain and Robinhood, backed up by one recovery phrase and shown in dollars."
      actions={
        <div className="flex items-center gap-2">
          {/* The video guide (2026-10-03): through main, never a bare href. */}
          <PrimaryButton onClick={() => void window.krypt.app.openExternal(AIO_WALLET_VIDEO_URL)}>
            <PlayCircle className="h-4 w-4" /> Watch the guide
          </PrimaryButton>
          {info?.exists && (
            <GhostButton onClick={() => void loadBalances(true)} disabled={loadingBal}>
              <RefreshCw className={cls('h-4 w-4', loadingBal && 'animate-spin')} /> Refresh
            </GhostButton>
          )}
        </div>
      }
    >
      {sheet && (
        <PhraseSheet
          phrase={sheet.phrase}
          firstTime={sheet.firstTime}
          onDone={() => void doBackedUp()}
          onClose={() => setSheet(null)}
        />
      )}

      {info?.failure && (
        <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-500/5 px-4 py-3 flex items-start gap-3 text-xs text-rose-200">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /> {info.failure}
        </div>
      )}

      {/* The look that sets it apart: one gradient-edged plate for every chain. */}
      <div className="relative mb-6 rounded-2xl p-[1px] bg-gradient-to-r from-violet-500/60 via-amber-400/50 to-emerald-400/60">
        <div className="rounded-2xl bg-black/80 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 font-display text-label uppercase tracking-eyebrow text-arc-gold/80">
                <Layers className="h-3.5 w-3.5" /> All-in-One
              </div>
              {info?.exists ? (
                <>
                  <div className="mt-1.5 text-4xl font-bold font-mono tabular-nums text-white">{bal ? dollars(bal.totalUsd) : '—'}</div>
                  <div className="mt-1 text-xs text-krypt-muted">
                    {bal
                      ? [
                          bal.partial ? 'not every chain answered in full — this is at least what it holds' : null,
                          bal.unpriced ? `${bal.unpriced} token${bal.unpriced === 1 ? '' : 's'} without a price, not counted` : null,
                          `read ${fmtAgo(bal.at)} ago`,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : balErr ?? (loadingBal ? 'Reading every chain…' : '')}
                  </div>
                </>
              ) : (
                <div className="mt-1.5 text-sm text-krypt-muted">No All-in-One wallet yet</div>
              )}
            </div>
            {info?.exists && (
              <div className="flex flex-wrap justify-end gap-1.5 max-w-[50%]">
                {(bal?.chains ?? []).map((c) => (
                  <span
                    key={c.chain}
                    title={c.ok ? undefined : c.message ?? 'not read'}
                    className={cls('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-label', CHAIN_TONE[c.chain], !c.ok && 'opacity-50')}
                  >
                    {AIO_CHAIN_LABEL[c.chain]} <span className="font-mono tabular-nums text-white/90">{c.ok && c.usd !== null ? dollars(c.usd) : '—'}{c.partial ? '+' : ''}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {!info?.exists ? (
        <Section title="Set it up">
          <Card className="space-y-4">
            <div className="text-sm text-white">One wallet for every chain the app trades.</div>
            <ul className="text-xs text-krypt-muted space-y-1 list-disc pl-5">
              <li>A Solana address, and one EVM address that works on BNB Chain, Robinhood and every other EVM chain.</li>
              <li>One 12-word recovery phrase backs up all of it, and opens it in Phantom and MetaMask too.</li>
              <li>One balance in dollars, whatever chain the money is on.</li>
              <li>Buy on any chain: when that chain is short, the buy tops itself up from your other chains first (in Live, once it signs on every chain).</li>
            </ul>
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void doCreate()} disabled={busy || !!info?.failure}>
                <Layers className="h-4 w-4" /> Create All-in-One wallet
              </PrimaryButton>
              <GhostButton onClick={() => setShowImport((v) => !v)}>Use my recovery phrase</GhostButton>
            </div>
            {showImport && (
              <div className="space-y-2 pt-2 border-t border-white/10">
                <div className="flex items-center gap-2 text-xs text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" /> The phrase of a wallet you use elsewhere gives this app the same keys. Prefer a fresh one for trading.
                </div>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="twelve or twenty-four words, separated by spaces"
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60 resize-y"
                />
                {!scan && <PrimaryButton onClick={() => void doImport()} disabled={busy || !importText.trim()}>Import</PrimaryButton>}
                {scan && (
                  <div className="space-y-3 rounded-lg border border-violet-400/30 bg-violet-500/5 p-3">
                    <div className="text-xs text-white">
                      {[...scan.solana, ...scan.evm].some(unreadRow)
                        ? 'Some accounts could not be read just now (shown as —), so the app cannot tell where this phrase holds money. Pick the account to use on each chain, or go Back and try again in a moment:'
                        : 'This phrase holds money on more than the usual first account. Pick the account to use on each chain:'}
                    </div>
                    {(['solana', 'evm'] as const).map((side) => {
                      const rows = scan[side].filter((r) => held(r) > 0 || unreadRow(r) || r.id === DEFAULT_AIO_PATHS[side]);
                      return (
                        <fieldset key={side} className="space-y-1">
                          <legend className="text-label uppercase tracking-label text-krypt-muted">{side === 'solana' ? 'Solana' : 'EVM (BNB Chain, Robinhood)'}</legend>
                          {rows.map((r) => (
                            <label key={r.id} className="flex cursor-pointer items-center gap-2 text-xs text-white/90">
                              <input type="radio" name={`aio-path-${side}`} checked={choice[side] === r.id} onChange={() => setChoice((c) => ({ ...c, [side]: r.id }))} />
                              <span className="w-56 truncate">{r.label}</span>
                              <span className="font-mono text-krypt-muted">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>
                              <span className="font-mono">
                                {Object.entries(r.balances)
                                  .map(([c, v]) => `${v === null || v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${c === 'solana' ? 'SOL' : c === 'bnb' ? 'BNB' : 'ETH'}`)
                                  .join(' · ')}
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      );
                    })}
                    <div className="flex gap-2">
                      <PrimaryButton onClick={() => void finishImport(choice)} disabled={busy}>Import these</PrimaryButton>
                      <GhostButton onClick={() => setScan(null)} disabled={busy}>Back</GhostButton>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        </Section>
      ) : (
        <>
          {!info.backedUp && (
            <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-amber-300 flex-shrink-0" />
              <div className="flex-1 text-xs text-krypt-muted">
                <span className="text-white font-semibold">Back up the recovery phrase.</span> Until it is written down, this computer holds the only copy of every key in this wallet.
              </div>
              <PrimaryButton onClick={() => void doReveal()}>
                <Eye className="h-4 w-4" /> Show phrase
              </PrimaryButton>
            </div>
          )}

          {info.missing.length > 0 && (
            <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-500/5 px-4 py-3 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-rose-300 flex-shrink-0" />
              <div className="flex-1 text-xs text-krypt-muted">
                Its {info.missing.map((m) => (m === 'solana' ? 'Solana' : 'EVM')).join(' and ')} key is no longer in the wallet list. The recovery phrase can put it back.
              </div>
              <GhostButton onClick={() => void doRepair()}>
                <Wrench className="h-4 w-4" /> Repair
              </GhostButton>
            </div>
          )}

          <Section
            title="Where it signs"
            description="Each chain trades with one wallet at a time. Make this one the signer everywhere, and every buy and sell on every chain uses it. Switch the top bar to Paper first — a wallet never changes under a live trade."
          >
            <Card className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {AIO_CHAINS.map((c: AioChain) => (
                  <div key={c} className={cls('rounded-lg border px-3 py-2', info.signingOn[c] ? 'border-emerald-400/30 bg-emerald-500/5' : 'border-white/10 bg-white/[0.02]')}>
                    <div className="text-xs font-semibold text-white">{AIO_CHAIN_LABEL[c]}</div>
                    <div className={cls('text-label mt-0.5', info.signingOn[c] ? 'text-emerald-300' : 'text-krypt-muted')}>
                      {info.signingOn[c] ? 'Signs with this wallet' : 'Another wallet signs here'}
                    </div>
                  </div>
                ))}
              </div>
              {!signsEverywhere && (
                <PrimaryButton onClick={() => void doActivate()} disabled={busy || info.missing.length > 0}>
                  <Globe2 className="h-4 w-4" /> Use it on every chain
                </PrimaryButton>
              )}
            </Card>
          </Section>

          <Section title="Speed" description="How fast moves and top-ups go, and whether to keep money ready on each chain.">
            <AioSpeedCard />
          </Section>

          <Section
            title="Move between chains"
            description="From this wallet on one chain to the same wallet on another, through Relay. Krypt's fee applies, as on a trade. A buy that is short on its chain tops itself up the same way, with no separate fee."
          >
            <MoveCard info={info} bal={bal} onMoved={() => void loadBalances(true)} />
          </Section>

          <Section title="Send" description="To any address — a friend, an exchange, your other wallet. Pick the chain, then what to send. No Krypt fee; you confirm in a system dialog.">
            <AioSendCard info={info} onSent={() => void loadBalances(true)} />
          </Section>

          <Section title="Receive" description="Two addresses cover everything. Send on the right network — a Solana coin to the Solana address, anything on an EVM chain to the other one.">
            <Card className="space-y-3">
              <div className="flex items-center gap-3">
                <span className={cls('rounded-full border px-2 py-0.5 text-label', CHAIN_TONE.solana)}>Solana</span>
                {info.solanaAddress && <div className="flex-1 min-w-0"><Copyable value={info.solanaAddress} /></div>}
              </div>
              <div className="flex items-center gap-3">
                <span className={cls('rounded-full border px-2 py-0.5 text-label', CHAIN_TONE.bnb)}>EVM</span>
                {info.evmAddress && <div className="flex-1 min-w-0"><Copyable value={info.evmAddress} /></div>}
              </div>
              <div className="text-label text-krypt-muted">
                The EVM address receives on BNB Chain, Robinhood, Ethereum, Base and Arbitrum. Coins sent on Ethereum, Base or Arbitrum show in the total; the app trades on BNB Chain and Robinhood.
                {settings.execution.autoSwapUsdc !== false && (
                  <span className="mt-1 block text-amber-200/80">
                    USDC sent to the Solana address is swapped to SOL automatically while Solana is in Live (Krypt's 0.5 % applies, as on any swap). To keep it as USDC, turn off "Auto-swap USDC to SOL" on the Sol Wallet page.
                  </span>
                )}
              </div>
            </Card>
          </Section>

          <Section title="What it holds" description="Every coin and token, the chain it is on, and what it is worth. Sell turns a token into that chain's own coin.">
            <HoldingsCard info={info} bal={bal} balErr={balErr} onChanged={() => void loadBalances(true)} />
          </Section>

          <Section
            title="Compress"
            description="Turn everything into one coin on one chain — SOL, ETH or BNB — so it can go out in a single send. Sells every token for its chain's coin, then moves each chain's coin across. You see the whole plan, and confirm it once, before anything happens."
          >
            <CompressCard info={info} onDone={() => void loadBalances(true)} />
          </Section>

          <Section title="Keys">
            <Card className="flex flex-wrap items-center gap-2">
              <GhostButton onClick={() => void doReveal()}>
                <Eye className="h-4 w-4" /> Show recovery phrase
              </GhostButton>
              {info.backedUp ? <Badge tone="success">Backed up</Badge> : <Badge tone="warn">Not backed up</Badge>}
              <div className="flex-1" />
              <GhostButton destructive onClick={() => void doRemove()}>
                <Trash2 className="h-4 w-4" /> Remove
              </GhostButton>
            </Card>
          </Section>
        </>
      )}
    </Page>
  );
}
