// Auto-swap USDC to SOL — the decision, pure.
//
// WHY. pump.fun pays callout rewards in USDC, into whichever of the user's
// wallets made the call. The terminal trades in SOL, every one of its safety
// rails is written in SOL, and the only thing a user could do with that USDC
// was press "Swap to SOL" on the rewards panel or send it out. Most did
// neither, and the balance sat there (2026-09-27: 1.64 USDC in the main
// wallet, sold by hand a day later). Swapping it for the user is what a SOL
// terminal should do — and the swap goes through the same path as the Swap
// page, so Krypt's fee is billed on it like on every other swap.
//
// This file decides WHETHER one wallet's USDC is swapped now. The runner
// (electron/engine/usdcSweep.ts) reads balances and calls the swap; nothing
// here touches a network or a clock, so the rules are unit-tested.
//
// The rules:
//   • off by setting → never (a user who holds USDC on purpose turns it off);
//   • live not armed → never (the swap needs the signer; paper has nothing
//     to swap with, and a disarmed app must not start moving money);
//   • below USDC_SWEEP_MIN_USDC → never (a swap smaller than that pays more
//     in fees than it returns, and quotes for dust fail anyway);
//   • one attempt per wallet per USDC_SWEEP_COOLDOWN_MS, success or failure —
//     a failing swap must not be retried every pass;
//   • never while an attempt for that wallet is in flight.

/** Smallest balance worth a swap, in USDC. */
export const USDC_SWEEP_MIN_USDC = 0.25;
/** After any attempt on a wallet, the earliest next attempt. */
export const USDC_SWEEP_COOLDOWN_MS = 10 * 60_000;
/** How often every wallet's USDC is read when nothing prompted a pass. */
export const USDC_SWEEP_POLL_MS = 5 * 60_000;
/** A holdings change asks for a pass; several in a row are one pass. */
export const USDC_SWEEP_KICK_DEBOUNCE_MS = 3_000;

export interface SweepWalletState {
  /** When this wallet was last swept (attempted), or null. */
  lastAttemptAt: number | null;
  inFlight: boolean;
}

export type SweepDecision = { swap: true } | { swap: false; why: 'off' | 'not live' | 'in flight' | 'cooldown' | 'below minimum' | 'unknown balance' };

/**
 * Whether ONE wallet's USDC is swapped on this pass.
 *
 * `usdc` is the balance in USDC, or null when it could not be read — unknown
 * never swaps (there is nothing to size the swap by) and never counts as an
 * attempt (the cooldown is for swaps sent, not for reads that failed).
 */
export function sweepDecision(
  usdc: number | null,
  state: SweepWalletState,
  opts: { enabled: boolean; live: boolean; now: number },
): SweepDecision {
  if (!opts.enabled) return { swap: false, why: 'off' };
  if (!opts.live) return { swap: false, why: 'not live' };
  if (state.inFlight) return { swap: false, why: 'in flight' };
  if (state.lastAttemptAt !== null && opts.now - state.lastAttemptAt < USDC_SWEEP_COOLDOWN_MS) return { swap: false, why: 'cooldown' };
  if (usdc === null || !Number.isFinite(usdc)) return { swap: false, why: 'unknown balance' };
  if (usdc < USDC_SWEEP_MIN_USDC) return { swap: false, why: 'below minimum' };
  return { swap: true };
}

/** USDC has six decimals. */
export function usdcFromRaw(raw: bigint): number {
  return Number(raw) / 1e6;
}
