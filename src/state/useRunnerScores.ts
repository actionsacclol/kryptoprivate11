// Krypt scores for runner flags — asked for once per mint, shared by every
// surface that lists flags.
//
// A flag is a launch a minute or two old, and the score is the token page's
// (liquidity, Shield sellability, the creator's record, a pump ban), which
// needs providers that may not know the token yet. So a row can honestly
// show "—" for a while and fill in on the next look. Module-level cache:
// the Runners tab and the Launches section must not each fetch the same
// mint, and a flag re-rendering every ten seconds must not refetch at all.

import { useEffect, useState } from 'react';

interface Entry {
  score: number | null;
  at: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
/** A null (not scoreable yet) is retried after this; a number is kept for the
 *  flag's lifetime — the inputs move slowly and a flag lives fifteen minutes. */
const RETRY_NULL_MS = 60_000;
const MAX_CONCURRENT = 3;

function notify(): void {
  for (const fn of listeners) fn();
}

async function fetchScore(mint: string): Promise<void> {
  inFlight.add(mint);
  try {
    const r = await window.krypt.market.summary(mint);
    cache.set(mint, { score: r.ok && r.data ? r.data.kryptScore : null, at: Date.now() });
  } catch {
    cache.set(mint, { score: null, at: Date.now() });
  } finally {
    inFlight.delete(mint);
    notify();
  }
}

function wanted(mints: string[], force: boolean): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const m of mints) {
    if (inFlight.has(m)) continue;
    const e = cache.get(m);
    if (!e) out.push(m);
    else if (force || (e.score === null && now - e.at > RETRY_NULL_MS)) out.push(m);
  }
  return out;
}

/**
 * Scores for `mints`, by mint. `undefined` = not asked yet, `null` = asked and
 * not scoreable. `refreshKey` changing re-asks for every listed mint (the
 * page's Refresh button).
 */
export function useRunnerScores(mints: string[], refreshKey: number): Record<string, number | null | undefined> {
  const [, bump] = useState(0);
  const key = mints.join(',');
  useEffect(() => {
    const fn = (): void => bump((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    const todo = wanted(key ? key.split(',') : [], false);
    // Newest flags first (the list is newest first), a few at a time: the
    // summary is memoised main-side, but a cold one costs provider calls.
    const run = async (): Promise<void> => {
      const queue = [...todo];
      const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
        while (queue.length) {
          const m = queue.shift();
          if (m) await fetchScore(m);
        }
      });
      await Promise.all(workers);
    };
    if (todo.length) void run();
  }, [key]);
  useEffect(() => {
    if (!refreshKey) return;
    const todo = wanted(key ? key.split(',') : [], true);
    if (todo.length) void Promise.all(todo.slice(0, 8).map(fetchScore));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const out: Record<string, number | null | undefined> = {};
  for (const m of mints) out[m] = cache.get(m)?.score;
  return out;
}
