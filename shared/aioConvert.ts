// "Buy anywhere" — the All-in-One wallet's top-up before a buy (phase 3,
// 2026-10-02). Pure: what to move, from where, and whether it is worth it.
// The moving is bridge.ts (Relay, EXACT_OUTPUT); the buying is the ordinary
// manual buy path; electron/engine/aioBuy.ts runs the two in order.
//
// The owner's decisions (2026-10-02):
//   · ONE Krypt fee per order: the conversion that funds a buy carries no
//     Krypt fee; the buy pays its 0.5 % as always. A standalone move (Move
//     card, Bridge page) still pays.
//   · Top up at least MIN_TOPUP_USD (when the source has it): Relay's cost is
//     about $0.02 flat plus destination gas plus ~0.06 %, which is ~2 % of a
//     $5 move and under 1 % at $25. What is not spent stays on that chain —
//     the user's money, ready for the next buy there.
//   · Above CONVERT_COST_CEILING_PCT of the ORDER, a manual buy asks first and
//     an unattended one refuses: a $3 buy funded from another chain is mostly
//     fees, and nobody should find that out afterwards.

import type { AioChain } from './aio';

export const MIN_TOPUP_USD = 25;
export const CONVERT_COST_CEILING_PCT = 3;

/**
 * The buy's own Krypt fee, as a share of the buy, at the FULL rate (a
 * $KRYPTO holder pays half; the difference just stays on the chain). It is
 * paid ON TOP of the amount — an EVM buy sends amount + fee, a Solana buy
 * transfers it beside the swap — so a top-up that brought only buy + reserve
 * left a large buy short of its own fee: it failed after the money had moved
 * (swarm 2026-10-03, MS-2).
 */
export const ORDER_FEE_SHARE = 0.005;

/** Gas refuel for exits: Relay's floor is about $5, which is many sells' gas. */
export const REFUEL_USD = 5;
/** Below this a chain is "out of gas" for a sell (its coin; a sell's gas on
 *  BNB / Robinhood is a few cents at most, Solana keeps an exit reserve). */
export const LOW_GAS: Record<AioChain, number> = { solana: 0.005, bnb: 0.0002, robinhood: 0.00003 };

/** What the chain must hold for this buy to go through: the buy, its fee, and
 *  the chain's own reserve (network costs + the exit). */
export function fundedTarget(buy: number, reserve: number): number {
  return buy * (1 + ORDER_FEE_SHARE) + reserve;
}

/**
 * What each chain keeps back for itself, in its own coin: enough to SELL
 * what it holds later (and pay a buy's network costs). A top-up brings the
 * destination to buy + this; a source is never drawn below this, so a
 * conversion can never strand a position on the chain it came from.
 * Solana's is the planBuySize reserve (exit 0.01 + buy overhead 0.005).
 */
export const CHAIN_RESERVE: Record<AioChain, number> = {
  solana: 0.015,
  bnb: 0.0005,
  robinhood: 0.0001,
};

export type AioBuyPlanKind = 'direct' | 'convert' | 'ask' | 'refuse' | 'off';

export interface AioBuyPlan {
  kind: AioBuyPlanKind;
  /** Plain words for the panel. */
  message: string;
  chain: AioChain;
  /** The buy, in the destination coin. */
  amount: number;
  /** Present for convert / ask. */
  convert?: {
    from: AioChain;
    /** Source coin leaving, and destination coin arriving (exact output). */
    inAmount: number;
    outAmount: number;
    /** Relay's whole cost in dollars (no Krypt fee on an order's top-up). */
    costUsd: number | null;
    /** That cost as a share of the ORDER's value. */
    costPct: number | null;
    etaSec: number | null;
    /** The top-up quote main will send — single use, expires. */
    quoteId: string;
    expiresAt: number;
  };
}

/**
 * How much the destination must RECEIVE: the shortfall (buy + reserve −
 * held), raised to MIN_TOPUP_USD when the price is known. Null when nothing
 * is needed. All in the destination coin.
 */
export function topUpTarget(p: { buy: number; held: number; reserve: number; priceUsd: number | null }): { need: number; target: number } | null {
  if (!(p.buy > 0) || !Number.isFinite(p.held)) return null;
  const need = fundedTarget(p.buy, p.reserve) - p.held;
  if (!(need > 0)) return null;
  const floor = p.priceUsd !== null && p.priceUsd > 0 ? MIN_TOPUP_USD / p.priceUsd : 0;
  return { need, target: Math.max(need, floor) };
}

export interface SourceQuote {
  from: AioChain;
  /** Source coin the deposit needs, and what the source can spare (held − its reserve). */
  inAmount: number;
  spare: number;
  outAmount: number;
  inUsd: number | null;
  outUsd: number | null;
  etaSec: number | null;
  quoteId: string;
  expiresAt: number;
}

/**
 * The cheapest source that can actually pay: its deposit fits inside what
 * it can spare. Cheapest by Relay's dollar cost; an unpriced quote ranks
 * after every priced one (unknown is never cheapest). Ties go to the faster.
 */
export function chooseSource(quotes: SourceQuote[]): SourceQuote | null {
  const usable = quotes.filter((q) => q.inAmount > 0 && q.inAmount <= q.spare);
  if (!usable.length) return null;
  const cost = (q: SourceQuote): number => (q.inUsd !== null && q.outUsd !== null ? q.inUsd - q.outUsd : Number.POSITIVE_INFINITY);
  return [...usable].sort((a, b) => cost(a) - cost(b) || (a.etaSec ?? 99) - (b.etaSec ?? 99))[0];
}

/** The top-up's cost against the ORDER it funds: within the ceiling, or ask. */
export function costVerdict(costUsd: number | null, orderUsd: number | null): { pct: number | null; ask: boolean } {
  if (costUsd === null || orderUsd === null || !(orderUsd > 0)) return { pct: null, ask: true }; // unknown cost is asked about, never assumed fine
  const pct = (Math.max(0, costUsd) / orderUsd) * 100;
  return { pct, ask: pct > CONVERT_COST_CEILING_PCT };
}
