// electron/evm/uniswap.ts — Universal Router calldata, decoded back, for
// both EVM chains.
//
// The builders are pure (viem encoders over fixed constants), so their
// output is pinned by DECODING it with the same ABIs: commands, action
// lists, the v4 swap params (with the Robinhood router's extra
// minHopPriceX36 word), fee legs, the packed v3 path, the PancakeSwap v2
// path array, and the approval shapes per chain. The deadline embeds
// Date.now, so whole-hex comparison is avoided.

import assert from 'node:assert';
import { decodeAbiParameters, decodeFunctionData } from 'viem';
import {
  sellFeeBips,
  buildV4Buy,
  buildV4Sell,
  buildV3Buy,
  buildV3Sell,
  buildV2Buy,
  buildV2Sell,
  buildApproveToken,
  buildPermit2Approve,
  NO_FEE,
  MAX_UINT160,
  MAX_UINT256,
  deadline,
} from './.evmuniswap.mjs';
import { ADDR, UNIVERSAL_ROUTER_ABI, ERC20_ABI, PERMIT2_ABI, UR_COMMAND, V4_ACTION, UR_ADDR } from './.evmchain.mjs';
import { ADDR_BSC } from './.evmbsc.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const lower = (s) => String(s).toLowerCase();
const TOKEN = '0xc7410e5136ac803e167782316c4a939a4f5097d5';
const KEY = { currency0: '0x0000000000000000000000000000000000000000', currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' };
const TREASURY = '0x2222222222222222222222222222222222222222';
const REFERRER = '0x3333333333333333333333333333333333333333';
const AMOUNT = 10n ** 15n;
const FEE_WEI = 5n * 10n ** 12n;
const NO_BIPS = { treasury: null, treasuryBips: 0n, referrer: null, referrerBips: 0n };
const BOTH_BIPS = { treasury: TREASURY, treasuryBips: 40n, referrer: REFERRER, referrerBips: 10n };

/** execute(bytes commands, bytes[] inputs, uint256 deadline) → parts. */
function decodeExecute(call) {
  const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: call.data });
  assert.equal(d.functionName, 'execute');
  const [commands, inputs, dl] = d.args;
  const bytes = [];
  for (let i = 2; i < commands.length; i += 2) bytes.push(parseInt(commands.slice(i, i + 2), 16));
  return { commands: bytes, inputs, deadline: dl };
}

const V4_PARAMS_T = [
  {
    type: 'tuple',
    components: [
      { type: 'tuple', name: 'poolKey', components: [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] },
      { type: 'bool', name: 'zeroForOne' },
      { type: 'uint128', name: 'amountIn' },
      { type: 'uint128', name: 'amountOutMinimum' },
      { type: 'uint256', name: 'minHopPriceX36' },
      { type: 'bytes', name: 'hookData' },
    ],
  },
];
// Stock Universal Router V3_SWAP_EXACT_IN input (PancakeSwap's UR2 on BNB).
const V3_SWAP_T = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }];
// Robinhood's modified router reads a SIXTH field: a `uint256[]` of per-hop
// minimum prices, sent EMPTY. The five-field input reverts
// SliceOutOfBounds() there (both verified on chain, 2026-09-09).
const V3_SWAP_RH_T = [...V3_SWAP_T, { type: 'uint256[]' }];
const V2_SWAP_T = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }];
const ADDR_UINT_T = [{ type: 'address' }, { type: 'uint256' }];
const ADDR_ADDR_UINT_T = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }];

function decodeV4Input(input) {
  const [actionsHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], input);
  const actions = [];
  for (let i = 2; i < actionsHex.length; i += 2) actions.push(parseInt(actionsHex.slice(i, i + 2), 16));
  return { actions, params };
}

// ── fee bips ──────────────────────────────────────────────────────────

ok('sellFeeBips: 50 bps with a 20 % referral share is 40 + 10; no referrer is 50 + 0; disabled is 0', () => {
  assert.deepEqual(sellFeeBips(50, 2000, true, true), { treasuryBips: 40n, referrerBips: 10n });
  assert.deepEqual(sellFeeBips(50, 2000, false, true), { treasuryBips: 50n, referrerBips: 0n });
  assert.deepEqual(sellFeeBips(50, 2000, true, false), { treasuryBips: 0n, referrerBips: 0n });
  assert.deepEqual(sellFeeBips(0, 2000, true, true), { treasuryBips: 0n, referrerBips: 0n });
});

ok('deadline is a unix timestamp about five minutes out', () => {
  const now = Math.floor(Date.now() / 1000);
  const d = Number(deadline());
  assert.ok(d >= now + 295 && d <= now + 305, `deadline ${d} vs now ${now}`);
});

// ── v4 buy (Robinhood) ────────────────────────────────────────────────

ok('buildV4Buy without a fee: one V4_SWAP command, actions 06 0c 0f, params decode with minHopPriceX36 = 0', () => {
  const call = buildV4Buy(KEY, TOKEN, AMOUNT, 0n, NO_FEE);
  assert.equal(lower(call.to), lower(ADDR.universalRouter));
  assert.equal(call.value, AMOUNT);
  assert.equal(call.data.slice(0, 10), '0x3593564c');
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.V4_SWAP]);
  assert.equal(ex.inputs.length, 1);
  const v4 = decodeV4Input(ex.inputs[0]);
  assert.deepEqual(v4.actions, [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
  assert.equal(v4.params.length, 3);
  const [swap] = decodeAbiParameters(V4_PARAMS_T, v4.params[0]);
  assert.equal(lower(swap.poolKey.currency0), KEY.currency0);
  assert.equal(lower(swap.poolKey.currency1), lower(KEY.currency1));
  assert.equal(swap.poolKey.fee, 0);
  assert.equal(swap.poolKey.tickSpacing, 200);
  assert.equal(lower(swap.poolKey.hooks), lower(KEY.hooks));
  assert.equal(swap.zeroForOne, true, 'ETH is currency0, so a buy is zeroForOne');
  assert.equal(swap.amountIn, AMOUNT);
  assert.equal(swap.amountOutMinimum, 0n);
  assert.equal(swap.minHopPriceX36, 0n);
  assert.equal(swap.hookData, '0x');
  const [settleCur, settleAmt] = decodeAbiParameters(ADDR_UINT_T, v4.params[1]);
  assert.equal(lower(settleCur), lower(UR_ADDR.ETH));
  assert.equal(settleAmt, AMOUNT);
  const [takeCur, takeMin] = decodeAbiParameters(ADDR_UINT_T, v4.params[2]);
  assert.equal(lower(takeCur), lower(TOKEN));
  assert.equal(takeMin, 0n);
});

ok('buildV4Buy carries minOut into both the swap params and TAKE_ALL', () => {
  const call = buildV4Buy(KEY, TOKEN, AMOUNT, 12_345n, NO_FEE);
  const v4 = decodeV4Input(decodeExecute(call).inputs[0]);
  const [swap] = decodeAbiParameters(V4_PARAMS_T, v4.params[0]);
  assert.equal(swap.amountOutMinimum, 12_345n);
  const [, takeMin] = decodeAbiParameters(ADDR_UINT_T, v4.params[2]);
  assert.equal(takeMin, 12_345n);
});

ok('buildV4Buy with a treasury fee: commands 05 10, two inputs, value = amount + fee, TRANSFER decodes to (ETH, treasury, fee)', () => {
  const fee = { totalWei: FEE_WEI, treasury: TREASURY, treasuryWei: FEE_WEI, referrer: null, referrerWei: 0n };
  const call = buildV4Buy(KEY, TOKEN, AMOUNT, 0n, fee);
  assert.equal(call.value, AMOUNT + FEE_WEI);
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.TRANSFER, UR_COMMAND.V4_SWAP]);
  assert.equal(ex.inputs.length, 2);
  const [cur, to, amt] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[0]);
  assert.equal(lower(cur), lower(UR_ADDR.ETH));
  assert.equal(lower(to), lower(TREASURY));
  assert.equal(amt, FEE_WEI);
  const v4 = decodeV4Input(ex.inputs[1]);
  const [swap] = decodeAbiParameters(V4_PARAMS_T, v4.params[0]);
  assert.equal(swap.amountIn, AMOUNT);
});

ok('buildV4Buy with treasury + referrer: two TRANSFERs then the swap, value covers both legs', () => {
  const fee = { totalWei: FEE_WEI, treasury: TREASURY, treasuryWei: 4n * 10n ** 12n, referrer: REFERRER, referrerWei: 10n ** 12n };
  const call = buildV4Buy(KEY, TOKEN, AMOUNT, 0n, fee);
  assert.equal(call.value, AMOUNT + FEE_WEI);
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.TRANSFER, UR_COMMAND.TRANSFER, UR_COMMAND.V4_SWAP]);
  const [, to2, amt2] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[1]);
  assert.equal(lower(to2), lower(REFERRER));
  assert.equal(amt2, 10n ** 12n);
});

ok('a fee plan with a positive total but no recipients adds no legs (nothing is sent nowhere)', () => {
  const fee = { totalWei: FEE_WEI, treasury: null, treasuryWei: FEE_WEI, referrer: null, referrerWei: 0n };
  const call = buildV4Buy(KEY, TOKEN, AMOUNT, 0n, fee);
  assert.equal(call.value, AMOUNT);
  assert.deepEqual(decodeExecute(call).commands, [UR_COMMAND.V4_SWAP]);
});

// ── v4 sell (Robinhood) ───────────────────────────────────────────────

ok('buildV4Sell with treasury 40 / referrer 10 bips: actions 06 0c 10 10 0f, value 0, portions decode', () => {
  const call = buildV4Sell(KEY, TOKEN, 10n ** 20n, 999n, BOTH_BIPS);
  assert.equal(call.value, 0n);
  assert.equal(lower(call.to), lower(ADDR.universalRouter));
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.V4_SWAP]);
  const v4 = decodeV4Input(ex.inputs[0]);
  assert.deepEqual(v4.actions, [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_PORTION, V4_ACTION.TAKE_PORTION, V4_ACTION.TAKE_ALL]);
  const [swap] = decodeAbiParameters(V4_PARAMS_T, v4.params[0]);
  assert.equal(swap.zeroForOne, false, 'token is currency1, so a sell is oneForZero');
  assert.equal(swap.amountIn, 10n ** 20n);
  assert.equal(swap.amountOutMinimum, 0n, 'the swap min is left open; TAKE_ALL enforces it after the fee');
  const [settleCur, settleAmt] = decodeAbiParameters(ADDR_UINT_T, v4.params[1]);
  assert.equal(lower(settleCur), lower(TOKEN));
  assert.equal(settleAmt, 10n ** 20n);
  const [c1, r1, b1] = decodeAbiParameters(ADDR_ADDR_UINT_T, v4.params[2]);
  assert.equal(lower(c1), lower(UR_ADDR.ETH));
  assert.equal(lower(r1), lower(TREASURY));
  assert.equal(b1, 40n);
  const [, r2, b2] = decodeAbiParameters(ADDR_ADDR_UINT_T, v4.params[3]);
  assert.equal(lower(r2), lower(REFERRER));
  assert.equal(b2, 10n);
  const [takeCur, takeMin] = decodeAbiParameters(ADDR_UINT_T, v4.params[4]);
  assert.equal(lower(takeCur), lower(UR_ADDR.ETH));
  assert.equal(takeMin, 999n);
});

ok('buildV4Sell with no fee recipients: actions 06 0c 0f only', () => {
  const call = buildV4Sell(KEY, TOKEN, 10n ** 20n, 1n, NO_BIPS);
  const v4 = decodeV4Input(decodeExecute(call).inputs[0]);
  assert.deepEqual(v4.actions, [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
});

ok('buildV4Sell with a treasury but zero bips adds no portion leg', () => {
  const call = buildV4Sell(KEY, TOKEN, 10n ** 20n, 1n, { treasury: TREASURY, treasuryBips: 0n, referrer: null, referrerBips: 0n });
  const v4 = decodeV4Input(decodeExecute(call).inputs[0]);
  assert.deepEqual(v4.actions, [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL]);
});

ok('v4 direction follows currency ordering when the token sorts BELOW the pair', () => {
  const low = '0x0000000000000000000000000000000000000abc';
  const key = { currency0: low, currency1: ADDR.weth, fee: 0, tickSpacing: 200, hooks: KEY.hooks };
  const buy = decodeAbiParameters(V4_PARAMS_T, decodeV4Input(decodeExecute(buildV4Buy(key, low, AMOUNT, 0n, NO_FEE)).inputs[0]).params[0])[0];
  assert.equal(buy.zeroForOne, false, 'pair (currency1) → token (currency0)');
  const sell = decodeAbiParameters(V4_PARAMS_T, decodeV4Input(decodeExecute(buildV4Sell(key, low, 1n, 0n, NO_BIPS)).inputs[0]).params[0])[0];
  assert.equal(sell.zeroForOne, true, 'token (currency0) → pair (currency1)');
});

// ── v3 (both chains; router, Permit2 and wrapped native per chain) ────

ok('buildV3Buy on Robinhood without a fee: WRAP_ETH then V3_SWAP_EXACT_IN, value = amount, path = WETH|fee|token', () => {
  const call = buildV3Buy('robinhood', TOKEN, 10_000, AMOUNT, 42n, NO_FEE);
  assert.equal(lower(call.to), lower(ADDR.universalRouter));
  assert.equal(call.value, AMOUNT);
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.WRAP_ETH, UR_COMMAND.V3_SWAP_EXACT_IN]);
  const [wrapTo, wrapAmt] = decodeAbiParameters(ADDR_UINT_T, ex.inputs[0]);
  assert.equal(lower(wrapTo), lower(UR_ADDR.ADDRESS_THIS));
  assert.equal(wrapAmt, AMOUNT);
  const [recipient, amountIn, minOut, path, payerIsUser, minHopPrices] = decodeAbiParameters(V3_SWAP_RH_T, ex.inputs[1]);
  assert.equal(lower(recipient), lower(UR_ADDR.MSG_SENDER));
  assert.equal(amountIn, AMOUNT);
  assert.equal(minOut, 42n);
  assert.equal(payerIsUser, false, 'the router pays from the WETH it just wrapped');
  assert.deepEqual([...minHopPrices], [], 'Robinhood router: sixth field is an EMPTY uint256[] — no hop-price floor');
  assert.equal(path.length, 2 + 2 * (20 + 3 + 20), 'packed 43-byte path');
  assert.equal(lower(path.slice(2, 42)), lower(ADDR.weth.slice(2)));
  assert.equal(parseInt(path.slice(42, 48), 16), 10_000);
  assert.equal(lower(path.slice(48)), lower(TOKEN.slice(2)));
});

ok('buildV3Buy on BNB targets PancakeSwap’s Universal Router 2 and wraps into WBNB', () => {
  const call = buildV3Buy('bnb', TOKEN, 2_500, AMOUNT, 42n, NO_FEE);
  assert.equal(lower(call.to), lower(ADDR_BSC.universalRouter));
  assert.notEqual(lower(call.to), lower(ADDR.universalRouter));
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.WRAP_ETH, UR_COMMAND.V3_SWAP_EXACT_IN]);
  const [, , , path] = decodeAbiParameters(V3_SWAP_T, ex.inputs[1]);
  assert.equal(ex.inputs[1].length, 2 + 64 * 8, 'stock five-field input on BNB (no minHopPriceX36 word)');
  assert.equal(lower(path.slice(2, 42)), lower(ADDR_BSC.wbnb.slice(2)));
  assert.equal(parseInt(path.slice(42, 48), 16), 2_500);
  assert.equal(lower(path.slice(48)), lower(TOKEN.slice(2)));
});

ok('buildV3Buy with a fee: TRANSFER first, value = amount + fee', () => {
  const fee = { totalWei: FEE_WEI, treasury: TREASURY, treasuryWei: FEE_WEI, referrer: null, referrerWei: 0n };
  const call = buildV3Buy('robinhood', TOKEN, 3_000, AMOUNT, 0n, fee);
  assert.equal(call.value, AMOUNT + FEE_WEI);
  assert.deepEqual(decodeExecute(call).commands, [UR_COMMAND.TRANSFER, UR_COMMAND.WRAP_ETH, UR_COMMAND.V3_SWAP_EXACT_IN]);
});

ok('buildV3Sell with both fee legs: swap → unwrap → pay portion ×2 → sweep, value 0, path = token|fee|WETH', () => {
  const call = buildV3Sell('robinhood', TOKEN, 10_000, 10n ** 20n, 777n, BOTH_BIPS);
  assert.equal(call.value, 0n);
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.V3_SWAP_EXACT_IN, UR_COMMAND.UNWRAP_WETH, UR_COMMAND.PAY_PORTION, UR_COMMAND.PAY_PORTION, UR_COMMAND.SWEEP]);
  const [recipient, amountIn, minOut, path, payerIsUser, minHopPrices] = decodeAbiParameters(V3_SWAP_RH_T, ex.inputs[0]);
  assert.equal(lower(recipient), lower(UR_ADDR.ADDRESS_THIS), 'WETH lands in the router to be unwrapped');
  assert.equal(amountIn, 10n ** 20n);
  assert.equal(minOut, 0n);
  assert.equal(payerIsUser, true, 'the seller pays through Permit2');
  assert.deepEqual([...minHopPrices], [], 'Robinhood router: sixth field is an EMPTY uint256[]');
  assert.equal(lower(path.slice(2, 42)), lower(TOKEN.slice(2)));
  assert.equal(parseInt(path.slice(42, 48), 16), 10_000);
  assert.equal(lower(path.slice(48)), lower(ADDR.weth.slice(2)));
  const [unwrapTo, unwrapMin] = decodeAbiParameters(ADDR_UINT_T, ex.inputs[1]);
  assert.equal(lower(unwrapTo), lower(UR_ADDR.ADDRESS_THIS));
  assert.equal(unwrapMin, 0n);
  const [pc1, pr1, pb1] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[2]);
  assert.equal(lower(pc1), lower(UR_ADDR.ETH));
  assert.equal(lower(pr1), lower(TREASURY));
  assert.equal(pb1, 40n);
  const [, pr2, pb2] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[3]);
  assert.equal(lower(pr2), lower(REFERRER));
  assert.equal(pb2, 10n);
  const [sc, sr, smin] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[4]);
  assert.equal(lower(sc), lower(UR_ADDR.ETH));
  assert.equal(lower(sr), lower(UR_ADDR.MSG_SENDER));
  assert.equal(smin, 777n);
});

ok('buildV3Sell on BNB: same shape, PancakeSwap router, path ends in WBNB', () => {
  const call = buildV3Sell('bnb', TOKEN, 2_500, 10n ** 20n, 1n, NO_BIPS);
  assert.equal(lower(call.to), lower(ADDR_BSC.universalRouter));
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.V3_SWAP_EXACT_IN, UR_COMMAND.UNWRAP_WETH, UR_COMMAND.SWEEP]);
  const [, , , path] = decodeAbiParameters(V3_SWAP_T, ex.inputs[0]);
  assert.equal(lower(path.slice(48)), lower(ADDR_BSC.wbnb.slice(2)));
});

// ── v2 (BNB: PancakeSwap v2, where four.meme graduates) ───────────────

ok('buildV2Buy without a fee: commands 0b 08, value = amount, WRAP_ETH to the router, V2 swap decodes to (MSG_SENDER, amountIn, minOut, [WBNB, token], false)', () => {
  const call = buildV2Buy(TOKEN, AMOUNT, 42n, NO_FEE);
  assert.equal(lower(call.to), lower(ADDR_BSC.universalRouter));
  assert.equal(call.value, AMOUNT);
  assert.equal(call.data.slice(0, 10), '0x3593564c');
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.WRAP_ETH, UR_COMMAND.V2_SWAP_EXACT_IN]);
  assert.deepEqual(ex.commands, [0x0b, 0x08]);
  const [wrapTo, wrapAmt] = decodeAbiParameters(ADDR_UINT_T, ex.inputs[0]);
  assert.equal(lower(wrapTo), lower(UR_ADDR.ADDRESS_THIS));
  assert.equal(wrapAmt, AMOUNT);
  const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(V2_SWAP_T, ex.inputs[1]);
  assert.equal(lower(recipient), lower(UR_ADDR.MSG_SENDER));
  assert.equal(amountIn, AMOUNT);
  assert.equal(minOut, 42n);
  assert.equal(path.length, 2);
  assert.equal(lower(path[0]), lower(ADDR_BSC.wbnb));
  assert.equal(lower(path[1]), lower(TOKEN));
  assert.equal(payerIsUser, false, 'the router pays from the WBNB it just wrapped');
});

ok('buildV2Buy with a fee: commands 05 0b 08, value = amount + fee, TRANSFER decodes to (native, treasury, fee)', () => {
  const fee = { totalWei: FEE_WEI, treasury: TREASURY, treasuryWei: FEE_WEI, referrer: null, referrerWei: 0n };
  const call = buildV2Buy(TOKEN, AMOUNT, 0n, fee);
  assert.equal(call.value, AMOUNT + FEE_WEI);
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [0x05, 0x0b, 0x08]);
  const [cur, to, amt] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[0]);
  assert.equal(lower(cur), lower(UR_ADDR.ETH));
  assert.equal(lower(to), lower(TREASURY));
  assert.equal(amt, FEE_WEI);
  const [, amountIn] = decodeAbiParameters(V2_SWAP_T, ex.inputs[2]);
  assert.equal(amountIn, AMOUNT, 'the swap itself is still sized at AMOUNT');
});

ok('buildV2Sell with both fee legs: 08 0c 06 06 04, value 0, swap to the router with payerIsUser, path [token, WBNB], portions 40/10, sweep minOut', () => {
  const call = buildV2Sell(TOKEN, 10n ** 20n, 777n, BOTH_BIPS);
  assert.equal(lower(call.to), lower(ADDR_BSC.universalRouter));
  assert.equal(call.value, 0n);
  const ex = decodeExecute(call);
  assert.deepEqual(ex.commands, [UR_COMMAND.V2_SWAP_EXACT_IN, UR_COMMAND.UNWRAP_WETH, UR_COMMAND.PAY_PORTION, UR_COMMAND.PAY_PORTION, UR_COMMAND.SWEEP]);
  assert.deepEqual(ex.commands, [0x08, 0x0c, 0x06, 0x06, 0x04]);
  const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(V2_SWAP_T, ex.inputs[0]);
  assert.equal(lower(recipient), lower(UR_ADDR.ADDRESS_THIS), 'WBNB lands in the router to be unwrapped');
  assert.equal(amountIn, 10n ** 20n);
  assert.equal(minOut, 0n, 'the swap min is left open; SWEEP enforces it after the fee');
  assert.deepEqual(path.map(lower), [lower(TOKEN), lower(ADDR_BSC.wbnb)]);
  assert.equal(payerIsUser, true, 'the seller pays through PancakeSwap’s Permit2');
  const [unwrapTo, unwrapMin] = decodeAbiParameters(ADDR_UINT_T, ex.inputs[1]);
  assert.equal(lower(unwrapTo), lower(UR_ADDR.ADDRESS_THIS));
  assert.equal(unwrapMin, 0n);
  const [pc1, pr1, pb1] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[2]);
  assert.equal(lower(pc1), lower(UR_ADDR.ETH));
  assert.equal(lower(pr1), lower(TREASURY));
  assert.equal(pb1, 40n);
  const [, pr2, pb2] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[3]);
  assert.equal(lower(pr2), lower(REFERRER));
  assert.equal(pb2, 10n);
  const [sc, sr, smin] = decodeAbiParameters(ADDR_ADDR_UINT_T, ex.inputs[4]);
  assert.equal(lower(sc), lower(UR_ADDR.ETH));
  assert.equal(lower(sr), lower(UR_ADDR.MSG_SENDER));
  assert.equal(smin, 777n);
});

ok('buildV2Sell with no fee: swap → unwrap → sweep', () => {
  const call = buildV2Sell(TOKEN, 1n, 1n, NO_BIPS);
  assert.deepEqual(decodeExecute(call).commands, [0x08, 0x0c, 0x04]);
});

// ── approvals, per chain ──────────────────────────────────────────────

ok('buildApproveToken: Robinhood names Uniswap’s canonical Permit2, BNB names PancakeSwap’s own', () => {
  const rh = buildApproveToken('robinhood', TOKEN);
  assert.equal(lower(rh.to), lower(TOKEN));
  assert.equal(rh.value, 0n);
  const d1 = decodeFunctionData({ abi: ERC20_ABI, data: rh.data });
  assert.equal(d1.functionName, 'approve');
  assert.equal(lower(d1.args[0]), lower('0x000000000022D473030F116dDEE9F6B43aC78BA3'));
  assert.equal(lower(d1.args[0]), lower(ADDR.permit2));
  assert.equal(d1.args[1], MAX_UINT256);
  assert.equal(MAX_UINT256, (1n << 256n) - 1n);
  const bnb = buildApproveToken('bnb', TOKEN);
  assert.equal(lower(bnb.to), lower(TOKEN));
  const d2 = decodeFunctionData({ abi: ERC20_ABI, data: bnb.data });
  assert.equal(lower(d2.args[0]), lower('0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768'));
  assert.equal(lower(d2.args[0]), lower(ADDR_BSC.permit2));
  assert.notEqual(lower(d1.args[0]), lower(d2.args[0]), 'the two chains use different Permit2 deployments');
});

ok('buildApproveToken with an explicit spender (four.meme’s manager) names that spender', () => {
  const call = buildApproveToken('bnb', TOKEN, ADDR_BSC.fourMemeManager);
  const d = decodeFunctionData({ abi: ERC20_ABI, data: call.data });
  assert.equal(lower(d.args[0]), lower(ADDR_BSC.fourMemeManager));
  assert.equal(d.args[1], MAX_UINT256);
});

ok('buildPermit2Approve targets the chain’s Permit2, spender the chain’s router, max uint160, expiry ~30 days out', () => {
  for (const [chain, permit2, router] of [
    ['robinhood', ADDR.permit2, ADDR.universalRouter],
    ['bnb', ADDR_BSC.permit2, ADDR_BSC.universalRouter],
  ]) {
    const call = buildPermit2Approve(chain, TOKEN);
    assert.equal(lower(call.to), lower(permit2), chain);
    assert.equal(call.value, 0n);
    const d = decodeFunctionData({ abi: PERMIT2_ABI, data: call.data });
    assert.equal(d.functionName, 'approve');
    assert.equal(lower(d.args[0]), lower(TOKEN));
    assert.equal(lower(d.args[1]), lower(router), chain);
    assert.equal(d.args[2], MAX_UINT160);
    const now = Math.floor(Date.now() / 1000);
    const expiry = Number(d.args[3]);
    assert.ok(expiry > now + 29 * 86_400 && expiry < now + 31 * 86_400, `${chain} expiry ${expiry}`);
  }
  assert.equal(MAX_UINT160, (1n << 160n) - 1n);
});

console.log(`\n${passed} evm uniswap cases passed`);
