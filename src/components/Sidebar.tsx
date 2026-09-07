import {
  Scale,
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
  Users,
  ScrollText,
  Settings,
  Sparkles,
  Telescope,
  BookMarked,
  Wallet, Flame, Coins, Thermometer, Copy, FolderPlus, Receipt } from 'lucide-react';
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
  | 'token'
  | 'watchlist'
  | 'runners'
  | 'trades'
  | 'creator'
  | 'funder'
  | 'warmer'
  | 'copier'
  | 'orders'
  | 'wallets'
  | 'dashboard'
  | 'launches'
  | 'positions'
  | 'paper'
  | 'history'
  | 'backtest'
  | 'execution'
  | 'wallet'
  | 'strategy'
  | 'console'
  | 'settings'
  | 'about'
  | 'legal';

export interface RouteSpec {
  id: RouteId;
  label: string;
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
  { id: 'discover', label: 'Discover', hint: 'New, graduating, migrated, trending', icon: Compass },
  { id: 'token', label: 'Token', hint: 'The token you have open', icon: LineChart, hidden: true },
  { id: 'watchlist', label: 'Watchlist', hint: 'Tokens you pinned', icon: Radar },
  { id: 'runners', label: 'Runners', hint: 'Launches the scanner flagged as potential runners', icon: Flame },
  { id: 'trades', label: 'Trades', hint: 'Every round trip you made, in and out', icon: Receipt },
  { id: 'orders', label: 'Orders', hint: 'Place and manage stop losses, take profits, limits', icon: ListOrdered },
  { id: 'positions', label: 'Portfolio', hint: 'Positions and PnL', icon: Wallet },
  { id: 'wallet', label: 'Wallet', hint: 'Your trading wallets, keys and arming', icon: KeyRound },
];

export const AUTOMATION_ROUTES: RouteSpec[] = [
  { id: 'dashboard', label: 'Observatory', hint: 'Engine dashboard', icon: Telescope },
  // Lives under Automation, not Terminal: this is the one page that trades on
  // its own initiative, off someone else's activity rather than your click.
  // It also used to be called "Wallets", one letter from the page holding YOUR
  // keys — a collision that got worse once a single "Wallet" held several.
  { id: 'wallets', label: 'Copy Trading', hint: "Follow other traders' wallets", icon: Users },
  { id: 'creator', label: 'Group Wallets', hint: 'Make a group of wallets to fund, warm or trade together', icon: FolderPlus },
  { id: 'funder', label: 'Funder', hint: 'Fund wallets from the active one, by group or individually; collect back', icon: Coins },
  { id: 'warmer', label: 'Warmer', hint: 'Random autotrading on a group or one wallet, under a loss cap', icon: Thermometer },
  { id: 'copier', label: 'Copier', hint: 'Follow the main wallet at a % or exact size; manual orders with a group', icon: Copy },
  { id: 'launches', label: 'Launches', hint: 'Live launch scanner', icon: Rocket },
  { id: 'strategy', label: 'Spellbook', hint: 'Strategy settings', icon: BookMarked },
  { id: 'execution', label: 'Execution', hint: 'Fees, lanes and send plans', icon: Gauge },
  // 'paper' (the old Paper book page) is no longer listed: paper round trips
  // sit on the Trades page beside the real ones, marked, and the wallet
  // holdings it also carried moved to the Wallet page (2026-09-06).
  { id: 'backtest', label: 'Backtest', icon: FlaskConical },
  { id: 'history', label: 'History', icon: HistoryIcon },
  { id: 'console', label: 'Grimoire', hint: 'Console log', icon: ScrollText },
];

export const SYSTEM_ROUTES: RouteSpec[] = [
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'about', label: 'About', icon: Sparkles },
  { id: 'legal', label: 'Legal', hint: 'Terms, privacy, risk disclosure', icon: Scale },
];

export const ROUTES: RouteSpec[] = [...TERMINAL_ROUTES, ...AUTOMATION_ROUTES, ...SYSTEM_ROUTES];

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
  const Icon = route.icon;
  return (
    <button
      onClick={() => onNavigate(route.id)}
      title={route.hint}
      className={cls(
        'group flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition relative',
        active
          ? 'bg-white/[0.07] text-white border border-white/10 shadow-[inset_0_1px_0_rgba(240,237,226,0.05)]'
          : 'text-krypt-muted hover:text-white hover:bg-white/5 border border-transparent',
      )}
    >
      <Icon className={cls('h-4 w-4 flex-shrink-0', active && 'text-krypt-purple')} />
      {route.label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto mr-3 rounded-full border border-arc-gold/40 bg-arc-gold/10 px-1.5 py-px font-mono text-[10px] text-arc-gold">
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
      <span className="font-display text-[9px] font-semibold uppercase tracking-[0.3em] text-krypt-muted/50 whitespace-nowrap">
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
}: {
  current: RouteId;
  onNavigate: (next: RouteId) => void;
  running: boolean;
  feedLive: boolean;
  /** Symbol of the token currently open, so the Token row is meaningful. */
  openSymbol: string | null;
  /** Per-route count chips. */
  badges?: Partial<Record<RouteId, number>>;
}) {
  return (
    <aside className="relative flex flex-col w-[210px] flex-shrink-0 border-r border-white/10 bg-krypt-panel/70  shadow-[inset_-14px_0_28px_rgba(0,0,0,0.35)]">
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-arc-gold/25 to-transparent" aria-hidden="true" />

      <div className="px-5 pt-5 pb-4 flex items-center gap-3">
        <img
          src="./krypt.png"
          alt=""
          className="h-9 w-9 rounded-md drop-shadow-[0_0_6px_rgba(139,124,232,0.6)]"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        <div>
          <div className="font-display text-[15px] font-bold tracking-[0.14em] text-krypt-gradient leading-none">KRYPTO</div>
          <div className="font-display text-[9px] tracking-[0.36em] text-arc-gold/80 leading-none mt-1.5">TERMINAL</div>
        </div>
      </div>

      <div className="mx-5 h-px bg-gradient-to-r from-white/10 via-white/5 to-transparent" aria-hidden="true" />

      <nav className="flex-1 px-3 pb-3 flex flex-col gap-0.5 overflow-y-auto">
        <GroupLabel>Terminal</GroupLabel>
        {TERMINAL_ROUTES.filter((r) => !r.hidden || current === r.id).map((r) => (
          <NavButton
            key={r.id}
            route={r.id === 'token' && openSymbol ? { ...r, label: openSymbol } : r}
            badge={badges?.[r.id]}
            active={current === r.id}
            onNavigate={onNavigate}
          />
        ))}

        <GroupLabel>Automation</GroupLabel>
        {AUTOMATION_ROUTES.map((r) => (
          <NavButton key={r.id} route={r} active={current === r.id} onNavigate={onNavigate} />
        ))}

        <GroupLabel>System</GroupLabel>
        {SYSTEM_ROUTES.map((r) => (
          <NavButton key={r.id} route={r} active={current === r.id} onNavigate={onNavigate} />
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
          <div className="font-display text-[10px] tracking-[0.24em] uppercase text-krypt-muted">
            {running && feedLive ? 'Scanning' : running ? 'Attuning' : 'Dormant'}
          </div>
        </div>

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

        <div className="text-[10px] text-krypt-muted/45 px-1 leading-relaxed">
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
