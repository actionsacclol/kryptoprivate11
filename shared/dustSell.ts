// Sell dust (2026-10-03): one button that sells every token in the wallet
// worth less than DUST_SELL_USD, on the lean fee lane. A 100% sell closes the
// token account and refunds its rent (~0.002 SOL), so on a leftover that is
// usually worth more than the coin itself — the user's scorenow wallet held
// seven stranded moonbag halves like that.
//
// Pure, so what is sold and what is left alone is pinned by a test:
//   · never $KRYPTO (it halves the user's fees) or anything the caller
//     excludes (a coin a Krypto Trader session holds);
//   · never a token with no price — unknown is not "small";
//   · never a balance of a few raw units: no route can sell it (sell-all's
//     own rule), so a sell would only burn fees.

export const DUST_SELL_USD = 0.5;

export interface DustHolding {
  mint: string;
  symbol: string | null;
  uiAmount: number;
  amountRaw: string;
}

export interface DustPlan {
  /** Sold, smallest first. */
  sell: Array<{ mint: string; symbol: string | null; uiAmount: number; valueUsd: number }>;
  /** Under the limit or unknown, but left alone — with the reason. */
  skip: Array<{ mint: string; symbol: string | null; why: string }>;
  /** About what the sold tokens are worth together. */
  totalUsd: number;
}

export function planDustSell(
  holdings: DustHolding[],
  valueUsd: (mint: string) => number | null,
  opts: { maxUsd?: number; exclude?: Map<string, string>; unroutable?: (h: DustHolding) => boolean } = {},
): DustPlan {
  const maxUsd = opts.maxUsd ?? DUST_SELL_USD;
  const sell: DustPlan['sell'] = [];
  const skip: DustPlan['skip'] = [];
  for (const h of holdings) {
    if (!(h.uiAmount > 0)) continue;
    const excluded = opts.exclude?.get(h.mint);
    if (excluded) {
      skip.push({ mint: h.mint, symbol: h.symbol, why: excluded });
      continue;
    }
    const v = valueUsd(h.mint);
    if (v === null || !Number.isFinite(v)) {
      skip.push({ mint: h.mint, symbol: h.symbol, why: 'no price right now — unknown is not "small"' });
      continue;
    }
    if (v >= maxUsd) continue; // not dust: not listed at all
    if (opts.unroutable?.(h)) {
      skip.push({ mint: h.mint, symbol: h.symbol, why: 'too few tokens for any route to sell' });
      continue;
    }
    sell.push({ mint: h.mint, symbol: h.symbol, uiAmount: h.uiAmount, valueUsd: v });
  }
  sell.sort((a, b) => a.valueUsd - b.valueUsd);
  return { sell, skip, totalUsd: Math.round(sell.reduce((a, x) => a + x.valueUsd, 0) * 100) / 100 };
}
