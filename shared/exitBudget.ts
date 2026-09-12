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
export function planBuySize(balanceLamports: number, requestedLamports: number): BuyPlan {
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
  return {
    lamports: affordable,
    note: `Buying ${(affordable / 1e9).toFixed(4)} SOL instead of ${(wanted / 1e9).toFixed(4)} — the rest is held back so you can pay to sell this again.`,
    refused: false,
  };
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
