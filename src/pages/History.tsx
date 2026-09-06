import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Clock, RefreshCw } from 'lucide-react';
import { Badge, Card, Empty, GhostButton, Page, Section } from '../components/common';
import { AreaChart } from '../components/viz/AreaChart';
import { DistBar } from '../components/viz/DistBar';
import { NumberTicker } from '../components/viz/NumberTicker';
import type { HistorySummary } from '@shared/types';
import { cls, fmtClock, shortAddr } from '../utils/format';

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-krypt-muted">{label}</div>
      <div className="mt-1.5 text-xl font-bold font-mono tabular-nums">{children}</div>
    </Card>
  );
}

function spanLabel(a: number | null, b: number | null): string {
  if (!a || !b) return '—';
  const h = (b - a) / 3_600_000;
  const d = new Date(a);
  const day = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  return `${day} · ${fmtClock(a)}–${fmtClock(b)} (${h.toFixed(1)} h)`;
}

const GOOD_EXITS = new Set(['take_profit', 'trailing_stop', 'curve_complete']);

export function History() {
  const [sum, setSum] = useState<HistorySummary | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await window.krypt.history.load();
    setLoading(false);
    if (r.ok && r.data) setSum(r.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const winRate = sum && sum.wins + sum.losses > 0 ? (sum.wins / (sum.wins + sum.losses)) * 100 : 0;
  const pnl = sum?.realizedPnlSol ?? 0;
  const maxHour = sum ? Math.max(1, ...sum.hourly.map((h) => h.launches)) : 1;

  return (
    <Page
      title="History"
      subtitle="Reconstructed from the on-disk recordings — survives restarts and covers every session."
      actions={
        <GhostButton onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} /> {loading ? 'Reading…' : 'Reload'}
        </GhostButton>
      }
    >
      {!sum || sum.closed === 0 ? (
        <Empty
          title={loading ? 'Reading recordings…' : 'No recorded history yet'}
          message="Once the engine has run and closed paper positions, the full history appears here — even after a restart."
        />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2 text-xs text-krypt-muted">
            <Clock className="h-3.5 w-3.5" />
            <span>{spanLabel(sum.firstAt, sum.lastAt)}</span>
            <span className="text-krypt-muted/40">·</span>
            <span>{sum.files} recording file{sum.files === 1 ? '' : 's'}</span>
          </div>

          <Section title="Lifetime">
            <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3">
              <Tile label="Realized PnL">
                <span className={cls(pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-white')}>
                  <NumberTicker value={pnl} format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}`} />
                </span>
              </Tile>
              <Tile label="Win rate"><span className="text-white">{winRate.toFixed(0)}%</span></Tile>
              <Tile label="Closed"><span className="text-white">{sum.closed}</span></Tile>
              <Tile label="Launches"><span className="text-white">{sum.launches.toLocaleString()}</span></Tile>
              <Tile label="Best"><span className="text-emerald-300">+{sum.best.toFixed(4)}</span></Tile>
              <Tile label="Worst"><span className="text-rose-300">{sum.worst.toFixed(4)}</span></Tile>
            </div>
          </Section>

          <Section title="Equity curve" description="Cumulative realized PnL across every closed paper position.">
            <Card>
              <AreaChart data={sum.equity} height={200} />
            </Card>
          </Section>

          <div className="grid lg:grid-cols-2 gap-4">
            <Section title="How positions exited" description="Which trigger closed each trade.">
              <Card>
                <DistBar
                  items={Object.entries(sum.exitReasons).map(([label, value]) => ({
                    label,
                    value,
                    tone: GOOD_EXITS.has(label) ? 'good' : label === 'orphaned' ? 'neutral' : 'bad',
                  }))}
                />
              </Card>
            </Section>
            <Section title="Decision mix" description="What the strategy did with each launch it saw.">
              <Card>
                <DistBar
                  items={Object.entries(sum.decisions).map(([label, value]) => ({
                    label,
                    value,
                    tone: label === 'enter' ? 'good' : label === 'reject' ? 'bad' : 'neutral',
                  }))}
                />
              </Card>
            </Section>
          </div>

          <Section title="Activity by hour" description="Launches seen (bar) and paper entries (purple dot) per hour.">
            <Card>
              <div className="flex items-end gap-1 h-24" role="img" aria-label="Launches per hour">
                {sum.hourly.map((h) => (
                  <div key={h.label} className="flex-1 flex flex-col items-center justify-end group relative">
                    <div className="w-full rounded-t-[3px] bg-krypt-purple/40" style={{ height: `${(h.launches / maxHour) * 100}%` }} />
                    {h.entries > 0 && <div className="absolute -top-1 h-1.5 w-1.5 rounded-full bg-arc-gold shadow-[0_0_6px_rgba(217,180,91,0.8)]" />}
                    <div className="pointer-events-none absolute -top-8 hidden group-hover:block rounded-lg border border-white/10 bg-black/85 px-2 py-1 text-[10px] font-mono whitespace-nowrap z-10">
                      {h.label} · {h.launches} launches · {h.entries} entries
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Section>

          <Section title={`Closed trades (${sum.recentCloses.length})`}>
            <Card padded={false} className="overflow-hidden">
              <div className="grid grid-cols-[1fr_1.2fr_0.9fr_0.9fr] gap-2 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-krypt-muted border-b border-white/5">
                <span>Time</span><span>Mint</span><span>Exit</span><span className="text-right">PnL</span>
              </div>
              <div className="max-h-[420px] overflow-auto divide-y divide-white/5">
                {sum.recentCloses.map((c, i) => (
                  <motion.div
                    key={`${c.mint}-${c.at}-${i}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(i * 0.01, 0.3) }}
                    className="grid grid-cols-[1fr_1.2fr_0.9fr_0.9fr] gap-2 px-5 py-2 text-sm items-center"
                  >
                    <span className="text-xs text-krypt-muted font-mono">{fmtClock(c.at)}</span>
                    <span className="font-mono text-xs text-white/80">{shortAddr(c.mint, 5)}</span>
                    <span>
                      <Badge tone={GOOD_EXITS.has(c.reason) ? 'success' : c.reason === 'orphaned' ? 'neutral' : 'warn'}>
                        {c.reason.replace(/_/g, ' ')}
                      </Badge>
                    </span>
                    <span className={cls('text-right font-mono text-xs font-semibold', c.pnlSol >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                      {c.pnlSol >= 0 ? '+' : ''}{c.pnlSol.toFixed(4)}
                    </span>
                  </motion.div>
                ))}
              </div>
            </Card>
          </Section>
        </>
      )}
    </Page>
  );
}
