// Wallet Lab — multi-wallet utilities (2026-09-03): fund a group of your own
// wallets from the active one, have a group FOLLOW the active wallet's
// manual trades, and run RANDOM trading on a group under a hard loss cap.
//
// Every real transaction still goes through the signer's policy and the
// trade pipeline (simulation, loss guard, platform fee, confirm socket);
// nothing here is a shortcut. Pure module: the engine and the page share
// these types and validators, and tests pin the planners.

export interface FollowSettings {
  enabled: boolean;
  /** Random delay before each follower repeats the trade. */
  delayMinMs: number;
  delayMaxMs: number;
  /** 'ratio' = a multiple of the active wallet's SOL size; 'fixed' = fixedSol. */
  sizeMode: 'ratio' | 'fixed';
  ratio: number;
  fixedSol: number;
  /** Hard cap per follower buy, SOL. */
  maxTradeSol: number;
  /** Also repeat the active wallet's sells, at the same share of the follower's bag. */
  followSells: boolean;
}

export interface RandomSettings {
  enabled: boolean;
  /** Which Discover column supplies candidates. */
  universe: 'trending' | 'graduating' | 'new';
  minLiquidityUsd: number;
  tradeSolMin: number;
  tradeSolMax: number;
  holdSecMin: number;
  holdSecMax: number;
  gapSecMin: number;
  gapSecMax: number;
  maxOpenPerWallet: number;
  /** Stop the run once realised PnL on CLOSED trades since start is at or
   *  below −maxLossSol; bags still held count at cost, not as a loss. */
  maxLossSol: number;
  maxTradesPerHour: number;
}

export interface LabGroupConfig {
  follow: FollowSettings;
  random: RandomSettings;
}

export const DEFAULT_FOLLOW: FollowSettings = {
  enabled: false,
  delayMinMs: 1_500,
  delayMaxMs: 8_000,
  sizeMode: 'ratio',
  ratio: 0.5,
  fixedSol: 0.01,
  maxTradeSol: 0.05,
  followSells: true,
};

export const DEFAULT_RANDOM: RandomSettings = {
  enabled: false,
  universe: 'trending',
  minLiquidityUsd: 20_000,
  tradeSolMin: 0.005,
  tradeSolMax: 0.02,
  holdSecMin: 60,
  holdSecMax: 600,
  gapSecMin: 30,
  gapSecMax: 300,
  maxOpenPerWallet: 1,
  maxLossSol: 0.05,
  maxTradesPerHour: 12,
};

export function defaultGroupConfig(): LabGroupConfig {
  return { follow: { ...DEFAULT_FOLLOW }, random: { ...DEFAULT_RANDOM } };
}

const num = (v: unknown, lo: number, hi: number, name: string): string | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${name} must be a number`;
  if (v < lo || v > hi) return `${name} must be between ${lo} and ${hi}`;
  return null;
};

export function validateFollow(f: FollowSettings): { ok: boolean; message: string } {
  if (typeof f.enabled !== 'boolean') return { ok: false, message: 'enabled must be true or false' };
  if (typeof f.followSells !== 'boolean') return { ok: false, message: 'followSells must be true or false' };
  const checks = [
    num(f.delayMinMs, 0, 120_000, 'delayMinMs'),
    num(f.delayMaxMs, 0, 120_000, 'delayMaxMs'),
    num(f.ratio, 0.01, 5, 'ratio'),
    num(f.fixedSol, 0.001, 5, 'fixedSol'),
    num(f.maxTradeSol, 0.001, 5, 'maxTradeSol'),
  ].filter((m): m is string => m !== null);
  if (checks.length) return { ok: false, message: checks[0] };
  if (f.delayMaxMs < f.delayMinMs) return { ok: false, message: 'delayMaxMs must be ≥ delayMinMs' };
  if (f.sizeMode !== 'ratio' && f.sizeMode !== 'fixed') return { ok: false, message: 'sizeMode must be ratio or fixed' };
  return { ok: true, message: 'ok' };
}

export function validateRandom(r: RandomSettings): { ok: boolean; message: string } {
  if (typeof r.enabled !== 'boolean') return { ok: false, message: 'enabled must be true or false' };
  const checks = [
    num(r.minLiquidityUsd, 0, 1e9, 'minLiquidityUsd'),
    num(r.tradeSolMin, 0.001, 5, 'tradeSolMin'),
    num(r.tradeSolMax, 0.001, 5, 'tradeSolMax'),
    num(r.holdSecMin, 5, 86_400, 'holdSecMin'),
    num(r.holdSecMax, 5, 86_400, 'holdSecMax'),
    num(r.gapSecMin, 5, 86_400, 'gapSecMin'),
    num(r.gapSecMax, 5, 86_400, 'gapSecMax'),
    num(r.maxOpenPerWallet, 1, 10, 'maxOpenPerWallet'),
    num(r.maxLossSol, 0.001, 100, 'maxLossSol'),
    num(r.maxTradesPerHour, 1, 240, 'maxTradesPerHour'),
  ].filter((m): m is string => m !== null);
  if (checks.length) return { ok: false, message: checks[0] };
  if (r.tradeSolMax < r.tradeSolMin) return { ok: false, message: 'tradeSolMax must be ≥ tradeSolMin' };
  if (r.holdSecMax < r.holdSecMin) return { ok: false, message: 'holdSecMax must be ≥ holdSecMin' };
  if (r.gapSecMax < r.gapSecMin) return { ok: false, message: 'gapSecMax must be ≥ gapSecMin' };
  if (!['trending', 'graduating', 'new'].includes(r.universe)) return { ok: false, message: 'universe must be trending, graduating or new' };
  return { ok: true, message: 'ok' };
}

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

// ── Random runner ─────────────────────────────────────────────────────

export interface RandomOpen {
  walletId: string;
  mint: string;
  symbol: string;
  boughtAt: number;
  sellAt: number;
  /** What the buy cost the wallet (simulated delta, else the size sent); the
   *  bag is carried at this until its sell lands. */
  costSol: number | null;
  /** Failed sell attempts so far; after the cap the bag is handed to the user by name. */
  tries?: number;
}

export interface RandomRunStatus {
  groupId: string;
  /** Wallet ids this run is limited to; null = every member but the active wallet. */
  walletIds: string[] | null;
  running: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  stopReason: string | null;
  buys: number;
  sells: number;
  failed: number;
  /** Realised SOL on CLOSED trades since start: reconciled cash delta of this
   *  run's fills with open bags added back at cost. Fees and tips included. */
  realizedSol: number;
  maxLossSol: number;
  open: RandomOpen[];
  nextActionAt: number | null;
  lastLine: string | null;
}

/** Uniform pick in [lo, hi]. */
export function between(lo: number, hi: number, rand: () => number = Math.random): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return a + (b - a) * rand();
}

/** Trade size in SOL, 4 decimals, never above what the wallet can spare. */
export function pickTradeSol(r: RandomSettings, walletBalanceSol: number | null, rand: () => number = Math.random): number | null {
  const want = Math.round(between(r.tradeSolMin, r.tradeSolMax, rand) * 10_000) / 10_000;
  if (walletBalanceSol === null) return want;
  const spare = walletBalanceSol - 0.004; // fee, tip, ATA rent, our fee
  if (spare < r.tradeSolMin) return null;
  return Math.min(want, Math.round(spare * 10_000) / 10_000);
}

/** The loss cap is on REALISED PnL of closed trades: a run stops when it has
 *  actually lost the money, never for merely holding what it bought. */
export function lossCapHit(realizedSol: number, maxLossSol: number): boolean {
  return realizedSol <= -Math.abs(maxLossSol);
}
