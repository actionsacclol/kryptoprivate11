// Which chains exist, and nothing else.
//
// A leaf: this file imports NOTHING, so anything may import it without
// creating a cycle. That is its whole job.
//
// It exists because `shared/evm.ts` — the most depended-on module in the
// codebase, 38 importers — needs a default from `shared/evmRunners.ts`, while
// `evmRunners.ts` needs the chain type from `evm.ts`. That was the one import
// cycle in 600 internal edges (measured 2026-09-18). It was harmless at
// runtime, because the back edge is `import type` and TypeScript erases it,
// but a cycle that is only harmless by accident is one edit away from not
// being, and bundlers and dependency tools see it whatever TypeScript does.
//
// `evm.ts` re-exports every name below, so nothing that already imports them
// from there has to change, and nothing should be "migrated" to this file for
// its own sake. Import from here only to avoid depending on `evm.ts` wholesale.

/** Every chain the terminal can show. */
export type ChainKind = 'solana' | 'robinhood' | 'bnb';

export const CHAIN_KINDS: ChainKind[] = ['solana', 'robinhood', 'bnb'];

/** The chains served by the EVM rail. */
export type EvmChainKind = 'robinhood' | 'bnb';

export const EVM_CHAINS: EvmChainKind[] = ['robinhood', 'bnb'];

export function isEvmChain(k: unknown): k is EvmChainKind {
  return k === 'robinhood' || k === 'bnb';
}

export function isChainKind(k: unknown): k is ChainKind {
  return k === 'solana' || isEvmChain(k);
}
