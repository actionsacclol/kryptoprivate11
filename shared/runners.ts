// Potential-runner alerts — what the scanner is FOR since 2026-09-02.
//
// Six months of research (docs/strat-swarm-2026-07-24.md, runner-odds
// 2026-08-30) said the same thing twice: the scanner cannot trade
// profitably on its own (negative EV with perfect landing, 12.9 % win rate,
// every variant negative), but it CAN rank launches (AUC 0.87–0.93 on a
// held-out day). So it no longer opens paper positions by default; it flags
// the launches whose measured graduation odds sit in the top buckets and
// tells the user, who decides. Every alert carries the observed rate AND the
// base rate, because "1 in 5 of these graduated" is honest and "runner!" is
// not. Pure module: the engine calls it, tests pin it.

import type { OddsBucket, OddsReport } from './odds';

/** The loosest bucket that still raises an alert. */
export type RunnerBucketFloor = 'top1' | 'top1_5' | 'top5_10';

export interface RunnerAlertSettings {
  enabled: boolean;
  minBucket: RunnerBucketFloor;
  /** Alerts per rolling hour; the rest are still recorded, just not pushed. */
  maxPerHour: number;
}

export const DEFAULT_RUNNER_ALERTS: RunnerAlertSettings = { enabled: true, minBucket: 'top1_5', maxPerHour: 12 };

export const RUNNER_BUCKET_LABEL: Record<RunnerBucketFloor, string> = {
  top1: 'Top 1 % only',
  top1_5: 'Top 5 %',
  top5_10: 'Top 10 %',
};

export interface RunnerFlag {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  flaggedAt: number;
  /** Which window the odds were judged at. */
  windowS: 60 | 120;
  bucket: OddsBucket;
  /** Observed graduation rate for that bucket on the measured day, and the
   *  day's base rate — both in percent. */
  observedPct: number;
  basePct: number;
  /** Launches in that bucket on the measured day (sample size). */
  n: number;
  /** The report's own lines, verbatim. */
  line: string;
  mult3Line: string | null;
  priceSol: number;
  curvePct: number;
  uniqueBuyers: number;
  netInflowSol: number;
  tradesSeen: number;
}

const RANK: Record<OddsBucket, number> = { top1: 0, top1_5: 1, top5_10: 2, top10_25: 3, top25_50: 4, bottom50: 5 };

export function bucketWithin(bucket: OddsBucket, floor: RunnerBucketFloor): boolean {
  return RANK[bucket] <= RANK[floor];
}

export interface RunnerVerdict {
  flag: boolean;
  reason: string;
}

/**
 * Flag or not. Hard rejects and a creator who already sold never flag,
 * whatever the odds say — those are the rug rules the same research
 * measured, and an alert that contradicts them would be noise.
 */
/**
 * How long a flag is worth showing. A potential runner is a call about the
 * next few minutes of a launch: at a quarter of an hour it has either moved
 * or it has not, the scanner has usually stopped tracking it (so there is no
 * live tape for the row either), and leaving it on the list buries the flags
 * that are still actionable. Both sides use this: the engine drops expired
 * flags from its store, the page filters with the same rule between pushes.
 */
export const RUNNER_TTL_MS = 15 * 60_000;

/** The flags still worth showing at `now`, newest first order preserved. */
export function pruneRunners<T extends { flaggedAt: number }>(list: T[], now: number, ttlMs = RUNNER_TTL_MS): T[] {
  return list.filter((r) => now - r.flaggedAt < ttlMs);
}

export function runnerVerdict(
  report: OddsReport | null,
  cfg: RunnerAlertSettings,
  ctx: { hardRejected: boolean; creatorSold: boolean; alreadyFlagged: boolean },
): RunnerVerdict {
  if (!cfg.enabled) return { flag: false, reason: 'runner alerts off' };
  if (ctx.alreadyFlagged) return { flag: false, reason: 'already flagged' };
  if (ctx.hardRejected) return { flag: false, reason: 'hard reject' };
  if (ctx.creatorSold) return { flag: false, reason: 'creator sold' };
  if (!report || !report.graduate) return { flag: false, reason: 'no odds (too few trades)' };
  if (!bucketWithin(report.graduate.bucket, cfg.minBucket)) {
    return { flag: false, reason: `bucket ${report.graduate.bucket} below ${cfg.minBucket}` };
  }
  return { flag: true, reason: `graduation odds ${report.graduate.bucket}` };
}

/** Rolling-hour cap. Allowed calls are counted; refused ones are not. */
export class RunnerRateLimit {
  private stamps: number[] = [];
  allow(now: number, maxPerHour: number): boolean {
    const cutoff = now - 3_600_000;
    while (this.stamps.length && this.stamps[0] < cutoff) this.stamps.shift();
    if (this.stamps.length >= Math.max(1, maxPerHour)) return false;
    this.stamps.push(now);
    return true;
  }
  count(now: number): number {
    const cutoff = now - 3_600_000;
    return this.stamps.filter((s) => s >= cutoff).length;
  }
}

/** Desktop notification / chat text. States the odds AND the odds against. */
export function runnerNotification(f: RunnerFlag): { title: string; body: string } {
  const failPct = Math.max(0, 100 - f.observedPct);
  const title = `Potential runner: ${f.symbol || f.mint.slice(0, 6)}`;
  const body =
    `${f.name || f.symbol} · curve ${f.curvePct.toFixed(0)} % · ${f.uniqueBuyers} buyers · +${f.netInflowSol.toFixed(2)} SOL net at ${f.windowS} s. ` +
    `Graduation odds bucket ${bucketLabel(f.bucket)}: ${f.observedPct.toFixed(0)} % of these graduated (base ${f.basePct.toFixed(1)} %), ` +
    `${failPct.toFixed(0)} % did not. Open the token to decide — nothing is bought for you.`;
  return { title, body };
}

export function bucketLabel(b: OddsBucket): string {
  switch (b) {
    case 'top1': return 'top 1 %';
    case 'top1_5': return 'top 1–5 %';
    case 'top5_10': return 'top 5–10 %';
    case 'top10_25': return 'top 10–25 %';
    case 'top25_50': return 'top 25–50 %';
    case 'bottom50': return 'bottom 50 %';
  }
}
