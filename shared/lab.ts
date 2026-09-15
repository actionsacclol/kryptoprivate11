// Wallet Lab — multi-wallet utilities: fund a group of your own wallets from
// the active one, and collect back from it.
//
// Every real transaction still goes through the signer's policy and the trade
// pipeline (simulation, loss guard, platform fee, confirm socket); nothing
// here is a shortcut. Pure module: the engine and the page share these types
// and validators, and tests pin the planners.

// ── Funding ───────────────────────────────────────────────────────────

export const LAMPORTS_PER_SOL = 1_000_000_000;
/** What a fresh system account needs to exist at all. */
export const RENT_EXEMPT_LAMPORTS = 890_880;
/** Kept back on the source wallet for the transfer fee and its own rent. */
export const FUND_HEADROOM_LAMPORTS = 1_500_000;
/** One fund call moves at most this much in total (20 wallets × 5 SOL). */
export const MAX_FUND_BATCH_LAMPORTS = 100 * LAMPORTS_PER_SOL;
/** Per-wallet ceiling for one fund transfer; the handler enforces the same. */
export const MAX_FUND_PER_WALLET_SOL = 50;
/** The IPC caps one call at this many wallets; the pages disable above it. */
export const MAX_LAB_WALLETS_PER_CALL = 20;

export interface FundTarget {
  walletId: string;
  publicKey: string;
  sol: number;
}

export interface FundPlan {
  ok: boolean;
  message: string;
  targets: FundTarget[];
  totalLamports: number;
}

/**
 * Split `totalSol` across `wallets` ('total' mode) or give each `perSol`
 * ('each' mode), bounded by the source balance. Every target must end up
 * rent-exempt or the whole transaction reverts.
 */
export function planFund(
  wallets: Array<{ walletId: string; publicKey: string }>,
  mode: 'each' | 'total',
  sol: number,
  sourceBalanceSol: number | null,
): FundPlan {
  if (!wallets.length) return { ok: false, message: 'No wallets selected', targets: [], totalLamports: 0 };
  if (!(sol > 0) || !Number.isFinite(sol)) return { ok: false, message: 'Amount must be positive', targets: [], totalLamports: 0 };
  const per = mode === 'each' ? sol : sol / wallets.length;
  if (per > MAX_FUND_PER_WALLET_SOL) {
    return { ok: false, message: `At most ${MAX_FUND_PER_WALLET_SOL} SOL per wallet`, targets: [], totalLamports: 0 };
  }
  const perLamports = Math.floor(per * LAMPORTS_PER_SOL);
  if (perLamports < RENT_EXEMPT_LAMPORTS) {
    return { ok: false, message: `Each wallet needs at least ${(RENT_EXEMPT_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6)} SOL to exist (rent)`, targets: [], totalLamports: 0 };
  }
  const totalLamports = perLamports * wallets.length;
  if (totalLamports > MAX_FUND_BATCH_LAMPORTS) {
    return { ok: false, message: `Fund at most ${MAX_FUND_BATCH_LAMPORTS / LAMPORTS_PER_SOL} SOL per batch`, targets: [], totalLamports: 0 };
  }
  if (sourceBalanceSol !== null) {
    const available = Math.floor(sourceBalanceSol * LAMPORTS_PER_SOL) - FUND_HEADROOM_LAMPORTS;
    if (totalLamports > available) {
      return {
        ok: false,
        message: `Total ${(totalLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL exceeds what the source can send (${Math.max(0, available / LAMPORTS_PER_SOL).toFixed(4)} SOL after rent and fee headroom)`,
        targets: [],
        totalLamports: 0,
      };
    }
  }
  return {
    ok: true,
    message: `${wallets.length} wallet${wallets.length === 1 ? '' : 's'} × ${(perLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
    targets: wallets.map((w) => ({ walletId: w.walletId, publicKey: w.publicKey, sol: perLamports / LAMPORTS_PER_SOL })),
    totalLamports,
  };
}
