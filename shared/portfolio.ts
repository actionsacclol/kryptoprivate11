// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — portfolio contract (term.txt sections 13, 14, 15).
//
// A position here is the intersection of two independent sources:
//
//   • what the CHAIN says you hold (authoritative, survives reinstalls);
//   • what THIS INSTALL'S ledger says you paid (only covers fills this app
//     made and could reconcile).
//
// They disagree all the time — you bought elsewhere, you traded before
// installing, an RPC was down when a fill landed. Rather than paper over
// that, a position carries `basisKnown`, and every derived number that
// depends on cost basis goes null when it is false. A PnL figure computed
// from a cost basis of zero is the single most misleading number a trading
// app can show.
// ──────────────────────────────────────────────────────────────────────

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;

  /** Tokens held right now, from the chain. */
  amount: number;
  decimals: number;

  /** Current price and value. Null when no provider could price it. */
  priceUsd: number | null;
  priceSol: number | null;
  valueUsd: number | null;
  valueSol: number | null;
  /**
   * How `valueSol` was obtained. `quote` = what selling the whole position
   * would fetch right now (a Jupiter sell quote on the routes the signer
   * allows) — the honest liquidation value, price impact included. `spot` =
   * provider price × amount, the fallback when no route quotes; it can be far
   * off for a thin token. Absent when the value is null.
   */
  valueSource?: 'quote' | 'spot';
  marketCapUsd: number | null;

  /**
   * True when this install has reconciled fills covering the tokens held.
   * False means we know what you hold but not what you paid.
   */
  basisKnown: boolean;
  /** SOL actually spent (fees included) on the tokens still held. */
  costSol: number | null;
  /** Average entry price in SOL per token. */
  avgEntryPriceSol: number | null;
  /** Market cap at the average entry, USD. */
  entryMcapUsd: number | null;

  /** Unrealized PnL on the remaining position. Null without a basis. */
  unrealizedPnlSol: number | null;
  unrealizedPnlPct: number | null;
  /** SOL realized from sells minus the cost of the tokens sold. */
  realizedPnlSol: number | null;

  firstBuyAt: number | null;
  lastFillAt: number | null;
  /** Fills for this mint this install could not read off the chain. */
  unreconciledFills: number;
  /**
   * True for a PAPER position: opened by a simulated fill, never held on
   * chain. Rendered with a paper tag and kept out of every real total.
   */
  paper?: boolean;
}

/** Paper trading, reported alongside — never inside — the real figures. */
export interface PaperSummary {
  positions: Position[];
  /** Closed paper round trips plus partial sells, exit model applied. */
  realizedPnlSol: number;
  closed: ClosedTrade[];
  /** The exit model, verbatim, so the UI can say what a paper sell means. */
  model: string;
}

export interface PortfolioSummary {
  /** True when this is the engine's LAST build served at once while a fresh
   *  one runs (a 'portfolio' event follows). Absent/false = freshly built. */
  stale?: boolean;
  /** Wallet SOL balance. */
  solBalance: number | null;
  solUsd: number | null;

  /** Value of every priced position, plus the SOL balance. */
  totalValueUsd: number | null;
  positionsValueUsd: number | null;

  /** Across all reconciled fills, all time. */
  realizedPnlSol: number | null;
  unrealizedPnlSol: number | null;
  /** Total SOL paid in fees across reconciled fills. */
  feesPaidSol: number | null;

  totalFills: number;
  reconciledFills: number;
  unreconciledFills: number;
  pendingFills: number;

  wins: number;
  losses: number;
  /** Null when there are no closed round trips to compute it from. */
  winRatePct: number | null;
  avgWinnerSol: number | null;
  avgLoserSol: number | null;
  /** Gross profit / gross loss. Null when there are no losses. */
  profitFactor: number | null;
  bestTradeSol: number | null;
  worstTradeSol: number | null;

  positions: Position[];
  /** Closed round trips, newest first. */
  closed: ClosedTrade[];

  /** Realized-PnL curve, cumulative SOL. */
  equity: Array<{ t: number; v: number }>;

  /** Things the user should know about the numbers above. */
  warnings: string[];
  generatedAt: number;
  /**
   * Paper positions, separately. Nothing in here contributes to any field
   * above: totals, PnL, win rate and fees are real fills only.
   */
  paper: PaperSummary;
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  holdMs: number;
  /** Tokens bought and sold across the round trip, whole units. */
  tokensBought: number;
  tokensSold: number;
  /** Average price paid and received, SOL per token. Null when the token
   *  amount could not be read off the chain, which is the same rule the rest
   *  of the ledger follows: unknown is never rendered as a number. */
  entryPriceSol: number | null;
  exitPriceSol: number | null;
  /** Buy and sell fills that made it up. */
  buys: number;
  sells: number;
}

/** One row of the trade-history export (term.txt section 14). */
export interface TradeHistoryRow {
  at: number;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** What was asked for: SOL on a buy, percent on a sell. */
  requested: number;
  /** Net SOL moved, from the chain. Null when unreconciled. */
  solDelta: number | null;
  tokenDelta: number | null;
  feeSol: number | null;
  signature: string | null;
  state: 'pending' | 'reconciled' | 'unreconciled';
  note: string | null;
  /** A paper fill (modelled, never on chain). The Trades tab labels it and
   *  can filter on it; absent on every real row. */
  paper?: boolean;
}

export function emptyPortfolio(): PortfolioSummary {
  return {
    solBalance: null,
    solUsd: null,
    totalValueUsd: null,
    positionsValueUsd: null,
    realizedPnlSol: null,
    unrealizedPnlSol: null,
    feesPaidSol: null,
    totalFills: 0,
    reconciledFills: 0,
    unreconciledFills: 0,
    pendingFills: 0,
    wins: 0,
    losses: 0,
    winRatePct: null,
    avgWinnerSol: null,
    avgLoserSol: null,
    profitFactor: null,
    bestTradeSol: null,
    worstTradeSol: null,
    positions: [],
    closed: [],
    equity: [],
    warnings: [],
    generatedAt: 0,
    paper: { positions: [], realizedPnlSol: 0, closed: [], model: '' },
  };
}

/** Convert the history rows to CSV for export. */
export function toCsv(rows: TradeHistoryRow[]): string {
  const head = [
    'time', 'mint', 'symbol', 'side', 'requested',
    'sol_delta', 'token_delta', 'fee_sol', 'signature', 'state', 'note', 'paper',
  ].join(',');
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      new Date(r.at).toISOString(),
      r.mint, r.symbol, r.side, r.requested,
      r.solDelta, r.tokenDelta, r.feeSol, r.signature, r.state, r.note, r.paper ? 'yes' : '',
    ].map(esc).join(','),
  );
  return [head, ...lines].join('\n');
}

// ── Share-card previews ───────────────────────────────────────────────
//
// A PnL card is the one artefact of this app that gets screenshotted and
// posted publicly, so it has to look right at the extremes — a 4-digit gain,
// a total loss, a missing image, a symbol long enough to overflow. Waiting to
// hold such a position before you can see the card is a bad way to find out.
//
// These are DEMO positions: real `Position` objects with obviously fake
// mints, built so the card can be exercised without holding anything.

export interface DemoScenario {
  id: string;
  label: string;
  /** What the card should be stress-testing. */
  note: string;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  { id: 'moonshot', label: '+2,400%', note: 'Four-digit gain — the number that has to fit' },
  { id: 'win', label: '+62%', note: 'An ordinary green card' },
  { id: 'flat', label: '+0.4%', note: 'Barely moved, where rounding shows' },
  { id: 'loss', label: '−38%', note: 'Red, with a negative sign that must not clip' },
  { id: 'rug', label: '−99.8%', note: 'Near-total loss' },
  { id: 'noimage', label: 'No image', note: 'A token with no icon and a long symbol' },
  { id: 'nobasis', label: 'No cost basis', note: 'Held, but this install never saw the buy' },
];

/**
 * A fake but structurally valid position for previewing a share card.
 *
 * The mint is deliberately not a real address — nothing should be able to
 * mistake one of these for something tradeable.
 */
export function demoPosition(scenario: string, now = Date.now()): Position {
  const base: Position = {
    mint: 'DemoMint1111111111111111111111111111111111',
    symbol: 'DEMO',
    name: 'Demo Token',
    imageUrl: null,
    amount: 1_250_000,
    decimals: 6,
    priceUsd: 0.000_812,
    priceSol: 0.000_008_1,
    valueUsd: 1015,
    valueSol: 10.1,
    marketCapUsd: 812_000,
    basisKnown: true,
    costSol: 6.2,
    avgEntryPriceSol: 0.000_004_96,
    entryMcapUsd: 496_000,
    unrealizedPnlSol: 3.9,
    unrealizedPnlPct: 62,
    realizedPnlSol: 0,
    firstBuyAt: now - 3 * 3_600_000,
    lastFillAt: now - 3 * 3_600_000,
    unreconciledFills: 0,
  };

  const withPnl = (pct: number, costSol: number): Position => {
    const valueSol = costSol * (1 + pct / 100);
    return {
      ...base,
      costSol,
      valueSol,
      valueUsd: valueSol * 100,
      unrealizedPnlSol: valueSol - costSol,
      unrealizedPnlPct: pct,
    };
  };

  switch (scenario) {
    case 'moonshot':
      return { ...withPnl(2400, 0.5), symbol: 'MOON', name: 'Moonshot', marketCapUsd: 12_400_000 };
    case 'flat':
      return { ...withPnl(0.4, 8), symbol: 'FLAT', name: 'Barely Moved' };
    case 'loss':
      return { ...withPnl(-38, 12), symbol: 'DIP', name: 'Went Down' };
    case 'rug':
      return { ...withPnl(-99.8, 20), symbol: 'RUG', name: 'Rugged', marketCapUsd: 1_400 };
    case 'noimage':
      return {
        ...withPnl(140, 3),
        symbol: 'LONGSYMBOLNAME',
        name: 'A Token With A Very Long Name Indeed',
        imageUrl: null,
      };
    case 'nobasis':
      return {
        ...base,
        basisKnown: false,
        costSol: null,
        avgEntryPriceSol: null,
        entryMcapUsd: null,
        unrealizedPnlSol: null,
        unrealizedPnlPct: null,
        realizedPnlSol: null,
        unreconciledFills: 2,
      };
    case 'win':
    default:
      return withPnl(62, 6.2);
  }
}
