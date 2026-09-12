import { memo, useEffect, useMemo, useState } from 'react';
import { Sidebar, type RouteId } from './Sidebar';
import type { WorkspaceId } from '../workspaces';
import { Ticker } from './viz/Ticker';
import { useAppState } from '../state/AppStateProvider';
import { loadPinned, subscribePinned } from '../panels/pinned';
import { useTerminal } from '../state/TerminalProvider';

// The two pieces of chrome that follow live engine state.
//
// They exist as separate components so that `App` does not have to subscribe.
// The engine pushes a status event every second; when the root consumed it,
// every route re-rendered on that heartbeat — including Discover, which is
// four columns of forty cards at 63 DOM elements each, about 10,000 in total.
// Nothing about that tree changes because `eventsPerSec` ticked.
//
// Now the subscription lives with the only two things that draw from it.
//
// The same applied to the MARKET context: `App` read `term.columns` only to
// label the Token nav row with a symbol, and every Discover poll replaced
// `columns` — so the root re-rendered on that too. The lookup moved here,
// where a re-render costs a sidebar, not the whole shell.

export const SidebarLive = memo(function SidebarLive({
  current,
  onNavigate,
  openMint,
  workspace,
  onHub,
}: {
  current: RouteId;
  onNavigate: (r: RouteId) => void;
  /** The mint the token page is showing, or null. */
  openMint: string | null;
  workspace: WorkspaceId;
  onHub: () => void;
}) {
  const { status, runners, settings } = useAppState();
  // An EVM chain switched off in Settings has no menu entry: its page can arm
  // that chain and polls its RPC, so a disabled chain must not be one click
  // away. Same rule the EVM panel already applied to its own chain strips.
  const hiddenRoutes = useMemo(() => {
    const out = new Set<RouteId>();
    if (!settings.evm.robinhood.enabled) out.add('walletrobinhood');
    if (!settings.evm.bnb.enabled) out.add('walletbnb');
    return out;
  }, [settings.evm.robinhood.enabled, settings.evm.bnb.enabled]);
  // My Layout's menu is whatever the user pinned, so it is state rather than
  // a fixed list. Read here — this component already re-renders on its own,
  // away from the root.
  const [pinned, setPinned] = useState<RouteId[]>(loadPinned);
  useEffect(() => subscribePinned(() => setPinned(loadPinned())), []);
  const groupsOverride = useMemo(() => {
    if (workspace !== 'layout') return undefined;
    return [
      { label: null as string | null, routes: ['workspace' as RouteId] },
      ...(pinned.length ? [{ label: 'Pinned' as string | null, routes: pinned }] : []),
    ];
  }, [workspace, pinned]);
  const { columns } = useTerminal();
  const recentRunners = useMemo(() => runners.filter((r) => Date.now() - r.flaggedAt < 3_600_000).length, [runners]);
  const openSymbol = useMemo(() => {
    if (openMint === null) return null;
    for (const col of Object.values(columns)) {
      const hit = col.rows.find((r) => r.mint === openMint);
      if (hit) return hit.symbol;
    }
    return `${openMint.slice(0, 4)}…`;
  }, [columns, openMint]);
  return (
    <Sidebar
      current={current}
      onNavigate={onNavigate}
      running={status.running}
      feedLive={status.feed === 'live'}
      openSymbol={openSymbol}
      badges={{ runners: recentRunners }}
      workspace={workspace}
      onHub={onHub}
      hiddenRoutes={hiddenRoutes}
      groupsOverride={groupsOverride}
    />
  );
});

export const TickerLive = memo(function TickerLive() {
  const { launches } = useAppState();
  return <Ticker launches={launches} />;
});
