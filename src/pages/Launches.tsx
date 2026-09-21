import { memo, useCallback, useState } from 'react';
import { Ban, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Card, Empty, Page, Section } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { Sparkline } from '../components/viz/Sparkline';
import type { LaunchRow } from '@shared/types';
import { cls, fmtAgo, fmtPrice, shortAddr } from '../utils/format';
import { useRunnerScores } from '../state/useRunnerScores';

const PHASE_TONE: Record<LaunchRow['phase'], 'neutral' | 'success' | 'warn' | 'danger' | 'gradient'> = {
  detected: 'neutral',
  evaluating: 'gradient',
  entered: 'success',
  flagged: 'gradient',
  rejected: 'danger',
  completed: 'warn',
  stale: 'neutral',
};

function LaunchDetails({ l }: { l: LaunchRow }) {
  const modal = useModal();
  const { blacklistCreator } = useAppState();

  const onBlacklist = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Blacklist creator',
      message: `Hard-reject every future launch from ${shortAddr(l.creator, 6)}?`,
      confirmLabel: 'Blacklist',
      destructive: true,
    });
    if (yes) void blacklistCreator(l.creator);
  };

  return (
    <div className="px-5 pb-4 pt-1 text-xs space-y-3 animate-fade-in">
      {l.reason && (
        <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-krypt-muted">
          {l.reason}
        </div>
      )}
      {l.score && (
        <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
          {(
            [
              ['Safety', l.score.safety, 20],
              ['Creator', l.score.creator, 18],
              ['Sells', l.score.sellPressure, 18],
              ['Timing', l.score.entryTiming, 12],
              ['Crowd', l.score.crowd, 8],
              ['Concen', l.score.concentration, 14],
              ['Meta', l.score.metadata, 10],
              ['Penalty', -l.score.penalties, 0],
            ] as Array<[string, number, number]>
          ).map(([label, v, max]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
              <div className="text-label uppercase tracking-wider text-krypt-muted">{label}</div>
              <div className={cls('font-mono font-semibold', v < 0 ? 'text-rose-300' : 'text-white')}>
                {v}{max > 0 && <span className="text-krypt-muted">/{max}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {l.riskFlags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {l.riskFlags.map((f) => (
            <Badge key={f.id} tone={f.hard ? 'danger' : 'warn'}>{f.label}</Badge>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between text-krypt-muted">
        <div className="space-x-4 font-mono">
          <span>mint {shortAddr(l.mint, 6)}</span>
          <span>
            creator {shortAddr(l.creator, 6)}
            {l.creatorPriorLaunches > 0 && ` · ${l.creatorPriorLaunches} prior`}
            {l.creatorPriorRugs > 0 && ` · ${l.creatorPriorRugs} dumps`}
          </span>
        </div>
        <button
          onClick={() => void onBlacklist()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 font-semibold text-rose-200 transition hover:bg-rose-500/20"
        >
          <Ban className="h-3 w-3" /> Blacklist creator
        </button>
      </div>
    </div>
  );
}

/**
 * One launch row. Memoised by VALUE, on the fields it draws (the TokenCard
 * pattern): the engine pushes `launchUpdate` up to 4×/s per token still in
 * its evaluation window, and each push hands the page a fresh row object —
 * so reference equality never hit and every one of up to 300 rows
 * reconciled on every push. The per-row framer-motion mount tween went with
 * it: a 0.25 s slide on a row replaced twenty times a second was invisible
 * and cost a motion component per row.
 */
const LaunchRowView = memo(
  function LaunchRowView({ l, expanded, onToggle }: { l: LaunchRow; expanded: boolean; onToggle: (mint: string) => void }) {
    return (
      <div className={cls(expanded && 'bg-white/[0.03]', l.phase === 'entered' && 'bg-krypt-purple/[0.06]')}>
        <button
          onClick={() => onToggle(l.mint)}
          className="w-full grid grid-cols-[24px_1.3fr_100px_0.6fr_0.85fr_0.6fr_0.7fr_0.7fr_0.6fr] items-center gap-2 px-5 py-2.5 text-left text-sm transition hover:bg-white/5"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-krypt-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-krypt-muted" />
          )}
          <span className="min-w-0 flex items-center gap-1.5">
            <span className="font-semibold text-white">{l.symbol || '—'}</span>
            {l.smartBuyerCount > 0 && (
              <span title="Smart-wallet buyer" className="text-micro font-bold uppercase tracking-wider text-krypt-purple px-1 py-0.5 rounded bg-krypt-purple/15 border border-krypt-purple/40">
                ★{l.smartBuyerCount}{l.smartEarly ? ' early' : ''}
              </span>
            )}
            <span className="ml-1 text-xs text-krypt-muted truncate">{l.name}</span>
          </span>
          <span><Sparkline data={l.priceHistory} width={92} height={24} /></span>
          <span className="text-xs text-krypt-muted">{fmtAgo(l.detectedAt)}</span>
          <span><Badge tone={PHASE_TONE[l.phase]}>{l.phase}</Badge></span>
          <span className="text-right font-mono text-xs">
            {l.score ? l.score.total : '—'}
          </span>
          <span className="text-right font-mono text-xs">{l.flow.uniqueBuyers}</span>
          <span
            className={cls(
              'text-right font-mono text-xs',
              l.flow.netInflowSol > 0 ? 'text-emerald-300' : l.flow.netInflowSol < 0 ? 'text-rose-300' : 'text-krypt-muted',
            )}
          >
            {l.flow.netInflowSol.toFixed(2)}
          </span>
          <span className="text-right font-mono text-xs text-krypt-muted">
            {l.flow.curveProgressPct.toFixed(1)}%
          </span>
        </button>
        {expanded && <LaunchDetails l={l} />}
        {expanded && (
          <div className="px-5 pb-3 text-body text-krypt-muted font-mono">
            price {fmtPrice(l.priceSol)} SOL · buys {l.flow.buys} / sells {l.flow.sells}
            {l.flow.creatorSold && <span className="text-rose-300"> · CREATOR SOLD</span>}
          </div>
        )}
      </div>
    );
  },
  (a, b) => {
    if (a.expanded !== b.expanded || a.onToggle !== b.onToggle) return false;
    // An expanded row draws the whole record (score table, flags, reason);
    // it is one row at most, so it simply always re-renders.
    if (a.expanded) return false;
    const x = a.l;
    const y = b.l;
    if (x === y) return true;
    if (
      x.mint !== y.mint ||
      x.symbol !== y.symbol ||
      x.name !== y.name ||
      x.phase !== y.phase ||
      x.detectedAt !== y.detectedAt ||
      x.smartBuyerCount !== y.smartBuyerCount ||
      x.smartEarly !== y.smartEarly ||
      (x.score?.total ?? null) !== (y.score?.total ?? null) ||
      x.flow.uniqueBuyers !== y.flow.uniqueBuyers ||
      x.flow.netInflowSol !== y.flow.netInflowSol ||
      x.flow.curveProgressPct !== y.flow.curveProgressPct
    ) {
      return false;
    }
    // The sparkline: same length and same last point means the same picture.
    const px = x.priceHistory;
    const py = y.priceHistory;
    return px.length === py.length && (px.length === 0 || px[px.length - 1] === py[py.length - 1]);
  },
);

export function Launches({ onOpenToken }: { onOpenToken?: (mint: string) => void } = {}) {
  const { launches, status, runners } = useAppState();
  const [open, setOpen] = useState<string | null>(null);
  // Stable, so the memo above holds across pushes.
  const onToggle = useCallback((mint: string) => setOpen((cur) => (cur === mint ? null : mint)), []);
  // Krypt scores for the flags shown below, shared with the Runners tab's cache.
  const runnerScores = useRunnerScores(runners.slice(0, 20).map((r) => r.mint), 0);

  return (
    <Page
      title="Launches"
      subtitle={`Live Pump.fun token creations · ${launches.length} tracked this session`}
    >
      <Section
        title="Potential runners"
        description="Launches whose measured graduation odds sit in the top buckets, judged at +60 s and +120 s. The rate shown is what that bucket did on the measured day — most still did not graduate. Nothing here is bought for you."
      >
        {runners.length === 0 ? (
          <Empty
            title={status.running ? 'Nothing flagged yet' : 'Scanner is stopped'}
            message={status.running ? 'A launch is judged a minute after it appears. Flags land here and as a notification.' : 'Start the scanner to judge launches as they appear.'}
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            {runners.slice(0, 20).map((r) => (
              <div key={r.mint} className="flex items-center gap-3 px-5 py-2.5 border-b border-white/5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-value text-white truncate">{r.symbol || r.mint.slice(0, 6)}</span>
                    <span className="text-body text-krypt-muted truncate">{r.name}</span>
                    <span className="text-label font-mono text-krypt-muted/60">{Math.max(0, Math.round((Date.now() - r.flaggedAt) / 60_000))}m ago · +{r.windowS} s</span>
                  </div>
                  <div className="text-body text-krypt-muted mt-0.5">
                    <span className="text-arc-gold">{r.observedPct.toFixed(0)} % of this bucket graduated</span> (base {r.basePct.toFixed(1)} %, n={r.n}) · curve {r.curvePct.toFixed(0)} % · {r.uniqueBuyers} buyers · +{r.netInflowSol.toFixed(2)} SOL net
                    {' · '}
                    <span title="Krypt score, the token page's. A flag is minutes old, so the providers may not score it yet.">
                      Krypt {runnerScores[r.mint] === undefined ? '…' : runnerScores[r.mint] === null ? '—' : `${runnerScores[r.mint]}/100`}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => onOpenToken?.(r.mint)}
                  className="rounded-md border border-krypt-purple/45 bg-krypt-purple/15 px-2.5 py-1 text-body font-bold text-white hover:bg-krypt-purple/30 transition"
                >
                  Open
                </button>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section>
        {launches.length === 0 ? (
          <Empty
            title={status.running ? 'Waiting for launches…' : 'Engine is stopped'}
            message={
              status.running
                ? 'New Pump.fun tokens appear here the moment their create instruction lands.'
                : 'Press “Start scanning” in the top bar to begin watching the chain.'
            }
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            <div className="grid grid-cols-[24px_1.3fr_100px_0.6fr_0.85fr_0.6fr_0.7fr_0.7fr_0.6fr] items-center gap-2 px-5 py-2.5 text-label font-semibold uppercase tracking-wider text-krypt-muted border-b border-white/5">
              <span />
              <span>Token</span>
              <span>Price</span>
              <span>Age</span>
              <span>Phase</span>
              {/* computeScore's weights are hand-picked and have no measured
                  hit rate (docs/insight-swarm-2026-08-30.md §D) — say so. */}
              <span className="text-right" title="Hand-weighted heuristic — no measured hit rate. Graduation odds are on Discover and the token page.">
                Heuristic score
              </span>
              <span className="text-right">Buyers</span>
              <span className="text-right">Net SOL</span>
              <span className="text-right">Curve</span>
            </div>
            <div className="max-h-[calc(100vh-320px)] overflow-auto divide-y divide-white/5">
              {launches.map((l) => (
                <LaunchRowView key={l.mint} l={l} expanded={open === l.mint} onToggle={onToggle} />
              ))}
            </div>
          </Card>
        )}
      </Section>
    </Page>
  );
}
