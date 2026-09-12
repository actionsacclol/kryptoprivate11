// Uniswap-family pools on the EVM chains — quotes and Universal Router
// calldata. Robinhood Chain runs Uniswap v3 + v4 (with the Pons hook);
// BNB Smart Chain runs PancakeSwap v2 + v3 behind PancakeSwap's Universal
// Router 2, which speaks the same command bytes for everything used here.
//
// Krypt's fee rides INSIDE the router call, so it inherits the simulation
// and the signer's policy and can never be a second transaction:
//   • buys: `TRANSFER(native, treasury, fee)` before the swap, with
//     msg.value = amountIn + fee (simulated OK, 2026-09-08);
//   • v4 sells: `TAKE_PORTION(ETH, treasury, bips)` on the output delta;
//   • v2/v3 sells: `UNWRAP_WETH(ADDRESS_THIS)` → `PAY_PORTION(native,
//     treasury, bips)` → `SWEEP(native, MSG_SENDER, minOut)`.
//
// Selling needs the token to reach the router through the chain's Permit2:
// a one-time `token.approve(Permit2)` and a `Permit2.approve(token, router,
// …)` per token — PancakeSwap has its OWN Permit2 on BNB. Deadlines are
// timestamps.

import { encodeAbiParameters, encodeFunctionData, encodePacked, type Address, type Hex } from 'viem';
import { ADDR, ERC20_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, UR_ADDR, UR_COMMAND, V3_FACTORY_ABI, V3_QUOTER_ABI, V4_ACTION, V4_QUOTER_ABI } from './chain';
import { ADDR_BSC, PANCAKE_V2_FACTORY_ABI, PANCAKE_V2_ROUTER_ABI } from './bsc';
import { CHAINS } from './chains';
import { client } from './client';
import { shortError } from './pons';
import type { EvmChainKind, EvmPoolKey } from '@shared/evm';

export interface FeePlan {
  /** Total Krypt fee on this trade, wei. 0 disables every fee leg. */
  totalWei: bigint;
  treasury: Address | null;
  treasuryWei: bigint;
  referrer: Address | null;
  referrerWei: bigint;
}

export const NO_FEE: FeePlan = { totalWei: 0n, treasury: null, treasuryWei: 0n, referrer: null, referrerWei: 0n };

export interface BuiltCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface SellFeeBips {
  treasury: Address | null;
  treasuryBips: bigint;
  referrer: Address | null;
  referrerBips: bigint;
}

const DEADLINE_S = 300;
export const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_S);

const enc = (types: string[], values: unknown[]): Hex => encodeAbiParameters(types.map((t) => ({ type: t })), values as never);

/**
 * Basis points of a sell's OUTPUT that go to the treasury and the referrer.
 * The router applies them to the real fill, so the fee is exact even when
 * the fill differs from the quote. 50 bps total; the referrer's 20 % share
 * comes out of the treasury's side.
 */
export function sellFeeBips(feeBps: number, referralShareBps: number, hasReferrer: boolean, enabled: boolean): { treasuryBips: bigint; referrerBips: bigint } {
  if (!enabled || feeBps <= 0) return { treasuryBips: 0n, referrerBips: 0n };
  const total = BigInt(feeBps);
  const referrer = hasReferrer ? (total * BigInt(referralShareBps)) / 10_000n : 0n;
  return { treasuryBips: total - referrer, referrerBips: referrer };
}

function feeTransfers(fee: FeePlan): { commands: number[]; inputs: Hex[]; value: bigint } {
  const commands: number[] = [];
  const inputs: Hex[] = [];
  let value = 0n;
  if (fee.treasury && fee.treasuryWei > 0n) {
    commands.push(UR_COMMAND.TRANSFER);
    inputs.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, fee.treasury, fee.treasuryWei]));
    value += fee.treasuryWei;
  }
  if (fee.referrer && fee.referrerWei > 0n) {
    commands.push(UR_COMMAND.TRANSFER);
    inputs.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, fee.referrer, fee.referrerWei]));
    value += fee.referrerWei;
  }
  return { commands, inputs, value };
}

function execute(router: Address, commands: number[], inputs: Hex[], value: bigint): BuiltCall {
  const cmdBytes = encodePacked(commands.map(() => 'uint8'), commands) as Hex;
  return {
    to: router,
    data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [cmdBytes, inputs, deadline()] }),
    value,
  };
}

/** The sell-side fee commands on native held by the router, then the sweep. */
function payPortionsAndSweep(fee: SellFeeBips, minOutAfterFee: bigint): { commands: number[]; inputs: Hex[] } {
  const commands: number[] = [];
  const inputs: Hex[] = [];
  if (fee.treasury && fee.treasuryBips > 0n) {
    commands.push(UR_COMMAND.PAY_PORTION);
    inputs.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, fee.treasury, fee.treasuryBips]));
  }
  if (fee.referrer && fee.referrerBips > 0n) {
    commands.push(UR_COMMAND.PAY_PORTION);
    inputs.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, fee.referrer, fee.referrerBips]));
  }
  commands.push(UR_COMMAND.SWEEP);
  inputs.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, UR_ADDR.MSG_SENDER, minOutAfterFee]));
  return { commands, inputs };
}

// ── v4 (Robinhood only) ───────────────────────────────────────────────

export async function quoteV4(key: EvmPoolKey, zeroForOne: boolean, amountIn: bigint): Promise<{ amountOut: bigint; gas: bigint } | { error: string }> {
  try {
    const r = await client('robinhood').simulateContract({
      address: ADDR.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: { currency0: key.currency0 as Address, currency1: key.currency1 as Address, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks as Address },
          zeroForOne,
          exactAmount: amountIn,
          hookData: '0x',
        },
      ],
    });
    const [amountOut, gas] = r.result;
    return { amountOut, gas };
  } catch (e) {
    return { error: shortError(e) };
  }
}

const POOL_KEY_T = {
  type: 'tuple',
  components: [
    { type: 'address', name: 'currency0' },
    { type: 'address', name: 'currency1' },
    { type: 'uint24', name: 'fee' },
    { type: 'int24', name: 'tickSpacing' },
    { type: 'address', name: 'hooks' },
  ],
} as const;

/** ExactInputSingleParams, with the Robinhood router's extra
 *  `minHopPriceX36` word (always 0 — the swap's own minOut bounds it). */
function encodeV4SwapParams(key: EvmPoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { ...POOL_KEY_T, name: 'poolKey' },
          { type: 'bool', name: 'zeroForOne' },
          { type: 'uint128', name: 'amountIn' },
          { type: 'uint128', name: 'amountOutMinimum' },
          { type: 'uint256', name: 'minHopPriceX36' },
          { type: 'bytes', name: 'hookData' },
        ],
      },
    ],
    [
      {
        poolKey: { currency0: key.currency0 as Address, currency1: key.currency1 as Address, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks as Address },
        zeroForOne,
        amountIn,
        amountOutMinimum: minOut,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
    ],
  );
}

/** ETH → token on a v4 pool. `minOut` in raw token units. */
export function buildV4Buy(key: EvmPoolKey, token: Address, amountIn: bigint, minOut: bigint, fee: FeePlan): BuiltCall {
  const zeroForOne = key.currency0.toLowerCase() !== token.toLowerCase(); // ETH (currency0) → token
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
  const params: Hex[] = [encodeV4SwapParams(key, zeroForOne, amountIn, minOut), enc(['address', 'uint256'], [UR_ADDR.ETH, amountIn]), enc(['address', 'uint256'], [token, minOut])];
  const v4 = enc(['bytes', 'bytes[]'], [actions, params]);
  const fees = feeTransfers(fee);
  return execute(ADDR.universalRouter, [...fees.commands, UR_COMMAND.V4_SWAP], [...fees.inputs, v4], amountIn + fees.value);
}

/** Token → ETH on a v4 pool; fee portions taken on the output before `minOutAfterFee`. */
export function buildV4Sell(key: EvmPoolKey, token: Address, amountIn: bigint, minOutAfterFee: bigint, fee: SellFeeBips): BuiltCall {
  const zeroForOne = key.currency0.toLowerCase() === token.toLowerCase(); // token → ETH
  const actionList: number[] = [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL];
  const params: Hex[] = [encodeV4SwapParams(key, zeroForOne, amountIn, 0n), enc(['address', 'uint256'], [token, amountIn])];
  if (fee.treasury && fee.treasuryBips > 0n) {
    actionList.push(V4_ACTION.TAKE_PORTION);
    params.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, fee.treasury, fee.treasuryBips]));
  }
  if (fee.referrer && fee.referrerBips > 0n) {
    actionList.push(V4_ACTION.TAKE_PORTION);
    params.push(enc(['address', 'address', 'uint256'], [UR_ADDR.ETH, fee.referrer, fee.referrerBips]));
  }
  actionList.push(V4_ACTION.TAKE_ALL);
  params.push(enc(['address', 'uint256'], [UR_ADDR.ETH, minOutAfterFee]));
  const actions = encodePacked(actionList.map(() => 'uint8'), actionList) as Hex;
  const v4 = enc(['bytes', 'bytes[]'], [actions, params]);
  return execute(ADDR.universalRouter, [UR_COMMAND.V4_SWAP], [v4], 0n);
}

// ── v3 (both chains) ──────────────────────────────────────────────────

export interface V3Route {
  feeTier: number;
  pool: Address;
  amountOut: bigint;
  gas: bigint;
}

/** Best v3 tier for token↔wrapped-native by quoting every tier. */
export async function bestV3Route(chain: EvmChainKind, token: Address, side: 'buy' | 'sell', amountIn: bigint): Promise<V3Route | null> {
  const cfg = CHAINS[chain];
  const c = client(chain);
  const pools = await c.multicall({
    allowFailure: true,
    contracts: cfg.v3FeeTiers.map((fee) => ({ address: cfg.addr.v3Factory, abi: V3_FACTORY_ABI, functionName: 'getPool' as const, args: [token, cfg.addr.wrapped, fee] as const })),
  });
  const candidates: Array<{ fee: number; pool: Address }> = [];
  cfg.v3FeeTiers.forEach((fee, i) => {
    const pool = pools[i].status === 'success' ? (pools[i].result as Address) : null;
    if (pool && pool !== '0x0000000000000000000000000000000000000000') candidates.push({ fee, pool });
  });
  if (!candidates.length) return null;
  const [tokenIn, tokenOut] = side === 'buy' ? [cfg.addr.wrapped, token] : [token, cfg.addr.wrapped];
  const quotes = await Promise.all(
    candidates.map(async (cand) => {
      try {
        const r = await c.simulateContract({
          address: cfg.addr.v3QuoterV2,
          abi: V3_QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut, amountIn, fee: cand.fee, sqrtPriceLimitX96: 0n }],
        });
        const [amountOut, , , gas] = r.result;
        return { feeTier: cand.fee, pool: cand.pool, amountOut, gas } as V3Route;
      } catch {
        return null;
      }
    }),
  );
  const ok = quotes.filter((q): q is V3Route => q !== null && q.amountOut > 0n);
  if (!ok.length) return null;
  ok.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return ok[0];
}

const v3Path = (tokenIn: Address, fee: number, tokenOut: Address): Hex => encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);

/**
 * The V3_SWAP_EXACT_IN input. Robinhood's Universal Router is a modified
 * build (see chain.ts: its v4 exact-in params carry an extra
 * `minHopPriceX36` word) and its v3 decoder reads a SIXTH field after the
 * stock five: a `uint256[]` of per-hop minimum prices. The stock 5-field
 * input reverts `SliceOutOfBounds()` there; an EMPTY array means "no
 * hop-price floor" and the swap succeeds (both verified on chain
 * 2026-09-09 — one entry per hop is also accepted, two for a single hop
 * reverts). PancakeSwap's UR2 on BNB is stock and takes five.
 */
function v3SwapInput(chain: EvmChainKind, recipient: Address, amountIn: bigint, minOut: bigint, path: Hex, payerIsUser: boolean): Hex {
  return chain === 'robinhood'
    ? enc(['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'], [recipient, amountIn, minOut, path, payerIsUser, []])
    : enc(['address', 'uint256', 'uint256', 'bytes', 'bool'], [recipient, amountIn, minOut, path, payerIsUser]);
}

/** Native → token through a v3 pool: wrap in the router, swap, pay the fee. */
export function buildV3Buy(chain: EvmChainKind, token: Address, feeTier: number, amountIn: bigint, minOut: bigint, fee: FeePlan): BuiltCall {
  const cfg = CHAINS[chain];
  const fees = feeTransfers(fee);
  const commands = [...fees.commands, UR_COMMAND.WRAP_ETH, UR_COMMAND.V3_SWAP_EXACT_IN];
  const inputs: Hex[] = [
    ...fees.inputs,
    enc(['address', 'uint256'], [UR_ADDR.ADDRESS_THIS, amountIn]),
    v3SwapInput(chain, UR_ADDR.MSG_SENDER, amountIn, minOut, v3Path(cfg.addr.wrapped, feeTier, token), false),
  ];
  return execute(cfg.addr.universalRouter, commands, inputs, amountIn + fees.value);
}

/** Token → native through a v3 pool: swap to the router, unwrap, pay the fee
 *  portion, sweep the rest to the seller with `minOutAfterFee` enforced. */
export function buildV3Sell(chain: EvmChainKind, token: Address, feeTier: number, amountIn: bigint, minOutAfterFee: bigint, fee: SellFeeBips): BuiltCall {
  const cfg = CHAINS[chain];
  const commands: number[] = [UR_COMMAND.V3_SWAP_EXACT_IN, UR_COMMAND.UNWRAP_WETH];
  const inputs: Hex[] = [
    v3SwapInput(chain, UR_ADDR.ADDRESS_THIS, amountIn, 0n, v3Path(token, feeTier, cfg.addr.wrapped), true),
    enc(['address', 'uint256'], [UR_ADDR.ADDRESS_THIS, 0n]),
  ];
  const tail = payPortionsAndSweep(fee, minOutAfterFee);
  return execute(cfg.addr.universalRouter, [...commands, ...tail.commands], [...inputs, ...tail.inputs], 0n);
}

// ── v2 (BNB: PancakeSwap v2, where four.meme graduates) ───────────────

/** The v2 pair for token/WBNB, or null. */
export async function v2Pair(token: Address): Promise<Address | null> {
  try {
    const p = await client('bnb').readContract({ address: ADDR_BSC.v2Factory, abi: PANCAKE_V2_FACTORY_ABI, functionName: 'getPair', args: [token, ADDR_BSC.wbnb] });
    return p && p !== '0x0000000000000000000000000000000000000000' ? (p.toLowerCase() as Address) : null;
  } catch {
    return null;
  }
}

export async function quoteV2(token: Address, side: 'buy' | 'sell', amountIn: bigint): Promise<{ amountOut: bigint } | { error: string }> {
  const path = side === 'buy' ? [ADDR_BSC.wbnb, token] : [token, ADDR_BSC.wbnb];
  try {
    const amounts = await client('bnb').readContract({ address: ADDR_BSC.v2Router, abi: PANCAKE_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path] });
    return { amountOut: amounts[amounts.length - 1] };
  } catch (e) {
    return { error: shortError(e) };
  }
}

/** BNB → token through the v2 pair: wrap in the router, swap, pay the fee. */
export function buildV2Buy(token: Address, amountIn: bigint, minOut: bigint, fee: FeePlan): BuiltCall {
  const fees = feeTransfers(fee);
  const commands = [...fees.commands, UR_COMMAND.WRAP_ETH, UR_COMMAND.V2_SWAP_EXACT_IN];
  const inputs: Hex[] = [
    ...fees.inputs,
    enc(['address', 'uint256'], [UR_ADDR.ADDRESS_THIS, amountIn]),
    enc(['address', 'uint256', 'uint256', 'address[]', 'bool'], [UR_ADDR.MSG_SENDER, amountIn, minOut, [ADDR_BSC.wbnb, token], false]),
  ];
  return execute(ADDR_BSC.universalRouter, commands, inputs, amountIn + fees.value);
}

/** Token → BNB through the v2 pair; the fee portion on the output. */
export function buildV2Sell(token: Address, amountIn: bigint, minOutAfterFee: bigint, fee: SellFeeBips): BuiltCall {
  const commands: number[] = [UR_COMMAND.V2_SWAP_EXACT_IN, UR_COMMAND.UNWRAP_WETH];
  const inputs: Hex[] = [
    enc(['address', 'uint256', 'uint256', 'address[]', 'bool'], [UR_ADDR.ADDRESS_THIS, amountIn, 0n, [token, ADDR_BSC.wbnb], true]),
    enc(['address', 'uint256'], [UR_ADDR.ADDRESS_THIS, 0n]),
  ];
  const tail = payPortionsAndSweep(fee, minOutAfterFee);
  return execute(ADDR_BSC.universalRouter, [...commands, ...tail.commands], [...inputs, ...tail.inputs], 0n);
}

// ── Approvals (sells through a router) ────────────────────────────────

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
const PERMIT2_EXPIRY_S = 30 * 24 * 3600;

export interface ApprovalNeeds {
  tokenToPermit2: boolean;
  permit2ToRouter: boolean;
}

/** What a router sell of `amount` raw units still needs approved. */
export async function approvalsNeeded(chain: EvmChainKind, owner: Address, token: Address, amount: bigint): Promise<ApprovalNeeds> {
  const cfg = CHAINS[chain];
  const res = await client(chain).multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi: ERC20_ABI, functionName: 'allowance' as const, args: [owner, cfg.addr.permit2] as const },
      { address: cfg.addr.permit2, abi: PERMIT2_ABI, functionName: 'allowance' as const, args: [owner, token, cfg.addr.universalRouter] as const },
    ],
  });
  const erc = res[0].status === 'success' ? (res[0].result as bigint) : 0n;
  const p2 = res[1].status === 'success' ? (res[1].result as readonly [bigint, number, number]) : ([0n, 0, 0] as const);
  const now = Math.floor(Date.now() / 1000);
  return { tokenToPermit2: erc < amount, permit2ToRouter: p2[0] < amount || Number(p2[1]) <= now + 60 };
}

/** ERC-20 allowance of `spender` on `token` for `owner`. */
export async function allowance(chain: EvmChainKind, owner: Address, token: Address, spender: Address): Promise<bigint> {
  try {
    return await client(chain).readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
  } catch {
    return 0n;
  }
}

export function buildApproveToken(chain: EvmChainKind, token: Address, spender: Address = CHAINS[chain].addr.permit2): BuiltCall {
  return { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] }), value: 0n };
}

export function buildPermit2Approve(chain: EvmChainKind, token: Address): BuiltCall {
  const cfg = CHAINS[chain];
  const expiry = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRY_S;
  return {
    to: cfg.addr.permit2,
    data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [token, cfg.addr.universalRouter, MAX_UINT160, expiry] }),
    value: 0n,
  };
}
