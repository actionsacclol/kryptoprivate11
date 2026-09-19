// Portfolio assembly — joins the chain (what you hold) with the ledger
// (what you paid) and the market layer (what it is worth now).
//
// The rule that shapes every function here: a number that depends on cost
// basis is null when the basis is unknown. See shared/portfolio.ts for why.
//
// Realized PnL uses AVERAGE COST, not FIFO. Average cost is what a memecoin
// trader means by "I'm up 2x on my bag" — they are not tracking tax lots, and
// FIFO would report a different number than the one they have in their head.
// The choice is stated in the UI so nobody has to guess which convention is
// in play.

import {
  emptyPortfolio,
  type ClosedTrade,
  type PortfolioSummary,
  type Position,
  type TradeHistoryRow,
} from '@shared/portfolio';
import type { WalletHolding } from '@shared/types';
import * as ledger from './ledger';

const LAMPORTS = 1_000_000_000;

export interface PortfolioInputs {
  /** Liquidation value per held mint, lamports — a Jupiter sell quote of the
   *  whole balance. Wins over spot × amount when present. */
  liquidation?: Map<string, number>;
  holdings: WalletHolding[];
  solBalance: number | null;
  solUsd: number | null;
  /** mint → live market data, from the market layer. */
  prices: Map<string, { priceSol: number | null; priceUsd: number | null; marketCapUsd: number | null; name: string; symbol: string; imageUrl: string | null; circSupply: number | null }>;
  /** The wallet whose holdings these are. Cost basis is read for THIS wallet
   *  only — another wallet's buys must never price this one's bags. Absent
   *  (or null) means single-wallet: every fill counts. */
  wallet?: string | null;
}

export function build(inputs: PortfolioInputs): PortfolioSummary {
  const out = emptyPortfolio();
  out.generatedAt = Date.now();
  out.solBalance = inputs.solBalance;
  out.solUsd = inputs.solUsd;

  const basis = ledger.basisByMint(inputs.wallet ?? undefined);
  const s = ledger.stats();
  out.totalFills = s.total;
  out.reconciledFills = s.reconciled;
  out.unreconciledFills = s.unreconciled;
  out.pendingFills = s.pending;

  // ── Open positions: driven by the CHAIN, enriched by the ledger ──────
  const positions: Position[] = [];
  for (const h of inputs.holdings) {
    if (!(h.uiAmount > 0)) continue;
    const px = inputs.prices.get(h.mint);
    const b = basis.get(h.mint);

    // Average cost of the tokens still held. Only meaningful when we saw the
    // buys AND still hold no more than we bought — holding more than the
    // ledger recorded means tokens arrived from somewhere we did not see.
    const boughtEnough = !!b && b.tokensBought > 0 && b.spentSol > 0;
    const avgCostPerToken = boughtEnough ? (b as NonNullable<typeof b>).spentSol / (b as NonNullable<typeof b>).tokensBought : null;
    const basisKnown = avgCostPerToken !== null && h.uiAmount <= (b as NonNullable<typeof b>).tokensBought * 1.02;

    const costSol = basisKnown ? (avgCostPerToken as number) * h.uiAmount : null;
    const priceSol = px?.priceSol ?? null;
    // Liquidation quote first — what a sell would actually return, impact
    // included. Spot × amount only when no route quotes, and it is labelled.
    const liq = inputs.liquidation?.get(h.mint);
    const valueSol = liq !== undefined ? liq / 1e9 : priceSol !== null ? priceSol * h.uiAmount : null;
    const valueSource: 'quote' | 'spot' | undefined = liq !== undefined ? 'quote' : valueSol !== null ? 'spot' : undefined;
    const valueUsd =
      valueSol !== null && inputs.solUsd !== null
        ? valueSol * inputs.solUsd
        : px?.priceUsd !== null && px?.priceUsd !== undefined
          ? px.priceUsd * h.uiAmount
          : null;

    const unrealizedPnlSol = valueSol !== null && costSol !== null ? valueSol - costSol : null;
    const unrealizedPnlPct =
      unrealizedPnlSol !== null && costSol !== null && costSol > 0 ? (unrealizedPnlSol / costSol) * 100 : null;

    // Realized on this mint: proceeds minus the average cost of what was sold.
    const realizedPnlSol =
      b && avgCostPerToken !== null && b.tokensSold > 0
        ? b.receivedSol - avgCostPerToken * b.tokensSold
        : null;

    positions.push({
      mint: h.mint,
      symbol: px?.symbol || h.symbol || h.mint.slice(0, 6),
      name: px?.name ?? '',
      imageUrl: px?.imageUrl ?? null,
      amount: h.uiAmount,
      decimals: h.decimals,
      priceUsd: px?.priceUsd ?? null,
      priceSol,
      valueUsd,
      valueSol,
      valueSource,
      marketCapUsd: px?.marketCapUsd ?? null,
      basisKnown,
      costSol,
      avgEntryPriceSol: basisKnown ? avgCostPerToken : null,
      entryMcapUsd:
        basisKnown && avgCostPerToken !== null && inputs.solUsd !== null && px?.circSupply
          ? avgCostPerToken * inputs.solUsd * px.circSupply
          : null,
      unrealizedPnlSol,
      unrealizedPnlPct,
      realizedPnlSol,
      firstBuyAt: b?.firstAt ?? null,
      lastFillAt: b?.lastAt ?? null,
      unreconciledFills: b?.unreconciled ?? 0,
    });
  }

  positions.sort((a, b2) => (b2.valueUsd ?? 0) - (a.valueUsd ?? 0));
  out.positions = positions;

  const pricedValue = positions.reduce((acc, p) => acc + (p.valueUsd ?? 0), 0);
  out.positionsValueUsd = positions.some((p) => p.valueUsd !== null) ? pricedValue : null;
  out.totalValueUsd =
    out.positionsValueUsd !== null && inputs.solBalance !== null && inputs.solUsd !== null
      ? out.positionsValueUsd + inputs.solBalance * inputs.solUsd
      : out.positionsValueUsd;

  out.unrealizedPnlSol = positions.some((p) => p.unrealizedPnlSol !== null)
    ? positions.reduce((acc, p) => acc + (p.unrealizedPnlSol ?? 0), 0)
    : null;

  // ── Closed round trips ───────────────────────────────────────────────
  //
  // A mint counts as closed when the ledger shows sells and the chain shows
  // no remaining balance. That double condition matters: a wallet that still
  // holds tokens has an open position no matter what the ledger says.
  const held = new Set(inputs.holdings.filter((h) => h.uiAmount > 0).map((h) => h.mint));
  const closed: ClosedTrade[] = [];
  let feesPaid = 0;
  let hasFees = false;

  for (const f of ledger.all()) {
    if (f.feeLamports !== null) {
      feesPaid += f.feeLamports / LAMPORTS;
      hasFees = true;
    }
  }
  out.feesPaidSol = hasFees ? feesPaid : null;

  // ONE ROW PER ROUND TRIP, not per mint.
  //
  // These used to be lifetime totals for the mint, which netted every trade
  // on it into a single row: buy, sell at a profit, buy back, sell at a loss
  // came out as one ambiguous number and the second trade read as having
  // overwritten the first (user report, 2026-09-19). They are two trades.
  // They are also one win and one loss, which is what the win rate, the best
  // and worst trade and the equity curve below all now count.
  //
  // `basisByMint` marks the boundaries during its walk - the only point that
  // knows where one trade ended and the next began - and each `trip` is an
  // episode as it stood when the position went flat.
  for (const [mint, b] of basis) {
    // The chain says this wallet still holds the token while the ledger
    // thinks the last episode closed. Something happened that the fills do
    // not describe - a buy from another client, a sell that never landed -
    // so the newest trip's claim to be CLOSED is the one the chain
    // contradicts. Drop that one; the trips before it are untouched by it
    // and stay. (`b.buys === 0` is what "the ledger has no open episode"
    // looks like after a reset.)
    const suspect = held.has(mint) && b.buys === 0 && b.trips.length > 0;
    const trips = suspect ? b.trips.slice(0, -1) : b.trips;
    trips.forEach((t, i) => {
      if (t.sells === 0 || t.spentSol <= 0) return;
      const pnlSol = t.receivedSol - t.spentSol;
      closed.push({
        mint,
        symbol: b.symbol || mint.slice(0, 6),
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        costSol: t.spentSol,
        proceedsSol: t.receivedSol,
        pnlSol,
        pnlPct: (pnlSol / t.spentSol) * 100,
        holdMs: Math.max(0, t.closedAt - t.openedAt),
        tokensBought: t.tokensBought,
        tokensSold: t.tokensSold,
        // Average in and average out. Both come from amounts read off the
        // chain; when one is missing the price is null rather than a guess.
        entryPriceSol: t.tokensBought > 0 ? t.spentSol / t.tokensBought : null,
        exitPriceSol: t.tokensSold > 0 ? t.receivedSol / t.tokensSold : null,
        buys: t.buys,
        sells: t.sells,
        // 1-based, so a re-entry can say which time round it was rather than
        // looking like a duplicate of the row above it.
        tripIndex: i + 1,
        tripsOnMint: trips.length,
      });
    });
  }
  closed.sort((a, b2) => b2.closedAt - a.closedAt);
  out.closed = closed;

  const wins = closed.filter((c) => c.pnlSol > 0);
  const losses = closed.filter((c) => c.pnlSol < 0);
  out.wins = wins.length;
  out.losses = losses.length;
  out.winRatePct = closed.length ? (wins.length / closed.length) * 100 : null;
  out.avgWinnerSol = wins.length ? wins.reduce((a, c) => a + c.pnlSol, 0) / wins.length : null;
  out.avgLoserSol = losses.length ? losses.reduce((a, c) => a + c.pnlSol, 0) / losses.length : null;
  const grossWin = wins.reduce((a, c) => a + c.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((a, c) => a + c.pnlSol, 0));
  out.profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
  out.bestTradeSol = closed.length ? Math.max(...closed.map((c) => c.pnlSol)) : null;
  out.worstTradeSol = closed.length ? Math.min(...closed.map((c) => c.pnlSol)) : null;
  out.realizedPnlSol = closed.length ? closed.reduce((a, c) => a + c.pnlSol, 0) : null;

  // Cumulative realized PnL, oldest → newest.
  const byTime = [...closed].sort((a, b2) => a.closedAt - b2.closedAt);
  let run = 0;
  out.equity = byTime.map((c) => {
    run += c.pnlSol;
    return { t: c.closedAt, v: Math.round(run * 1e6) / 1e6 };
  });

  // ── Warnings: say what the numbers do NOT cover ──────────────────────
  if (s.unreconciled > 0) {
    out.warnings.push(
      `${s.unreconciled} fill${s.unreconciled === 1 ? '' : 's'} could not be read from the chain and ${s.unreconciled === 1 ? 'is' : 'are'} excluded from every figure here.`,
    );
  }
  if (s.pending > 0) {
    out.warnings.push(`${s.pending} recent fill${s.pending === 1 ? '' : 's'} still reconciling.`);
  }
  const noBasis = positions.filter((p) => !p.basisKnown).length;
  if (noBasis > 0) {
    out.warnings.push(
      `${noBasis} position${noBasis === 1 ? '' : 's'} ${noBasis === 1 ? 'has' : 'have'} no cost basis in this install — PnL for ${noBasis === 1 ? 'it' : 'them'} is shown as unknown, not as zero.`,
    );
  }
  const unpriced = positions.filter((p) => p.priceUsd === null).length;
  if (unpriced > 0) {
    out.warnings.push(`${unpriced} position${unpriced === 1 ? '' : 's'} could not be priced and ${unpriced === 1 ? 'is' : 'are'} excluded from the total value.`);
  }

  return out;
}

/** Flat fill list for the history table and the CSV/JSON export. */
export function history(): TradeHistoryRow[] {
  return ledger.all().map((f) => ({
    at: f.at,
    mint: f.mint,
    symbol: f.symbol,
    side: f.side,
    requested: f.requested,
    solDelta: f.solDeltaLamports === null ? null : f.solDeltaLamports / LAMPORTS,
    tokenDelta:
      f.tokenDeltaRaw !== null && f.decimals !== null
        ? Number(BigInt(f.tokenDeltaRaw)) / 10 ** f.decimals
        : null,
    feeSol: f.feeLamports === null ? null : f.feeLamports / LAMPORTS,
    signature: f.signature,
    state: f.state,
    note: f.note,
  }));
}
