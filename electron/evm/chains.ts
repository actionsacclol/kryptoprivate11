// The per-chain configuration the EVM rail dispatches on.
//
// One object per chain answers "which contracts, which router, which fee
// rule, which launchpad" so the shared code (client, wallet, trade, ledger,
// discover, market) never has to ask `if (chain === 'bnb')` for an address.
// The launchpad-specific code (pons.ts, fourmeme.ts) stays chain-specific by
// nature and is reached through venue.ts.

import type { Chain, Address } from 'viem';
import { EVM_CHAIN_META, type EvmChainKind, type EvmChainMeta, type EvmRpcCapability } from '@shared/evm';
import { ADDR, ROBINHOOD, V3_FEE_TIERS } from './chain';
import { ADDR_BSC, BSC, PANCAKE_V3_FEE_TIERS } from './bsc';

/**
 * One endpoint per capability.
 *
 * BNB has **no single free endpoint that does everything** — 28 were probed
 * read-only on 2026-09-09 (docs/api-swarm-2026-09-09.md §2, raw tables in the
 * swarm's rpc-evm report) and they fall into three families:
 *
 *   · official dataseeds (`*.bnbchain.org`, defibit, ninicoin, bsc.nodereal.io)
 *     — receipts yes, `eth_simulateV1` yes, `eth_getLogs` **disabled outright**
 *     (`-32005 limit exceeded` for a single block; BNB's own docs say so), and
 *     state for ~110 blocks ≈ 50 s (geth's 128-block trie);
 *   · publicnode (the chain's `publicRpc`) — logs near head, `eth_simulateV1`,
 *     **no receipts at any depth** and ≤20 blocks of state;
 *   · `rpc-bnb.blockmachine.io` (listed in BNB's own docs) and NodeReal's
 *     shared-key URL — archival receipts, logs and state, but **no
 *     `eth_simulateV1`**.
 *
 * Modelling that as one `receiptRpc` field is what capped the launch index at
 * ~67 minutes, priced fills from state the endpoint had already pruned, and
 * sent every broadcast through a private relay by accident. Empty string means
 * "the chain's main endpoint serves this" (see client.endpointFor: a user's own
 * endpoint always wins, then the entry here, then the public endpoint).
 */
export type EvmEndpointMap = Record<EvmRpcCapability, string>;

export interface EvmChainConfig {
  kind: EvmChainKind;
  meta: EvmChainMeta;
  viem: Chain;
  /** Contracts every venue on the chain shares. */
  addr: {
    native: Address;
    wrapped: Address;
    multicall3: Address;
    permit2: Address;
    universalRouter: Address;
    v3Factory: Address;
    v3QuoterV2: Address;
    /** Krypt's curve router for the chain's launchpad, '' until deployed. */
    kryptRouter: Address | '';
  };
  v3FeeTiers: readonly number[];
  /**
   * How to price gas. 'base2x': EIP-1559 with priority 0 and a cap at twice
   * the base fee (Robinhood: sequencer takes no tip). 'gasPrice': the node's
   * eth_gasPrice as both fields (BNB: base fee is 0 and validators enforce a
   * minimum gas price, so a zero tip is dropped).
   */
  feeRule: 'base2x' | 'gasPrice';
  /** Floor for maxFeePerGas, wei. */
  minFeePerGas: bigint;
  /** Wait this long for a receipt before reporting "not confirmed". */
  receiptTimeoutMs: number;
  /** Which endpoint serves which capability. See EvmEndpointMap. */
  endpoints: EvmEndpointMap;
  /** Rate gate for the PUBLIC endpoint (rps, burst). */
  publicRate: { rate: number; burst: number };
}

export const CHAINS: Record<EvmChainKind, EvmChainConfig> = {
  robinhood: {
    kind: 'robinhood',
    meta: EVM_CHAIN_META.robinhood,
    viem: ROBINHOOD,
    addr: {
      native: ADDR.native,
      wrapped: ADDR.weth,
      multicall3: ADDR.multicall3,
      permit2: ADDR.permit2,
      universalRouter: ADDR.universalRouter,
      v3Factory: ADDR.v3Factory,
      v3QuoterV2: ADDR.v3QuoterV2,
      kryptRouter: ADDR.kryptRouter,
    },
    v3FeeTiers: V3_FEE_TIERS,
    feeRule: 'base2x',
    minFeePerGas: 10_000_000n, // 0.01 gwei
    receiptTimeoutMs: 45_000,
    endpoints: {
      // The official RPC is genuinely good: archive receipts (a 1,000,000-block-old
      // hash answered), a 200,000-block `eth_getLogs` window in 1.28 s, and
      // `eth_simulateV1`. It serves everything except two things.
      receipts: '',
      // (1) State. It prunes at ~4,096–16,384 blocks — 7–27 minutes at 100 ms
      // blocks — with `-32000 "metadata is not found, <block>"`. A live trade
      // reconciles well inside that, but a deferred reconcile or a restart does
      // not, and a fill priced from pruned state is priced wrong. ordofi holds
      // the same state at depth 1,000,000 (≈27 h). It must NEVER become the
      // general read client: it key-gates `eth_simulateV1` and `txpool_status`.
      state: 'https://rpc.ordofi.network',
      logs: '',
      simulate: '',
      // Robinhood's own RPC, i.e. the ordinary public path. Stated here rather
      // than inherited so the choice is visible next to BNB's (below).
      broadcast: '',
      // (2) WSS. The official RPC's handshake fails; publicnode-Robinhood
      // carried newHeads + unfiltered logs for 15 s (5,891 events) on
      // 2026-09-09. Nothing subscribes yet — this is where a Pons launch feed
      // would live.
      ws: 'wss://robinhood-rpc.publicnode.com',
    },
    publicRate: { rate: 5, burst: 8 },
  },
  bnb: {
    kind: 'bnb',
    meta: EVM_CHAIN_META.bnb,
    viem: BSC,
    addr: {
      native: ADDR_BSC.native,
      wrapped: ADDR_BSC.wbnb,
      multicall3: ADDR_BSC.multicall3,
      permit2: ADDR_BSC.permit2,
      universalRouter: ADDR_BSC.universalRouter,
      v3Factory: ADDR_BSC.v3Factory,
      v3QuoterV2: ADDR_BSC.v3QuoterV2,
      kryptRouter: ADDR_BSC.kryptRouter,
    },
    v3FeeTiers: PANCAKE_V3_FEE_TIERS,
    feeRule: 'gasPrice',
    minFeePerGas: 50_000_000n, // 0.05 gwei — the validators' floor
    receiptTimeoutMs: 60_000,
    endpoints: {
      // publicnode (the chain's publicRpc) refuses `eth_getTransactionReceipt`
      // at EVERY depth — "Archive requests require a personal token", even for
      // the head block — so receipts have to come from somewhere else or no BNB
      // trade ever confirms. The dataseed answers a head receipt and a 2022 one,
      // is documented at 10K/5min, and is the fastest of the three families near
      // head, which is where a receipt poll lives.
      receipts: 'https://bsc-dataseed.bnbchain.org',
      // NOT the dataseed. Its historical state is geth's 128-block trie —
      // bisected to 110–119 blocks on three hosts, ≈50 s at 450 ms blocks —
      // against a 60 s receipt timeout, so a fill confirmed near the timeout was
      // being priced from state the endpoint had already dropped. blockmachine
      // answered `eth_getBalance` at depth 5,000,000.
      state: 'https://rpc-bnb.blockmachine.io',
      // NOT the dataseed (getLogs is disabled there by policy) and not
      // publicnode (403 "archive" past ~9,000 blocks, which is what capped the
      // launch index at ~67 minutes). blockmachine is listed in BNB's own docs
      // and returned a 5,000-block log window at depth 1,000,000 in 705 ms; its
      // hard cap is a 10,000-block INCLUSIVE range.
      logs: 'https://rpc-bnb.blockmachine.io',
      // Must not be blockmachine: it answers `eth_simulateV1` with
      // -32603 "global signer not initialized for mining mode". publicnode and
      // the dataseeds both serve it, so '' (the main endpoint) is correct.
      simulate: '',
      // DELIBERATE, and the one entry here that is a product call rather than a
      // capability fact. '' means publicnode, which states "MEV protection
      // enabled by default" and routes eth_sendRawTransaction through private
      // relays — so BNB sends bypass the public mempool. That may well be what a
      // sniper wants, but it changes the failure mode: a transaction sitting in
      // a relay is invisible to eth_getTransactionByHash on every other node, so
      // the 'pending' stage cannot tell "queued" from "dropped". The ordinary
      // public-mempool path is 'https://bsc-dataseed.bnbchain.org'. Left as it
      // has always behaved; changing it is a decision for a human, not a
      // side effect of this refactor.
      broadcast: '',
      // Measured 2026-09-09: newHeads + unfiltered logs, 6,014 events in 15 s,
      // keyless. Nothing subscribes yet — a four.meme TokenCreate feed would
      // live here and would never touch publicnode's archive wall, because a
      // subscription only ever delivers head data.
      ws: 'wss://bsc-rpc.publicnode.com',
    },
    publicRate: { rate: 8, burst: 12 },
  },
};

export function chainConfig(chain: EvmChainKind): EvmChainConfig {
  return CHAINS[chain];
}
