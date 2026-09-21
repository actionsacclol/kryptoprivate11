// Telegram members and the website's domain record for a token, asked of
// main by mint (2026-09-20). Main derives the links from its own facts and
// does the lookups; the renderer never sends a URL. One answer per token
// per minute is plenty — the numbers move slowly and main caches anyway —
// so a settled answer is reused across the header, the Links tab and the
// Links panel without asking again.

import { useEffect, useState } from 'react';
import type { LinkIntel } from '@shared/linkIntel';

const cache = new Map<string, { value: LinkIntel; at: number }>();
const FRESH_MS = 60_000;

const settled = (x: LinkIntel): boolean =>
  (!x.telegram || x.telegram.state === 'ok' || x.telegram.state === 'failed') && (!x.website || x.website.state === 'ok' || x.website.state === 'failed');

/** The token's lookups: what main knows now, refreshed once when stale or unsettled. */
export function useLinkIntel(mint: string | null): LinkIntel | null {
  const [value, setValue] = useState<LinkIntel | null>(() => (mint ? cache.get(mint)?.value ?? null : null));
  useEffect(() => {
    if (!mint) {
      setValue(null);
      return;
    }
    let alive = true;
    const hit = cache.get(mint);
    setValue(hit?.value ?? null);
    if (hit && hit.at > Date.now() - FRESH_MS && settled(hit.value)) return;
    void (async () => {
      try {
        const r = await window.krypt.links.intel(mint, true);
        if (!alive || !r.ok || !r.data) return;
        cache.set(mint, { value: r.data, at: Date.now() });
        setValue(r.data);
      } catch {
        /* the surfaces say nothing was looked up */
      }
    })();
    return () => {
      alive = false;
    };
  }, [mint]);
  return value;
}
