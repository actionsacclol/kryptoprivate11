// Volume farming — the preset, and the arithmetic that says whether it pays.
//
// WHAT THIS IS. Some programmes pay on measured activity rather than on being
// early: volume traded, fills, days active. Farming one means generating that
// activity deliberately, on a coin chosen for DEPTH rather than for direction,
// because depth is what makes a round trip cost nothing.
//
// ─── Rebuilt 2026-09-14, on measurements, twice over ──────────────────
//
// The first version of this file priced farming on a graduated pump.fun pool
// and guessed the fees. Two things then got measured and both moved the answer
// by orders of magnitude:
//
//  1. The volume-edge swarm (docs/volume-edge-swarm-2026-09-14.md) measured the
//     real PumpSwap floor at 2.3-3.4% a round trip — and on a FRESH pool
//     ~1.20%/side, because pump's coin-creator fee is highest when a pool is
//     new. Farming a memecoin is hopeless and the old defaults said otherwise.
//  2. Quoting Jupiter's actual routes, a WSOL->USDC->WSOL round trip costs
//     0.000-0.007% at 0.5-100 SOL. SOL/USDT and SOL/JitoSOL are the same.
//     That is 200-400x cheaper. The universe was the whole problem.
//
// So this file now prices ESTABLISHED pairs, and it takes the friction as a
// MEASURED input rather than modelling it. `frictionPctPerRoundTrip` comes
// from a real quote pair (quote WSOL->M for S, quote M->WSOL for what came
// back; 1 - back/S is the entire friction: spread, both impacts, both LP fees,
// in one unbiased number). Splitting that into a "pool fee" and a "slippage"
// term would be inventing detail the probe does not have and the first version
// got both of those numbers wrong.
//
// ─── Gas is the binding cost, and it inverts the design ───────────────
//
// Friction is a PERCENTAGE and gas is a FIXED amount per transaction, so at
// small size gas is everything:
//
//     0.5 SOL/trip -> 1.21%      10 SOL -> 0.061%      100 SOL -> 0.010%
//
// Farming wants FEW LARGE round trips on the deepest pair, not many small ones.
// The old preset defaulted to 0.25 SOL on a memecoin, which is the worst
// available configuration on both axes.
//
// ─── Whose fee, and why there are three answers ───────────────────────
//
// The app charges FEE_BPS (0.5%/side) on ordinary trades and FARM_FEE_BPS
// (0.05%/side) on farming round trips. Which applies changes the answer
// completely, so `feeBpsPerSide` is explicit and the UI prices all three:
//
//   * owner, own treasury  -> 0 bps. The fee is a wash: it leaves one pocket
//     and arrives in another. Real cost is friction + gas only. Note this can
//     never be PROFITABLE on its own — paying yourself is not income — it just
//     makes the volume nearly free.
//   * user, farming        -> FARM_FEE_BPS. 0.10% a round trip.
//   * user, ordinary rate  -> FEE_BPS. 1.00% a round trip, which needs a
//     programme paying more than 1% of volume. Nothing pays that. This is the
//     number that made the feature impossible before the farm rate existed.

import { FARM_FEE_BPS, FEE_BPS } from './fees';

export { FARM_FEE_BPS, FEE_BPS };

/** Fee applied to a farming round trip, in percent per side. */
export const FARM_FEE_PCT_PER_SIDE = FARM_FEE_BPS / 100;
/** The ordinary trading fee, for the comparison the UI draws. */
export const FULL_FEE_PCT_PER_SIDE = FEE_BPS / 100;

/** Who is paying, which decides whether the app's fee is a cost at all. */
export type FarmPayer = 'owner' | 'user';

export interface VolumeFarmPreset {
  /** Off until someone turns it on, and it ships off. */
  enabled: boolean;
  /** The token traded against WSOL. Empty while the preset is only planned. */
  mint: string;
  /** Human label for the pair, for the UI. */
  symbol: string;
  /** Notional per round trip, in SOL. BIGGER IS CHEAPER — gas is fixed per
   *  transaction, so this is the single most important field on the page. */
  tradeSol: number;
  /** Seconds held before the position is closed again. */
  holdSec: number;
  /** Seconds between one round trip finishing and the next starting. */
  gapSec: number;
  /** Hard stop: give up once this much SOL has actually been spent. A BUDGET,
   *  not a stop-loss — the spend is the point. */
  budgetSol: number;
  /**
   * The whole market friction of one round trip, percent, MEASURED.
   *
   * `1 - back/out` from a quote pair. Never guessed: the guessed version of
   * this number was wrong by 200x. Until a probe has run, this is null and
   * every derived figure is null with it.
   */
  frictionPctPerRoundTrip: number | null;
  /** Priority fee + signature cost per transaction, in SOL. Two per round
   *  trip, and at small size this dominates everything else. */
  gasSolPerTx: number;
  /** Who pays the app's fee — see FarmPayer. */
  payer: FarmPayer;
}

/**
 * The shipped preset. Sized where gas has stopped mattering (10 SOL is
 * 0.06%; 100 SOL is 0.01%) but not so large that a first run is frightening.
 * No mint: the coin is the user's choice and the probe has to run on it.
 */
export const DEFAULT_VOLUME_FARM: VolumeFarmPreset = {
  enabled: false,
  mint: '',
  symbol: '',
  tradeSol: 10,
  holdSec: 20,
  gapSec: 10,
  budgetSol: 1,
  frictionPctPerRoundTrip: null,
  gasSolPerTx: 0.00301,
  payer: 'user',
};

export interface FarmProjection {
  tripsPerHour: number;
  /** Two per round trip — what a programme counting TRADES counts. */
  fillsPerHour: number;
  /** Both legs — what a programme counting VOLUME counts. */
  volumeSolPerHour: number;
  /** Null until the friction has been measured. Never a guess. */
  costSolPerHour: number | null;
  appFeeSolPerHour: number;
  frictionSolPerHour: number | null;
  gasSolPerHour: number;
  /** The number that decides everything. Null until measured. */
  costPctOfVolume: number | null;
  budgetHours: number | null;
  volumeSolForBudget: number | null;
}

export function projectFarming(p: VolumeFarmPreset): FarmProjection {
  const cycleSec = Math.max(1, p.holdSec + p.gapSec);
  const tripsPerHour = 3600 / cycleSec;
  const fillsPerHour = tripsPerHour * 2;
  const volumeSolPerHour = tripsPerHour * Math.max(0, p.tradeSol) * 2;

  // The app's fee is charged per SIDE, so it applies to the whole volume.
  const feePctPerSide = p.payer === 'owner' ? 0 : FARM_FEE_PCT_PER_SIDE;
  const appFeeSolPerHour = (volumeSolPerHour * feePctPerSide) / 100;
  const gasSolPerHour = fillsPerHour * Math.max(0, p.gasSolPerTx);

  // Friction is per ROUND TRIP, not per side — the probe measures the pair.
  const f = p.frictionPctPerRoundTrip;
  const measured = f !== null && Number.isFinite(f);
  const frictionSolPerHour = measured ? (tripsPerHour * Math.max(0, p.tradeSol) * (f as number)) / 100 : null;

  const costSolPerHour = frictionSolPerHour === null ? null : appFeeSolPerHour + frictionSolPerHour + gasSolPerHour;
  const costPctOfVolume =
    costSolPerHour === null || volumeSolPerHour <= 0 ? null : (costSolPerHour / volumeSolPerHour) * 100;
  const budgetHours = costSolPerHour === null || costSolPerHour <= 0 ? null : p.budgetSol / costSolPerHour;
  const volumeSolForBudget = budgetHours === null ? null : budgetHours * volumeSolPerHour;

  return {
    tripsPerHour,
    fillsPerHour,
    volumeSolPerHour,
    costSolPerHour,
    appFeeSolPerHour,
    frictionSolPerHour,
    gasSolPerHour,
    costPctOfVolume,
    budgetHours,
    volumeSolForBudget,
  };
}

/** What a programme must pay, as a percent of volume traded, to break even.
 *  Null when the friction has not been measured — the honest answer is then
 *  "we do not know yet", never a number. */
export function requiredRewardPct(proj: FarmProjection): number | null {
  return proj.costPctOfVolume;
}

/** Net, as a percent of volume, if a programme pays `rewardPct` of volume.
 *  Positive means the farming pays for itself and then some. */
export function netPctOfVolume(proj: FarmProjection, rewardPct: number): number | null {
  if (proj.costPctOfVolume === null || !Number.isFinite(rewardPct)) return null;
  return rewardPct - proj.costPctOfVolume;
}

/** Reasons a preset cannot be run as configured, worst first. */
export function presetProblems(p: VolumeFarmPreset): string[] {
  const out: string[] = [];
  if (!p.mint.trim()) out.push('No coin chosen yet.');
  if (p.frictionPctPerRoundTrip === null) out.push('Friction has not been measured — run the probe before trusting any number here.');
  if (p.tradeSol <= 0) out.push('Trade size must be above zero.');
  if (p.budgetSol <= 0) out.push('Budget must be above zero.');
  if (p.holdSec + p.gapSec < 2) out.push('A cycle shorter than two seconds will not survive confirmation times.');
  // Gas is fixed per transaction, so a small trade is almost all gas. At
  // 0.00301 SOL/tx a 1 SOL round trip is 0.6% before anything else.
  if (p.tradeSol > 0 && p.tradeSol < 5) {
    const gasPct = ((2 * p.gasSolPerTx) / p.tradeSol) * 100;
    out.push(`At ${p.tradeSol} SOL a round trip, gas alone is ${gasPct.toFixed(2)}% of volume — size up, it is the cheapest change available.`);
  }
  if (p.frictionPctPerRoundTrip !== null && p.frictionPctPerRoundTrip > 0.5) {
    out.push('Measured friction above 0.5% a round trip means this is not a deep pair — SOL/USDC measures near 0.00%.');
  }
  return out;
}

/**
 * The sentence that must never leave the screen.
 *
 * Cost is knowable and this page computes it. Eligibility is not: programmes
 * paying for activity routinely exclude self-matched and multi-wallet volume,
 * and publish that rule after the window they measure. That is the risk that
 * decides whether any of this was worth doing, and the app cannot price it.
 */
export const eligibilityNote =
  'The cost below is measured, not modelled. Whether the volume COUNTS is not: programmes that pay on ' +
  'activity commonly exclude self-matched trading and multi-wallet patterns, and they publish those rules ' +
  'after the window they measure. Read the programme’s terms before funding a run — this is a position ' +
  'in their future judgement, not in a coin.';

/** Said plainly wherever the owner case is shown. Paying yourself is not
 *  income, and a farming page that implied otherwise would be lying. */
export const ownerNote =
  'As the treasury owner your own fee is a wash — it leaves one pocket and arrives in another — so volume ' +
  'costs you only friction and gas. That makes the volume nearly free; it does not make it profitable. ' +
  'Round-tripping your own money can only ever net out slightly negative.';
