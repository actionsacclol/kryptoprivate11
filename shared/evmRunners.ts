// Runner calls for Robinhood and BNB — earned, not borrowed.
//
// The Solana runner alert works because it is not a guess: `shared/odds.ts`
// was fitted on pump launches and the number a user sees is the OBSERVED
// graduation rate of pump launches that scored alike. Its honesty comes from
// that word — observed — and it is why the same model cannot be pointed at
// another chain. Pons and four.meme are different curves with different fees
// and different traders.
//
// So these chains get the same CONSTRUCTION rather than the same model: watch
// launches, record what happened in their first minute, wait to see which of
// them graduated, and report the rate we actually measured. Early on there is
// no rate and the app says so. Later there is one, and it is this chain's.
//
// ─── One feature, on purpose ─────────────────────────────────────────────
//
// Unique buyers in the first 60 seconds. Not because it is the best — nobody
// has measured that yet — but because it is the one signal that means the same
// thing on both chains, cannot be faked by a single wallet trading with
// itself, and does not depend on a curve shape. Three guessed features would
// look more sophisticated and be worth less.
//
// ─── What stops this becoming a slot machine ─────────────────────────────
//
//  * A bucket says nothing until it has `MIN_BUCKET_SAMPLES` launches in it.
//  * An alert must beat the chain's own BASE RATE, and both numbers are shown
//    together — "9 of 100 of these graduated, against 2 in 100 overall" is a
//    fact a person can weigh. "RUNNER" is not.
//  * Outcomes are only counted once a launch has had time to graduate, so the
//    denominator is never quietly inflated by launches still in flight.

// From the leaf, not from `./evm`: that file imports this one for its own
// defaults, and taking the type from there was the codebase's only cycle.
import type { EvmChainKind } from './chainKind';

/** Buyer-count buckets. Edges are inclusive lower bounds. */
export const BUYER_BUCKETS = [0, 1, 3, 6, 11, 21] as const;

export type BuyerBucket = (typeof BUYER_BUCKETS)[number];

export const BUYER_BUCKET_LABEL: Record<BuyerBucket, string> = {
  0: 'no buyers',
  1: '1–2 buyers',
  3: '3–5 buyers',
  6: '6–10 buyers',
  11: '11–20 buyers',
  21: '21+ buyers',
};

/** Launches in a bucket before its rate is reported at all. */
export const MIN_BUCKET_SAMPLES = 100;

/**
 * How long a launch is given to graduate before its outcome is final.
 *
 * A launch still inside this window is neither a success nor a failure, and
 * counting it as a failure would drag every rate down and make the newest
 * buckets look worst — the exact bias that would make a fresh install
 * distrust its own numbers.
 */
export const OUTCOME_HORIZON_MS = 6 * 60 * 60 * 1000;

export function bucketOf(uniqueBuyers: number): BuyerBucket {
  let hit: BuyerBucket = 0;
  for (const b of BUYER_BUCKETS) if (uniqueBuyers >= b) hit = b;
  return hit;
}

/** Observed counts for one bucket on one chain. Both are things we watched. */
export interface BucketTally {
  bucket: BuyerBucket;
  /** Launches whose outcome is final. */
  settled: number;
  /** Of those, how many graduated. */
  graduated: number;
}

export interface RunnerModel {
  chain: EvmChainKind;
  tallies: BucketTally[];
  /** All settled launches, and how many graduated. The bar to beat. */
  totalSettled: number;
  totalGraduated: number;
}

export function emptyModel(chain: EvmChainKind): RunnerModel {
  return { chain, tallies: BUYER_BUCKETS.map((bucket) => ({ bucket, settled: 0, graduated: 0 })), totalSettled: 0, totalGraduated: 0 };
}

/** Chain-wide graduation rate, or null before there is anything to divide. */
export function baseRatePct(m: RunnerModel): number | null {
  return m.totalSettled > 0 ? (m.totalGraduated / m.totalSettled) * 100 : null;
}

/** A bucket's observed rate, or null while the sample is too small to report. */
export function bucketRatePct(m: RunnerModel, bucket: BuyerBucket): number | null {
  const t = m.tallies.find((x) => x.bucket === bucket);
  if (!t || t.settled < MIN_BUCKET_SAMPLES) return null;
  return (t.graduated / t.settled) * 100;
}

/**
 * The chain's rate over every launch NOT in this bucket, or null when there
 * is nothing outside it to compare against.
 *
 * This is the bar, not the chain-wide base. The base contains the bucket,
 * so the top bucket of any monotone distribution clears it by construction
 * — "beats the mean" said nothing. Found by audit 2026-09-11.
 */
export function otherRatePct(m: RunnerModel, bucket: BuyerBucket): number | null {
  const t = m.tallies.find((x) => x.bucket === bucket);
  const settled = m.totalSettled - (t?.settled ?? 0);
  const graduated = m.totalGraduated - (t?.graduated ?? 0);
  return settled > 0 ? (graduated / settled) * 100 : null;
}

/**
 * The Wilson 95 % lower bound on a rate, in percent: "at least this much".
 *
 * A bucket of 268 launches with 6 graduations reads 2.2 %; its lower bound
 * is 1.0 %. Against a chain running 1.4 % elsewhere, the point estimate says
 * "runner" and the bound says "cannot tell" — and the bound is right, which
 * is why the flag reads it. Null for an empty sample; never below 0.
 */
export function wilsonLowerPct(graduated: number, settled: number): number | null {
  return wilson(graduated, settled, -1);
}

/**
 * The Wilson 95 % UPPER bound, in percent: "at most this much".
 *
 * The bar a bucket has to clear is not the other launches' point estimate
 * but the top of THEIR interval: a chain that has seen 0 of 500 graduate is
 * not known to graduate at 0 %, only at under 0.76 %, and a bucket's first
 * graduation in 100 (lower bound 0.18 %) does not clear that. Found by
 * audit 2026-09-11 on BNB, where the base read 0.0 % and the first bucket
 * to a single graduation would have been announced as a runner.
 */
export function wilsonUpperPct(graduated: number, settled: number): number | null {
  return wilson(graduated, settled, 1);
}

function wilson(graduated: number, settled: number, side: -1 | 1): number | null {
  if (!(settled > 0)) return null;
  const z = 1.959964;
  const n = settled;
  const p = Math.min(1, Math.max(0, graduated / n));
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(100, Math.max(0, ((centre + side * spread) / (1 + z2 / n)) * 100));
}

export interface RunnerCall {
  /** Null when this chain cannot yet say anything about this launch. */
  bucket: BuyerBucket;
  uniqueBuyers: number;
  /** Observed rate for the bucket, null until the sample is big enough. */
  ratePct: number | null;
  /** The chain's own base rate over the same records. Shown for scale. */
  baseRatePct: number | null;
  /**
   * The rate over every launch NOT in this bucket — the number the bucket has
   * to beat. The chain-wide base includes the bucket itself, so the top of a
   * monotone distribution "beats" it by construction.
   */
  otherRatePct: number | null;
  /** Wilson 95 % lower bound on `ratePct` — "at least this, with confidence". */
  lowerPct: number | null;
  /** Launches behind `ratePct`. Shown, always — a rate without an n is a claim. */
  samples: number;
  /**
   * True only when the bucket is measured AND its lower bound clears the
   * rate of every other launch — not merely its point estimate. A bucket
   * resting on six graduations can sit above the base and still be noise.
   */
  flag: boolean;
  /** Plain words for the UI. Never the word "runner" on its own. */
  detail: string;
}

/**
 * Judge one launch's first minute against what this chain has shown us.
 *
 * Returns a call whether or not it flags, because "we have seen 40 like this,
 * which is not enough to say anything" is information too — and it is the
 * honest thing to show on a fresh install rather than silence.
 */
export function judge(m: RunnerModel, uniqueBuyers: number): RunnerCall {
  const bucket = bucketOf(uniqueBuyers);
  const t = m.tallies.find((x) => x.bucket === bucket);
  const samples = t?.settled ?? 0;
  const rate = bucketRatePct(m, bucket);
  const base = baseRatePct(m);
  const other = otherRatePct(m, bucket);
  const otherUpper = wilsonUpperPct(m.totalGraduated - (t?.graduated ?? 0), m.totalSettled - samples);
  const lower = rate === null ? null : wilsonLowerPct(t?.graduated ?? 0, samples);
  const label = BUYER_BUCKET_LABEL[bucket];

  if (rate === null) {
    return {
      bucket,
      uniqueBuyers,
      ratePct: null,
      baseRatePct: base,
      otherRatePct: other,
      lowerPct: null,
      samples,
      flag: false,
      detail: `${samples} of ${MIN_BUCKET_SAMPLES} launches recorded with ${label} — not enough yet to say anything.`,
    };
  }
  // A measured rate is a signal only when even its LOWER bound clears the
  // rate of every other launch on the chain. A point estimate above the base
  // on a handful of graduations is what noise looks like, and notifying on
  // it is noise dressed as a signal. Found by audit 2026-09-11: the real
  // 11–20 bucket (6 of 268) sat above the base by a margin of two
  // graduations, and was the default alert floor.
  // Two intervals that do not overlap: the bucket's floor above the rest
  // of the chain's ceiling. Either side alone is not enough — see
  // `wilsonUpperPct` for the zero-base case that a point estimate misses.
  const beats = other !== null && otherUpper !== null && lower !== null && lower > otherUpper;
  if (m.totalGraduated === 0) {
    // "0.0 % — no better than 0.0 %" is true and reads like a bug.
    return {
      bucket,
      uniqueBuyers,
      ratePct: rate,
      baseRatePct: base,
      otherRatePct: other,
      lowerPct: lower,
      samples,
      flag: false,
      detail: `${samples} launches with ${label} recorded, and none of the ${m.totalSettled} settled on this chain has graduated yet — nothing to compare against.`,
    };
  }
  const detail = beats
    ? `${rate.toFixed(1)}% of ${samples} launches with ${label} graduated — at least ${lower.toFixed(1)}% with 95% confidence — against ${other.toFixed(1)}% (at most ${otherUpper.toFixed(1)}%) for every other launch on this chain.`
    : other === null || otherUpper === null
      ? `${rate.toFixed(1)}% of ${samples} launches with ${label} graduated, but every launch this chain has settled is in this bucket — nothing to compare against yet.`
      : rate > other
        ? `${rate.toFixed(1)}% of ${samples} launches with ${label} graduated, above the ${other.toFixed(1)}% for every other launch — but on ${t?.graduated ?? 0} graduations that is inside the noise (at least ${(lower ?? 0).toFixed(1)}% here, at most ${otherUpper.toFixed(1)}% there, with 95% confidence).`
        : `${rate.toFixed(1)}% of ${samples} launches with ${label} graduated — no better than the ${other.toFixed(1)}% for every other launch on this chain.`;
  return {
    bucket,
    uniqueBuyers,
    ratePct: rate,
    baseRatePct: base,
    otherRatePct: other,
    lowerPct: lower,
    samples,
    flag: beats,
    detail,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Runner filters — which of these calls is worth interrupting someone for.
//
// `judge` above answers "what have we seen happen to launches like this".
// That is a measurement, and it is made on every launch. This is the second,
// separate question: does it rise to a notification?
//
// They are kept apart on purpose. The Solana side made the same split
// (shared/runners.ts) and the reason holds here: a filter that changed what
// was MEASURED would quietly change the numbers a user is reading. Turning
// these knobs changes what you are told about, never what was true.
// ─────────────────────────────────────────────────────────────────────────

export interface EvmRunnerAlerts {
  enabled: boolean;
  /**
   * The loosest buyer bucket that may raise an alert.
   *
   * Defaults to 11+, not to the top bucket. On Robinhood's measured record
   * (2,192 settled launches, 1.46 % base, 2026-09-11) 21+ graduates 8.9 %
   * and clears every other launch with room to spare; 11–20 reads 2.2 % on
   * six graduations, which is above the base and inside the noise, so the
   * base-rate rule keeps it quiet until the record can tell. The floor is
   * 11 so that the day it CAN tell, nothing has to be reconfigured; starting
   * at 3+ would notify on most of the chain.
   */
  minBucket: BuyerBucket;
  /** Alerts per rolling hour. The rest are still recorded, just not pushed. */
  maxPerHour: number;
  /**
   * Require the bucket's measured rate to BEAT this chain's own base rate.
   *
   * On by default, and it is the rule that keeps the feature honest: a bucket
   * can be well sampled and still be no better than picking at random, and
   * notifying on that is noise dressed as a signal. A user who wants every
   * measured bucket can turn it off, and then gets exactly what they asked
   * for — the numbers shown are unchanged either way.
   */
  requireBeatsBase: boolean;
  /**
   * Discord webhook for THIS chain's flags. Empty = off.
   *
   * Per chain rather than global on purpose: someone watching Robinhood and
   * BNB usually wants them in different places, and the chains have separate
   * records, separate base rates and separate floors already. See
   * RunnerAlertSettings in shared/runners.ts for why the URL is pinned to
   * Discord's hosts at the IPC boundary.
   */
  webhookUrl: string;
}

export const DEFAULT_EVM_RUNNER_ALERTS: EvmRunnerAlerts = {
  enabled: true,
  minBucket: 11,
  maxPerHour: 12,
  requireBeatsBase: true,
  webhookUrl: '',
};

/** Bucket order, loosest last. Used to compare a call against the floor. */
const BUCKET_RANK: Record<BuyerBucket, number> = { 0: 0, 1: 1, 3: 2, 6: 3, 11: 4, 21: 5 };

export interface EvmRunnerVerdict {
  alert: boolean;
  /** Why, in words, whichever way it went — the log line and the UI use it. */
  reason: string;
}

/**
 * Should this call interrupt someone?
 *
 * Never invents a reason to say yes: an unmeasured bucket is refused, because
 * `ratePct === null` means this chain has not yet seen enough launches like
 * this one to have an opinion, and an alert with no rate behind it is the
 * thing this whole module exists to avoid.
 */
export function evmRunnerVerdict(call: RunnerCall, cfg: EvmRunnerAlerts): EvmRunnerVerdict {
  if (!cfg.enabled) return { alert: false, reason: 'runner alerts off for this chain' };
  if (BUCKET_RANK[call.bucket] < BUCKET_RANK[cfg.minBucket]) {
    return { alert: false, reason: `${BUYER_BUCKET_LABEL[call.bucket]} is below the ${BUYER_BUCKET_LABEL[cfg.minBucket]} floor` };
  }
  if (call.ratePct === null) {
    return { alert: false, reason: `only ${call.samples} of ${MIN_BUCKET_SAMPLES} launches recorded in this bucket` };
  }
  if (cfg.requireBeatsBase && !call.flag) {
    return { alert: false, reason: 'measured, but no better than this chain overall' };
  }
  return { alert: true, reason: call.detail };
}

/**
 * Desktop notification text. States the odds AND the odds against.
 *
 * "80 % of these did not graduate" is in the body for the same reason the
 * Solana notification carries it: a number on its own reads as a promise.
 */
export function evmRunnerNotification(
  chainName: string,
  symbol: string,
  token: string,
  call: RunnerCall,
): { title: string; body: string } {
  const name = symbol || `${token.slice(0, 8)}…`;
  // Only a flagged call is announced as a runner. With the base-rate rule
  // switched off a measured-but-not-better call can still notify, and its
  // title says what it is. (Until 2026-09-11 both read "looks like a runner".)
  const title = call.flag
    ? `${chainName}: ${name} looks like a runner`
    : `${chainName}: ${name} — ${call.uniqueBuyers} buyers, measured, not above base`;
  if (call.ratePct === null) {
    return { title, body: call.detail };
  }
  const failPct = Math.max(0, 100 - call.ratePct);
  // The numbers the flag was DECIDED on: the bucket's lower bound and the
  // rate of every other launch — not the chain-wide base, which contains
  // the bucket and always reads as a win for the top of the distribution.
  const body =
    `${call.uniqueBuyers} buyers in the first minute. ` +
    `${call.ratePct.toFixed(0)} % of the ${call.samples} launches we have watched with ${BUYER_BUCKET_LABEL[call.bucket]} graduated` +
    (call.lowerPct !== null ? ` (at least ${call.lowerPct.toFixed(1)} % with 95 % confidence)` : '') +
    (call.otherRatePct !== null ? `, against ${call.otherRatePct.toFixed(1)} % for every other launch on this chain` : '') +
    `, and ${failPct.toFixed(0)} % did not. Open it to decide — nothing is bought for you.`;
  return { title, body };
}

// ── Flagged calls, kept for the session ───────────────────────────────
//
// `EvmScanLaunch` lives only while a launch is inside its measurement window
// (EVM_SCAN_TRACK_MS, 130 s), so a flagged call vanished about two minutes
// after it was made. Solana's runner flags are kept for the whole session and
// the Runner alerts panel lists them; without this the same panel could not
// show an EVM call at all, let alone say which chain it came from.
//
// Deliberately NOT shaped like Solana's `RunnerFlag`. That type carries curve
// regime, net inflow, an odds bucket and a price — things these rails do not
// measure. Filling them with zeroes to share one type is how a panel starts
// showing numbers nobody measured.

export interface EvmRunnerFlag {
  chain: EvmChainKind;
  token: string;
  symbol: string;
  name: string;
  flaggedAt: number;
  uniqueBuyers: number;
  /** Observed rate for the bucket, and the rate it had to beat. */
  ratePct: number | null;
  otherRatePct: number | null;
  /** Wilson 95 % lower bound — "at least this, with confidence". */
  lowerPct: number | null;
  samples: number;
  /** The call's own sentence, verbatim. */
  detail: string;
}

/** How many flagged calls are kept per chain. */
export const EVM_RUNNER_FLAG_CAP = 50;

