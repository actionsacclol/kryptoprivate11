import { type ChainKind } from './evm';
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

/**
 * Which way a config trades against its leader (2026-09-20).
 *
 *   copy     buy when they buy, mirror their sells.
 *   reverse  buy when they SELL, sell when they buy back — and, because a
 *            leader almost never buys the same coin back, the position has
 *            its own exits: take-profit, stop-loss and a maximum hold.
 *
 * Reverse is the contrarian read of the same feed: the followability study
 * (docs/wallet-convergence-2026-09-14.md) found leaders' edge is latency
 * and their exits come early; fading an exit is a bet that the coin keeps
 * going after they leave. It is a bet, measured nowhere yet, so it starts
 * on paper like everything else and its scorecard is kept separately.
 */
export type CopyDirection = 'copy' | 'reverse' | 'fomo';
export const DEFAULT_EXIT_TAKE_PROFIT_PCT = 25;
export const DEFAULT_EXIT_STOP_LOSS_PCT = 20;
export const DEFAULT_EXIT_MAX_HOLD_MIN = 30;

/**
 * FOMO copy (2026-09-20): buy when SEVERAL wallets from a set pile into the
 * same coin inside a window — the crowd, not one leader. The set is one of:
 *
 *   followed   every wallet with an enabled copy or reverse config
 *   saved      the wallets saved on the Scout
 *   tracked    the tracked-wallet list (labels, alerts)
 *   top        the Scout's top N by Copy score over the last 7 days
 *
 * Measured, this is the pattern the followability study called
 * "convergence" (docs/wallet-convergence-2026-09-14.md): with 2, 3 and 4
 * top wallets converging on a coin within minutes, the FOLLOWER's outcome
 * got worse with every extra wallet — −15 % → −32 % at 60 min, monotone,
 * both periods. The crowd is late by construction. It ships because it is
 * asked for by name; it ships on paper, with that number on the form.
 */
export type FomoSource = 'followed' | 'saved' | 'tracked' | 'top';
export const FOMO_SOURCES: FomoSource[] = ['followed', 'saved', 'tracked', 'top'];
export const FOMO_SOURCE_LABEL: Record<FomoSource, string> = {
  followed: 'Followed wallets',
  saved: 'Saved Scout wallets',
  tracked: 'Tracked wallets',
  top: 'Top Scout wallets by Copy score',
};
export const DEFAULT_FOMO_MIN_WALLETS = 3;
export const DEFAULT_FOMO_WINDOW_SEC = 180;
export const DEFAULT_FOMO_TOP_N = 25;
/** Share of the wallets that triggered an entry that must have SOLD before
 *  the position follows them out. */
export const DEFAULT_FOMO_CROWD_EXIT_PCT = 50;
/** The `wallet` a FOMO config carries: it follows a set, not an address. */
export const FOMO_WALLET = 'fomo';
export const isFomo = (c: { direction?: CopyDirection | null }): boolean => c.direction === 'fomo';

export type SizingMode =
  /** Always the same SOL amount, whatever they spent. */
  | 'fixed'
  /** A percentage of what they spent, capped. */
  | 'proportional';

/** Which chain a config lives on; absent (every config saved before 2026-09-11) is Solana. */
export const chainOf = (c: { chain?: ChainKind | null }): ChainKind => c.chain ?? 'solana';

export interface CopyConfig {
  id: string;
  /**
   * The chain the followed wallet trades on and the copies go out on.
   * Solana leaders are watched through the wallet decoder on any DEX;
   * Robinhood Chain and BNB leaders through the Observatory's trade feed —
   * their launchpad-curve trades (Pons, four.meme) while a token is on its
   * curve, which is where a memecoin's first hours happen. Amounts in the
   * `…Sol` fields are in that chain's own coin.
   */
  chain?: ChainKind;
  /** Wallet being followed. */
  wallet: string;
  label: string;
  enabled: boolean;
  mode: CopyMode;
  /** Absent (every config saved before 2026-09-20) is `copy`. */
  direction?: CopyDirection;
  /**
   * The position's OWN exits — take-profit and stop-loss in percent gross of
   * entry, hold in minutes — judged on every price tick.
   *
   * On a reverse or FOMO config absent means the shipped default, never
   * "off": those positions have no leader sell to close them, and a bag with
   * no exit is held until the user notices. On a copy config absent means
   * off — the leader's sells govern — and a value set is an extra exit on
   * top of them.
   */
  exitTakeProfitPct?: number | null;
  exitStopLossPct?: number | null;
  exitMaxHoldMin?: number | null;
  /** FOMO only: the set watched, how many of them inside how many seconds
   *  trigger an entry, the N for `top`, and the crowd-exit share. Absent
   *  means the defaults. */
  fomoSource?: FomoSource | null;
  fomoMinWallets?: number | null;
  fomoWindowSec?: number | null;
  fomoTopN?: number | null;
  fomoCrowdExitPct?: number | null;

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

  // ── Filters every competitor ships and this app lacked (2026-09-21) ──
  // docs/copy-trade-competitors-2026-09-21.md. All optional; absent or null
  // is OFF, so every config saved before this day behaves exactly as it did.
  // Each one is a REFUSAL recorded on the scorecard, and a fact the engine
  // cannot read fails CLOSED — the same rule as the three filters above.
  /** Skip tokens under this market cap, USD. */
  minMarketCapUsd?: number | null;
  /** Their trade size band, in the chain's coin: a leader buy outside it is
   *  not copied (a 0.01 SOL probe is not a conviction buy; a 50 SOL one is
   *  a whale you cannot follow at your size). */
  minLeaderSol?: number | null;
  maxLeaderSol?: number | null;
  /** Token age band at the time of their buy, seconds. */
  minTokenAgeSec?: number | null;
  maxTokenAgeSec?: number | null;
  /** At most this many entries per token for this config; 1 = buy once.
   *  Skipped rows do not count, exits never do. */
  maxBuysPerToken?: number | null;
  /** Never copy these mints / tokens by these creators. */
  blockedMints?: string[] | null;
  blockedCreators?: string[] | null;
  /** A leader sell under this share of their bag is not mirrored, percent —
   *  a 3 % trim is noise; a copier chasing every trim pays the fee each time. */
  minLeaderSellPct?: number | null;
  /** Trailing stop, percent below the highest mark since entry. Armed from
   *  entry (a position that never rises stops at −X % like a stop-loss).
   *  Off unless set, on every direction. */
  exitTrailingPct?: number | null;

  /** Wait this long after their trade before copying, ms. */
  delayMs: number;
  maxSlippagePct: number;
  /** Mirror their sells too, proportionally to what we hold. */
  copySells: boolean;
  /**
   * Which of this install's Solana wallets signs the copies. Null (or
   * absent, for a config saved before 2026-09-11) is the active wallet. With
   * it, an active trading wallet and a copy wallet can be different, and two
   * leaders can be followed on two wallets at once — every config is its own
   * runner, and this is the wallet it runs on.
   */
  walletId?: string | null;

  /** Stop copying for the day after losing this much (paper or live). */
  dailyLossLimitSol: number;
  /** Stop after this many copies in a day. */
  dailyTradeLimit: number;
  /**
   * Burst wall: at most this many copies in any rolling 60 s (2026-09-09).
   *
   * The daily limit is checked against copies that have already RESOLVED, so
   * a leader who fires eight swaps in one slot could out-run it. The engine
   * now reserves a slot before it buys, and this is the second wall: it is a
   * REFUSAL, never a clamp or a queue — the copy is skipped and recorded.
   *
   * Optional so a config persisted before this field, or one arriving from an
   * IPC payload that does not carry it yet, still validates; the engine reads
   * it as DEFAULT_COPIES_PER_MINUTE when absent.
   */
  maxCopiesPerMinute?: number | null;

  createdAt: number;
}

/** Applied when a config does not carry `maxCopiesPerMinute`. */
export const DEFAULT_COPIES_PER_MINUTE = 10;
/** Blocked mints / creators per config. */
export const MAX_BLOCKLIST = 100;

/** A blocklist as the engine compares it: trimmed, empties dropped, deduped
 *  (Solana addresses are case-sensitive, EVM ones are not — both spellings
 *  are kept, and the engine tests both). Null when nothing is left. */
export function cleanBlocklist(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const a = v.trim();
    if (!a || a.length > 64 || out.includes(a)) continue;
    out.push(a);
    if (out.length >= MAX_BLOCKLIST) break;
  }
  return out.length ? out : null;
}

/** Is `address` on a blocklist — exact for Solana, case-insensitive for EVM. */
export function isBlocked(list: string[] | null | undefined, address: string | null | undefined): boolean {
  if (!list || !list.length || !address) return false;
  const lower = address.toLowerCase();
  return list.some((a) => a === address || a.toLowerCase() === lower);
}

export const directionOf = (c: { direction?: CopyDirection | null }): CopyDirection =>
  c.direction === 'reverse' ? 'reverse' : c.direction === 'fomo' ? 'fomo' : 'copy';

/**
 * A config's own exits. Reverse and FOMO fill the defaults in; a copy
 * config's are off unless set (its leader's sells are its exits). Null =
 * off for that one exit.
 */
export function ownExitsOf(c: Pick<CopyConfig, 'direction' | 'exitTakeProfitPct' | 'exitStopLossPct' | 'exitMaxHoldMin' | 'exitTrailingPct'>): {
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldMin: number | null;
  /** Never defaulted: a trailing stop is opt-in on every direction. */
  trailingPct: number | null;
} {
  const d = directionOf(c);
  const n = (v: number | null | undefined, dflt: number): number | null => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    return d === 'copy' ? null : dflt;
  };
  return {
    takeProfitPct: n(c.exitTakeProfitPct, DEFAULT_EXIT_TAKE_PROFIT_PCT),
    stopLossPct: n(c.exitStopLossPct, DEFAULT_EXIT_STOP_LOSS_PCT),
    maxHoldMin: n(c.exitMaxHoldMin, DEFAULT_EXIT_MAX_HOLD_MIN),
    trailingPct: typeof c.exitTrailingPct === 'number' && Number.isFinite(c.exitTrailingPct) && c.exitTrailingPct > 0 ? c.exitTrailingPct : null,
  };
}

/** A FOMO config's crowd rule, defaults filled in. */
export function fomoRuleOf(c: Pick<CopyConfig, 'fomoSource' | 'fomoMinWallets' | 'fomoWindowSec' | 'fomoTopN' | 'fomoCrowdExitPct'>): {
  source: FomoSource;
  minWallets: number;
  windowSec: number;
  topN: number;
  crowdExitPct: number;
} {
  const n = (v: number | null | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return {
    source: c.fomoSource && FOMO_SOURCES.includes(c.fomoSource) ? c.fomoSource : 'followed',
    minWallets: n(c.fomoMinWallets, DEFAULT_FOMO_MIN_WALLETS),
    windowSec: n(c.fomoWindowSec, DEFAULT_FOMO_WINDOW_SEC),
    topN: n(c.fomoTopN, DEFAULT_FOMO_TOP_N),
    crowdExitPct: n(c.fomoCrowdExitPct, DEFAULT_FOMO_CROWD_EXIT_PCT),
  };
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
  /** The config's chain at the time; absent = Solana. */
  chain?: ChainKind;
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
  /** Absent = a copy. A reverse row was opened by the leader SELLING; a
   *  FOMO row by a crowd, named in `triggeredBy`. */
  direction?: CopyDirection;
  /** FOMO: the wallets whose buys triggered this entry. */
  triggeredBy?: string[];
  /**
   * `exit` = one sell mirrored from the leader (2026-09-08): a slice of a
   * copy, where `ourSol` is the cost basis of the share sold and `pnlSol`
   * its realised result. Absent = a copy (a buy). Until this existed a
   * leader's sell only marked the copy closed — no sell was placed, and the
   * history said "closed" over a wallet that still held every token.
   */
  kind?: 'exit';
  /** Highest mark seen since entry, for the trailing stop (2026-09-21).
   *  Absent on older rows and read as the entry. */
  peakPriceSol?: number;
  /** Exit: the copy it came out of. */
  parentId?: string;
  /** Exit: share of what we HELD that this slice actually sold, 1–100.
   *  When the quantity is tracked this is measured from the fill; without a
   *  tracked quantity it falls back to the leader's own fraction. */
  soldPct?: number;
  /** Exit: what the LEADER sold, 1–100, when it differs from `soldPct`.
   *  They are the same on an exact mirror; they diverge when our sell came
   *  back short, and the difference is the thing worth seeing. */
  leaderPct?: number;
  /** Copy: how much of it is still held, 0–100. Absent = all of it. */
  remainingPct?: number;
  /** Copy: realised across its exits so far, SOL. */
  realizedSol?: number;
  /** Transaction of a live fill, when there was one. */
  signature?: string | null;
  /** Where the time went, their fill → ours (2026-09-21). Absent on rows
   *  written before it existed, and on an exit, which is timed by the
   *  leader's sell rather than by an entry race. */
  timing?: CopyTiming;

  // ── Quantities (2026-09-15) ────────────────────────────────────────
  //
  // Everything above sizes a copy in SOL, and until now a mirrored sell was
  // sized in SOL too: the leader's fraction scaled by this config's share of
  // what the wallet PAID for the bag. Two positions bought at different
  // prices do not hold tokens in proportion to what they cost, so that ratio
  // is not the token share — and when it came out low the sell went out
  // small while the book still wrote the leader's fraction down as done.
  // A user's NON copy exited at "100 %", sold 52 % of the remaining tokens,
  // and was marked closed over 83,236 tokens that never left the wallet.
  //
  // So a live copy now carries the only number that settles it: base units,
  // from the confirmed fill. Decimal strings, because a u64 of a 6-decimal
  // memecoin runs past what a double holds exactly.
  //
  // All optional: a row opened before this, a paper row, and a rail whose
  // host cannot read balances all leave them absent, and absent means
  // "unknown" — the old percentage path, honestly labelled.

  /** Copy: base units the confirmed buy actually delivered. */
  tokensRaw?: string | null;
  /** Copy: base units of `tokensRaw` this copy still holds. */
  tokensLeftRaw?: string | null;
  /** Decimals for every raw amount on this row. */
  tokenDecimals?: number | null;
  /** Exit: base units this slice actually removed from the wallet. */
  soldRaw?: string | null;
  /** Exit: base units the sell was ASKED for, when it came back short. */
  wantedRaw?: string | null;
  /**
   * Copy: base units still in the wallet after this copy was marked closed.
   *
   * The balance sweep sets it. Non-null is a flag, not bookkeeping: the app
   * is saying "our record says done, the chain says these are still here".
   */
  leftoverRaw?: string | null;
}

/** A raw base-unit string as a bigint, or null when it is absent or junk. */
export function rawOf(s: string | null | undefined): bigint | null {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/** Whole tokens for a raw amount, for display only — never for sizing. */
export function uiTokens(raw: bigint, decimals: number | null | undefined): number {
  const d = typeof decimals === 'number' && decimals >= 0 && decimals <= 18 ? decimals : 0;
  return Number(raw) / 10 ** d;
}

/**
 * Below this share of the copy's original quantity, a remainder is dust.
 *
 * A sell is a share of a balance that moves under it, so the last few base
 * units routinely do not leave — and a copy held open over 40 base units of
 * a 1e15 position is noise dressed as a finding. 0.5 % matches the
 * `remainingPct` threshold the percentage path has always closed on.
 */
export const EXIT_DUST_PCT = 0.5;

/** Is `left` dust against an original quantity of `total`? */
export function isDustRemainder(left: bigint, total: bigint): boolean {
  if (left <= 0n) return true;
  if (total <= 0n) return false;
  return left * 1_000n <= total * BigInt(Math.round(EXIT_DUST_PCT * 10));
}

/**
 * How a followed wallet is being watched. Since 2026-09-06 every followed
 * wallet has its own subscription on the live socket, and its swaps are
 * read from the transaction's balance deltas — so a leader trading through
 * Jupiter into Raydium or Meteora is seen, not only one on the pump.fun
 * curve. `over-cap` means THE HOST refused a subscription and the watcher
 * learned a ceiling from that refusal — it is never an invented number.
 * Measured 2026-09-09: the public endpoint acked 16 subscriptions on ONE
 * socket, and `x-ratelimit-pubsub-limit: 10` counts CONNECTIONS per IP, not
 * subscriptions per socket. The old reading silently unwatched leaders past
 * ten and told the user to buy a key for a limit that does not exist.
 */
export interface CopyWatchStatus {
  state: 'watching' | 'connecting' | 'over-cap' | 'off';
  /** Last transaction seen from the wallet (any kind), ms. */
  lastSeenAt: number | null;
  /** Last SWAP decoded from it, ms. */
  lastSwapAt: number | null;
  seen: number;
  swaps: number;
  /** Seen but never readable from the RPC after every retry — those trades
   *  were NOT copied (2026-09-20). Absent on status built before it. */
  unreadable?: number;
  /** Read, but not a copyable swap (transfers, LP moves, claims). */
  notSwap?: number;
  /** Which subscription the socket rides (2026-09-21): `logs` reads each
   *  trade back, `tx` (Helius transactionSubscribe, paid plans) receives it
   *  with the notification. Absent on status built before it. */
  feed?: 'logs' | 'tx';
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
  /**
   * The store existed but could not be read, so nothing is being saved this
   * session (2026-09-09). Null on a healthy load. Optional so a snapshot
   * built before this field still satisfies the type.
   */
  loadFailure?: string | null;
  /** Per FOMO config (2026-09-20): which set it listens to and how many
   *  wallets that set holds right now. Zero is an honest zero — a source the
   *  host cannot answer, or a Scout with nothing saved. */
  crowd?: Record<string, { source: FomoSource; wallets: number }>;
  /** Where the time goes on a copy, this session (2026-09-21). Absent on a
   *  snapshot built before it existed. */
  latency?: CopyLatency;
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
  /** MEDIAN hold across closed round trips, ms. `avgHoldMs` is dragged by one
   *  long position; the median is what the wallet usually does, and on the
   *  measured tape the two differ by orders of magnitude. */
  medianHoldMs: number | null;
  /** Share of closed round trips that opened AND closed faster than
   *  `COPY_LATENCY_FLOOR_MS` — trips a copier could not have been inside.
   *  Null before any trip closes. */
  tooFastPct: number | null;
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
    medianHoldMs: null,
    tooFastPct: null,
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

/**
 * Below this hold, a round trip is not copyable — not "worse", NOT copyable.
 *
 * A copier has to see the leader's buy on the feed, decide, build, sign and
 * land; then do the whole thing again to exit. A position that opens and
 * closes inside this window was over before a follower could be in it, so the
 * leader's profit on it is unreachable by construction.
 *
 * The number matters because of what the tape says. Measured over 9.3M curve
 * trades across two day-pairs six weeks apart
 * (docs/wallet-convergence-2026-09-14.md), the MEDIAN profitable pump wallet
 * holds SIX SECONDS. Their edge is latency. Ranking them by their own PnL —
 * which is what this file did until 2026-09-14 — therefore surfaces precisely
 * the wallets a user cannot copy.
 *
 * One minute is deliberately generous: it is not a claim that a 61-second trip
 * is comfortably copyable, only that a sub-minute one certainly is not.
 */
export const COPY_LATENCY_FLOOR_MS = 60_000;

/**
 * A wallet is flagged when most of its record is unreachable.
 *
 * Deliberately NOT a quality score. The same measurements found that longer
 * holds are not more profitable to follow — the 1-10 minute bucket was WORSE
 * than the sub-minute one, and no hold bucket was profitable in either period.
 * So this says "you could not have been in these trades", never "these trades
 * are good".
 */
export const TOO_FAST_FLAG_PCT = 50;

export type LeaderRankKey =
  | 'realizedPnlSol' | 'returnPct' | 'winRatePct' | 'tradesPerDay' | 'unrealizedPnlSol' | 'medianHoldMs';

export const LEADER_RANK_KEYS: Array<{ key: LeaderRankKey; label: string }> = [
  { key: 'realizedPnlSol', label: 'Realized' },
  { key: 'returnPct', label: 'Return %' },
  { key: 'winRatePct', label: 'Win rate' },
  { key: 'tradesPerDay', label: 'Trades / day' },
  { key: 'unrealizedPnlSol', label: 'Unrealized' },
  // Longest first, so the wallets a copy could actually be inside are findable
  // at all. A sort order, not a recommendation.
  { key: 'medianHoldMs', label: 'Hold time' },
];

/** True when most of this wallet's closed trips were over before a copy could
 *  have joined them. Null-safe: an unmeasured wallet is never flagged. */
export function leaderTooFast(s: LeaderStats): boolean {
  return s.tooFastPct !== null && s.roundTrips >= MIN_TRIPS_FOR_RANK && s.tooFastPct >= TOO_FAST_FLAG_PCT;
}

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

// ── Copy Simple (2026-09-20) ──────────────────────────────────────────
//
// The simple page asks three things — whose wallet, how much per trade, and
// which chain when a 0x address does not say — and derives the rest. Same
// config, same store, same engine as the full page; only the questions are
// fewer. The derivation is here, not in the page, so a test can pin it and
// the full page can show exactly what the simple one saved.

/** The per-trade sizes the simple page offers, in the chain's native coin. */
export const SIMPLE_SIZES = [0.05, 0.1, 0.25, 0.5] as const;
/** The most the simple page will size a trade at; more needs the full page. */
export const SIMPLE_MAX_SOL = 5;
/** Daily loss limit as a multiple of the per-trade size. */
export const SIMPLE_LOSS_MULTIPLE = 10;

/** What kind of address this is, from its shape alone. Null = neither. */
export function chainForAddress(address: string): 'solana' | 'evm' | null {
  const a = address.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'solana';
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'evm';
  return null;
}

/**
 * The whole config from three answers. Fixed sizing at `perTrade` (clamped
 * to 0.001–SIMPLE_MAX_SOL; a bad number becomes the second offered size),
 * the per-trade cap equal to it, a daily loss limit of ten trades' worth,
 * paper, and switched ON — a paper follow has nothing to arm. Everything
 * else is `defaultConfig`, so a simple follow reads sensibly on the full page.
 */
export function simpleConfig(wallet: string, label: string, chain: ChainKind, perTrade: number): Omit<CopyConfig, 'id' | 'createdAt'> {
  const wanted = Number.isFinite(perTrade) && perTrade > 0 ? perTrade : SIMPLE_SIZES[1];
  const size = Math.round(Math.min(SIMPLE_MAX_SOL, Math.max(0.001, wanted)) * 1_000) / 1_000;
  const base = defaultConfig(wallet.trim(), label.trim(), chain, 'copy');
  return {
    ...base,
    enabled: true,
    mode: 'paper',
    sizing: 'fixed',
    sizeValue: size,
    maxTradeSol: size,
    dailyLossLimitSol: Math.round(size * SIMPLE_LOSS_MULTIPLE * 1_000) / 1_000,
    copySells: true,
  };
}

export function defaultConfig(wallet: string, label: string, chain: ChainKind = 'solana', direction: CopyDirection = 'copy'): Omit<CopyConfig, 'id' | 'createdAt'> {
  return {
    chain,
    wallet: direction === 'fomo' ? FOMO_WALLET : wallet,
    label,
    enabled: false,
    direction,
    // A copy's own exits are off; a reverse's or FOMO's are the defaults.
    exitTakeProfitPct: direction === 'copy' ? null : DEFAULT_EXIT_TAKE_PROFIT_PCT,
    exitStopLossPct: direction === 'copy' ? null : DEFAULT_EXIT_STOP_LOSS_PCT,
    exitMaxHoldMin: direction === 'copy' ? null : DEFAULT_EXIT_MAX_HOLD_MIN,
    fomoSource: direction === 'fomo' ? 'followed' : null,
    fomoMinWallets: direction === 'fomo' ? DEFAULT_FOMO_MIN_WALLETS : null,
    fomoWindowSec: direction === 'fomo' ? DEFAULT_FOMO_WINDOW_SEC : null,
    fomoTopN: direction === 'fomo' ? DEFAULT_FOMO_TOP_N : null,
    fomoCrowdExitPct: direction === 'fomo' ? DEFAULT_FOMO_CROWD_EXIT_PCT : null,
    // Paper. Always paper, until the user has a reason not to.
    mode: 'paper',
    sizing: 'fixed',
    sizeValue: 0.05,
    maxTradeSol: 0.1,
    minLiquidityUsd: 5_000,
    maxMarketCapUsd: null,
    minKryptScore: null,
    onlyPumpfun: false,
    minMarketCapUsd: null,
    minLeaderSol: null,
    maxLeaderSol: null,
    minTokenAgeSec: null,
    maxTokenAgeSec: null,
    maxBuysPerToken: null,
    blockedMints: null,
    blockedCreators: null,
    minLeaderSellPct: null,
    exitTrailingPct: null,
    delayMs: 0,
    maxSlippagePct: 15,
    copySells: true,
    walletId: null,
    dailyLossLimitSol: 0.25,
    dailyTradeLimit: 20,
    maxCopiesPerMinute: DEFAULT_COPIES_PER_MINUTE,
  };
}

export function validateConfig(c: Omit<CopyConfig, 'id' | 'createdAt'>): { ok: boolean; message: string } {
  // The full base58 shape, not just a length: this string is handed to the
  // wallet watcher to subscribe on, and `copy:resetStats` has always checked
  // it properly while the save path did not.
  const chain = chainOf(c);
  if (c.direction !== undefined && c.direction !== null && c.direction !== 'copy' && c.direction !== 'reverse' && c.direction !== 'fomo') {
    return { ok: false, message: 'Direction must be copy, reverse or fomo' };
  }
  if (isFomo(c)) {
    // A crowd, not an address. Solana only: the crowd is heard on the pump
    // curve feed, and the followed wallets on their own subscriptions.
    if (chain !== 'solana') return { ok: false, message: 'FOMO copying watches the Solana feeds only' };
    if (c.wallet !== FOMO_WALLET) return { ok: false, message: 'A FOMO config follows a set of wallets, not an address' };
  } else if (chain === 'solana') {
    if (!c.wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.wallet)) return { ok: false, message: 'Enter a valid wallet address' };
  } else if (!c.wallet || !/^0x[0-9a-fA-F]{40}$/.test(c.wallet)) {
    return { ok: false, message: `Enter a valid 0x address on ${chain === 'robinhood' ? 'Robinhood Chain' : 'BNB Smart Chain'}` };
  }
  if (c.walletId !== undefined && c.walletId !== null && (typeof c.walletId !== 'string' || !c.walletId)) return { ok: false, message: 'Pick a wallet to copy with, or leave it on the active one' };
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
  // Absent is allowed and means the default; present must be sane.
  if (c.maxCopiesPerMinute !== undefined && c.maxCopiesPerMinute !== null) {
    if (!(c.maxCopiesPerMinute > 0) || c.maxCopiesPerMinute > 120) {
      return { ok: false, message: 'Copies per minute must be between 1 and 120' };
    }
  }
  // Own exits: a value that is present must be sane, whatever the direction.
  const tp = c.exitTakeProfitPct;
  if (tp !== undefined && tp !== null && (!(tp > 0) || tp > 1_000)) return { ok: false, message: 'Take-profit must be between 1% and 1000%' };
  const sl = c.exitStopLossPct;
  if (sl !== undefined && sl !== null && (!(sl > 0) || sl > 95)) return { ok: false, message: 'Stop-loss must be between 1% and 95%' };
  const hold = c.exitMaxHoldMin;
  if (hold !== undefined && hold !== null && (!(hold > 0) || hold > 1_440)) return { ok: false, message: 'Max hold must be between 1 and 1440 minutes' };
  const trail = c.exitTrailingPct;
  if (trail !== undefined && trail !== null && (!(trail > 0) || trail > 95)) return { ok: false, message: 'Trailing stop must be between 1% and 95%' };
  // The 2026-09-21 filters. Absent or null is off; a value that is present
  // must be sane, and a band must not be empty.
  const opt = (v: number | null | undefined): number | null => (v === undefined || v === null ? null : v);
  const minMc = opt(c.minMarketCapUsd);
  if (minMc !== null && !(minMc >= 0)) return { ok: false, message: 'Min market cap must be zero or more' };
  if (minMc !== null && c.maxMarketCapUsd !== null && c.maxMarketCapUsd !== undefined && minMc > c.maxMarketCapUsd) {
    return { ok: false, message: 'Min market cap is above your max market cap' };
  }
  const minL = opt(c.minLeaderSol);
  const maxL = opt(c.maxLeaderSol);
  if (minL !== null && !(minL >= 0)) return { ok: false, message: 'Their minimum trade size must be zero or more' };
  if (maxL !== null && !(maxL > 0)) return { ok: false, message: 'Their maximum trade size must be greater than zero' };
  if (minL !== null && maxL !== null && minL > maxL) return { ok: false, message: 'Their minimum trade size is above the maximum' };
  const minAge = opt(c.minTokenAgeSec);
  const maxAge = opt(c.maxTokenAgeSec);
  if (minAge !== null && !(minAge >= 0)) return { ok: false, message: 'Token age must be zero or more' };
  if (maxAge !== null && !(maxAge > 0)) return { ok: false, message: 'Max token age must be greater than zero' };
  if (minAge !== null && maxAge !== null && minAge > maxAge) return { ok: false, message: 'Min token age is above the max' };
  const perToken = opt(c.maxBuysPerToken);
  if (perToken !== null && (!Number.isInteger(perToken) || perToken < 1 || perToken > 100)) return { ok: false, message: 'Max buys per token must be a whole number from 1 to 100' };
  for (const [list, what] of [[c.blockedMints, 'token'], [c.blockedCreators, 'creator']] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length > MAX_BLOCKLIST) return { ok: false, message: `At most ${MAX_BLOCKLIST} blocked ${what}s` };
    if (list.some((a) => typeof a !== 'string' || !a.trim() || a.length > 64)) return { ok: false, message: `A blocked ${what} must be an address` };
  }
  const minSell = opt(c.minLeaderSellPct);
  if (minSell !== null && (!(minSell > 0) || minSell > 100)) return { ok: false, message: 'Mirror sells of at least must be between 1% and 100%' };
  if (isFomo(c)) {
    if (c.fomoSource !== undefined && c.fomoSource !== null && !FOMO_SOURCES.includes(c.fomoSource)) return { ok: false, message: 'Pick which wallets the crowd is' };
    const k = c.fomoMinWallets;
    if (k !== undefined && k !== null && (!(k >= 2) || k > 50)) return { ok: false, message: 'FOMO needs between 2 and 50 wallets to trigger' };
    const w = c.fomoWindowSec;
    if (w !== undefined && w !== null && (!(w >= 10) || w > 3_600)) return { ok: false, message: 'FOMO window must be between 10 seconds and an hour' };
    const n = c.fomoTopN;
    if (n !== undefined && n !== null && (!(n >= 2) || n > 200)) return { ok: false, message: 'Top N must be between 2 and 200' };
    const x = c.fomoCrowdExitPct;
    if (x !== undefined && x !== null && (!(x >= 1) || x > 100)) return { ok: false, message: 'Crowd exit must be between 1% and 100%' };
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
  const who = c.label || `${c.wallet.slice(0, 6)}…`;
  const x = ownExitsOf(c);
  const exits = `+${x.takeProfitPct ?? '—'}% / −${x.stopLossPct ?? '—'}% / ${x.maxHoldMin ?? '—'} min`;
  if (directionOf(c) === 'reverse') {
    return `${c.mode === 'paper' ? 'Paper-reverse' : 'REVERSE'} ${who}: buy when they sell, ${size} (max ${c.maxTradeSol}), out at ${exits} or when they buy back`;
  }
  if (directionOf(c) === 'fomo') {
    const f = fomoRuleOf(c);
    return `${c.mode === 'paper' ? 'Paper-FOMO' : 'FOMO'} ${c.label || FOMO_SOURCE_LABEL[f.source]}: buy when ${f.minWallets} of ${FOMO_SOURCE_LABEL[f.source].toLowerCase()} buy the same coin within ${f.windowSec} s, ${size} (max ${c.maxTradeSol}), out at ${exits} or when ${f.crowdExitPct}% of them have sold`;
  }
  return `${c.mode === 'paper' ? 'Paper-copy' : 'COPY'} ${who} at ${size} (max ${c.maxTradeSol})`;
}

/** Win rate, or null when nothing has closed yet. */
export function winRate(s: CopyStats): number | null {
  const closed = s.wins + s.losses;
  return closed > 0 ? (s.wins / closed) * 100 : null;
}

// ── Copy latency (2026-09-21) ─────────────────────────────────────────
//
// A tester watching a leader wallet and their copy wallet side by side timed
// ~5–6 s from the leader's transaction to theirs landing, which on a low-cap
// launch is enough for the entry to move a long way. The question they could
// not answer from outside — how much of that is hearing about the trade and
// how much is placing ours — is the one this record answers.
//
// Every field is a DURATION in milliseconds, and every one is nullable
// because a stage that did not happen or could not be timed must read as
// unknown rather than as zero (the house rule: an em dash, never a 0). A
// paper copy has no `sendMs`; a trade delivered whole by `transactionSubscribe`
// has no `readMs`; a leader transaction with no block time has no `detectMs`.

export interface CopyTiming {
  /** Which subscription delivered it. `tx` carries the transaction with the
   *  notification; `logs` carries a signature and costs a read-back. */
  feed?: 'logs' | 'tx';
  /**
   * Their transaction's block time → the notification reaching us.
   *
   * This is the chain and the RPC, not us: it includes the wait for
   * `confirmed`, which is the commitment both subscriptions ask for. Null
   * when the transaction carried no block time.
   */
  detectMs: number | null;
  /** Reading the transaction back by signature. Null on the `tx` transport,
   *  which needs no read-back at all. */
  readMs: number | null;
  /** How many reads that took. More than 1 means the first answer was "the
   *  node does not have it yet", and each retry backs off. */
  readTries?: number;
  /** Decoding the swap out of the wallet's own balance deltas. */
  decodeMs: number | null;
  /** The filters, including the token-facts lookup — a round trip whenever
   *  the mint is not already cached, which for a fresh launch it is not. */
  checkMs: number | null;
  /**
   * The token-facts lookup ALONE, inside `checkMs`.
   *
   * Broken out because it is the one stage in the copier that can make a
   * network call on a mint nobody has seen before — which a leader's fresh
   * launch always is — and because a filter block that is otherwise pure
   * arithmetic should not be able to hide a round trip inside its total.
   */
  factsMs: number | null;
  /** The config's own `delayMs`, honoured as set. Not a cost to fix; here so
   *  it is not mistaken for one. */
  delayMs: number | null;
  /** Our order: handed over until the broadcast came back. Null in paper. */
  sendMs: number | null;
  /** Inside `sendMs`, from the signer: building the unsigned transaction. */
  buildMs?: number | null;
  /** Inside `sendMs`: first send → landed, failed or expired. */
  confirmMs?: number | null;
  /** Their block time → our order done. The number the tester was holding a
   *  stopwatch to. Null when either end is unknown. */
  totalMs: number | null;
}

/** Everything this record can account for, which is every stage but the
 *  chain's own. Used to show what the breakdown does NOT explain. */
export function accountedMs(t: CopyTiming): number {
  return (t.readMs ?? 0) + (t.decodeMs ?? 0) + (t.checkMs ?? 0) + (t.delayMs ?? 0) + (t.sendMs ?? 0);
}

/**
 * The breakdown as one line, for the Console and the exported logs.
 *
 * Ordered as it happens, so reading left to right is walking the path, and
 * an unknown stage is left OUT rather than printed as zero — a stage that
 * did not run and a stage that took no time are not the same fact.
 */
export function describeCopyTiming(t: CopyTiming): string {
  const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);
  const parts: string[] = [];
  if (t.detectMs !== null) parts.push(`heard ${ms(t.detectMs)}`);
  if (t.readMs !== null) parts.push(`read ${ms(t.readMs)}${t.readTries && t.readTries > 1 ? ` (${t.readTries} tries)` : ''}`);
  if (t.decodeMs !== null) parts.push(`decode ${ms(t.decodeMs)}`);
  if (t.checkMs !== null) {
    // The lookup is named inside the checks, not beside them, so the parts
    // still add up to the whole when read left to right.
    const facts = t.factsMs !== null ? ` [token facts ${ms(t.factsMs)}]` : '';
    parts.push(`checks ${ms(t.checkMs)}${facts}`);
  }
  if (t.delayMs) parts.push(`your delay ${ms(t.delayMs)}`);
  if (t.sendMs !== null) {
    const inner: string[] = [];
    if (t.buildMs != null) inner.push(`build ${ms(t.buildMs)}`);
    if (t.confirmMs != null) inner.push(`land ${ms(t.confirmMs)}`);
    parts.push(`order ${ms(t.sendMs)}${inner.length ? ` [${inner.join(', ')}]` : ''}`);
  }
  const head = t.totalMs !== null ? `${ms(t.totalMs)} their fill → ours` : 'timing';
  return `${head}${t.feed ? ` via ${t.feed}` : ''}: ${parts.join(' · ')}`;
}

/**
 * The median of each stage over recent copies.
 *
 * A median, not a mean: one copy that waited out a parked RPC would drag an
 * average somewhere no individual copy ever was, and the question being asked
 * is "what does this usually cost", not "what is the worst case". `samples`
 * says how many rows it is built from, so a median of two is not mistaken for
 * a measurement.
 *
 * Every field is null when no sample had that stage — a run entirely on the
 * `tx` transport has no read-back to report, and reporting 0 would read as
 * "instant" rather than "did not happen".
 */
export interface CopyLatency {
  samples: number;
  detectMs: number | null;
  readMs: number | null;
  decodeMs: number | null;
  checkMs: number | null;
  factsMs: number | null;
  delayMs: number | null;
  sendMs: number | null;
  totalMs: number | null;
  /** How the samples were delivered, so a median is read against the right
   *  transport. Both are counted; a mixed run says so. */
  feeds: { logs: number; tx: number };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Build the summary from whatever timed rows are to hand, newest first. */
export function copyLatency(rows: CopyTiming[]): CopyLatency {
  const of = (pick: (t: CopyTiming) => number | null | undefined): number | null =>
    median(rows.map(pick).filter((n): n is number => typeof n === 'number'));
  return {
    samples: rows.length,
    detectMs: of((t) => t.detectMs),
    readMs: of((t) => t.readMs),
    decodeMs: of((t) => t.decodeMs),
    checkMs: of((t) => t.checkMs),
    factsMs: of((t) => t.factsMs),
    delayMs: of((t) => t.delayMs),
    sendMs: of((t) => t.sendMs),
    totalMs: of((t) => t.totalMs),
    feeds: {
      logs: rows.filter((t) => t.feed === 'logs').length,
      tx: rows.filter((t) => t.feed === 'tx').length,
    },
  };
}
