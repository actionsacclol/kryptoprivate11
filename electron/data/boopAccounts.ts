// Boop bonding-curve state, read from the chain.
//
// Same job as launchLabAccounts.ts / dbcAccounts.ts: exact curve progress for
// the Graduating column, one `getMultipleAccounts` for a whole page.
//
// ─── Layout, established by measurement ───────────────────────────────
//
// The pool account is 125 bytes and its address is `["bonding_curve", mint]`
// — derivable, so a mint needs no lookup. Offsets confirmed across 14 live
// pools on 2026-08-24:
//
//   40   mint            pubkey   (matched the mint from the trade event)
//   72   virtualSol      u64      30 SOL on a fresh curve
//   80   virtualTokens   u64      1e18
//   88   solTarget       u64      86 SOL — READ, never hardcoded
//   96   migrationFee?   u64      6 SOL, constant across every pool seen
//   104  realSol         u64      progress numerator
//   112  tokenReserves   u64      the price divisor
//
// The reserve fields were not guessed. Pricing the curve as
// `(virtualSol + realSol) / tokenReserves` reproduced GeckoTerminal's quoted
// USD price within 5-8% on 5 of 6 pools — close enough to confirm the field
// identities, with the gap explained by fees and last-trade staleness.
//
// `solTarget` is read per pool rather than assumed, because a hardcoded
// migration threshold is the trap that has already cost this codebase a
// feature: measured DBC thresholds spanned five orders of magnitude.

import { base58Encode } from '../chain/base58';
import { getMultipleAccountsRaw } from '../chain/rpcClient';
import { boopPoolFor } from '../chain/addresses';
import { BOOP_PROGRAM } from '../engine/boopDecoder';

export { BOOP_PROGRAM };

/** Every Boop curve account seen was exactly this size. */
const POOL_LEN = 125;

const OFF = {
  mint: 40,
  virtualSol: 72,
  virtualTokens: 80,
  solTarget: 88,
  realSol: 104,
  tokenReserves: 112,
} as const;

/** Boop tokens are 9-decimal (1e18 supply at 9dp = 1e9 tokens). The account
 *  does not carry decimals, so this is the documented assumption — stated
 *  rather than hidden, and only used for display maths. */
export const BOOP_DECIMALS = 9;

export interface BoopPoolState {
  pool: string;
  mint: string;
  virtualSol: bigint;
  virtualTokens: bigint;
  realSol: bigint;
  tokenReserves: bigint;
  solTarget: bigint;
  /** 0..100, or null when the pool reports no target to divide by. */
  progressPct: number | null;
  /** Spot price in lamports per whole token, or null. */
  priceLamports: number | null;
}

/** Pure — exported for tests. */
export function parsePoolAccount(pool: string, data: Buffer): BoopPoolState | null {
  if (data.length !== POOL_LEN) return null;
  try {
    const virtualSol = data.readBigUInt64LE(OFF.virtualSol);
    const realSol = data.readBigUInt64LE(OFF.realSol);
    const tokenReserves = data.readBigUInt64LE(OFF.tokenReserves);
    const solTarget = data.readBigUInt64LE(OFF.solTarget);
    const progressPct =
      solTarget > 0n ? Math.max(0, Math.min(100, Number((realSol * 10_000n) / solTarget) / 100)) : null;
    const price =
      tokenReserves > 0n
        ? (Number(virtualSol + realSol) / Number(tokenReserves)) * 10 ** BOOP_DECIMALS
        : null;
    return {
      pool,
      mint: base58Encode(data.subarray(OFF.mint, OFF.mint + 32)),
      virtualSol,
      virtualTokens: data.readBigUInt64LE(OFF.virtualTokens),
      realSol,
      tokenReserves,
      solTarget,
      progressPct,
      priceLamports: price !== null && Number.isFinite(price) ? price : null,
    };
  } catch {
    return null;
  }
}

/** The curve account for a mint. Derived — `["bonding_curve", mint]`. */
export function poolFor(mint: string): string {
  return boopPoolFor(mint, BOOP_PROGRAM);
}

/**
 * Curve state for many MINTS at once.
 *
 * Takes mints rather than pools because the pool is derivable, which is the
 * whole convenience of this rail: a Discover row already has the mint.
 */
export async function progressForMints(httpUrl: string, mints: string[]): Promise<Map<string, BoopPoolState>> {
  const out = new Map<string, BoopPoolState>();
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return out;

  const poolToMint = new Map<string, string>();
  for (const mint of unique) {
    try {
      poolToMint.set(poolFor(mint), mint);
    } catch {
      /* an unparseable mint from a provider — skip it */
    }
  }
  if (!poolToMint.size) return out;

  const res = await getMultipleAccountsRaw(httpUrl, [...poolToMint.keys()]);
  if (!res.ok || !res.data) return out;
  for (const [pool, data] of res.data) {
    const state = parsePoolAccount(pool, data);
    // The account must agree with the mint we derived it from; a mismatch
    // means the layout moved, and a wrong mint on a Discover row is a wrong
    // token to click.
    const expected = poolToMint.get(pool);
    if (!state || (expected && state.mint !== expected)) continue;
    out.set(state.mint, state);
  }
  return out;
}
