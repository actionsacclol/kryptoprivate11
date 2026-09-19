// DexScreener's profile and boost routes — keyless, and on a host this app
// already contacts and already discloses in the privacy policy.
//
//   GET /token-profiles/latest/v1   newly-filled token profiles: socials, CTO
//   GET /token-boosts/latest/v1     who is paying for placement, and how much
//
// Both verified 200 and keyless on 2026-09-19 (30 rows each; 17 and 19 of them
// Solana). Documented limit on this host is 60 requests/minute for these
// routes — far more than a panel a user opens needs.
//
// The boost route is the interesting one. DexScreener sells Boosts, reported
// at roughly $3,999 per 24 hours; its own FAQ says trending "is not for sale".
// The purchase counts are public, so the app can simply name them. No score,
// no accusation, no warning icon — the number someone spent, attributed to
// the place they spent it.

import { getJson, memo } from '../http';
import { parseBoosts, parseProfiles, HUB_CHAINS, type BoostedToken, type TokenProfile } from '@shared/wire';

/**
 * Two minutes.
 *
 * These lists turn over in minutes, not seconds, and the panel is something a
 * user opens rather than watches. Both calls share the provider's existing
 * per-host budget and park, so a parked DexScreener degrades this panel and
 * nothing else.
 */
const TTL_MS = 120_000;

/** Null = the call failed. `[]` = it answered and there are none. The panel
 *  says different things about those two and has to be able to tell. */
export async function boostedTokens(): Promise<BoostedToken[] | null> {
  return memo<BoostedToken[]>('wire:boosts', TTL_MS, async () => {
    const r = await getJson<unknown>('dexscreener', '/token-boosts/latest/v1');
    if (!r.ok || r.data === undefined) return null;
    return parseBoosts(r.data, [...HUB_CHAINS]);
  });
}

export async function tokenProfiles(): Promise<TokenProfile[] | null> {
  return memo<TokenProfile[]>('wire:profiles', TTL_MS, async () => {
    const r = await getJson<unknown>('dexscreener', '/token-profiles/latest/v1');
    if (!r.ok || r.data === undefined) return null;
    return parseProfiles(r.data, [...HUB_CHAINS]);
  });
}
