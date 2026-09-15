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
  /**
   * Discord webhook to post flags to. Empty = off, which is the default.
   *
   * This is OUTBOUND ONLY and is not the chat bot: the bot in system/bots.ts
   * is read-only, paired by code, and silent to strangers. A webhook is a URL
   * the user pasted from their own server's settings, and the only thing that
   * ever travels down it is the same flag the desktop notification carries.
   *
   * Validated at the IPC boundary against Discord's own hosts (see
   * settingsValidation.ts). That matters more than usual here: everywhere
   * else the app refuses to take a URL from the renderer at all, and this is
   * the one field that has to, so it is pinned to a host that cannot be used
   * to post your flags somewhere you did not choose.
   */
  webhookUrl: string;
}

export const DEFAULT_RUNNER_ALERTS: RunnerAlertSettings = {
  enabled: true,
  minBucket: 'top1_5',
  maxPerHour: 12,
  webhookUrl: '',
};

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
  /** When the creator sold AFTER the flag (ms epoch), else null. The flag
   *  stays on the list so the call can be judged, but its premise is gone.
   *  Decided 60 s after the flag on curves still open (07-27, n = 848):
   *  flags whose creator had not sold graduated 21.6 %, those whose creator
   *  had 4.7 % (runner-outcome swarm 09-11, reviewer r4). */
  creatorSoldAt?: number | null;
  /** Curve regime at the judge (shared/odds.ts curveRegime). "mixed" curves
   *  were 76 % of 07-27 flags and 91 % of live September flags; a mixed
   *  graduation seeds a median 0.16 SOL into the pool against exactly
   *  84.99 SOL for a classic one, and mixed graduates held a median 0.008×
   *  of the flag price an hour later (labeler + reviewer r3). */
  regime?: 'classic' | 'mixed' | 'unknown';
}

/** What happened after the flags of the measured day, for the +60 s window.
 *  Test day 2026-07-27 (held out), 873 launches flagged by the shipped rule,
 *  791 of them with a SOL price. Graduated 18.4 % (n 873); +50 % before
 *  −25 % inside the hour 32.6 %, a 25 % trailing stop beating 1.035× 24.9 %
 *  (n 791); no trade 5–10 min after the flag 39.4 % (n 873). Live on
 *  2026-09-10/11 (n 2,633) 11.0 % graduated. The +120 s window has too few
 *  flags (n 132) for an honest line. Source: E:\data\work\runner-outcome-2026-09-11
 *  (flag-eval, reviewer r1). */
export const FLAG_FORWARD_LINE: Record<60 | 120, string | null> = {
  60: 'Of 873 flagged like this on 2026-07-27: 18 in 100 graduated (11 in 100 live on 09-10/11) · 33 in 100 reached +50 % before −25 % within the hour · 25 in 100 beat break-even on a 25 % trailing stop · 39 in 100 had no trade at 10 min.',
  120: null,
};

/** One sentence on the curve regime for a flag, or null when it adds nothing. */
export function regimeLine(regime: RunnerFlag['regime']): string | null {
  if (regime === 'mixed') return 'Mixed curve: on the measured day these graduated into a pool seeded with ~0.16 SOL, not 85, and held a median 0.008× of the flag price an hour later.';
  return null;
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
/** Mark a flagged launch's creator sell. Returns the new list, or null when
 *  nothing changed (mint not flagged, or already marked). */
export function markCreatorSold<T extends { mint: string; creatorSoldAt?: number | null }>(list: T[], mint: string, at: number): T[] | null {
  let changed = false;
  const out = list.map((r) => {
    if (r.mint !== mint || (r.creatorSoldAt !== undefined && r.creatorSoldAt !== null)) return r;
    changed = true;
    return { ...r, creatorSoldAt: at };
  });
  return changed ? out : null;
}

export function pruneRunners<T extends { flaggedAt: number }>(list: T[], now: number, ttlMs = RUNNER_TTL_MS): T[] {
  return list.filter((r) => now - r.flaggedAt < ttlMs);
}

/** Trades the scanner keeps per launch for the odds judge. A launch that
 *  fills this inside its first 130 s is an unknown to the judge (its window
 *  features are floors and the last-10-s rate reads 0) — never a zero. */
export const ODDS_TAPE_CAP = 5000;

export function runnerVerdict(
  report: OddsReport | null,
  cfg: RunnerAlertSettings,
  ctx: { hardRejected: boolean; creatorSold: boolean; alreadyFlagged: boolean; tapeTruncated?: boolean; nonSolQuote?: boolean },
): RunnerVerdict {
  if (!cfg.enabled) return { flag: false, reason: 'runner alerts off' };
  if (ctx.alreadyFlagged) return { flag: false, reason: 'already flagged' };
  if (ctx.hardRejected) return { flag: false, reason: 'hard reject' };
  if (ctx.creatorSold) return { flag: false, reason: 'creator sold' };
  if (ctx.tapeTruncated) return { flag: false, reason: 'odds tape truncated (too many trades to score honestly)' };
  // A curve whose SOL reserves read 0 is quoted in something other than SOL:
  // every SOL feature is 0, the count features are a launch farm's (9 % of
  // 07-27 flags, one creator behind 54 of 91), no rug rule can fire, and the
  // builder refuses to buy it. Unknown quote → not scored.
  if (ctx.nonSolQuote) return { flag: false, reason: 'curve is not quoted in SOL (unknown quote) — not scored' };
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
  const regime = regimeLine(f.regime);
  const body =
    `${f.name || f.symbol} · ${f.curvePct.toFixed(0)} % of supply sold · ${f.uniqueBuyers} buyers · +${f.netInflowSol.toFixed(2)} SOL net at ${f.windowS} s. ` +
    `Graduation odds bucket ${bucketLabel(f.bucket)}: ${f.observedPct.toFixed(0)} % of these graduated (base ${f.basePct.toFixed(1)} %), ` +
    `${failPct.toFixed(0)} % did not.${regime ? ` ${regime}` : ''} Open the token to decide — nothing is bought for you.`;
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
