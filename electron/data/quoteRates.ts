// SOL per raw unit of a pump.fun QUOTE token.
//
// 2026-10-26, user report: the chart of 5skM7cwc…pump ("Reddit Inc.") flipped
// between two prices. The coin's bonding curve is quoted in RDDT — Backpack's
// tokenized Reddit stock, a 6-decimal Token-2022 mint — not SOL. pump's
// program zeroes every SOL field on such a curve's trades and account (the
// money sits in `quote_*` fields and the account's reserve slot holds RDDT),
// so everything in this app that divided a "SOL" figure by 1e9 priced the
// coin ~700× too low: the header said a few dollars of market cap, the curve
// subscription pushed ticks at that price, and Birdeye — which prices it
// right — drew the same minute at $15k. Two sources, two units, one bar.
//
// This module is the conversion. One Jupiter search answers decimals, symbol
// and USD price for the quote token; with the SOL/USD rate the app already
// memoises, SOL per RAW quote unit = usd ÷ solUsd ÷ 10^decimals. Everything
// downstream keeps working in SOL and lamports — the engine multiplies a raw
// quote amount by this and carries on. No rate yet → null, and the caller
// skips rather than prices (honest-null rule). Quote mints are a short list
// (tokenized stocks, maybe a stablecoin), so this costs one request per
// quote token per thirty seconds while one is on screen or trading.

import * as jup from './providers/jupiter';
import { cached, memo, staleValue } from './http';

export interface QuoteRate {
  mint: string;
  symbol: string | null;
  decimals: number;
  /** USD per WHOLE quote token. */
  usd: number;
  solUsd: number;
  /** SOL per one RAW unit (10^-decimals of a token): what a lamport is to SOL. */
  solPerUnit: number;
  at: number;
}

const RATE_TTL_MS = 30_000;
const key = (mint: string): string => `quoterate:${mint}`;

/** SOL per raw unit of `mint`, from what is already in memory: the fresh
 *  value, else the last good one inside its grace (a stock does not move
 *  700× in five minutes, and the chart edge must not stall on a Jupiter
 *  park). Null when nothing has been fetched yet — then `want()` fires so
 *  the next tick has it. Synchronous: this is on the trade hot path. */
export function solPerUnit(mint: string): number | null {
  const fresh = cached<QuoteRate>(key(mint));
  if (fresh) return fresh.solPerUnit;
  want(mint);
  const stale = staleValue<QuoteRate>(key(mint));
  return stale ? stale.value.solPerUnit : null;
}

/** The quote token's symbol, if the rate has ever been read. */
export function symbolOf(mint: string): string | null {
  return cached<QuoteRate>(key(mint))?.symbol ?? staleValue<QuoteRate>(key(mint))?.value.symbol ?? null;
}

/** Everything known about the quote token, from memory. */
export function rateIfCached(mint: string): QuoteRate | null {
  return cached<QuoteRate>(key(mint)) ?? staleValue<QuoteRate>(key(mint))?.value ?? null;
}

/** Fetch in the background; the memo dedupes concurrent asks. */
export function want(mint: string): void {
  void ensure(mint).catch(() => {
    /* the memo already answered null; nothing to add */
  });
}

/** The rate, fetching it when it is not in memory. Null when Jupiter does
 *  not price the token (or is parked) or SOL/USD is unknown. */
export async function ensure(mint: string): Promise<QuoteRate | null> {
  return memo<QuoteRate>(key(mint), RATE_TTL_MS, async () => {
    const [rows, solUsd] = await Promise.all([jup.search(mint), jup.solUsd()]);
    const t = rows.find((r) => r.id === mint);
    const usd = t?.usdPrice;
    const decimals = t?.decimals;
    if (!t || typeof usd !== 'number' || !(usd > 0) || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    if (solUsd === null || !(solUsd > 0)) return null;
    const solPerUnit = usd / solUsd / 10 ** decimals;
    if (!Number.isFinite(solPerUnit) || solPerUnit <= 0) return null;
    return { mint, symbol: t.symbol?.trim() || null, decimals, usd, solUsd, solPerUnit, at: Date.now() };
  });
}
