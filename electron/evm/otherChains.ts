// EVM chains the app does not trade on, read only for the All-in-One wallet.
//
// Its EVM address is the same on every EVM chain, so people WILL send USDC
// to it on Ethereum, Base or Arbitrum — the address is right, the chain is
// not one the app trades. Those funds are real and the user's; hiding them
// would read as "the app lost my money". So the wallet reads the native coin
// and the two dollar stablecoins on each, includes them in the total, and
// (phase 2) lets Relay convert them to where they are needed.
//
// Read-only and small on purpose: no logs, no history, no token discovery —
// one balance call and one multicall per chain, on a public endpoint.
//
// Every token below was read off its own chain on 2026-10-01 (symbol and
// decimals from the contract, not from memory). Arbitrum's USDT now names
// itself "USD₮0" — the same contract, migrated to the USDT0 standard.

import { createPublicClient, defineChain, erc20Abi, http, type Address, type Chain, type PublicClient } from 'viem';
import type { AioOtherChain } from '@shared/aio';

interface OtherChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  stables: Array<{ address: Address; symbol: string; decimals: number }>;
}

export const OTHER_CHAINS: Record<AioOtherChain, OtherChainConfig> = {
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    nativeSymbol: 'ETH',
    stables: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    ],
  },
  base: {
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://base-rpc.publicnode.com',
    nativeSymbol: 'ETH',
    stables: [
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', decimals: 6 },
    ],
  },
  arbitrum: {
    name: 'Arbitrum',
    chainId: 42161,
    rpcUrl: 'https://arbitrum-one-rpc.publicnode.com',
    nativeSymbol: 'ETH',
    stables: [
      { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
      { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
    ],
  },
};

/** Multicall3 has the same address on every one of these chains. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Defined here rather than imported from 'viem/chains', which pulls viem's
// whole chain catalogue (and its TypeScript sources) into the main bundle.
const viemChain = (chain: AioOtherChain): Chain => {
  const c = OTHER_CHAINS[chain];
  return defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
};
const clients = new Map<AioOtherChain, PublicClient>();

function client(chain: AioOtherChain): PublicClient {
  let c = clients.get(chain);
  if (!c) {
    c = createPublicClient({ chain: viemChain(chain), transport: http(OTHER_CHAINS[chain].rpcUrl, { timeout: 8_000, retryCount: 1 }) }) as PublicClient;
    clients.set(chain, c);
  }
  return c;
}

export interface OtherChainRead {
  /** Wei. */
  native: bigint;
  /** Raw units per stable address (lowercase); a token whose read failed is absent. */
  stables: Map<string, bigint>;
}

/** Native + stables for one owner on one chain. Throws on a failed read —
 *  the caller marks that chain unread, never zero. */
export async function readOtherChain(chain: AioOtherChain, owner: Address): Promise<OtherChainRead> {
  const cfg = OTHER_CHAINS[chain];
  const c = client(chain);
  const [native, res] = await Promise.all([
    c.getBalance({ address: owner }),
    c.multicall({
      allowFailure: true,
      contracts: cfg.stables.map((s) => ({ address: s.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner] as const })),
    }),
  ]);
  const stables = new Map<string, bigint>();
  cfg.stables.forEach((s, i) => {
    const r = res[i];
    if (r.status === 'success') stables.set(s.address.toLowerCase(), r.result as bigint);
  });
  return { native, stables };
}
