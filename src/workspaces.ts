// Workspaces — the app's top-level organisation.
//
// The app grew to twenty-five routes in one flat sidebar, which made two
// unrelated jobs look like one list: "Funder" sat four rows from "Orders",
// and a page that trades on its own initiative sat next to one that only
// moves when you click. Workspaces isolate those jobs. You land on the Hub,
// pick what you are doing, and the sidebar then shows only that job's pages.
//
// The rules this file exists to keep:
//
//   * ONE home per route. `workspaceOf` is the single answer to "where does
//     this page live", derived from `routes` order, so a page cannot drift
//     into two menus and disagree with itself.
//   * A route may still be LISTED in more than one workspace when it is
//     genuinely needed in both (arming a wallet, for instance). Listing is
//     navigation; the home is identity. `extraRoutes` is that distinction,
//     spelled out rather than implied.
//   * Nothing here imports a page. This module is a map, so it stays cheap
//     and the route loaders keep their lazy boundaries.

import type { RouteId } from './components/Sidebar';

export type WorkspaceId = 'hub' | 'terminal' | 'automation' | 'engine' | 'wallets' | 'rewards' | 'scout' | 'launch' | 'layout' | 'system';

export interface WorkspaceSpec {
  id: WorkspaceId;
  /** Shown on the Hub card and in the top bar. */
  title: string;
  /** One line, plain language — what you would come here to do. */
  blurb: string;
  /** The pages this workspace OWNS, in sidebar order. First is the landing. */
  routes: RouteId[];
  /** Pages listed here for convenience but owned by another workspace. */
  extraRoutes?: RouteId[];
  /**
   * Sidebar group headings, in order, each with the routes under it.
   *
   * The original sidebar had three fixed groups — Terminal, Automation,
   * System — which described the WHOLE app. Inside a workspace those labels
   * are wrong: "TERMINAL / Wallet" then "AUTOMATION / Group Wallets" reads
   * like two unrelated apps when the workspace is called Wallet Utilities.
   * A workspace names its own sections, or has none.
   */
  groups?: Array<{ label: string; routes: RouteId[] }>;
  /** Lucide icon name, resolved by the Hub so this module stays icon-free. */
  icon: 'compass' | 'users' | 'cpu' | 'wallet' | 'gift' | 'scout' | 'launch' | 'layout' | 'settings' | 'automation';
  /** False until the workspace has something worth opening. */
  ready: boolean;
}

export const WORKSPACES: WorkspaceSpec[] = [
  {
    id: 'terminal',
    title: 'Terminal',
    blurb: 'Find a token, read it, and trade it by hand.',
    routes: ['discover', 'token', 'watchlist', 'runners', 'trades', 'orders', 'positions'],
    extraRoutes: ['wallet', 'walletrobinhood', 'walletbnb'],
    groups: [
      { label: 'Find', routes: ['discover', 'token', 'watchlist', 'runners'] },
      { label: 'Your trading', routes: ['trades', 'orders', 'positions', 'wallet', 'walletrobinhood', 'walletbnb'] },
    ],
    icon: 'compass',
    ready: true,
  },
  {
    id: 'automation',
    title: 'Automation',
    // Was "Copy Trading", which named ONE of the things in it. What actually
    // unites these pages is that each one acts off something other than your
    // click — another trader's wallet, a rule you wrote, a schedule. Scripts
    // moved here from Main Engine for that reason: it is not part of the
    // scanner, it just happened to be built alongside it.
    blurb: 'Everything that trades without you clicking: followed wallets, your own rules, and farming.',
    routes: ['wallets', 'scripts', 'farming'],
    icon: 'automation',
    ready: true,
  },
  {
    id: 'engine',
    title: 'Main Engine',
    // Scripts used to be listed here and owned here. It moved to Automation
    // on 2026-09-13: it is a thing that acts on its own, not a part of the
    // scanner, and the two were only together because they were built
    // together. Deliberately NOT left in `extraRoutes` — two menus showing
    // the same page is how the flat sidebar became unreadable in the first
    // place, and the Hub card for Automation now says where it went.
    blurb: 'The scanner, its tuning, and the record of what it did.',
    routes: ['dashboard', 'observatoryrobinhood', 'observatorybnb', 'launches', 'strategy', 'execution', 'backtest', 'history', 'console'],
    groups: [
      { label: 'Running', routes: ['dashboard', 'observatoryrobinhood', 'observatorybnb', 'launches'] },
      { label: 'Tuning', routes: ['strategy', 'execution'] },
      { label: 'Looking back', routes: ['backtest', 'history', 'console'] },
    ],
    icon: 'cpu',
    ready: true,
  },
  {
    id: 'wallets',
    title: 'Wallet Utilities',
    blurb: 'Your keys, and the wallet groups you fund, warm and mirror.',
    routes: ['wallet', 'walletrobinhood', 'walletbnb', 'swap', 'bridge', 'creator', 'funder'],
    groups: [
      { label: 'Your wallets', routes: ['wallet', 'walletrobinhood', 'walletbnb'] },
      // Its own heading. It is neither a wallet nor part of the Lab's
      // many-wallet machinery — it is the one thing on this workspace that
      // acts on what a single wallet is holding right now.
      { label: 'Tools', routes: ['swap', 'bridge'] },
      { label: 'Wallet Lab', routes: ['creator', 'funder'] },
    ],
    icon: 'wallet',
    ready: true,
  },
  {
    id: 'rewards',
    title: 'Rewards',
    // Deliberately NOT "Airdrop Hunter". Six researchers killed farming on the
    // arithmetic (docs/airdrop-research-2026-09-09.md): break-even needs a hit
    // rate above 100% once labour is priced, eligibility rules are published
    // after the block they measure, and two of our three chains have no
    // reachable airdrop layer at all. What IS real is the opposite shape — a
    // published, funded, address-queryable rate you can verify BEFORE acting.
    // So this workspace states what you are earning; it never chases a maybe.
    blurb: 'Published reward rates on the pools you can actually verify — no hunting, no guessing.',
    routes: ['rewards'],
    icon: 'gift',
    ready: true,
  },
  {
    id: 'scout',
    title: 'Wallet Scout',
    // A DATA tool, and the blurb has to keep saying so. Ranking traders by
    // past profit picks up luck as readily as skill — this project measured
    // that on liquidity providers (corr 0.936 with price direction) and on a
    // strategy that went +24.37% in-sample to −1.39% out. So: what they did,
    // over a window, and the reader decides.
    blurb: 'What wallets actually did, on every chain. Find someone worth following — or find out nobody is.',
    routes: ['scout'],
    icon: 'scout',
    ready: true,
  },
  {
    id: 'launch',
    title: 'Launch a Token',
    // The research said do not build this, on economics and on the signer
    // invariant (docs/launch-research-2026-09-09.md). The invariant objection
    // is answered — off by default, its own wallet, one NAMED extra signer.
    // The economics objection is not, and the page says so before the switch
    // rather than after: ~2% graduate, and a launch with no audience is worth
    // a couple of dollars.
    blurb: 'Create your own token. Off by default, with a wallet of its own — and honest about what it is worth.',
    routes: ['launch'],
    icon: 'launch',
    ready: true,
  },
  {
    id: 'layout',
    title: 'My Layout',
    // The one surface the app does not decide for you. Everything on it is a
    // self-contained widget (src/panels/registry.tsx) — panels that need a
    // selected token cannot go here, because a free-form grid has no token.
    blurb: 'Your own dashboard. Choose the panels, drag them where you want.',
    routes: ['workspace'],
    icon: 'layout',
    ready: true,
  },
  {
    id: 'system',
    title: 'Settings & Legal',
    blurb: 'Preferences, providers, keys, and the documents you accepted.',
    routes: ['settings', 'about', 'legal'],
    icon: 'settings',
    ready: true,
  },
];

/** Every workspace that owns `route`, in declaration order. */
const OWNER = new Map<RouteId, WorkspaceId>();
for (const w of WORKSPACES) {
  for (const r of w.routes) if (!OWNER.has(r)) OWNER.set(r, w.id);
}

/**
 * Which workspace a route belongs to. Falls back to `terminal` rather than
 * throwing: a route added to the sidebar and forgotten here should still be
 * reachable, just filed in the obvious place. `_unmappedRoutes` is the test
 * seam that keeps that fallback from becoming a habit.
 */
export function workspaceOf(route: RouteId): WorkspaceId {
  return OWNER.get(route) ?? 'terminal';
}

/**
 * Sidebar sections for a workspace. A workspace that names its own groups gets
 * those; one that does not gets a single unlabelled list, because a lone
 * heading over every item in the menu is decoration.
 *
 * Only routes the workspace actually lists appear, so a group can name a route
 * that a build later moves without leaving a heading over nothing.
 */
export function groupsFor(id: WorkspaceId): Array<{ label: string | null; routes: RouteId[] }> {
  const w = WORKSPACES.find((x) => x.id === id);
  if (!w) return [];
  const listed = new Set(routesFor(id));
  if (!w.groups) return [{ label: null, routes: routesFor(id) }];
  const grouped = w.groups
    .map((g) => ({ label: g.label as string | null, routes: g.routes.filter((r) => listed.has(r)) }))
    .filter((g) => g.routes.length > 0);
  // Anything the groups forgot still has to be reachable.
  const covered = new Set(grouped.flatMap((g) => g.routes));
  const rest = routesFor(id).filter((r) => !covered.has(r));
  return rest.length > 0 ? [...grouped, { label: null, routes: rest }] : grouped;
}

/** The routes a workspace shows in its sidebar: owned first, then borrowed. */
export function routesFor(id: WorkspaceId): RouteId[] {
  const w = WORKSPACES.find((x) => x.id === id);
  if (!w) return [];
  return [...w.routes, ...(w.extraRoutes ?? [])];
}

/** The page a workspace opens on. */
export function landingRouteOf(id: WorkspaceId): RouteId {
  return WORKSPACES.find((x) => x.id === id)?.routes[0] ?? 'discover';
}

export function workspaceSpec(id: WorkspaceId): WorkspaceSpec | undefined {
  return WORKSPACES.find((x) => x.id === id);
}

/**
 * Test seam: routes the sidebar knows about that no workspace claims.
 *
 * `paper` is expected here and is not a mistake — the old Paper book page was
 * delisted in 2026-09-06 when paper round trips moved onto the Trades page
 * beside the real ones. It stays a valid RouteId so old state does not break,
 * and `workspaceOf` files it under Terminal if anything still reaches it.
 */
export function _unmappedRoutes(all: RouteId[]): RouteId[] {
  return all.filter((r) => !OWNER.has(r));
}
