// pump.fun Callouts — keyless, read-only, and never on the trade path.
//
// Two routes on the host this app already talks to
// (`frontend-api-v3.pump.fun`, declared once in http.ts and in the privacy
// policy's source list):
//
//   GET /home-feed          the global feed — every live callout, all chains,
//                           each with the CALLER'S OWN POSITION in the coin.
//   GET /callout/top/{mint} the calls on one coin.
//
// What is NOT available keyless, checked 2026-09-18 so nobody spends an
// afternoon rediscovering it: `/callout/leaderboard`, `/callout/leaderboard-
// stats/{userId}` and `/callout/eligibility/{mint}` all answer 401. pump's own
// caller ranking is behind a login, which is fine — a leaderboard the app can
// compute from wallets it already watches is worth more than one it copies.
//
// The feed is ~290 KB and arrives whole: `limit` is accepted and ignored
// (measured — asking for 5 returned 148). So it is fetched once, parsed down
// to compact rows in main, and only the rows cross IPC. It is also RANKED, not
// chronological; `newestFirst` is applied by the caller that wants time order.

import { getJson, memo } from '../http';
import { parseCoinCallouts, parseHomeFeed, type Callout } from '@shared/callouts';
import type { ChainKind } from '@shared/evm';

/**
 * How long a fetched feed is reused.
 *
 * 30 s is the point where a panel someone is watching feels live without the
 * app becoming a poller: at 2 calls a minute against a 60/60 s route it is
 * 3% of the budget, and the `pumpfun:callout` lane caps the whole feature at
 * 20 anyway. Several open panels share this one cached answer — `memo` also
 * collapses concurrent misses into a single fetch, which is what stops a rail
 * and a widget opened together from making two.
 */
const FEED_TTL_MS = 30_000;

/** A coin's own callouts change far more slowly than the global feed, and this
 *  one is fetched per token the user opens. */
const COIN_TTL_MS = 120_000;

/**
 * Why the last read failed, in the HTTP layer's own words.
 *
 * `memo` caches a VALUE, so a failure has to come back as null - which
 * threw away a precise message ("pumpfun: rate limited, retrying in 20s")
 * and left the panel saying "not answering", which is the difference
 * between a user waiting twenty seconds and a user filing a bug. Kept here
 * and read by the IPC handler right after the call.
 */
let lastError: string | null = null;

export function lastCalloutError(): string | null {
  return lastError;
}

/**
 * The global callouts feed.
 *
 * Returns null when the call failed — distinct from `[]`, which means pump
 * answered and there are none. The panel says different things about those two
 * and must be able to tell them apart (the "polite refusal" bug class: a 200
 * that means no is not the same as no answer).
 */
export async function calloutFeed(): Promise<Callout[] | null> {
  return memo<Callout[]>('callouts:feed', FEED_TTL_MS, async () => {
    const r = await getJson<unknown>('pumpfun', '/home-feed', { lane: 'callout' });
    if (!r.ok || r.data === undefined) {
      lastError = r.message || null;
      return null;
    }
    lastError = null;
    return parseHomeFeed(r.data);
  });
}

/** The callouts on one coin. Null = the call failed; [] = none. */
export async function calloutsForMint(mint: string, chain: ChainKind): Promise<Callout[] | null> {
  const key = `callouts:mint:${chain}:${mint}`;
  return memo<Callout[]>(key, COIN_TTL_MS, async () => {
    const r = await getJson<unknown>('pumpfun', `/callout/top/${encodeURIComponent(mint)}`, { lane: 'callout' });
    if (!r.ok || r.data === undefined) {
      lastError = r.message || null;
      return null;
    }
    lastError = null;
    return parseCoinCallouts(r.data, mint, chain);
  });
}
