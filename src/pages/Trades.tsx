// Trades — every round trip you have actually made, in and out (2026-09-03).
//
// The Portfolio page answers "what am I holding and how am I doing overall".
// This one answers a different question: what did each trade DO. One row per
// mint you bought and fully sold, with what went in, what came out, how long
// it was held, and a card you can share.
//
// Everything here is read back from the chain: the cost is the lamports that
// actually left the wallet, the proceeds are what actually arrived. Nothing
// on this page is a mark or an estimate, which is why it is the page a share
// card is worth making from. Open positions get their own section, clearly
// separated and clearly labelled unrealized, because an open trade is not a
// result yet.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Clapperboard, RefreshCw, Share2, Wand2 } from 'lucide-react';
import type { Candle } from '@shared/market';
import type { ClosedTrade, PortfolioSummary, Position } from '@shared/portfolio';
import { Card, Empty, GhostButton, IconButton, Page, Section } from '../components/common';
import { PnlCard, type CardSubject } from '../components/terminal/PnlCard';
import { TradeReplay } from '../components/terminal/TradeReplay';
import { SimulateTrade } from '../components/terminal/SimulateTrade';
import { cls, fmtUsd, shortAddr } from '../utils/format';
import { useToast } from '../state/ToastProvider';
import { ageLabel, cachedPortfolio, rememberPortfolio } from '../state/routeCache';

function holdLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function when(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A SOL price per token, which for a memecoin is a very small number. */
function price(p: number | null): string {
  if (p === null || !Number.isFinite(p) || p <= 0) return '—';
  if (p >= 0.001) return p.toFixed(6);
  return p.toExponential(2);
}

function ClosedRow({
  t,
  paper,
  solUsd,
  onOpen,
  onShare,
  onReplay,
}: {
  t: ClosedTrade;
  /** A paper round trip: the fills were modelled, never broadcast. */
  paper: boolean;
  solUsd: number | null;
  onOpen: () => void;
  onShare: () => void;
  onReplay: () => void;
}) {
  const up = t.pnlSol >= 0;
  return (
    <div className="group flex items-center gap-4 border-b border-white/5 px-5 py-3 last:border-b-0 transition hover:bg-white/[0.03]">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold text-white">{t.symbol || shortAddr(t.mint)}</span>
          {paper && (
            <span className="rounded border border-amber-400/50 bg-amber-500/15 px-1 py-px text-[8px] font-bold uppercase tracking-[0.18em] text-amber-300">
              Paper
            </span>
          )}
          <span className="whitespace-nowrap font-mono text-[10px] text-krypt-muted/60">
            {when(t.closedAt)} · held {holdLabel(t.holdMs)} · {t.buys} buy{t.buys === 1 ? '' : 's'} / {t.sells} sell
            {t.sells === 1 ? '' : 's'}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
          <span className="text-krypt-muted">
            in <span className="text-white/85">{t.costSol.toFixed(4)} SOL</span>
            {t.entryPriceSol !== null && <span className="text-krypt-muted/60"> @ {price(t.entryPriceSol)}</span>}
          </span>
          <span className="text-krypt-muted">
            out <span className="text-white/85">{t.proceedsSol.toFixed(4)} SOL</span>
            {t.exitPriceSol !== null && <span className="text-krypt-muted/60"> @ {price(t.exitPriceSol)}</span>}
          </span>
        </div>
      </button>

      <div className="flex flex-shrink-0 flex-col items-end">
        <span className={cls('font-mono text-[15px] font-semibold', up ? 'text-emerald-300' : 'text-rose-300')}>
          {up ? '+' : ''}
          {t.pnlSol.toFixed(4)} SOL
        </span>
        <span className={cls('font-mono text-[11px]', up ? 'text-emerald-300/70' : 'text-rose-300/70')}>
          {up ? '+' : ''}
          {t.pnlPct.toFixed(1)} %{solUsd !== null ? ` · ${up ? '+' : '-'}${fmtUsd(Math.abs(t.pnlSol) * solUsd)}` : ''}
        </span>
      </div>

      <IconButton onClick={onReplay} title="Watch this trade play back, and save it as a video">
        <Clapperboard className="h-4 w-4" />
      </IconButton>
      <IconButton onClick={onShare} title="Make a share card for this trade">
        <Share2 className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

function OpenRow({ p, onOpen, onShare }: { p: Position; onOpen: () => void; onShare: () => void }) {
  const pnl = p.unrealizedPnlSol;
  const up = (pnl ?? 0) >= 0;
  return (
    <div className="flex items-center gap-4 border-b border-white/5 px-5 py-3 last:border-b-0 transition hover:bg-white/[0.03]">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold text-white">{p.symbol || shortAddr(p.mint)}</span>
          <span className="font-mono text-[10px] text-krypt-muted/60">still held</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[11px] text-krypt-muted">
          <span>
            in <span className="text-white/85">{p.costSol !== null ? `${p.costSol.toFixed(4)} SOL` : '—'}</span>
          </span>
          <span>
            worth <span className="text-white/85">{p.valueSol !== null ? `${p.valueSol.toFixed(4)} SOL` : '—'}</span>
            {p.valueSource === 'spot' && <span className="text-arc-gold/70"> (spot)</span>}
          </span>
        </div>
      </button>
      <div className="flex flex-shrink-0 flex-col items-end">
        <span className={cls('font-mono text-[15px] font-semibold', pnl === null ? 'text-krypt-muted' : up ? 'text-emerald-300' : 'text-rose-300')}>
          {pnl === null ? '—' : `${up ? '+' : ''}${pnl.toFixed(4)} SOL`}
        </span>
        <span className="font-mono text-[11px] text-krypt-muted/70">unrealized</span>
      </div>
      <IconButton onClick={onShare} title="Make a share card (marked as an open position)">
        <Share2 className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

export function TradesPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  // Open on the last portfolio this session saw (routeCache); the engine's
  // kept build and then the fresh one follow. Loading only when there is
  // nothing at all to show (2026-09-08: 4–10 s of empty page per visit).
  const [data, setData] = useState<PortfolioSummary | null>(() => cachedPortfolio());
  const [loading, setLoading] = useState(() => cachedPortfolio() === null);
  const [share, setShare] = useState<CardSubject | null>(null);
  const [replay, setReplay] = useState<ClosedTrade | null>(null);
  /** Candles for a simulated replay; a real one fetches its own. */
  const [replayCandles, setReplayCandles] = useState<Candle[] | undefined>(undefined);
  const [simOpen, setSimOpen] = useState(false);
  const [showOpen, setShowOpen] = useState(true);

  const load = useCallback(
    async (opts: { stale?: boolean } = { stale: true }) => {
      if (!cachedPortfolio()) setLoading(true);
      try {
        const r = await window.krypt.portfolio.summary(opts);
        if (r.ok && r.data) {
          setData(r.data);
          rememberPortfolio(r.data);
        } else toast.error(r.message || 'Could not read the portfolio');
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
    // A fill, real or paper, lands here at once — the page used to load
    // once on mount, so a paper round trip done a moment earlier was missing
    // until the user left and came back (2026-09-06).
    const off = window.krypt.engine.onEvent((ev) => {
      // Any rebuild, whoever asked for it, lands here at once.
      if (ev.kind === 'portfolio') {
        setData(ev.summary);
        rememberPortfolio(ev.summary);
      }
      // A fill awaits the REAL rebuild, so a closed position is never shown open.
      if (ev.kind === 'fill' || ev.kind === 'paper') void load({ stale: false });
    });
    return off;
  }, [load]);

  const closed = data?.closed ?? [];
  const paperClosed = data?.paper.closed ?? [];
  const open = data?.positions ?? [];
  // One list, newest first, paper rows marked. The separate Paper book page
  // went on 2026-09-06: a paper round trip is a trade you made, and it
  // belongs beside the real ones — labelled, and kept out of the totals.
  const rows = useMemo(
    () =>
      [...closed.map((t) => ({ t, paper: false })), ...paperClosed.map((t) => ({ t, paper: true }))].sort(
        (a, b) => b.t.closedAt - a.t.closedAt,
      ),
    [closed, paperClosed],
  );
  const totals = useMemo(() => {
    const realised = closed.reduce((a, c) => a + c.pnlSol, 0);
    const wins = closed.filter((c) => c.pnlSol > 0).length;
    const paperPnl = paperClosed.reduce((a, c) => a + c.pnlSol, 0);
    return { realised, wins, count: closed.length, paperCount: paperClosed.length, paperPnl };
  }, [closed, paperClosed]);

  return (
    <Page
      title="Trades"
      subtitle={
        totals.count || totals.paperCount
          ? [
              totals.count
                ? `${totals.count} closed round trip${totals.count === 1 ? '' : 's'} · ${totals.wins} up, ${totals.count - totals.wins} down · ${totals.realised >= 0 ? '+' : ''}${totals.realised.toFixed(4)} SOL realised`
                : 'No real round trips yet',
              totals.paperCount ? `${totals.paperCount} paper (${totals.paperPnl >= 0 ? '+' : ''}${totals.paperPnl.toFixed(4)} SOL, not counted)` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Every round trip you complete lands here, paper or real'
      }
      actions={
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => setSimOpen(true)}>
            <Wand2 className="h-3.5 w-3.5" />
            Simulate
          </GhostButton>
          <IconButton onClick={() => void load()} title="Re-read positions and fills" disabled={loading}>
            <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
          </IconButton>
        </div>
      }
    >
      <Section
        title={`Closed (${rows.length})${data?.stale ? ` · updating${ageLabel(data.generatedAt) ? `, ${ageLabel(data.generatedAt)}` : '…'}` : ''}`}
        description="What actually left the wallet and what actually came back, read from the chain. Rows marked paper were modelled fills that never touched the chain and count toward nothing. Make a card from one, or replay it: the candles arrive as they happened, the PnL moves with them, and it ends on the realised number."
      >
        {rows.length === 0 ? (
          <Empty
            title={loading ? 'Reading your fills…' : 'No completed trades yet'}
            message="A trade appears here once you have sold everything you bought of a token, in Paper or Live. Buy and sell from the token page and it lands here by itself. Simulate builds a made-up one if you just want to see how the replay and the card look."
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            {rows.map(({ t, paper }) => (
              <ClosedRow
                key={`${paper ? 'paper-' : ''}${t.mint}-${t.closedAt}`}
                t={t}
                paper={paper}
                solUsd={data?.solUsd ?? null}
                onOpen={() => onOpenToken(t.mint)}
                onShare={() => setShare({ kind: 'trade', trade: t })}
                onReplay={() => {
                  setReplayCandles(undefined);
                  setReplay(t);
                }}
              />
            ))}
          </Card>
        )}
      </Section>

      <Section
        title={`Still open (${open.length})`}
        description="Not results yet. Shown so the page is the whole picture, and any card made from one is marked unrealized."
        actions={
          <GhostButton onClick={() => setShowOpen((v) => !v)}>
            {showOpen ? (
              <>
                <ArrowUpRight className="h-3.5 w-3.5" /> Hide
              </>
            ) : (
              <>
                <ArrowDownRight className="h-3.5 w-3.5" /> Show
              </>
            )}
          </GhostButton>
        }
      >
        {!showOpen ? null : open.length === 0 ? (
          <Empty title="Nothing open" message="The wallet holds no tokens this app can price." />
        ) : (
          <Card padded={false} className="overflow-hidden">
            {open.map((p) => (
              <OpenRow
                key={p.mint}
                p={p}
                onOpen={() => onOpenToken(p.mint)}
                onShare={() => setShare({ kind: 'position', position: p })}
              />
            ))}
          </Card>
        )}
      </Section>

      {share && <PnlCard subject={share} solUsd={data?.solUsd ?? null} onClose={() => setShare(null)} />}
      {replay && <TradeReplay trade={replay} candles={replayCandles} onClose={() => setReplay(null)} />}
      {simOpen && (
        <SimulateTrade
          onClose={() => setSimOpen(false)}
          onReplay={(t, c) => {
            setReplayCandles(c);
            setReplay(t);
            setSimOpen(false);
          }}
          onCard={(t) => {
            setShare({ kind: 'trade', trade: t });
            setSimOpen(false);
          }}
        />
      )}
    </Page>
  );
}
