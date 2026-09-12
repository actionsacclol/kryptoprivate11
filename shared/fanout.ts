// Fan-out planning — decide how much each wallet buys when several buy the
// same token at once. Pure arithmetic in LAMPORTS, no I/O, no signing.
//
// Two modes, chosen by the user per buy (see the terminal's fan-out panel):
//
//   • 'same'  — every wallet buys the SAME amount. Predictable; the group
//               spends amountSol × walletCount in total.
//   • 'total' — a single total is SPLIT across the wallets. Optionally
//               randomised, so the buys are not identical round numbers that
//               obviously came from one operator. The split always sums back to
//               exactly the total — randomisation moves lamports between
//               wallets, it never creates or loses them.
//
// Everything is computed in lamports (integers) so a split can be guaranteed to
// add up. SOL is only for display.

export type FanoutMode = 'same' | 'total';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface FanoutOptions {
  mode: FanoutMode;
  /** 'same': the amount EACH wallet buys. 'total': the amount to split across
   *  all of them. In SOL. */
  amountSol: number;
  /** 'total' only: jitter each share by up to ±this fraction (0..0.9) before
   *  normalising back to the total. 0 = an even split. */
  jitter?: number;
  /** No wallet may end up below this (SOL). A share that would fall under it is
   *  a planning error, not silently rounded up — an unexpectedly tiny buy is
   *  worse than a refusal. */
  minSol?: number;
}

export interface WalletShare {
  wallet: string;
  lamports: number;
  sol: number;
}

export interface FanoutPlan {
  ok: boolean;
  message: string;
  shares: WalletShare[];
  /** Sum of all shares, in lamports. For 'total' this equals the requested
   *  total exactly; for 'same' it is amount × count. */
  totalLamports: number;
}

const EMPTY: FanoutPlan = { ok: false, message: '', shares: [], totalLamports: 0 };

function toLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

function share(wallet: string, lamports: number): WalletShare {
  return { wallet, lamports, sol: lamports / LAMPORTS_PER_SOL };
}

/**
 * Build the per-wallet buy plan.
 *
 * `rand` is injected (defaults to Math.random) so the randomised split is
 * deterministic in tests. It is only consulted when mode is 'total' and
 * jitter > 0.
 */
export function planFanout(wallets: string[], opts: FanoutOptions, rand: () => number = Math.random): FanoutPlan {
  const uniq = [...new Set(wallets.filter((w) => w && w.trim()))];
  if (uniq.length === 0) return { ...EMPTY, message: 'No wallets selected.' };
  if (!Number.isFinite(opts.amountSol) || opts.amountSol <= 0) {
    return { ...EMPTY, message: 'Amount must be greater than zero.' };
  }
  // Same rule as the jitter below: a non-finite floor would make every
  // comparison against it false, i.e. silently no floor at all.
  const minLamports = toLamports(Math.max(0, Number.isFinite(opts.minSol) ? (opts.minSol as number) : 0));

  if (opts.mode === 'same') {
    const each = toLamports(opts.amountSol);
    if (each < minLamports) {
      return { ...EMPTY, message: `Each buy would be below the ${opts.minSol} SOL minimum.` };
    }
    const shares = uniq.map((w) => share(w, each));
    return { ok: true, message: 'ok', shares, totalLamports: each * uniq.length };
  }

  // mode === 'total'
  const total = toLamports(opts.amountSol);
  if (total < minLamports * uniq.length) {
    return {
      ...EMPTY,
      message: `A ${opts.amountSol} SOL total split across ${uniq.length} wallets would put some below the ${opts.minSol} SOL minimum.`,
    };
  }

  // A non-finite jitter must become 0, not survive the clamp: Math.max/min
  // pass NaN straight through, every weight would then be NaN, and because
  // the remainder loop (`NaN > 0`) and the floor check (`NaN < min`) are both
  // false a plan of NaN shares would be returned as ok. A plan is either
  // arithmetic or a refusal — never a row of NaNs.
  const asked = Number.isFinite(opts.jitter) ? (opts.jitter as number) : 0;
  const jitter = Math.max(0, Math.min(0.9, asked));

  // Weights: 1 (even) or 1±jitter (randomised). Shares are proportional to
  // weight, then rounded to lamports, then the rounding remainder is settled on
  // the largest share so the sum is exactly the total.
  const weights = uniq.map(() => (jitter === 0 ? 1 : 1 - jitter + rand() * 2 * jitter));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let allocated = 0;
  const raw = uniq.map((w, i) => {
    const lamports = Math.floor((total * weights[i]) / weightSum);
    allocated += lamports;
    return { w, lamports };
  });

  // Hand the leftover lamports (0..count-1 of them) to the largest shares, so
  // the total is exact and the remainder never lands on a tiny share.
  let remainder = total - allocated;
  const order = [...raw].sort((a, b) => b.lamports - a.lamports);
  for (let i = 0; remainder > 0; i = (i + 1) % order.length) {
    order[i].lamports += 1;
    remainder -= 1;
  }

  // Enforce the floor after settling — a randomised share could dip under it.
  const below = raw.find((r) => r.lamports < minLamports);
  if (below) {
    return {
      ...EMPTY,
      message: `A randomised share fell below the ${opts.minSol} SOL minimum — lower the jitter or the wallet count.`,
    };
  }

  const shares = raw.map((r) => share(r.w, r.lamports));
  return { ok: true, message: 'ok', shares, totalLamports: total };
}

/** The wallet public keys in a plan, for the caller that signs each buy. */
export function planWallets(plan: FanoutPlan): string[] {
  return plan.shares.map((s) => s.wallet);
}
