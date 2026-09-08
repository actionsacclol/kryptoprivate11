// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — copy trading (term.txt section 11).
//
// PAPER IS THE DEFAULT AND THE POINT.
//
// Six months of adversarial research in `docs/` failed to find a profitable
// automated memecoin strategy on this data, and copying a wallet is exactly
// such a strategy — one whose edge you have not measured, delegated to a
// stranger who does not know you exist. term.txt asks for paper-copy mode
// ("simulate following this wallet for 7 days without risking money") and
// that is the honest primary: you follow a wallet on paper, the app keeps an
// unforgiving scorecard, and only then do you get to decide.
//
// Live copying exists, is off, and requires the same arming as every other
// real trade plus its own daily loss limit. The UI shows the paper record
// next to the switch, so the decision is made against evidence rather than
// against a follower count.
// ──────────────────────────────────────────────────────────────────────

export type CopyMode = 'paper' | 'live';

export type SizingMode =
  /** Always the same SOL amount, whatever they spent. */
  | 'fixed'
  /** A percentage of what they spent, capped. */
  | 'proportional';

export interface CopyConfig {
  id: string;
  /** Wallet being followed. */
  wallet: string;
  label: string;
  enabled: boolean;
  mode: CopyMode;

  sizing: SizingMode;
  /** `fixed`: SOL per trade. `proportional`: percent of their size. */
  sizeValue: number;
  /** Hard ceiling per copied trade, SOL. */
  maxTradeSol: number;

  /** Skip a copy when the token fails these. Null = no constraint. */
  minLiquidityUsd: number | null;
  maxMarketCapUsd: number | null;
  minKryptScore: number | null;
  /** Only copy tokens on these launchpads. Empty = any. */
  onlyPumpfun: boolean;

  /** Wait this long after their trade before copying, ms. */
  delayMs: number;
  maxSlippagePct: number;
  /** Mirror their sells too, proportionally to what we hold. */
  copySells: boolean;

  /** Stop copying for the day after losing this much (paper or live). */
  dailyLossLimitSol: number;
  /** Stop after this many copies in a day. */
  dailyTradeLimit: number;

  createdAt: number;
}

export interface CopyStats {
  configId: string;
  /** Paper and live are scored separately — they are different experiments. */
  mode: CopyMode;
  trades: number;
  wins: number;
  losses: number;
  /** Sum of realized PnL across closed copies, SOL. */
  realizedPnlSol: number;
  /** Currently open copies. */
  openCount: number;
  openCostSol: number;
  /** Skipped because a filter rejected the token. */
  skipped: number;
  /** Skipped because a limit was hit. */
  blocked: number;
  firstAt: number | null;
  lastAt: number | null;
}

export type CopyTradeState = 'open' | 'closed' | 'skipped';

export interface CopyTrade {
  id: string;
  configId: string;
  mode: CopyMode;
  wallet: string;
  mint: string;
  symbol: string;
  at: number;
  /** What they did. */
  theirSol: number;
  /** What we did (or would have done). */
  ourSol: number;
  entryPriceSol: number | null;
  exitPriceSol: number | null;
  closedAt: number | null;
  pnlSol: number | null;
  state: CopyTradeState;
  /** Why it was skipped, when it was. */
  reason: string | null;
  /**
   * `exit` = one sell mirrored from the leader (2026-09-08): a slice of a
   * copy, where `ourSol` is the cost basis of the share sold and `pnlSol`
   * its realised result. Absent = a copy (a buy). Until this existed a
   * leader's sell only marked the copy closed — no sell was placed, and the
   * history said "closed" over a wallet that still held every token.
   */
  kind?: 'exit';
  /** Exit: the copy it came out of. */
  parentId?: string;
  /** Exit: share of what we HELD that was sold, 1–100 — the leader's own fraction. */
  soldPct?: number;
  /** Copy: how much of it is still held, 0–100. Absent = all of it. */
  remainingPct?: number;
  /** Copy: realised across its exits so far, SOL. */
  realizedSol?: number;
  /** Transaction of a live fill, when there was one. */
  signature?: string | null;
}

/**
 * How a followed wallet is being watched. Since 2026-09-06 every followed
 * wallet has its own subscription on the live socket, and its swaps are
 * read from the transaction's balance deltas — so a leader trading through
 * Jupiter into Raydium or Meteora is seen, not only one on the pump.fun
 * curve. `over-cap` is the public socket's ten-subscription limit; a Helius
 * key lifts it.
 */
export interface CopyWatchStatus {
  state: 'watching' | 'connecting' | 'over-cap' | 'off';
  /** Last transaction seen from the wallet (any kind), ms. */
  lastSeenAt: number | null;
  /** Last SWAP decoded from it, ms. */
  lastSwapAt: number | null;
  seen: number;
  swaps: number;
}

export interface CopySnapshot {
  configs: CopyConfig[];
  stats: Record<string, CopyStats>;
  recent: CopyTrade[];
  /** Live copying is possible right now. */
  liveExecutable: boolean;
  liveBlockedReason: string | null;
  /** Per followed wallet: is it being watched, and when was it last seen. */
  watch: Record<string, CopyWatchStatus>;
  /** Per followed wallet: THEIR record, from every swap seen (below). */
  leaders: Record<string, LeaderStats>;
}

// ── The leader's own record ───────────────────────────────────────────
//
// The copy scorecard answers "what did following them cost or make ME,
// through my filters and delay". A user running five wallets on paper is
// asking a different question — "are they any good" — and the copies alone
// cannot answer it: the filters skip most of what a leader does. So every
// swap seen on a followed wallet is scored as THEIR trade (2026-09-08),
// average-cost per token, from the first buy seen to the sell that leaves
// nothing. A sell of tokens bought BEFORE we watched has no known cost and
// is counted, never scored — the record must not flatter itself with
// proceeds whose cost it did not see.

/** One of the leader's round trips: first buy seen → last sell. */
export interface LeaderRoundTrip {
  mint: string;
  symbol: string;
  /** SOL they spent on it while watched. */
  costSol: number;
  /** SOL they got back. */
  proceedsSol: number;
  pnlSol: number;
  openedAt: number;
  closedAt: number;
  buys: number;
  sells: number;
}

export interface LeaderStats {
  wallet: string;
  /** First swap seen, ms — the record starts here, not at their history. */
  watchedSince: number | null;
  lastTradeAt: number | null;
  buys: number;
  sells: number;
  /** Positions opened AND closed while watched. */
  roundTrips: number;
  wins: number;
  losses: number;
  /** Closed round trips plus the sold share of open ones, SOL. */
  realizedPnlSol: number;
  /** SOL they put into positions while watched. */
  volumeSol: number;
  openCount: number;
  openCostSol: number;
  /** Open positions at the last price known; null when none is priced. */
  unrealizedPnlSol: number | null;
  avgHoldMs: number | null;
  bestSol: number | null;
  worstSol: number | null;
  /** Sells (or parts of sells) of tokens bought before we watched. */
  unscoredSells: number;
  /** Buys + sells per day since the first swap seen. */
  tradesPerDay: number | null;
  /** Realised over cost across closed round trips, %. */
  returnPct: number | null;
  /** Newest first. */
  recentTrips: LeaderRoundTrip[];
}

export function emptyLeaderStats(wallet: string): LeaderStats {
  return {
    wallet,
    watchedSince: null,
    lastTradeAt: null,
    buys: 0,
    sells: 0,
    roundTrips: 0,
    wins: 0,
    losses: 0,
    realizedPnlSol: 0,
    volumeSol: 0,
    openCount: 0,
    openCostSol: 0,
    unrealizedPnlSol: null,
    avgHoldMs: null,
    bestSol: null,
    worstSol: null,
    unscoredSells: 0,
    tradesPerDay: null,
    returnPct: null,
    recentTrips: [],
  };
}

/** Win rate over closed round trips, or null before any closed. */
export function leaderWinRate(s: LeaderStats): number | null {
  const n = s.wins + s.losses;
  return n > 0 ? (s.wins / n) * 100 : null;
}

/** Fewer closed round trips than this and a rank says nothing — such a
 *  wallet sorts after every wallet with a real sample, whatever its number. */
export const MIN_TRIPS_FOR_RANK = 5;

export type LeaderRankKey = 'realizedPnlSol' | 'returnPct' | 'winRatePct' | 'tradesPerDay' | 'unrealizedPnlSol';

export const LEADER_RANK_KEYS: Array<{ key: LeaderRankKey; label: string }> = [
  { key: 'realizedPnlSol', label: 'Realized' },
  { key: 'returnPct', label: 'Return %' },
  { key: 'winRatePct', label: 'Win rate' },
  { key: 'tradesPerDay', label: 'Trades / day' },
  { key: 'unrealizedPnlSol', label: 'Unrealized' },
];

/** Best first by the chosen key. Small samples rank after real ones;
 *  unknowns (null) after everything; ties broken by more round trips. */
export function rankLeaders(list: LeaderStats[], by: LeaderRankKey): LeaderStats[] {
  const val = (s: LeaderStats): number | null => (by === 'winRatePct' ? leaderWinRate(s) : s[by]);
  const enough = (s: LeaderStats): boolean => s.roundTrips >= MIN_TRIPS_FOR_RANK;
  return [...list].sort((a, b) => {
    const ea = enough(a);
    const eb = enough(b);
    if (ea !== eb) return ea ? -1 : 1;
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return b.roundTrips - a.roundTrips;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (vb !== va) return vb - va;
    return b.roundTrips - a.roundTrips;
  });
}

export function defaultConfig(wallet: string, label: string): Omit<CopyConfig, 'id' | 'createdAt'> {
  return {
    wallet,
    label,
    enabled: false,
    // Paper. Always paper, until the user has a reason not to.
    mode: 'paper',
    sizing: 'fixed',
    sizeValue: 0.05,
    maxTradeSol: 0.1,
    minLiquidityUsd: 5_000,
    maxMarketCapUsd: null,
    minKryptScore: null,
    onlyPumpfun: false,
    delayMs: 0,
    maxSlippagePct: 15,
    copySells: true,
    dailyLossLimitSol: 0.25,
    dailyTradeLimit: 20,
  };
}

export function validateConfig(c: Omit<CopyConfig, 'id' | 'createdAt'>): { ok: boolean; message: string } {
  if (!c.wallet || c.wallet.length < 32) return { ok: false, message: 'Enter a valid wallet address' };
  if (!(c.sizeValue > 0)) return { ok: false, message: 'Size must be greater than zero' };
  if (c.sizing === 'proportional' && c.sizeValue > 500) {
    return { ok: false, message: 'Proportional size cannot exceed 500% of their trade' };
  }
  if (!(c.maxTradeSol > 0) || c.maxTradeSol > 25) {
    return { ok: false, message: 'Max per trade must be between 0 and 25 SOL' };
  }
  if (c.sizing === 'fixed' && c.sizeValue > c.maxTradeSol) {
    return { ok: false, message: 'Fixed size is above your own max per trade' };
  }
  if (c.delayMs < 0 || c.delayMs > 60_000) return { ok: false, message: 'Delay must be between 0 and 60 seconds' };
  if (c.maxSlippagePct <= 0 || c.maxSlippagePct > 50) {
    return { ok: false, message: 'Slippage must be between 0% and 50%' };
  }
  if (!(c.dailyLossLimitSol > 0)) return { ok: false, message: 'Set a daily loss limit' };
  if (!(c.dailyTradeLimit > 0) || c.dailyTradeLimit > 500) {
    return { ok: false, message: 'Daily trade limit must be between 1 and 500' };
  }
  return { ok: true, message: 'ok' };
}

/** How much we would copy for a trade of `theirSol`. */
export function copySize(c: CopyConfig, theirSol: number): number {
  const raw = c.sizing === 'fixed' ? c.sizeValue : theirSol * (c.sizeValue / 100);
  return Math.min(raw, c.maxTradeSol);
}

export function describeConfig(c: CopyConfig): string {
  const size = c.sizing === 'fixed' ? `${c.sizeValue} SOL` : `${c.sizeValue}% of their size`;
  return `${c.mode === 'paper' ? 'Paper-copy' : 'COPY'} ${c.label || `${c.wallet.slice(0, 6)}…`} at ${size} (max ${c.maxTradeSol})`;
}

/** Win rate, or null when nothing has closed yet. */
export function winRate(s: CopyStats): number | null {
  const closed = s.wins + s.losses;
  return closed > 0 ? (s.wins / closed) * 100 : null;
}
