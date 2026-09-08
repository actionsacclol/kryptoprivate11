import { Suspense, lazy, useCallback, useEffect, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { AUTOMATION_ROUTES, type RouteId } from './components/Sidebar';
import { ensureRouteCacheSubscribed } from './state/routeCache';
import { ROUTE_LOADERS, prefetchRoute, prefetchWhenIdle } from './routeLoaders';
import { TopBar } from './components/TopBar';
import { Onboarding } from './components/Onboarding';
import { AutomationBar } from './components/AutomationBar';
import { IntegrityBanner } from './components/IntegrityBanner';
import { TokenSearch } from './components/terminal/TokenSearch';
import { SidebarLive, TickerLive } from './components/LiveChrome';
import { HotkeyHost } from './components/HotkeyHost';
import { Discover } from './pages/Discover';
import { TokenPage } from './pages/Token';

// Discover and the token page are the trading screens — they stay in the
// entry bundle so the app opens on them with nothing left to fetch. Every
// other route is loaded on first visit: the old single 1.4 MB bundle carried
// three.js (Observatory only), every settings page and the legal text through
// the first paint of a screen that used none of them. The loaders live in
// routeLoaders.ts so the sidebar can warm the same chunk on hover.
const LegalPage = lazy(() => ROUTE_LOADERS.legal().then((m) => ({ default: m.LegalPage })));
const WatchlistPage = lazy(() => ROUTE_LOADERS.watchlist().then((m) => ({ default: m.WatchlistPage })));
const RunnersPage = lazy(() => ROUTE_LOADERS.runners().then((m) => ({ default: m.RunnersPage })));
const CreatorPage = lazy(() => ROUTE_LOADERS.creator().then((m) => ({ default: m.CreatorPage })));
const FunderPage = lazy(() => ROUTE_LOADERS.funder().then((m) => ({ default: m.FunderPage })));
const WarmerPage = lazy(() => ROUTE_LOADERS.warmer().then((m) => ({ default: m.WarmerPage })));
const CopierPage = lazy(() => ROUTE_LOADERS.copier().then((m) => ({ default: m.CopierPage })));
const ScriptsPage = lazy(() => ROUTE_LOADERS.scripts().then((m) => ({ default: m.ScriptsPage })));
const OrdersPage = lazy(() => ROUTE_LOADERS.orders().then((m) => ({ default: m.OrdersPage })));
const TradesPage = lazy(() => ROUTE_LOADERS.trades().then((m) => ({ default: m.TradesPage })));
const Dashboard = lazy(() => ROUTE_LOADERS.dashboard().then((m) => ({ default: m.Dashboard })));
const Launches = lazy(() => ROUTE_LOADERS.launches().then((m) => ({ default: m.Launches })));
const Positions = lazy(() => ROUTE_LOADERS.paper().then((m) => ({ default: m.Positions })));
const PortfolioPage = lazy(() => ROUTE_LOADERS.positions().then((m) => ({ default: m.PortfolioPage })));
const WalletsPage = lazy(() => ROUTE_LOADERS.wallets().then((m) => ({ default: m.WalletsPage })));
const Execution = lazy(() => ROUTE_LOADERS.execution().then((m) => ({ default: m.Execution })));
const History = lazy(() => ROUTE_LOADERS.history().then((m) => ({ default: m.History })));
const Backtest = lazy(() => ROUTE_LOADERS.backtest().then((m) => ({ default: m.Backtest })));
const WalletPage = lazy(() => ROUTE_LOADERS.wallet().then((m) => ({ default: m.WalletPage })));
const Strategy = lazy(() => ROUTE_LOADERS.strategy().then((m) => ({ default: m.Strategy })));
const Console = lazy(() => ROUTE_LOADERS.console().then((m) => ({ default: m.Console })));
const SettingsPage = lazy(() => ROUTE_LOADERS.settings().then((m) => ({ default: m.SettingsPage })));
const About = lazy(() => ROUTE_LOADERS.about().then((m) => ({ default: m.About })));

// Fetched in the background once the first screen has settled, most-visited
// first: the click that opens one of these then needs no network round trip.
const WARM_ROUTES: RouteId[] = ['trades', 'positions', 'orders', 'watchlist', 'runners', 'launches', 'wallets', 'scripts'];

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<RouteId>('discover');
  // Where the user asked to go. The sidebar follows this at once; the page
  // itself arrives inside a transition (see navigate).
  const [target, setTarget] = useState<RouteId>('discover');
  const [isPending, startTransition] = useTransition();
  // Pages open on what the last visit saw; the cache listens for the
  // engine's pushes from the first frame on.
  useEffect(() => ensureRouteCacheSubscribed(), []);
  useEffect(() => prefetchWhenIdle(WARM_ROUTES), []);
  const [openMint, setOpenMint] = useState<string | null>(null);

  // Gated until Onboarding reports otherwise: the shell is inert while the
  // legal/setup overlay is up (or still deciding), so nothing behind it is
  // reachable by keyboard before the terms are accepted.
  const [gated, setGated] = useState(true);

  // Navigation is a transition: the page being left stays on screen and
  // usable until the next one can render, so a route whose chunk is still
  // loading never swaps the pane for a spinner. The chunk is asked for
  // first, the sidebar moves at once, and the hairline under the top bar
  // shows the wait when there is one.
  const navigate = useCallback((r: RouteId) => {
    void prefetchRoute(r);
    setTarget(r);
    startTransition(() => setRoute(r));
  }, []);

  // Opening a token is a route change plus a mint — the token page is the
  // only route that carries state, so it lives here rather than in a router.
  // Not a transition: the page is in the entry bundle and its first render
  // is ~80 ms of work, and a transition let Discover's poll updates
  // interrupt and restart that render (400+ ms measured) — a plain update
  // commits it once.
  const openToken = useCallback((mint: string) => {
    setTarget('token');
    setOpenMint(mint);
    setRoute('token');
  }, []);

  // Discover is never unmounted. Its ~10,000 row elements were the cost of
  // every return visit (4–5 s of mount work plus a cold fetch of all four
  // columns); off-route it is hidden with content-visibility (rendering
  // state kept, nothing painted or hit-tested), stops polling, and re-reads
  // the wallet when it comes back.
  const discoverActive = route === 'discover' || (route === 'token' && !openMint);

  return (
    <div className="flex h-full bg-krypt-void">
      <Onboarding onNavigate={navigate} onGateChange={setGated} />
      {/* Hotkeys live in a null leaf: their 4 s settings poll used to sit in
          root state and re-render every route on each tick. */}
      <HotkeyHost mint={route === 'token' ? openMint : null} gated={gated} />
      <div className="pointer-events-none fixed inset-0 bg-krypt-radial" />
      <div className="pointer-events-none fixed inset-0 stars-backdrop opacity-80" />
      {/* Sidebar and Ticker subscribe to engine AND market state THEMSELVES.
          App used to call useAppState(), which meant the engine's 1/s status
          push re-rendered the ROOT — and with it every route, including
          Discover's ~10,000 DOM elements. It then still called useTerminal()
          for a sidebar label, so every Discover poll did the same. Pushing
          both subscriptions down to the components that need them keeps
          those heartbeats local; the root now re-renders only on navigation. */}
      {/* `inert` (not typed in React 18) removes the whole shell from the
          tab order and hit-testing while the onboarding gate is up. */}
      <div className="contents" {...(gated ? ({ inert: '' } as Record<string, string>) : {})}>
      <SidebarLive current={target} onNavigate={navigate} openMint={route === 'token' ? openMint : null} />
      <div className="flex flex-col flex-1 min-w-0 relative">
        <IntegrityBanner />
        <TopBar search={<TokenSearch onOpen={openToken} />} onOpenAutomation={() => navigate('dashboard')} onOpenRunners={() => navigate('runners')} />
        {isPending && (
          <div
            className="pointer-events-none absolute left-0 right-0 top-0 z-30 h-0.5 bg-krypt-purple/80 animate-pulse"
            aria-hidden="true"
          />
        )}
        {/* The launch ticker belongs to the engine, so it only shows on the
            automation side — a terminal user with the engine stopped should
            not see an empty tape strip across every screen. */}
        {/* Engine controls live with the automation routes, not above a
            chart. AUTOMATION_ROUTES is the same list the sidebar groups by,
            so the bar follows the section rather than a hand-kept list. */}
        {AUTOMATION_ROUTES.some((r) => r.id === route) && <AutomationBar />}
        {route !== 'discover' && route !== 'token' && <TickerLive />}
        <main className="flex-1 min-h-0 relative">
          <div
            className={discoverActive ? 'h-full' : 'absolute inset-0 pointer-events-none'}
            style={discoverActive ? undefined : { contentVisibility: 'hidden' }}
            aria-hidden={discoverActive ? undefined : true}
          >
            <Discover onOpenToken={openToken} active={discoverActive} />
          </div>
          {!discoverActive && (
            <div key={route === 'token' ? `token:${openMint}` : route} className="h-full">
              <Suspense fallback={<RouteFallback />}>
                {/* The fade starts when the page can paint, not when its
                    chunk starts loading — inside the boundary, a lazy route
                    no longer spends the fade on the spinner. */}
                <div className="h-full animate-ink">
                  {route === 'token' && openMint && (
                    <TokenPage mint={openMint} onBack={() => navigate('discover')} />
                  )}
                  {route === 'watchlist' && <WatchlistPage onOpenToken={openToken} />}
                  {route === 'runners' && <RunnersPage onOpenToken={openToken} />}
                  {route === 'creator' && <CreatorPage onOpenToken={openToken} />}
                  {route === 'funder' && <FunderPage onOpenToken={openToken} />}
                  {route === 'warmer' && <WarmerPage onOpenToken={openToken} />}
                  {route === 'copier' && <CopierPage onOpenToken={openToken} />}
                  {route === 'trades' && <TradesPage onOpenToken={openToken} />}
                  {route === 'orders' && <OrdersPage onOpenToken={openToken} />}
                  {route === 'dashboard' && <Dashboard onNavigate={navigate} />}
                  {route === 'launches' && <Launches onOpenToken={openToken} />}
                  {route === 'positions' && <PortfolioPage onOpenToken={openToken} />}
                  {route === 'paper' && <Positions />}
                  {route === 'legal' && <LegalPage />}
                  {route === 'wallets' && <WalletsPage />}
                  {route === 'scripts' && <ScriptsPage />}
                  {route === 'execution' && <Execution />}
                  {route === 'history' && <History />}
                  {route === 'backtest' && <Backtest />}
                  {route === 'wallet' && <WalletPage />}
                  {route === 'strategy' && <Strategy />}
                  {route === 'console' && <Console />}
                  {route === 'settings' && <SettingsPage />}
                  {route === 'about' && <About />}
                </div>
              </Suspense>
            </div>
          )}
        </main>
      </div>
      </div>
    </div>
  );
}
