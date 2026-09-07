import { useCallback, useEffect, useState } from 'react';
import { Download, Image as ImageIcon, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { DEMO_SCENARIOS, demoPosition } from '@shared/portfolio';
import type { PortfolioSummary, Position, TradeHistoryRow } from '@shared/portfolio';
import { imageSrc } from '@shared/market';
import { Card, Empty, GhostButton, Page, Section } from '../components/common';
import { AreaChart } from '../components/viz/AreaChart';
import { PnlCard, type CardSubject } from '../components/terminal/PnlCard';
import { useToast } from '../state/ToastProvider';
import { cls, fmtDur, fmtNum, fmtPriceUsd, fmtUsd, shortAddr, toneFor } from '../utils/format';

// Portfolio, trade history and PnL cards (term.txt §13, §14, §15).
//
// Every figure here is joined from three sources that routinely disagree —
// the chain, this install's fill ledger, and the market layer. Where the
// join fails the number is null and the page says so, rather than showing a
// confident zero. The warnings strip at the top is not decoration: it is the
// difference between "you are up 2 SOL" and "you are up 2 SOL on the fills
// we could read".

type Tab = 'positions' | 'history';

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="plate rounded-lg px-4 py-3" title={hint}>
      <div className="text-[9px] uppercase tracking-[0.18em] text-krypt-muted/70">{label}</div>
      <div className={cls('text-lg font-mono font-semibold mt-1', tone ?? 'text-white')}>{value}</div>
    </div>
  );
}

const sol = (v: number | null | undefined, digits = 4): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '' : ''}${v.toFixed(digits)}`;

function PositionRow({
  p,
  onOpen,
  onShare,
}: {
  p: Position;
  onOpen: () => void;
  onShare: () => void;
}) {
  return (
    <div className="plate rounded-lg px-3 py-2.5 hover:!border-white/20 transition">
      <div className="flex items-center gap-3">
        <button onClick={onOpen} className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
          <div className="h-8 w-8 rounded-md overflow-hidden border border-white/10 bg-black/40 flex-shrink-0">
            {imageSrc(p.imageUrl) && (
              <img src={imageSrc(p.imageUrl) as string} alt="" className="h-full w-full object-cover" />
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-white truncate flex items-center gap-1.5">
              {p.symbol}
              {p.paper && (
                <span className="rounded border border-amber-400/50 bg-amber-500/15 px-1 py-px text-[8px] font-bold uppercase tracking-[0.18em] text-amber-300">
                  Paper
                </span>
              )}
            </div>
            <div className="text-[10px] font-mono text-krypt-muted">{shortAddr(p.mint, 4)}</div>
          </div>
        </button>

        <div className="hidden md:block w-24 text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted/60">Holding</div>
          <div className="text-[11px] font-mono text-white/85">{fmtNum(p.amount, 0)}</div>
        </div>
        <div className="w-20 text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted/60">Price</div>
          <div className="text-[11px] font-mono text-white/85">{fmtPriceUsd(p.priceUsd)}</div>
        </div>
        <div className="w-24 text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted/60">Value</div>
          <div className="text-[12px] font-mono text-white">{fmtUsd(p.valueUsd)}</div>
        </div>
        <div className="w-24 text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted/60">Cost</div>
          <div className="text-[11px] font-mono text-white/85">
            {p.costSol === null ? '—' : `${sol(p.costSol)} SOL`}
          </div>
        </div>
        <div className="w-28 text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted/60">Unrealized</div>
          <div className={cls('text-[12px] font-mono font-semibold', toneFor(p.unrealizedPnlSol))}>
            {p.unrealizedPnlSol === null
              ? '—'
              : `${p.unrealizedPnlSol >= 0 ? '+' : ''}${sol(p.unrealizedPnlSol)}`}
            {p.unrealizedPnlPct !== null && (
              <span className="text-[10px] ml-1 opacity-80">
                ({p.unrealizedPnlPct >= 0 ? '+' : ''}
                {p.unrealizedPnlPct.toFixed(0)}%)
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onShare}
          disabled={p.unrealizedPnlPct === null}
          title={p.unrealizedPnlPct === null ? 'Needs a cost basis to make a card' : 'Make a PnL card'}
          className={cls(
            'h-8 w-8 rounded-lg border flex items-center justify-center transition flex-shrink-0',
            p.unrealizedPnlPct === null
              ? 'border-white/8 text-krypt-muted/30 cursor-not-allowed'
              : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white hover:border-krypt-purple/40',
          )}
        >
          <ImageIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {!p.basisKnown && (
        <p className="text-[10px] text-krypt-muted/60 mt-1.5 pl-11">
          No cost basis in this install — {p.unreconciledFills > 0
            ? `${p.unreconciledFills} fill(s) could not be read from the chain.`
            : 'these tokens were not bought through Krypt.'}{' '}
          PnL is unknown, not zero.
        </p>
      )}
    </div>
  );
}

export function PortfolioPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const [data, setData] = useState<PortfolioSummary | null>(null);
  const [history, setHistory] = useState<TradeHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('positions');
  // Paper fills share the list, labelled; this keeps them apart on demand.
  const [histFilter, setHistFilter] = useState<'all' | 'live' | 'paper'>('all');
  const shownHistory = history.filter((r) => (histFilter === 'all' ? true : histFilter === 'paper' ? r.paper === true : !r.paper));
  const [share, setShare] = useState<CardSubject | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, h] = await Promise.all([window.krypt.portfolio.summary(), window.krypt.portfolio.history()]);
    if (p.ok && p.data) setData(p.data);
    else if (!p.ok) toast.error(p.message);
    if (h.ok && h.data) setHistory(h.data);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    // A fill — real or paper — shows up at once rather than on the next
    // 30 s tick: a paper round trip done seconds before opening this page
    // used to be missing from the Trades tab until the poll came round.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'fill' || ev.kind === 'paper') void load();
    });
    return () => {
      clearInterval(id);
      off();
    };
    // `load` is stable enough; re-running on every toast identity change
    // would restart the interval constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportAs = async (fmt: 'csv' | 'json'): Promise<void> => {
    const r = await window.krypt.portfolio.export(fmt);
    if (r.ok) toast.success(r.message);
    else toast.error(r.message);
  };

  return (
    <Page
      title="Portfolio"
      subtitle="What you hold, what you paid, and what it is worth — joined from the chain, this app's fill ledger and live prices."
      actions={
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => void exportAs('csv')} className="!py-2 !px-3 text-xs">
            <Download className="h-3.5 w-3.5" />
            CSV
          </GhostButton>
          <GhostButton onClick={() => void exportAs('json')} className="!py-2 !px-3 text-xs">
            <Download className="h-3.5 w-3.5" />
            JSON
          </GhostButton>
          <button
            onClick={() => void load()}
            className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
            title="Refresh"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      }
    >
      {data && data.warnings.length > 0 && (
        <div className="mb-5 rounded-lg border border-arc-gold/30 bg-arc-gold/10 px-4 py-3">
          <div className="flex items-center gap-2 text-arc-gold text-[12px] font-semibold mb-1">
            <TriangleAlert className="h-4 w-4" />
            What these numbers do not cover
          </div>
          <ul className="text-[11px] text-arc-gold/85 space-y-0.5 leading-relaxed">
            {data.warnings.map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Headline */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-6">
        <Stat label="Total value" value={fmtUsd(data?.totalValueUsd)} hint="Positions plus SOL balance, priced now" />
        <Stat
          label="Unrealized"
          value={data?.unrealizedPnlSol === null || data?.unrealizedPnlSol === undefined ? '—' : `${data.unrealizedPnlSol >= 0 ? '+' : ''}${sol(data.unrealizedPnlSol)} SOL`}
          tone={toneFor(data?.unrealizedPnlSol)}
        />
        <Stat
          label="Realized"
          value={data?.realizedPnlSol === null || data?.realizedPnlSol === undefined ? '—' : `${data.realizedPnlSol >= 0 ? '+' : ''}${sol(data.realizedPnlSol)} SOL`}
          tone={toneFor(data?.realizedPnlSol)}
        />
        <Stat
          label="Win rate"
          value={data?.winRatePct === null || data?.winRatePct === undefined ? '—' : `${data.winRatePct.toFixed(0)}%`}
          hint={data ? `${data.wins}W / ${data.losses}L` : undefined}
        />
        <Stat
          label="Profit factor"
          value={data?.profitFactor === null || data?.profitFactor === undefined ? '—' : data.profitFactor.toFixed(2)}
          hint="Gross profit divided by gross loss"
        />
        <Stat label="Fees paid" value={data?.feesPaidSol === null || data?.feesPaidSol === undefined ? '—' : `${sol(data.feesPaidSol)} SOL`} />
      </div>

      {/* Equity curve */}
      {data && data.equity.length > 1 && (
        <Section title="Realized PnL" description="Cumulative, in SOL, across closed round trips this install recorded.">
          <Card padded={false} className="p-3">
            <AreaChart data={data.equity} height={140} valueSuffix=" SOL" />
          </Card>
        </Section>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-3 border-b border-white/8 pb-2">
        {([
          ['positions', `Positions (${data?.positions.length ?? 0})`],
          ['history', `Trade history (${history.length})`],
        ] as Array<[Tab, string]>).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cls(
              'rounded-md px-3 py-1.5 text-[12px] font-semibold transition',
              tab === id ? 'bg-white/8 text-white' : 'text-krypt-muted hover:text-white hover:bg-white/5',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Share-card preview.
          The card is the one thing here that gets screenshotted and posted, so
          it has to survive a four-digit gain, a minus sign, a missing icon and
          an overlong symbol. Holding such a position first is a bad way to
          find that out — these are obviously-fake positions for checking it. */}
      {tab === 'positions' && (
        <div className="mb-3">
          <button
            onClick={() => setPreviewOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold text-krypt-muted hover:text-white hover:border-white/25 transition"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Preview share card
          </button>
          {previewOpen && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DEMO_SCENARIOS.map((sc) => (
                <button
                  key={sc.id}
                  title={sc.note}
                  onClick={() => setShare({ kind: 'position', position: demoPosition(sc.id) })}
                  className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[10px] font-mono text-krypt-muted hover:text-white hover:border-krypt-purple/40 transition"
                >
                  {sc.label}
                </button>
              ))}
              <span className="self-center text-[10px] text-krypt-muted/50">
                demo data — the mint is deliberately fake
              </span>
            </div>
          )}
        </div>
      )}

      {/* One list. Open paper positions sit with the real ones, carrying the
          Paper chip (PositionRow), and count toward none of the totals above;
          their fills are on the Trades tab like every other fill. The separate
          paper section went on 2026-09-06 — two lists for one wallet read as
          two products. */}
      {tab === 'positions' &&
        (data && data.positions.length + data.paper.positions.length > 0 ? (
          <div className="space-y-2">
            {data.positions.map((p) => (
              <PositionRow key={p.mint} p={p} onOpen={() => onOpenToken(p.mint)} onShare={() => setShare({ kind: 'position', position: p })} />
            ))}
            {data.paper.positions.map((p) => (
              <PositionRow key={`paper-${p.mint}`} p={p} onOpen={() => onOpenToken(p.mint)} onShare={() => setShare({ kind: 'position', position: p })} />
            ))}
            {data.paper.positions.length > 0 && (
              <p className="text-[10px] text-krypt-muted/55 px-3 pt-1 leading-relaxed">
                Rows marked <span className="text-amber-300/80">paper</span> are simulated fills, never broadcast; exits are
                modelled ({data.paper.model}) and they count toward none of the totals above.
              </p>
            )}
          </div>
        ) : (
          <Empty
            title="No open positions"
            message="Tokens bought through Krypt appear here with their real cost basis, read back from the chain. Paper positions appear here too, marked."
          />
        ))}

      {tab === 'history' &&
        (history.length > 0 ? (
          <div className="space-y-1">
            {/* Paper fills sit in the same list, labelled; the filter keeps
                them apart when the real record is what matters. */}
            {history.some((r) => r.paper) && (
              <div className="flex items-center gap-1 px-3 pb-1">
                {(['all', 'live', 'paper'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setHistFilter(f)}
                    className={cls(
                      'rounded px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] transition',
                      histFilter === f ? 'bg-white/10 text-white' : 'text-krypt-muted/60 hover:text-white',
                    )}
                  >
                    {f}
                  </button>
                ))}
                <span className="ml-2 text-[10px] text-krypt-muted/50">
                  {history.filter((r) => r.paper).length} paper · {history.filter((r) => !r.paper).length} live
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 px-3 text-[10px] uppercase tracking-[0.14em] text-krypt-muted/60">
              <span className="w-32">Time</span>
              <span className="w-16">Side</span>
              <span className="flex-1">Token</span>
              <span className="w-20 text-right">Asked</span>
              <span className="w-24 text-right">SOL moved</span>
              <span className="w-20 text-right">Fee</span>
              <span className="w-24 text-right">State</span>
            </div>
            {shownHistory.map((r, i) => (
              <div
                key={`${r.signature ?? i}-${i}`}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[11px] font-mono hover:bg-white/[0.04] transition"
              >
                <span className="w-32 text-krypt-muted/70">{new Date(r.at).toLocaleString()}</span>
                <span className={cls('w-16 font-bold', r.side === 'buy' ? 'text-emerald-400' : 'text-rose-400')}>
                  {r.side.toUpperCase()}
                </span>
                <button
                  onClick={() => onOpenToken(r.mint)}
                  className="flex-1 text-left text-white/85 hover:text-krypt-purple truncate flex items-center gap-1.5 min-w-0"
                >
                  <span className="truncate">{r.symbol || shortAddr(r.mint, 5)}</span>
                  {r.paper && (
                    <span className="shrink-0 rounded border border-amber-400/50 bg-amber-500/15 px-1 py-px text-[8px] font-bold uppercase tracking-[0.18em] text-amber-300">
                      Paper
                    </span>
                  )}
                </button>
                <span className="w-20 text-right text-krypt-muted">
                  {r.side === 'buy' ? `${r.requested} SOL` : `${r.requested}%`}
                </span>
                <span className={cls('w-24 text-right', toneFor(r.solDelta))}>
                  {r.solDelta === null ? '—' : `${r.solDelta >= 0 ? '+' : ''}${r.solDelta.toFixed(4)}`}
                </span>
                <span className="w-20 text-right text-krypt-muted">
                  {r.feeSol === null ? '—' : r.feeSol.toFixed(5)}
                </span>
                <span
                  className={cls(
                    'w-24 text-right text-[10px]',
                    r.paper
                      ? 'text-amber-300/80'
                      : r.state === 'reconciled' ? 'text-emerald-400/80' : r.state === 'pending' ? 'text-arc-gold/80' : 'text-rose-400/80',
                  )}
                  title={r.note ?? undefined}
                >
                  {r.paper ? 'paper' : r.state}
                </span>
              </div>
            ))}
            {shownHistory.length === 0 && (
              <p className="text-[11px] text-krypt-muted/60 px-3 py-4">No {histFilter} trades yet.</p>
            )}
            <p className="text-[10px] text-krypt-muted/55 px-3 pt-2 leading-relaxed">
              &ldquo;SOL moved&rdquo; is the actual change in your wallet balance for that transaction, read back from
              the chain — it includes the priority fee, any tip, the relayer&rsquo;s cut, rent and slippage. It is not
              the amount that was requested. Rows marked <span className="text-amber-300/80">paper</span> never touched
              the chain: their SOL is the fill model&rsquo;s, fees folded into the price, and they count toward none of
              the totals above.
            </p>
          </div>
        ) : (
          <Empty title="No trades yet" message="Real fills made through Krypt are recorded here and reconciled against the chain." />
        ))}

      {/* Closed round trips */}
      {data && data.closed.length > 0 && (
        <Section title={`Closed round trips (${data.closed.length})`}>
          <div className="space-y-1">
            {data.closed.slice(0, 25).map((c) => (
              <div
                key={`${c.mint}-${c.closedAt}`}
                className="flex items-center gap-3 rounded-md px-3 py-1.5 text-[11px] font-mono hover:bg-white/[0.04] transition"
              >
                <button onClick={() => onOpenToken(c.mint)} className="w-28 text-left text-white/85 hover:text-krypt-purple truncate">
                  {c.symbol}
                </button>
                <span className="text-krypt-muted w-24 text-right">{sol(c.costSol)} in</span>
                <span className="text-krypt-muted w-24 text-right">{sol(c.proceedsSol)} out</span>
                <span className={cls('w-24 text-right font-semibold', toneFor(c.pnlSol))}>
                  {c.pnlSol >= 0 ? '+' : ''}{sol(c.pnlSol)}
                </span>
                <span className={cls('w-20 text-right', toneFor(c.pnlSol))}>
                  {c.pnlPct >= 0 ? '+' : ''}{c.pnlPct.toFixed(0)}%
                </span>
                <span className="flex-1 text-right text-krypt-muted/60">{fmtDur(c.holdMs)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {share && <PnlCard subject={share} solUsd={data?.solUsd ?? null} onClose={() => setShare(null)} />}
    </Page>
  );
}
