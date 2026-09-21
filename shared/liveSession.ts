// The live session's ledger — real fills since the session began.
//
// The Observatory's session panel showed two accountings and swapped
// between them: paper positions when idle, and while armed the wallet's
// balance change as the headline (right) beside `liveBuys` / `liveSells` /
// realized / unrealized / win rate drawn from the scanner's own trades —
// which no longer exist (manual execution only since 2026-08-16). So a day
// of twenty manual trades read: −0.068 SOL, 0 buys, 0 sells, realized
// +0.000, win rate — (user report, 2026-09-19).
//
// The truth is in the ledger: every manual buy and sell is a fill,
// reconciled against the chain, and the portfolio already turns those into
// closed round trips and priced open positions. This takes that and scopes
// it to the session — fills placed since it began, round trips closed since,
// positions opened since — so the panel's counters, realized and unrealized
// agree with the wallet delta above them instead of contradicting it.
//
// Nothing here is a second accounting. It is the portfolio's numbers with a
// time window on them, and the window is the same `liveSessionStartedAt`
// the panel already names in its subtitle.

import type { PortfolioSummary } from './portfolio';

/** The part of a ledger fill this needs — structural, so the electron
 *  module's own type satisfies it without being imported here. */
export interface SessionFill {
  at: number;
  side: 'buy' | 'sell';
  state: 'pending' | 'reconciled' | 'unreconciled';
  wallet?: string | null;
}

export interface LiveSessionLedger {
  /** When the session began, ms. */
  since: number;
  /** Fills PLACED since then, whatever their state — a buy that is still
   *  reconciling is still a buy the user made. */
  buys: number;
  sells: number;
  /** Of those, still reconciling / could not be read from the chain. */
  pending: number;
  unreconciled: number;
  /** Round trips CLOSED since the session began. Null when there are none:
   *  no trip is not a profit of zero. */
  realizedSol: number | null;
  /** Open positions OPENED since the session began, marked by the last
   *  portfolio build. Null when none of them could be priced. */
  unrealizedSol: number | null;
  open: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  /** Largest peak-to-trough fall of cumulative realized PnL over the
   *  session's closed trips, in order of closing. Null with no trips. */
  maxDrawdownSol: number | null;
  /** When the portfolio these figures came from was built. Null when no
   *  build exists yet, in which case the fill counts are the only figures. */
  portfolioAt: number | null;
}

export function liveSessionLedger(since: number, fills: SessionFill[], summary: PortfolioSummary | null, owner: string | null): LiveSessionLedger {
  let buys = 0;
  let sells = 0;
  let pending = 0;
  let unreconciled = 0;
  for (const f of fills) {
    if (f.at < since) continue;
    // Several wallets are held; only the active one's fills are this
    // session's. A fill from before multi-wallet carries no wallet and is
    // treated as the active wallet's — the only wallet that existed then.
    if (owner && (f.wallet ?? owner) !== owner) continue;
    if (f.side === 'buy') buys += 1;
    else sells += 1;
    if (f.state === 'pending') pending += 1;
    else if (f.state === 'unreconciled') unreconciled += 1;
  }
  const out: LiveSessionLedger = {
    since,
    buys,
    sells,
    pending,
    unreconciled,
    realizedSol: null,
    unrealizedSol: null,
    open: 0,
    wins: 0,
    losses: 0,
    winRatePct: null,
    maxDrawdownSol: null,
    portfolioAt: null,
  };
  if (!summary) return out;
  out.portfolioAt = summary.generatedAt;

  const closed = summary.closed.filter((c) => c.closedAt >= since).sort((a, b) => a.closedAt - b.closedAt);
  if (closed.length) {
    let realized = 0;
    let peak = 0;
    let dd = 0;
    for (const c of closed) {
      realized += c.pnlSol;
      if (c.pnlSol > 0) out.wins += 1;
      else if (c.pnlSol < 0) out.losses += 1;
      if (realized > peak) peak = realized;
      if (peak - realized > dd) dd = peak - realized;
    }
    out.realizedSol = Math.round(realized * 1e6) / 1e6;
    out.winRatePct = (out.wins / closed.length) * 100;
    out.maxDrawdownSol = Math.round(dd * 1e6) / 1e6;
  }

  const open = summary.positions.filter((p) => (p.firstBuyAt ?? 0) >= since);
  out.open = open.length;
  const priced = open.filter((p) => p.unrealizedPnlSol !== null);
  if (priced.length) {
    out.unrealizedSol = Math.round(priced.reduce((a, p) => a + (p.unrealizedPnlSol as number), 0) * 1e6) / 1e6;
  }
  return out;
}
