// The Observatory — the dashboard rebuilt around the scrying orb. One
// dominant instrument (the orb), the session ledger beside it, the ritual
// pipeline underneath, then launch rate, the replay archive, and recent
// closes. Every arcane label maps to real engine state.

import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Crosshair, Database, FolderOpen } from 'lucide-react';
import { Card, Empty, GhostButton, Section } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { useReduceEffects, EffectsOff } from '../components/viz/useReduceEffects';
import { AreaChart } from '../components/viz/AreaChart';
import { Bars } from '../components/viz/Bars';
import { NumberTicker } from '../components/viz/NumberTicker';
import { Pipeline } from '../components/Pipeline';
import { TokenDrawer } from '../components/TokenDrawer';
import type { RouteId } from '../components/Sidebar';
import { useToast } from '../state/ToastProvider';
import type { LaunchRow } from '@shared/types';
import { cls, fmtBytes, fmtDur, fmtPct, fmtPrice, fmtSol } from '../utils/format';

// three.js rides with the observatory alone: the cards and numbers paint
// first and the orb follows from its own chunk.
const Radar3D = lazy(() => import('../components/viz/Radar3D').then((m) => ({ default: m.Radar3D })));

function OrbLabel({ text, on, tone = 'violet' }: { text: string; on: boolean; tone?: 'violet' | 'gold' }) {
  return (
    <div className="flex items-center gap-1.5 text-micro font-display uppercase tracking-label">
      <span
        className={cls(
          'h-1 w-1 rotate-45 flex-shrink-0',
          on
            ? tone === 'gold' ? 'bg-arc-gold shadow-gold-glow animate-rune-pulse' : 'bg-krypt-purple shadow-krypt-glow animate-rune-pulse'
            : 'bg-krypt-muted/30',
        )}
        aria-hidden="true"
      />
      <span className={on ? 'text-white/80' : 'text-krypt-muted/50'}>{text}</span>
    </div>
  );
}

function LedgerStat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <div className="text-micro font-display uppercase tracking-label text-krypt-muted/80">{label}</div>
      <div className={cls(
        'mt-0.5 text-sm font-mono tabular-nums font-semibold',
        tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-white/90',
      )}>{value}</div>
    </div>
  );
}

export function Dashboard({ onNavigate }: { onNavigate: (r: RouteId) => void }) {
  const { status, positions, launches, equity } = useAppState();
  const toast = useToast();
  const reduceEffects = useReduceEffects();
  const [rec, setRec] = useState<{ files: number; totalBytes: number }>({ files: 0, totalBytes: 0 });
  // Snapshot, not just a mint: the launches list is capped, so the row behind
  // an open drawer can be evicted mid-inspection. Fresh data wins when
  // available; the snapshot keeps the drawer alive when it is not.
  const [inspect, setInspect] = useState<LaunchRow | null>(null);
  // The launch-rate window must advance even when the feed is quiet.
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinuteTick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void window.krypt.recorder.stats().then((r) => {
        if (alive && r.ok && r.data) setRec(r.data);
      });
    };
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Launches per minute, last 15 buckets.
  const buckets = useMemo(() => {
    const now = Date.now();
    const out: Array<{ label: string; count: number }> = [];
    for (let i = 14; i >= 0; i--) {
      const start = now - (i + 1) * 60_000;
      const end = now - i * 60_000;
      const count = launches.filter((l) => l.detectedAt >= start && l.detectedAt < end).length;
      const d = new Date(end);
      out.push({ label: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, count });
    }
    return out;
    // minuteTick advances the window during quiet stretches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launches, minuteTick]);

  const pnl = status.realizedPnlSol;
  // When live, the headline PnL is the ACTUAL wallet-balance change; paper PnL
  // is shown as a secondary line for comparison.
  const livePnl = status.liveActive && status.liveRealizedPnlSol != null ? status.liveRealizedPnlSol : pnl;
  const closed = positions.filter((p) => p.state === 'closed' && p.exitReason !== 'orphaned');
  const wins = closed.filter((p) => p.pnlSol > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : null;
  const unrealized = positions.filter((p) => p.state !== 'closed').reduce((a, p) => a + p.pnlSol, 0);
  // Session-wide drawdown from the cumulative realized PnL of every close —
  // the equity buffer only holds ~15 minutes and would understate it.
  const maxDrawdown = useMemo(() => {
    const byClose = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (const p of byClose) {
      cum += p.pnlSol;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    return dd;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);
  const buys = status.liveActive ? status.liveBuys : positions.length;
  const sells = status.liveActive ? status.liveSells : closed.length;
  const evaluating = launches.filter((l) => l.phase === 'evaluating').length;
  const recent = positions
    .filter((p) => p.state === 'closed')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 6);
  const inspected = inspect ? launches.find((l) => l.mint === inspect.mint) ?? inspect : null;

  const openDrawer = (mint: string): void => {
    const l = launches.find((x) => x.mint === mint);
    if (l) setInspect(l);
    else toast.info('That launch is no longer in session memory');
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* ── Hero: the orb + the ledger ── */}
      <div className="relative px-8 pt-6 pb-2">
        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
            className="plate relative h-[340px] rounded-lg !bg-black/45 overflow-hidden"
          >
            {/* Dust lives on its own layer — the mask must not fade the orb or labels. */}
            <div className="absolute inset-0 grid-backdrop animate-dust pointer-events-none" aria-hidden="true" />
            {reduceEffects === false ? (
              <Suspense fallback={<EffectsOff label="" />}>
                <Radar3D
                  launches={launches}
                  live={status.feed === 'live'}
                  onSelect={openDrawer}
                />
              </Suspense>
            ) : (
              <EffectsOff label={reduceEffects === null ? '' : 'Effects reduced · Settings › Display'} />
            )}
            <div className="pointer-events-none absolute top-4 left-5">
              <div className="font-display text-label uppercase tracking-eyebrow text-arc-gold/75">The Observatory</div>
              <div className="mt-1.5 text-3xl font-bold font-mono tabular-nums text-white glow-text">
                <NumberTicker value={status.launchesSeen} format={(v) => String(Math.round(v))} />
              </div>
              <div className="font-display text-label uppercase tracking-label text-krypt-muted mt-0.5">
                Launches observed
              </div>
            </div>
            <div className="pointer-events-none absolute top-4 right-5 flex flex-col items-end gap-2">
              <OrbLabel text={`Evaluating ${evaluating}`} on={evaluating > 0} />
              <OrbLabel text="Risk wards active" on={status.running} />
              <OrbLabel text="Creator scans" on={status.running && status.feed === 'live'} />
              <OrbLabel text={`Runners ${status.runnersFlagged}`} on={status.runnersFlagged > 0} tone="gold" />
            </div>
            <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-3 text-label font-mono text-krypt-muted/70">
              <span><span className="text-krypt-pink">●</span> launch</span>
              <span><span className="text-arc-gold">●</span> runner</span>
              <span><span className="text-rose-900">●</span> rejected</span>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.08 }}
            className="plate relative h-[340px] rounded-lg p-5 flex flex-col"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <div className="font-display text-label uppercase tracking-eyebrow text-krypt-muted">
                    Session ledger
                  </div>
                  {status.liveActive && (
                    <span className="text-micro font-bold uppercase tracking-wider text-rose-300 px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/30">live</span>
                  )}
                </div>
                {/* WHICH accounting this is, and since when.
                    This panel shows two different sets of numbers — paper
                    positions when idle, live-session counters when armed —
                    and swaps between them the instant `liveActive` changes.
                    To anyone watching, that swap is indistinguishable from
                    the numbers being wiped, which is what was reported on
                    2026-09-16. Both resets are deliberate (arming
                    rebaselines the loss breakers on purpose), so the fix is
                    to SAY which one you are looking at. */}
                <div className="mt-0.5 text-label text-krypt-muted/60">
                  {status.liveActive
                    ? `Live session${status.liveSessionStartedAt ? ` · started ${fmtDur(Date.now() - status.liveSessionStartedAt)} ago` : ''}${status.liveSessionReason ? ` when ${status.liveSessionReason}` : ''}`
                    : 'Paper session · research positions, not real money'}
                </div>
                <NumberTicker
                  value={livePnl}
                  format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`}
                  className={cls(
                    'mt-1 block text-4xl font-bold font-mono tabular-nums tracking-tight',
                    livePnl > 0 ? 'text-emerald-300' : livePnl < 0 ? 'text-rose-300 glow-text' : 'text-white',
                  )}
                />
                {status.liveActive && (
                  <div className="mt-1 text-body text-krypt-muted font-mono">
                    research paper {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)} SOL
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-x-4 gap-y-3">
              <LedgerStat label="Wallet" value={status.walletBalanceSol != null ? `${status.walletBalanceSol.toFixed(3)}` : '—'} />
              <LedgerStat label="Realized" value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`} tone={pnl > 0 ? 'good' : pnl < 0 ? 'bad' : undefined} />
              <LedgerStat label="Unrealized" value={`${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(3)}`} tone={unrealized > 0 ? 'good' : unrealized < 0 ? 'bad' : undefined} />
              <LedgerStat label="Open" value={String(status.openPositions)} />
              <LedgerStat label="Buys" value={String(buys)} />
              <LedgerStat label="Sells" value={String(sells)} />
              <LedgerStat label="Win rate" value={winRate != null ? `${winRate.toFixed(0)}%` : '—'} tone={winRate != null ? (winRate >= 50 ? 'good' : 'bad') : undefined} />
              <LedgerStat label="Max DD" value={maxDrawdown > 0 ? `−${maxDrawdown.toFixed(3)}` : '—'} tone={maxDrawdown > 0 ? 'bad' : undefined} />
            </div>

            <div className="flex-1 mt-2 -mx-2 min-h-0">
              <AreaChart data={equity} height={130} />
            </div>
          </motion.div>
        </div>
      </div>

      {/* ── The ritual pipeline ── */}
      <div className="px-8 py-4">
        <Pipeline status={status} launches={launches} />
      </div>

      <div className="px-8 pb-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Launch rate */}
        <Section title="Launch rate" description="New Pump.fun tokens per minute, last 15 minutes.">
          <Card>
            <Bars buckets={buckets} height={80} />
          </Card>
        </Section>

        {/* Replay archive */}
        <Section title="Replay archive" description="Raw evidence for strategy re-fitting.">
          <Card className="flex items-center justify-between h-[112px]">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-krypt-purple" />
              <div>
                <div className="text-sm font-semibold text-white font-mono">{rec.files} record{rec.files === 1 ? '' : 's'} · {fmtBytes(rec.totalBytes)}</div>
                <div className="text-xs text-krypt-muted mt-0.5">events · decisions · order intents</div>
              </div>
            </div>
            <GhostButton onClick={() => void window.krypt.app.openRecordingsFolder()}>
              <FolderOpen className="h-4 w-4" /> Open archive
            </GhostButton>
          </Card>
        </Section>
      </div>

      {/* Recent closes */}
      <div className="px-8 pb-10">
        <Section
          title="Recent closes"
          actions={
            <GhostButton onClick={() => onNavigate('positions')} className="!py-1.5 !px-3 text-xs">
              All positions <ArrowRight className="h-3.5 w-3.5" />
            </GhostButton>
          }
        >
          {recent.length === 0 ? (
            <Empty
              title="No closed positions yet"
              message="Qualifying launches are traded through the full exit state machine while the engine runs."
              action={
                !status.running ? (
                  <div className="flex items-center gap-2 text-xs text-krypt-muted">
                    <Crosshair className="h-3.5 w-3.5 text-krypt-purple" /> Press Start scanning to begin watching the chain
                  </div>
                ) : undefined
              }
            />
          ) : (
            <Card padded={false} className="overflow-hidden">
              <div className="grid grid-cols-[1fr_110px_110px_150px_80px_130px_70px] items-center gap-2 px-5 py-2 text-micro font-display font-semibold uppercase tracking-label text-krypt-muted border-b border-white/10">
                <span>Token</span>
                <span className="text-right">Entry</span>
                <span className="text-right">Close</span>
                <span className="text-right">PnL</span>
                <span className="text-right">Hold</span>
                <span>Exit reason</span>
                <span className="text-right">Mode</span>
              </div>
              <div className="divide-y divide-white/5">
                {recent.map((p) => (
                  <motion.button
                    key={p.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    onClick={() => openDrawer(p.mint)}
                    className="w-full grid grid-cols-[1fr_110px_110px_150px_80px_130px_70px] items-center gap-2 px-5 py-2.5 text-left transition hover:bg-white/[0.04]"
                  >
                    <span className="text-sm font-semibold text-white truncate">{p.symbol}</span>
                    <span className="text-right text-xs font-mono text-krypt-muted">{fmtPrice(p.entryPriceSol)}</span>
                    <span className="text-right text-xs font-mono text-krypt-muted">{fmtPrice(p.currentPriceSol)}</span>
                    <span className={cls('text-right text-xs font-mono font-semibold', p.pnlSol >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                      {p.pnlSol >= 0 ? '+' : ''}{fmtSol(p.pnlSol)} ({fmtPct(p.pnlPct)})
                    </span>
                    <span className="text-right text-xs font-mono text-krypt-muted">
                      {p.closedAt ? fmtDur(p.closedAt - p.openedAt) : ''}
                    </span>
                    <span className="text-xs text-krypt-muted truncate">{p.exitReason?.replace(/_/g, ' ') ?? '—'}</span>
                    <span className={cls('text-right text-label font-mono uppercase', p.live ? 'text-rose-300' : 'text-krypt-muted/70')}>
                      {p.live ? 'live' : 'paper'}
                    </span>
                  </motion.button>
                ))}
              </div>
            </Card>
          )}
        </Section>
      </div>

      <TokenDrawer launch={inspected} onClose={() => setInspect(null)} />
    </div>
  );
}
