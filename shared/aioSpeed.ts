// All-in-One speed tiers (2026-10-03). Pure: what each tier changes.
//
// The research swarm's finding, which these numbers keep honest: on these
// chains a FEE buys very little time. Solana's priority fee is fractions of
// a cent; BNB sits at its gas floor; Robinhood (an Arbitrum chain) ignores
// tips entirely. The free speed fixes (parallel quotes, parallel reads,
// rebroadcast, the user's fast RPC) apply to every tier. What a tier moves:
//
//   · the Solana deposit's priority fee (the fee estimator's percentiles),
//   · BNB gas (Fast doubles it — still about a tenth of a cent),
//   · how often a top-up's arrival is checked, and how long a buy waits for
//     it before giving up (the money still lands; the buy is just not made
//     on a price that may have moved).
//
// The one honest "pay more for speed" is the FLOAT (shared/aioFloat.ts):
// money kept ready on each chain so a buy needs no conversion at all.

export type AioSpeed = 'cheap' | 'normal' | 'fast';
export const AIO_SPEEDS: AioSpeed[] = ['cheap', 'normal', 'fast'];
export const AIO_SPEED_LABEL: Record<AioSpeed, string> = { cheap: 'Cheapest', normal: 'Normal', fast: 'Fast' };

/** What each tier does, in a line, for the setting's own description. */
export const AIO_SPEED_NOTE: Record<AioSpeed, string> = {
  cheap: 'Lowest network fees. Top-ups are checked every second and a buy waits up to 2 minutes for one.',
  normal: 'Market-rate fees. Top-ups are checked every 0.3 s; a buy waits up to 90 s.',
  fast: 'Top priority fee on Solana and double gas on BNB (still under a cent). A buy waits at most 45 s for its top-up.',
};

/** A Relay deposit used 13,701 CU when measured; the limit is paid in full,
 *  used or not, so it sits a little over twice that. */
export const SOLANA_DEPOSIT_CU_LIMIT = 30_000;

export interface FeePercentiles {
  p50: number;
  p75: number;
  p90: number;
}

/** Compute-unit price (micro-lamports) for a Solana deposit at this tier. */
export function solanaDepositPrice(speed: AioSpeed, est: FeePercentiles | null): number {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));
  if (speed === 'cheap') return clamp(est?.p50 ?? 10_000, 10_000, 200_000);
  if (speed === 'fast') return clamp(est?.p90 ?? 200_000, 200_000, 2_000_000);
  return clamp(Math.max(50_000, est?.p75 ?? 50_000), 50_000, 500_000);
}

/** Multiplier on an EVM deposit's fee fields. Robinhood ignores tips, so
 *  paying more there buys nothing — it is never raised. */
export function evmFeeMultiplier(speed: AioSpeed, chain: 'bnb' | 'robinhood'): number {
  return speed === 'fast' && chain === 'bnb' ? 2 : 1;
}

/** How often a top-up's arrival is checked. */
export function arrivalPollMs(speed: AioSpeed): number {
  return speed === 'cheap' ? 1_000 : speed === 'fast' ? 200 : 300;
}

/** How long a buy waits for its top-up before it is not placed. */
export function abandonAfterMs(speed: AioSpeed): number {
  return speed === 'cheap' ? 120_000 : speed === 'fast' ? 45_000 : 90_000;
}

export function isAioSpeed(v: unknown): v is AioSpeed {
  return v === 'cheap' || v === 'normal' || v === 'fast';
}
