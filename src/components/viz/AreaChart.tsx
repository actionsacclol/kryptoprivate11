// Session equity curve — single series (the title names it, no legend),
// crosshair + tooltip on hover, recessive hairline grid, values in text
// tokens. Zero-line shown when the series crosses it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtClock } from '../../utils/format';

export interface SeriesPoint {
  t: number;
  v: number;
}

const PURPLE = '#8B7CE8';

export function AreaChart({
  data,
  height = 180,
  valueSuffix = ' SOL',
}: {
  data: SeriesPoint[];
  height?: number;
  valueSuffix?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ x: number; idx: number } | null>(null);
  // viewBox width tracks the actual container so a fixed aspect ratio never
  // letterboxes the drawing (which would also desync the hover crosshair).
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    if (data.length < 2) return null;
    const padX = 8;
    const padY = 14;
    const min = Math.min(0, ...data.map((d) => d.v));
    const max = Math.max(0, ...data.map((d) => d.v));
    const span = max - min || 1;
    const x = (i: number) => padX + (i / (data.length - 1)) * (width - padX * 2);
    const y = (v: number) => padY + (1 - (v - min) / span) * (height - padY * 2);
    const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.v).toFixed(1)}`);
    return { pts, x, y, min, max, zeroY: y(0) };
  }, [data, height, width]);

  if (!geom) {
    return (
      <div className="flex items-center justify-center text-xs text-krypt-muted/60" style={{ height }}>
        Collecting session data…
      </div>
    );
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * width;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(((fx - 8) / (width - 16)) * (data.length - 1))));
    setHover({ x: fx, idx });
  };

  const hp = hover ? data[hover.idx] : null;
  const lastV = data[data.length - 1].v;

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Session PnL, currently ${lastV.toFixed(4)}${valueSuffix}`}
      >
        <defs>
          <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PURPLE} stopOpacity="0.35" />
            <stop offset="100%" stopColor={PURPLE} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* hairline grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={8} x2={width - 8} y1={14 + f * (height - 28)} y2={14 + f * (height - 28)} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
        ))}
        {/* zero line */}
        <line x1={8} x2={width - 8} y1={geom.zeroY} y2={geom.zeroY} stroke="rgba(255,255,255,0.14)" strokeWidth={1} strokeDasharray="3 4" />
        <polygon points={`8,${geom.zeroY} ${geom.pts.join(' ')} ${width - 8},${geom.zeroY}`} fill="url(#eq-fill)" />
        <polyline points={geom.pts.join(' ')} fill="none" stroke={PURPLE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover && hp && (
          <g>
            <line x1={geom.x(hover.idx)} x2={geom.x(hover.idx)} y1={10} y2={height - 10} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
            <circle cx={geom.x(hover.idx)} cy={geom.y(hp.v)} r={4} fill={PURPLE} stroke="#0A0A0F" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover && hp && (
        <div
          className="pointer-events-none absolute top-1 rounded-lg border border-white/10 bg-black/85 px-2.5 py-1.5 text-body font-mono backdrop-blur-sm"
          style={{ left: `${Math.min(86, Math.max(2, (hover.x / width) * 100))}%` }}
        >
          <span className="text-krypt-muted">{fmtClock(hp.t)} · </span>
          <span className={hp.v >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
            {hp.v >= 0 ? '+' : ''}{hp.v.toFixed(4)}{valueSuffix}
          </span>
        </div>
      )}
    </div>
  );
}
