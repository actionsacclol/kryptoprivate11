// Micro line chart for table rows and cards. One hue, no axes, no chrome —
// the row it lives in carries the labels. Rendered as pure SVG.

export function Sparkline({
  data,
  width = 96,
  height = 28,
  stroke = '#8B7CE8',
  positive,
}: {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  /** When set, overrides hue with PnL polarity (emerald/rose). */
  positive?: boolean;
}) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.08)" strokeWidth={2} strokeDasharray="2 4" />
      </svg>
    );
  }
  const color = positive === undefined ? stroke : positive ? '#22C55E' : '#EF4444';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 3;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  const gid = `sp-${color.replace('#', '')}`;
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
