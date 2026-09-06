// Opportunity scoring — v2 (data-driven redesign, 2026-07).
//
// The v1 model (monotonic momentum: more buyers + more inflow + more
// acceleration = higher score) was REFUTED by our own 133-trade paper
// record: it barely separated winners (avg 60.5) from losers (59.2), and
// the momentum features it rewarded actively anti-correlated with wins
// (losers had MORE buyers, MORE inflow; winners had FEWER sells, less sell
// volume, and entered EARLIER on the curve). See docs/edge-speed-plan.
//
// v2 weight shape:
//   20 safety + 18 creator + 18 sellPressure + 12 entryTiming
//   + 8 crowd(band) + 14 concentration + 10 metadata − penalties
//
// Momentum is replaced by BAND-shaped scores (a plateau, not a ramp) so
// over-hyped tops score low, and sell activity gets a dedicated component.
// Every threshold is a StrategySettings knob — 133 samples is far too few
// to hardcode against, so the recorder keeps writing raw flow for re-fit.

import type { LiveFlow, RiskFlag, ScoreBreakdown, StrategySettings } from '@shared/types';
import type { CreatorRecord } from './creators';

export interface ScoreInputs {
  flags: RiskFlag[];
  mintChecked: boolean;
  creator: CreatorRecord;
  flow: LiveFlow;
  hasUri: boolean;
  nameOk: boolean;
  strategy: StrategySettings;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Trapezoid band: 0 below `lo`, ramps to 1 by `peakLo`, holds 1 to
 *  `peakHi`, ramps back to 0 by `hi`. A wide plateau resists overfitting. */
function band(x: number, lo: number, peakLo: number, peakHi: number, hi: number): number {
  if (x <= lo || x >= hi) return 0;
  if (x < peakLo) return (x - lo) / (peakLo - lo);
  if (x <= peakHi) return 1;
  return (hi - x) / (hi - peakHi);
}

export function computeScore(i: ScoreInputs): ScoreBreakdown {
  const f = i.flow;

  // Safety (0..20): full marks only when the mint was verified clean.
  // Unverified caps at 8 — fail-closed, never assume safe.
  let safety = 0;
  const softFlags = i.flags.filter((ff) => !ff.hard).length;
  if (i.mintChecked) safety = clamp(20 - softFlags * 4, 0, 20);
  else safety = clamp(8 - softFlags * 2, 0, 8);

  // Creator (0..18): unknown creators neutral at 9; history moves both ways.
  let creator = 9;
  if (i.creator.launches > 0) {
    const dumpRate = i.creator.dumps / i.creator.launches;
    const completionRate = i.creator.completions / i.creator.launches;
    creator = clamp(9 + completionRate * 9 - dumpRate * 13, 0, 18);
  }

  // Sell pressure (0..18) — the single strongest clean separator in the data
  // (winners 0.75 sells / 0.63 SOL vs losers 1.65 / 2.0). A spotless book
  // scores 18; ANY sell caps the component at 14 so a clean book strictly
  // dominates, then a graded slope (not a cliff) penalizes more selling.
  let sellPressure: number;
  if (f.sells === 0) {
    sellPressure = 18;
  } else {
    sellPressure = clamp(14 - f.sellVolumeSol * 9 - f.sells * 1.5 - f.distinctSellers * 1.0, 0, 14);
  }

  // Entry timing (0..12): reward the 10–20% curve band. Winners entered at
  // 17.7% vs losers 20.4%; the v1 formula rewarded LATER entry — backwards.
  const c = f.curveProgressPct;
  const entryTiming = 12 * band(c, i.strategy.entryCurveMinPct, 10, 18, i.strategy.entryCurveMaxPct + 6);

  // Crowd (0..8): band-shaped, NOT monotonic. A little organic crowd is
  // good; a mob is a top. Wide plateau so legit steady launches still pass.
  const buyersBand = band(f.uniqueBuyers, 2, 5, 10, i.strategy.maxUniqueBuyers + 4);
  const inflowBand = band(f.netInflowSol, 0.5, 3, 12, i.strategy.maxNetInflowSol + 6);
  const crowd = 8 * 0.5 * (buyersBand + inflowBand);

  // Concentration (0..14): token-weighted, not SOL-weighted (the SOL-weighted
  // top-buyer share did NOT separate — 0.232 vs 0.234 — because snipers buy
  // SOL-light but token-heavy). Penalize a dominant holder + bundle cluster.
  const holderPenalty = clamp((f.topHolderTokenShare - 0.1) / 0.4, 0, 1);
  const bundlePenalty = clamp((f.earlyBuyerShare - 0.2) / 0.5, 0, 1);
  const concentration = clamp(14 * (1 - 0.6 * holderPenalty - 0.4 * bundlePenalty), 0, 14);

  // Metadata (0..10): presence checks only in the hot path.
  let metadata = 0;
  if (i.nameOk) metadata += 5;
  if (i.hasUri) metadata += 5;

  // Penalties: creator selling during evaluation is the strongest manipulation
  // signal; a sell-heavy book is the second (now mostly handled by sellPressure).
  let penalties = 0;
  if (f.creatorSold) penalties += 25;
  if (f.sellVolumeSol > f.buyVolumeSol * 0.8 && f.sells > 2) penalties += 8;

  const total = clamp(
    safety + creator + sellPressure + entryTiming + crowd + concentration + metadata - penalties,
    0,
    100,
  );

  const r = (v: number): number => Math.round(v * 10) / 10;
  return {
    safety: r(safety),
    creator: r(creator),
    sellPressure: r(sellPressure),
    entryTiming: r(entryTiming),
    crowd: r(crowd),
    concentration: r(concentration),
    metadata,
    penalties,
    total: r(total),
  };
}
