// A pump.fun curve's figures in SOL, whatever the curve is quoted in.
//
// Since 2026-10 pump launches coins against tokenized stocks (Backpack's
// RDDT, …). On such a curve the program writes ZERO into every SOL field of
// its trade events and keeps the money in `quote_*` fields, in the quote
// token's raw units; the curve account's reserve slots hold the quote token
// too. Read as SOL, that is a price ~700× too low and a volume of nothing
// (user report 2026-10-26, "conflicting results overriding each other" on
// the chart — our feed at $2, Birdeye at $15k).
//
// The engine, the orders, the tape and the chart all think in SOL and
// lamports, and should keep doing so. So the conversion happens HERE, once,
// at the edge: a raw quote amount × SOL-per-raw-unit = SOL, and the virtual
// quote reserve converted the same way is a virtual SOL reserve the ordinary
// curve math accepts. No rate known → null, and the caller skips: a tick at
// a wrong price is worse than no tick.
//
// Pure. The rate comes in as a function so this is testable without Jupiter.

import type { PumpTradeEvent } from './pumpDecoder';
import type { CurveState } from './txBuilder';
import { spotPriceSol, LAMPORTS_PER_SOL } from './curve';

export interface TradeInSol {
  /** Lamports that changed hands (the event's own `sol_amount` on a SOL
   *  curve; the quote amount converted on any other). */
  solLamports: bigint;
  /** The SOL that changed hands, whole units. */
  sol: number;
  /** Virtual SOL reserves after the trade, lamports — the ordinary curve
   *  math (progress, spot price) accepts this on either kind of curve. */
  vSol: bigint;
  /** Spot price after the trade, SOL per whole token. */
  priceSol: number;
}

/** SOL-per-raw-unit of a quote mint, or null when not known yet. */
export type QuoteRateFn = (quoteMint: string) => number | null;

/** Raw quote units → lamports at `solPerUnit`; null while the rate is
 *  unknown (never a figure in the wrong unit). */
export function rawToLamports(raw: bigint, solPerUnit: number | null): bigint | null {
  if (solPerUnit === null || !(solPerUnit > 0)) return null;
  return lamportsOf(raw, solPerUnit);
}

function lamportsOf(raw: bigint, solPerUnit: number): bigint {
  const l = Number(raw) * solPerUnit * LAMPORTS_PER_SOL;
  return Number.isFinite(l) && l > 0 ? BigInt(Math.round(l)) : 0n;
}

/**
 * A trade's SOL figures. On a SOL curve this is the event itself; on a
 * quote-paired curve it is the quote fields converted at `rate(quoteMint)`,
 * or null while that rate is unknown.
 */
export function tradeInSol(ev: PumpTradeEvent, rate: QuoteRateFn): TradeInSol | null {
  if (ev.quoteMint === null) {
    return {
      solLamports: ev.solAmount,
      sol: Number(ev.solAmount) / LAMPORTS_PER_SOL,
      vSol: ev.virtualSolReserves,
      priceSol: spotPriceSol(ev.virtualSolReserves, ev.virtualTokenReserves),
    };
  }
  if (ev.quoteAmount === null || ev.virtualQuoteReserves === null) return null;
  const r = rate(ev.quoteMint);
  if (r === null || !(r > 0)) return null;
  const solLamports = lamportsOf(ev.quoteAmount, r);
  const vSol = lamportsOf(ev.virtualQuoteReserves, r);
  return {
    solLamports,
    sol: Number(solLamports) / LAMPORTS_PER_SOL,
    vSol,
    priceSol: spotPriceSol(vSol, ev.virtualTokenReserves),
  };
}

/**
 * A curve ACCOUNT's virtual SOL reserve, lamports. The account keeps one
 * reserve slot whatever the quote: on a SOL curve it is lamports already; on
 * a quote curve it is raw quote units and is converted. Null = rate unknown.
 */
export function curveVSolLamports(st: Pick<CurveState, 'vSol' | 'quoteMint'>, rate: QuoteRateFn): bigint | null {
  if (st.quoteMint === null) return st.vSol;
  const r = rate(st.quoteMint);
  if (r === null || !(r > 0)) return null;
  return lamportsOf(st.vSol, r);
}
