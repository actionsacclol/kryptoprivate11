// pump.fun Callouts — the shape, and the rules for reading one honestly.
//
// A callout is someone publicly calling a coin: a thesis, a timestamp, and
// from then on a multiple that everyone can see. pump.fun ranks callers on a
// leaderboard and pays them out of the volume their call brings in, which is
// exactly why a callout is not intel on its own — the caller is paid for
// attention, not for being right.
//
// What makes it worth showing here is the one thing pump's own feed carries
// and its UI mostly does not: the caller's OWN POSITION in the coin they are
// calling. Held, cost, unrealised, realised. "Called it and already sold" is a
// fact about a call, and it is in the payload.
//
// Parsing lives in shared/ rather than in the provider so it can be tested
// against a captured payload with no network (test/callouts.test.mjs).
//
// House rule, and it matters more here than almost anywhere: a number that was
// not read is `null` and renders as an em dash. A callout page full of
// confident zeros would be lying about someone's money.

import type { ChainKind } from './evm';

/** The caller, and what they are actually holding of what they called. */
export interface Caller {
  /** pump's display name. */
  name: string | null;
  /** Their wallet — the same string Wallet Scout and the leader ranking use. */
  wallet: string | null;
  xUsername: string | null;
  verified: boolean;
  avatarUrl: string | null;
  /** How many calls they have made, ever. */
  totalCallouts: number | null;
  /** Tokens still held of the coin they called. 0 is a KNOWN zero here — it
   *  means they hold none, not that we failed to read it. */
  holds: number | null;
  positionUsd: number | null;
  costUsd: number | null;
  boughtUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  realizedUsd: number | null;
}

export interface Callout {
  id: string;
  mint: string;
  /** The chain, mapped to one this app trades. Null means pump calls it
   *  something this app has no rail for (hyperevm, arc) — the row still
   *  shows, it just cannot be opened. */
  chain: ChainKind | null;
  /** What pump called the chain. Kept so an unmappable row can say which. */
  rawChain: string;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  /** When the call was made (ms). */
  at: number;
  thesis: string | null;
  /** Market cap in USD when they called it. */
  calledAtMcapUsd: number | null;
  /** Market cap in USD now, as pump reports it. */
  mcapUsdNow: number | null;
  /** Price in USD at the call — the honest basis for computing a multiple
   *  against this app's own price rather than trusting pump's. */
  calloutPriceUsd: number | null;
  /**
   * The multiple since the call — DERIVED HERE, not repeated from pump.
   *
   * Measured 2026-09-18 on three calls, reading both routes for each: for the
   * same callout with the same `calledOutAtMcap`, `/home-feed` said 3.413 and
   * `/callout/top` said 5; 1.206 and 1.6; 15.77 and 60.9. Two numbers cannot
   * both be the multiple, and there is no way from outside to know which (the
   * per-coin route behaves like a peak, but behaving like one is not being
   * one). So neither is shown. `multiple` is `mcapUsdNow / calledAtMcapUsd`,
   * both of them pump's own figures off the same row, which is a number that
   * can at least be explained to whoever asks.
   *
   * `peakMultiple` cannot be derived — nothing in the payload says what the
   * price did in between — so it stays pump's `maxMultiplier`, and is null on
   * the per-coin route, which does not serve one.
   */
  multiple: number | null;
  peakMultiple: number | null;
  likes: number | null;
  replies: number | null;
  views: number | null;
  /** Follow-up posts the caller added to their own call. */
  updates: number | null;
  caller: Caller;
}

/**
 * pump's chain names are not this app's.
 *
 * `bsc` is what this app calls `bnb`. `hyperevm` and `arc` are real chains in
 * the feed that this app has no rail for, and they map to null: the row is
 * shown (a call is a call) but nothing offers to open or trade it.
 */
export function calloutChain(raw: unknown): ChainKind | null {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === 'solana') return 'solana';
  if (s === 'bsc' || s === 'bnb') return 'bnb';
  if (s === 'robinhood') return 'robinhood';
  return null;
}

/** A finite number, or null. Never coerces, never defaults to 0. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * A multiple we are willing to repeat.
 *
 * Measured 2026-09-18: `/callout/top` said 1.7 for a call that `/callout/list`
 * said was 0.0000141, while `maxMultiplier` said 1.025. One of those routes is
 * dividing by the wrong price. A multiple at or below zero is impossible, and
 * one over a million is a unit error rather than a 1,000,000x — both are
 * dropped, because an em dash is honest and a wrong multiple is the whole
 * reason someone would buy.
 */
function sane(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0 || n > 1e6) return null;
  return n;
}

/**
 * The multiple a call is up, from the two market caps on its own row.
 *
 * Null unless BOTH are real and positive: a call with no recorded size is a
 * call whose multiple nobody can compute, and 1x would read as "flat" when it
 * means "not known".
 */
export function derivedMultiple(calledAtMcapUsd: number | null, mcapUsdNow: number | null): number | null {
  if (calledAtMcapUsd === null || mcapUsdNow === null) return null;
  if (!(calledAtMcapUsd > 0) || !(mcapUsdNow > 0)) return null;
  return sane(mcapUsdNow / calledAtMcapUsd);
}

function str(v: unknown, max = 400): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** An ISO timestamp to ms, or null. */
function at(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Did the caller put money where their mouth is?
 *
 * - `holding`   they called it and hold it.
 * - `sold`      they called it, held it, and are out.
 * - `never`     they called it and never bought it.
 * - `null`      we could not read enough to say — say nothing.
 *
 * This is the one judgement this module makes, and it is made from the
 * caller's own numbers in pump's payload, not inferred from anything.
 */
export function skinInTheGame(c: Callout): 'holding' | 'sold' | 'never' | null {
  const { holds, boughtUsd, realizedUsd } = c.caller;
  if (holds === null) return null;
  if (holds > 0) return 'holding';
  // Held none. Whether that is "sold" or "never bought" needs the buy side.
  if (boughtUsd === null && realizedUsd === null) return null;
  if ((boughtUsd ?? 0) > 0 || (realizedUsd ?? 0) !== 0) return 'sold';
  return 'never';
}

/** One row of `GET /home-feed`. Exported for the provider's type only. */
type FeedCoin = Record<string, unknown>;

function parseCaller(p: Record<string, unknown>): Caller {
  return {
    name: str(p.userName, 60),
    wallet: str(p.walletAddress, 64),
    xUsername: str(p.xUsername, 60),
    verified: p.isVerified === true,
    avatarUrl: str(p.profileImage, 300),
    totalCallouts: num(p.totalCallouts),
    holds: num(p.amountHeld),
    positionUsd: num(p.valueUsd),
    costUsd: num(p.costBasisUsd),
    boughtUsd: num(p.amountBoughtUsd),
    pnlUsd: num(p.pnlUsd),
    pnlPct: num(p.pnlPercentage),
    realizedUsd: num(p.realizedPnlUsd),
  };
}

/**
 * `GET /home-feed` → the callouts in it.
 *
 * Every row that is missing a mint, an id or a timestamp is DROPPED rather
 * than filled in with a placeholder: this list is read at a glance and acted
 * on, and half a row is worse than no row. Returns [] for a payload that is
 * not the shape we expect, never throws — a feed that changed shape must
 * leave the panel empty and honest, not take the window down.
 */
export function parseHomeFeed(raw: unknown): Callout[] {
  const coins = (raw as { coins?: unknown } | null)?.coins;
  if (!Array.isArray(coins)) return [];
  const out: Callout[] = [];
  for (const row of coins) {
    if (typeof row !== 'object' || row === null) continue;
    const c = row as FeedCoin;
    const position = (typeof c.position === 'object' && c.position !== null ? c.position : null) as Record<string, unknown> | null;
    const callout = (position && typeof position.callout === 'object' && position.callout !== null ? position.callout : null) as Record<string, unknown> | null;
    if (!callout) continue;
    const id = str(callout.calloutId, 64);
    const mint = str(c.coinMint, 64);
    const when = at(callout.calloutTimestamp);
    if (!id || !mint || when === null) continue;
    out.push({
      id,
      mint,
      chain: calloutChain(c.chain),
      rawChain: str(c.chain, 24) ?? 'unknown',
      name: str(c.coinName, 60),
      symbol: str(c.symbol, 20),
      imageUrl: str(c.coinImage, 300),
      at: when,
      thesis: str(callout.thesis, 400),
      calledAtMcapUsd: num(callout.calledOutAtMcap),
      mcapUsdNow: num(c.marketCap),
      calloutPriceUsd: num(callout.calloutPrice),
      multiple: derivedMultiple(num(callout.calledOutAtMcap), num(c.marketCap)),
      peakMultiple: sane(callout.maxMultiplier),
      likes: num(callout.likes),
      replies: num(callout.replyCount),
      views: num(callout.viewCount),
      updates: num(callout.updateCount),
      caller: position ? parseCaller(position) : parseCaller({}),
    });
  }
  return out;
}

/**
 * `GET /callout/top/{mint}` → that coin's callouts.
 *
 * A different shape from the feed: `{ callouts: [...] }`, flat, and with the
 * caller's wallet in `userId` rather than `walletAddress`. It carries no
 * position, so `skinInTheGame` on one of these rows answers null — which is
 * the correct answer, not a reason to guess.
 */
export function parseCoinCallouts(raw: unknown, mint: string, chain: ChainKind): Callout[] {
  const rows = (raw as { callouts?: unknown } | null)?.callouts;
  if (!Array.isArray(rows)) return [];
  const out: Callout[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const c = row as Record<string, unknown>;
    const id = str(c.calloutId, 64);
    const when = at(c.createdAt);
    if (!id || when === null) continue;
    out.push({
      id,
      mint: str(c.coinMint, 64) ?? mint,
      chain,
      rawChain: chain,
      name: null,
      symbol: null,
      imageUrl: null,
      at: when,
      thesis: str(c.thesis, 400),
      calledAtMcapUsd: num(c.marketCap),
      mcapUsdNow: null,
      calloutPriceUsd: num(c.calloutPriceUsd),
      // This route serves no current market cap, so there is nothing to
      // derive a multiple from — and its own `multiple` field is the one
      // measured disagreeing with the feed. An em dash next to "called at
      // $4,407" and the chart already on screen is the honest answer.
      multiple: null,
      peakMultiple: null,
      likes: num(c.likes),
      replies: num(c.replyCount),
      views: num(c.viewCount),
      updates: num(c.updateCount),
      caller: {
        name: str(c.username, 60),
        // On this route the wallet is `userId`; `user_uuid` is the account id.
        wallet: str(c.userId, 64),
        xUsername: str(c.xUsername, 60),
        verified: c.isVerified === true,
        avatarUrl: str(c.profileImage, 300),
        totalCallouts: null,
        holds: null,
        positionUsd: null,
        costUsd: null,
        boughtUsd: null,
        pnlUsd: null,
        pnlPct: null,
        realizedUsd: null,
      },
    });
  }
  return out;
}

/** Newest first. The feed arrives in pump's recommendation rank, which is not
 *  time order and is not a ranking this app has any way to check. */
export function newestFirst(rows: Callout[]): Callout[] {
  return [...rows].sort((a, b) => b.at - a.at);
}

/** Feed rows for one mint, newest first. */
export function calloutsFor(rows: Callout[], mint: string): Callout[] {
  const key = mint.toLowerCase();
  return newestFirst(rows.filter((r) => r.mint.toLowerCase() === key));
}
