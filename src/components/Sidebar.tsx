import { Fragment } from 'react';
import { useLocale } from '../state/useLocale';
import { UpdateNotice } from './UpdateNotice';
import {
  Activity,
  Scale,
  Home,
  LayoutGrid,
  Compass,
  FlaskConical,
  Gauge,
  Globe,
  History as HistoryIcon,
  KeyRound,
  LineChart,
  ListOrdered,
  Radar,
  Rocket,
  Megaphone,

  Users,
  ScrollText,
  Settings,
  Sparkles,
  Telescope,
  BookMarked,
  BookOpen,
  Wallet, Flame, Coins, FolderPlus, Receipt, Code2, Repeat, Shuffle, Sprout, UserPlus, AtSign, Bot } from 'lucide-react';
import { groupsFor, workspaceSpec, type WorkspaceId } from '../workspaces';
import { prefetchRoute } from '../routeLoaders';
import { COPYRIGHT_LINE } from '@shared/legal/entity';
import { cls } from '../utils/format';

const KRYPT_URL = 'https://krypt.cc';
const DISCORD_URL = 'https://discord.gg/muzFKR657F';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.317 4.369A19.79 19.79 0 0 0 15.885 3c-.21.375-.444.88-.608 1.28a18.27 18.27 0 0 0-5.487 0A12.6 12.6 0 0 0 9.18 3a19.74 19.74 0 0 0-4.435 1.37C1.93 8.59 1.165 12.69 1.548 16.73a19.93 19.93 0 0 0 6.073 3.07c.49-.668.927-1.377 1.302-2.122-.715-.27-1.4-.603-2.046-.99.172-.126.34-.257.502-.39a14.2 14.2 0 0 0 12.142 0c.164.137.332.268.502.39-.647.39-1.334.724-2.05.992.376.744.81 1.453 1.302 2.12a19.9 19.9 0 0 0 6.075-3.07c.45-4.69-.766-8.75-3.235-12.36ZM8.02 14.33c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.097 2.157 2.42 0 1.335-.956 2.42-2.157 2.42Zm7.96 0c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.097 2.157 2.42 0 1.335-.946 2.42-2.157 2.42Z" />
    </svg>
  );
}

export type RouteId =
  | 'discover'
  | 'workspace'
  | 'scout'
  | 'launch'
  | 'token'
  | 'watchlist'
  | 'runners'
  | 'wire'
  | 'trades'
  | 'creator'
  | 'funder'
  | 'copier'
  | 'autocallout'
  | 'pumpaccounts'
  | 'orders'
  | 'copysimple'
  | 'wallets'
  | 'scripts'
  | 'farming'
  | 'mcp'
  | 'dashboard'
  | 'observatoryrobinhood'
  | 'observatorybnb'
  | 'launches'
  | 'positions'
  | 'paper'
  | 'history'
  | 'backtest'
  | 'execution'
  | 'wallet'
  | 'walletrobinhood'
  | 'walletbnb'
  | 'swap'
  | 'bridge'
  | 'guides'
  | 'strategy'
  | 'console'
  | 'settings'
  | 'about'
  | 'legal';

export interface RouteSpec {
  id: RouteId;
  /** English, and the fallback: a route with no `i18n` key shows this. */
  label: string;
  /** Translation key, where one exists. Optional so adding a route never
   *  waits on eight catalogues. */
  i18n?: import('@shared/i18n').MessageKey;
  /** Plain-language tooltip for the ritual names. */
  hint?: string;
  icon: typeof Telescope;
  /** Routes reached by clicking a token, not by the nav list. */
  hidden?: boolean;
}

// Two groups, because the app now does two different jobs. TERMINAL is the
// manual trading surface a stranger opens on; AUTOMATION is the original
// sniper — the engine, its shadow strategies and its recordings — which is
// still here, still running, and still where the honest research lives.
export const TERMINAL_ROUTES: RouteSpec[] = [
  { id: 'discover', label: 'Discover', i18n: 'nav.discover', hint: 'New, graduating, migrated, trending', icon: Compass },
  { id: 'token', label: 'Token', i18n: 'nav.token', hint: 'The token you have open', icon: LineChart, hidden: true },
  { id: 'watchlist', label: 'Watchlist', i18n: 'nav.watchlist', hint: 'Tokens you pinned', icon: Radar },
  { id: 'runners', label: 'Runners', i18n: 'nav.runners', hint: 'Launches the scanner flagged as potential runners', icon: Flame },
  { id: 'wire', label: 'Wire', i18n: 'nav.wire', hint: 'Rail health, and who is paying for placement', icon: Activity },
  { id: 'trades', label: 'Trades', i18n: 'nav.trades', hint: 'Every round trip you made, in and out', icon: Receipt },
  { id: 'orders', label: 'Orders', i18n: 'nav.orders', hint: 'Place and manage stop losses, take profits, limits', icon: ListOrdered },
  { id: 'positions', label: 'Portfolio', i18n: 'nav.portfolio', hint: 'Positions and PnL', icon: Wallet },
  { id: 'wallet', label: 'Sol Wallet', i18n: 'nav.solWallet', hint: 'Your Solana trading wallet, keys and arming', icon: KeyRound },
  // One page per EVM chain rather than one page with a chain switch: a user
  // looking for their BNB balance should find "BNB Wallet" in the menu, not
  // discover that "Wallet" means something different depending on a control
  // in the top bar. The KEY is shared across EVM chains and each page says so.
  { id: 'walletrobinhood', label: 'Robinhood Wallet', i18n: 'nav.robinhoodWallet', hint: 'Your Robinhood Chain wallet and balances', icon: KeyRound },
  { id: 'walletbnb', label: 'BNB Wallet', i18n: 'nav.bnbWallet', hint: 'Your BNB Smart Chain wallet and balances', icon: KeyRound },
  // Its own entry rather than a card on the Solana wallet page: it is a tool
  // people come here to use, not housekeeping they find while checking a
  // balance.
  { id: 'swap', label: 'Swap', i18n: 'nav.swap', hint: 'Trade one token for another — cash out to a stablecoin, or consolidate dust', icon: Repeat },
  // Separate from Swap on purpose: a swap is atomic and nobody ever holds
  // your money; a bridge is two transactions with a third party in between.
  { id: 'bridge', label: 'Bridge', i18n: 'nav.bridge', hint: 'Move a chain’s own coin to another chain — off by default', icon: Shuffle },
];

export const AUTOMATION_ROUTES: RouteSpec[] = [
  { id: 'dashboard', label: 'Observatory', i18n: 'nav.observatory', hint: 'Solana engine dashboard', icon: Telescope },
  { id: 'observatoryrobinhood', label: 'Observatory · Robinhood', hint: 'Pons launches on Robinhood Chain', icon: Telescope },
  { id: 'observatorybnb', label: 'Observatory · BNB', hint: 'four.meme launches on BNB Smart Chain', icon: Telescope },
  // Lives under Automation, not Terminal: this is the one page that trades on
  // its own initiative, off someone else's activity rather than your click.
  // It also used to be called "Wallets", one letter from the page holding YOUR
  // keys — a collision that got worse once a single "Wallet" held several.
  // Copy Simple (2026-09-20): the three-question way in. Same store as
  // Copy Trading, which keeps every control.
  { id: 'copysimple', label: 'Copy Simple', hint: 'Paste a wallet, pick an amount, follow on paper', icon: UserPlus },
  { id: 'wallets', label: 'Copy Trading', i18n: 'nav.copyTrading', hint: "Follow other traders' wallets — every control", icon: Users },
  { id: 'scripts', label: 'Scripts', i18n: 'nav.scripts', hint: 'Your own rules and code, under a budget — paper first', icon: Code2 },
  { id: 'farming', label: 'Farming', hint: 'Not built yet — what it would be, and what has to be true first', icon: Sprout },
  // Moved out of Settings (2026-09-23): nobody found it there, and an AI
  // trading through the app is a way of acting without your click.
  { id: 'mcp', label: 'AI connection', hint: 'Let an AI like Claude read the app (MCP) and, if you allow it, trade through it', icon: Bot },
  { id: 'creator', label: 'Wallet list', i18n: 'nav.groupWallets', hint: 'Up to 15 wallets: make main, pump.fun account, import an existing one', icon: FolderPlus },
  { id: 'funder', label: 'Funder', i18n: 'nav.funder', hint: 'Fund wallets from the main one, all or hand-picked; collect back', icon: Coins },
  // Merged into the Wallet list (2026-09-22). Hidden, kept so old pins open.
  { id: 'copier', label: 'Copier', hint: 'Now part of the Wallet list', icon: Users, hidden: true },
  { id: 'autocallout', label: 'Auto-callout', hint: 'Post a pump.fun callout on the coins you buy', icon: Megaphone },
  { id: 'pumpaccounts', label: 'pump.fun accounts', hint: 'Every wallet’s account: sessions, names, and your caller stats', icon: AtSign },
  { id: 'launches', label: 'Launches', i18n: 'nav.launches', hint: 'Live launch scanner', icon: Rocket },
  { id: 'strategy', label: 'Strategy', hint: 'Paper-entry gates and backtest defaults — nothing here buys', icon: BookMarked },
  { id: 'execution', label: 'Execution', i18n: 'nav.execution', hint: 'What gets flagged as a runner, fees and lanes', icon: Gauge },
  // 'paper' (the old Paper book page) is no longer listed: paper round trips
  // sit on the Trades page beside the real ones, marked, and the wallet
  // holdings it also carried moved to the Wallet page (2026-09-06).
  { id: 'backtest', label: 'Backtest', i18n: 'nav.backtest', icon: FlaskConical },
  { id: 'history', label: 'History', i18n: 'nav.history', icon: HistoryIcon },
  { id: 'console', label: 'Console', hint: 'Live engine log', icon: ScrollText },
];

export const GUIDES_ROUTES: RouteSpec[] = [
  { id: 'guides', label: 'Guides', i18n: 'nav.guides', hint: 'How each part of the app works, in plain words', icon: BookOpen },
];

export const SCOUT_ROUTES: RouteSpec[] = [
  { id: 'scout', label: 'Wallet Scout', i18n: 'nav.walletScout', hint: 'Top traders per chain, over a window you pick', icon: Users },
];

export const LAUNCH_ROUTES: RouteSpec[] = [
  { id: 'launch', label: 'Launch a token', i18n: 'nav.launchToken', hint: 'Create your own token — off by default', icon: Rocket },
];

export const LAYOUT_ROUTES: RouteSpec[] = [
  { id: 'workspace', label: 'Widgets', i18n: 'nav.widgets', hint: 'Widgets you choose, arranged how you like', icon: LayoutGrid },
];

export const SYSTEM_ROUTES: RouteSpec[] = [
  { id: 'settings', label: 'Settings', i18n: 'nav.settings', icon: Settings },
  { id: 'about', label: 'About', i18n: 'nav.about', icon: Sparkles },
  { id: 'legal', label: 'Legal', i18n: 'nav.legal', hint: 'Terms, privacy, risk disclosure', icon: Scale },
];

export const ROUTES: RouteSpec[] = [...TERMINAL_ROUTES, ...AUTOMATION_ROUTES, ...GUIDES_ROUTES, ...SCOUT_ROUTES, ...LAUNCH_ROUTES, ...LAYOUT_ROUTES, ...SYSTEM_ROUTES];

function NavButton({
  route,
  active,
  onNavigate,
  badge,
}: {
  route: RouteSpec;
  active: boolean;
  onNavigate: (id: RouteId) => void;
  /** Small count chip (runners flagged in the last hour). */
  badge?: number;
}) {
  const { t } = useLocale();
  const Icon = route.icon;
  return (
    <button
      onClick={() => onNavigate(route.id)}
      // The chunk starts loading on hover: by the click it is usually cached.
      onMouseEnter={() => void prefetchRoute(route.id)}
      onFocus={() => void prefetchRoute(route.id)}
      title={route.hint}
      className={cls(
        'group flex items-center gap-3 rounded-md px-3 py-2 text-value font-medium transition relative',
        active
          ? 'bg-white/[0.07] text-white border border-white/10 shadow-[inset_0_1px_0_rgba(240,237,226,0.05)]'
          : 'text-krypt-muted hover:text-white hover:bg-white/5 border border-transparent',
      )}
    >
      <Icon className={cls('h-4 w-4 flex-shrink-0', active && 'text-krypt-purple')} />
      {route.i18n ? t(route.i18n) : route.label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto mr-3 rounded-full border border-arc-gold/40 bg-arc-gold/10 px-1.5 py-px font-mono text-label text-arc-gold">
          {badge}
        </span>
      )}
      {active && (
        <>
          <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full bg-gradient-to-b from-krypt-purple via-arc-gold/80 to-krypt-purple" />
          <span className="absolute right-2.5 h-1 w-1 rotate-45 bg-arc-gold/70 shadow-gold-glow" aria-hidden="true" />
        </>
      )}
    </button>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span className="font-display text-micro font-semibold uppercase tracking-heading text-krypt-muted/50 whitespace-nowrap">
        {children}
      </span>
      <div className="h-px flex-1 bg-gradient-to-r from-white/8 to-transparent" aria-hidden="true" />
    </div>
  );
}

export function Sidebar({
  current,
  onNavigate,
  running,
  feedLive,
  openSymbol,
  badges,
  workspace,
  onHub,
  hiddenRoutes,
  groupsOverride,
}: {
  current: RouteId;
  onNavigate: (next: RouteId) => void;
  running: boolean;
  feedLive: boolean;
  /** Symbol of the token currently open, so the Token row is meaningful. */
  openSymbol: string | null;
  /** Per-route count chips. */
  badges?: Partial<Record<RouteId, number>>;
  /** The workspace being shown. The nav lists only its pages — twenty-five
   *  routes in one column was the thing workspaces exist to fix. */
  workspace: WorkspaceId;
  /** Back to the Hub. Present on every page, which is the point. */
  onHub: () => void;
  /** Routes to leave out of the menu entirely — a chain switched off in
   *  Settings, for instance. Hiding rather than disabling is deliberate: the
   *  original EVM panel hid a disabled chain so it could not be armed from a
   *  surface the user turned off, and its balance poll stopped hitting an RPC
   *  they had disabled. A menu entry that opens an armable page is the same
   *  hazard one click further away. */
  hiddenRoutes?: ReadonlySet<RouteId>;
  /**
   * Replaces the workspace's own sections entirely.
   *
   * Used by Widgets, where the menu is whatever the user pinned rather than
   * a fixed set of pages. Passed in rather than read here so this component
   * stays a pure function of its props.
   */
  groupsOverride?: Array<{ label: string | null; routes: RouteId[] }>;
}) {
  const { t } = useLocale();
  const spec = workspaceSpec(workspace);
  // Sections come from the WORKSPACE, not from the app-wide Terminal /
  // Automation / System split — inside "Wallet Utilities" those headings
  // described a different app.
  const byId = new Map(ROUTES.map((r) => [r.id, r]));
  const groups = (groupsOverride ?? groupsFor(workspace))
    .map((g) => ({
      label: g.label,
      items: g.routes
        .filter((id) => !hiddenRoutes?.has(id))
        .map((id) => byId.get(id))
        .filter((r): r is RouteSpec => !!r),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <aside className="relative flex flex-col w-[210px] flex-shrink-0 border-r border-white/10 bg-krypt-panel/70  shadow-[inset_-14px_0_28px_rgba(0,0,0,0.35)]">
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-arc-gold/25 to-transparent" aria-hidden="true" />

      <div className="px-5 pt-5 pb-4 flex items-center gap-3">
        <img
          src="./krypt.png"
          alt=""
          className="h-9 w-9 rounded-md drop-shadow-[0_0_6px_rgb(var(--krypt-accent)/0.6)]"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        <div>
          <div className="font-display text-figure font-bold tracking-label text-krypt-gradient leading-none">KRYPTO</div>
          <div className="font-display text-micro tracking-eyebrow text-arc-gold/80 leading-none mt-1.5">TERMINAL</div>
        </div>
      </div>

      <div className="mx-5 h-px bg-gradient-to-r from-white/10 via-white/5 to-transparent" aria-hidden="true" />

      <button
        onClick={onHub}
        className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-note font-medium text-krypt-muted transition hover:border-krypt-purple/40 hover:bg-krypt-purple/10 hover:text-white"
        title="Back to the Hub"
      >
        <Home className="h-3.5 w-3.5" />
        Hub
        {spec && <span className="ml-auto truncate text-label text-krypt-muted/60">{spec.title}</span>}
      </button>

      <nav className="flex-1 px-3 pb-3 flex flex-col gap-0.5 overflow-y-auto">
        {groups.map((g, gi) => (
          <Fragment key={g.label ?? `g${gi}`}>
            {/* A single unlabelled section renders as a plain list. */}
            {g.label && groups.length > 1 && <GroupLabel>{g.label}</GroupLabel>}
            {g.items
              .filter((r) => !r.hidden || current === r.id)
              .map((r) => (
                <NavButton
                  key={r.id}
                  route={r.id === 'token' && openSymbol ? { ...r, label: openSymbol } : r}
                  badge={badges?.[r.id]}
                  active={current === r.id}
                  onNavigate={onNavigate}
                />
              ))}
          </Fragment>
        ))}
      </nav>

      <div className="px-3 py-3 border-t border-white/5 space-y-2.5">
        <div className="flex items-center gap-2 px-1">
          <span className={cls(
            'h-2 w-2 rounded-full',
            running && feedLive ? 'bg-emerald-400 animate-pulse-slow shadow-[0_0_8px_rgba(52,211,153,0.7)]' :
            running             ? 'bg-amber-400 animate-pulse-slow' :
                                  'bg-krypt-muted/40',
          )} />
          <div className="font-display text-label tracking-label uppercase text-krypt-muted">
            {running && feedLive ? t('status.scanning') : running ? t('status.attuning') : t('status.dormant')}
          </div>
        </div>

        {/* Renders nothing unless a newer version actually exists. */}
        <UpdateNotice />

        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => window.krypt.app.openExternal(KRYPT_URL)}
            className="group flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-2 text-xs font-semibold text-krypt-muted transition hover:text-white hover:border-krypt-purple/40 hover:bg-krypt-purple/10 hover:shadow-krypt-glow"
          >
            <Globe className="h-3.5 w-3.5 transition group-hover:text-krypt-purple" />
            krypt.cc
          </button>
          <button
            onClick={() => window.krypt.app.openExternal(DISCORD_URL)}
            className="group flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-2 text-xs font-semibold text-krypt-muted transition hover:text-white hover:border-[#5865F2]/50 hover:bg-[#5865F2]/15"
          >
            <DiscordIcon className="h-3.5 w-3.5 transition group-hover:text-[#8b94f7]" />
            Discord
          </button>
        </div>

        <div className="text-label text-krypt-muted/45 px-1 leading-relaxed">
          <div>Free · no ads, no telemetry</div>
          <button
            onClick={() => onNavigate('legal')}
            className="mt-0.5 underline underline-offset-2 hover:text-krypt-muted transition-colors"
          >
            Terms · Privacy · Risk
          </button>
          <div className="mt-0.5">Provided as-is, no warranty. {COPYRIGHT_LINE}</div>
        </div>
      </div>
    </aside>
  );
}
