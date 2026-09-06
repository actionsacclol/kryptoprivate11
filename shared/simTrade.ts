// A made-up trade, for looking at the replay and the share card without
// waiting for a real round trip whose candles still exist.
//
// This exists because provider history for a dead memecoin is often a single
// candle, which makes the replay impossible to judge. It is a DESIGN tool:
// everything it produces is marked simulated, on the card and in the video,
// and the marking is not optional. A fabricated trade that could pass for a
// real one is the single most harmful artefact this codebase could learn to
// make, so the label travels with the data rather than being a checkbox in
// the UI.
//
// Deterministic: the same input always produces the same path, so a layout
// can be compared against itself and a test can pin the shape.

import type { Candle, CandleInterval } from './market';
import type { ClosedTrade } from './portfolio';

export type SimShape = 'steady' | 'dip-then-run' | 'spike-then-fade' | 'chop';

export interface SimInput {
  symbol: string;
  /** SOL that went in. */
  costSol: number;
  /** Result as a percentage of the cost: 250 = a 3.5×, -80 = most of it gone. */
  pnlPct: number;
  /** How long it was held. */
  holdMs: number;
  /** 0 = a clean line, 1 = violent. */
  volatility: number;
  shape: SimShape;
  /** Same seed, same path. */
  seed: number;
  /** When the trade closed; the open is derived from holdMs. */
  closedAt: number;
}

export const DEFAULT_SIM: SimInput = {
  symbol: 'DEMO',
  costSol: 0.5,
  pnlPct: 180,
  holdMs: 6 * 60_000,
  volatility: 0.45,
  shape: 'dip-then-run',
  seed: 7,
  closedAt: 0,
};

export interface SimResult {
  trade: ClosedTrade;
  candles: Candle[];
  interval: CandleInterval;
}

/** Small deterministic PRNG (mulberry32) — no dependency, same everywhere. */
function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INTERVALS: Array<[CandleInterval, number]> = [
  ['1s', 1],
  ['5s', 5],
  ['15s', 15],
  ['1m', 60],
  ['5m', 300],
  ['15m', 900],
  ['1h', 3600],
  ['4h', 14400],
];

/** An interval that puts roughly 40 candles inside the hold. */
export function simInterval(holdMs: number): [CandleInterval, number] {
  const target = Math.max(1, holdMs / 1000 / 40);
  let best = INTERVALS[0];
  for (const iv of INTERVALS) if (Math.abs(iv[1] - target) < Math.abs(best[1] - target)) best = iv;
  return best;
}

/** The drift each shape follows across the hold, before noise. 0 → 1. */
function shapeAt(shape: SimShape, u: number): number {
  switch (shape) {
    case 'dip-then-run':
      // Down into the first third, then the run.
      return u < 0.33 ? -0.55 * (u / 0.33) : -0.55 + 1.55 * ((u - 0.33) / 0.67);
    case 'spike-then-fade':
      // Overshoots early and gives some back — what most runners look like.
      return u < 0.55 ? 1.45 * (u / 0.55) : 1.45 - 0.45 * ((u - 0.55) / 0.45);
    case 'chop':
      return u + 0.28 * Math.sin(u * Math.PI * 4);
    case 'steady':
    default:
      return u;
  }
}

/**
 * Build the trade and the candles behind it. The exit lands exactly on the
 * requested result: this is a picture of a number the user chose, not a
 * simulation of a market.
 */
export function simulateTrade(input: SimInput): SimResult {
  const closedAt = input.closedAt;
  const holdMs = Math.max(10_000, input.holdMs);
  const openedAt = closedAt - holdMs;
  const [interval, stepSec] = simInterval(holdMs);
  const rand = rng(input.seed);

  const holdSteps = Math.max(6, Math.round(holdMs / 1000 / stepSec));
  const lead = Math.max(3, Math.round(holdSteps * 0.28));
  const tail = Math.max(3, Math.round(holdSteps * 0.22));
  const entry = 0.0000012; // an ordinary memecoin price in SOL
  const targetRatio = Math.max(0.01, 1 + input.pnlPct / 100);

  // A multiplicative path: shape gives the drift, the seed gives the wobble,
  // then the whole thing is normalised so the exit is exact.
  const vol = Math.max(0, Math.min(1, input.volatility));
  const closes: number[] = [];
  for (let i = 0; i <= holdSteps; i++) {
    const u = i / holdSteps;
    const drift = shapeAt(input.shape, u) * Math.log(targetRatio);
    const noise = (rand() - 0.5) * vol * 0.22 * Math.sqrt(u + 0.05);
    closes.push(Math.exp(drift + noise));
  }
  // Force both ends: in at 1, out at exactly the requested ratio.
  const drop = closes[closes.length - 1] / targetRatio;
  for (let i = 0; i < closes.length; i++) {
    const u = i / holdSteps;
    closes[i] = (closes[i] / Math.pow(drop, u)) * (i === 0 ? 1 / closes[0] : 1);
  }
  closes[0] = 1;
  closes[closes.length - 1] = targetRatio;

  const candles: Candle[] = [];
  const openSec = Math.floor(openedAt / 1000);
  const push = (timeSec: number, prev: number, next: number): void => {
    const hi = Math.max(prev, next) * (1 + rand() * 0.05 * (0.3 + vol));
    const lo = Math.min(prev, next) * (1 - rand() * 0.05 * (0.3 + vol));
    candles.push({
      time: timeSec,
      open: entry * prev,
      high: entry * hi,
      low: entry * Math.max(1e-9, lo),
      close: entry * next,
      volume: Math.round(1000 + rand() * 9000),
    });
  };

  // Lead-in: quiet drift before the buy.
  let p = closes[0];
  for (let i = lead; i > 0; i--) {
    const prev = p * (1 + (rand() - 0.5) * 0.05 * (0.4 + vol));
    push(openSec - i * stepSec, prev, p);
    p = prev;
  }
  // The hold itself.
  for (let i = 1; i < closes.length; i++) {
    push(openSec + (i - 1) * stepSec, closes[i - 1], closes[i]);
  }
  // Tail: what happened after the exit, which is not part of the result.
  let after = closes[closes.length - 1];
  for (let i = 0; i < tail; i++) {
    const next = after * (1 + (rand() - 0.5) * 0.06 * (0.4 + vol));
    push(openSec + (closes.length - 1 + i) * stepSec, after, next);
    after = next;
  }

  const proceedsSol = input.costSol * targetRatio;
  const tokens = input.costSol / entry;
  const trade: ClosedTrade = {
    mint: `SIMULATED${String(input.seed).padStart(4, '0')}`,
    symbol: input.symbol.toUpperCase().slice(0, 12) || 'DEMO',
    openedAt,
    closedAt,
    costSol: input.costSol,
    proceedsSol,
    pnlSol: proceedsSol - input.costSol,
    pnlPct: input.pnlPct,
    holdMs,
    tokensBought: tokens,
    tokensSold: tokens,
    entryPriceSol: entry,
    exitPriceSol: entry * targetRatio,
    buys: 1,
    sells: 1,
  };
  return { trade, candles, interval };
}

/** True for anything this module made. Used to force the SIMULATED mark. */
export function isSimulated(trade: { mint: string }): boolean {
  return trade.mint.startsWith('SIMULATED');
}
