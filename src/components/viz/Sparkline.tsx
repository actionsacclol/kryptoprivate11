import { useAccent } from '../../state/useAccent';
// Micro line chart for table rows and cards. One hue, no axes, no chrome —
// the row it lives in carries the labels. Rendered as pure SVG.

export function Sparkline({
  data,
  width = 96,
  height = 28,
  stroke,
  positive,
  floorSpan,
}: {
  data: number[];
  width?: number;
  height?: number;
  /** Overrides the accent. Omitted = whatever the theme's accent is. */
  stroke?: string;
  /** When set, overrides hue with PnL polarity (emerald/rose). */
  positive?: boolean;
  /**
   * Smallest vertical range the box may show, as a fraction of the FIRST
   * value. Without it the line is scaled to its own min and max, so a series
   * that wiggles by 0.3 % fills the whole height and reads like a rocket —
   * which is what a runner row looked like while its market cap bounced
   * around a thousand dollars (user report, 2026-09-19). With 0.5, a ±5 %
   * wiggle is a nearly flat line and a doubling still fills the box.
   */
  floorSpan?: number;
}) {
  const { rgb } = useAccent();
  const hue = stroke ?? rgb();
  if (data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.08)" strokeWidth={2} strokeDasharray="2 4" />
      </svg>
    );
  }
  const color = positive === undefined ? hue : positive ? '#22C55E' : '#EF4444';
  let min = Math.min(...data);
  let max = Math.max(...data);
  if (floorSpan && floorSpan > 0 && data[0] > 0) {
    const need = data[0] * floorSpan;
    if (max - min < need) {
      const mid = (max + min) / 2;
      min = mid - need / 2;
      max = mid + need / 2;
    }
  }
  const span = max - min || 1;
  const pad = 3;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  const gid = `sp-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg width={width} height={height} aria-label={`price trend, ${data.length} points`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`${pad},${height - pad} ${pts.join(' ')} ${width - pad},${height - pad}`}
        fill={`url(#${gid})`}
      />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}
