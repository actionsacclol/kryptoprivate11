import { useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { TokenSummary } from '@shared/market';
import type { AppSettings, LiveState, WalletInfo } from '@shared/types';
import { FEE_BPS, splitFee } from '@shared/fees';
import { KRYPTO_FEE_WAIVER_TOKENS, KRYPTO_TOKEN } from '@shared/krypto';
import { useKryptoWaiver } from '../../state/useKryptoWaiver';
import { cls, fmtUsd, shortAddr } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

// The trade panel. It drives the EXISTING signer (live:testTrade /
// live:sellToken), so nothing about custody, arming or the loss guard
// changes here — this is a better surface on the same execution path.
//
// The cost block is the honest-intel feature that survived every pass of the
// 2026-08-16 product swarm: show the ALL-IN cost before the click, including
// the parts competitors leave out. Numbers here are estimates and say so;
// the exact figures come back from the execution diagnostics after the fill.

const BUY_PRESETS = [0.05, 0.1, 0.25, 0.5, 1];
const SELL_PRESETS = [10, 25, 50, 75, 100];

/** Relayer fee when the app is not building the transaction itself. */
const RELAYER_FEE_PCT = 0.5;
/** pump.fun protocol fee, per side. */
const PROTOCOL_FEE_PCT = 1.0;

export function TradePanel({
  token,
  settings,
  wallet,
  live,
  solUsd,
  onTraded,
}: {
  token: TokenSummary;
  settings: AppSettings;
  wallet: WalletInfo | null;
  live: LiveState | null;
  solUsd: number | null;
  onTraded: () => void;
}) {
  const toast = useToast();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amountSol, setAmountSol] = useState(0.1);
  const [sellPct, setSellPct] = useState(100);
  const [busy, setBusy] = useState(false);

  // ONE mode: Live (real SOL) when armed AND broadcast is on, else Paper.
  const isLive = live?.armed === true && settings.execution.liveEnabled;
  // Honest null: a balance that has not been checked yet is UNKNOWN, not
  // zero — only a known zero blocks a live buy.
  const balanceKnown = typeof wallet?.balanceSol === 'number';
  const funded = balanceKnown && (wallet?.balanceSol ?? 0) > 0;

  // Krypt's fee is waived for $KRYPTO holders. Read from the same answer the
  // signer uses, so the number on the screen where the money is committed is
  // the number that will actually be taken. Unknown reads as charged, which
  // is the direction main errs in too.
  const waiver = useKryptoWaiver();
  const cost = useMemo(() => {
    const usd = solUsd ? amountSol * solUsd : null;
    const protocol = amountSol * (PROTOCOL_FEE_PCT / 100);
    const relayer = settings.execution.localTxBuild ? 0 : amountSol * (RELAYER_FEE_PCT / 100);
    // Krypt's own cut. Leaving it out of a block headed "estimated total
    // fees" understated what the same transaction charges, on the screen
    // where the user decides the size.
    const krypt = waiver.waived ? 0 : splitFee(Math.round(amountSol * 1e9), false).totalLamports / 1e9;
    const priority = 0.002; // modeled; the real figure comes from the fee estimator
    // Landing tips are paid on the same transaction whenever a fast lane is on.
    const tips = settings.execution.useJito || settings.execution.useHeliusSender ? 0.0005 : 0;
    const network = 0.000005;
    const rent = 0.00204; // ATA creation, refundable via rent sweep
    const total = protocol + relayer + krypt + priority + tips + network + rent;
    return { usd, protocol, relayer, krypt, priority, tips, network, rent, total };
  }, [amountSol, solUsd, waiver.waived, settings.execution.localTxBuild, settings.execution.useJito, settings.execution.useHeliusSender]);

  const toUsd = (sol: number): string => (solUsd ? fmtUsd(sol * solUsd) : `${sol.toFixed(5)} SOL`);

  // Gating follows the ONE mode:
  //   • Paper — always allowed once a wallet exists; nothing is broadcast, so
  //     no funding/cap checks. This is the default and needs no ceremony.
  //   • Live buy — needs a funded wallet. The per-trade cap does NOT apply to a
  //     buy you place by hand (it bounds orders, copy trade and fan-out), and
  //     the panel does not mention it — a manual size is the user's call.
  //   • Sell — never blocked by mode beyond needing a wallet; a paper sell
  //     simulates, a live sell is real. Refusing an exit is a trap the order
  //     engine avoids too ("breakers stop buys, never sells").
  const blocked = !wallet?.exists
    ? 'No trading wallet. Create one on the Wallet page.'
    : side === 'buy' && isLive
      ? balanceKnown && !funded
        ? 'Trading wallet has no SOL — switch to Paper or fund it.'
        : null
      : null;

  const doBuy = async (): Promise<void> => {
    setBusy(true);
    try {
      // Paper mode simulates (nothing broadcast); Live mode is a real buy.
      // Either way executeTrade simulates and loss-guards first — the safety is
      // internal, not a switch the user has to remember.
      const r = await window.krypt.live.testTrade(token.mint, amountSol, !isLive);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onTraded();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doSell = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.live.sellToken(token.mint, sellPct);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onTraded();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
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

      {side === 'sell' && sellPct < 100 && (
        <p className="text-label text-krypt-muted/70 leading-relaxed">
          A partial sell is built locally like any other, but it keeps the token account open. A 100% sell closes it
          in the same transaction and reclaims the ~0.002 SOL of rent sitting in it.
        </p>
      )}

      {side === 'buy' ? (
        <>
          <div className="grid grid-cols-5 gap-1">
            {BUY_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setAmountSol(p)}
                className={cls(
                  'rounded-md border py-1.5 text-body font-mono font-semibold transition',
                  amountSol === p
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
              step={0.01}
              value={amountSol}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setAmountSol(n);
              }}
              className="flex-1 bg-transparent px-3 py-2.5 text-sm font-mono text-white outline-none"
            />
            <span className="px-3 text-body uppercase text-krypt-muted">SOL</span>
          </div>
          <div className="text-body text-krypt-muted text-right -mt-1">
            {cost.usd !== null ? `≈ ${fmtUsd(cost.usd)}` : 'SOL price unavailable'}
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

      {/* One line, not a ledger. The itemised breakdown moved out of the
          panel — it is on the Execution page, in Settings and in the guides —
          but the TOTAL and our own fee stay here, because this is where the
          money is committed and a cost you only learn about elsewhere is a
          cost you were not told. Hover for the parts. */}
      {side === 'buy' && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
          <span
            className="text-body text-krypt-muted"
            title={[
              `pump.fun protocol ${PROTOCOL_FEE_PCT}%: ${toUsd(cost.protocol)}`,
              cost.relayer > 0 ? `Relayer ${RELAYER_FEE_PCT}%: ${toUsd(cost.relayer)}` : null,
              waiver.waived
                ? `Krypt ${(FEE_BPS / 100).toFixed(2).replace(/\.?0+$/, '')}% per side: WAIVED — you hold ${waiver.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${KRYPTO_TOKEN.symbol}`
                : `Krypt ${(FEE_BPS / 100).toFixed(2).replace(/\.?0+$/, '')}% per side: ${toUsd(cost.krypt)}`,
              `Priority fee (est.): ${toUsd(cost.priority)}`,
              cost.tips > 0 ? `Landing tips (est.): ${toUsd(cost.tips)}` : null,
              `Network: ${toUsd(cost.network)}`,
              `Token account rent (refundable): ${toUsd(cost.rent)}`,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            Est. fees <span className="font-mono text-white/80">{toUsd(cost.total)}</span>
            {waiver.waived ? (
              <span className="text-emerald-300/80"> · Krypt fee waived (${KRYPTO_TOKEN.symbol} holder)</span>
            ) : (
              <>
                <span className="text-krypt-muted/60"> · incl. Krypt {(FEE_BPS / 100).toFixed(2).replace(/\.?0+$/, '')}% per side</span>
                {/* The way out of that line, where the line is. Someone told
                    the fee is charged should be told what removes it in the
                    same breath, not on another page. */}
                <span className="text-krypt-muted/45">
                  {' '}· hold {KRYPTO_FEE_WAIVER_TOKENS.toLocaleString()} ${KRYPTO_TOKEN.symbol} to waive it
                </span>
              </>
            )}
          </span>
          <span className="text-label text-krypt-muted/50">
            slippage capped at {settings.execution.liveSlippagePct}%
          </span>
          <span className="text-label">
            {(settings.execution.mevMode ?? 'fast') === 'private' ? (
              <span className="text-emerald-300/80">· private buy (bundle lane only)</span>
            ) : (
              <span className="text-krypt-muted/50">
                · {(settings.execution.mevMode ?? 'fast') === 'off' ? 'public lane' : 'public lanes, tipped'}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Action */}
      <button
        onClick={side === 'buy' ? doBuy : doSell}
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
        {side === 'buy' ? `${isLive ? 'Buy' : 'Paper buy'} ${amountSol} SOL` : `${isLive ? 'Sell' : 'Paper sell'} ${sellPct}%`}
      </button>

      {blocked && (
        <p className="text-body text-arc-gold/80 leading-relaxed flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
          {blocked}
        </p>
      )}

      <div className="flex items-center justify-between text-label text-krypt-muted/60 pt-1 border-t border-white/5">
        <span>{wallet?.publicKey ? shortAddr(wallet.publicKey, 4) : 'no wallet'}</span>
        <span>{wallet?.balanceSol !== null && wallet?.balanceSol !== undefined ? `${wallet.balanceSol.toFixed(4)} SOL` : '—'}</span>
      </div>
    </div>
  );
}
