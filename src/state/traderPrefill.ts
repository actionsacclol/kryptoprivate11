// "Open in Krypto Trader" — the coin handed from the Token or Runners page to
// the Krypto Trader form.
//
// The app has no router with query state: the token page is the only route
// that carries anything, and it lives in App.tsx. A one-shot slot is enough
// here — the link writes the mint, navigates, and the page reads it on mount.
// The page CLEARS it only after it has mounted (review #20): reading must be
// free of side effects, because the route change is a transition and React
// may throw a half-rendered page away and render it again — a slot emptied
// by the discarded render would open the form blank. Cleared after mount, so
// returning to the page later opens an empty form, not an old click's coin.
//
// The chain travels with the coin (stage 4): an EVM token page hands its
// chain, so the form opens on BNB or Robinhood with that chain's wallets.

import type { ChainKind } from '@shared/chainKind';

let pending: { mint: string; chain: ChainKind } | null = null;

export function setTraderPrefill(mint: string, chain: ChainKind = 'solana'): void {
  const m = mint.trim();
  pending = m ? { mint: m, chain } : null;
}

/** The handed-over coin and its chain, without taking it (safe in render). */
export function peekTraderPrefill(): { mint: string; chain: ChainKind } | null {
  return pending;
}

/** Called once the page has mounted with `seen`: clears the slot, unless a
 *  newer click has written another coin since. */
export function clearTraderPrefill(seen: { mint: string; chain: ChainKind } | null): void {
  if (seen && pending === seen) pending = null;
}
