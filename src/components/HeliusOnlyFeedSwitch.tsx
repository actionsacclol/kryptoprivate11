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

export function HeliusOnlyFeedSwitch() {
  const { settings, updateSettings } = useAppState();
  const hasKey = (settings.rpc.heliusApiKey ?? '').trim().length > 0;
  const on = settings.rpc.heliusOnlyFeed ?? false;
  return (
    <Switch
      checked={on && hasKey}
      disabled={!hasKey}
      onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusOnlyFeed: v } })}
      label="Helius only (no public sockets)"
      description={
        hasKey
          ? 'Runs the launch feed and every token watcher on your Helius socket alone: the public WebSockets and the publicnode block standby are not opened. For a VPN or shared IP where the free endpoints refuse connections. Every push is billed to your key (~800k credits a day at firehose rates — a paid-plan switch); the credit ceiling above turns it back off. Account lookups (HTTP) are unchanged. Takes effect the next time the scanner starts.'
          : 'Needs a Helius API key (Settings → Solana RPC).'
      }
    />
  );
}
