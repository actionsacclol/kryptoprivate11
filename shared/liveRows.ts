// A Discover row built from our OWN tape, with no provider involved.
//
// The New column was entirely provider-fed: pump.fun's list, Jupiter's
// recent, two GeckoTerminal listings. All four are rate-limited, so the
// column a user watches most is the one most exposed to a park - and when
// pump throttles, the fastest-moving list in the app stops moving.
//
// Meanwhile the scanner is already decoding every pump.fun create off the
// websocket, sub-second and unmetered, and putting it on the Launches page.
// Those rows carry a mint, a name, a creator, a price from the curve's
// virtual reserves and a live curve percentage. That is most of a card.
//
// So this module turns one into a TokenSummary, and merges it with what the
// providers returned. The effect is a column that fills the instant a token
// is created, keeps filling while pump.fun is throttling, and costs nothing.
//
// What it does NOT do is invent the parts the tape cannot see. There is no
// volume, no holder count, no 5-minute change on a token that is four
// seconds old, so those stay null and render as an em dash until a provider
// fills them in. A row that says "—" is honest; a row that says 0 is not.

import { emptySummary, type TokenSummary } from './market';
import type { LaunchRow } from './types';

/**
 * pump.fun mints a fixed 1,000,000,000 tokens with 6 decimals, every time.
 * It is a property of the launchpad, not of the coin, which is why a market
 * cap can be computed from price alone here and cannot be for a token from
 * anywhere else.
 */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;
const PUMP_DECIMALS = 6;

/**
 * One scanner launch as a Discover row.
 *
 * `createdAt` is `detectedAt` - when the create instruction reached us, not
 * the block time it carries. The two differ by the feed's latency, which is
 * well under a second, and the alternative is a null age on the one column
 * that is entirely about age.
 */
export function summaryFromLaunch(l: LaunchRow, solUsd: number | null): TokenSummary {
  const row = emptySummary(l.mint);
  row.name = l.name;
  row.symbol = l.symbol;
  row.creator = l.creator;
  row.launchpad = 'pumpfun';
  row.decimals = PUMP_DECIMALS;
  row.createdAt = l.detectedAt;
  row.priceSol = l.priceSol > 0 ? l.priceSol : null;
  row.priceUsd = row.priceSol !== null && solUsd !== null ? row.priceSol * solUsd : null;
  if (row.priceUsd !== null) {
    row.marketCapUsd = row.priceUsd * PUMP_TOTAL_SUPPLY;
    row.fdvUsd = row.marketCapUsd;
  }
  row.totalSupply = PUMP_TOTAL_SUPPLY;
  row.circSupply = PUMP_TOTAL_SUPPLY;
  row.bondingCurvePct = l.flow.curveProgressPct;
  row.poolAddress = l.bondingCurve || null;
  row.dexId = 'pumpfun';
  row.liveTracked = true;
  row.sources = { price: 'engine', marketCap: 'engine' };
  row.fetchedAt = Date.now();
  return row;
}

/**
 * Fill a provider row's gaps from the live one, and let the tape win on the
 * two numbers it is genuinely fresher about.
 *
 * The provider row is the richer one - it has the image, the socials, the
 * volume, the audit - so it is the base. But its price and curve percentage
 * are from a poll that may be seconds old, while the tape's are from the
 * last trade we saw. `localise()` in market.ts already takes that position
 * for a token page (`sources.price = 'engine'` whenever the engine tracks
 * the mint); this is the same rule applied to a list row.
 */
export function fillFromLive(providerRow: TokenSummary, live: TokenSummary): TokenSummary {
  const out = { ...providerRow };
  if (live.priceSol !== null) {
    out.priceSol = live.priceSol;
    if (live.priceUsd !== null) out.priceUsd = live.priceUsd;
    out.sources = { ...out.sources, price: 'engine' };
  }
  // Only when the provider has none: pump's own market cap is computed from
  // the same supply but reported by the venue, and overriding a venue's
  // number with our arithmetic gains nothing.
  if (out.marketCapUsd === null && live.marketCapUsd !== null) {
    out.marketCapUsd = live.marketCapUsd;
    out.sources = { ...out.sources, marketCap: 'engine' };
  }
  if (out.fdvUsd === null) out.fdvUsd = live.fdvUsd;
  if (live.bondingCurvePct !== null) out.bondingCurvePct = live.bondingCurvePct;
  if (out.createdAt === null) out.createdAt = live.createdAt;
  if (!out.name) out.name = live.name;
  if (!out.symbol) out.symbol = live.symbol;
  if (out.creator === null) out.creator = live.creator;
  if (out.poolAddress === null) out.poolAddress = live.poolAddress;
  if (out.totalSupply === null) out.totalSupply = live.totalSupply;
  if (out.circSupply === null) out.circSupply = live.circSupply;
  out.liveTracked = true;
  return out;
}

/**
 * Merge live launches into a map of provider rows, in place.
 *
 * Returns the number of mints the tape contributed that no provider had -
 * the number worth knowing, because it is how much of the column would have
 * been missing without the scanner running.
 */
export function mergeLiveLaunches(
  byMint: Map<string, TokenSummary>,
  launches: LaunchRow[],
  solUsd: number | null,
  maxAgeMs: number,
): number {
  const now = Date.now();
  let added = 0;
  for (const l of launches) {
    if (!l.mint) continue;
    if (now - l.detectedAt > maxAgeMs) continue;
    const live = summaryFromLaunch(l, solUsd);
    const have = byMint.get(l.mint);
    if (have) byMint.set(l.mint, fillFromLive(have, live));
    else {
      byMint.set(l.mint, live);
      added += 1;
    }
  }
  return added;
}

/**
 * The launches no provider row covers yet, as rows, newest first.
 *
 * The renderer's half of this. Main merges the tape into the column when a
 * poll asks, which is up to four seconds after a token exists; this fills
 * the gap between polls, in the process that already has the launch feed.
 *
 * It ADDS only. Enriching the rows already on screen would hand every card
 * a new object on every sample, and a memoised grid that re-renders wholesale
 * every second is not smoother than one that waits for the poll - it is the
 * same screen, drawn more often. Enrichment stays where a poll can do it
 * once.
 */
export function newLiveRows(
  existing: Iterable<string>,
  launches: LaunchRow[],
  solUsd: number | null,
  maxAgeMs: number,
): TokenSummary[] {
  const have = new Set(existing);
  const now = Date.now();
  const out: TokenSummary[] = [];
  for (const l of launches) {
    if (!l.mint || have.has(l.mint)) continue;
    if (now - l.detectedAt > maxAgeMs) continue;
    have.add(l.mint);
    out.push(summaryFromLaunch(l, solUsd));
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * The SOL price the rows already imply.
 *
 * Every priced row carries both a SOL and a USD price, so their ratio is a
 * SOL/USD rate the app has already paid for. Asking a provider for it again
 * to label a row that is one second old would spend a request to learn
 * something already on screen.
 */
export function impliedSolUsd(rows: TokenSummary[]): number | null {
  for (const r of rows) {
    if (r.priceSol !== null && r.priceUsd !== null && r.priceSol > 0) return r.priceUsd / r.priceSol;
  }
  return null;
}
