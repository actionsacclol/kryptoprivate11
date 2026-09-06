import { Suspense, lazy, useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AUTOMATION_ROUTES, type RouteId } from './components/Sidebar';
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
// the first paint of a screen that used none of them.
const LegalPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.LegalPage })));
const WatchlistPage = lazy(() => import('./pages/Watchlist').then((m) => ({ default: m.WatchlistPage })));
const RunnersPage = lazy(() => import('./pages/Runners').then((m) => ({ default: m.RunnersPage })));
const CreatorPage = lazy(() => import('./pages/lab/Creator').then((m) => ({ default: m.CreatorPage })));
const FunderPage = lazy(() => import('./pages/lab/Funder').then((m) => ({ default: m.FunderPage })));
const WarmerPage = lazy(() => import('./pages/lab/Warmer').then((m) => ({ default: m.WarmerPage })));
const CopierPage = lazy(() => import('./pages/lab/Copier').then((m) => ({ default: m.CopierPage })));
const OrdersPage = lazy(() => import('./pages/Orders').then((m) => ({ default: m.OrdersPage })));
const TradesPage = lazy(() => import('./pages/Trades').then((m) => ({ default: m.TradesPage })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Launches = lazy(() => import('./pages/Launches').then((m) => ({ default: m.Launches })));
const Positions = lazy(() => import('./pages/Positions').then((m) => ({ default: m.Positions })));
const PortfolioPage = lazy(() => import('./pages/Portfolio').then((m) => ({ default: m.PortfolioPage })));
const WalletsPage = lazy(() => import('./pages/Wallets').then((m) => ({ default: m.WalletsPage })));
const Execution = lazy(() => import('./pages/Execution').then((m) => ({ default: m.Execution })));
const History = lazy(() => import('./pages/History').then((m) => ({ default: m.History })));
const Backtest = lazy(() => import('./pages/Backtest').then((m) => ({ default: m.Backtest })));
const WalletPage = lazy(() => import('./pages/Wallet').then((m) => ({ default: m.WalletPage })));
const Strategy = lazy(() => import('./pages/Strategy').then((m) => ({ default: m.Strategy })));
const Console = lazy(() => import('./pages/Console').then((m) => ({ default: m.Console })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })));

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<RouteId>('discover');
  const [openMint, setOpenMint] = useState<string | null>(null);

  // Gated until Onboarding reports otherwise: the shell is inert while the
  // legal/setup overlay is up (or still deciding), so nothing behind it is
  // reachable by keyboard before the terms are accepted.
  const [gated, setGated] = useState(true);

  // Opening a token is a route change plus a mint — the token page is the
  // only route that carries state, so it lives here rather than in a router.
  const openToken = useCallback((mint: string) => {
    setOpenMint(mint);
    setRoute('token');
  }, []);

  return (
    <div className="flex h-full bg-krypt-void">
      <Onboarding onNavigate={setRoute} onGateChange={setGated} />
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
      <SidebarLive current={route} onNavigate={setRoute} openMint={route === 'token' ? openMint : null} />
      <div className="flex flex-col flex-1 min-w-0 relative">
        <IntegrityBanner />
        <TopBar search={<TokenSearch onOpen={openToken} />} onOpenAutomation={() => setRoute('dashboard')} onOpenRunners={() => setRoute('runners')} />
        {/* The launch ticker belongs to the engine, so it only shows on the
            automation side — a terminal user with the engine stopped should
            not see an empty tape strip across every screen. */}
        {/* Engine controls live with the automation routes, not above a
            chart. AUTOMATION_ROUTES is the same list the sidebar groups by,
            so the bar follows the section rather than a hand-kept list. */}
        {AUTOMATION_ROUTES.some((r) => r.id === route) && <AutomationBar />}
        {route !== 'discover' && route !== 'token' && <TickerLive />}
        <main className="flex-1 min-h-0">
          <div key={route === 'token' ? `token:${openMint}` : route} className="h-full animate-ink">
            <Suspense fallback={<RouteFallback />}>
              {route === 'discover' && <Discover onOpenToken={openToken} />}
              {route === 'token' && openMint && (
                <TokenPage mint={openMint} onBack={() => setRoute('discover')} />
              )}
              {route === 'token' && !openMint && <Discover onOpenToken={openToken} />}
              {route === 'watchlist' && <WatchlistPage onOpenToken={openToken} />}
              {route === 'runners' && <RunnersPage onOpenToken={openToken} />}
              {route === 'creator' && <CreatorPage onOpenToken={openToken} />}
          {route === 'funder' && <FunderPage onOpenToken={openToken} />}
          {route === 'warmer' && <WarmerPage onOpenToken={openToken} />}
          {route === 'copier' && <CopierPage onOpenToken={openToken} />}
              {route === 'trades' && <TradesPage onOpenToken={openToken} />}
              {route === 'orders' && <OrdersPage onOpenToken={openToken} />}
              {route === 'dashboard' && <Dashboard onNavigate={setRoute} />}
              {route === 'launches' && <Launches onOpenToken={openToken} />}
              {route === 'positions' && <PortfolioPage onOpenToken={openToken} />}
              {route === 'paper' && <Positions />}
              {route === 'legal' && <LegalPage />}
              {route === 'wallets' && <WalletsPage />}
              {route === 'execution' && <Execution />}
              {route === 'history' && <History />}
              {route === 'backtest' && <Backtest />}
              {route === 'wallet' && <WalletPage />}
              {route === 'strategy' && <Strategy />}
              {route === 'console' && <Console />}
              {route === 'settings' && <SettingsPage />}
              {route === 'about' && <About />}
            </Suspense>
          </div>
        </main>
      </div>
      </div>
    </div>
  );
}
