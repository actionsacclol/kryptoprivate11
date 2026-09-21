// A Discover row from a Raydium pool the engine saw created — our own
// observation, no provider involved.
//
// The Migrated column is provider-fed: pump.fun's own `complete` feed plus
// GeckoTerminal's `new_pools`, which indexes a pool some minutes after it
// exists and is rate-limited on top. The engine now hears every Raydium
// AMM v4 and CPMM creation off the websocket the moment it lands, and reads
// the pool's own account for its mints and reserves. That is a row: a mint,
// a pool, a price from the reserves, the SOL in it, and when we saw it.
//
// Same rules as shared/liveRows.ts: nothing the chain did not say is
// invented. There is no name, no image, no volume on a pool that is four
// seconds old, so those stay empty until a provider fills them in, and a
// pool with no SOL side has no SOL price — an em dash, not a number.

import { emptySummary, type TokenSummary } from './market';

export type RaydiumPoolKind = 'amm-v4' | 'cpmm';

/** One pool creation as the engine recorded it. */
export interface LiveAmmPool {
  kind: RaydiumPoolKind;
  pool: string;
  /** The token: the side opposite SOL, or opposite USDC/USDT. A pool with
   *  neither is not recorded at all — see raydiumWatcher.baseSide. */
  mint: string;
  decimals: number;
  /** The other side. Wrapped SOL for every pool this rail prices. */
  quoteMint: string;
  /** False for a USDC/USDT-quoted pool, whose reserves are not lamports. */
  solQuoted: boolean;
  /** Reserve ratio at creation, SOL per whole token. Null when unpriceable. */
  priceSol: number | null;
  /** SOL in the pool at creation. Null when there is no SOL side. */
  solInPool: number | null;
  /** When the creation reached us, ms. */
  detectedAt: number;
  signature: string;
}

/**
 * One live pool as a Discover row.
 *
 * `createdAt` is `detectedAt` — when the creation reached us, which trails
 * the block by the feed's latency and is otherwise the pool's birth. The
 * row says it is migrated (`bondingCurvePct` 100) because that is what the
 * Migrated column means by a new AMM pool, whoever launched the token;
 * a token that never had a curve reads the same as one that finished it.
 */
export function summaryFromPool(p: LiveAmmPool, solUsd: number | null): TokenSummary {
  const row = emptySummary(p.mint);
  row.launchpad = 'raydium';
  row.dexId = 'raydium';
  row.decimals = p.decimals;
  row.createdAt = p.detectedAt;
  row.poolAddress = p.pool;
  row.poolQuoteMint = p.quoteMint;
  row.priceSol = p.priceSol;
  row.priceUsd = p.priceSol !== null && solUsd !== null ? p.priceSol * solUsd : null;
  // Both sides of a constant-product pool are worth the same, so the SOL
  // side doubled is the pool's liquidity — the same arithmetic every
  // aggregator reports for these pools.
  row.liquidityUsd = p.solInPool !== null && solUsd !== null ? p.solInPool * 2 * solUsd : null;
  row.bondingCurvePct = 100;
  row.liveTracked = true;
  row.sources = { price: 'engine', liquidity: 'engine' };
  row.fetchedAt = Date.now();
  return row;
}

/**
 * Merge live pools into a map of provider rows, in place.
 *
 * A mint the providers already returned keeps their richer row (image,
 * socials, volume) and takes the live pool address when theirs is missing;
 * one they have not listed yet becomes a row of its own. Returns how many
 * the engine contributed that no provider had.
 */
export function mergeLivePools(byMint: Map<string, TokenSummary>, pools: LiveAmmPool[], solUsd: number | null, maxAgeMs: number): number {
  const now = Date.now();
  let added = 0;
  for (const p of pools) {
    if (!p.mint) continue;
    if (now - p.detectedAt > maxAgeMs) continue;
    const have = byMint.get(p.mint);
    if (have) {
      if (have.poolAddress === null) {
        have.poolAddress = p.pool;
        have.poolQuoteMint = p.quoteMint;
      }
      if (have.createdAt === null) have.createdAt = p.detectedAt;
      have.liveTracked = true;
      continue;
    }
    byMint.set(p.mint, summaryFromPool(p, solUsd));
    added += 1;
  }
  return added;
}
