// What pump says about you as a caller.
//
// ─── The route, READ from pump's own site code and CONFIRMED live 09-22 ───
//
// `GET /users/{address}/callout-stats` — PUBLIC, keyed by the wallet address,
// "derived from publicly visible callouts". Every rolling window in one
// answer: daily, weekly, monthly, allTime, each
//
//   { totalCallouts, calloutsWithMultiple, twoXPercent, onePointFiveXPercent,
//     onePointTwoXPercent, averageMultiple, medianMultiple,
//     averageTimeToPeakMs, distribution: [{min, max, count}] }
//
// plus `computedAt`. A window is absent only when their stats service is down
// (the route "fails open to {}") and present with zeros for someone with no
// callouts — so an absent window is UNKNOWN, a zero is a real zero.
//
// Until 09-22 this read `/callout/leaderboard-stats/{userId}`, which answers
// leaderboard streaks and finishes, not performance — every field this looked
// for was missing and the panel said so. That route also needed pump's user
// id, which the app never had.

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The path a caller's stats are read from. The address goes into a path, so
 *  it may only ever be a plain base58 address — nothing to escape. */
export function callerStatsPath(address: string): string | null {
  const a = (address ?? '').trim();
  return BASE58_ADDRESS.test(a) ? `/users/${a}/callout-stats` : null;
}

/** One rolling window. Every number is nullable: null = not in the answer. */
export interface CalloutWindow {
  totalCallouts: number | null;
  /** Share of callouts whose peak reached 2× / 1.5× / 1.2×, in percent. */
  twoXPct: number | null;
  oneFiveXPct: number | null;
  oneTwoXPct: number | null;
  averageMultiple: number | null;
  medianMultiple: number | null;
  averageTimeToPeakMs: number | null;
}

export const STATS_WINDOWS = ['daily', 'weekly', 'monthly', 'allTime'] as const;
export type StatsWindowKey = (typeof STATS_WINDOWS)[number];
export const STATS_WINDOW_LABEL: Record<StatsWindowKey, string> = {
  daily: 'Today',
  weekly: 'This week',
  monthly: 'This month',
  allTime: 'All time',
};

export interface CallerStats {
  /** Absent window = their stats service did not answer for it. */
  windows: Partial<Record<StatsWindowKey, CalloutWindow>>;
  /** When pump computed them (ISO), or null. */
  computedAt: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function windowFrom(raw: unknown): CalloutWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  return {
    totalCallouts: num(w.totalCallouts),
    twoXPct: num(w.twoXPercent),
    oneFiveXPct: num(w.onePointFiveXPercent),
    oneTwoXPct: num(w.onePointTwoXPercent),
    averageMultiple: num(w.averageMultiple),
    medianMultiple: num(w.medianMultiple),
    averageTimeToPeakMs: num(w.averageTimeToPeakMs),
  };
}

/** pump's answer, read field by field. Unknown fields are ignored. */
export function callerStatsFrom(body: unknown): CallerStats {
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const windows: CallerStats['windows'] = {};
  for (const k of STATS_WINDOWS) {
    const w = windowFrom(o[k]);
    if (w) windows[k] = w;
  }
  return { windows, computedAt: typeof o.computedAt === 'string' ? o.computedAt : null };
}

/** One line per account, in the order the accounts are listed. */
export function namesFromList(text: string, max: number): string[] {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, max);
}

/**
 * Why a list of names cannot be applied, or null.
 *
 * Usernames are almost certainly unique on pump — so a list with the same name
 * twice is a run that half works and leaves nobody able to say which half. It
 * is refused before anything is sent.
 */
export function nameListProblem(names: string[], accounts: number): string | null {
  if (names.length === 0) return 'Write at least one name.';
  if (names.length > accounts) return `${names.length} names for ${accounts} account${accounts === 1 ? '' : 's'}.`;
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.toLowerCase();
    if (seen.has(key)) return `"${n}" is in the list twice — pump almost certainly wants them unique.`;
    seen.add(key);
  }
  return null;
}
