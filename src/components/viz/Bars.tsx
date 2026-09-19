import { useAccent } from '../../state/useAccent';
// Launches-per-minute bars — magnitude, one hue, rounded data ends,
// 2px gaps, per-bar hover tooltip. Newest minute on the right.

import { useState } from 'react';

// Read at render - an inline style string cannot carry var() through here.

export function Bars({
  buckets,
  height = 72,
}: {
  /** Oldest → newest counts, one per minute. */
  buckets: Array<{ label: string; count: number }>;
  height?: number;
}) {
  const { rgb } = useAccent();
  const PURPLE = rgb();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="relative">
      <div className="flex items-end gap-[2px]" style={{ height }} role="img" aria-label="Launches per minute">
        {buckets.map((b, i) => {
          const h = Math.max(3, (b.count / max) * height);
          const active = hover === i;
          return (
            <div
              key={b.label}
              className="flex-1 rounded-t-[4px] transition-[filter] cursor-default"
              style={{
                height: h,
                background: b.count === 0 ? 'rgba(255,255,255,0.06)' : PURPLE,
                opacity: b.count === 0 ? 1 : 0.45 + 0.55 * (b.count / max),
                filter: active ? 'brightness(1.35) drop-shadow(0 0 6px rgb(var(--krypt-accent) / 0.6))' : undefined,
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-lg border border-white/10 bg-black/85 px-2 py-1 text-label font-mono text-white whitespace-nowrap">
          {buckets[hover].label} · {buckets[hover].count} launch{buckets[hover].count === 1 ? '' : 'es'}
        </div>
      )}
    </div>
  );
}
