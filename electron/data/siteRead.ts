// What the Links panel read off a token's own website, kept for the scripts
// and the token page (2026-09-20). Written only by the renderer after a
// person opened the site in the panel's browser view — main never fetches a
// token's website — and validated at the IPC boundary before it lands here.
// The same shape as data/xStats.ts, for the same reasons.

import type { SiteRead } from '@shared/siteRead';

export interface SiteReadRecord {
  read: SiteRead;
  readAt: number;
}

const byMint = new Map<string, SiteReadRecord>();
const MAX = 2_000;

export function set(mint: string, read: SiteRead, readAt = Date.now()): SiteReadRecord {
  const rec = { read, readAt };
  byMint.set(mint, rec);
  if (byMint.size > MAX) {
    const oldest = byMint.keys().next().value;
    if (oldest !== undefined) byMint.delete(oldest);
  }
  return rec;
}

export function get(mint: string): SiteReadRecord | null {
  return byMint.get(mint) ?? null;
}

/** Test seam. */
export function _reset(): void {
  byMint.clear();
}
