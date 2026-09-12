// ERC-20 reads shared by every EVM chain — one multicall per question.

import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { ERC20_ABI } from './chain';
import { client } from './client';
import { MULTICALL_BYTES } from './pons';
import type { EvmChainKind } from '@shared/evm';

/**
 * An eth_call / eth_estimateGas state override that makes `owner` appear to
 * have approved `spender` for the maximum amount on an OpenZeppelin v5
 * ERC-20 (`_allowances` is the mapping at storage slot 1: the Pons factory's
 * tokens, and most launchpad tokens). Pure — no RPC. Lets a sell be
 * simulated honestly BEFORE the one-time approval has landed; a token with a
 * different layout simply reverts as before and the caller falls back.
 */
export function allowanceStateOverride(token: Address, owner: Address, spender: Address): { address: Address; stateDiff: Array<{ slot: Hex; value: Hex }> } {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, 1n]));
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]));
  const value = `0x${'ff'.repeat(32)}` as Hex;
  return { address: token, stateDiff: [{ slot, value }] };
}

export interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

/** name / symbol / decimals / totalSupply for many tokens in one multicall. */
export async function tokenMeta(chain: EvmChainKind, tokens: Address[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  if (!tokens.length) return out;
  const res = await client(chain).multicall({
    allowFailure: true,
    batchSize: MULTICALL_BYTES,
    contracts: tokens.flatMap((address) => [
      { address, abi: ERC20_ABI, functionName: 'name' as const },
      { address, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address, abi: ERC20_ABI, functionName: 'decimals' as const },
      { address, abi: ERC20_ABI, functionName: 'totalSupply' as const },
    ]),
  });
  tokens.forEach((address, i) => {
    const name = res[i * 4], symbol = res[i * 4 + 1], dec = res[i * 4 + 2], supply = res[i * 4 + 3];
    out.set(address.toLowerCase(), {
      name: name.status === 'success' ? String(name.result) : '',
      symbol: symbol.status === 'success' ? String(symbol.result) : '',
      decimals: dec.status === 'success' ? Number(dec.result) : 18,
      totalSupply: supply.status === 'success' ? (supply.result as bigint) : 0n,
    });
  });
  return out;
}

export async function balanceOf(chain: EvmChainKind, token: Address, owner: Address): Promise<bigint> {
  return client(chain).readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

export interface HoldingRead {
  raw: bigint;
  symbol: string;
  name: string;
  decimals: number;
}

/** Balances + names for many tokens of one owner in one multicall. Only
 *  tokens with a positive balance are returned. */
export async function holdingsOf(chain: EvmChainKind, owner: Address, tokens: Address[]): Promise<Map<string, HoldingRead>> {
  const out = new Map<string, HoldingRead>();
  if (!tokens.length) return out;
  const res = await client(chain).multicall({
    allowFailure: true,
    batchSize: MULTICALL_BYTES,
    contracts: tokens.flatMap((t) => [
      { address: t, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [owner] as const },
      { address: t, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address: t, abi: ERC20_ABI, functionName: 'name' as const },
      { address: t, abi: ERC20_ABI, functionName: 'decimals' as const },
    ]),
  });
  tokens.forEach((t, i) => {
    const bal = res[i * 4];
    if (bal.status !== 'success') return;
    const raw = bal.result as bigint;
    if (raw <= 0n) return;
    out.set(t.toLowerCase(), {
      raw,
      symbol: res[i * 4 + 1].status === 'success' ? String(res[i * 4 + 1].result) : '',
      name: res[i * 4 + 2].status === 'success' ? String(res[i * 4 + 2].result) : '',
      decimals: res[i * 4 + 3].status === 'success' ? Number(res[i * 4 + 3].result) : 18,
    });
  });
  return out;
}
