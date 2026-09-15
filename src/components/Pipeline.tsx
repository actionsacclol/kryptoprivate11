// The ritual pipeline — one connected instrument showing every launch's path
// through the engine: detected off the wire, decoded, evaluated against the
// wards, FLAGGED as a potential runner — or banished to the rejection seal.
// Counts are live; the connectors carry moving sparks while the engine runs.
//
// The fourth stage used to be "Entered", from when the engine opened
// positions by itself. It has not done that since 2026-08-16, so the number
// sat at zero and read as a broken instrument. The stage the scanner
// actually produces is a flagged runner; paper entries, which are an opt-in
// research toggle, are shown underneath when there are any.

import { useMemo } from 'react';
import type { EngineStatus, LaunchRow } from '@shared/types';
import { NumberTicker } from './viz/NumberTicker';
import { cls } from '../utils/format';

function Stage({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: 'gold' | 'crimson';
}) {
  return (
    <div
      className={cls(
        'plate rounded-lg px-4 py-3 min-w-[118px] text-center',
        tone === 'gold' && 'plate-gold',
        tone === 'crimson' && 'plate-crimson',
      )}
    >
      <div className={cls(
        'font-display text-micro font-semibold uppercase tracking-heading',
        tone === 'gold' ? 'text-arc-gold/90' : tone === 'crimson' ? 'text-rose-300/90' : 'text-krypt-muted',
      )}>
        {label}
      </div>
      <NumberTicker
        value={value}
        format={(v) => String(Math.round(v))}
        className={cls(
          'mt-1 block text-xl font-bold font-mono tabular-nums',
          tone === 'gold' ? 'text-arc-gold glow-text-gold' : tone === 'crimson' ? 'text-rose-300' : 'text-white',
        )}
      />
      {sub && <div className="mt-0.5 text-label font-mono text-krypt-muted/70">{sub}</div>}
    </div>
  );
}

function Connector({ active, crimson }: { active: boolean; crimson?: boolean }) {
  return (
    <div className="relative flex-1 min-w-[24px] h-px self-center overflow-visible" aria-hidden="true">
      <div className={cls('absolute inset-0', crimson ? 'bg-rose-500/25' : 'bg-white/[0.12]')} />
      {active && (
        <span
          className={cls(
            'animate-spark absolute -top-[2px] h-[5px] w-[5px] rotate-45',
            crimson ? 'bg-rose-400 shadow-crimson-glow' : 'bg-krypt-pink shadow-krypt-glow',
          )}
        />
      )}
    </div>
  );
}

export function Pipeline({ status, launches }: { status: EngineStatus; launches: LaunchRow[] }) {
  // Every seen launch WAS decoded (that's how it was seen); layoutErrors
  // counts decode drift across all events, surfaced as a sublabel instead.
  const decodedSub = status.running
    ? `${Math.round(status.decodeLatencyMs)} ms${status.layoutErrors > 0 ? ` · ${status.layoutErrors} drift` : ''}`
    : undefined;

  // Most common rejection reason this session.
  const topReason = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of launches) {
      if (l.phase !== 'rejected' || !l.reason) continue;
      counts.set(l.reason, (counts.get(l.reason) ?? 0) + 1);
    }
    let best: { reason: string; n: number } | null = null;
    for (const [reason, n] of counts) {
      if (!best || n > best.n) best = { reason, n };
    }
    return best;
  }, [launches]);

  const flowing = status.running && status.feed === 'live';

  return (
    <div className="plate rounded-lg px-5 py-4 overflow-x-auto">
      <div className="flex items-center gap-3 min-w-[840px]">
        <Stage label="Detected" value={status.launchesSeen} sub={status.running ? `${status.eventsPerSec.toFixed(1)} ev/s` : undefined} />
        <Connector active={flowing} />
        <Stage label="Decoded" value={status.launchesSeen} sub={decodedSub} />
        <Connector active={flowing} />
        <Stage label="Evaluated" value={status.launchesEvaluated} />
        <Connector active={flowing && status.runnersFlagged > 0} />
        <Stage
          label="Runners"
          value={status.runnersFlagged}
          sub={status.launchesEntered > 0 ? `${status.launchesEntered} paper` : undefined}
          tone="gold"
        />
        <Connector active={flowing && status.launchesRejected > 0} crimson />
        <Stage label="Rejected" value={status.launchesRejected} tone="crimson" />
      </div>
      {topReason && (
        <div className="mt-3 flex items-center gap-2 text-xs text-krypt-muted">
          <span className="h-1.5 w-1.5 rotate-45 bg-rose-400/70 flex-shrink-0" aria-hidden="true" />
          Most common rejection: <span className="text-rose-300/90">{topReason.reason}</span>
          <span className="font-mono text-krypt-muted/60">×{topReason.n}</span>
        </div>
      )}
    </div>
  );
}
