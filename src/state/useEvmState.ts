import { useCallback, useEffect, useState } from 'react';
import type { EvmChainKind, EvmState } from '@shared/evm';

/**
 * One EVM chain's rail state (wallet balance on that chain, arm state, RPC
 * host, fees, native/USD) — read once on mount and whenever `chain` changes,
 * then kept live off the `evmState` push the rail sends for THAT chain.
 * Every EVM surface reads through this so Paper/Live can never disagree
 * between the trade panel, the wallet page, the top bar and Discover's
 * quick buy. Arm state is per chain: a Robinhood push never touches a BNB
 * reader.
 *
 * `null` (the top bar while Solana is selected) reads nothing and yields
 * null — hooks cannot be conditional, but the fetch can.
 */
export function useEvmState(chain: EvmChainKind | null): { evm: EvmState | null; refresh: () => Promise<void> } {
  const [evm, setEvm] = useState<EvmState | null>(null);
  const refresh = useCallback(async () => {
    if (!chain) return;
    try {
      const r = await window.krypt.evm.state(chain);
      if (r.ok && r.data && r.data.chain === chain) setEvm(r.data);
    } catch {
      /* rail unavailable — the panels show their "no wallet" state */
    }
  }, [chain]);
  useEffect(() => {
    // A state from the previous chain must not show under the new one.
    setEvm(null);
    if (!chain) return;
    void refresh();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'evmState' && ev.state.chain === chain) setEvm(ev.state);
    });
    return off;
  }, [refresh, chain]);
  // Belt and braces: the effect above clears the old chain's state, but an
  // effect runs after render, so this is the line that makes a stale paint
  // impossible rather than merely unobserved.
  return { evm: evm && evm.chain === chain ? evm : null, refresh };
}
