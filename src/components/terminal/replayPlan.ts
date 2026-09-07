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
import type { ClosedTrade } from '@shared/portfolio';

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

// ── Units ─────────────────────────────────────────────────────────────
//
// The fills are in SOL per token. GeckoTerminal and Birdeye history is in
// USD per token. Comparing a USD close against a SOL entry price multiplied
// the running PnL by the SOL price: a +300 % trade replayed as +40,000 %
// and +110 SOL (2026-09-06). The replay does not know the SOL/USD rate at
// the time of the trade, but it knows something better — the price the
// user actually paid, and the candle that was closing when they paid it.
// Scaling the whole series so that candle's close equals the entry price
// converts it to SOL at the entry-time rate, which is exact where it
// matters (the entry) and drifts only by however much SOL/USD moved during
// the hold. The exit is never taken from a candle: once the replay passes
// it, the realised figure from the fills is shown.

/** The candle closing at or just before `sec`, else the first one. */
function candleAt(candles: Candle[], sec: number): Candle | null {
  if (!candles.length) return null;
  let hit: Candle | null = null;
  for (const c of candles) {
    if (c.time <= sec) hit = c;
    else break;
  }
  return hit ?? candles[0];
}

/**
 * Candles rescaled so the one closing at the entry equals the entry price.
 * `anchored` is false (and the candles returned unchanged) when there is
 * nothing to anchor on — no entry price, or a candle that closed at zero.
 */
export function anchorCandlesToEntry(
  candles: Candle[],
  openedAtMs: number,
  entryPriceSol: number | null,
): { candles: Candle[]; anchored: boolean } {
  if (entryPriceSol === null || !(entryPriceSol > 0)) return { candles, anchored: false };
  const at = candleAt(candles, Math.floor(openedAtMs / 1000));
  if (!at || !(at.close > 0)) return { candles, anchored: false };
  const k = entryPriceSol / at.close;
  if (!Number.isFinite(k) || k <= 0) return { candles, anchored: false };
  return {
    anchored: true,
    candles: candles.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k })),
  };
}

// ── A path when no history survives ───────────────────────────────────
//
// Providers keep little history for dead tokens, so an old trade often has
// nothing to animate. The two facts that were ever real — what was paid at
// the open and what was received at the close — still are, and a replay
// can be honest about the rest: a seeded random path that STARTS at the
// entry price at the entry time and ENDS at the exit price at the exit
// time, labelled on the frame as illustrative. Seeded from the trade so the
// same trade always draws the same path.

/** Entry and exit in SOL per token, each rebuilt from the other and the
 *  realised percentage when one is missing. Null when neither is known. */
export function tradePrices(trade: Pick<ClosedTrade, 'entryPriceSol' | 'exitPriceSol' | 'pnlPct'>): { entry: number; exit: number } | null {
  const entry = trade.entryPriceSol !== null && trade.entryPriceSol > 0 ? trade.entryPriceSol : null;
  const exit = trade.exitPriceSol !== null && trade.exitPriceSol > 0 ? trade.exitPriceSol : null;
  const ratio = 1 + trade.pnlPct / 100;
  if (entry !== null && exit !== null) return { entry, exit };
  if (entry !== null && ratio > 0) return { entry, exit: entry * ratio };
  if (exit !== null && ratio > 0) return { entry: exit / ratio, exit };
  return null;
}

/** The finest interval that keeps the whole window under ~200 candles. */
export function pickSyntheticInterval(openedAtMs: number, closedAtMs: number): CandleInterval {
  const w = replayWindow(openedAtMs, closedAtMs);
  const spanSec = Math.max(1, w.toSec - w.fromSec);
  return ORDER.find((iv) => spanSec / INTERVAL_SECONDS[iv] <= 200) ?? '4h';
}

/** Deterministic small PRNG (mulberry32) seeded from a string. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately normal, from the seeded uniform. */
function gauss(rnd: () => number): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rnd();
  return (s - 3) / Math.sqrt(0.5);
}

/**
 * Synthetic candles for a trade with no history: a Brownian bridge in log
 * price from the entry to the exit across the hold, with a random walk
 * either side for the margins. The candle closing at the entry time closes
 * at EXACTLY the entry price and the one at the exit time at exactly the
 * exit price, so `runningPnl` at the exit reproduces the trade's realised
 * percentage. Null when neither fill price is known — there is nothing
 * honest to draw a path between.
 */
export function syntheticCandles(
  trade: Pick<ClosedTrade, 'mint' | 'openedAt' | 'closedAt' | 'entryPriceSol' | 'exitPriceSol' | 'pnlPct'>,
  interval: CandleInterval = pickSyntheticInterval(trade.openedAt, trade.closedAt),
): Candle[] | null {
  const prices = tradePrices(trade);
  if (!prices) return null;
  const step = INTERVAL_SECONDS[interval];
  const w = replayWindow(trade.openedAt, trade.closedAt);
  // Bucket boundaries on the interval, with the entry and exit landing on
  // the bucket that contains them (the same rule the markers use).
  const openSec = Math.floor(trade.openedAt / 1000);
  const closeSec = Math.max(openSec + 1, Math.floor(trade.closedAt / 1000));
  const first = Math.floor(w.fromSec / step) * step;
  const times: number[] = [];
  for (let t = first; t <= w.toSec; t += step) times.push(t);
  if (times.length < 3) return null;
  const entryIdx = Math.max(0, times.findIndex((t) => t + step > openSec));
  let exitIdx = times.findIndex((t) => t + step > closeSec);
  if (exitIdx < 0) exitIdx = times.length - 1;
  if (exitIdx <= entryIdx) exitIdx = Math.min(times.length - 1, entryIdx + 1);

  const rnd = seededRandom(`${trade.mint}:${trade.openedAt}:${trade.closedAt}`);
  const lnEntry = Math.log(prices.entry);
  const lnExit = Math.log(prices.exit);
  const holdSteps = Math.max(1, exitIdx - entryIdx);
  // Per-step volatility from the size of the move itself, bounded so a flat
  // trade still wiggles and a 50× one does not draw a wall.
  const sigma = Math.min(0.08, Math.max(0.01, (Math.abs(lnExit - lnEntry) / Math.sqrt(holdSteps)) * 1.4));

  // 1. The bridge across the hold: random walk, then pinned at both ends by
  //    subtracting the walk's drift proportionally.
  const walk: number[] = [0];
  for (let i = 1; i <= holdSteps; i++) walk.push(walk[i - 1] + gauss(rnd) * sigma);
  const closes = new Array<number>(times.length).fill(0);
  for (let i = 0; i <= holdSteps; i++) {
    const f = i / holdSteps;
    const bridge = walk[i] - f * walk[holdSteps];
    closes[entryIdx + i] = lnEntry + f * (lnExit - lnEntry) + bridge;
  }
  // 2. Before the entry: walk backwards from the entry, drifting gently
  //    toward it so the run-up looks like a market, not a cliff.
  for (let i = entryIdx - 1; i >= 0; i--) closes[i] = closes[i + 1] + gauss(rnd) * sigma * 0.8;
  // 3. After the exit: keep walking from the exit.
  for (let i = exitIdx + 1; i < times.length; i++) closes[i] = closes[i - 1] + gauss(rnd) * sigma * 0.8;

  const out: Candle[] = [];
  for (let i = 0; i < times.length; i++) {
    const close = Math.exp(closes[i]);
    const open = i === 0 ? close * Math.exp(gauss(rnd) * sigma * 0.5) : out[i - 1].close;
    const wick = Math.abs(gauss(rnd)) * sigma * 0.6;
    const hi = Math.max(open, close) * Math.exp(wick * rnd());
    const lo = Math.min(open, close) * Math.exp(-wick * rnd());
    out.push({ time: times[i], open, high: hi, low: lo, close, volume: 0 });
  }
  // Pin the two facts exactly, whatever floating point did to the bridge.
  out[entryIdx].close = prices.entry;
  out[exitIdx].close = prices.exit;
  for (const i of [entryIdx, exitIdx]) {
    out[i].high = Math.max(out[i].high, out[i].open, out[i].close);
    out[i].low = Math.min(out[i].low, out[i].open, out[i].close);
    if (i + 1 < out.length) out[i + 1].open = out[i].close;
  }
  return out;
}
