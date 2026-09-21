// The last read of a token's own website, shared between the Links panel
// (which writes it) and the token page's Links tab (which shows it). The
// same shape and reasons as useXStats.ts: localStorage for the pop-out
// window, the `storage` event as the cross-window signal, the age shown
// rather than the record hidden.

import { useEffect, useState } from 'react';
import type { SiteRead } from '@shared/siteRead';

export interface SiteReadEntry {
  read: SiteRead;
  readAt: number;
}

const KEY = 'krypt.links.site.v1';
const EVENT = 'krypt:siteread';
const MAX = 300;

function loadAll(): Record<string, SiteReadEntry> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, SiteReadEntry>) : {};
  } catch {
    return {};
  }
}

export function loadSiteRead(mint: string): SiteReadEntry | null {
  const e = loadAll()[mint];
  return e && typeof e.readAt === 'number' && e.read ? e : null;
}

export function saveSiteRead(mint: string, read: SiteRead): SiteReadEntry {
  const entry = { read, readAt: Date.now() };
  try {
    const all = loadAll();
    all[mint] = entry;
    const keys = Object.keys(all);
    if (keys.length > MAX) {
      keys.sort((a, b) => all[a].readAt - all[b].readAt).slice(0, keys.length - MAX).forEach((k) => delete all[k]);
    }
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* the panel still shows what it read this time */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* same-window only; other windows hear `storage` */
  }
  return entry;
}

/** The token's last site read, live across writes from this or another window. */
export function useSiteRead(mint: string | null): SiteReadEntry | null {
  const [entry, setEntry] = useState<SiteReadEntry | null>(() => (mint ? loadSiteRead(mint) : null));
  useEffect(() => {
    setEntry(mint ? loadSiteRead(mint) : null);
    if (!mint) return;
    const refresh = (): void => setEntry(loadSiteRead(mint));
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === KEY) refresh();
    };
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [mint]);
  return entry;
}
