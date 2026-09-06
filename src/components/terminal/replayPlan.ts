// Planning a trade replay: which candles to ask for, which window to show,
// and what the running PnL is at each frame.
//
// Pure and separate from the drawing because these are the decisions that
// make a replay honest or useless. The provider only serves "the most recent
// N candles of interval X", so replaying a trade from four hours ago means
// choosing an interval whose N reaches back that far — pick it too fine and
// the window is not covered at all, too coarse and a two-minute trade is
// three candles. Both failures are silent in a rendered animation, so they
// are decided here and pinned by a test.

import type { Candle, CandleInterval } from '@shared/market';

export const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
};

/** Candles we ask a provider for. Above this, requests get slow and are
 *  often truncated anyway. */
export const REPLAY_CANDLE_LIMIT = 600;
/** Leave headroom: providers return fewer than asked more often than not. */
const USABLE = 520;

const ORDER: CandleInterval[] = ['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h'];

/**
 * The finest interval whose recent window still reaches back to the start of
 * the trade. `now` is passed in rather than read, so this is testable and
 * gives the same answer twice.
 */
export function pickInterval(openedAtMs: number, closedAtMs: number, nowMs: number): CandleInterval {
  // Reach back to the OPEN (the earliest thing shown), and never so coarse
  // that the hold itself is a couple of candles.
  const spanSec = Math.max(60, (nowMs - openedAtMs) / 1000);
  const holdSec = Math.max(1, (closedAtMs - openedAtMs) / 1000);
  const reaching = ORDER.filter((iv) => spanSec / INTERVAL_SECONDS[iv] <= USABLE);
  if (!reaching.length) return '4h';
  // Among the intervals that reach, prefer the finest that still puts at
  // least a handful of candles inside the hold; falling back to the finest
  // that reaches at all when the trade was shorter than any bucket.
  const detailed = reaching.find((iv) => holdSec / INTERVAL_SECONDS[iv] >= 6);
  return detailed ?? reaching[0];
}

export interface ReplayWindow {
  /** Inclusive bounds in SECONDS, matching Candle.time. */
  fromSec: number;
  toSec: number;
}

/**
 * The slice to animate: the hold, plus a margin either side so the entry is
 * not the first frame and the exit is not the last. The margin is a share of
 * the hold, floored so a ten-second scalp still gets context.
 */
export function replayWindow(openedAtMs: number, closedAtMs: number, marginRatio = 0.35): ReplayWindow {
  const openSec = Math.floor(openedAtMs / 1000);
  const closeSec = Math.max(openSec + 1, Math.floor(closedAtMs / 1000));
  const margin = Math.max(30, Math.round((closeSec - openSec) * marginRatio));
  return { fromSec: openSec - margin, toSec: closeSec + margin };
}

/** Candles inside the window, in time order. */
export function trimCandles(candles: Candle[], w: ReplayWindow): Candle[] {
  return candles.filter((c) => c.time >= w.fromSec && c.time <= w.toSec).sort((a, b) => a.time - b.time);
}

/**
 * How many candles are on screen at `progress` (0..1). Always at least one,
 * so the first frame is never an empty chart.
 */
export function revealCount(progress: number, total: number): number {
  if (total <= 0) return 0;
  const p = Math.min(1, Math.max(0, progress));
  return Math.max(1, Math.min(total, Math.ceil(p * total)));
}

export interface RunningPnl {
  /** Percent against the entry price. */
  pct: number;
  /** SOL, against what the position cost. */
  sol: number;
}

/**
 * What the position is worth at `price`, given what it cost and the average
 * price paid. Null entry or cost means we cannot say — and a replay that
 * invents a number is worse than one that shows none.
 */
export function runningPnl(price: number, entryPriceSol: number | null, costSol: number): RunningPnl | null {
  if (entryPriceSol === null || !(entryPriceSol > 0) || !(costSol > 0) || !(price > 0)) return null;
  const ratio = price / entryPriceSol;
  return { pct: (ratio - 1) * 100, sol: costSol * ratio - costSol };
}

/** Price extremes of the visible candles, padded so nothing touches an edge. */
export function priceRange(candles: Candle[], padRatio = 0.08): { min: number; max: number } {
  if (!candles.length) return { min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max === min) {
    const bump = Math.abs(max) * 0.05 || 1;
    return { min: min - bump, max: max + bump };
  }
  const pad = (max - min) * padRatio;
  return { min: min - pad, max: max + pad };
}

/** Frames in a replay of `seconds` at `fps`, bounded so nothing runs away. */
export function frameCount(seconds: number, fps: number): number {
  return Math.max(1, Math.min(3600, Math.round(seconds * fps)));
}
