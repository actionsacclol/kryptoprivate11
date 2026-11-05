// Helius credit budget — pure accounting, no I/O.
//
// ─── Why this exists ──────────────────────────────────────────────────
//
// Helius bills websocket traffic by BYTES: 2 credits per 0.1 MB uncompressed.
// Measured 2026-11-04 (see MEASURED_FIREHOSE_PER_HOUR), the launch feed alone is
// about 45,000 credits an hour and the AMM tape about 80,000, so with both on a
// key a 1M-credit monthly allowance lasted one working day.
//
// The comment this replaces estimated 33k pushes/hour, and the version after
// it billed a credit per push (37x too high). An estimate that wrong is worse
// than none: it makes an expensive switch look affordable — or free. So the
// ceiling is now counted rather than assumed, and the app turns the socket
// off by itself when the budget is spent.
//
// This module is the arithmetic; electron/system/heliusBudget.ts persists it
// and the engine feeds it.

export interface CreditUsage {
  /** Credits counted in the current window. */
  used: number;
  /** Ceiling for the window. 0 disables the guard entirely. */
  limit: number;
  /** Epoch ms when the window started. */
  windowStartedAt: number;
  /** Credits billed to websocket traffic (bytes / 51,200), counted separately
   *  so the UI can show what dominates. The field name predates byte billing. */
  wsEvents: number;
  /** HTTP RPC calls billed to the key. */
  httpCalls: number;
  /** Where the credits went. Missing on a count saved by an older version. */
  breakdown?: CreditBreakdown;
}

/** Credits by socket and by RPC method, so "why did it run out" has an answer. */
export interface CreditBreakdown {
  /** Epoch ms this breakdown started. It can be younger than the window. */
  since: number;
  sockets: Record<string, number>;
  methods: Record<string, number>;
}

export function emptyBreakdown(now: number): CreditBreakdown {
  return { since: now, sockets: {}, methods: {} };
}

/** Largest first, sockets and methods together. */
export function breakdownRows(b: CreditBreakdown | undefined): Array<{ label: string; credits: number }> {
  if (!b) return [];
  return [...Object.entries(b.sockets), ...Object.entries(b.methods)]
    .map(([label, credits]) => ({ label, credits }))
    .sort((x, y) => y.credits - x.credits);
}

export function emptyUsage(now: number): CreditUsage {
  return { used: 0, limit: 0, windowStartedAt: now, wsEvents: 0, httpCalls: 0, breakdown: emptyBreakdown(now) };
}

/** Helius bills per calendar month; a 30-day rolling window is close enough
 *  and needs no knowledge of the billing date. */
export const WINDOW_MS = 30 * 24 * 60 * 60_000;

export function windowExpired(u: CreditUsage, now: number): boolean {
  return now - u.windowStartedAt >= WINDOW_MS;
}

/** Roll the window over if it has aged out. Returns the usage to store. */
export function rollWindow(u: CreditUsage, now: number): CreditUsage {
  if (!windowExpired(u, now)) return u;
  return { ...emptyUsage(now), limit: u.limit };
}

export function record(u: CreditUsage, kind: 'ws' | 'http', count: number, label?: string): CreditUsage {
  const n = Math.max(0, Math.floor(count));
  if (!n) return u;
  const next: CreditUsage = {
    ...u,
    used: u.used + n,
    wsEvents: kind === 'ws' ? u.wsEvents + n : u.wsEvents,
    httpCalls: kind === 'http' ? u.httpCalls + n : u.httpCalls,
  };
  if (label && u.breakdown) {
    const field = kind === 'ws' ? 'sockets' : 'methods';
    next.breakdown = {
      ...u.breakdown,
      [field]: { ...u.breakdown[field], [label]: (u.breakdown[field][label] ?? 0) + n },
    };
  }
  return next;
}

/** Sender is free on every Helius plan, so it never counts. */
export function isBilledHeliusUrl(url: string): boolean {
  return /helius/i.test(url) && !/sender\.helius/i.test(url);
}

/** A limit of 0 means "no guard" — the user has a plan that can take it. */
export function overBudget(u: CreditUsage): boolean {
  return u.limit > 0 && u.used >= u.limit;
}

/** 0..100, or null when there is no limit to be a fraction of. */
export function usedPct(u: CreditUsage): number | null {
  if (u.limit <= 0) return null;
  return Math.min(100, (u.used / u.limit) * 100);
}

/**
 * How long the remaining budget lasts at the current rate.
 *
 * Null when there is no limit, nothing has been spent yet, or the window is
 * too young to extrapolate from — an estimate off a two-second sample is the
 * kind of confident nonsense this file exists to stop.
 */
export function hoursRemaining(u: CreditUsage, now: number): number | null {
  if (u.limit <= 0 || u.used <= 0) return null;
  const elapsedMs = now - u.windowStartedAt;
  if (elapsedMs < 60_000) return null;
  const perHour = u.used / (elapsedMs / 3_600_000);
  if (perHour <= 0) return null;
  return Math.max(0, (u.limit - u.used) / perHour);
}

/**
 * Helius websocket billing is BY BYTES, not by push: 2 credits per 0.1 MB of
 * uncompressed payload (verified 2026-08-30). So one credit buys 51,200
 * bytes, and a push costs whatever it weighs — a pump trade notification is
 * ~1.4 KB, about 0.03 credits.
 */
export const FEED_BYTES_PER_CREDIT = 51_200;

/** Fractional credits for a payload — callers accumulate the fraction and
 *  bill whole credits, because `record` floors. */
export function feedCreditsForBytes(bytes: number): number {
  return bytes > 0 ? bytes / FEED_BYTES_PER_CREDIT : 0;
}

/** The launch feed in credits per hour. Bytes on a public socket at `processed`
 *  on 2026-11-04, at Helius's 2 credits per 0.1 MB: 51k over 60 s and 40k over
 *  40 s. Short samples of a stream that moves with the market, so use it as a
 *  size, not a promise. The figure before this was 21k, measured in August. */
export const MEASURED_FIREHOSE_PER_HOUR = 45_000;

/** The AMM tape: 80k over 30 s and 82k over 35 s, same day and method. */
export const MEASURED_AMM_TAPE_PER_HOUR = 80_000;

/** What a given allowance buys at the measured firehose rate, in hours. */
export function firehoseHoursFor(limit: number): number {
  return limit > 0 ? limit / MEASURED_FIREHOSE_PER_HOUR : 0;
}

/** What a Helius launch feed costs, in words, for the switches that turn one on. */
export function feedCostText(limit: number): string {
  const allowance = limit > 0 ? limit : 1_000_000;
  const hours = Math.round(firehoseHoursFor(allowance));
  const rate = MEASURED_FIREHOSE_PER_HOUR.toLocaleString('en-US');
  return `Costs about ${rate} Helius credits an hour while scanning, so ${allowance.toLocaleString('en-US')} credits last about ${hours} hours.`;
}
