// Two small decisions lifted out of engine.ts so a test can pin them
// (2026-09-27): which locally-known price a mint gets, and when a pump-amm
// delivery is worth decoding.
//
// WHY. A launch row's `priceSol` is the bonding curve's spot, written on
// every curve trade. When the curve completes that write stops — the last
// one is the graduation price (4.1088e-7 SOL, ~$50k) — and the coin goes on
// trading on PumpSwap. The engine's cheap price read (a script's bot.price,
// paper marks, the fee estimate) preferred the row over everything else, so
// every migrated coin read as its graduation price for as long as the row
// lived. User report (Callout Farm, 5.2.1): six calls whose "$50k" entries
// were really $2.4k–$18k, a $25k confirm that passed coins down 90 %, a
// "down 20 %" guard that never fired.

/** A price and the moment it was seen. */
export interface TimedPrice {
  priceSol: number;
  at: number;
}

export interface CheapPriceInput {
  /** The launch row's price — the curve's spot; null when untracked. */
  rowPriceSol: number | null;
  /** The curve is complete: the row's price is the graduation price. */
  curveComplete: boolean;
  /** Prices from the other local sources — the last-known map, the tape,
   *  the chain read's cache — each with its time. Any order. */
  timed: TimedPrice[];
}

const usable = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0;

/**
 * The cheapest honest price, or null.
 *
 * On the curve the row IS the live spot and wins. Once the curve is complete
 * the newest timed price wins — an AMM swap the feed heard, the orders
 * poller's summary, the tape — and the row is the last resort: at the moment
 * of migration the graduation price is also the pool's opening price, so it
 * is right until the pool prints and wrong from then on.
 */
export function cheapPrice(i: CheapPriceInput): number | null {
  if (!i.curveComplete && usable(i.rowPriceSol)) return i.rowPriceSol;
  let best: TimedPrice | null = null;
  for (const t of i.timed) {
    if (!usable(t.priceSol) || !Number.isFinite(t.at)) continue;
    if (best === null || t.at > best.at) best = t;
  }
  if (best) return best.priceSol;
  return usable(i.rowPriceSol) ? i.rowPriceSol : null;
}

export interface AmmDecodeInput {
  shadowStratLab: boolean;
  shadowMigration: boolean;
  /** Mints the terminal tape is subscribed to (open charts). */
  tapeSubscribed: number;
  /** An advanced order is armed on something. */
  ordersArmed: boolean;
  /** An armed script holds or subscribed to something (automation.wantsAnyTicks). */
  scriptsWantTicks: boolean;
}

/**
 * Is a pump-amm delivery worth decoding? The feed carries every PumpSwap
 * swap; decoding is skipped while nothing could use one. A script following
 * a coin it holds or watches counts (2026-09-27): before, its ticks and its
 * price stopped at the migration unless a chart was open or an order armed.
 */
export function ammDecodeWanted(i: AmmDecodeInput): boolean {
  return i.shadowStratLab || i.shadowMigration || i.tapeSubscribed > 0 || i.ordersArmed || i.scriptsWantTicks;
}
