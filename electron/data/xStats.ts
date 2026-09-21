// What the Links panel read off a token's X page, kept for the scripts and
// the token page (2026-09-20). Written only by the renderer after a person
// opened the page in the panel's browser view — main never fetches an X
// page itself — and validated at the IPC boundary before it lands here.
// In memory for the session: a follower count is a fact about a moment,
// and the record says when it was read.

import type { XStats } from '@shared/xStats';

export interface XStatsRecord {
  stats: XStats;
  readAt: number;
}

const byMint = new Map<string, XStatsRecord>();
const MAX = 2_000;

export function set(mint: string, stats: XStats, readAt = Date.now()): XStatsRecord {
  const rec = { stats, readAt };
  byMint.set(mint, rec);
  if (byMint.size > MAX) {
    const oldest = byMint.keys().next().value;
    if (oldest !== undefined) byMint.delete(oldest);
  }
  return rec;
}

export function get(mint: string): XStatsRecord | null {
  return byMint.get(mint) ?? null;
}

/** Test seam. */
export function _reset(): void {
  byMint.clear();
}
