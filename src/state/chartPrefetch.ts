// Warm a token's chart while the pointer rests on its row (2026-10-26).
//
// Opening a token paints its chart from whatever main already holds; when
// nothing is held the real series lands only after a provider answers —
// "sometimes over a second to load a chart". The sidebar already warms a
// page's code on hover (routeLoaders.ts); this does the same for the chart's
// DATA: the row under the pointer is the one most likely to be clicked
// next, so its first minute-chart load is started early. A click within
// the provider memo's window then paints the real history at once.
//
// Bounded on purpose. One mint in flight at a time, a short rest before it
// fires (a sweep across a column must not fan out a request per row), and
// a mint is asked at most once per window — the same request the click
// would have made, just sooner; never more of them.

const REST_MS = 160;
const REPEAT_MS = 20_000;
const DEFAULT_INTERVAL = '1m' as const;

let restTimer: number | null = null;
let inFlight: string | null = null;
const askedAt = new Map<string, number>();

/** The pointer is on `mint`'s row. Solana mints only — the EVM chart path
 *  is a different call and is not warmed here. */
export function prefetchChart(mint: string): void {
  if (!mint || mint.startsWith('0x')) return;
  if (restTimer !== null) window.clearTimeout(restTimer);
  restTimer = window.setTimeout(() => {
    restTimer = null;
    fire(mint);
  }, REST_MS);
}

/** The pointer left before it rested long enough. */
export function cancelPrefetch(): void {
  if (restTimer !== null) {
    window.clearTimeout(restTimer);
    restTimer = null;
  }
}

function fire(mint: string): void {
  if (document.hidden || inFlight !== null) return;
  const last = askedAt.get(mint) ?? 0;
  if (Date.now() - last < REPEAT_MS) return;
  askedAt.set(mint, Date.now());
  if (askedAt.size > 500) askedAt.clear();
  inFlight = mint;
  // The same call the token page makes on open; main memoises the answer,
  // so the click finds it in memory. The result itself is not wanted here.
  void window.krypt.market
    .candles(mint, DEFAULT_INTERVAL, 500)
    .catch(() => undefined)
    .finally(() => {
      if (inFlight === mint) inFlight = null;
    });
}
