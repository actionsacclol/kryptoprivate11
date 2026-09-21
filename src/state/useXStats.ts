// The last X-page read for a token, shared between the Links panel (which
// writes it) and the token page header (which shows "12.3K followers").
//
// localStorage, because the panel may be popped out into its own window and
// the `storage` event is the cheapest cross-window signal there is (the same
// reasoning as panels/chartToken.ts). The record says when it was read; a
// number from an hour ago is still shown, with its age, rather than hidden.

import { useEffect, useState } from 'react';
import type { XStats } from '@shared/xStats';

export interface XStatsEntry {
  stats: XStats;
  readAt: number;
}

const KEY = 'krypt.links.xstats.v1';
const EVENT = 'krypt:xstats';
const MAX = 300;

function loadAll(): Record<string, XStatsEntry> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, XStatsEntry>) : {};
  } catch {
    return {};
  }
}

export function loadXStats(mint: string): XStatsEntry | null {
  const e = loadAll()[mint];
  return e && typeof e.readAt === 'number' && e.stats ? e : null;
}

export function saveXStats(mint: string, stats: XStats): XStatsEntry {
  const entry = { stats, readAt: Date.now() };
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

/** The token's last read, live across writes from this or another window. */
export function useXStats(mint: string | null): XStatsEntry | null {
  const [entry, setEntry] = useState<XStatsEntry | null>(() => (mint ? loadXStats(mint) : null));
  useEffect(() => {
    setEntry(mint ? loadXStats(mint) : null);
    if (!mint) return;
    const refresh = (): void => setEntry(loadXStats(mint));
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
