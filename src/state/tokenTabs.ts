// Open token tabs — several charts at once, clicked between.
//
// The watchlist is where a low-cap trader lives, and until now reading four
// coins meant four round trips through it: watchlist → token → back →
// watchlist → token. At the speed those markets move that is the whole cost
// of the decision (user report, 2026-09-15). A tab is a token you have
// opened and not closed; the bar that lists them replaced the scrolling
// launch ticker, which was decoration in the one strip of chrome that could
// have been doing this.
//
// What this module is NOT: it does not mount a page per tab. Only the active
// token renders, exactly as before — a tab is a remembered address, so ten
// of them cost ten short strings and no work. That is why the cap can be
// generous and why switching is instant.

import { isEvmAddress, type ChainKind } from '@shared/evm';

export interface TokenTab {
  mint: string;
  /** The chain the tab was opened on; a bare 0x address defaults to
   *  Robinhood, the first EVM chain the app had, matching `openToken`. */
  chain: ChainKind;
  /** Symbol when the opener knew one — the bar shows the address until the
   *  page learns it, and never invents one. */
  symbol?: string;
  /** Last made active, ms. The eviction order when the cap is reached. */
  at: number;
}

/**
 * How many tabs are kept.
 *
 * Not a performance limit — a tab is a string — but a legibility one: past
 * about a dozen the bar stops being scannable and the thing it was meant to
 * save you from (hunting for a coin) comes back in a different shape. The
 * least recently used one goes, never the active one.
 */
export const MAX_TOKEN_TABS = 12;

const KEY = 'krypt.tokenTabs.v1';

export const tabKey = (t: { mint: string; chain: ChainKind }): string => `${t.chain}:${t.mint}`;

/**
 * A strictly increasing "last used" stamp.
 *
 * `Date.now()` has millisecond resolution, and several tabs can be opened
 * inside one — restoring a saved list does exactly that. Equal stamps make
 * "least recently used" ambiguous, and the tie fell on the FIRST tab, which
 * could be the one just used. Monotonic, so the order is always the real one.
 */
let lastStamp = 0;
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Mark a tab used, so the cap evicts the right one. */
export function touchTab(tabs: TokenTab[], key: string): TokenTab[] {
  return tabs.map((t) => (tabKey(t) === key ? { ...t, at: stamp() } : t));
}

/** The chain a bare address belongs to, the same rule `openToken` uses. */
export const chainForMint = (mint: string, chain?: ChainKind): ChainKind =>
  chain ?? (isEvmAddress(mint) ? 'robinhood' : 'solana');

function clean(raw: unknown): TokenTab[] {
  if (!Array.isArray(raw)) return [];
  const out: TokenTab[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const mint = (x as TokenTab).mint;
    const chain = (x as TokenTab).chain;
    if (typeof mint !== 'string' || !mint) continue;
    if (chain !== 'solana' && chain !== 'robinhood' && chain !== 'bnb') continue;
    const key = tabKey({ mint, chain });
    if (seen.has(key)) continue;
    seen.add(key);
    const symbol = (x as TokenTab).symbol;
    const at = (x as TokenTab).at;
    out.push({
      mint,
      chain,
      symbol: typeof symbol === 'string' && symbol ? symbol.slice(0, 16) : undefined,
      at: typeof at === 'number' && at > 0 ? at : stamp(),
    });
    if (out.length >= MAX_TOKEN_TABS) break;
  }
  return out;
}

/** What was open last time. Storage is per-viewer and may be unreadable —
 *  a failure here is an empty bar, never a broken app. */
export function loadTabs(): TokenTab[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? clean(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveTabs(tabs: TokenTab[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs.slice(0, MAX_TOKEN_TABS)));
  } catch {
    /* private window, blocked storage — the tabs simply do not survive */
  }
}

/**
 * Open `mint`, returning the new list.
 *
 * Opening a token that is already open is a SELECT, not a second tab —
 * otherwise the bar fills with duplicates of whatever you keep checking,
 * which is exactly the coin you are watching most.
 */
export function openTab(tabs: TokenTab[], mint: string, chain: ChainKind, symbol?: string): TokenTab[] {
  const key = tabKey({ mint, chain });
  const now = stamp();
  const existing = tabs.find((t) => tabKey(t) === key);
  if (existing) {
    return tabs.map((t) => (tabKey(t) === key ? { ...t, at: now, symbol: symbol || t.symbol } : t));
  }
  const next = [...tabs, { mint, chain, symbol, at: now }];
  if (next.length <= MAX_TOKEN_TABS) return next;
  // Drop the least recently active — never the one just opened.
  let oldest = 0;
  for (let i = 1; i < next.length - 1; i += 1) if (next[i].at < next[oldest].at) oldest = i;
  return next.filter((_, i) => i !== oldest);
}

export function closeTab(tabs: TokenTab[], key: string): TokenTab[] {
  return tabs.filter((t) => tabKey(t) !== key);
}

/**
 * Which tab to show after `key` is closed.
 *
 * The one to its RIGHT, falling back to the left — what a browser does, and
 * what the hand expects when it closes the tab it is looking at. Null when
 * nothing is left.
 */
export function neighbourOf(tabs: TokenTab[], key: string): TokenTab | null {
  const i = tabs.findIndex((t) => tabKey(t) === key);
  if (i < 0) return null;
  return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

/** Name a tab: its symbol when known, a short address when not. Never a
 *  guess — an address that has not resolved reads as an address. */
export function tabLabel(t: TokenTab): string {
  if (t.symbol) return t.symbol;
  return t.mint.length > 10 ? `${t.mint.slice(0, 4)}…${t.mint.slice(-3)}` : t.mint;
}
