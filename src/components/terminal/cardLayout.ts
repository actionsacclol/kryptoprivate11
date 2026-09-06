// Where every line on a share card sits.
//
// Pulled out of the drawing code because it is the one part that can be
// wrong in a way nobody notices until the image is already on someone's
// timeline: text drawn on a canvas does not wrap, reflow or complain, it
// just overlaps. A trade card carries three supporting rows plus a result
// line, which is exactly the case that collided with the footer.
//
// Pure, so a test can assert the baselines never come within a line of each
// other for any row count the card can produce.

export const CARD_W = 1200;
export const CARD_H = 675;

/** Left margin for every line, and the plate inset it sits inside. */
export const CARD_PAD = 88;

export interface CardLayout {
  /** Baseline of the $TICKER line. */
  ticker: number;
  /** Baseline of the big percentage. */
  big: number;
  /** Baselines of the supporting rows, in order. */
  rows: number[];
  /** Baseline of the result line, when there is one. */
  pnl: number | null;
  /** Baseline of the bottom line (footer text and the brand). */
  bottom: number;
}

/** Minimum gap between two baselines; below this the glyphs touch. */
export const MIN_GAP = 34;

const ROW_GAP = 38;
const BOTTOM = CARD_H - 64;

/**
 * `rowCount` supporting rows and optionally a result line, packed upward
 * from the bottom so a card with fewer rows breathes and a card with more
 * still clears the footer.
 */
export function cardLayout(rowCount: number, hasPnl: boolean): CardLayout {
  const lines = Math.max(0, rowCount) + (hasPnl ? 1 : 0);
  // The block of rows ends this far above the bottom line, leaving room for
  // the footer text that shares that baseline.
  const blockEnd = BOTTOM - 52;
  const blockStart = blockEnd - (lines - 1) * ROW_GAP;
  const rows: number[] = [];
  for (let i = 0; i < Math.max(0, rowCount); i++) rows.push(blockStart + i * ROW_GAP);
  const pnl = hasPnl ? blockStart + rowCount * ROW_GAP : null;
  // The headline sits above the block, never crowding it.
  const big = Math.min(412, blockStart - 62);
  return { ticker: big - 144, big, rows, pnl, bottom: BOTTOM };
}
