// "Helius only" for the launch feed (2026-09-30). One component, shown on
// Settings → Solana RPC and on Execution, so the two can never disagree.
//
// User report: on a shared VPN IP api.mainnet-beta.solana.com refused the
// feed socket in a loop (1006, ~27 reconnects in 18 min) — it caps pubsub
// connections per IP — while the Helius socket was already in the pool.
// With this on, resolveRpc (shared/types.ts) swaps every feed socket for the
// key's Helius socket and turns the public block standby off.

import { Switch } from './common';
import { useAppState } from '../state/AppStateProvider';
import { feedCostText } from '@shared/credits';

export function HeliusOnlyFeedSwitch() {
  const { settings, updateSettings } = useAppState();
  const hasKey = (settings.rpc.heliusApiKey ?? '').trim().length > 0;
  const on = settings.rpc.heliusOnlyFeed ?? false;
  const limit = settings.rpc.heliusMonthlyCredits ?? 0;
  return (
    <Switch
      checked={on && hasKey}
      disabled={!hasKey}
      onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusOnlyFeed: v } })}
      label="Helius only (no public sockets)"
      description={
        hasKey
          ? `Runs the launch feed and token watchers on your Helius socket alone: the public launch sockets and the publicnode block standby are not opened. The AMM tape stays on a public socket because it costs about twice as much. For a VPN or shared IP where the free endpoints refuse connections. ${feedCostText(limit)} The credit ceiling turns it back off. Account lookups (HTTP) are unchanged.`
          : 'Needs a Helius API key (Settings → Solana RPC).'
      }
    />
  );
}
