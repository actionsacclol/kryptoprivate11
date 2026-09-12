// What an EVM chain's Observatory shows.
//
// One of these per chain, and they never merge. The Solana Observatory reads
// the SniperEngine; each EVM chain reads its own scanner, with its own cursor,
// its own counts and its own launches. A number on the BNB Observatory is a
// BNB number or it is an em dash.
//
// ─── Why there are no odds here ──────────────────────────────────────────
//
// The Solana runner alert is not a heuristic: `shared/odds.ts` was fit on pump
// launches from 2026-07-25/26 and validated on a held-out pump day, and the
// number a user sees is the OBSERVED graduation rate of pump launches that
// scored alike. That number describes pump's population and nothing else.
//
// Pons and four.meme are different curves, different fee structures and
// different traders — Pons taxes the launch block at 99% per recipient, which
// makes its first sixty seconds structurally unlike pump's. Scoring them with
// pump's model would print a confident graduation chance with no evidence
// behind it, which is the one thing this app must never do.
//
// So each chain gets MEASURED FACTS about its own launches — counts, native
// in, unique buyers, curve progress — and, once it has watched enough of them
// end, a runner call built from ITS OWN records: see shared/evmRunners.ts.
// That call is the same construction as the Solana one (an observed rate
// beside the base rate, never a predicted probability) fitted to this chain's
// population rather than borrowed from another. Facts are honest at n=1;
// rates are not, so a bucket says nothing until it has a hundred launches
// behind it.

import type { EvmChainKind } from './evm';

export interface EvmScanStatus {
  chain: EvmChainKind;
  /** The scanner is polling this chain right now. */
  running: boolean;
  /** Turned off in Settings — running is false and that is not a fault. */
  enabled: boolean;
  /** Last block ingested. Null = never read, which renders as an em dash. */
  lastBlock: number | null;
  /** Blocks behind the head at the last poll. Null when either is unknown. */
  behind: number | null;
  /** Launch events seen since the scanner started. */
  launchesSeen: number;
  /** Trade events seen since the scanner started. */
  tradesSeen: number;
  /** Launches still inside their measurement window. */
  tracking: number;
  /** Graduations seen since the scanner started. */
  graduationsSeen: number;
  /** Runner calls flagged this session — a call that BEAT the chain's own
   *  base rate. See shared/evmRunners.ts; a call is never a prediction. */
  callsFlagged: number;
  startedAt: number | null;
  lastPollAt: number | null;
  /** Why the last poll failed, or null. Shown rather than swallowed. */
  lastError: string | null;
}

export function emptyScanStatus(chain: EvmChainKind): EvmScanStatus {
  return {
    chain,
    running: false,
    enabled: false,
    lastBlock: null,
    behind: null,
    launchesSeen: 0,
    tradesSeen: 0,
    tracking: 0,
    graduationsSeen: 0,
    callsFlagged: 0,
    startedAt: null,
    lastPollAt: null,
    lastError: null,
  };
}

/**
 * What was actually measured in a launch's first `windowS` seconds.
 *
 * Every field is a count or a sum of events we saw. Nothing here is derived
 * from a model, and nothing is a prediction. A field is null when the window
 * has not closed yet or the value could not be read — never 0 as a stand-in.
 */
export interface EvmLaunchWindow {
  windowS: 60 | 120;
  /** Buy events in the window. */
  buys: number;
  /** Sell events in the window. */
  sells: number;
  /** Distinct buying addresses. */
  uniqueBuyers: number;
  /**
   * Native token in, minus native out, in whole units (ETH / BNB) — or NULL
   * when the launch is not quoted in the native coin at all. four.meme
   * curves are quoted in whatever the creator chose, and on 2026-09-11 only
   * 22 % of 300 live BNB launches were BNB-quoted: the rest were being summed
   * and ranked as if their USDT (and nine other assets) were BNB. Found by
   * audit. A count of buys is a count on any curve; a sum of money is not.
   */
  netNative: number | null;
  /** Native in only; null on the same terms. */
  volumeNative: number | null;
  /** Curve progress at the close of the window, 0..100, or null if unread. */
  curvePct: number | null;
  /** True when the creator's own address sold inside the window. */
  creatorSold: boolean;
}

export interface EvmScanLaunch {
  chain: EvmChainKind;
  token: string;
  name: string;
  symbol: string;
  creator: string;
  /** Local time the scanner first saw it — not the block timestamp. */
  seenAt: number;
  blockNumber: number;
  /** Measured windows, filled as each closes. */
  windows: EvmLaunchWindow[];
  /** Set when the launch graduated while the scanner was watching. */
  graduatedAt: number | null;
  /**
   * What the curve is quoted in: the chain's own coin, or something else.
   * Null until read (BNB reads it from four.meme's helper after the launch
   * is seen; Robinhood's Pons curves are always ETH).
   */
  quote: 'native' | 'other' | null;
  /**
   * What this chain's own records say about a launch that started like this,
   * made when the 60 s window closed. Null before then.
   */
  call?: import('./evmRunners').RunnerCall | null;
}

/** Newest first, and never more than this many kept in memory. */
export const EVM_SCAN_LAUNCH_CAP = 300;

/** How long a launch stays in the measurement window. */
export const EVM_SCAN_TRACK_MS = 130_000;
