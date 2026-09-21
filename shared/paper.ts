// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — paper positions (pure logic).
//
// A Paper buy runs the SAME build → sign → simulate → loss-guard pipeline as
// a real one and stops before broadcast. The simulation tells us exactly what
// the trade would have cost (the wallet's lamport delta, fees included) and
// exactly how many tokens the wallet would have received. Those two real
// numbers are the paper fill. Nothing here is a guess about the entry.
//
// The EXIT is modelled, and says so: a paper sell fills at the last known
// price with a flat PAPER_ROUND_TRIP_COST_PCT taken off the proceeds to stand
// in for the sell-side protocol fee, priority fee and slippage a real exit
// would pay. That is deliberately pessimistic and deliberately simple — a
// paper book that flatters its user teaches them to lose real money.
//
// Paper numbers never touch the real ledger, the real portfolio totals, the
// live breakers or fee accounting. This module has no I/O; persistence lives
// in electron/engine/paperBook.ts.
// ──────────────────────────────────────────────────────────────────────

import type { ClosedTrade, Position, TradeHistoryRow } from './portfolio';
import type { ChainKind } from './evm';

/** Flat cost modelled on every paper sell, percent of gross proceeds. */
export const PAPER_ROUND_TRIP_COST_PCT = 1;
/** Open paper positions are bounded so a runaway click can't grow the file forever. */
export const MAX_OPEN_PAPER_POSITIONS = 200;
/** Closed paper round trips kept for the realized total and the history list. */
export const MAX_CLOSED_PAPER_TRADES = 500;

/** One line the UI can quote so nobody mistakes the exit model for a real fill. */
export const PAPER_FILL_MODEL = `paper fill at last price, no slippage/fees modelled beyond ${PAPER_ROUND_TRIP_COST_PCT}%`;

export interface PaperFill {
  side: 'buy' | 'sell';
  /** SOL spent (buy, from the simulation) or received net of the model (sell). */
  sol: number;
  tokens: number;
  at: number;
  /** SOL per token at the fill. */
  priceSol: number;
}

/**
 * A paper fill worked out from the live price, for when the chain cannot be
 * asked.
 *
 * A paper BUY used to require a full on-chain simulation, which needs a real
 * wallet holding real SOL — so paper trading, the mode that exists to be
 * practised with no money, failed for exactly the people using it that way
 * ("Simulation call failed: AccountNotFound", 2026-09-05). When the
 * simulation cannot run, the fill is modelled instead, and labelled as such.
 *
 * It is deliberately not flattering: the same 1 % protocol fee and 0.5 %
 * platform fee a real buy pays come off the top, so a paper record is not
 * better than the trade it stands for.
 */
export const PAPER_SIDE_COST = 0.015;

export function modelledPaperFill(solIn: number, priceSol: number): { tokens: number; costSol: number } | null {
  if (!Number.isFinite(solIn) || solIn <= 0) return null;
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;
  const spent = solIn * (1 - PAPER_SIDE_COST);
  const tokens = spent / priceSol;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return { tokens, costSol: solIn };
}

export interface PaperPosition {
  mint: string;
  /**
   * Which chain this simulated position is on. Absent on every position
   * written before 2026-09-14, which were all Solana.
   *
   * It is part of the KEY, not decoration: the same 0x address can exist on
   * both Robinhood Chain and BNB, so a book keyed on the address alone would
   * merge two different tokens into one position and sell the wrong one.
   */
  chain?: ChainKind;
  symbol: string;
  /** Tokens still held. UI units when `decimalsKnown`, raw base units otherwise. */
  tokens: number;
  /** SOL paid (simulated, fees included) for the tokens still held — average cost. */
  costSol: number;
  /**
   * False when the mint's decimals could not be read, in which case `tokens`
   * is raw and the position cannot be priced. It can still be closed; the
   * exit then realizes −cost (honest: we cannot value it).
   */
  decimalsKnown: boolean;
  openedAt: number;
  lastFillAt: number;
  /** Realized SOL on this mint so far (partials), fee model applied. */
  realizedSol: number;
  fills: PaperFill[];
}

export interface PaperBook {
  version: 1;
  open: PaperPosition[];
  closed: ClosedTrade[];
}

export function emptyPaperBook(): PaperBook {
  return { version: 1, open: [], closed: [] };
}

export interface PaperSellResult {
  ok: boolean;
  message: string;
  book: PaperBook;
  tokensSold: number;
  proceedsSol: number;
  realizedSol: number;
  /** True when the whole position was closed. */
  closed: boolean;
}

const round = (v: number): number => Math.round(v * 1e9) / 1e9;

/**
 * Open (or add to) a paper position from a successful dry run.
 * Adding to an existing position averages the cost, like the real portfolio.
 */
/** Positions are identified by chain AND address — see PaperPosition.chain. */
export function samePaperKey(a: { mint: string; chain?: ChainKind }, b: { mint: string; chain?: ChainKind }): boolean {
  return a.mint === b.mint && (a.chain ?? 'solana') === (b.chain ?? 'solana');
}

export function openPaper(
  book: PaperBook,
  p: { mint: string; symbol: string; tokens: number; costSol: number; decimalsKnown: boolean; chain?: ChainKind },
  now = Date.now(),
): { ok: boolean; message: string; book: PaperBook; position: PaperPosition | null } {
  if (!(p.tokens > 0)) return { ok: false, message: 'Simulation reported no tokens received — no paper position opened', book, position: null };
  if (!(p.costSol > 0)) return { ok: false, message: 'Simulation reported no SOL spent — no paper position opened', book, position: null };
  const existing = book.open.find((x) => samePaperKey(x, p));
  if (!existing && book.open.length >= MAX_OPEN_PAPER_POSITIONS) {
    return { ok: false, message: `Paper book is full (${MAX_OPEN_PAPER_POSITIONS} open) — close some first`, book, position: null };
  }
  const fill: PaperFill = { side: 'buy', sol: p.costSol, tokens: p.tokens, at: now, priceSol: p.costSol / p.tokens };
  let position: PaperPosition;
  if (existing) {
    if (existing.decimalsKnown !== p.decimalsKnown) {
      return { ok: false, message: 'Cannot add to this paper position: token units differ from the first fill', book, position: null };
    }
    position = {
      ...existing,
      tokens: round(existing.tokens + p.tokens),
      costSol: round(existing.costSol + p.costSol),
      lastFillAt: now,
      fills: [...existing.fills, fill],
    };
  } else {
    position = {
      mint: p.mint,
      chain: p.chain ?? 'solana',
      symbol: p.symbol,
      tokens: p.tokens,
      costSol: p.costSol,
      decimalsKnown: p.decimalsKnown,
      openedAt: now,
      lastFillAt: now,
      realizedSol: 0,
      fills: [fill],
    };
  }
  const open = existing ? book.open.map((x) => (samePaperKey(x, p) ? position : x)) : [...book.open, position];
  return { ok: true, message: 'ok', book: { ...book, open }, position };
}

/**
 * Sell `pct` of a paper position at `priceSol`. Refuses (does not fill at 0)
 * when there is no positive price — a paper exit at a made-up price is the
 * kind of number this product refuses to show.
 */
export function sellPaper(
  book: PaperBook,
  mint: string,
  pct: number,
  priceSol: number | null,
  now = Date.now(),
  chain: ChainKind = 'solana',
): PaperSellResult {
  const fail = (message: string): PaperSellResult => ({ ok: false, message, book, tokensSold: 0, proceedsSol: 0, realizedSol: 0, closed: false });
  const pos = book.open.find((x) => samePaperKey(x, { mint, chain }));
  if (!pos) return fail('No paper position in this token');
  const share = Math.max(1, Math.min(100, Math.round(pct))) / 100;
  const tokensSold = share >= 1 ? pos.tokens : round(pos.tokens * share);
  const costOut = share >= 1 ? pos.costSol : round(pos.costSol * share);

  let proceeds: number;
  let fillPrice: number;
  if (!pos.decimalsKnown) {
    // Unpriceable: closing it is allowed (the user wants it gone) but the
    // exit is booked as a total loss rather than valued at a guess.
    proceeds = 0;
    fillPrice = 0;
  } else {
    if (priceSol === null || !(priceSol > 0)) return fail('no price to fill a paper sell — try again in a moment');
    proceeds = round(tokensSold * priceSol * (1 - PAPER_ROUND_TRIP_COST_PCT / 100));
    fillPrice = priceSol;
  }
  const realized = round(proceeds - costOut);
  const fill: PaperFill = { side: 'sell', sol: proceeds, tokens: tokensSold, at: now, priceSol: fillPrice };
  const closedAll = share >= 1 || round(pos.tokens - tokensSold) <= 0;

  let open: PaperPosition[];
  let closed = book.closed;
  if (closedAll) {
    open = book.open.filter((x) => !samePaperKey(x, { mint, chain }));
    const totalCost = pos.fills.filter((f) => f.side === 'buy').reduce((a, f) => a + f.sol, 0);
    const totalProceeds = pos.fills.filter((f) => f.side === 'sell').reduce((a, f) => a + f.sol, 0) + proceeds;
    const pnl = round(totalProceeds - totalCost);
    const trade: ClosedTrade = {
      mint,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: now,
      costSol: round(totalCost),
      proceedsSol: round(totalProceeds),
      pnlSol: pnl,
      pnlPct: totalCost > 0 ? (pnl / totalCost) * 100 : 0,
      holdMs: now - pos.openedAt,
      tokensBought: pos.fills.filter((f) => f.side === 'buy').reduce((a, f) => a + f.tokens, 0),
      tokensSold: pos.fills.filter((f) => f.side === 'sell').reduce((a, f) => a + f.tokens, 0) + tokensSold,
      // Average paid across the buys that made this position.
      entryPriceSol: (() => {
        const buys = pos.fills.filter((f) => f.side === 'buy');
        const tokens = buys.reduce((a, f) => a + f.tokens, 0);
        const sol = buys.reduce((a, f) => a + f.sol, 0);
        return tokens > 0 ? sol / tokens : null;
      })(),
      exitPriceSol: fillPrice,
      buys: pos.fills.filter((f) => f.side === 'buy').length,
      sells: pos.fills.filter((f) => f.side === 'sell').length + 1,
    };
    closed = [trade, ...book.closed].slice(0, MAX_CLOSED_PAPER_TRADES);
  } else {
    const next: PaperPosition = {
      ...pos,
      tokens: round(pos.tokens - tokensSold),
      costSol: round(pos.costSol - costOut),
      lastFillAt: now,
      realizedSol: round(pos.realizedSol + realized),
      fills: [...pos.fills, fill],
    };
    open = book.open.map((x) => (samePaperKey(x, { mint, chain }) ? next : x));
  }
  const what = closedAll ? 'closed' : `sold ${Math.round(share * 100)}% of`;
  const message = pos.decimalsKnown
    ? `Paper ${what} ${pos.symbol || mint.slice(0, 6)} — ${proceeds.toFixed(4)} SOL back, ${realized >= 0 ? '+' : ''}${realized.toFixed(4)} SOL (${PAPER_FILL_MODEL})`
    : `Paper ${what} ${pos.symbol || mint.slice(0, 6)} — token units unknown, booked as a full loss of ${costOut.toFixed(4)} SOL`;
  return { ok: true, message, book: { ...book, open, closed }, tokensSold, proceedsSol: proceeds, realizedSol: realized, closed: closedAll };
}

/** Realized paper PnL: closed round trips plus partials on still-open positions. */
export function paperRealizedSol(book: PaperBook): number {
  const closed = book.closed.reduce((a, t) => a + t.pnlSol, 0);
  const partial = book.open.reduce((a, p) => a + p.realizedSol, 0);
  return round(closed + partial);
}

/**
 * Paper fills as trade-history rows, so the Trades tab shows them beside the
 * real ones, labelled (2026-09-06: they were missing from it entirely).
 *
 * An open position still carries its fills, so each fill is a row; a sell's
 * "asked" percent is rebuilt from the tokens held before it. A closed round
 * trip keeps only its totals, so it becomes one buy row at open and one sell
 * row at close, and its note says when several fills were folded in.
 *
 * The numbers are the model's, never the chain's: `solDelta` is signed the
 * way the ledger signs it (a buy is negative), `feeSol` is null because the
 * model folds fees into the fill price, there is no signature, and
 * `paper: true` is what the UI keys the label and the filter off.
 */
export function paperHistoryRows(book: PaperBook): TradeHistoryRow[] {
  const rows: TradeHistoryRow[] = [];
  const note = `Paper — ${PAPER_FILL_MODEL}`;
  const base = (p: { mint: string; symbol: string }, at: number): Omit<TradeHistoryRow, 'side' | 'requested' | 'solDelta' | 'tokenDelta'> => ({
    at,
    mint: p.mint,
    symbol: p.symbol,
    feeSol: null,
    signature: null,
    state: 'reconciled',
    note,
    paper: true,
  });
  for (const p of book.open) {
    let held = 0;
    for (const f of p.fills) {
      // Raw units when decimals are unknown are not a token count the row
      // can honestly show.
      const tokens = p.decimalsKnown ? f.tokens : null;
      if (f.side === 'buy') {
        rows.push({ ...base(p, f.at), side: 'buy', requested: f.sol, solDelta: -f.sol, tokenDelta: tokens });
        held += f.tokens;
      } else {
        const pct = held > 0 ? Math.max(1, Math.min(100, Math.round((f.tokens / held) * 100))) : 100;
        rows.push({ ...base(p, f.at), side: 'sell', requested: pct, solDelta: f.sol, tokenDelta: tokens === null ? null : -tokens });
        held = Math.max(0, held - f.tokens);
      }
    }
  }
  for (const c of book.closed) {
    const folded =
      c.buys > 1 || c.sells > 1
        ? ` · ${c.buys} buy${c.buys === 1 ? '' : 's'} and ${c.sells} sell${c.sells === 1 ? '' : 's'} folded into one round trip`
        : '';
    rows.push({ ...base(c, c.openedAt), note: note + folded, side: 'buy', requested: c.costSol, solDelta: -c.costSol, tokenDelta: c.tokensBought });
    rows.push({ ...base(c, c.closedAt), note: note + folded, side: 'sell', requested: 100, solDelta: c.proceedsSol, tokenDelta: -c.tokensSold });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export interface PaperPriceInput {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  name: string;
  symbol: string;
  imageUrl: string | null;
  /** Circulating supply, to place the entry market cap. */
  circSupply: number | null;
  decimals: number;
}

/**
 * Render a paper position as the `Position` shape the UI already draws,
 * flagged `paper: true`. Cost basis is always known (it came from the
 * simulation); value/PnL go null when there is no current price or the
 * token units are unknown.
 */
export function paperToPosition(p: PaperPosition, px: PaperPriceInput | undefined, solUsd: number | null): Position {
  const priceSol = px?.priceSol ?? null;
  const priceable = p.decimalsKnown && priceSol !== null && priceSol > 0;
  const valueSol = priceable ? p.tokens * (priceSol as number) : null;
  const valueUsd = valueSol !== null && solUsd !== null ? valueSol * solUsd : (valueSol !== null && px?.priceUsd != null ? p.tokens * px.priceUsd : null);
  const avgEntry = p.decimalsKnown && p.tokens > 0 ? p.costSol / p.tokens : null;
  const unrealized = valueSol !== null ? valueSol - p.costSol : null;
  const entryMcapUsd =
    avgEntry !== null && px?.circSupply != null && px.circSupply > 0 && solUsd !== null ? avgEntry * solUsd * px.circSupply : null;
  return {
    mint: p.mint,
    symbol: px?.symbol || p.symbol,
    name: px?.name || p.symbol,
    imageUrl: px?.imageUrl ?? null,
    amount: p.tokens,
    decimals: px?.decimals ?? 6,
    priceUsd: px?.priceUsd ?? null,
    priceSol,
    valueUsd,
    valueSol,
    marketCapUsd: px?.marketCapUsd ?? null,
    basisKnown: true,
    costSol: p.costSol,
    avgEntryPriceSol: avgEntry,
    entryMcapUsd,
    unrealizedPnlSol: unrealized,
    unrealizedPnlPct: unrealized !== null && p.costSol > 0 ? (unrealized / p.costSol) * 100 : null,
    realizedPnlSol: p.realizedSol,
    firstBuyAt: p.openedAt,
    lastFillAt: p.lastFillAt,
    unreconciledFills: 0,
    // A paper position is only ever spot × amount — there is no sell quote
    // for a bag nobody holds — and the panel should say so, the way it does
    // for a real position with no route: a thin token's spot can be far off
    // what a sell would return (a paper position reported as a total loss,
    // 2026-09-19).
    valueSource: valueSol !== null ? 'spot' : undefined,
    paper: true,
  };
}

/** Load-time sanitiser: a corrupt file yields an empty book, not a crash. */
export function parsePaperBook(raw: unknown): PaperBook {
  const out = emptyPaperBook();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<PaperBook>;
  if (Array.isArray(r.open)) {
    out.open = r.open.filter(
      (p): p is PaperPosition =>
        !!p && typeof p.mint === 'string' && Number.isFinite(p.tokens) && p.tokens > 0 && Number.isFinite(p.costSol),
    ).map((p) => ({ ...p, fills: Array.isArray(p.fills) ? p.fills : [], realizedSol: Number.isFinite(p.realizedSol) ? p.realizedSol : 0, decimalsKnown: p.decimalsKnown !== false }))
      .slice(0, MAX_OPEN_PAPER_POSITIONS);
  }
  if (Array.isArray(r.closed)) {
    out.closed = r.closed.filter((t): t is ClosedTrade => !!t && typeof t.mint === 'string' && Number.isFinite(t.pnlSol)).slice(0, MAX_CLOSED_PAPER_TRADES);
  }
  return out;
}
