import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { EVM_CHAIN_META, type EvmChainKind, type EvmPosition } from '@shared/evm';
import { cls, fmtUsd } from '../../utils/format';
import { fmtNative, fmtNativeSigned, fmtPriceNative, fmtTokens, isPendingResult, PENDING_TOAST } from '../../utils/evm';
import { useToast } from '../../state/ToastProvider';

// Your position in THIS token on one EVM chain — the EVM twin of
// PositionPanel. What you HOLD is read from the chain and always known;
// what you PAID comes from this install's ledger and can be unknown (bought
// elsewhere, fill still reconciling), in which case every derived number is
// an em dash rather than an invented zero.

const SELL_PCTS = [25, 50, 100] as const;

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-krypt-muted/80">{label}</span>
      <span className={cls('font-mono tabular-nums', tone ?? 'text-white/90')}>{value}</span>
    </div>
  );
}

export function EvmPositionPanel({
  chain,
  address,
  nativeUsd,
  armed,
  refreshKey,
  onTraded,
}: {
  chain: EvmChainKind;
  address: string;
  nativeUsd: number | null;
  armed: boolean;
  refreshKey: number;
  onTraded: () => void;
}) {
  const toast = useToast();
  const sym = EVM_CHAIN_META[chain].nativeSymbol;
  const [pos, setPos] = useState<EvmPosition | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await window.krypt.evm.portfolio(chain);
      if (r.ok && r.data) {
        setPos(r.data.positions.find((p) => p.token.toLowerCase() === address.toLowerCase()) ?? null);
      }
    } finally {
      setLoaded(true);
    }
  }, [chain, address]);

  useEffect(() => {
    setPos(null);
    setLoaded(false);
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 20_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'evmFill' && ev.fill.chain === chain && ev.fill.token.toLowerCase() === address.toLowerCase()) void load();
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [load, refreshKey, chain, address]);

  const sell = async (pct: number): Promise<void> => {
    setBusy(pct);
    try {
      const r = await window.krypt.evm.sell(chain, address, pct, !armed);
      if (r.ok) toast.success(r.message);
      else if (isPendingResult(r)) toast.warn(PENDING_TOAST);
      else toast.error(r.message);
      onTraded();
      void load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!loaded || !pos || pos.amount <= 0) return null;

  const pnl = pos.unrealizedPnlNative;
  const pct = pos.unrealizedPnlPct;
  const tone = pnl === null ? 'text-krypt-muted' : pnl >= 0 ? 'text-emerald-300' : 'text-rose-300';
  const usd = (v: number | null): string => (v === null || nativeUsd === null ? '' : ` (${fmtUsd(v * nativeUsd)})`);

  return (
    <div className="plate rounded-lg p-3 mt-4 space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-[0.28em] text-arc-gold/90">Your position</h3>
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        <button onClick={() => void load()} title="Refresh" className="text-krypt-muted/60 hover:text-white transition">
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-krypt-muted/70 flex items-center gap-1.5">
            Value
            {pos.valueSource === 'spot' && (
              <span
                title="Spot price × your amount — no sell quote was run for this figure; a thin curve can fetch less"
                className="rounded border border-amber-400/30 px-1 py-px text-[8px] tracking-[0.12em] text-amber-300/80 normal-case"
              >
                spot × amount
              </span>
            )}
          </span>
          <span className="font-mono text-base text-white tabular-nums">
            {fmtNative(pos.valueNative, sym)}
            <span className="text-[11px] text-krypt-muted/70">{usd(pos.valueNative)}</span>
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 mt-1">
          <span className="text-[10px] uppercase tracking-[0.2em] text-krypt-muted/70">Unrealized</span>
          <span className={cls('font-mono text-sm tabular-nums', tone)}>
            {pnl === null ? '—' : `${fmtNativeSigned(pnl, sym)}${pct === null ? '' : ` · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}`}
          </span>
        </div>
      </div>

      <div className="space-y-1">
        <Row label="Holding" value={`${fmtTokens(pos.amount)} ${pos.symbol || ''}`} />
        <Row label="Avg entry" value={fmtPriceNative(pos.avgEntryPriceNative, sym)} />
        <Row label="Now" value={fmtPriceNative(pos.priceNative, sym)} />
        <Row label="Cost" value={pos.costNative === null ? '—' : fmtNative(pos.costNative, sym)} />
        {pos.realizedPnlNative !== null && (
          <Row label="Realized so far" value={fmtNativeSigned(pos.realizedPnlNative, sym)} tone={pos.realizedPnlNative >= 0 ? 'text-emerald-300' : 'text-rose-300'} />
        )}
      </div>

      {!pos.basisKnown && (
        <p className="text-[10px] text-krypt-muted/60 leading-relaxed">
          No cost basis in this install —{' '}
          {pos.unreconciledFills > 0 ? `${pos.unreconciledFills} fill(s) could not be read from the chain yet.` : 'these tokens were not bought through Krypt.'}{' '}
          PnL is unknown, not zero.
        </p>
      )}

      <div className="grid grid-cols-3 gap-1">
        {SELL_PCTS.map((p) => (
          <button
            key={p}
            onClick={() => void sell(p)}
            disabled={busy !== null}
            className={cls(
              'rounded-md border py-1.5 text-[11px] font-semibold transition flex items-center justify-center gap-1',
              'border-rose-400/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25',
              busy !== null && 'opacity-60 cursor-wait',
            )}
          >
            {busy === p && <Loader2 className="h-3 w-3 animate-spin" />}
            {armed ? 'Sell' : 'Sim'} {p}%
          </button>
        ))}
      </div>
    </div>
  );
}
