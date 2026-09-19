// One callouts feed, however many things are watching it.
//
// The rail, the widget and a token page can all be open at once. Each one
// polling on its own timer would be three IPC calls a tick for one answer, so
// the feed lives here instead: a module-level store with subscribers, one
// timer that runs only while at least one component is mounted, and a single
// `lastCheckedAt` everything reports the same way.
//
// This is a cache of somebody else's opinions, not state the app has to be
// correct about, so it is deliberately NOT persisted. A fresh window shows a
// loading row for one tick rather than yesterday's calls dressed as current.

import { useEffect, useState } from 'react';
import type { ChainKind } from '@shared/evm';
import { derivedMultiple, type Callout } from '@shared/callouts';

/** Matches the provider's own TTL in main — polling faster only re-serves the
 *  same memoised answer and spends the lane's budget doing it. */
const POLL_MS = 30_000;

export interface CalloutsState {
  rows: Callout[];
  /** Null until the first answer. `[]` means pump answered and there are
   *  none; the two must not look the same. */
  answered: boolean;
  /** Why the last attempt failed, if it did. Kept alongside the old rows: a
   *  feed that just went unreachable should keep showing what it last knew
   *  AND say that it is stale. */
  error: string | null;
  lastCheckedAt: number | null;
  loading: boolean;
}

let state: CalloutsState = { rows: [], answered: false, error: null, lastCheckedAt: null, loading: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit(next: Partial<CalloutsState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

async function refresh(): Promise<void> {
  // A slow answer must not stack up behind itself on a 30 s timer.
  if (inFlight) return;
  inFlight = true;
  emit({ loading: true });
  try {
    const r = await window.krypt.callouts.feed();
    if (r.ok && r.data) {
      emit({ rows: r.data, answered: true, error: null, lastCheckedAt: Date.now(), loading: false });
    } else {
      // Keep the rows. An unreachable feed is not an empty one.
      emit({ error: r.message || 'Callouts are not answering', lastCheckedAt: Date.now(), loading: false });
    }
  } catch {
    emit({ error: 'Callouts are not answering', lastCheckedAt: Date.now(), loading: false });
  } finally {
    inFlight = false;
  }
}

/** Force a re-read now — the panel's refresh button. */
export function refreshCallouts(): void {
  void refresh();
}

/**
 * Subscribe to the feed.
 *
 * `active` is what starts and stops the polling: a collapsed rail and a panel
 * nobody has switched on must not hold a timer open. The feed fetches on the
 * first active subscriber and the timer is cleared when the last one goes.
 */
export function useCallouts(active = true): CalloutsState {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!active) return;
    const fn = (): void => bump((n) => n + 1);
    listeners.add(fn);
    if (timer === null) {
      timer = setInterval(() => void refresh(), POLL_MS);
      void refresh();
    } else if (state.lastCheckedAt === null) {
      void refresh();
    }
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [active]);

  return state;
}

export interface CoinCallouts {
  rows: Callout[];
  answered: boolean;
  loading: boolean;
}

/**
 * The calls on ONE coin, from pump's per-coin route.
 *
 * Separate from the feed on purpose. The feed only carries coins pump is
 * currently surfacing, so a coin that was called an hour ago is simply not
 * in it — and "no calls in the feed" is not the same statement as "nobody
 * has called this coin". This route answers the second one.
 *
 * It fetches once per (mint, chain) while `active`, and main memoises it for
 * two minutes on top of that: opening the same chart repeatedly costs one
 * request, not one per open.
 */
export function useCoinCallouts(
  mint: string | null,
  chain: ChainKind | null,
  active: boolean,
  /** The symbol the workspace already knows for this token, used when the
   *  market summary has not got one. */
  fallbackSymbol: string | null = null,
): CoinCallouts {
  const [state, setState] = useState<CoinCallouts>({ rows: [], answered: false, loading: false });

  useEffect(() => {
    if (!active || !mint || !chain) {
      setState({ rows: [], answered: false, loading: false });
      return;
    }
    // A late answer for the coin you just navigated away from must not
    // overwrite the one you are looking at now.
    let live = true;
    setState({ rows: [], answered: false, loading: true });
    void (async () => {
      try {
        // `/callout/top` serves neither the coin's symbol nor its market cap
        // now, so on its own every row read as an address with an em dash
        // where the multiple goes (user report, 2026-09-18). The app already
        // knows both, from the same summary every other panel uses — so the
        // multiple here is DERIVED from our own market cap against the one
        // pump recorded at the call, exactly as the feed's is, rather than
        // from pump's per-coin `multiple`, which is the field measured
        // disagreeing with itself.
        const [r, sum] = await Promise.all([
          window.krypt.callouts.forMint(mint, chain),
          chain === 'solana'
            ? window.krypt.market.summary(mint).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!live) return;
        if (r.ok && r.data) {
          const t = sum && sum.ok ? (sum.data ?? null) : null;
          const symbol = t?.symbol || fallbackSymbol;
          const mcapNow = t?.marketCapUsd ?? null;
          const rows = r.data.map((c) => ({
            ...c,
            symbol: symbol ?? c.symbol,
            name: t?.name ?? c.name,
            mcapUsdNow: mcapNow,
            multiple: derivedMultiple(c.calledAtMcapUsd, mcapNow),
          }));
          setState({ rows, answered: true, loading: false });
        } else {
          setState({ rows: [], answered: false, loading: false });
        }
      } catch {
        if (live) setState({ rows: [], answered: false, loading: false });
      }
    })();
    return () => {
      live = false;
    };
  }, [mint, chain, active, fallbackSymbol]);

  return state;
}
