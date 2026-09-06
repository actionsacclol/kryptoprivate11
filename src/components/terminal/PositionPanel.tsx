import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { Position } from '@shared/portfolio';
import { cls, fmtNum, fmtSol, fmtUsd } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

// Your position in THIS token, on the token page (2026-08-29).
//
// After a buy the first question is "what is it worth now, and how do I get
// out" — and until now the answer lived on the Portfolio page. This panel
// puts the chain-reconciled position (shared/portfolio.ts) next to the
// chart: tokens held, value, entry vs now, unrealized PnL, and one-click
// sells. It renders nothing when the wallet holds none of the token, so a
// page you are only researching stays uncluttered.
//
// Honest nulls: what you HOLD comes from the chain and is always known; what
// you PAID comes from this install's ledger and can be unknown (bought
// elsewhere, fill still reconciling). Every derived number goes to an em
// dash rather than a made-up zero when the basis is missing.

const SELL_PCTS = [25, 50, 100] as const;

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-krypt-muted/80">{label}</span>
      <span className={cls('font-mono tabular-nums', tone ?? 'text-white/90')}>{value}</span>
    </div>
  );
}

export function PositionPanel({
  mint,
  solUsd,
  isLive,
  refreshKey,
  onTraded,
}: {
  mint: string;
  solUsd: number | null;
  /** Live mode: the real position, real sells. Paper mode: the paper
   *  position (opened by a simulated fill) and paper sells. */
  isLive: boolean;
  /** Bump to force a reload (after a trade, or a fill event). */
  refreshKey: number;
  onTraded: () => void;
}) {
  const toast = useToast();
  const [realPos, setRealPos] = useState<Position | null>(null);
  const [paperPos, setPaperPos] = useState<Position | null>(null);
  const [paperModel, setPaperModel] = useState('');
  const [pending, setPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await window.krypt.portfolio.summary();
      if (r.ok && r.data) {
        setRealPos(r.data.positions.find((p) => p.mint === mint) ?? null);
        setPaperPos(r.data.paper.positions.find((p) => p.mint === mint) ?? null);
        setPaperModel(r.data.paper.model);
        setPending(r.data.pendingFills);
      }
    } finally {
      setLoaded(true);
    }
  }, [mint]);

  useEffect(() => {
    void load();
    // A position is priced by the same providers as the chart; 20s keeps the
    // value honest without doubling the Portfolio page's traffic.
    const id = setInterval(() => void load(), 20_000);
    // A fill on this mint re-reads at once — landed (tokens are in the
    // wallet) and again reconciled (cost basis is known) — so the panel
    // never sits up to 20 s behind the toast that said the trade landed.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'fill' && ev.mint === mint && ev.state !== 'failed') void load();
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [load, refreshKey, mint]);

  const sell = async (pct: number): Promise<void> => {
    setBusy(pct);
    try {
      const r = await window.krypt.live.sellToken(mint, pct);
      r.ok ? toast.success(r.message) : toast.error(r.message);
      onTraded();
      void load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) return null;
  // Which position this panel is about:
  //   Live  → the real one (a paper one on the same mint gets a note);
  //   Paper → the paper one; failing that the real one, read-only, so a
  //           researcher still sees what the wallet holds.
  const pos = isLive ? realPos : (paperPos ?? realPos);
  if (!pos || pos.amount <= 0) return null;
  const isPaper = pos.paper === true;
  // Sell buttons act on the position shown, in the mode shown: real sells
  // in Live, paper sells in Paper. A real position shown in Paper mode is
  // read-only — the engine would route the click to the paper book.
  const canSell = isLive ? !isPaper : isPaper;

  const pnl = pos.unrealizedPnlSol;
  const pct = pos.unrealizedPnlPct;
  const tone = pnl === null ? 'text-krypt-muted' : pnl >= 0 ? 'text-emerald-300' : 'text-rose-300';
  const usd = (sol: number | null): string =>
    sol === null || solUsd === null ? '' : ` (${fmtUsd(sol * solUsd)})`;

  return (
    <div className="plate rounded-lg p-3 mt-4 space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-[0.28em] text-arc-gold/90">
          Your position
        </h3>
        {isPaper && (
          <span
            title={`Simulated fill — never held on chain. Exit: ${paperModel}`}
            className="rounded border border-amber-400/50 bg-amber-500/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.18em] text-amber-300"
          >
            Paper
          </span>
        )}
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        <button
          onClick={() => void load()}
          title="Refresh"
          className="text-krypt-muted/60 hover:text-white transition"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* The headline: what it is worth right now, and how that compares. */}
      <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-krypt-muted/70 flex items-center gap-1.5">
            Value
            {pos.valueSource === 'quote' && (
              <span
                title="What selling the whole position would fetch right now — a live sell quote, price impact included"
                className="rounded border border-emerald-400/30 px-1 py-px text-[8px] tracking-[0.12em] text-emerald-300/80 normal-case"
              >
                sell quote
              </span>
            )}
            {pos.valueSource === 'spot' && (
              <span
                title="No sell route quoted — this is the provider's spot price × your amount, which can be far off for a thin token"
                className="rounded border border-amber-400/30 px-1 py-px text-[8px] tracking-[0.12em] text-amber-300/80 normal-case"
              >
                spot × amount
              </span>
            )}
          </span>
          <span className="font-mono text-base text-white tabular-nums">
            {pos.valueSol === null ? '—' : `${fmtSol(pos.valueSol)} SOL`}
            <span className="text-[11px] text-krypt-muted/70">{usd(pos.valueSol)}</span>
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 mt-1">
          <span className="text-[10px] uppercase tracking-[0.2em] text-krypt-muted/70">Unrealized</span>
          <span className={cls('font-mono text-sm tabular-nums', tone)}>
            {pnl === null
              ? '—'
              : `${pnl >= 0 ? '+' : ''}${fmtSol(pnl)} SOL${pct === null ? '' : ` · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}`}
          </span>
        </div>
      </div>

      <div className="space-y-1">
        <Row label="Holding" value={`${fmtNum(pos.amount, pos.amount < 1000 ? 2 : 0)} ${pos.symbol || ''}`} />
        <Row label="Cost" value={pos.costSol === null ? '—' : `${fmtSol(pos.costSol)} SOL${usd(pos.costSol)}`} />
        <Row label="Entry MC" value={pos.entryMcapUsd === null ? '—' : fmtUsd(pos.entryMcapUsd)} />
        <Row label="Now MC" value={pos.marketCapUsd === null ? '—' : fmtUsd(pos.marketCapUsd)} />
        {pos.realizedPnlSol !== null && pos.realizedPnlSol !== 0 && (
          <Row
            label="Realized so far"
            value={`${pos.realizedPnlSol >= 0 ? '+' : ''}${fmtSol(pos.realizedPnlSol)} SOL`}
            tone={pos.realizedPnlSol >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'}
          />
        )}
      </div>

      {isPaper && (
        <p className="text-[10px] text-amber-300/70 leading-relaxed">
          Paper position: entry is the simulated fill&rsquo;s real cost and token count. Exit is modelled —{' '}
          {paperModel || 'paper fill at last price'}. Nothing was broadcast.
        </p>
      )}

      {isLive && paperPos && !isPaper && (
        <p className="text-[10px] text-amber-300/70 leading-relaxed">
          A paper position is also open in this token — switch to Paper to manage it.
        </p>
      )}

      {!isLive && !isPaper && (
        <p className="text-[10px] text-krypt-muted/60 leading-relaxed">
          Real holding — switch to Live to sell it. A Paper buy opens a separate paper position.
        </p>
      )}

      {!pos.basisKnown && (
        <p className="text-[10px] text-krypt-muted/60 leading-relaxed">
          {pending > 0 || pos.unreconciledFills > 0
            ? 'Cost basis is still being read from the chain — PnL appears once the fill is confirmed.'
            : 'Cost basis unknown: these tokens were not bought through this install, so PnL cannot be shown.'}
        </p>
      )}

      {canSell && (
        <div className="grid grid-cols-3 gap-1.5 pt-0.5">
          {SELL_PCTS.map((p) => (
            <button
              key={p}
              disabled={busy !== null}
              onClick={() => void sell(p)}
              className={cls(
                'rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-50',
                isPaper
                  ? p === 100
                    ? 'border-amber-400/60 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                    : 'border-amber-400/25 bg-amber-500/10 text-amber-100/90 hover:bg-amber-500/20'
                  : p === 100
                    ? 'border-rose-500/60 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30'
                    : 'border-white/10 bg-white/5 text-white/90 hover:bg-white/10',
              )}
            >
              {busy === p ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> : `${isPaper ? 'Paper sell' : 'Sell'} ${p}%`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
