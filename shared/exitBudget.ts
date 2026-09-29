// What an exit is allowed to spend on speed.
//
// A sell's priority fee and landing tips are OPTIONAL extras that buy
// placement in a block. They are charged like this:
//
//   • the base fee and the priority fee are taken when the transaction is
//     LOADED, before any instruction runs — so the wallet must already hold
//     them;
//   • tips are ordinary transfers appended AFTER the swap, so the proceeds
//     of the sell pay for those.
//
// That first point is what stranded a real position on 2026-09-05: the sell
// path floors the priority fee at 0.002 SOL, the wallet held 0.00167, and
// every attempt died with InsufficientFundsForFee before the swap could put
// SOL back. The extras made the exit impossible — which is exactly backwards,
// because someone with almost no SOL left is precisely who needs to get out.
//
// So an exit is budgeted against the balance: pay the base fee, keep a small
// margin, and spend whatever is left (up to what was asked) on priority. When
// even that is out of reach, go out bare rather than not at all.

/** Solana's per-signature base fee. One signer here. */
export const BASE_FEE_LAMPORTS = 5_000;
/** Left untouched so a rounding error cannot make the fee unpayable. */
export const FEE_MARGIN_LAMPORTS = 2_000;
/**
 * Below this free balance an exit stops paying for placement altogether:
 * tips are dropped and the priority fee is whatever the margin allows.
 */
export const LEAN_EXIT_LAMPORTS = 10_000_000; // 0.01 SOL

export interface ExitBudget {
  /** What to actually pay for priority, in lamports. */
  priorityLamports: number;
  /** Whether to attach landing tips at all. */
  useTips: boolean;
  /** Set when the plan was cut back, for the log and the user. */
  note: string | null;
  /** True when even the base fee cannot be covered — the sell will fail. */
  hopeless: boolean;
}

/**
 * Fit an exit to the wallet.
 *
 * `balanceLamports` is what the wallet holds now; `requestedPriorityLamports`
 * is what the fee policy would like to spend. Nothing here can make a sell
 * fail that would otherwise have worked: the result is always ≤ what was
 * asked for.
 */
export function planExitBudget(balanceLamports: number, requestedPriorityLamports: number): ExitBudget {
  const balance = Number.isFinite(balanceLamports) && balanceLamports > 0 ? Math.floor(balanceLamports) : 0;
  const wanted = Number.isFinite(requestedPriorityLamports) && requestedPriorityLamports > 0 ? Math.floor(requestedPriorityLamports) : 0;

  if (balance <= BASE_FEE_LAMPORTS) {
    return {
      priorityLamports: 0,
      useTips: false,
      note: `only ${(balance / 1e9).toFixed(6)} SOL in the wallet — not even the network fee is covered`,
      hopeless: true,
    };
  }

  const spendable = balance - BASE_FEE_LAMPORTS - FEE_MARGIN_LAMPORTS;
  // Comfortable balance: pay what was asked, keep the tips.
  if (balance >= LEAN_EXIT_LAMPORTS && wanted <= spendable) {
    return { priorityLamports: wanted, useTips: true, note: null, hopeless: false };
  }

  const priority = Math.max(0, Math.min(wanted, spendable));
  const cutPriority = priority < wanted;
  const note =
    balance < LEAN_EXIT_LAMPORTS
      ? `low SOL (${(balance / 1e9).toFixed(4)}) — exit sent lean: no landing tips${cutPriority ? `, priority fee ${(priority / 1e9).toFixed(6)} SOL instead of ${(wanted / 1e9).toFixed(6)}` : ''}`
      : cutPriority
        ? `priority fee trimmed to ${(priority / 1e9).toFixed(6)} SOL so the exit fits the balance`
        : null;
  return { priorityLamports: priority, useTips: false, note, hopeless: false };
}

// ── The other half: never spend the exit money in the first place ─────

/**
 * Held back from every buy so the resulting position can always be sold.
 *
 * A sell has to pay a base fee and a priority fee before the swap runs, and
 * usually opens or closes a token account too. 0.01 SOL covers that with
 * room to spare, and is small enough that holding it back does not change
 * anyone's trade.
 */
export const EXIT_RESERVE_LAMPORTS = 10_000_000;
/** What the BUY itself costs beyond the amount swapped: priority fee, base
 *  fee, landing tips and the token account's rent. */
export const BUY_OVERHEAD_LAMPORTS = 5_000_000;

export interface BuyPlan {
  /** What to actually buy with, in lamports. Zero means do not trade. */
  lamports: number;
  /** Set when the size was reduced or refused. */
  note: string | null;
  /** True when the wallet cannot fund any buy that leaves an exit. */
  refused: boolean;
}

/**
 * Fit a buy to the wallet, keeping enough behind to sell the position again.
 *
 * This is not the per-trade cap (that bounds unattended execution and does
 * not apply to a click). It is arithmetic: spending the last of the SOL
 * leaves a token that cannot be sold, which is how a real position was
 * stranded on 2026-09-05.
 */
export function planBuySize(
  balanceLamports: number,
  requestedLamports: number,
  /**
   * `minShare`: refuse rather than shrink when less than this share of the
   * requested size is affordable. An UNATTENDED buy (a script's, an order's)
   * sets it — on 2026-09-28 a script asked for 0.0151 SOL and the last of a
   * drained wallet bought 0.0063 without the script being told, a bag too
   * small to call and stopped out at −100 %. A click keeps the trim: the
   * user is looking at the toast.
   */
  opts: { minShare?: number } = {},
): BuyPlan {
  const balance = Number.isFinite(balanceLamports) && balanceLamports > 0 ? Math.floor(balanceLamports) : 0;
  const wanted = Number.isFinite(requestedLamports) && requestedLamports > 0 ? Math.floor(requestedLamports) : 0;
  if (wanted <= 0) return { lamports: 0, note: null, refused: true };

  const affordable = balance - EXIT_RESERVE_LAMPORTS - BUY_OVERHEAD_LAMPORTS;
  if (affordable <= 0) {
    const need = (EXIT_RESERVE_LAMPORTS + BUY_OVERHEAD_LAMPORTS) / 1e9;
    return {
      lamports: 0,
      note: `${(balance / 1e9).toFixed(4)} SOL is not enough to buy and still afford to sell — this wallet needs about ${need.toFixed(3)} SOL before a trade.`,
      refused: true,
    };
  }
  if (wanted <= affordable) return { lamports: wanted, note: null, refused: false };
  if (opts.minShare !== undefined && affordable < wanted * opts.minShare) {
    return {
      lamports: 0,
      note: `Only ${(affordable / 1e9).toFixed(4)} of the ${(wanted / 1e9).toFixed(4)} SOL asked for is affordable once ${((EXIT_RESERVE_LAMPORTS + BUY_OVERHEAD_LAMPORTS) / 1e9).toFixed(3)} SOL is held back to sell again — refused rather than shrunk below ${Math.round(opts.minShare * 100)}% of its size.`,
      refused: true,
    };
  }
  return {
    lamports: affordable,
    note: `Buying ${(affordable / 1e9).toFixed(4)} SOL instead of ${(wanted / 1e9).toFixed(4)} — the rest is held back so you can pay to sell this again.`,
    refused: false,
  };
}

// ── What a small trade cannot afford (2026-09-28) ─────────────────────
//
// Read from one night's ledger: 50 script buys of 0.013–0.02 SOL paid the
// two priority-fee FLOORS below on every round trip — 0.003 SOL, 19 % of the
// bag before slippage — and network fees were 0.18 of the 0.34 SOL lost.
// A trade that must move +19 % to hand the money back is not a trade a
// script should be allowed to make on its own.

/** The priority-fee floors every Solana trade pays (engine.priorityFeeSolFor). */
export const PRIORITY_FEE_FLOOR_SOL = { buy: 0.001, sell: 0.002 } as const;
/** An unattended buy is refused rather than shrunk below this share of its size. */
export const UNATTENDED_MIN_FILL_SHARE = 0.8;
/** The most of an unattended buy the two floors may take, round trip. */
export const MAX_UNATTENDED_FEE_SHARE = 0.1;

// ── Fee lanes (2026-09-29) ──────────────────────────────────────────────
//
// The floors above are a LANDING-SPEED choice: they buy a place near the
// front of a contested slot, and a sniper or a stop needs that. A script that
// sells on a five-minute timer does not. Measured the same day:
//   • the farm's 95 round trips lost 0.693 SOL; the priority fee was 50 % of
//     it, tips 8 %, the price move only 36 %;
//   • 64 sampled pump curve trades on 09-16 paid a median 32,110 lamports of
//     priority (0.000032 SOL) — 84 % paid less than our 0.001 buy floor, and
//     70 % sent no tip at all — and they landed;
//   • the app's own transactions consume a median 85.7k CU (buy) and 55.1k
//     (sell + close) under a 120k limit.
// 'lean' prices the compute unit from the live estimate with NO floor, sends
// no Jito / Helius tip and uses the public lane only. A lean sell that fails
// to land is retried ONCE on the fast lane: an exit is never left stuck to
// save a fee. Stops, orders, rug exits and every button stay on 'fast'.

export type FeeLane = 'fast' | 'lean';
export const FEE_LANES: readonly FeeLane[] = ['fast', 'lean'];

/** A lean compute-unit price, micro-lamports per CU: never under this (09-16:
 *  the p25 of landed pump trades was 66,667, the median 82,017)… */
export const LEAN_MIN_MICRO_PER_CU = 50_000;
/** …never over this, whatever the estimate says (a wild estimate is not a
 *  reason to pay fast-lane prices on the slow lane)… */
export const LEAN_MAX_MICRO_PER_CU = 500_000;
/** …and this when there is no estimate at all. */
export const LEAN_DEFAULT_MICRO_PER_CU = 100_000;
/** The compute budget a lean fee is judged against in the guards: PumpSwap's
 *  minimum limit (the curve's is 120k), so the guard is never optimistic. */
export const LEAN_GUARD_CU = 250_000;

/** A lean priority fee in SOL, from the estimate's median (null = none). */
export function leanPriorityFeeSol(p50MicroPerCu: number | null | undefined, computeUnitLimit: number): number {
  const raw = typeof p50MicroPerCu === 'number' && Number.isFinite(p50MicroPerCu) && p50MicroPerCu > 0 ? p50MicroPerCu : LEAN_DEFAULT_MICRO_PER_CU;
  const micro = Math.min(LEAN_MAX_MICRO_PER_CU, Math.max(LEAN_MIN_MICRO_PER_CU, raw));
  const cu = Number.isFinite(computeUnitLimit) && computeUnitLimit > 0 ? computeUnitLimit : 120_000;
  // micro-lamports × CU = micro-lamports; /1e6 → lamports; /1e9 → SOL.
  return (micro * cu) / 1e15;
}

/** The execution settings a lean trade is sent with: no tips, public lane. */
export function leanExec<T extends { useJito: boolean; useHeliusSender: boolean; mevMode?: string }>(exec: T): T {
  return { ...exec, useJito: false, useHeliusSender: false, mevMode: 'off' };
}

/** The most a lane's priority fees can cost on a buy and a sell, in SOL. */
export function laneRoundTripPrioritySol(lane: FeeLane = 'fast'): number {
  if (lane === 'lean') return 2 * leanPriorityFeeSol(LEAN_MAX_MICRO_PER_CU, LEAN_GUARD_CU);
  return PRIORITY_FEE_FLOOR_SOL.buy + PRIORITY_FEE_FLOOR_SOL.sell;
}

/** The share of `sol` a lane's priority fees take on a buy and a sell. */
export function roundTripFeeShare(sol: number, lane: FeeLane = 'fast'): number {
  if (!Number.isFinite(sol) || sol <= 0) return Infinity;
  return laneRoundTripPrioritySol(lane) / sol;
}

/** The smallest buy an unattended caller may make on Solana: 0.03 SOL on
 *  the fast lane, 0.0025 SOL on the lean one. */
export function minUnattendedBuySol(lane: FeeLane = 'fast'): number {
  return Math.round((laneRoundTripPrioritySol(lane) / MAX_UNATTENDED_FEE_SHARE) * 1e4) / 1e4;
}

/** Mean Jito / Helius tip per side, measured on the farm's fills (09-29). */
export const MEAN_TIP_SOL = { buy: 0.000056, sell: 0.000438 } as const;

/**
 * The fixed SOL a real trade of this lane pays on one side — priority, the
 * base signature fee and (fast lane) the mean tip — for a PAPER fill to
 * charge. Paper used to charge only 1.5 % a side, so a paper record of a
 * 0.02 SOL script showed none of the ~17 % the floors cost it live.
 */
export function paperFixedFeeSol(lane: FeeLane, side: 'buy' | 'sell'): number {
  const base = BASE_FEE_LAMPORTS / 1e9;
  if (lane === 'lean') return leanPriorityFeeSol(null, 120_000) + base;
  return PRIORITY_FEE_FLOOR_SOL[side] + MEAN_TIP_SOL[side] + base;
}

/**
 * Should an unattended sell be held back as dust?
 *
 * True when the estimate is KNOWN and under the priority fee the sell would
 * pay: five stop-loss sells on 2026-09-28 returned less SOL than they cost
 * to send. An unknown estimate never holds a sell back — a stale or missing
 * price must not become a blocked exit — and a hand sell never asks.
 */
export function shouldHoldAsDust(estProceedsLamports: number | null | undefined, priorityFeeLamports: number): boolean {
  if (estProceedsLamports === null || estProceedsLamports === undefined || !Number.isFinite(estProceedsLamports)) return false;
  if (!Number.isFinite(priorityFeeLamports) || priorityFeeLamports <= 0) return false;
  return estProceedsLamports < priorityFeeLamports;
}

/**
 * Plain English for the failures this situation produces. Solana reports
 * both as opaque codes, and "InstructionError: [2, {Custom: 1}]" tells a
 * user nothing about what to do next.
 */
export function explainFeeFailure(errText: string, balanceLamports: number | null): string | null {
  const bal = balanceLamports === null ? null : balanceLamports / 1e9;
  const topUp = 'Send a little SOL to this wallet (0.01 is plenty) and try again.';
  if (/InsufficientFundsForFee/i.test(errText)) {
    return `Not enough SOL to pay the network fee${bal === null ? '' : ` — the wallet holds ${bal.toFixed(6)} SOL`}. ${topUp}`;
  }
  // System program error 1 is ResultWithNegativeLamports: a transfer in the
  // transaction would take the balance below zero.
  if (/"Custom":\s*1\b/.test(errText) && /InstructionError/.test(errText)) {
    return `A transfer in this trade would spend more SOL than the wallet holds${bal === null ? '' : ` (${bal.toFixed(6)} SOL)`}. ${topUp}`;
  }
  // pump.fun's own revert codes, read from its on-chain IDL (2026-09-10).
  // Anchor logs the name, but a relayer-built transaction often gives us the
  // bare code — and "Custom: 6025" tells nobody anything.
  const pump = errText.match(/"Custom":\s*(60(?:2[0-9]|30))(?![0-9])/);
  if (pump) {
    const named: Record<string, string> = {
      '6020': 'Buy zero amount',
      '6021': 'Not enough tokens to buy',
      '6022': 'Sell zero amount',
      '6023': 'Not enough tokens to sell',
      '6024': 'Overflow',
      '6025': 'Truncation',
      '6026': 'Division by zero',
    };
    const code = pump[1];
    // 6022 and 6025 are the same story from two directions: the amount is too
    // small for the curve to price. That is almost always a bag that is
    // already gone or down to dust, not a broken order.
    if (code === '6022' || code === '6023' || code === '6025') {
      return `Nothing left to sell — pump rejected the amount (${named[code]}). The position is gone or too small for the curve to price.`;
    }
    if (named[code]) return `pump rejected this trade: ${named[code]} (${code}).`;
  }
  return null;
}
