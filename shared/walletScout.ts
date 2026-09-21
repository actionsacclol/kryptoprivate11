// Wallet Scout — what wallets on a chain actually did, over a window.
//
// Copy trading could already score a wallet, but only one you were ALREADY
// following: `LeaderStats` starts its record at the first swap it sees. There
// was no way to find a wallet worth following in the first place. This is that
// missing half, and it is a data tool — it reports what happened, day by day,
// and lets someone decide.
//
// ─── Why this is a RECORD and not a rating ───────────────────────────────
//
// Ranking wallets by PnL over a window selects for luck as much as skill: with
// thousands of wallets making a handful of trades each, the top of any such
// list is dominated by variance. This project has measured that shape twice —
// ranking liquidity providers turned out to rank token-picking (corr 0.936
// with price direction against 0.414 with fees), and a strategy that scored
// +24.37% in-sample came back −1.39% out of sample.
//
// So nothing here predicts. Every number is something we watched happen, over
// a window the user chose, and the UI says so. Whether a wallet's rank in one
// window says anything about the next is a question that can only be answered
// by measuring it once these records span time — which is why they persist.
//
// ─── Two things that would mislead if left unsaid ────────────────────────
//
//  * A small sample is not a record. `MIN_TRIPS_FOR_RANK` keeps a wallet with
//    two lucky trades off the top of the list.
//  * The top of a PnL board tends to be BOTS. The LP swarm's number-one
//    liquidity provider was a JIT bot holding positions for one block. A
//    sniper that wins on latency is not copyable by someone clicking a button,
//    so `looksAutomated` marks them rather than quietly ranking them.

import type { EvmChainKind } from './evm';
import { scoreWallet, type WalletFlag, type WalletScore } from './walletScore';

/** Solana plus the EVM chains — the Scout runs one book per chain. */
export type ScoutChain = 'solana' | EvmChainKind;

export const SCOUT_CHAINS: ScoutChain[] = ['solana', 'robinhood', 'bnb'];

/** Windows a user can ask for. `all` is everything still on disk. */
export type ScoutWindow = 'day' | 'week' | 'month' | 'all';

export const SCOUT_WINDOW_DAYS: Record<ScoutWindow, number | null> = {
  day: 1,
  week: 7,
  month: 30,
  all: null,
};

export const SCOUT_WINDOW_LABEL: Record<ScoutWindow, string> = {
  day: 'Today',
  week: '7 days',
  month: '30 days',
  all: 'All time',
};

/** Below this many closed round trips a wallet is not ranked. */
export const MIN_TRIPS_FOR_RANK = 5;

/** Days of history kept per wallet. Older buckets roll off. */
export const SCOUT_RETENTION_DAYS = 45;

/**
 * Tracked wallets per chain. Beyond this the store evicts — thin records
 * (below `MIN_TRIPS_FOR_RANK`) least-recently-active first, then ranked ones
 * least-recently-active. Named here so the page can say "capped" instead of
 * leaving a round number to look like a scan that stopped.
 */
export const SCOUT_MAX_TRACKED = 6_000;

/** How far back a manual scan reaches. */
export type ScoutScanHours = 1 | 6 | 24;
export const SCOUT_SCAN_HOURS: ScoutScanHours[] = [1, 6, 24];
export const SCOUT_SCAN_HOURS_LABEL: Record<ScoutScanHours, string> = { 1: '1 hour', 6: '6 hours', 24: '24 hours' };

/**
 * One manual scan, per chain. The record is fed from live decoders while the
 * collector runs; a scan reads the SAME trades from a historical source and
 * feeds them the same way, so a fresh install has a board before the feed has
 * been on for a day. Everything here is a count of something that happened.
 */
export interface ScoutScanStatus {
  chain: ScoutChain;
  running: boolean;
  /** Epoch ms of the last start, or null when never run this session. */
  startedAt: number | null;
  finishedAt: number | null;
  hours: ScoutScanHours;
  /** Units of work — tokens on Solana, block chunks on the EVM chains. */
  units: number;
  unitsDone: number;
  /** Trades read from the source. */
  read: number;
  /** Trades that became a record. */
  fed: number;
  /** Trades the store already had (the live feed saw them). */
  duplicates: number;
  /** Provider / RPC calls spent. */
  calls: number;
  /** Wallets on record before and after, so the result line can say what changed. */
  trackedBefore: number;
  trackedAfter: number;
  cancelled: boolean;
  /** Why it stopped, or what it could not read. Empty while all is well. */
  message: string;
}

/**
 * One day of one wallet's activity, on one chain.
 *
 * Daily buckets are what make every window cheap and rotation trivial: a week
 * is seven of these added up, and a day older than the retention window is
 * simply dropped.
 */
export interface ScoutDay {
  /** Days since the Unix epoch, local time. */
  day: number;
  buys: number;
  sells: number;
  /** Positions opened AND closed inside this day. */
  roundTrips: number;
  wins: number;
  losses: number;
  /** Realised SOL/ETH/BNB from trips closed this day. */
  pnl: number;
  /** Native put into positions this day. */
  volume: number;
  /**
   * What a FOLLOWER would have got (2026-09-20, shared/walletScore.ts): trips
   * closed this day where a copy could fill both legs at the lag, how many
   * closed up, and each one's net return %. Optional because records written
   * before this existed have none — absent is "not measured", never zero.
   */
  fTrips?: number;
  fWins?: number;
  fReturns?: number[];
  /** Trips closed this day a follower could NOT have been inside: the leader
   *  was out before a fill, or no print ever came to fill at. */
  unreachable?: number;
  /** Trips that opened and closed inside COPY_LATENCY_FLOOR (60 s). */
  fast?: number;
  /** Trips closed since the follower model existed — the denominator for
   *  `fast`. Records from before it have none, and read as unmeasured. */
  measured?: number;
}

/** One of a wallet's recent closed trips, for the detail drawer. */
export interface ScoutTrip {
  mint: string;
  openedAt: number;
  closedAt: number;
  /** Native the wallet put in and took out. */
  cost: number;
  pnl: number;
  holdMs: number;
  /** The follower's net return on this trip, %, or null with why. */
  followerReturnPct: number | null;
  followerNote: 'filled' | 'too-fast' | 'no-entry' | 'no-exit';
}

export interface ScoutWallet {
  chain: ScoutChain;
  address: string;
  firstSeen: number;
  lastSeen: number;
  /** Newest first, capped at SCOUT_RETENTION_DAYS. */
  days: ScoutDay[];
  /** Positions open right now — cost only; unrealised is not claimed. */
  openCount: number;
  openCost: number;
  /**
   * Median hold in ms across closed trips, or null below a usable sample.
   * The single most useful signal for "can I actually copy this?" — a wallet
   * whose median hold is two seconds is a bot.
   */
  medianHoldMs: number | null;
  /** Distinct mints traded (a floor once the record's cap is reached). */
  distinctMints?: number;
  /** Newest first, capped. */
  recentTrips?: ScoutTrip[];
}

/** A wallet's record over ONE window. Every field is measured. */
export interface ScoutRow {
  chain: ScoutChain;
  address: string;
  window: ScoutWindow;
  buys: number;
  sells: number;
  roundTrips: number;
  wins: number;
  losses: number;
  pnl: number;
  volume: number;
  /** pnl ÷ volume as a percentage, or null when nothing was spent. */
  returnPct: number | null;
  /** wins ÷ roundTrips as a percentage, or null below the sample floor. */
  winRatePct: number | null;
  medianHoldMs: number | null;
  lastSeen: number;
  /** Enough closed trips in this window to be ranked. */
  ranked: boolean;
  /**
   * Holds for seconds and trades constantly — a bot, and not copyable by a
   * person clicking a button. Marked, never silently ranked above a human.
   */
  looksAutomated: boolean;

  // ── What a follower would have got (2026-09-20) ────────────────────
  /** Trips a copy could have mirrored at the lag, both legs filled. */
  fTrips: number;
  /** Median follower net return over those, %. Null under five. */
  fMedianReturnPct: number | null;
  fWinRatePct: number | null;
  /** fTrips ÷ judged trips, %, where judged = filled + unreachable (a trip
   *  still waiting for its exit print is neither). Null when nothing has
   *  been judged — a record from before the follower model is not 0 %. */
  reachablePct: number | null;
  /** Trips judged so far: the denominator behind `reachablePct`. */
  judgedTrips: number;
  /** Share of measured trips that opened and closed inside a minute, %. */
  fastPct: number | null;
  activeDays: number;
  distinctMints: number;
  /** The Copy score, 0..100 — least-bad to follow, never an edge. */
  copyScore: number | null;
  flags: WalletFlag[];
}

export type ScoutSort = 'copyScore' | 'pnl' | 'returnPct' | 'winRatePct' | 'roundTrips' | 'volume' | 'fMedianReturnPct';

export const SCOUT_SORT_LABEL: Record<ScoutSort, string> = {
  copyScore: 'Copy score',
  fMedianReturnPct: 'Follower return',
  pnl: 'Their profit',
  returnPct: 'Their return',
  winRatePct: 'Their win rate',
  roundTrips: 'Round trips',
  volume: 'Volume',
};
export const SCOUT_SORTS: ScoutSort[] = ['copyScore', 'fMedianReturnPct', 'pnl', 'returnPct', 'winRatePct', 'roundTrips', 'volume'];

/**
 * The id a trade is remembered by, so the live feed and a manual scan agree
 * on what "the same trade" is. `tx` is the signature on Solana and
 * `hash:logIndex` on the EVM chains; the rest pins one fill inside a
 * transaction that carries several (a bundle buying two mints, a router
 * filling twice).
 */
export function tradeId(tx: string, mint: string, address: string, isBuy: boolean): string {
  return `${tx}|${mint.toLowerCase()}|${address.toLowerCase()}|${isBuy ? 'b' : 's'}`;
}

/** Local day number for a timestamp. */
export function dayOf(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 86_400_000);
}

/**
 * A wallet trading this fast, holding this briefly, is automated.
 *
 * Deliberately conservative — being wrong here labels a real trader a bot, so
 * it takes BOTH a sub-10-second median hold and real volume of trips. A person
 * cannot hold for eight seconds thirty times.
 */
export function looksAutomated(medianHoldMs: number | null, roundTrips: number): boolean {
  return medianHoldMs !== null && medianHoldMs < 10_000 && roundTrips >= 10;
}

/** Sum a wallet's daily buckets over a window, ending today. */
export function summarise(w: ScoutWallet, window: ScoutWindow, now = Date.now()): ScoutRow {
  const span = SCOUT_WINDOW_DAYS[window];
  const today = dayOf(now);
  const from = span === null ? -Infinity : today - (span - 1);
  const days = w.days.filter((d) => d.day >= from && d.day <= today);

  const sum = (pick: (d: ScoutDay) => number): number => days.reduce((a, d) => a + pick(d), 0);
  const roundTrips = sum((d) => d.roundTrips);
  const wins = sum((d) => d.wins);
  const volume = sum((d) => d.volume);
  const pnl = sum((d) => d.pnl);
  const ranked = roundTrips >= MIN_TRIPS_FOR_RANK;

  // The follower's side of the same days.
  const fTrips = sum((d) => d.fTrips ?? 0);
  const fWins = sum((d) => d.fWins ?? 0);
  const fast = sum((d) => d.fast ?? 0);
  const unreachable = sum((d) => d.unreachable ?? 0);
  const measured = sum((d) => d.measured ?? 0);
  const fReturns = days.flatMap((d) => d.fReturns ?? []).sort((a, b) => a - b);
  const fMedianReturnPct = fTrips >= MIN_TRIPS_FOR_RANK && fReturns.length ? fReturns[Math.floor(fReturns.length / 2)] : null;
  const fWinRatePct = fTrips >= MIN_TRIPS_FOR_RANK ? (fWins / fTrips) * 100 : null;
  // Judged = filled or unreachable. A trip waiting for its exit print is
  // neither, and a record from before the model has none — both are "not
  // measured", never "0 % reachable".
  const judgedTrips = fTrips + unreachable;
  const reachablePct = judgedTrips > 0 ? (fTrips / judgedTrips) * 100 : null;
  const fastPct = measured > 0 ? Math.min(100, (fast / measured) * 100) : null;
  const activeDays = days.filter((d) => d.buys + d.sells > 0).length;
  // 'all' spans the record itself; a one-day window has no span to judge.
  const windowDays = span === null ? Math.max(1, today - dayOf(w.firstSeen) + 1) : span;
  const distinctMints = w.distinctMints ?? 0;
  const automated = looksAutomated(w.medianHoldMs, roundTrips);
  const scored = scoreWallet({
    roundTrips,
    fTrips,
    fMedianReturnPct,
    fWinRatePct,
    reachablePct,
    judgedTrips,
    activeDays,
    windowDays: windowDays >= 3 ? windowDays : null,
    distinctMints,
    looksAutomated: automated,
  });

  return {
    chain: w.chain,
    address: w.address,
    window,
    buys: sum((d) => d.buys),
    sells: sum((d) => d.sells),
    roundTrips,
    wins,
    losses: sum((d) => d.losses),
    pnl,
    volume,
    // Unknown, not 0: a wallet that spent nothing has no return to report.
    returnPct: volume > 0 ? (pnl / volume) * 100 : null,
    // A win rate off two trades is noise wearing a percentage sign.
    winRatePct: ranked ? (wins / roundTrips) * 100 : null,
    medianHoldMs: w.medianHoldMs,
    lastSeen: w.lastSeen,
    ranked,
    looksAutomated: automated,
    fTrips,
    fMedianReturnPct,
    fWinRatePct,
    reachablePct,
    judgedTrips,
    fastPct,
    activeDays,
    distinctMints,
    copyScore: scored.score,
    flags: scored.flags,
  };
}

/** The score with its checks, for a row already summarised — the drawer. */
export function scoreOfRow(r: ScoutRow, windowDays: number | null): WalletScore {
  return scoreWallet({
    roundTrips: r.roundTrips,
    fTrips: r.fTrips,
    fMedianReturnPct: r.fMedianReturnPct,
    fWinRatePct: r.fWinRatePct,
    reachablePct: r.reachablePct,
    judgedTrips: r.judgedTrips,
    activeDays: r.activeDays,
    windowDays,
    distinctMints: r.distinctMints,
    looksAutomated: r.looksAutomated,
  });
}

/** An empty row for a saved wallet with no record yet. */
export function emptyRow(chain: ScoutChain, address: string, window: ScoutWindow): ScoutRow {
  return {
    chain,
    address,
    window,
    buys: 0,
    sells: 0,
    roundTrips: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    volume: 0,
    returnPct: null,
    winRatePct: null,
    medianHoldMs: null,
    lastSeen: 0,
    ranked: false,
    looksAutomated: false,
    fTrips: 0,
    fMedianReturnPct: null,
    fWinRatePct: null,
    reachablePct: null,
    judgedTrips: 0,
    fastPct: null,
    activeDays: 0,
    distinctMints: 0,
    copyScore: null,
    flags: ['thin'],
  };
}

/**
 * Rank rows for display.
 *
 * Order of precedence, and each step is a decision rather than a tie-break:
 *   1. wallets with enough trips to be ranked come first;
 *   2. among those, humans before bots — a bot may be the most profitable
 *      thing on the chain and still be uncopyable;
 *   3. then the chosen measure, descending, with unknown last;
 *   4. then more round trips, because a bigger sample is a better record.
 */
export function rankScout(rows: readonly ScoutRow[], by: ScoutSort): ScoutRow[] {
  const val = (r: ScoutRow): number | null => r[by];
  return [...rows].sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    if (a.looksAutomated !== b.looksAutomated) return a.looksAutomated ? 1 : -1;
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return b.roundTrips - a.roundTrips;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (vb !== va) return vb - va;
    return b.roundTrips - a.roundTrips;
  });
}

/** Drop buckets past retention. Returns a new array, newest first. */
export function rotate(days: readonly ScoutDay[], now = Date.now()): ScoutDay[] {
  const cutoff = dayOf(now) - (SCOUT_RETENTION_DAYS - 1);
  return [...days].filter((d) => d.day >= cutoff).sort((a, b) => b.day - a.day);
}
