// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — runner odds (2026-08-30).
//
// Pure, no I/O. Scores a launch at +60 s / +120 s against the dated model in
// shared/odds-model.json (exported by
// scripts/analysis/export_odds_model_2026_08_30.py from the runner analysis
// in docs/runner-odds-2026-08-30.md) and returns OBSERVED bucket rates from
// the held-out day 2026-07-27 — never the model's probability. The model
// ranks well (AUC 0.87–0.94 held out) but is over-confident above ~20 %
// predicted, so the number a user sees is "of launches that scored like this
// on 07-27, X in 100 graduated (n = …)", beside the base rate.
//
// The model takes RANKS, not raw values: every rank feature is mapped to its
// mid-rank percentile in the train universe (07-25 + 07-26), reproduced here
// from a 201-point quantile grid to within ±0.01. Binary features pass
// through as 0/1. Null → 0.5 plus the feature's `__null` coefficient when
// the train set had nulls; a null in a feature that was never null in train
// (a REQUIRED feature) means the launch is not scored at all.
//
// Honest-null rule: unknown → null report → the UI renders an em dash. Zero
// trades → not scored. The "2× in 5 minutes" label is not shipped (§7 of the
// report: a null result for odds display).
// ──────────────────────────────────────────────────────────────────────

import type { LaunchTrade } from './launchintel';
import modelJson from './odds-model.json';

export type OddsBucket = 'top1' | 'top1_5' | 'top5_10' | 'top10_25' | 'top25_50' | 'bottom50';
export type CurveRegime = 'classic' | 'mixed' | 'unknown';

/** What the terminal knows about a launch, frozen at `windowS` seconds. */
export interface OddsFeatures {
  windowS: 60 | 120;
  /** Trades with offset in (W−10 s, W] ÷ 10. */
  tradesPerSecondLast10s: number | null;
  /** Buy events by W. */
  nBuys: number | null;
  /** Distinct selling wallets by W. */
  uniqueSellers: number | null;
  /** Σ buy SOL − Σ sell SOL (event SOL, fees excluded). */
  netSol: number | null;
  /** netSol ÷ buy SOL; null with no buys. */
  netOverBuy: number | null;
  /** Creator net tokens (buys − sells, floored 0) ÷ supply, 0..1. */
  creatorShareOfSupply: number | null;
  /** Creator has ≥ 1 sell by W. Null = creator unknown. */
  creatorSold: boolean | null;
  /** Curve regime is not the classic constant product (see curveRegime). */
  curveMixed: boolean | null;
  /** Sum of the 3 largest non-creator net positions ÷ supply, 0..1. */
  top3BuyersShare: number | null;
  /** Largest single buy SOL ÷ buy SOL; null with no buys. */
  largestBuyFrac: number | null;
  /** Median buy size, SOL; null with no buys. */
  medianBuySol: number | null;
  /** Token-side bonding-curve progress 0..1. */
  curveProgress: number | null;
  /** Creator tokens bought in the create slot ÷ supply; null without the create slot. */
  devBuyShareOfSupply: number | null;
  /** Metadata twitter field non-empty; null until metadata resolves. */
  metaTwitter: boolean | null;
  /** Tokens bought by non-creator wallets whose first buy was 1–20 slots after create ÷ supply. */
  sniperShare: number | null;
  /** Buy SOL ÷ unique buyers; null with no buyers. */
  buySolPerBuyer: number | null;
  /** Trades observed inside the window. 0 ⇒ not scored. */
  tradesSeen: number;
}

export interface OddsReport {
  /** The day the rates were measured on ("2026-07-27"). */
  model: string;
  windowS: 60 | 120;
  regime: CurveRegime;
  /** Graduation bucket and its observed rate. Null when the model cannot be scored. */
  graduate: { bucket: OddsBucket; observedPct: number; n: number; basePct: number; line: string } | null;
  /**
   * ≥ 3× from the 60 s price within the hour. Only at +60 s. classicPct /
   * mixedPct: for the top-5 % buckets the report's regime split (classic =
   * top-5 % within classic curves, mixed = mixed launches above the global
   * cut); for lower buckets the observed rate of that regime inside the
   * bucket, null when fewer than 50 such launches.
   */
  mult3: { classicPct: number | null; mixedPct: number | null; line: string } | null;
  /** ≥ 5× from the 60 s price within the hour. Same conventions as mult3. */
  mult5: { classicPct: number | null; mixedPct: number | null; line: string } | null;
  /** Verbatim panel footer for the window. */
  footer: string;
  tradesSeen: number;
}

// ── The artefact ──────────────────────────────────────────────────────

export type OddsFeatureKey = Exclude<keyof OddsFeatures, 'windowS' | 'tradesSeen'>;

export interface OddsModelFeature {
  key: OddsFeatureKey;
  /** Dataset column the coefficient was fitted on. */
  column: string;
  kind: 'rank' | 'binary';
  coef: number;
  /** Coefficient of the `__null` indicator; null ⇒ the feature is REQUIRED. */
  nullCoef: number | null;
  trainN: number;
  /** 201 train-universe quantiles (q = 0, 0.005, …, 1); null for binary. */
  grid: number[] | null;
}

export interface OddsRegimeCell {
  n: number;
  observed: number | null;
}

export interface OddsModelBucket {
  bucket: OddsBucket;
  label: string;
  /** Lowest predicted probability that landed in this bucket on the measured day. */
  scoreMin: number;
  n: number;
  observed: number;
  lift: number;
  predMean: number;
  byRegime: { classic: OddsRegimeCell; mixed: OddsRegimeCell };
}

export interface OddsRegimeTop5 {
  n: number;
  base: number | null;
  auc: number | null;
  /** Observed rate of the top 5 % by score INSIDE this regime, in %. */
  top5WithinPct: number | null;
  nAboveCut: number | null;
  /** Observed rate of this regime's launches above the GLOBAL top-5 % cut, in %. */
  aboveCutPct: number | null;
}

export interface OddsModelSpec {
  key: string;
  windowS: 60 | 120;
  label: 'grad' | 'peak3' | 'peak5';
  labelText: string;
  intercept: number;
  features: OddsModelFeature[];
  base: number;
  population: number;
  buckets: OddsModelBucket[];
  regimeTop5: { classic: OddsRegimeTop5; mixed: OddsRegimeTop5 };
  footer: string;
  golden: { mint: string; features: OddsFeatures; p: number; bucket: OddsBucket; pGrid: number }[];
}

export interface OddsModelFile {
  measuredOn: string;
  fittedOn: string[];
  source: string;
  supplyUnits: number;
  gridPoints: number;
  rankTransform: string;
  models: Record<string, OddsModelSpec>;
}

export const ODDS_MODEL: OddsModelFile = modelJson as unknown as OddsModelFile;

// ── Curve regime ──────────────────────────────────────────────────────

/** Classic pump.fun constant product in raw units: 30 SOL · 1.073e9 tokens. */
export const CLASSIC_CURVE_K = 30e9 * 1.073e15;
export const CLASSIC_CURVE_TOLERANCE = 0.005;

/**
 * Classic when vSol·vTok (raw lamports × raw token units) is within 0.5 % of
 * the standard product; mixed otherwise; unknown on null. A curve that has
 * left the constant product does not return to it, so the current state is
 * the regime "as knowable at W".
 */
export function curveRegime(vSol: number | null, vTok: number | null): CurveRegime {
  if (vSol === null || vTok === null || !Number.isFinite(vSol) || !Number.isFinite(vTok)) return 'unknown';
  if (vSol <= 0 || vTok <= 0) return 'unknown';
  const k = vSol * vTok;
  return Math.abs(k - CLASSIC_CURVE_K) / CLASSIC_CURVE_K <= CLASSIC_CURVE_TOLERANCE ? 'classic' : 'mixed';
}

// ── Rank transform + logistic ─────────────────────────────────────────

/**
 * Mid-rank percentile of `v` against a sorted quantile grid. Mirrors
 * common.RankTransformer: (count< + count≤) / 2 / n, where the counts are
 * read off the grid; between grid points linear; outside the grid 0 / 1.
 */
export function rankPercentile(grid: number[], v: number): number {
  const m = grid.length - 1;
  if (m < 1) return 0.5;
  // lo = first index with grid[i] >= v ; hi = first index with grid[i] > v
  let lo = 0;
  let hiB = grid.length;
  while (lo < hiB) {
    const mid = (lo + hiB) >> 1;
    if (grid[mid] < v) lo = mid + 1;
    else hiB = mid;
  }
  let hi = lo;
  let hiE = grid.length;
  while (hi < hiE) {
    const mid = (hi + hiE) >> 1;
    if (grid[mid] <= v) hi = mid + 1;
    else hiE = mid;
  }
  if (lo < hi) return (lo / m + Math.min(hi, m) / m) / 2; // on a tie block
  if (lo === 0) return 0; // below the grid
  if (lo > m) return 1; // above the grid
  const span = grid[lo] - grid[lo - 1];
  const frac = span > 0 ? (v - grid[lo - 1]) / span : 0;
  return (lo - 1 + frac) / m;
}

function featureValue(f: OddsFeatures, key: OddsFeatureKey): number | null {
  const v = f[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number.isFinite(v) ? v : null;
}

/**
 * The model's predicted probability, or null when a REQUIRED feature is
 * unknown. Internal: the number is never rendered (see the header) and is
 * exposed only through `__oddsInternals` for the golden round-trip test.
 */
function modelProbability(spec: OddsModelSpec, f: OddsFeatures): number | null {
  let z = spec.intercept;
  for (const feat of spec.features) {
    const raw = featureValue(f, feat.key);
    if (raw === null) {
      if (feat.nullCoef === null) return null;
      z += feat.coef * 0.5 + feat.nullCoef;
      continue;
    }
    const x = feat.kind === 'binary' || !feat.grid ? raw : rankPercentile(feat.grid, raw);
    z += feat.coef * x;
  }
  return 1 / (1 + Math.exp(-z));
}

function bucketOf(spec: OddsModelSpec, p: number): OddsModelBucket {
  for (const b of spec.buckets) if (p >= b.scoreMin) return b;
  return spec.buckets[spec.buckets.length - 1];
}

// ── Wording (report §7) ───────────────────────────────────────────────

const fmtN = (n: number): string => n.toLocaleString('en-US');

/** "2", "1.6", "3" — integers from 2 up, one decimal below. */
function pctWord(pct: number): string {
  return pct >= 2 ? String(Math.round(pct)) : (Math.round(pct * 10) / 10).toString();
}

/** "About 17 in 100", "About 1 in 200", "Fewer than 1 in 1,000". */
function inNWord(pct: number): { lead: string; about: boolean } {
  if (pct >= 1.5) return { lead: `About ${Math.round(pct)} in 100`, about: true };
  if (pct >= 0.1) {
    const per = Math.max(100, Math.round(100 / pct / 50) * 50);
    return { lead: `About 1 in ${fmtN(per)}`, about: true };
  }
  return { lead: 'Fewer than 1 in 1,000', about: false };
}

function gradLine(b: OddsModelBucket, basePct: number): string {
  const obs = b.observed * 100;
  const { lead } = inNWord(obs);
  return `${lead} launches like this graduated (n = ${fmtN(b.n)}). Base: ${pctWord(basePct)} in 100.`;
}

function regimeWord(v: number | null): string {
  return v === null ? '—' : `~${pctWord(v)}`;
}

function multLine(
  mult: 3 | 5,
  b: OddsModelBucket,
  basePct: number,
  classicPct: number | null,
  mixedPct: number | null,
): string {
  const obs = b.observed * 100;
  const { lead } = inNWord(obs);
  const head = lead.startsWith('About ') && obs >= 1.5 ? lead.slice('About '.length) : lead;
  let s = `${head} hit ${mult}× within the hour (n = ${fmtN(b.n)}); base ${pctWord(basePct)} in 100.`;
  if (classicPct !== null || mixedPct !== null) {
    s += ` Classic ${regimeWord(classicPct)} · mixed ${regimeWord(mixedPct)}`;
  }
  return s;
}

const MIN_REGIME_N = 50;

function regimeSplit(spec: OddsModelSpec, b: OddsModelBucket): { classicPct: number | null; mixedPct: number | null } {
  if (b.bucket === 'top1' || b.bucket === 'top1_5') {
    // The report's split for the top 5 %: classic = top-5 % within classic
    // curves (too few classic launches clear the global cut to measure),
    // mixed = mixed launches above the global cut.
    return { classicPct: spec.regimeTop5.classic.top5WithinPct, mixedPct: spec.regimeTop5.mixed.aboveCutPct };
  }
  const c = b.byRegime.classic;
  const m = b.byRegime.mixed;
  return {
    classicPct: c.n >= MIN_REGIME_N && c.observed !== null ? c.observed * 100 : null,
    mixedPct: m.n >= MIN_REGIME_N && m.observed !== null ? m.observed * 100 : null,
  };
}

// ── Scoring ───────────────────────────────────────────────────────────

/**
 * Score a launch. Null when there are no trades, when the window has no
 * shipped graduation model, or when a REQUIRED feature of that model is
 * unknown. The 3×/5× lines are shipped at +60 s only and are null on their
 * own when their model cannot be scored.
 */
export function scoreOdds(f: OddsFeatures): OddsReport | null {
  if (!f || !(f.tradesSeen > 0)) return null;
  const grad = ODDS_MODEL.models[`${f.windowS}|grad`];
  if (!grad) return null;
  const pGrad = modelProbability(grad, f);
  if (pGrad === null) return null;
  const gb = bucketOf(grad, pGrad);
  const gradBasePct = grad.base * 100;

  const regime: CurveRegime = f.curveMixed === null ? 'unknown' : f.curveMixed ? 'mixed' : 'classic';

  const mult = (label: 'peak3' | 'peak5', m: 3 | 5): OddsReport['mult3'] => {
    const spec = ODDS_MODEL.models[`${f.windowS}|${label}`];
    if (!spec) return null;
    const p = modelProbability(spec, f);
    if (p === null) return null;
    const b = bucketOf(spec, p);
    const split = regimeSplit(spec, b);
    return { ...split, line: multLine(m, b, spec.base * 100, split.classicPct, split.mixedPct) };
  };

  return {
    model: ODDS_MODEL.measuredOn,
    windowS: f.windowS,
    regime,
    graduate: {
      bucket: gb.bucket,
      observedPct: gb.observed * 100,
      n: gb.n,
      basePct: gradBasePct,
      line: gradLine(gb, gradBasePct),
    },
    mult3: mult('peak3', 3),
    mult5: mult('peak5', 5),
    footer: grad.footer,
    tradesSeen: f.tradesSeen,
  };
}

// ── Features from a trade list ────────────────────────────────────────

/** Slots after the create slot that still count as a snipe (shared/launchintel.ts). */
const SNIPER_SLOTS = 20;

/**
 * Build the model inputs from a launch's trade list, frozen at `windowS`
 * seconds after the FIRST TRADE (the dev buy lands in the create slot, so
 * this is the create time to within feed latency). Trades are accepted in
 * any order; anything after the window is ignored.
 *
 * Definitions (all over trades with offset ≤ W):
 *   tradesPerSecondLast10s  trades with offset in (W−10 s, W] ÷ 10
 *   nBuys / uniqueSellers   buy events / distinct selling wallets
 *   netSol / netOverBuy     Σ buy SOL − Σ sell SOL / that ÷ Σ buy SOL (null with no buys)
 *   creatorShareOfSupply    creator (buys − sells) tokens, floored 0, ÷ supply
 *   creatorSold             creator has a sell; null without creator
 *   curveMixed              curveRegime(vSol, vTok) === 'mixed'; null when unknown
 *   top3BuyersShare         3 largest non-creator net positions ÷ supply; null without creator or supply
 *   largestBuyFrac          largest buy SOL ÷ Σ buy SOL (null with no buys)
 *   medianBuySol            median buy SOL (null with no buys)
 *   devBuyShareOfSupply     creator tokens bought in the create slot ÷ supply; null without createSlot
 *   sniperShare             tokens bought by non-creator wallets whose first buy was 1–20 slots
 *                           after the create slot ÷ supply; null without createSlot / creator / supply
 *   buySolPerBuyer          Σ buy SOL ÷ unique buyers (null with no buyers)
 */
export function oddsFeaturesFromTrades(
  trades: LaunchTrade[],
  ctx: {
    creator: string | null;
    /** Total supply in UI units (pump default 1e9). */
    supply: number | null;
    curveProgress: number | null;
    /** Raw lamports / raw token units of the curve at the window. */
    virtualSolReserves: number | null;
    virtualTokenReserves: number | null;
    hasTwitter: boolean | null;
    createSlot: number | null;
    windowS: 60 | 120;
  },
): OddsFeatures {
  const W = ctx.windowS;
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || a.slot - b.slot);
  const t0 = sorted[0]?.ts ?? null;
  const inWindow = t0 === null ? [] : sorted.filter((t) => t.ts - t0 <= W * 1000);

  const supply = ctx.supply !== null && Number.isFinite(ctx.supply) && ctx.supply > 0 ? ctx.supply : null;
  const creator = ctx.creator || null;

  let nBuys = 0;
  let buySol = 0;
  let sellSol = 0;
  let largest = 0;
  let last10 = 0;
  const buySizes: number[] = [];
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  const net = new Map<string, number>();
  const firstBuySlot = new Map<string, number>();
  const bought = new Map<string, number>();
  let creatorSold: boolean | null = creator ? false : null;
  let devBuyTokens = 0;

  for (const t of inWindow) {
    const off = t.ts - (t0 as number);
    if (off > (W - 10) * 1000) last10 += 1;
    if (t.isBuy) {
      nBuys += 1;
      buySol += t.sol;
      buySizes.push(t.sol);
      if (t.sol > largest) largest = t.sol;
      buyers.add(t.user);
      net.set(t.user, (net.get(t.user) ?? 0) + t.base);
      bought.set(t.user, (bought.get(t.user) ?? 0) + t.base);
      const fs = firstBuySlot.get(t.user);
      if (fs === undefined || t.slot < fs) firstBuySlot.set(t.user, t.slot);
      if (creator && t.user === creator && ctx.createSlot !== null && t.slot === ctx.createSlot) devBuyTokens += t.base;
    } else {
      sellSol += t.sol;
      sellers.add(t.user);
      net.set(t.user, (net.get(t.user) ?? 0) - t.base);
      if (creator && t.user === creator) creatorSold = true;
    }
  }

  const share = (tokens: number): number | null => (supply === null ? null : tokens / supply);

  let creatorShare: number | null = null;
  if (creator && supply !== null) creatorShare = Math.max(0, net.get(creator) ?? 0) / supply;

  let top3: number | null = null;
  let sniper: number | null = null;
  if (creator && supply !== null) {
    const others: number[] = [];
    for (const [u, v] of net) if (u !== creator) others.push(Math.max(0, v));
    others.sort((a, b) => b - a);
    top3 = (others[0] ?? 0) + (others[1] ?? 0) + (others[2] ?? 0);
    top3 /= supply;
    if (ctx.createSlot !== null) {
      let sn = 0;
      for (const [u, fs] of firstBuySlot) {
        if (u === creator) continue;
        const d = fs - ctx.createSlot;
        if (d >= 1 && d <= SNIPER_SLOTS) sn += bought.get(u) ?? 0;
      }
      sniper = sn / supply;
    }
  }

  let median: number | null = null;
  if (buySizes.length) {
    const s = [...buySizes].sort((a, b) => a - b);
    const mid = s.length >> 1;
    median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  const regime = curveRegime(ctx.virtualSolReserves, ctx.virtualTokenReserves);

  return {
    windowS: W,
    tradesPerSecondLast10s: inWindow.length ? last10 / 10 : null,
    nBuys: inWindow.length ? nBuys : null,
    uniqueSellers: inWindow.length ? sellers.size : null,
    netSol: inWindow.length ? buySol - sellSol : null,
    netOverBuy: buySol > 0 ? (buySol - sellSol) / buySol : null,
    creatorShareOfSupply: creatorShare,
    creatorSold,
    curveMixed: regime === 'unknown' ? null : regime === 'mixed',
    top3BuyersShare: top3,
    largestBuyFrac: buySol > 0 ? largest / buySol : null,
    medianBuySol: median,
    curveProgress: ctx.curveProgress,
    devBuyShareOfSupply: creator && ctx.createSlot !== null && supply !== null ? share(devBuyTokens) : null,
    metaTwitter: ctx.hasTwitter,
    sniperShare: sniper,
    buySolPerBuyer: buyers.size ? buySol / buyers.size : null,
    tradesSeen: inWindow.length,
  };
}

/**
 * Test hook for the golden round-trip (test/odds.test.mjs). The probability
 * must never reach the UI — OddsReport does not carry it.
 */
export const __oddsInternals = { modelProbability, bucketOf, rankPercentile };
