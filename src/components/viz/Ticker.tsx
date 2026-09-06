// The prophecy ribbon — a continuously scrolling strip of the newest tokens
// off the chain, set like an illuminated manuscript margin. Content is
// duplicated once for a seamless CSS loop; paused on hover; disabled under
// reduced motion.

import type { LaunchRow } from '@shared/types';
import { cls, fmtAgo } from '../../utils/format';

const PHASE_COLOR: Record<LaunchRow['phase'], string> = {
  detected: 'text-white/75',
  evaluating: 'text-krypt-pink',
  entered: 'text-arc-gold',
  flagged: 'text-arc-gold',
  rejected: 'text-rose-300/70',
  completed: 'text-amber-300',
  stale: 'text-white/35',
};

function TapeItem({ l }: { l: LaunchRow }) {
  return (
    <span className="inline-flex items-center gap-2 px-3.5 font-mono text-xs whitespace-nowrap">
      <span className={cls('font-semibold', PHASE_COLOR[l.phase])}>{l.symbol || '—'}</span>
      <span className={l.flow.netInflowSol >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'}>
        {l.flow.netInflowSol >= 0 ? '▲' : '▼'} {Math.abs(l.flow.netInflowSol).toFixed(2)}
      </span>
      <span className="text-krypt-muted/60">{l.flow.uniqueBuyers}b</span>
      <span className="text-krypt-muted/40">{fmtAgo(l.detectedAt)}</span>
      <span className="text-arc-gold/30 text-[9px]">✦</span>
    </span>
  );
}

export function Ticker({ launches }: { launches: LaunchRow[] }) {
  const items = launches.slice(0, 24);
  if (items.length === 0) return null;
  return (
    <div className="group relative flex items-stretch overflow-hidden border-b border-white/10 bg-black/40 select-none">
      <div className="flex items-center border-r border-white/10 bg-krypt-panel/80 px-3 z-20">
        <span className="font-display text-[9px] uppercase tracking-[0.32em] text-arc-gold/70">Omens</span>
      </div>
      <div className="relative flex-1 overflow-hidden py-1.5">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-14 bg-gradient-to-r from-krypt-void to-transparent z-10" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-14 bg-gradient-to-l from-krypt-void to-transparent z-10" />
        <div className="flex w-max animate-tape group-hover:[animation-play-state:paused]">
          {items.map((l) => <TapeItem key={`a-${l.mint}`} l={l} />)}
          {items.map((l) => <TapeItem key={`b-${l.mint}`} l={l} />)}
        </div>
      </div>
    </div>
  );
}
