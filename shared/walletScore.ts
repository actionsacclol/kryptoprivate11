// The Copy score — a Krypt score for WALLETS (2026-09-20).
//
// The coin score asks "would I be safe buying this?" and averages the checks
// that resolved. This asks the one question the Scout exists for: "if I had
// mirrored this wallet, what would I have got?" — and it is built on the
// finding that decides everything about it (docs/wallet-convergence-2026-09-14.md):
//
//   * Top wallets are real and their edge persists day to day. But ranking
//     them by THEIR OWN PnL selects for snipers whose median hold is six
//     seconds — the wallets a follower cannot be inside. Their edge is
//     latency, which is the one thing a copy cannot copy.
//   * Ranking by what a FOLLOWER realises — entering at the first print after
//     a lag, exiting the same way, net of cost — persists monotonically
//     across all ten deciles in two periods six weeks apart, and halves the
//     loss of the naive ranking. It does not reach profit: no decile was
//     positive; the best lost ~1–3 % per copied trade after costs.
//
// So every input here is what a follower would have realised, measured from
// the prints the feed actually saw, not what the wallet made. The score
// ranks LEAST-BAD TO FOLLOW. It is never an edge and the UI must not call
// it one. Honest-null throughout: a check that could not be measured is not
// counted, and under three resolved checks — or five closed trips — there
// is no score at all.

/**
 * The lag a follower fills at, on both legs. The app's own copier measured
 * ~1.4 s from a leader's print to a landed order on top of feed latency;
 * two seconds is what it actually gets, not the 800 ms an in-house bot might.
 */
export const FOLLOWER_LAG_MS = 2_000;
/** No print on the mint for this long after the lag: the follower could not
 *  have filled at all (an illiquid or dead coin). The trip is unreachable. */
export const FOLLOWER_FILL_STALE_MS = 10 * 60_000;
/** Cost per side a follower pays on pump: the venue's 1 % plus Krypt's 0.5 %.
 *  Slippage is NOT modelled — the score is optimistic by that much, and the
 *  drawer says so. */
export const FOLLOWER_COST_PER_SIDE = 0.015;

/** The follower's net round-trip return, in %, buying at `entry` and selling
 *  at `exit` with the per-side cost on both legs. */
export function followerNetReturnPct(entryPrice: number, exitPrice: number, costPerSide = FOLLOWER_COST_PER_SIDE): number | null {
  if (!(entryPrice > 0) || !(exitPrice > 0) || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return null;
  const net = (exitPrice * (1 - costPerSide)) / (entryPrice * (1 + costPerSide)) - 1;
  return Number.isFinite(net) ? net * 100 : null;
}

/** Piecewise-linear map, clamped at the ends. Points must be x-ascending. */
export function ramp(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}

export type WalletFlag = 'bot' | 'thin' | 'unreachable' | 'concentrated' | 'partial';

/** Below this share of the window's trips judged, the copy figures describe
 *  a slice of the record, and the row says so. Records from before the
 *  model, and the first days after it, are mostly this. */
export const PARTIAL_COVERAGE = 0.5;

export interface WalletScoreInput {
  /** Closed round trips in the window (the wallet's own). */
  roundTrips: number;
  /** Trips a follower could have mirrored: both legs filled at the lag. */
  fTrips: number;
  /** Median follower net return over those, %. Null under the sample floor. */
  fMedianReturnPct: number | null;
  /** Share of follower trips that closed positive, %. */
  fWinRatePct: number | null;
  /** fTrips ÷ judged trips, %. Null when nothing has been judged. */
  reachablePct: number | null;
  /** Trips judged (filled or unreachable) — the reachable check resolves on
   *  these, so a record from before the model is not scored as unreachable. */
  judgedTrips: number;
  /** Days with at least one trade, and the window's span in days (null for
   *  a one-day window, where consistency means nothing). */
  activeDays: number;
  windowDays: number | null;
  /** Distinct mints traded (a floor once the record's cap is hit). */
  distinctMints: number;
  looksAutomated: boolean;
}

export interface WalletCheck {
  id: 'followerReturn' | 'followerWin' | 'reachable' | 'consistency' | 'focus';
  label: string;
  /** The measured figure as text, or an em dash. */
  value: string;
  /** 0..100 when resolved. */
  points: number | null;
  weight: number;
  resolved: boolean;
  /** One line a person can act on. */
  note: string;
}

export interface WalletScore {
  /** 0..100, or null: too few trips or too few checks resolved. */
  score: number | null;
  checks: WalletCheck[];
  resolved: number;
  total: number;
  flags: WalletFlag[];
}

/** Closed trips below which nothing here is a measurement. Matches the
 *  Scout's rank floor. */
export const SCORE_MIN_TRIPS = 5;
export const SCORE_MIN_RESOLVED = 3;

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}%`);

/**
 * Score a wallet over one window. Weighted average of the checks that
 * resolved; a check's weight is its bearing on "what would a copier get".
 *
 *   follower return  ×3   what the copy would have made, net, per trip
 *   follower win      ×2   how often it closed up
 *   reachable         ×2   how much of the record a copy could be inside
 *   consistency       ×1   trading across the window, not one lucky day
 *   focus             ×1   many mints once beats one mint many times
 */
export function scoreWallet(i: WalletScoreInput): WalletScore {
  const checks: WalletCheck[] = [];
  const enough = i.roundTrips >= SCORE_MIN_TRIPS;
  const fEnough = i.fTrips >= SCORE_MIN_TRIPS;

  // 1. Follower return. The measured top decile sat near −3 %; that is the
  //    "least bad" band, not a good one, so it scores in the middle.
  {
    const v = fEnough ? i.fMedianReturnPct : null;
    checks.push({
      id: 'followerReturn',
      label: 'Follower return',
      value: pct(v),
      points: v === null ? null : Math.round(ramp(v, [[-25, 0], [-10, 35], [-3, 60], [0, 75], [10, 100]])),
      weight: 3,
      resolved: v !== null,
      note:
        v === null
          ? `Median net return a copier would have made per trip. Needs ${SCORE_MIN_TRIPS} follower-priced trips (has ${i.fTrips}).`
          : `Median net return per copied trip at a ${FOLLOWER_LAG_MS / 1000} s lag, costs on both legs, no slippage modelled. Measured across the whole tape, even the best wallets sit near −3 %.`,
    });
  }
  // 2. Follower win rate.
  {
    const v = fEnough ? i.fWinRatePct : null;
    checks.push({
      id: 'followerWin',
      label: 'Follower win rate',
      value: pct(v),
      points: v === null ? null : Math.round(ramp(v, [[20, 0], [45, 60], [60, 100]])),
      weight: 2,
      resolved: v !== null,
      note: v === null ? 'Share of copied trips that closed up. Needs five follower-priced trips.' : 'Share of copied trips that closed up, net of costs. The tape-wide best is ~45 %.',
    });
  }
  // 3. Reachability — over the trips the model actually judged.
  {
    const v = enough && i.judgedTrips >= SCORE_MIN_TRIPS ? i.reachablePct : null;
    checks.push({
      id: 'reachable',
      label: 'Reachable trips',
      value: pct(v),
      points: v === null ? null : Math.round(ramp(v, [[0, 0], [50, 50], [90, 100]])),
      weight: 2,
      resolved: v !== null,
      note:
        v === null
          ? `Share of the wallet's trips a copy could have been inside. Needs ${SCORE_MIN_TRIPS} judged trips (has ${i.judgedTrips}).`
          : 'Share of the wallet\'s closed trips where a copy could fill both legs. The rest were over before a follower could land, or had no print to fill at.',
    });
  }
  // 4. Consistency — only when the window is wide enough to have days in it.
  {
    const span = i.windowDays !== null && i.windowDays >= 3 ? i.windowDays : null;
    const v = span !== null && enough ? Math.min(1, i.activeDays / span) : null;
    checks.push({
      id: 'consistency',
      label: 'Active days',
      value: span === null ? '—' : `${i.activeDays} of ${span}`,
      points: v === null ? null : Math.round(ramp(v, [[0.1, 10], [0.5, 60], [0.9, 100]])),
      weight: 1,
      resolved: v !== null,
      note: span === null ? 'Days traded across the window. Meaningless over a single day.' : 'Days with a trade across the window. One good day is luck; a record is many.',
    });
  }
  // 5. Focus — trips per mint. Forty trips on two mints is an insider or a
  //    wash pattern, not a trader to mirror on the next coin.
  {
    const perMint = enough && i.distinctMints > 0 ? i.roundTrips / i.distinctMints : null;
    checks.push({
      id: 'focus',
      label: 'Coins per trip',
      value: perMint === null ? '—' : `${i.distinctMints} coins, ${i.roundTrips} trips`,
      points: perMint === null ? null : Math.round(ramp(perMint, [[1, 100], [2, 80], [3, 50], [6, 0]])),
      weight: 1,
      resolved: perMint !== null,
      note: perMint === null ? 'How spread the record is across coins.' : perMint >= 4 ? 'Most trips are on the same few coins — that is a relationship with those coins, not a knack for picking them.' : 'Trips are spread across coins, which is what a copy on the next coin needs.',
    });
  }

  let earned = 0;
  let possible = 0;
  let resolved = 0;
  for (const c of checks) {
    if (!c.resolved || c.points === null) continue;
    resolved += 1;
    earned += c.points * c.weight;
    possible += c.weight;
  }
  const score = enough && resolved >= SCORE_MIN_RESOLVED && possible > 0 ? Math.round(earned / possible) : null;

  const flags: WalletFlag[] = [];
  if (i.looksAutomated) flags.push('bot');
  if (!enough) flags.push('thin');
  if (enough && i.judgedTrips >= SCORE_MIN_TRIPS && i.reachablePct !== null && i.reachablePct < 25) flags.push('unreachable');
  // A score built on a small slice of a big record — the model has judged
  // fewer than half the window's trips. The number stands; the label says
  // what it stands on.
  if (enough && score !== null && i.judgedTrips < i.roundTrips * PARTIAL_COVERAGE) flags.push('partial');
  if (enough && i.distinctMints > 0 && i.roundTrips / i.distinctMints >= 4) flags.push('concentrated');

  return { score, checks, resolved, total: checks.length, flags };
}

/** The tone a score renders in. Null is a dash, never a colour. */
export function scoreTone(score: number | null): 'good' | 'mid' | 'bad' | null {
  if (score === null) return null;
  return score >= 70 ? 'good' : score >= 40 ? 'mid' : 'bad';
}
