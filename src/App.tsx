import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { AUTOMATION_ROUTES, type RouteId } from './components/Sidebar';
import { ensureRouteCacheSubscribed } from './state/routeCache';
import { landingRouteOf, routesFor, workspaceOf, type WorkspaceId } from './workspaces';
import { loadPinned } from './panels/pinned';
import { setChartToken } from './panels/chartToken';
import { Hub } from './pages/Hub';
import { AppBackdrop, BACKDROP_FULL, BACKDROP_QUIET } from './components/viz/LiquidMetal';
import { ROUTE_LOADERS, prefetchRoute, prefetchWhenIdle } from './routeLoaders';
import { TopBar } from './components/TopBar';
import { Onboarding } from './components/Onboarding';
import { AutomationBar } from './components/AutomationBar';
import { IntegrityBanner } from './components/IntegrityBanner';
import { TokenSearch } from './components/terminal/TokenSearch';
import { SidebarLive, TokenTabsLive } from './components/LiveChrome';
import { chainForMint, closeTab, loadTabs, neighbourOf, openTab, saveTabs, tabKey, touchTab, type TokenTab } from './state/tokenTabs';
import { HotkeyHost } from './components/HotkeyHost';
import { LiteModeHost } from './components/LiteModeHost';
import { Discover } from './pages/Discover';
import { TokenPage } from './pages/Token';
import { isEvmAddress, isEvmChain, type ChainKind } from '@shared/evm';

// The EVM token page (Robinhood Chain, BNB Smart Chain) is not on the route
// map: it is reached by an 0x address plus the chain the row came from — the
// address alone says "EVM" (0x + 40 hex is never a Solana mint) but not
// which chain. Lazy — most sessions never open one.
const EvmTokenPage = lazy(() => ROUTE_LOADERS.evmToken().then((m) => ({ default: m.EvmTokenPage })));

// Discover and the token page are the trading screens — they stay in the
// entry bundle so the app opens on them with nothing left to fetch. Every
// other route is loaded on first visit: the old single 1.4 MB bundle carried
// three.js (Observatory only), every settings page and the legal text through
// the first paint of a screen that used none of them. The loaders live in
// routeLoaders.ts so the sidebar can warm the same chunk on hover.
const LegalPage = lazy(() => ROUTE_LOADERS.legal().then((m) => ({ default: m.LegalPage })));
const WorkspacePage = lazy(() => ROUTE_LOADERS.workspace().then((m) => ({ default: m.Workspace })));
const ScoutPage = lazy(() => ROUTE_LOADERS.scout().then((m) => ({ default: m.Scout })));
const LaunchPage = lazy(() => ROUTE_LOADERS.launch().then((m) => ({ default: m.Launch })));
const SwapPage = lazy(() => ROUTE_LOADERS.swap().then((m) => ({ default: m.Swap })));
const BridgePage = lazy(() => ROUTE_LOADERS.bridge().then((m) => ({ default: m.Bridge })));
const WatchlistPage = lazy(() => ROUTE_LOADERS.watchlist().then((m) => ({ default: m.WatchlistPage })));
const RunnersPage = lazy(() => ROUTE_LOADERS.runners().then((m) => ({ default: m.RunnersPage })));
const CreatorPage = lazy(() => ROUTE_LOADERS.creator().then((m) => ({ default: m.CreatorPage })));
const FunderPage = lazy(() => ROUTE_LOADERS.funder().then((m) => ({ default: m.FunderPage })));
const ScriptsPage = lazy(() => ROUTE_LOADERS.scripts().then((m) => ({ default: m.ScriptsPage })));
const OrdersPage = lazy(() => ROUTE_LOADERS.orders().then((m) => ({ default: m.OrdersPage })));
const TradesPage = lazy(() => ROUTE_LOADERS.trades().then((m) => ({ default: m.TradesPage })));
const Dashboard = lazy(() => ROUTE_LOADERS.dashboard().then((m) => ({ default: m.Dashboard })));
const EvmObservatoryPage = lazy(() => ROUTE_LOADERS.observatoryrobinhood().then((m) => ({ default: m.EvmObservatory })));
const Launches = lazy(() => ROUTE_LOADERS.launches().then((m) => ({ default: m.Launches })));
const Positions = lazy(() => ROUTE_LOADERS.paper().then((m) => ({ default: m.Positions })));
const PortfolioPage = lazy(() => ROUTE_LOADERS.positions().then((m) => ({ default: m.PortfolioPage })));
const WalletsPage = lazy(() => ROUTE_LOADERS.wallets().then((m) => ({ default: m.WalletsPage })));
const Execution = lazy(() => ROUTE_LOADERS.execution().then((m) => ({ default: m.Execution })));
const History = lazy(() => ROUTE_LOADERS.history().then((m) => ({ default: m.History })));
const Backtest = lazy(() => ROUTE_LOADERS.backtest().then((m) => ({ default: m.Backtest })));
const RewardsPage = lazy(() => ROUTE_LOADERS.rewards().then((m) => ({ default: m.RewardsPage })));
const FarmingPage = lazy(() => ROUTE_LOADERS.farming().then((m) => ({ default: m.FarmingPage })));
const WalletPage = lazy(() => ROUTE_LOADERS.wallet().then((m) => ({ default: m.WalletPage })));
const EvmWalletPage = lazy(() => ROUTE_LOADERS.wallet().then((m) => ({ default: m.EvmWalletPage })));
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
  // The app opens on the Hub. Workspaces isolate the jobs the app does; the
  // sidebar then lists only the pages of the one you picked.
  const [workspace, setWorkspace] = useState<WorkspaceId>('hub');
  const [route, setRoute] = useState<RouteId>('discover');
  // Where the user asked to go. The sidebar follows this at once; the page
  // itself arrives inside a transition (see navigate).
  const [target, setTarget] = useState<RouteId>('discover');
  const [isPending, startTransition] = useTransition();
  // Pages open on what the last visit saw; the cache listens for the
  // engine's pushes from the first frame on.
  useEffect(() => ensureRouteCacheSubscribed(), []);

  useEffect(() => prefetchWhenIdle(WARM_ROUTES), []);
  // ── Open tokens ──────────────────────────────────────────────────
  //
  // Several charts at once, clicked between, instead of a round trip through
  // the watchlist for each one (user report, 2026-09-15: "things can be
  // pretty fast paced in the low caps"). Only the ACTIVE token renders — a
  // tab is a remembered address, not a mounted page — so the open list costs
  // nothing but the strings in it.
  const [tabs, setTabs] = useState<TokenTab[]>(() => loadTabs());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => saveTabs(tabs), [tabs]);

  const active = useMemo(() => tabs.find((t) => tabKey(t) === activeKey) ?? null, [tabs, activeKey]);
  const openMint = active?.mint ?? null;
  const openChain = active?.chain ?? 'solana';

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
    // Navigating to a page follows it into ITS workspace — so anything that
    // jumps straight to a route (the top bar's engine button, a toast,
    // onboarding) lands with the right sidebar rather than in whichever
    // workspace happened to be open.
    //
    // UNLESS the workspace you are in already lists the page. That is what
    // `extraRoutes` means: listed here on purpose, owned elsewhere. Without
    // this, clicking "Sol Wallet" in the Terminal sidebar threw you into
    // Wallet Utilities, and the whole extraRoutes mechanism was inert.
    // My Layout's pins count as "listed here" too, or clicking a pinned page
    // would throw you into that page's home workspace and lose the menu you
    // built. One localStorage read per navigation, in a click handler.
    setWorkspace((cur) => (routesFor(cur).includes(r) || (cur === 'layout' && loadPinned().includes(r)) ? cur : workspaceOf(r)));
    startTransition(() => setRoute(r));
  }, []);

  /** Open a workspace at its landing page. */
  const openWorkspace = useCallback((id: WorkspaceId) => {
    const landing = landingRouteOf(id);
    void prefetchRoute(landing);
    setTarget(landing);
    setWorkspace(id);
    startTransition(() => setRoute(landing));
  }, []);

  const toHub = useCallback(() => setWorkspace('hub'), []);

  // Opening a token is a route change plus a mint — the token page is the
  // only route that carries state, so it lives here rather than in a router.
  // Not a transition: the page is in the entry bundle and its first render
  // is ~80 ms of work, and a transition let Discover's poll updates
  // interrupt and restart that render (400+ ms measured) — a plain update
  // commits it once.
  const openToken = useCallback((mint: string, chain?: ChainKind, symbol?: string) => {
    setTarget('token');
    // Callers that know the row's chain say so; a bare 0x address (an old
    // pin, a script) is Robinhood's, the first EVM chain the app had.
    const ch = chainForMint(mint, chain);
    // Opening a token already open SELECTS it rather than adding a second
    // tab for it — which would otherwise happen most to the coin you keep
    // checking, the one you least want duplicated.
    setTabs((cur) => openTab(cur, mint, ch, symbol));
    setActiveKey(tabKey({ mint, chain: ch }));
    // The chart panel follows whatever was opened last, in this window or a
    // popped-out one. Written here because this is the one place every route
    // into a token converges.
    setChartToken({ mint, chain: ch });
    // The WORKSPACE moves too, not just the route.
    //
    // A workspace decides what renders at all: while it is 'hub', nothing but
    // the Hub is on screen, so setting the route alone looked like the click
    // did nothing. Three callers had each learned this separately and set the
    // workspace themselves before calling — the Hub, a popped-out panel and a
    // notification click — and the top-bar search, which can be used from ANY
    // workspace, had not. Doing it here makes every caller correct by
    // construction instead of by remembering.
    setWorkspace(workspaceOf('token'));
    setRoute('token');
  }, []);

  /** Click a tab: show that token, wherever you were. */
  const selectTab = useCallback(
    (t: TokenTab) => {
      setActiveKey(tabKey(t));
      setChartToken({ mint: t.mint, chain: t.chain });
      setTabs((cur) => touchTab(cur, tabKey(t)));
      setTarget('token');
      setWorkspace((cur) => (routesFor(cur).includes('token') ? cur : workspaceOf('token')));
      setRoute('token');
    },
    [],
  );

  /** Close one. The tab to its right takes over, falling back to the left —
   *  what a browser does, and what the hand expects. Closing the last one
   *  leaves you on Discover rather than on a blank token page. */
  const dropTab = useCallback(
    (key: string) => {
      setTabs((cur) => {
        if (activeKey === key) {
          const next = neighbourOf(cur, key);
          setActiveKey(next ? tabKey(next) : null);
          if (next) setChartToken({ mint: next.mint, chain: next.chain });
          else if (route === 'token') {
            setTarget('discover');
            setRoute('discover');
          }
        }
        return closeTab(cur, key);
      });
    },
    [activeKey, route],
  );

  /**
   * "New tab" — go to the finder.
   *
   * A token tab needs a token, and the app has one place for choosing one.
   * So this does not open a blank tab (there is nothing to put in it); it
   * takes you to Discover, and the tab appears when you pick something.
   */
  const newTab = useCallback(() => {
    setTarget('discover');
    setWorkspace((cur) => (routesFor(cur).includes('discover') ? cur : workspaceOf('discover')));
    startTransition(() => setRoute('discover'));
  }, []);

  /** A tab whose label was worked out downstream keeps it from now on. */
  const noteTabSymbol = useCallback((key: string, symbol: string) => {
    setTabs((cur) => (cur.some((t) => tabKey(t) === key && !t.symbol) ? cur.map((t) => (tabKey(t) === key ? { ...t, symbol } : t)) : cur));
  }, []);

  const dropAllTabs = useCallback(() => {
    setTabs([]);
    setActiveKey(null);
    if (route === 'token') {
      setTarget('discover');
      setRoute('discover');
    }
  }, [route]);

  // Still its own function, but only to name the chain: the Hub's rows are
  // Solana. Leaving the Hub is `openToken`'s job now, along with every other
  // way into a token.
  const openTokenFromHub = useCallback((mint: string) => openToken(mint, 'solana'), [openToken]);

  // Clicking a desktop notification opens its token. Main owns the
  // Notification (and so the click); it asks the engine to emit this, and
  // this is where it lands. Until 2026-09-13 the click did nothing at all,
  // so the one thing the notification was pushing you toward still meant
  // going and finding the coin by hand.
  useEffect(() => {
    return window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'openToken') return;
      // `openToken` moves the workspace as well as the route, so a
      // notification click lands on the token wherever the user was.
      openToken(ev.mint, ev.chain);
    });
  }, [openToken]);

  // Discover is never unmounted. Its ~10,000 row elements were the cost of
  // every return visit (4–5 s of mount work plus a cold fetch of all four
  // columns); off-route it is hidden with content-visibility (rendering
  // state kept, nothing painted or hit-tested), stops polling, and re-reads
  // the wallet when it comes back.
  // On the Hub, Discover is still MOUNTED — unmounting it costs 4–5 s of
  // remount work and a cold fetch of all four columns on the way back — but
  // it is not the active surface, so it hides and stops polling exactly as it
  // does on any other route.
  const onHub = workspace === 'hub';
  const discoverActive = !onHub && (route === 'discover' || (route === 'token' && !openMint));

  return (
    <div className="flex h-full bg-krypt-void">
      <Onboarding onNavigate={navigate} onGateChange={setGated} />
      {/* Hotkeys live in a null leaf: their 4 s settings poll used to sit in
          root state and re-render every route on each tick. */}
      {/* Hotkeys drive the Solana signer; an EVM address gives them nothing to fire at. */}
      <HotkeyHost mint={route === 'token' && openMint && !isEvmAddress(openMint) ? openMint : null} gated={gated} />
      {/* Same shape: the one subscriber to `reduceEffects`, mirroring it into
          the lite store so the root never has to watch app state. */}
      <LiteModeHost />
      <div className="pointer-events-none fixed inset-0 bg-krypt-radial" />
      <div className="pointer-events-none fixed inset-0 stars-backdrop opacity-80" />
      {/* The liquid-metal sheet, in the same layer as the two above so it
          paints BEHIND the chrome rather than over it — the top bar is a
          static div with no z-index, and anything positioned washes it out.
          Mounted ONCE for the life of the app: the Hub gets it at full
          strength as the moment of arrival, every other page gets a far
          quieter one (a ninth of the pixels, half the frames) so it can sit
          behind a live chart without being felt. Only once `reduceEffects`
          is known to be false; Lite mode unmounts it and disposes the GL
          context. */}
      <AppBackdrop intensity={onHub ? BACKDROP_FULL : BACKDROP_QUIET} />
      {/* The live chrome subscribes to engine AND market state ITSELF.
          App used to call useAppState(), which meant the engine's 1/s status
          push re-rendered the ROOT — and with it every route, including
          Discover's ~10,000 DOM elements. It then still called useTerminal()
          for a sidebar label, so every Discover poll did the same. Pushing
          both subscriptions down to the components that need them keeps
          those heartbeats local; the root now re-renders only on navigation. */}
      {/* `inert` (not typed in React 18) removes the whole shell from the
          tab order and hit-testing while the onboarding gate is up. */}
      <div className="contents" {...(gated ? ({ inert: '' } as Record<string, string>) : {})}>
      {!onHub && (
        <SidebarLive
          current={target}
          onNavigate={navigate}
          openMint={route === 'token' ? openMint : null}
          workspace={workspace}
          onHub={toHub}
        />
      )}
      <div className="flex flex-col flex-1 min-w-0 relative">
        <IntegrityBanner />
        <TopBar search={<TokenSearch onOpen={openToken} />} onOpenAutomation={() => navigate('dashboard')} onOpenRunners={() => navigate('runners')} onHub={onHub ? undefined : toHub} />
        {isPending && (
          <div
            className="pointer-events-none absolute left-0 right-0 top-0 z-30 h-0.5 bg-krypt-purple/80 animate-pulse"
            aria-hidden="true"
          />
        )}
        {/* Engine controls live with the automation routes, not above a
            chart. AUTOMATION_ROUTES is the same list the sidebar groups by,
            so the bar follows the section rather than a hand-kept list. */}
        {!onHub && AUTOMATION_ROUTES.some((r) => r.id === route) && <AutomationBar />}
        {/* This strip used to be the scrolling launch ticker — decoration in
            the one piece of chrome that could have been doing something.
            It is the open tokens now.

            TERMINAL ONLY. It is shown across that whole workspace, not just
            on the token page, because the job it does is getting you BACK to
            a chart: from the watchlist, from Discover, from an order list,
            without the round trip through the list you came from (user
            report, 2026-09-15). Everywhere else it would be a row of chrome
            about tokens on a page that is not about tokens — the Scripts
            page and the Funder do not want a chart bar over them.

            `activeKey` is null off the token route, so no tab ever claims to
            be the one on screen when none is. */}
        {workspace === 'terminal' && (
          <TokenTabsLive
            tabs={tabs}
            activeKey={route === 'token' ? activeKey : null}
            onSelect={selectTab}
            onClose={dropTab}
            onCloseAll={dropAllTabs}
            onNew={newTab}
            onResolve={noteTabSymbol}
          />
        )}
        <main className="flex-1 min-h-0 relative">
          <div
            className={discoverActive ? 'h-full' : 'absolute inset-0 pointer-events-none'}
            style={discoverActive ? undefined : { contentVisibility: 'hidden' }}
            aria-hidden={discoverActive ? undefined : true}
          >
            <Discover onOpenToken={openToken} active={discoverActive} />
          </div>
          {onHub && (
            <div className="h-full overflow-auto animate-ink">
              <Hub onOpen={openWorkspace} onOpenToken={openTokenFromHub} />
            </div>
          )}
          {!onHub && !discoverActive && (
            <div key={route === 'token' ? `token:${openChain}:${openMint}` : route} className="h-full">
              <Suspense fallback={<RouteFallback />}>
                {/* The fade starts when the page can paint, not when its
                    chunk starts loading — inside the boundary, a lazy route
                    no longer spends the fade on the spinner. */}
                <div className="h-full animate-ink">
                  {route === 'token' && openMint && (
                    isEvmChain(openChain) && isEvmAddress(openMint)
                      ? <EvmTokenPage chain={openChain} address={openMint} onBack={() => navigate('discover')} />
                      : <TokenPage mint={openMint} onBack={() => navigate('discover')} />
                  )}
                  {route === 'watchlist' && <WatchlistPage onOpenToken={openToken} />}
                  {route === 'runners' && <RunnersPage onOpenToken={openToken} />}
                  {route === 'creator' && <CreatorPage onOpenToken={openToken} />}
                  {route === 'funder' && <FunderPage onOpenToken={openToken} />}
                  {route === 'trades' && <TradesPage onOpenToken={openToken} />}
                  {route === 'orders' && <OrdersPage onOpenToken={openToken} />}
                  {route === 'dashboard' && <Dashboard onNavigate={navigate} />}
                  {route === 'observatoryrobinhood' && <EvmObservatoryPage chain="robinhood" />}
                  {route === 'observatorybnb' && <EvmObservatoryPage chain="bnb" />}
                  {route === 'launches' && <Launches onOpenToken={openToken} />}
                  {route === 'positions' && <PortfolioPage onOpenToken={openToken} />}
                  {route === 'paper' && <Positions />}
                  {route === 'legal' && <LegalPage />}
                  {route === 'wallets' && <WalletsPage />}
                  {route === 'scripts' && <ScriptsPage />}
                  {route === 'execution' && <Execution />}
                  {route === 'history' && <History />}
                  {route === 'backtest' && <Backtest />}
                  {route === 'rewards' && <RewardsPage />}
                  {route === 'farming' && <FarmingPage />}
                  {route === 'workspace' && <WorkspacePage openToken={openToken} />}
                  {route === 'scout' && <ScoutPage />}
                  {route === 'launch' && <LaunchPage />}
                  {route === 'swap' && <SwapPage />}
                  {route === 'bridge' && <BridgePage />}
                  {route === 'wallet' && <WalletPage />}
                  {route === 'walletrobinhood' && <EvmWalletPage chain="robinhood" />}
                  {route === 'walletbnb' && <EvmWalletPage chain="bnb" />}
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
