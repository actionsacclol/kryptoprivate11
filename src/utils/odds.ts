import type { OddsBucket, CurveRegime } from '@shared/odds';

// Renderer-side vocabulary for the graduation-odds report (shared/odds.ts).
//
// The wording is fixed by docs/runner-odds-2026-08-30.md §7: a bucket is
// shown as its LABEL, the observed line for that bucket comes verbatim from
// the report, and nothing here invents a number. Tone follows the same rule
// as the rug badges — never green, never the word "runner": the top buckets
// are arc-gold, the next purple, the middle neutral, the rest muted.

/** Bucket order, best first. Used for the Discover sort and the "≥" filter. */
export const ODDS_BUCKET_ORDER: readonly OddsBucket[] = [
  'top1',
  'top1_5',
  'top5_10',
  'top10_25',
  'top25_50',
  'bottom50',
];

export const ODDS_BUCKET_LABEL: Record<OddsBucket, string> = {
  top1: 'Top 1 %',
  top1_5: 'Top 1–5 %',
  top5_10: 'Top 5–10 %',
  top10_25: '10–25 %',
  top25_50: '25–50 %',
  bottom50: 'Bottom 50 %',
};

/** 0 = best bucket … 5 = worst; null bucket sorts last. */
export function oddsBucketRank(bucket: OddsBucket | null | undefined): number {
  if (!bucket) return ODDS_BUCKET_ORDER.length;
  const i = ODDS_BUCKET_ORDER.indexOf(bucket);
  return i === -1 ? ODDS_BUCKET_ORDER.length : i;
}

/** Text tone for a bucket. Deliberately no emerald anywhere. */
export function oddsTone(bucket: OddsBucket): string {
  switch (bucket) {
    case 'top1':
    case 'top1_5':
      return 'text-arc-gold';
    case 'top5_10':
      return 'text-krypt-purple';
    case 'top10_25':
      return 'text-white/85';
    default:
      return 'text-krypt-muted';
  }
}

/** Border/background for a chip in the same family as the text tone. */
export function oddsChipClass(bucket: OddsBucket): string {
  switch (bucket) {
    case 'top1':
    case 'top1_5':
      return 'border-arc-gold/40 bg-arc-gold/10 text-arc-gold';
    case 'top5_10':
      return 'border-krypt-purple/40 bg-krypt-purple/15 text-krypt-purple';
    case 'top10_25':
      return 'border-white/15 bg-white/5 text-white/80';
    default:
      return 'border-white/10 bg-white/[0.03] text-krypt-muted';
  }
}

export const REGIME_LABEL: Record<CurveRegime, string> = {
  classic: 'classic curve',
  mixed: 'mixed curve',
  unknown: 'regime unknown',
};

export const ODDS_NOT_JUDGED = 'Not judged — under 60 s old, graduated, or first trades not read yet';
