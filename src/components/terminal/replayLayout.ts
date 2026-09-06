// Where every element of a replay frame sits, for a given canvas size.
//
// The first version placed each line at a hand-picked fraction of the height
// and sized the fonts off the WIDTH. At 16:9 that put a 122px percentage
// under a baseline only 76px below the ticker, so the wordmark, the ticker
// and the big number all sat on top of each other — and at 9:16 the same
// numbers were far too wide for the frame.
//
// Both are the same mistake: type placed by eye instead of stacked by its
// own measured height. This module stacks it, and a test walks every shape
// the panel offers to check nothing collides and nothing runs off the edge.

export interface ReplayLayout {
  /** Font sizes, in pixels. */
  wordmarkSize: number;
  tickerSize: number;
  bigSize: number;
  solSize: number;
  tagSize: number;
  footerSize: number;
  /** Baselines, top to bottom. */
  wordmark: number;
  ticker: number;
  big: number;
  sol: number;
  footer: number;
  /** The candle area. */
  chartTop: number;
  chartBottom: number;
  padX: number;
}

/** Rough width of a string in a sans font at `size`, good enough to keep
 *  text inside the frame without measuring on a canvas. */
export function approxWidth(text: string, size: number): number {
  return text.length * size * 0.58;
}

/** A percentage long enough to be the widest thing the big line ever holds. */
const WIDEST_BIG = '+9999.9%';

export function replayLayout(W: number, H: number): ReplayLayout {
  const padX = Math.round(W * 0.07);
  const usable = W - padX * 2;

  // Sized against BOTH dimensions: the height decides how much room a line
  // deserves, the width decides how much it can take before it overflows.
  const wordmarkSize = Math.round(Math.min(H * 0.03, W * 0.032));
  const tickerSize = Math.round(Math.min(H * 0.055, W * 0.07));
  let bigSize = Math.round(Math.min(H * 0.13, W * 0.16));
  while (bigSize > 24 && approxWidth(WIDEST_BIG, bigSize) > usable) bigSize -= 2;
  const solSize = Math.round(Math.min(H * 0.038, W * 0.045));
  const tagSize = Math.round(solSize * 0.72);
  const footerSize = Math.round(Math.min(H * 0.028, W * 0.024));

  // Stack downward, each baseline a line-height below the previous.
  const wordmark = Math.round(H * 0.06);
  const ticker = Math.round(wordmark + tickerSize * 1.15);
  const big = Math.round(ticker + bigSize * 1.02);
  const sol = Math.round(big + solSize * 1.5);

  const footer = Math.round(H - Math.max(28, H * 0.05));
  const chartTop = Math.round(sol + Math.max(18, H * 0.035));
  const chartBottom = Math.round(footer - Math.max(24, H * 0.05));

  return {
    wordmarkSize,
    tickerSize,
    bigSize,
    solSize,
    tagSize,
    footerSize,
    wordmark,
    ticker,
    big,
    sol,
    footer,
    chartTop,
    chartBottom,
    padX,
  };
}
