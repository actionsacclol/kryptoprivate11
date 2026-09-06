// Helius credit budget — pure accounting, no I/O.
//
// ─── Why this exists ──────────────────────────────────────────────────
//
// The pump firehose was measured on 2026-08-24 at **780,000 websocket pushes
// per hour** (13,000 in a 60s sample, commitment `processed`). Helius bills
// websocket traffic by BYTES — 2 credits per 0.1 MB uncompressed (checked
// 2026-08-30) — which puts the firehose at ~21,000 credits an hour, so a
// 1M-credit monthly allowance lasts about **two days** of continuous runtime.
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
}

export function emptyUsage(now: number): CreditUsage {
  return { used: 0, limit: 0, windowStartedAt: now, wsEvents: 0, httpCalls: 0 };
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

export function record(u: CreditUsage, kind: 'ws' | 'http', count: number): CreditUsage {
  const n = Math.max(0, Math.floor(count));
  if (!n) return u;
  return {
    ...u,
    used: u.used + n,
    wsEvents: kind === 'ws' ? u.wsEvents + n : u.wsEvents,
    httpCalls: kind === 'http' ? u.httpCalls + n : u.httpCalls,
  };
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

/** Pump firehose in CREDITS per hour under byte billing: ~780,000 pushes an
 *  hour (measured 2026-08-24) at ~1.4 KB each ≈ 1.1 GB/h ÷ 51,200 ≈ 21k.
 *  The constant this replaces billed a credit per push (780k/h) — 37x too
 *  high once the billing unit was checked. */
export const MEASURED_FIREHOSE_PER_HOUR = 21_000;

/** What a given allowance buys at the measured firehose rate, in hours. */
export function firehoseHoursFor(limit: number): number {
  return limit > 0 ? limit / MEASURED_FIREHOSE_PER_HOUR : 0;
}
