// The rules a Krypto Trader session trades by — pure, no I/O.
//
//   • depth math (price impact on a constant-product pool, Rules A/B/C, the
//     D7 opposite-side floor, dump impact) — docs/krypto-trader-2026-09-25.md
//     Appendix B §2;
//   • the session's own book in base units (fills, lots, room with reinvest
//     off/on per D13, the pending reservation);
//   • the four presets as intent functions;
//   • `checkTraderIntent`, the ONE guard every driver passes through
//     (preset rules, AI, MCP, and the user's own sell-all as an exit);
//   • stops, the fit check, the derived row, and the strict AI reply parser
//     the stage-3 driver will use.
//
// Every limit the guard applies is the user's (TraderLimits, 0 = off). What
// the guard never lets go, whatever the limits say: an unknown or stale
// price never permits a buy, an unknown depth never permits a buy, a sell is
// never larger than the session's own claim, and the budget is the budget.

import { FEE_BPS } from './fees';
import { PAPER_SIDE_COST } from './paper';
import type { ChainKind } from './chainKind';
import {
  DEFAULT_TRADER_PARAMS,
  FIT_FORWARD_LINE,
  FIT_NO_FORECAST_LINE,
  TRADER_AI_HEARTBEAT_MS,
  TRADER_AI_MIN_GAP_FLOOR_SEC,
  TRADER_AI_MOVE_PCT,
  TRADER_AI_NEAR_STOP_PCT,
  TRADER_AI_STYLE,
  TRADER_PRESETS,
  traderAntiWashOff,
  traderMoney,
  traderUnit,
  type DipsParams,
  type HoldParams,
  type StepsParams,
  type TraderAiFacts,
  type TraderAiState,
  type TraderBook,
  type TraderDerived,
  type TraderDriver,
  type TraderFit,
  type TraderLimits,
  type TraderMarketFacts,
  type TraderParamsByPreset,
  type TraderPendingExit,
  type TraderPreset,
  type TraderPresetParams,
  type TraderSession,
  type TrimParams,
} from './kryptoTrader';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Krypt's fee per side, percent (FEE_BPS in shared/fees.ts). */
export const KRYPT_FEE_PCT = FEE_BPS / 100;
/** pump curve fee per side, percent (electron/engine/curve.ts FEE_BPS 100). */
export const CURVE_FEE_PCT = 1;
/** PumpSwap / DEX pool fee per side when the swap event's lp+protocol bps are
 *  not known (the quant report's low case). */
export const POOL_FEE_PCT = 0.3;
/** A price older than this is stale: it never triggers a stop and never
 *  permits a buy (critic #5). */
export const STALE_PRICE_MS = 60_000;
/** Smallest buy worth the fees. Not a pacing limit — below it a buy is all fee. */
export const TRADER_MIN_BUY_SOL = 0.005;
/** A pending or unreconciled buy holds room at the requested SOL × this. */
export const RESERVE_FACTOR = 1.015;
/** No buys on a curve at or above this progress (the trim preset's 95 % pause). */
export const NEAR_GRAD_PCT = 95;
/** Below this many trades an hour the session would be most of the market. */
export const THIN_TRADES_PER_HOUR = 30;

// ─── Depth math (constant product, fees excluded) ──────────────────────────

/** % the price rises when `s` SOL is bought into a pool with `R` SOL. */
export function buyMovePct(s: number, R: number): number | null {
  if (!(R > 0) || !(s >= 0)) return null;
  return ((1 + s / R) ** 2 - 1) * 100;
}

/** % the price falls when a sell takes `s` SOL out of a pool with `R` SOL. */
export function sellMovePct(s: number, R: number): number | null {
  if (!(R > 0) || !(s >= 0)) return null;
  if (s >= R) return 100;
  return (1 - (1 - s / R) ** 2) * 100;
}

/** Rule A: the largest single trade that moves price at most `movePct`. */
export function ruleAMaxTradeSol(R: number | null, movePct = 2): number | null {
  if (R === null || !(R > 0)) return null;
  return R * (Math.sqrt(1 + movePct / 100) - 1);
}

/** Rule B: the largest position whose full exit moves price at most
 *  `exitMovePct`. Selling in pieces moves a constant-product price the same
 *  total, so this binds however the exit is split. */
export function ruleBMaxPositionSol(R: number | null, exitMovePct = 10): number | null {
  if (R === null || !(R > 0)) return null;
  return R * (1 - Math.sqrt(1 - exitMovePct / 100));
}

/** Venue fee per side, percent. */
export function venueFeePct(venue: 'curve' | 'pool' | 'pumpswap' | null, poolFeePct = POOL_FEE_PCT): number {
  return venue === 'curve' ? CURVE_FEE_PCT : poolFeePct;
}

/** Rule C's round-trip cost, percent: 2·s/R + 2·(Krypt + venue fee). The
 *  $KRYPTO holder rate halves Krypt's part. Null when R is unknown. */
export function roundTripCostPct(sol: number, R: number | null, venue: 'curve' | 'pool' | 'pumpswap' | null, opts: { holderRate?: boolean; poolFeePct?: number } = {}): number | null {
  if (R === null || !(R > 0)) return null;
  const krypt = opts.holderRate ? KRYPT_FEE_PCT / 2 : KRYPT_FEE_PCT;
  return 2 * (sol / R) * 100 + 2 * (krypt + venueFeePct(venue, opts.poolFeePct));
}

/** D7: the least price move between a sell and the next buy (and back),
 *  percent — max(2 × round trip, 8 % on a curve / 5 % on a pool). */
export function d7FloorPct(venue: 'curve' | 'pool' | 'pumpswap' | null, roundTripPct: number | null): number {
  const base = venue === 'curve' ? 8 : 5;
  return roundTripPct === null ? base : Math.max(base, 2 * roundTripPct);
}

/**
 * Pool depth R (native wei) implied by two BUY quotes of the same venue —
 * `tSmall` tokens for `pSmall` wei and `tBig` for `pBig` (stage 4, EVM).
 *
 * On a constant-product pool with the fee taken from the input (factor f),
 * t(p) = f·p·Y / (R + f·p), so the ratio r = (tS/pS)/(tB/pB) = (R + f·pB) /
 * (R + f·pS) and R = f·(pB − r·pS)/(r − 1). f is within 1 % of one on every
 * venue this rail trades and is left out (R reads at most ~1 % deep). No spot
 * price is needed, so the same two probes serve a four.meme curve (Helper3's
 * own `tryBuy`), a PancakeSwap v2 pair, a v3 pool (where it is the depth of
 * the active range — the depth a trade actually meets) and a Pons v4 pool.
 * Null when the quotes show no impact (r ≤ 1) or are unusable: an unknown
 * depth, and so no buy — never a guess.
 */
export function impliedDepthWei(pSmall: bigint, tSmall: bigint, pBig: bigint, tBig: bigint): bigint | null {
  if (pSmall <= 0n || pBig <= pSmall || tSmall <= 0n || tBig <= 0n) return null;
  const ONE = 10n ** 18n;
  // r scaled by 1e18: (tS·pB)/(tB·pS)
  const r = (tSmall * pBig * ONE) / (tBig * pSmall);
  if (r <= ONE) return null;
  const num = pBig * ONE - r * pSmall;
  if (num <= 0n) return null;
  const R = num / (r - ONE);
  return R > 0n ? R : null;
}

/**
 * The exact base units an EVM session sells for a claim (stage 4). The EVM
 * rail sells an exact `amountRaw` (refused above the balance, never
 * clamped — bnb-audit-2026-09-11), so a session sells EXACTLY its claim —
 * never a wallet percentage that could round into the user's own tokens.
 * A wallet that now holds less than the claim (a hand sell) sells what it
 * holds, which is all the session's. Null — NO SELL — on an unread or empty
 * balance. four.meme's 1e9 sell quantum is floored by the rail itself, so the
 * amount that goes out is at most this.
 */
export function exactSellRaw(claimRaw: bigint, balanceRaw: bigint | null): bigint | null {
  if (balanceRaw === null || balanceRaw <= 0n || claimRaw <= 0n) return null;
  return claimRaw < balanceRaw ? claimRaw : balanceRaw;
}

/** Under this many base units an EVM session's leftover is dust: four.meme
 *  sells only whole multiples of 1e9 (bnb-audit-2026-09-09), so an exit can
 *  leave up to 1e9 − 1 behind that no sell can move. */
export const EVM_SELL_DUST_RAW = 10n ** 9n;

/** Price multiple if a holder of `holderPct` % of supply sold into a pool
 *  holding `Y` tokens: (Y / (Y + h·supply))². An impact, never a score. */
export function dumpImpact(Y: number | null, supply: number | null, holderPct: number | null): number | null {
  if (Y === null || supply === null || holderPct === null || !(Y > 0) || !(supply > 0) || !(holderPct >= 0)) return null;
  const x = Y / (Y + (holderPct / 100) * supply);
  return x * x;
}

// ─── Base units ────────────────────────────────────────────────────────────

export function big(s: string | null | undefined): bigint {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Base units → whole tokens (for price math only; the book stays in raw). */
export function uiTokens(raw: string | bigint, decimals: number | null): number | null {
  if (decimals === null) return null;
  const r = typeof raw === 'bigint' ? raw : big(raw);
  return Number(r) / 10 ** decimals;
}

/** The claim (base units) for a sell of `pct` % of the session's bag. 100 is
 *  the whole claim; anything less ROUNDS DOWN — never more than asked. */
export function claimRawForPct(tokensRaw: string, pct: number): bigint {
  const held = big(tokensRaw);
  if (!(pct > 0) || held <= 0n) return 0n;
  if (pct >= 100) return held;
  const bps = BigInt(Math.floor(pct * 100));
  return (held * bps) / 10_000n;
}

/**
 * The wallet percentage that sells at most `claimRaw` of `balanceRaw` —
 * critic #2. The sell rail takes "NN.NN%" of the wallet's CURRENT balance, and
 * the wallet can hold tokens that are not the session's (bought by hand, held
 * before). So:
 *   • ROUNDED DOWN to the basis point (engine.pctForTokens rounds UP, which
 *     for a claim of 999,999 of 1,000,000 returns 100 and sells the user's
 *     own token too);
 *   • 100 only when the claim is at least the whole balance;
 *   • null — NO SELL — when the balance is unknown, empty, or the claim is
 *     under one basis point (the builder's 0.01 % floor would oversell it).
 */
export function pctForClaim(claimRaw: bigint, balanceRaw: bigint | null): number | null {
  if (balanceRaw === null || balanceRaw <= 0n || claimRaw <= 0n) return null;
  if (claimRaw >= balanceRaw) return 100;
  const bps = (claimRaw * 10_000n) / balanceRaw;
  if (bps <= 0n) return null;
  return Number(bps) / 100;
}

// ─── The book ──────────────────────────────────────────────────────────────

export function emptyBook(): TraderBook {
  return { tokensRaw: '0', decimals: null, openCostSol: 0, realisedSol: 0, feesSol: 0, lots: [], signatures: [], pendingSol: 0 };
}

/**
 * SOL the session may still put in (D13). Reinvest off: B − open cost −
 * max(0, −realised), so a loss shrinks it and a profit never grows it. On:
 * min(B + realised, 2B) − open cost. Pending buys hold room at their
 * reservation; an unknown fill never frees any.
 */
export function roomSol(book: TraderBook, budgetSol: number, reinvest: boolean): number {
  const base = reinvest ? Math.min(budgetSol + book.realisedSol, 2 * budgetSol) : budgetSol - Math.max(0, -book.realisedSol);
  return Math.max(0, base - book.openCostSol - book.pendingSol);
}

/** Hold room for a buy before the first await. */
export function reserve(book: TraderBook, sol: number): number {
  const r = Math.max(0, sol) * RESERVE_FACTOR;
  book.pendingSol = round(book.pendingSol + r, 9);
  return r;
}

/** Give reserved room back (never below zero). */
export function release(book: TraderBook, amount: number): void {
  book.pendingSol = Math.max(0, round(book.pendingSol - Math.max(0, amount), 9));
}

/** A confirmed buy: base units in, SOL out (fees included). */
export function applyBuyFill(book: TraderBook, f: { tokensRaw: string; costSol: number; at: number; decimals: number | null; feesSol?: number; signature?: string | null }): void {
  const add = big(f.tokensRaw);
  book.tokensRaw = (big(book.tokensRaw) + add).toString();
  if (book.decimals === null && f.decimals !== null) book.decimals = f.decimals;
  book.openCostSol = round(book.openCostSol + Math.max(0, f.costSol), 9);
  book.feesSol = round(book.feesSol + Math.max(0, f.feesSol ?? 0), 9);
  if (add > 0n) book.lots.push({ tokensRaw: add.toString(), costSol: Math.max(0, f.costSol), at: f.at });
  if (f.signature && !book.signatures.includes(f.signature)) book.signatures.push(f.signature);
}

/**
 * A confirmed sell: base units out, SOL in. Average-cost accounting — the
 * cost of what was sold is its share of the open cost, and every lot shrinks
 * by the same share. Returns the realised change.
 */
export function applySellFill(book: TraderBook, f: { tokensRaw: string; proceedsSol: number; feesSol?: number; signature?: string | null }): number {
  const held = big(book.tokensRaw);
  let sold = big(f.tokensRaw);
  if (sold > held) sold = held;
  if (f.signature && !book.signatures.includes(f.signature)) book.signatures.push(f.signature);
  book.feesSol = round(book.feesSol + Math.max(0, f.feesSol ?? 0), 9);
  if (held <= 0n) {
    book.realisedSol = round(book.realisedSol + Math.max(0, f.proceedsSol), 9);
    return Math.max(0, f.proceedsSol);
  }
  const share = Number((sold * 1_000_000_000n) / held) / 1e9;
  const costSold = book.openCostSol * share;
  const left = held - sold;
  book.tokensRaw = left.toString();
  book.openCostSol = left === 0n ? 0 : round(book.openCostSol - costSold, 9);
  if (left === 0n) book.lots = [];
  else {
    book.lots = book.lots
      .map((l) => {
        const t = big(l.tokensRaw);
        const keep = t - (t * sold) / held;
        return { ...l, tokensRaw: keep.toString(), costSol: l.costSol * (1 - share) };
      })
      .filter((l) => big(l.tokensRaw) > 0n);
  }
  const delta = Math.max(0, f.proceedsSol) - costSold;
  book.realisedSol = round(book.realisedSol + delta, 9);
  return delta;
}

/** Average SOL per whole token of the bag, or null with no bag. */
export function avgCostSol(book: TraderBook): number | null {
  const t = uiTokens(book.tokensRaw, book.decimals);
  if (t === null || !(t > 0) || !(book.openCostSol > 0)) return null;
  return book.openCostSol / t;
}

// ─── Paper fills (critic #11) ──────────────────────────────────────────────
//
// Trader's paper model: PAPER_SIDE_COST (1.5 % a side, the same cost a real
// buy pays) on BOTH sides, plus the session's OWN price impact from
// constant-product math against the depth R when R is known. When it is not,
// the fill is flat and the trade carries PAPER_IMPACT_NOTE — in the thin coins
// this feature targets, a paper session that ignores its own impact beats
// live exactly where it matters. (paper.ts's PAPER_ROUND_TRIP_COST_PCT is the
// other paper model, for paper POSITIONS; Trader does not use it.)

export function paperBuyFill(sol: number, priceSol: number, depthSol: number | null, decimals: number): { tokensRaw: string; costSol: number; impactModelled: boolean } | null {
  if (!(sol > 0) || !(priceSol > 0)) return null;
  const net = sol * (1 - PAPER_SIDE_COST);
  let tokens: number;
  let impactModelled = false;
  if (depthSol !== null && depthSol > 0) {
    const Y = depthSol / priceSol;
    tokens = (Y * net) / (depthSol + net);
    impactModelled = true;
  } else {
    tokens = net / priceSol;
  }
  const raw = BigInt(Math.floor(tokens * 10 ** decimals));
  if (raw <= 0n) return null;
  return { tokensRaw: raw.toString(), costSol: sol, impactModelled };
}

export function paperSellFill(tokensRaw: bigint, decimals: number, priceSol: number, depthSol: number | null): { proceedsSol: number; impactModelled: boolean } | null {
  if (tokensRaw <= 0n || !(priceSol > 0)) return null;
  const t = Number(tokensRaw) / 10 ** decimals;
  let gross: number;
  let impactModelled = false;
  if (depthSol !== null && depthSol > 0) {
    const Y = depthSol / priceSol;
    gross = (depthSol * t) / (Y + t);
    impactModelled = true;
  } else {
    gross = t * priceSol;
  }
  return { proceedsSol: gross * (1 - PAPER_SIDE_COST), impactModelled };
}

// ─── Intents ───────────────────────────────────────────────────────────────

export type TraderIntent =
  | { action: 'hold'; reason: string }
  | { action: 'buy'; sol: number; reason: string; tag?: 'entry' | 'rebuy' | 'lot' | 'add' }
  | { action: 'sell'; pct: number; reason: string; exit?: boolean; tag?: 'trim' | 'rung' | 'tp' | 'stop' | 'user' | 'ai'; rung?: number };

const HOLD = (reason: string): TraderIntent => ({ action: 'hold', reason });

/** What a preset sees. Only the session's own book and its own marks — no
 *  market cap, no volume, no field priced in the coin's size (M7). */
export interface TraderView {
  now: number;
  /** SOL per whole token, FRESH (≤ STALE_PRICE_MS) or null. */
  priceSol: number | null;
  venue: 'curve' | 'pool' | null;
  curvePct: number | null;
  budgetSol: number;
  roomSol: number;
  tokensRaw: string;
  decimals: number | null;
  avgCostSol: number | null;
  openCostSol: number;
  entrySolDone: number;
  coreRaw: string | null;
  anchorPriceSol: number | null;
  lastTrim: { priceSol: number; solOut: number } | null;
  roundsToday: number;
  rungsDone: number[];
  lotsBought: number;
  peakPriceSol: number | null;
  /** The chain's smallest buy (TRADER_MONEY); absent = Solana's. */
  minBuy?: number;
  /** The chain's coin for the reasons ("SOL", "BNB", "ETH"); absent = SOL. */
  unit?: string;
}

const minBuyOf = (x: { minBuy?: number }): number => (typeof x.minBuy === 'number' && x.minBuy > 0 ? x.minBuy : TRADER_MIN_BUY_SOL);
const unitOf = (x: { unit?: string }): string => x.unit || 'SOL';

function entryIntent(v: TraderView, entryPct: number): TraderIntent | null {
  const target = v.budgetSol * (entryPct / 100);
  const left = target - v.entrySolDone;
  const min = minBuyOf(v);
  if (left < min || v.roomSol < min) return null;
  return { action: 'buy', sol: round(Math.min(left, v.roomSol), 6), reason: `entry: ${fmtSol(v.entrySolDone)} of ${fmtSol(target)} ${unitOf(v)} in`, tag: 'entry' };
}

function nearGrad(v: TraderView): boolean {
  return v.venue === 'curve' && v.curvePct !== null && v.curvePct >= NEAR_GRAD_PCT;
}

export function trimIntent(p: TrimParams, v: TraderView): TraderIntent {
  const px = v.priceSol;
  if (!px) return HOLD('price unknown or stale');
  // The pause is locked on while on the curve, whatever the toggle says.
  const noBuy = nearGrad(v) ? `curve at ${Math.round(v.curvePct ?? 0)}% — no buys near graduation` : null;
  const entry = entryIntent(v, p.entryPct);
  if (entry && v.coreRaw === null) return noBuy ? HOLD(noBuy) : entry;
  const held = big(v.tokensRaw);
  // Rebuy first: the SOL the matching trim took out, once price is far enough under it.
  if (v.lastTrim && px <= v.lastTrim.priceSol * (1 - p.rebuyDipPct / 100)) {
    if (noBuy) return HOLD(noBuy);
    const sol = Math.min(v.lastTrim.solOut, v.roomSol);
    if (sol >= minBuyOf(v)) return { action: 'buy', sol: round(sol, 6), reason: `${Math.round((1 - px / v.lastTrim.priceSol) * 100)}% under the last trim — buying its ${unitOf(v)} back`, tag: 'rebuy' };
  }
  const anchor = v.anchorPriceSol ?? v.avgCostSol;
  if (!anchor || held <= 0n) return HOLD('nothing to trim yet');
  if (px < anchor * (1 + p.stepPct / 100)) return HOLD(`${pctStr(px / anchor - 1)} vs anchor; trims at +${p.stepPct}%`);
  if (v.roundsToday >= p.maxRoundsPerDay) return HOLD(`${p.maxRoundsPerDay} trims today — the preset's daily cap`);
  const core = big(v.coreRaw);
  if (held <= core) return HOLD('only the core is left');
  const tradable = held - core;
  const sellRaw = (tradable * BigInt(Math.round(p.trimPct * 100))) / 10_000n;
  if (sellRaw <= 0n) return HOLD('trim too small');
  const pct = Number((sellRaw * 1_000_000n) / held) / 10_000;
  return { action: 'sell', pct: round(pct, 4), reason: `+${Math.round((px / anchor - 1) * 100)}% over the anchor — trimming ${p.trimPct}% of the tradable bag`, tag: 'trim' };
}

export function stepsIntent(p: StepsParams, v: TraderView): TraderIntent {
  const px = v.priceSol;
  if (!px) return HOLD('price unknown or stale');
  const entry = entryIntent(v, p.entryPct);
  if (entry && v.rungsDone.length === 0 && v.coreRaw === null) return nearGrad(v) ? HOLD('no buys near graduation') : entry;
  const held = big(v.tokensRaw);
  if (held <= 0n || !v.avgCostSol) return HOLD('nothing held');
  const x = px / v.avgCostSol;
  const left = [...p.rungs].sort((a, b) => a.upPct - b.upPct).filter((r) => !v.rungsDone.includes(r.upPct));
  if (left.length === 0) return HOLD('every step is sold; the rest is held');
  const due = left.find((r) => x >= 1 + r.upPct / 100);
  if (!due) return HOLD(`${pctStr(x - 1)} vs your average; next step +${left[0]!.upPct}%`);
  let pct = due.sellPct;
  if (p.recoverCostFirst && v.rungsDone.length === 0) {
    const t = uiTokens(held, v.decimals);
    const value = t !== null ? t * px * (1 - PAPER_SIDE_COST) : null;
    if (value && value > 0) pct = Math.min(100, Math.max(pct, (v.openCostSol / value) * 100));
  }
  return { action: 'sell', pct: round(pct, 4), reason: `reached +${due.upPct}%`, tag: 'rung', rung: due.upPct };
}

/** Lot i's SOL: base × mult^i, the lots summing to the budget. */
export function dipLotSol(p: DipsParams, budgetSol: number, i: number): number {
  let sum = 0;
  for (let k = 0; k < p.lots; k++) sum += p.sizeMult ** k;
  return (budgetSol / sum) * p.sizeMult ** i;
}

export function dipsIntent(p: DipsParams, v: TraderView): TraderIntent {
  const px = v.priceSol;
  if (!px) return HOLD('price unknown or stale');
  const held = big(v.tokensRaw);
  if (p.takeProfitPct !== null && held > 0n && v.avgCostSol && px >= v.avgCostSol * (1 + p.takeProfitPct / 100)) {
    return { action: 'sell', pct: 100, reason: `+${Math.round((px / v.avgCostSol - 1) * 100)}% over your average — target`, tag: 'tp' };
  }
  if (v.lotsBought >= p.lots) return HOLD(`all ${p.lots} lots are in`);
  if (nearGrad(v)) return HOLD('no buys near graduation');
  const lot = Math.min(dipLotSol(p, v.budgetSol, v.lotsBought), v.roomSol);
  if (lot < minBuyOf(v)) return HOLD('budget in use');
  if (v.lotsBought === 0) return { action: 'buy', sol: round(lot, 6), reason: 'first lot', tag: 'lot' };
  if (!v.avgCostSol) return HOLD('waiting for the first lot to settle');
  if (px > v.avgCostSol * (1 - p.stepPct / 100)) return HOLD(`${pctStr(px / v.avgCostSol - 1)} vs your average; next lot at −${p.stepPct}%`);
  if (v.peakPriceSol && px < v.peakPriceSol * (1 - p.maxBelowHighPct / 100)) return HOLD(`more than ${p.maxBelowHighPct}% under the session high — not catching this`);
  return { action: 'buy', sol: round(lot, 6), reason: `${Math.round((1 - px / v.avgCostSol) * 100)}% under your average — lot ${v.lotsBought + 1} of ${p.lots}`, tag: 'lot' };
}

export function holdIntent(p: HoldParams, v: TraderView): TraderIntent {
  const px = v.priceSol;
  if (!px) return HOLD('price unknown or stale');
  const entry = entryIntent(v, p.entryPct);
  if (entry && v.coreRaw === null) return nearGrad(v) ? HOLD('no buys near graduation') : entry;
  const held = big(v.tokensRaw);
  if (p.takeProfitPct !== null && held > 0n && v.avgCostSol && px >= v.avgCostSol * (1 + p.takeProfitPct / 100)) {
    return { action: 'sell', pct: 100, reason: `+${Math.round((px / v.avgCostSol - 1) * 100)}% over your average — target`, tag: 'tp' };
  }
  return HOLD(held > 0n ? 'holding' : 'nothing held');
}

/** What the session's preset wants now. */
export function presetIntent(preset: TraderPreset, params: TraderPresetParams, v: TraderView): TraderIntent {
  switch (preset) {
    case 'trim':
      return trimIntent(params as TrimParams, v);
    case 'steps':
      return stepsIntent(params as StepsParams, v);
    case 'dips':
      return dipsIntent(params as DipsParams, v);
    default:
      return holdIntent(params as HoldParams, v);
  }
}

/** Whether the preset's opening buys are done (the engine then fixes the core). */
export function entryDone(preset: TraderPreset, params: TraderPresetParams, v: Pick<TraderView, 'budgetSol' | 'entrySolDone' | 'roomSol' | 'minBuy'>): boolean {
  if (preset === 'dips') return true;
  const pct = (params as TrimParams | StepsParams | HoldParams).entryPct;
  const left = v.budgetSol * (pct / 100) - v.entrySolDone;
  const min = minBuyOf(v);
  return left < min || v.roomSol < min;
}

// ─── The guard ─────────────────────────────────────────────────────────────

/** Another source's fill of this coin: any of the user's wallets, a script,
 *  copy, MCP or a hand trade — anything that is not this session. */
export interface OtherFill {
  side: 'buy' | 'sell';
  at: number;
}

export interface TraderCheckContext {
  now: number;
  driver: TraderDriver;
  limits: TraderLimits;
  budgetSol: number;
  roomSol: number;
  /** Pool depth R, SOL. Null = unknown → no buy. */
  depthSol: number | null;
  venue: 'curve' | 'pool' | null;
  /** SOL per token and when it was read; stale → no buy, no non-exit sell. */
  priceSol: number | null;
  priceAt: number | null;
  tokensRaw: string;
  avgCostSol: number | null;
  lastTradeAt: number | null;
  lastAttemptAt: number | null;
  lastBuyAt: number | null;
  lastSellAt: number | null;
  lastBuyPriceSol: number | null;
  lastSellPriceSol: number | null;
  /** Attempts in the last hour, failures included. */
  tradeTimes: number[];
  buysWindow: { at: number; sol: number }[];
  losingAdds: number;
  /** The per-trade cap (D5). Null = none. */
  maxLiveSol: number | null;
  /** Round-trip cost at this size, for the per-coin D7 floor. */
  roundTripPct: number | null;
  otherFills: OtherFill[];
  /** A reason buys are held that is not a limit (venue changed, near graduation…). */
  buyHold: string | null;
  /** A sell whose fill has not settled — the claim is unknown until it does. */
  unsettledSell: boolean;
  /** The chain's smallest buy; absent = Solana's. */
  minBuy?: number;
  /** The chain's coin, for the reasons; absent = SOL. */
  unit?: string;
}

export type TraderCheck = { ok: true; intent: TraderIntent; notes: string[] } | { ok: false; reason: string };

/** The effective D7 floor for these limits, percent. 0 = off. */
export function oppositeFloorPct(limits: TraderLimits, venue: 'curve' | 'pool' | null, roundTripPct: number | null): number {
  if (limits.oppositeMovePct === null) return d7FloorPct(venue, roundTripPct);
  return limits.oppositeMovePct;
}

/** The earliest time the next non-exit trade may go, from the pacing limits. */
export function nextTradeAt(c: Pick<TraderCheckContext, 'now' | 'limits' | 'lastAttemptAt' | 'lastTradeAt' | 'tradeTimes'>): number | null {
  let at = c.now;
  const last = Math.max(c.lastAttemptAt ?? 0, c.lastTradeAt ?? 0);
  if (c.limits.minGapSec > 0 && last > 0) at = Math.max(at, last + c.limits.minGapSec * 1000);
  if (c.limits.maxTradesPerHour > 0) {
    const recent = c.tradeTimes.filter((t) => c.now - t < 3_600_000).sort((a, b) => a - b);
    if (recent.length >= c.limits.maxTradesPerHour) at = Math.max(at, recent[recent.length - c.limits.maxTradesPerHour]! + 3_600_000);
  }
  return at > c.now ? at : null;
}

/**
 * Whether an intent may run, and at what size. Every driver goes through
 * this — the preset, the AI key, MCP, and the user's own sell (as an exit).
 *
 * An EXIT (a stop, the time limit, the user's "sell session bag") skips the
 * pacing and anti-churn limits: they exist to stop a bot churning, and an
 * exit is the one trade that must never be held back. It still needs a bag.
 */
export function checkTraderIntent(intent: TraderIntent, c: TraderCheckContext): TraderCheck {
  const notes: string[] = [];
  if (intent.action === 'hold') return { ok: true, intent, notes };
  const L = c.limits;
  const fresh = c.priceSol !== null && c.priceSol > 0 && c.priceAt !== null && c.now - c.priceAt <= STALE_PRICE_MS;
  const exit = intent.action === 'sell' && intent.exit === true;

  if (intent.action === 'sell') {
    const held = big(c.tokensRaw);
    if (held <= 0n) return { ok: false, reason: 'nothing to sell' };
    if (c.unsettledSell) return { ok: false, reason: 'a sell is still settling — the bag is unknown until it does' };
    if (!Number.isFinite(intent.pct) || intent.pct <= 0) return { ok: false, reason: 'bad sell size' };
    const pct = Math.min(100, intent.pct);
    if (exit) return { ok: true, intent: { ...intent, pct }, notes };
    if (!fresh) return { ok: false, reason: 'price unknown or stale' };
  } else {
    if (!fresh) return { ok: false, reason: 'price unknown or stale' };
    if (c.buyHold) return { ok: false, reason: c.buyHold };
    if (c.depthSol === null || !(c.depthSol > 0)) return { ok: false, reason: 'pool depth unknown — no buys' };
  }

  // Pacing (M4). Attempts count, failures included (K6).
  if (L.maxTradesPerHour > 0) {
    const recent = c.tradeTimes.filter((t) => c.now - t < 3_600_000);
    if (recent.length >= L.maxTradesPerHour) return { ok: false, reason: `${L.maxTradesPerHour} trades in the last hour — your cap` };
  }
  const last = Math.max(c.lastAttemptAt ?? 0, c.lastTradeAt ?? 0);
  if (L.minGapSec > 0 && last > 0 && c.now - last < L.minGapSec * 1000) {
    return { ok: false, reason: `under your ${L.minGapSec} s gap since the last trade` };
  }

  const px = c.priceSol!;
  const floor = oppositeFloorPct(L, c.venue, c.roundTripPct);

  if (intent.action === 'sell') {
    // M1: minimum hold after a buy.
    if (L.minHoldSec > 0 && c.lastBuyAt !== null && c.now - c.lastBuyAt < L.minHoldSec * 1000) {
      return { ok: false, reason: `under your ${L.minHoldSec} s minimum hold after a buy` };
    }
    // M3: someone else of yours bought this coin just now.
    if (L.crossWalletSec > 0 && c.otherFills.some((f) => f.side === 'buy' && c.now - f.at < L.crossWalletSec * 1000)) {
      return { ok: false, reason: `another of your wallets or automations bought this coin in the last ${L.crossWalletSec} s` };
    }
    // D7: a sell after a buy needs the price to have moved up the floor.
    const lastWasBuy = c.lastBuyAt !== null && (c.lastSellAt === null || c.lastBuyAt > c.lastSellAt);
    if (floor > 0 && lastWasBuy && c.lastBuyPriceSol && px < c.lastBuyPriceSol * (1 + floor / 100)) {
      return { ok: false, reason: `price is under ${floor.toFixed(1)}% above the last buy` };
    }
    let pct = Math.min(100, intent.pct);
    if (L.minSellPctOfBag > 0 && pct < L.minSellPctOfBag) {
      return { ok: false, reason: `under your smallest sell (${L.minSellPctOfBag}% of the bag)` };
    }
    pct = round(pct, 4);
    return { ok: true, intent: { ...intent, pct }, notes };
  }

  // ── buys ──
  if (L.noRebuySec > 0 && c.lastSellAt !== null && c.now - c.lastSellAt < L.noRebuySec * 1000) {
    return { ok: false, reason: `inside your ${L.noRebuySec} s no-buy-back window after a sell` };
  }
  if (L.crossWalletSec > 0 && c.otherFills.some((f) => f.side === 'sell' && c.now - f.at < L.crossWalletSec * 1000)) {
    return { ok: false, reason: `another of your wallets or automations sold this coin in the last ${L.crossWalletSec} s` };
  }
  const lastWasSell = c.lastSellAt !== null && (c.lastBuyAt === null || c.lastSellAt > c.lastBuyAt);
  if (floor > 0 && lastWasSell && c.lastSellPriceSol && px > c.lastSellPriceSol * (1 - floor / 100)) {
    return { ok: false, reason: `price is not ${floor.toFixed(1)}% under the last sell` };
  }
  const aiDriven = c.driver === 'ai' || c.driver === 'mcp';
  if (aiDriven && L.maxLosingAdds > 0 && c.avgCostSol && px < c.avgCostSol && c.losingAdds >= L.maxLosingAdds) {
    return { ok: false, reason: `${L.maxLosingAdds} buys already made under water — your cap` };
  }
  let sol = intent.sol;
  const clip = (cap: number, why: string): void => {
    if (sol > cap) {
      sol = cap;
      notes.push(why);
    }
  };
  if (!Number.isFinite(sol) || sol <= 0) return { ok: false, reason: 'bad buy size' };
  if (L.maxBuyDepthPct > 0) clip((c.depthSol! * L.maxBuyDepthPct) / 100, `sized to ${L.maxBuyDepthPct}% of pool depth`);
  if (aiDriven && L.aiMaxBuyPctOfBudget > 0) clip((c.budgetSol * L.aiMaxBuyPctOfBudget) / 100, `sized to ${L.aiMaxBuyPctOfBudget}% of the budget`);
  const minBuy = minBuyOf(c);
  if (c.maxLiveSol !== null && c.maxLiveSol > 0) clip(c.maxLiveSol, `sized down to the ${c.maxLiveSol} ${unitOf(c)} per-trade cap`);
  if (L.maxDailyBuysX > 0) {
    const day = c.buysWindow.filter((b) => c.now - b.at < 86_400_000).reduce((a, b) => a + b.sol, 0);
    const cap = c.budgetSol * L.maxDailyBuysX - day;
    if (cap < minBuy) return { ok: false, reason: `buys in the last 24 h reached ${L.maxDailyBuysX}× the budget — buys stop, exits keep working` };
    clip(cap, `sized to your ${L.maxDailyBuysX}× daily buy cap`);
  }
  // Room is net of the reservation this buy will make, so compare before it.
  clip(c.roomSol / RESERVE_FACTOR, 'sized to the room left in the budget');
  if (sol < minBuy) {
    return { ok: false, reason: c.roomSol / RESERVE_FACTOR < minBuy ? 'the budget is in use' : `under the ${minBuy} ${unitOf(c)} minimum` };
  }
  return { ok: true, intent: { ...intent, sol: round(sol, 6) }, notes };
}

// ─── Stops ─────────────────────────────────────────────────────────────────

/**
 * A stop that is due now, or null. Pure — the engine latches the result as a
 * pending exit (it is never consumed while it cannot run). A stale or unknown
 * price NEVER triggers one (critic #5): max loss needs a fresh mark.
 */
export function stopDue(p: {
  now: number;
  expiresAt: number;
  budgetSol: number;
  maxLossPct: number;
  book: TraderBook;
  priceSol: number | null;
  priceAt: number | null;
  startDepthSol: number | null;
  depthSol: number | null;
  poolGone: boolean;
  /** The chain's coin, for the reason; absent = SOL. */
  unit?: string;
}): Omit<TraderPendingExit, 'since' | 'lastWarnAt'> | null {
  if (p.now >= p.expiresAt) return { kind: 'time_limit', reason: 'the time limit is up' };
  const fresh = p.priceSol !== null && p.priceSol > 0 && p.priceAt !== null && p.now - p.priceAt <= STALE_PRICE_MS;
  const held = big(p.book.tokensRaw) > 0n;
  if (held && p.poolGone) return { kind: 'liquidity', reason: 'the pool is gone' };
  if (held && p.startDepthSol !== null && p.depthSol !== null && p.startDepthSol > 0 && p.depthSol <= p.startDepthSol * 0.5) {
    return { kind: 'liquidity', reason: `pool depth fell ${Math.round((1 - p.depthSol / p.startDepthSol) * 100)}% from the session start` };
  }
  if (held && fresh && p.maxLossPct > 0) {
    const t = uiTokens(p.book.tokensRaw, p.book.decimals);
    if (t !== null) {
      const pnl = p.book.realisedSol + t * p.priceSol! - p.book.openCostSol;
      if (pnl <= -p.budgetSol * (p.maxLossPct / 100)) return { kind: 'max_loss', reason: `down ${fmtSol(-pnl)} ${unitOf(p)} — your ${p.maxLossPct}% max loss` };
    }
  }
  return null;
}

// ─── The page's derived row ────────────────────────────────────────────────

export function traderDerived(s: TraderSession, now: number): TraderDerived {
  const b = s.book;
  const tokens = uiTokens(b.tokensRaw, b.decimals);
  const fresh = s.lastPriceSol !== null && s.lastPriceAt !== null && now - s.lastPriceAt <= STALE_PRICE_MS;
  const px = s.lastPriceSol;
  const mark = tokens !== null && px !== null ? tokens * px : big(b.tokensRaw) === 0n ? 0 : null;
  const unrealised = mark !== null ? mark - b.openCostSol : null;
  const pnl = unrealised !== null ? b.realisedSol + unrealised : null;
  let vsHold: number | null = null;
  const base = s.holdBaseline;
  if (pnl !== null && base.priceSol && px) {
    const heldTokens = (base.solIn * (1 - PAPER_SIDE_COST)) / base.priceSol;
    const holdPnl = heldTokens * px - base.solIn;
    vsHold = pnl - holdPnl;
  }
  return {
    tokens,
    avgCostSol: avgCostSol(b),
    markSol: mark,
    unrealisedSol: unrealised,
    equitySol: pnl === null ? null : s.options.budgetSol + pnl,
    roomSol: roomSol(b, s.options.budgetSol, s.options.reinvest),
    vsHoldSol: vsHold,
    grossPnlSol: pnl === null ? null : pnl + b.feesSol,
    nextTradeAt: nextTradeAt({ now, limits: s.options.limits, lastAttemptAt: s.lastAttemptAt, lastTradeAt: s.lastTradeAt, tradeTimes: s.tradeTimes }),
    antiWashOff: traderAntiWashOff(s.options.limits),
    priceStale: !fresh,
  };
}

// ─── Entry as a series (critic #7) ─────────────────────────────────────────

/**
 * How many buys the preset's entry takes at these settings. The quant
 * results assumed ONE fill; with the per-trade cap (default 0.05 SOL) and a
 * 1 %-of-depth cap per buy, the default entry is ten buys and eats the hourly
 * trade allowance. The page shows `notice` before Start and must not treat
 * it as an edge case.
 */
export function entryPlan(p: { budgetSol: number; entryPct: number; maxLiveSol: number | null; depthSol: number | null; limits: TraderLimits; minBuy?: number; unit?: string }): { buys: number | null; minutes: number | null; notice: string | null } {
  const entry = p.budgetSol * (p.entryPct / 100);
  let per = entry;
  if (p.maxLiveSol !== null && p.maxLiveSol > 0) per = Math.min(per, p.maxLiveSol);
  if (p.limits.maxBuyDepthPct > 0) {
    if (p.depthSol === null) return { buys: null, minutes: null, notice: 'Pool depth unknown: the entry cannot be sized.' };
    per = Math.min(per, (p.depthSol * p.limits.maxBuyDepthPct) / 100);
  }
  const minBuy = minBuyOf(p);
  if (!(per >= minBuy)) return { buys: null, minutes: null, notice: `Each buy would be under the ${minBuy} ${unitOf(p)} minimum — raise the per-trade cap or pick a deeper coin.` };
  const buys = Math.ceil(entry / per - 1e-9);
  let minutes = ((buys - 1) * p.limits.minGapSec) / 60;
  if (p.limits.maxTradesPerHour > 0 && buys > p.limits.maxTradesPerHour) minutes = Math.max(minutes, Math.floor((buys - 1) / p.limits.maxTradesPerHour) * 60);
  const notice =
    buys > 1
      ? `The entry takes ${buys} buys of about ${fmtSol(per)} ${unitOf(p)} over ~${Math.ceil(minutes)} min (per-trade cap${p.limits.maxBuyDepthPct > 0 ? ' and depth cap' : ''}). The tested results assumed one fill; a series pays more and fills at moving prices.`
      : null;
  return { buys, minutes: Math.ceil(minutes), notice };
}

// ─── The fit check (design §4 + critic #10/#13) ────────────────────────────

export interface TraderFitInput {
  now: number;
  mint: string;
  /** The session chain (absent = Solana). Money figures are its coin. */
  chain?: ChainKind;
  /** 'curve' | 'pumpswap' (Solana) | 'pool' (an EVM v2/v3/v4 pool), or null
   *  for a venue that cannot be traded. */
  venue: 'curve' | 'pumpswap' | 'pool' | null;
  /** The venue in words, for the card. */
  venueLabel?: string | null;
  /** Why the venue cannot be traded, from the rail (e.g. "quoted in USDT,
   *  not BNB"). Used as the refusal when `venue` is null. */
  venueRefusal?: string | null;
  regime: 'classic' | 'mixed' | 'unknown' | null;
  curvePct: number | null;
  depthSol: number | null;
  /** Token side of the pool (whole tokens) and supply, for dump impact. */
  tokenReserve: number | null;
  supply: number | null;
  createdAt: number | null;
  devPct: number | null;
  top10Pct: number | null;
  sniperPct: number | null;
  bundledPct: number | null;
  trades1h: number | null;
  vol1hUsd: number | null;
  vol6hUsd: number | null;
  vol24hUsd: number | null;
  organic1hUsd: number | null;
  creatorLaunches: number | null;
  creatorGraduations: number | null;
  /** The creator address is known (live needs it). */
  creatorKnown: boolean;
  kryptScore: number | null;
  notSellable: boolean | null;
  transferFeeBps: number | null;
  defaultFrozen: boolean | null;
  /** M9 message when this is the user's own coin, else null. */
  ownCoin: string | null;
  holderRate: boolean;
  maxLiveSol: number | null;
  budgetSol: number;
  limits: TraderLimits;
  params?: Partial<TraderParamsByPreset>;
}

export function traderFit(i: TraderFitInput): TraderFit {
  const refusals: string[] = [];
  const liveRefusals: string[] = [];
  const notes: string[] = [];
  const greyed: Record<TraderPreset, string | null> = { trim: null, steps: null, dips: null, hold: null };
  const R = i.depthSol !== null && i.depthSol > 0 ? i.depthSol : null;
  const chain: ChainKind = i.chain ?? 'solana';
  const money = traderMoney(chain);
  const unit = money.symbol;
  const evm = chain !== 'solana';
  const venueKind: 'curve' | 'pool' | null = i.venue === 'curve' ? 'curve' : i.venue === 'pumpswap' || i.venue === 'pool' ? 'pool' : null;

  if (i.venue === null) {
    refusals.push(
      i.venueRefusal
        ? i.venueRefusal
        : evm
          ? `Krypto Trader trades ${unit}-quoted coins on this chain's launch curve or a ${unit} pool this app can route. This coin is neither, so its depth cannot be read.`
          : 'Krypto Trader trades pump.fun coins, on the curve or on PumpSwap, for now. This coin trades somewhere else, so its depth cannot be read.',
    );
  }
  // The classic / mixed curve split is pump.fun's (Pons and four.meme have no
  // mixed curves); on an EVM curve it does not apply and is not asked.
  if (!evm && i.venue === 'curve' && i.regime !== 'classic') {
    refusals.push(i.regime === 'mixed' ? 'Mixed bonding curve: sells drain it ~5× faster and it graduates into a pool seeded with ~0.16 SOL. No preset fits.' : 'The curve type is unknown, and on the curve an unknown type is treated as not classic.');
  }
  if (i.notSellable === true) refusals.push('Jupiter Shield says this coin is not sellable.');
  if (i.transferFeeBps !== null && i.transferFeeBps > 0) refusals.push(`Token-2022 transfer fee (${i.transferFeeBps / 100}%) on every move.`);
  if (i.defaultFrozen === true) refusals.push('New token accounts are frozen by default.');
  if (R === null && i.venue !== null) refusals.push(evm ? `Pool depth could not be read in ${unit} — no buy can be sized, so the session is refused.` : 'Pool depth could not be read.');
  if (evm && i.venue === 'curve' && chain === 'bnb') notes.push('Many four.meme coins charge a creator tax on buys that the curve quote does not show (1–10% seen): a buy can land short of the quote.');
  if (i.ownCoin) refusals.push(i.ownCoin);
  if (!i.creatorKnown) liveRefusals.push('The creator is unknown, so live trading is refused (paper is allowed).');

  const cap = ruleBMaxPositionSol(R, 10);
  const clipped = cap === null ? null : Math.min(i.budgetSol, cap);
  if (clipped !== null && clipped < i.budgetSol) notes.push(`Clipped to ${fmtSol(clipped)} ${unit}: a full exit would move price more than 10%.`);
  if (clipped !== null && clipped < money.minBudget) refusals.push(`The pool is too thin for the smallest budget (${money.minBudget} ${unit}) at a 10% exit move.`);
  const size = clipped ?? i.budgetSol;
  const perTrade = Math.min(size, i.maxLiveSol !== null && i.maxLiveSol > 0 ? i.maxLiveSol : size);
  const rt = roundTripCostPct(perTrade, R, venueKind, { holderRate: i.holderRate });
  const floor = d7FloorPct(venueKind, rt);
  const tph = i.trades1h;
  const thin = tph !== null && tph < THIN_TRADES_PER_HOUR;
  if (thin) notes.push('Your orders would be most of the market.');

  const P: TraderParamsByPreset = {
    trim: { ...DEFAULT_TRADER_PARAMS.trim, ...(i.params?.trim ?? {}) },
    steps: { ...DEFAULT_TRADER_PARAMS.steps, ...(i.params?.steps ?? {}) },
    dips: { ...DEFAULT_TRADER_PARAMS.dips, ...(i.params?.dips ?? {}) },
    hold: { ...DEFAULT_TRADER_PARAMS.hold, ...(i.params?.hold ?? {}) },
  };
  // Trim and rebuy.
  {
    const p = P.trim;
    const why: string[] = [];
    if (p.stepPct < floor) why.push(`a ${p.stepPct}% step is under this coin's ${floor.toFixed(1)}% floor (twice the round-trip cost)`);
    if (R !== null && (perTrade / R) * 100 > p.stepPct / 8) why.push('each trade moves price more than an eighth of the step');
    if (thin) why.push(`under ${THIN_TRADES_PER_HOUR} trades an hour`);
    if (i.venue === 'curve' && !p.pauseNearGrad) why.push('on the curve the 95% pause must stay on');
    greyed.trim = why.length ? why.join('; ') : null;
  }
  // Take profit in steps.
  if (R !== null) {
    const rungs = [...P.steps.rungs].sort((a, b) => a.upPct - b.upPct);
    let prev = 0;
    for (const r of rungs) {
      const s = size * (r.sellPct / 100) * (1 + r.upPct / 100);
      const move = sellMovePct(s, R);
      if (move !== null && move > (r.upPct - prev) / 2) {
        greyed.steps = `the +${r.upPct}% step's sell moves price ${move.toFixed(1)}%, more than half the gap to the step before it`;
        break;
      }
      prev = r.upPct;
    }
  }
  // Buy dips.
  {
    const p = P.dips;
    const why: string[] = [];
    const lot = dipLotSol(p, size, p.lots - 1);
    const a = ruleAMaxTradeSol(R, 2);
    if (a !== null && lot > a) why.push(`a ${fmtSol(lot)} ${unit} lot moves price more than 2% (Rule A: ${fmtSol(a)} ${unit})`);
    const dt = dumpImpact(i.tokenReserve, i.supply, i.devPct !== null && i.top10Pct !== null ? i.devPct + i.top10Pct : null);
    if (dt !== null && 1 - dt > p.stepPct / 100) why.push('One holder can make every dip.');
    if (thin) why.push(`under ${THIN_TRADES_PER_HOUR} trades an hour, buying each dip is most of the buy side`);
    greyed.dips = why.length ? why.join('; ') : null;
  }
  if (refusals.length) for (const k of TRADER_PRESETS) greyed[k] = greyed[k] ?? 'the coin is refused';

  const entryPct = (P.hold.entryPct ?? 100);
  const plan = entryPlan({ budgetSol: size, entryPct, maxLiveSol: i.maxLiveSol, depthSol: R, limits: i.limits, minBuy: money.minBuy, unit });

  let trend: TraderFit['volumeTrend'] = null;
  if (i.vol1hUsd !== null && i.vol6hUsd !== null && i.vol6hUsd > 0) {
    const r = i.vol1hUsd / (i.vol6hUsd / 6);
    trend = r > 1.2 ? 'rising' : r < 0.8 ? 'falling' : 'flat';
  }
  const graduationNote =
    i.venue === 'curve' && evm
      ? `If the curve completes, the coin moves to its ${chain === 'bnb' ? 'PancakeSwap' : 'Uniswap'} pool; buys wait for a fresh price there, exits keep working.`
      : i.venue === 'curve'
      ? i.regime === 'classic'
        ? 'If it completes, the pool opens within 2% of the curve price (97.8% of classic graduations).'
        : i.regime === 'mixed'
          ? 'If it completes, the pool opens a median 15% lower, seeded with ~0.16 SOL.'
          : null
      : null;
  const age = i.createdAt !== null ? Math.max(0, (i.now - i.createdAt) / 1000) : null;
  if (age !== null && age > 120) notes.push('Graduation odds only exist at +60/+120 s; this coin is past that.');

  return {
    mint: i.mint,
    chain,
    native: unit,
    venue: i.venue,
    venueLabel: i.venueLabel ?? (i.venue === 'curve' && !evm ? 'pump.fun curve' : i.venue === 'pumpswap' ? 'PumpSwap pool' : null),
    regime: evm ? null : i.regime,
    curvePct: i.curvePct,
    depthSol: R,
    budgetPctOfDepth: R !== null ? (size / R) * 100 : null,
    fullExitMovePct: R !== null ? sellMovePct(size, R) : null,
    maxTradeAt2PctSol: ruleAMaxTradeSol(R, 2),
    budgetCapSol: cap,
    clippedBudgetSol: clipped,
    graduationNote,
    ageSec: age,
    dumpImpact: {
      dev: dumpImpact(i.tokenReserve, i.supply, i.devPct),
      top10: dumpImpact(i.tokenReserve, i.supply, i.top10Pct),
      sniper: dumpImpact(i.tokenReserve, i.supply, i.sniperPct),
      bundled: dumpImpact(i.tokenReserve, i.supply, i.bundledPct),
    },
    tradesPerHour: tph,
    volumeTrend: trend,
    organicSharePct: i.organic1hUsd !== null && i.vol1hUsd !== null && i.vol1hUsd > 0 ? (i.organic1hUsd / i.vol1hUsd) * 100 : null,
    creator: { launches: i.creatorLaunches, graduations: i.creatorGraduations },
    kryptScore: i.kryptScore,
    roundTripCostPct: rt,
    d7FloorPct: R !== null ? floor : null,
    maxLiveSol: i.maxLiveSol,
    entryBuys: plan.buys,
    entryBlockingNotice: plan.notice,
    refusals,
    liveRefusals,
    greyed,
    notes,
    noForecastLine: FIT_NO_FORECAST_LINE,
    forwardLine: FIT_FORWARD_LINE,
  };
}

// ─── The AI reply (stage 3's driver; strict) ───────────────────────────────

const AI_KEYS = new Set(['action', 'sol', 'percent', 'next_check_sec', 'reason']);

/**
 * A model reply → an intent, or null (treated as hold). STRICT, unlike
 * Krypto Mode's parser: the reply must be exactly one JSON object (no prose
 * around it — structured output guarantees that), no key outside the schema,
 * never `sol` and `percent` both set, `next_check_sec` 30..1800, reason ≤ 160.
 */
export function parseTraderAiReply(raw: unknown): { intent: TraderIntent; nextCheckSec: number } | null {
  if (typeof raw !== 'string') return null;
  let j: unknown;
  try {
    j = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (Object.keys(o).some((k) => !AI_KEYS.has(k))) return null;
  const has = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  if (has('sol') && has('percent')) return null;
  const reason = o.reason;
  if (typeof reason !== 'string' || reason.length > 160) return null;
  const n = o.next_check_sec;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 30 || n > 1800) return null;
  if (o.action === 'hold') {
    if (has('sol') || has('percent')) return null;
    return { intent: { action: 'hold', reason: reason || 'model says hold' }, nextCheckSec: n };
  }
  if (o.action === 'buy') {
    const sol = o.sol;
    if (typeof sol !== 'number' || !Number.isFinite(sol) || sol <= 0) return null;
    return { intent: { action: 'buy', sol, reason, tag: 'add' }, nextCheckSec: n };
  }
  if (o.action === 'sell') {
    const pct = o.percent;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
    return { intent: { action: 'sell', pct, reason, tag: 'ai' }, nextCheckSec: n };
  }
  return null;
}

// ─── The AI driver's facts and cadence (stage 3) ───────────────────────────

/**
 * The price at which the max-loss stop fires, from the session's own book:
 * realised + tokens × p − open cost = −budget × maxLoss%. Null with no bag or
 * an unknown decimals count; 0 or below (the stop cannot be reached by price)
 * is returned as 0.
 */
export function stopPriceSol(book: TraderBook, budgetSol: number, maxLossPct: number): number | null {
  const t = uiTokens(book.tokensRaw, book.decimals);
  if (t === null || !(t > 0) || !(maxLossPct > 0)) return null;
  const p = (book.openCostSol - book.realisedSol - budgetSol * (maxLossPct / 100)) / t;
  return p > 0 ? p : 0;
}

/**
 * The facts a driver (AI key or MCP) sees for one session. Numbers and
 * app-defined values ONLY — never `s.symbol`, never anything a coin's creator
 * or a provider wrote (T26). The coin is "the coin". The user's thesis is the
 * one free text, and it is the user's own, labelled an opinion.
 */
export function traderAiFacts(
  s: TraderSession,
  m: TraderMarketFacts,
  c: { now: number; maxLiveSol: number | null; roundTripPct: number | null; curvePct: number | null },
): TraderAiFacts {
  const now = c.now;
  const L = s.options.limits;
  const fresh = s.lastPriceSol !== null && s.lastPriceAt !== null && now - s.lastPriceAt <= STALE_PRICE_MS;
  const px = s.lastPriceSol;
  const d = traderDerived(s, now);
  const floor = oppositeFloorPct(L, s.lastVenue, c.roundTripPct);
  const r = (n: number | null | undefined, dp = 6): number | null => (typeof n === 'number' && Number.isFinite(n) ? round(n, dp) : null);
  const sig = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toPrecision(6)) : null);
  const secsTo = (t: number | null): number | null => (t !== null && t > now ? Math.ceil((t - now) / 1000) : null);
  const aiDriven = s.options.driver === 'ai' || s.options.driver === 'mcp';
  // What the next buy may be at most, before the pool-depth and room checks the guard does at the time.
  const caps: number[] = [d.roomSol / RESERVE_FACTOR];
  if (L.maxBuyDepthPct > 0 && s.lastDepthSol !== null) caps.push((s.lastDepthSol * L.maxBuyDepthPct) / 100);
  if (aiDriven && L.aiMaxBuyPctOfBudget > 0) caps.push((s.options.budgetSol * L.aiMaxBuyPctOfBudget) / 100);
  if (c.maxLiveSol !== null && c.maxLiveSol > 0) caps.push(c.maxLiveSol);
  if (L.maxDailyBuysX > 0) caps.push(s.options.budgetSol * L.maxDailyBuysX - s.buysWindow.filter((b) => now - b.at < 86_400_000).reduce((a, b) => a + b.sol, 0));
  const maxBuy = s.lastDepthSol === null ? null : Math.max(0, Math.min(...caps));
  const lastWasBuy = s.lastBuyAt !== null && (s.lastSellAt === null || s.lastBuyAt > s.lastSellAt);
  const noBuyUntil = Math.max(L.noRebuySec > 0 && s.lastSellAt !== null ? s.lastSellAt + L.noRebuySec * 1000 : 0, 0);
  const noSellUntil = L.minHoldSec > 0 && s.lastBuyAt !== null && lastWasBuy ? s.lastBuyAt + L.minHoldSec * 1000 : 0;
  const lo = m.range1hLowSol;
  const hi = m.range1hHighSol;
  return {
    coin: 'the coin',
    chain: s.options.chain ?? 'solana',
    money_unit: traderUnit(s.options.chain),
    preset: s.options.preset,
    style: TRADER_AI_STYLE[s.options.preset],
    mode: s.mode,
    price: {
      sol_per_token: fresh ? sig(px) : null,
      age_sec: s.lastPriceAt !== null ? Math.max(0, Math.round((now - s.lastPriceAt) / 1000)) : null,
      venue: s.lastVenue,
      curve_pct: s.lastVenue === 'curve' ? r(c.curvePct, 1) : null,
    },
    liquidity: {
      depth_sol_now: r(s.lastDepthSol, 3),
      depth_sol_at_start: r(s.startDepthSol, 3),
      change_pct: s.lastDepthSol !== null && s.startDepthSol ? r((s.lastDepthSol / s.startDepthSol - 1) * 100, 1) : null,
    },
    market: {
      market_cap_usd: r(m.marketCapUsd, 0),
      holders: r(m.holders, 0),
      top10_pct: r(m.top10Pct, 1),
      change_pct: { m5: r(m.change5mPct, 1), m15: r(m.change15mPct, 1), h1: r(m.change1hPct, 1), h6: r(m.change6hPct, 1), h24: r(m.change24hPct, 1) },
      range_1h: {
        low_sol: sig(lo),
        high_sol: sig(hi),
        position_pct: fresh && lo !== null && hi !== null && hi > lo ? r(((px! - lo) / (hi - lo)) * 100, 0) : null,
      },
      volume_5m_vs_1h_avg: r(m.vol5mVs1hAvg, 2),
      buys_5m: r(m.buys5m, 0),
      sells_5m: r(m.sells5m, 0),
      closes_5m_pct_vs_now: fresh && px ? m.closes5mSol.slice(-12).filter((x) => Number.isFinite(x) && x > 0).map((x) => round((x / px - 1) * 100, 1)) : [],
    },
    book: {
      tokens: r(d.tokens, 2),
      avg_cost_sol: sig(d.avgCostSol),
      open_cost_sol: round(s.book.openCostSol, 6),
      realised_sol: round(s.book.realisedSol, 6),
      unrealised_sol: r(d.unrealisedSol, 6),
      fees_sol: round(s.book.feesSol, 6),
      budget_sol: s.options.budgetSol,
      room_sol: round(d.roomSol, 6),
      session_high_sol: sig(s.peakPriceSol),
      session_low_sol: sig(s.ai?.lowPriceSol ?? null),
      vs_hold_sol: r(d.vsHoldSol, 6),
    },
    last_fills: s.trades.slice(0, 8).map((t) => ({
      ago_sec: Math.max(0, Math.round((now - t.at) / 1000)),
      side: t.side,
      sol: r(t.sol, 6),
      pct_of_bag: r(t.pct, 2),
      price_sol: sig(t.priceSol),
      ok: t.ok,
      by: t.by,
    })),
    limits: {
      next_trade_in_sec: secsTo(d.nextTradeAt),
      max_buy_sol_now: r(maxBuy, 6),
      min_buy_sol: traderMoney(s.options.chain).minBuy,
      min_sell_pct_of_bag: L.minSellPctOfBag,
      opposite_move_pct: round(floor, 1),
      no_buy_until_sec: secsTo(noBuyUntil || null),
      no_sell_until_sec: secsTo(noSellUntil || null),
      losing_adds_left: aiDriven && L.maxLosingAdds > 0 ? Math.max(0, L.maxLosingAdds - s.losingAdds) : null,
      stop_price_sol: sig(stopPriceSol(s.book, s.options.budgetSol, s.options.maxLossPct)),
      max_loss_sol: round(s.options.budgetSol * (s.options.maxLossPct / 100), 6),
      time_left_min: Math.max(0, Math.round((s.expiresAt - now) / 60_000)),
    },
    user_thesis_opinion: s.options.thesis.trim() ? s.options.thesis.trim().slice(0, 500) : null,
  };
}

export type TraderAiDue = { ask: true; trigger: string } | { ask: false; why: string | null };

/**
 * Whether the AI driver asks its model now (design §7). Pure. The triggers:
 * the price moved ≥ max(4 %, the D7 floor) since the last ask; one of the
 * session's own trades filled or failed; a new session high or low; the price
 * within 10 % of the stop; the model's own next_check_sec is due; a 5-minute
 * heartbeat. Held back by the user's AI pacing (a 5 s floor, never lower) and
 * the day's spend cap — which pauses asks only; the stops keep running.
 */
export function traderAiDue(p: {
  now: number;
  limits: Pick<TraderLimits, 'aiMinGapSec' | 'aiMaxAsksPerHour'>;
  ai: TraderAiState;
  /** Fresh price or null (no ask on a stale price: nothing new to say). */
  priceSol: number | null;
  peakPriceSol: number | null;
  stopPriceSol: number | null;
  floorPct: number;
  spentTodayUsd: number;
  dailyCapUsd: number;
}): TraderAiDue {
  const a = p.ai;
  if (p.dailyCapUsd > 0 && p.spentTodayUsd >= p.dailyCapUsd) return { ask: false, why: `AI paused: $${p.spentTodayUsd.toFixed(2)} spent today — your $${p.dailyCapUsd} daily cap. The stops keep running.` };
  const gap = Math.max(TRADER_AI_MIN_GAP_FLOOR_SEC, p.limits.aiMinGapSec) * 1000;
  if (a.lastAskAt !== null && p.now - a.lastAskAt < gap) return { ask: false, why: null };
  if (p.limits.aiMaxAsksPerHour > 0 && a.askTimes.filter((t) => p.now - t < 3_600_000).length >= p.limits.aiMaxAsksPerHour) {
    return { ask: false, why: `AI waiting: ${p.limits.aiMaxAsksPerHour} asks in the last hour — your cap.` };
  }
  if (a.lastAskAt === null) return { ask: true, trigger: 'first look' };
  if (a.eventAt !== null) return { ask: true, trigger: 'a trade of the session filled or failed' };
  const px = p.priceSol;
  if (px !== null) {
    const move = Math.max(TRADER_AI_MOVE_PCT, p.floorPct);
    if (a.askPriceSol && Math.abs(px / a.askPriceSol - 1) * 100 >= move) return { ask: true, trigger: `price moved ${pctStr(px / a.askPriceSol - 1)} since the last look` };
    if (a.askHighSol !== null && p.peakPriceSol !== null && p.peakPriceSol > a.askHighSol) return { ask: true, trigger: 'a new session high' };
    if (a.askLowSol !== null && a.lowPriceSol !== null && a.lowPriceSol < a.askLowSol) return { ask: true, trigger: 'a new session low' };
    if (p.stopPriceSol !== null && p.stopPriceSol > 0 && px <= p.stopPriceSol * (1 + TRADER_AI_NEAR_STOP_PCT / 100)) return { ask: true, trigger: 'the price is near the stop' };
  }
  if (a.nextCheckAt !== null && p.now >= a.nextCheckAt) return { ask: true, trigger: 'the model asked to look again now' };
  if (p.now - a.lastAskAt >= TRADER_AI_HEARTBEAT_MS) return { ask: true, trigger: 'the 5-minute check' };
  return { ask: false, why: null };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function round(n: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
}
function pctStr(f: number): string {
  return `${f >= 0 ? '+' : ''}${Math.round(f * 100)}%`;
}
function fmtSol(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}
