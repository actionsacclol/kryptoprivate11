export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function shortAddr(addr: string, n = 4): string {
  if (addr.length <= n * 2 + 1) return addr;
  return `${addr.slice(0, n)}…${addr.slice(-n)}`;
}

export function fmtSol(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} SOL`;
}

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 0.001) return v.toFixed(6);
  return v.toExponential(2);
}

export function fmtPct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Duration between two timestamps, compact: "42s", "3m 10s", "1h 12m". */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '—';
  }
}

// ── Terminal formatting ───────────────────────────────────────────────
//
// One rule runs through all of these: a null is NOT a zero. The market data
// layer returns null wherever no provider could answer, and these renderers
// print an em dash for it. A terminal that shows "0 holders" when it means
// "we don't know yet" is teaching the user to distrust every other number
// on the screen.

const DASH = '—';

/** Compact USD: $1.2K, $340K, $12.4M. */
export function fmtUsd(v: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  if (abs >= 1) return `$${v.toFixed(opts.decimals ?? 2)}`;
  return `$${v.toFixed(opts.decimals ?? 4)}`;
}

/**
 * Sub-cent prices with subscript zero-runs, the way every memecoin terminal
 * writes them: $0.0₅1234 instead of $0.000001234. Returns the parts so the
 * caller can render the run count as an actual <sub>.
 */
export function fmtSubPrice(v: number | null | undefined): { lead: string; zeros: number; digits: string } | null {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return null;
  if (v >= 0.001) return { lead: v < 1 ? '0' : Math.floor(v).toString(), zeros: 0, digits: '' };
  const exp = Math.floor(Math.log10(v));
  const zeros = Math.abs(exp) - 1;
  const digits = Math.round(v * 10 ** (zeros + 4)).toString().slice(0, 4);
  return { lead: '0', zeros, digits };
}

/** Plain price string for places that cannot render a subscript. */
export function fmtPriceUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return DASH;
  if (v >= 1) return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(8)}`;
  return `$${v.toExponential(4)}`;
}

/** Whole numbers with thousands separators; null-safe. */
export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Percentage where null is unknown, not zero. */
export function fmtPctOrDash(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(digits)}%`;
}

/** Signed percentage change, for price deltas. */
export function fmtChange(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** Very compact age: 4s, 12m, 3h, 6d. */
export function fmtAge(createdAt: number | null | undefined, now = Date.now()): string {
  if (createdAt === null || createdAt === undefined || !Number.isFinite(createdAt)) return DASH;
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Tailwind text colour for a signed number. Neutral when unknown. */
export function toneFor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'text-krypt-muted';
  return v > 0 ? 'text-emerald-400' : 'text-rose-400';
}

/** Colour band for a 0..100 score. Null renders muted, never green. */
export function scoreTone(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'text-krypt-muted';
  if (score >= 75) return 'text-emerald-400';
  if (score >= 50) return 'text-arc-gold';
  return 'text-rose-400';
}
