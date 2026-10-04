// The All-in-One FLOAT (2026-10-03): money kept ready on each chain so a buy
// there needs no conversion — the one honest way to pay for speed on these
// chains (shared/aioSpeed.ts says why fees cannot). Pure: what to move.
//
// The owner's rules:
//   · Off by default; the user names the dollar amount.
//   · Every refill is an ordinary move between chains — Relay's cost plus
//     Krypt's 0.5 %, like the Move card. The float is a convenience the user
//     pays for, not a free bridge.
//   · Never on a guess: an unread balance or price moves nothing.
//   · Never drains the source: it keeps its own float and its reserve.
//   · Slow and bounded: one refill per chain per cooldown, a daily cap, and
//     the scheduler stops itself after repeated failures.

import type { AioChain } from './aio';

/** A chain is refilled once it holds less than this share of the target. */
export const FLOAT_REFILL_BELOW = 0.5;
/** Relay refuses below ~$5, and its fixed cost is most of a tiny move. */
export const FLOAT_MIN_MOVE_USD = 5;
/** Per destination chain, between refills. */
export const FLOAT_COOLDOWN_MS = 10 * 60_000;
/** Refills in a rolling day, across every chain. */
export const FLOAT_MAX_PER_DAY = 8;
/** Consecutive failed refills before the scheduler stops itself. */
export const FLOAT_MAX_FAILURES = 3;

export interface FloatChainState {
  chain: AioChain;
  /** Native balance, in the chain's coin. Null = unread. */
  held: number | null;
  /** The coin's dollar price. Null = unknown. */
  priceUsd: number | null;
  /** The chain's own reserve, in its coin (aioConvert CHAIN_RESERVE). */
  reserve: number;
}

export interface FloatMove {
  from: AioChain;
  to: AioChain;
  /** Dollars to move, and the same in the SOURCE coin. */
  usd: number;
  amountFrom: number;
}

/**
 * The next refill, or null. One at a time: the chain furthest below target
 * is refilled from the chain holding the most, by just enough to bring it
 * back to the target — and only when the source can spare that while
 * keeping its own target and reserve.
 */
export function nextFloatRefill(chains: FloatChainState[], targetUsd: number): FloatMove | null {
  if (!(targetUsd >= FLOAT_MIN_MOVE_USD)) return null;
  // Every chain must be read: a refill decided on a partial picture could
  // pick the wrong source, or refill a chain that is actually fine.
  if (chains.length < 2 || chains.some((c) => c.held === null || c.priceUsd === null || !(c.priceUsd > 0))) return null;
  const usd = (c: FloatChainState): number => (c.held as number) * (c.priceUsd as number);
  const source = [...chains].sort((a, b) => usd(b) - usd(a))[0]!;
  const short = chains
    .filter((c) => c.chain !== source.chain && usd(c) < targetUsd * FLOAT_REFILL_BELOW)
    .sort((a, b) => usd(a) - usd(b))[0];
  if (!short) return null;
  const want = targetUsd - usd(short);
  if (want < FLOAT_MIN_MOVE_USD) return null;
  const sourceSpare = usd(source) - targetUsd - source.reserve * (source.priceUsd as number);
  if (want > sourceSpare) return null;
  return { from: source.chain, to: short.chain, usd: want, amountFrom: want / (source.priceUsd as number) };
}
