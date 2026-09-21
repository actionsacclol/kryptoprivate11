import type { RouteId } from './components/Sidebar';

// One loader per code-split route (2026-09-08).
//
// App.tsx builds its lazy components from these, and the sidebar warms the
// same loaders on hover/focus, so the chunk a click needs is usually in the
// module cache before the click lands. A second dynamic-import site for the
// same page would be a second chunk request in dev and a duplicate edge in
// the production graph — this map is the only place a page chunk is named.
//
// Discover and the token page are not here: they ship in the entry bundle.
export const ROUTE_LOADERS = {
  legal: () => import('./pages/Legal'),
  workspace: () => import('./pages/Workspace'),
  scout: () => import('./pages/Scout'),
  launch: () => import('./pages/Launch'),
  swap: () => import('./pages/Swap'),
  bridge: () => import('./pages/Bridge'),
  watchlist: () => import('./pages/Watchlist'),
  runners: () => import('./pages/Runners'),
  wire: () => import('./pages/Wire'),
  creator: () => import('./pages/lab/Creator'),
  funder: () => import('./pages/lab/Funder'),
  scripts: () => import('./pages/Scripts'),
  orders: () => import('./pages/Orders'),
  trades: () => import('./pages/Trades'),
  dashboard: () => import('./pages/Dashboard'),
  observatoryrobinhood: () => import('./pages/EvmObservatory'),
  observatorybnb: () => import('./pages/EvmObservatory'),
  launches: () => import('./pages/Launches'),
  positions: () => import('./pages/Portfolio'),
  paper: () => import('./pages/Positions'),
  wallets: () => import('./pages/Wallets'),
  copysimple: () => import('./pages/CopySimple'),
  execution: () => import('./pages/Execution'),
  history: () => import('./pages/History'),
  backtest: () => import('./pages/Backtest'),
  guides: () => import('./pages/Guides'),
  farming: () => import('./pages/Farming'),
  wallet: () => import('./pages/Wallet'),
  // Both EVM wallet pages live in the same chunk as the Solana one — they
  // share EvmWalletPanel and the page shell, so splitting them would fetch
  // the same code twice.
  walletrobinhood: () => import('./pages/Wallet'),
  walletbnb: () => import('./pages/Wallet'),
  strategy: () => import('./pages/Strategy'),
  console: () => import('./pages/Console'),
  settings: () => import('./pages/Settings'),
  about: () => import('./pages/About'),
  // Not a nav route: reached by an 0x address plus the chain it lives on.
  evmToken: () => import('./pages/EvmToken'),
} as const;

type LoaderMap = Partial<Record<RouteId, () => Promise<unknown>>>;

const warmed = new Map<RouteId, Promise<unknown>>();

/** Fetch a route's chunk now (idempotent; a failed fetch is retried on the
 *  next ask). Routes in the entry bundle resolve at once. */
export function prefetchRoute(id: RouteId): Promise<void> {
  const load = (ROUTE_LOADERS as LoaderMap)[id];
  if (!load) return Promise.resolve();
  let p = warmed.get(id);
  if (!p) {
    p = load().catch(() => {
      warmed.delete(id);
    });
    warmed.set(id, p);
  }
  return p.then(() => undefined);
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

/** Warm chunks in the background, one at a time, once the first screen has
 *  had `delayMs` to itself. Returns a cancel for unmount. */
export function prefetchWhenIdle(ids: RouteId[], delayMs = 2500): () => void {
  let cancelled = false;
  const queue = ids.filter((id) => !warmed.has(id));
  const idle = (cb: () => void): void => {
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(cb, { timeout: 4000 });
    else window.setTimeout(cb, 250);
  };
  const next = (): void => {
    if (cancelled) return;
    const id = queue.shift();
    if (!id) return;
    void prefetchRoute(id).finally(() => idle(next));
  };
  const t = window.setTimeout(() => idle(next), delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(t);
  };
}
