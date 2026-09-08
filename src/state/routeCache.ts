// What the last visit to a panel saw, kept across navigations.
//
// Why (2026-09-08 navigation measurements): App.tsx remounts every page on
// navigation (key={route}), so each page started from empty state and asked
// main to rebuild what it had shown a moment earlier — Portfolio and Trades
// waited 5–7 s on a provider build, Watchlist 2 s on a rate-limited batch,
// with nothing on screen. This module is the memory those pages lost: a
// page seeds its state from here on the first frame, marks it as aged, and
// refreshes in the background. Main pushes the fresh results as engine
// events, so every open page updates together.
//
// Renderer-only. Nothing here crosses IPC or reaches a trade path; the
// engine keeps its own copies for that. Keyed data that belongs to a signer
// is dropped the moment the active wallet changes.

import type { PortfolioSummary } from '@shared/portfolio';
import type { TokenSummary } from '@shared/market';
import type { WalletHolding } from '@shared/types';

let portfolio: PortfolioSummary | null = null;
let holdings: { data: WalletHolding[]; at: number } | null = null;

/** Token rows the Watchlist (and the Token page) painted last, by mint. Not
 *  per-wallet: a token's price is the same for everyone. */
export const lastRows = new Map<string, TokenSummary>();
const ROWS_CAP = 300;

export function rememberRows(rows: Iterable<TokenSummary>): void {
  for (const t of rows) {
    if (!t?.mint) continue;
    lastRows.delete(t.mint);
    lastRows.set(t.mint, t);
  }
  while (lastRows.size > ROWS_CAP) lastRows.delete(lastRows.keys().next().value as string);
}

export function cachedPortfolio(): PortfolioSummary | null {
  return portfolio;
}

export function rememberPortfolio(p: PortfolioSummary): void {
  portfolio = p;
}

export function cachedHoldings(): { data: WalletHolding[]; at: number } | null {
  return holdings;
}

export function rememberHoldings(data: WalletHolding[], at: number): void {
  holdings = { data, at };
}

function clearWalletScoped(): void {
  portfolio = null;
  holdings = null;
}

let subscribed = false;

/** Wire the cache to the engine's pushes. Idempotent; call once at app mount. */
export function ensureRouteCacheSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  window.krypt.engine.onEvent((ev) => {
    if (ev.kind === 'portfolio') portfolio = ev.summary;
    else if (ev.kind === 'holdings') holdings = { data: ev.data, at: ev.at };
    else if (ev.kind === 'walletSwitched') clearWalletScoped();
  });
}

/** "12 s ago" for an age stamp; empty when fresh. */
export function ageLabel(at: number | undefined | null, freshMs = 5_000): string {
  if (!at) return '';
  const s = Math.round((Date.now() - at) / 1000);
  if (s * 1000 < freshMs) return '';
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
