import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { EVM_CHAIN_META, EVM_FEE_BPS, VENUE_LABEL, type EvmChainKind, type EvmQuote, type EvmTokenState } from '@shared/evm';
import { cls, fmtUsd, shortAddr } from '../../utils/format';
import { KRYPTO_TOKEN } from '@shared/krypto';
import { holderFeeBps } from '@shared/krypto';
import { useKryptoWaiver } from '../../state/useKryptoWaiver';
import { WaiverHint } from './WaiverHint';
import { fmtNative, fmtTokens, isPendingResult, PENDING_TOAST, rawToNumber, weiToNumber } from '../../utils/evm';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { useEvmState } from '../../state/useEvmState';

// The EVM trade panel — one component for both EVM chains, told which one
// by `chain`. Same job as TradePanel (Solana): a better surface on the
// rail's own execution path (evm:buy / evm:sell), which simulates the exact
// bytes, re-checks the signer's policy and reconciles the fill from the
// receipt. This panel adds a LIVE QUOTE — the rail answers with the curve's
// or the pool's own number for the amount typed, so what the button says
// is what the chain said a moment ago.
//
// Paper here is a simulation of the real calldata (gas estimate included);
// nothing is broadcast and no paper position is kept. The button says so.
// Paper/Live is PER CHAIN: this pill arms only the chain it names.

const BUY_PRESETS: Record<EvmChainKind, number[]> = {
  robinhood: [0.005, 0.01, 0.025, 0.05, 0.1],
  bnb: [0.01, 0.02, 0.05, 0.1, 0.25],
};
const DEFAULT_BUY: Record<EvmChainKind, number> = { robinhood: 0.01, bnb: 0.02 };
/** Above this a live buy asks first — roughly $1,000 of either unit. */
const LARGE_BUY: Record<EvmChainKind, number> = { robinhood: 0.5, bnb: 1 };
const SELL_PRESETS = [10, 25, 50, 75, 100];

export function EvmTradePanel({
  chain,
  address,
  symbol,
  decimals,
  state,
  settings,
  nativeUsd,
  onTraded,
}: {
  chain: EvmChainKind;
  address: string;
  symbol: string;
  decimals: number;
  state: EvmTokenState | null;
  settings: AppSettings;
  nativeUsd: number | null;
  onTraded: () => void;
}) {
  const toast = useToast();
  const modal = useModal();
  const waiver = useKryptoWaiver();
  const meta = EVM_CHAIN_META[chain];
  const sym = meta.nativeSymbol;
  const { evm, refresh } = useEvmState(chain);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState(DEFAULT_BUY[chain]);
  const [sellPct, setSellPct] = useState(100);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<EvmQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  // 0.01 ETH and 0.01 BNB are different bets; re-seed on a chain change.
  useEffect(() => {
    setAmount(DEFAULT_BUY[chain]);
  }, [chain]);

  // `evm === null` is UNKNOWN, not "no wallet": the rail answers in one round
  // trip, and while the public RPC is parked that can take a moment. Saying
  // "create a wallet" to someone who has one — and refusing their sell — is
  // the honest-null rule broken at the worst place.
  const loaded = evm !== null;
  const armed = evm?.live.armed === true;
  const walletExists = evm?.wallet.exists === true;
  const balance = evm?.wallet.balanceNative ?? null;
  const balanceKnown = typeof balance === 'number';
  const feesOn = evm?.feesEnabled === true;
  const slippage = settings.evm.slippagePct;

  // Live quote, debounced. A sell needs a wallet (the size is a share of
  // what it holds); a buy quotes without one.
  useEffect(() => {
    const size = side === 'buy' ? amount : sellPct;
    if (!(size > 0) || (side === 'sell' && !walletExists) || state?.venue === 'unknown') {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const id = setTimeout(async () => {
      try {
        const r = await window.krypt.evm.quote(chain, side, address, size);
        if (cancelled) return;
        if (r.ok && r.data) {
          setQuote(r.data);
          setQuoteError(null);
        } else {
          setQuote(null);
          setQuoteError(r.message);
        }
      } catch (err) {
        if (!cancelled) setQuoteError((err as Error).message);
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [chain, side, amount, sellPct, address, walletExists, state?.venue]);

  const blocked = !loaded
    ? 'Reading the EVM wallet…'
    : evm?.wallet.failure
      ? `Wallet file could not be read — nothing was overwritten. ${evm.wallet.failure}`
      : !walletExists
    ? 'No EVM wallet. Create one on the Wallet page — it serves Robinhood Chain and BNB Smart Chain alike.'
    : // `untradable` comes from a venue probe that quotes a 0.001-native BUY.
      // That is a fair answer for buying and a bad one for selling: it greyed
      // out the Sell button on a bag the user is holding, which is a limit
      // blocking an exit. A sell is always ATTEMPTABLE — the quote and the
      // plan report honestly if it truly cannot route, and the warning is
      // still shown below either way.
      state?.untradable && side === 'buy'
      ? state.untradable
      : side === 'buy' && armed && balanceKnown && (balance ?? 0) <= 0
        ? `This wallet has no ${sym} on ${meta.name} — send some in, or switch to Paper.`
        : null;

  const setMode = async (wantLive: boolean): Promise<void> => {
    if (wantLive === armed) return;
    if (wantLive) {
      const yes = await modal.confirm({
        title: `Go Live on ${meta.name}`,
        message: `Live signs and broadcasts REAL transactions from your EVM wallet on ${meta.name}. Every trade is still simulated and policy-checked before it sends — but real ${sym} moves. Switch to Live?`,
        confirmLabel: 'Go Live',
        destructive: true,
      });
      if (!yes) return;
      const r = await window.krypt.evm.arm(chain);
      r.ok ? toast.warn(r.message) : toast.error(r.message);
    } else {
      const r = await window.krypt.evm.disarm(chain);
      r.ok ? toast.success(r.message) : toast.error(r.message);
    }
    void refresh();
  };

  const doTrade = async (): Promise<void> => {
    // A quick-buy field takes any number, and the only guard in main refuses
    // above 50 native — 50 BNB is roughly $38,000. Anything unusually large
    // gets the same confirmation that arming does, so a stray digit cannot
    // spend a fortune on one click.
    if (side === 'buy' && armed && amount > LARGE_BUY[chain]) {
      const yes = await modal.confirm({
        title: `Buy ${fmtNative(amount, sym)}?`,
        message: `That is a large trade on ${meta.name}${nativeUsd ? ` — about ${fmtUsd(amount * nativeUsd)}` : ''}. It will be signed and broadcast from your EVM wallet. Continue?`,
        confirmLabel: `Buy ${fmtNative(amount, sym)}`,
        destructive: true,
      });
      if (!yes) return;
    }
    setBusy(true);
    try {
      const r = side === 'buy'
        ? await window.krypt.evm.buy(chain, address, amount, !armed)
        : await window.krypt.evm.sell(chain, address, sellPct, !armed);
      if (r.ok) toast.success(r.message);
      else if (isPendingResult(r)) toast.warn(PENDING_TOAST);
      else toast.error(r.message);
      onTraded();
      void refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toUsd = (v: number | null): string => (v === null ? '—' : nativeUsd ? fmtUsd(v * nativeUsd) : fmtNative(v, sym));
  const expectedTokens = quote && side === 'buy' ? rawToNumber(quote.amountOut, decimals) : null;
  const minTokens = quote && side === 'buy' ? rawToNumber(quote.minOut, decimals) : null;
  const expectedNative = quote && side === 'sell' ? weiToNumber(quote.amountOut) : null;
  const minNative = quote && side === 'sell' ? weiToNumber(quote.minOut) : null;
  const feeNative = quote ? weiToNumber(quote.feeWei) : null;
  const gasNative = quote ? weiToNumber(quote.gasCostWei) : null;
  const totalOut = side === 'buy' && quote ? amount + (feeNative ?? 0) + (gasNative ?? 0) : null;

  return (
    <div className="space-y-3">
      {/* This chain's own mode. The top-bar switch follows the selected chain. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-label uppercase tracking-label text-krypt-muted/70">{meta.name}</span>
        <div className="inline-flex rounded-lg border border-white/12 overflow-hidden text-label font-bold uppercase tracking-label">
          <button
            onClick={() => void setMode(false)}
            className={cls('px-2.5 py-1 transition', !armed ? 'bg-emerald-500/20 text-emerald-200' : 'text-krypt-muted hover:text-white')}
          >
            Paper
          </button>
          <button
            onClick={() => void setMode(true)}
            disabled={!loaded || !walletExists}
            title={!loaded ? 'Reading the EVM wallet…' : walletExists ? undefined : 'Create an EVM wallet first'}
            className={cls('px-2.5 py-1 transition disabled:opacity-40', armed ? 'bg-rose-500/25 text-rose-200 shadow-crimson-glow' : 'text-krypt-muted hover:text-white')}
          >
            Live
          </button>
        </div>
      </div>

      {/* Side */}
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 p-1 bg-black/30">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={cls(
              'rounded-md py-2 text-note font-bold uppercase tracking-label transition',
              side === s
                ? s === 'buy'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                  : 'bg-rose-500/20 text-rose-300 border border-rose-400/40'
                : 'text-krypt-muted hover:text-white border border-transparent',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {side === 'buy' ? (
        <>
          <div className="grid grid-cols-5 gap-1">
            {BUY_PRESETS[chain].map((p) => (
              <button
                key={p}
                onClick={() => setAmount(p)}
                className={cls(
                  'rounded-md border py-1.5 text-body font-mono font-semibold transition',
                  amount === p
                    ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white'
                    : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-lg border border-white/10 bg-black/40 overflow-hidden">
            <input
              type="number"
              min={0}
              step={0.001}
              value={amount}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setAmount(n);
              }}
              className="flex-1 bg-transparent px-3 py-2.5 text-sm font-mono text-white outline-none"
            />
            <span className="px-3 text-body uppercase text-krypt-muted">{sym}</span>
          </div>
          <div className="text-body text-krypt-muted text-right -mt-1">
            {nativeUsd ? `≈ ${fmtUsd(amount * nativeUsd)}` : `${sym} price unavailable`}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-5 gap-1">
          {SELL_PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => setSellPct(p)}
              className={cls(
                'rounded-md border py-1.5 text-body font-mono font-semibold transition',
                sellPct === p
                  ? 'border-rose-400/50 bg-rose-500/20 text-white'
                  : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
              )}
            >
              {p}%
            </button>
          ))}
        </div>
      )}

      {/* The quote: what the chain said a moment ago for exactly this size. */}
      <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 space-y-1 text-body">
        <div className="flex items-center justify-between gap-3">
          <span className="text-krypt-muted/80">Expected</span>
          <span className="font-mono text-white/90 tabular-nums flex items-center gap-1.5">
            {quoting && <Loader2 className="h-3 w-3 animate-spin text-krypt-purple" />}
            {quote
              ? side === 'buy'
                ? `${fmtTokens(expectedTokens)} ${symbol || 'tokens'}`
                : fmtNative(expectedNative, sym)
              : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-krypt-muted/80">Min at {side === 'sell' ? Math.max(slippage, 15) : slippage}% slippage</span>
          <span className="font-mono text-white/70 tabular-nums">
            {quote ? (side === 'buy' ? `${fmtTokens(minTokens)}` : fmtNative(minNative, sym)) : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          {/* The $KRYPTO holder rate covers every chain, so this line has to
              know about it too — the quote is already priced with it main-side. */}
          <span className="text-krypt-muted/80">
            Krypt fee {feesOn ? `${(holderFeeBps(EVM_FEE_BPS, waiver.halved) / 100).toFixed(2).replace(/\.?0+$/, '')}%` : ''}
          </span>
          <span className={cls('font-mono tabular-nums', waiver.halved ? 'text-emerald-300/80' : 'text-white/70')}>
            {!feesOn
              ? 'no platform fee yet'
              : quote
                ? `${fmtNative(feeNative, sym)}${feeNative !== null && nativeUsd ? ` (${fmtUsd(feeNative * nativeUsd)})` : ''}${waiver.halved ? ` · halved (${KRYPTO_TOKEN.symbol} holder)` : ''}`
                : '—'}
          </span>
        </div>
        {/* The holder rate is every chain's, so the way to it belongs on every
            chain's fee line. `charged` keeps it off a panel that is not
            taking a fee in the first place. */}
        <WaiverHint halved={waiver.halved} charged={feesOn} className="text-right" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-krypt-muted/80">Gas (est.)</span>
          <span className="font-mono text-white/70 tabular-nums">{quote && gasNative !== null ? toUsd(gasNative) : '—'}</span>
        </div>
        {side === 'buy' && (
          // The button says the swap amount, but a curve buy also debits the
          // Krypt fee as its own transfer, plus gas. This is what leaves the
          // wallet. (The venue's own fee is already inside the quote.)
          <div className="flex items-center justify-between gap-3">
            <span className="text-krypt-muted/80">Total out</span>
            <span className="font-mono text-white/90 tabular-nums">{totalOut === null ? '—' : `${fmtNative(totalOut, sym)}${nativeUsd ? ` (${fmtUsd(totalOut * nativeUsd)})` : ''}`}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-krypt-muted/80">Route</span>
          <span className="font-mono text-white/70">
            {quote ? VENUE_LABEL[quote.venue] : state ? VENUE_LABEL[state.venue] : '—'}
            {quote && !quote.simulated && <span className="text-amber-300/80"> · formula</span>}
          </span>
        </div>
        {quote && quote.approvalsNeeded > 0 && (
          <p className="text-label text-arc-gold/80 leading-relaxed">
            {quote.approvalsNeeded} one-time approval transaction{quote.approvalsNeeded === 1 ? '' : 's'} will be sent first so the router can move this token.
          </p>
        )}
        {quote?.note && <p className="text-label text-krypt-muted/70 leading-relaxed">{quote.note}</p>}
        {quoteError && <p className="text-label text-rose-300/90 leading-relaxed">{quoteError}</p>}
      </div>

      <button
        onClick={() => void doTrade()}
        disabled={busy || blocked !== null}
        className={cls(
          'w-full rounded-lg border py-3 text-sm font-bold uppercase tracking-action transition flex items-center justify-center gap-2',
          blocked !== null
            ? 'border-white/8 bg-white/5 text-krypt-muted/50 cursor-not-allowed'
            : side === 'buy'
              ? 'border-emerald-400/45 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
              : 'border-rose-400/45 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30',
        )}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {side === 'buy'
          ? armed ? `Buy ${amount} ${sym}` : `Simulate buy ${amount} ${sym}`
          : armed ? `Sell ${sellPct}%` : `Simulate sell ${sellPct}%`}
      </button>

      {/* Shown even when it does not block: on a sell it is a warning, not a
          refusal. */}
      {side === 'sell' && !blocked && state?.untradable && (
        <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-body leading-relaxed text-amber-200">
          {state.untradable} — selling is still allowed; the quote below is the honest answer.
        </p>
      )}
      {blocked && (
        <p className="text-body text-arc-gold/80 leading-relaxed flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
          {blocked}
        </p>
      )}

      {!armed && walletExists && !blocked && (
        <p className="text-label text-krypt-muted/60 leading-relaxed">
          Paper: the real transaction is estimated on the chain and nothing is sent. No paper position is kept for {meta.shortName} yet.
        </p>
      )}

      <div className="flex items-center justify-between text-label text-krypt-muted/60 pt-1 border-t border-white/5">
        <span>{evm?.wallet.address ? shortAddr(evm.wallet.address, 4) : 'no wallet'}</span>
        <span>{balanceKnown ? fmtNative(balance, sym) : '—'}</span>
      </div>
    </div>
  );
}
