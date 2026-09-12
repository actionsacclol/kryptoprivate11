// The buy-side fee interlock for Robinhood Chain (policy.requireFeeLeg).
//
// A router buy planned WITH a fee must carry a TRANSFER of native ETH to the
// treasury for at least the planned amount, or the signer refuses. Built from
// the same calldata shape uniswap.ts emits (viem's encoder, the real ABI), so
// a refusal here is one the signer would make on the real bytes. Sells never
// set the interlock; that is pinned too.

import assert from 'node:assert';
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';
import {
  checkEvmTx,
  decodeExecute,
  decodeTransferInput,
  carriesFeeLeg,
  carriesRouterFee,
  decodeRouterBuyFee,
  EXECUTE_SELECTOR,
  KRYPT_ROUTER_BUY_SELECTOR,
  UR_TRANSFER_COMMAND,
  DEFAULT_MAX_GAS,
  DEFAULT_MAX_FEE_PER_GAS,
} from './.evmpolicy.mjs';

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

const CHAIN = 4663;
const ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
const CURVE = '0xec8DAA33ec6eb33258af6f29d7590afe8e8b0f42';
const TREASURY = '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a';
const REFERRER = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x9999999999999999999999999999999999999999';
const ETH = '0x0000000000000000000000000000000000000000';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ME = '0x1111111111111111111111111111111111111111';

const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const curveAbi = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)']);

const AMOUNT = 10n ** 15n; // 0.001 ETH
const FEE = 5n * 10n ** 12n; // 0.5 %
const TREASURY_WEI = 4n * 10n ** 12n;
const REFERRER_WEI = 10n ** 12n;

const transfer = (token, to, wei) => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [token, to, wei]);
// A stand-in for the v4 swap input: any bytes, the interlock ignores them.
const swapInput = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', ['0x01', '0x02', '0x03']]);
const execute = (commands, inputs) => encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [commands, inputs, 1_800_000_000n] });

const withFee = execute('0x0510', [transfer(ETH, TREASURY, TREASURY_WEI), swapInput]);
const withFeeAndReferrer = execute('0x050510', [transfer(ETH, TREASURY, TREASURY_WEI), transfer(ETH, REFERRER, REFERRER_WEI), swapInput]);
const stripped = execute('0x10', [swapInput]);
const redirected = execute('0x0510', [transfer(ETH, STRANGER, TREASURY_WEI), swapInput]);
const shaved = execute('0x0510', [transfer(ETH, TREASURY, TREASURY_WEI - 1n), swapInput]);
const wrongToken = execute('0x0510', [transfer(WETH, TREASURY, TREASURY_WEI), swapInput]);
const allowRevertFlag = execute('0x8510', [transfer(ETH, TREASURY, TREASURY_WEI), swapInput]);
const splitAcrossTwo = execute('0x050510', [transfer(ETH, TREASURY, TREASURY_WEI / 2n), transfer(ETH, TREASURY, TREASURY_WEI / 2n), swapInput]);

const policy = (extra = {}) => ({
  chainId: CHAIN,
  intent: 'trade',
  allow: [{ to: ROUTER, selectors: [EXECUTE_SELECTOR], maxValueWei: AMOUNT + FEE }],
  maxGas: DEFAULT_MAX_GAS,
  maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS,
  approveSpenders: [],
  permit2Spenders: [],
  ...extra,
});
const interlocked = policy({ requireFeeLeg: { treasury: TREASURY, minWei: TREASURY_WEI } });
const tx = (data, value = AMOUNT + FEE, to = ROUTER) => ({ chainId: CHAIN, to, value, data, gas: 200_000n, maxFeePerGas: 500_000_000n });

// ── decoding ──────────────────────────────────────────────────────────

ok('decodeExecute reads commands and inputs back out of real calldata', () => {
  const d = decodeExecute(withFeeAndReferrer);
  assert.ok(d);
  assert.deepEqual(d.commands, [0x05, 0x05, 0x10]);
  assert.equal(d.inputs.length, 3);
  assert.equal(d.deadline, 1_800_000_000n);
  const t = decodeTransferInput(d.inputs[0]);
  assert.equal(t.token.toLowerCase(), ETH);
  assert.equal(t.recipient.toLowerCase(), TREASURY.toLowerCase());
  assert.equal(t.value, TREASURY_WEI);
});

ok('decodeExecute returns null for a curve buy, garbage and truncated bytes', () => {
  const buy = encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [AMOUNT, 0n, ME] });
  assert.equal(decodeExecute(buy), null);
  assert.equal(decodeExecute('0x'), null);
  assert.equal(decodeExecute('0x3593564c'), null);
  assert.equal(decodeExecute(withFee.slice(0, 200)), null);
});

ok('the TRANSFER command byte is 0x05 and the allow-revert flag bit is masked', () => {
  assert.equal(UR_TRANSFER_COMMAND, 0x05);
  assert.equal(carriesFeeLeg(allowRevertFlag, TREASURY, TREASURY_WEI), true);
});

// ── carriesFeeLeg ─────────────────────────────────────────────────────

ok('a buy that pays the treasury at least the planned fee carries the leg', () => {
  assert.equal(carriesFeeLeg(withFee, TREASURY, TREASURY_WEI), true);
  assert.equal(carriesFeeLeg(withFeeAndReferrer, TREASURY, TREASURY_WEI), true);
  assert.equal(carriesFeeLeg(withFee, TREASURY.toLowerCase(), TREASURY_WEI), true, 'case-insensitive treasury');
});

ok('two treasury transfers that add up to the fee still count', () => {
  assert.equal(carriesFeeLeg(splitAcrossTwo, TREASURY, TREASURY_WEI), true);
});

ok('stripped, redirected, shaved and wrong-token fee legs do not', () => {
  assert.equal(carriesFeeLeg(stripped, TREASURY, TREASURY_WEI), false, 'no TRANSFER at all');
  assert.equal(carriesFeeLeg(redirected, TREASURY, TREASURY_WEI), false, 'paid to a stranger');
  assert.equal(carriesFeeLeg(shaved, TREASURY, TREASURY_WEI), false, 'one wei short');
  assert.equal(carriesFeeLeg(wrongToken, TREASURY, TREASURY_WEI), false, 'WETH is not the native leg the router pays from msg.value');
  assert.equal(carriesFeeLeg(withFee, TREASURY, 0n), false, 'a zero minimum is never "carried" — the caller clears the interlock instead');
});

// ── the signer's verdicts ─────────────────────────────────────────────

ok('interlocked buy WITH the fee leg signs', () => {
  assert.equal(checkEvmTx(tx(withFee), interlocked).ok, true);
  assert.equal(checkEvmTx(tx(withFeeAndReferrer), interlocked).ok, true);
});

ok('interlocked buy with the fee stripped is refused, and says why', () => {
  const v = checkEvmTx(tx(stripped, AMOUNT), interlocked);
  assert.equal(v.ok, false);
  assert.match(v.message, /platform fee/);
});

ok('interlocked buy with the fee redirected or shaved is refused', () => {
  assert.equal(checkEvmTx(tx(redirected), interlocked).ok, false);
  assert.equal(checkEvmTx(tx(shaved), interlocked).ok, false);
});

ok('the interlock only ever applies to a router call — a curve buy under it is refused (curve buys never set it)', () => {
  const buy = encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [AMOUNT, 0n, ME] });
  const curvePolicy = policy({ allow: [{ to: CURVE, selectors: ['0x59a87bc1'], maxValueWei: AMOUNT }], requireFeeLeg: { treasury: TREASURY, minWei: TREASURY_WEI } });
  assert.equal(checkEvmTx(tx(buy, AMOUNT, CURVE), curvePolicy).ok, false);
});

ok('without the interlock (fees off, dust, corrupt blob) the same stripped buy signs — a legit user is never blocked', () => {
  assert.equal(checkEvmTx(tx(stripped, AMOUNT), policy()).ok, true);
});

ok('a sell never carries the interlock: a plain router sell signs whatever the fee state', () => {
  const sellPolicy = policy({ allow: [{ to: ROUTER, selectors: [EXECUTE_SELECTOR], maxValueWei: 0n }] });
  assert.equal(sellPolicy.requireFeeLeg, undefined);
  assert.equal(checkEvmTx(tx(stripped, 0n), sellPolicy).ok, true);
});

// ── the curve-router shape (contracts/KryptCurveRouter.sol) ───────────

const KRYPT_ROUTER = '0x000000000000000000000000000000000000c0de';
const routerBuyAbi = parseAbi(['function buy(address curve, uint256 quoteIn, uint256 minTokensOut, uint256 feeWei, address referrer, uint256 referrerWei) payable returns (uint256, uint256)']);
const routerBuy = (feeWei, referrer, referrerWei) =>
  encodeFunctionData({ abi: routerBuyAbi, functionName: 'buy', args: [CURVE, AMOUNT, 0n, feeWei, referrer, referrerWei] });
const routerPolicy = policy({
  allow: [{ to: KRYPT_ROUTER, selectors: [KRYPT_ROUTER_BUY_SELECTOR], maxValueWei: AMOUNT + FEE }],
  requireFeeLeg: { treasury: TREASURY, minWei: TREASURY_WEI, via: 'curve-router' },
});
const routerTx = (data, value = AMOUNT + FEE) => tx(data, value, KRYPT_ROUTER);

ok('the router buy selector is the keccak of buy(address,uint256,uint256,uint256,address,uint256)', () => {
  assert.equal(KRYPT_ROUTER_BUY_SELECTOR, '0xf26c91bb');
  assert.equal(routerBuy(FEE, ETH, 0n).slice(0, 10), KRYPT_ROUTER_BUY_SELECTOR);
});

ok('decodeRouterBuyFee reads quoteIn, feeWei and referrerWei; null for anything else', () => {
  const f = decodeRouterBuyFee(routerBuy(FEE, REFERRER, REFERRER_WEI));
  assert.deepEqual(f, { quoteIn: AMOUNT, feeWei: FEE, referrerWei: REFERRER_WEI });
  assert.equal(decodeRouterBuyFee(withFee), null);
  assert.equal(decodeRouterBuyFee('0xf26c91bb'), null);
});

ok('a routed buy that pays the treasury its planned share signs (with and without a referrer)', () => {
  assert.equal(carriesRouterFee(routerBuy(FEE, REFERRER, REFERRER_WEI), TREASURY_WEI), true);
  assert.equal(carriesRouterFee(routerBuy(FEE, ETH, 0n), TREASURY_WEI), true, 'no referrer: the whole fee reaches the treasury');
  assert.equal(checkEvmTx(routerTx(routerBuy(FEE, REFERRER, REFERRER_WEI)), routerPolicy).ok, true);
  assert.equal(checkEvmTx(routerTx(routerBuy(FEE, ETH, 0n)), routerPolicy).ok, true);
});

ok('a routed buy with the fee zeroed, shaved, or shifted to the referrer is refused', () => {
  assert.equal(checkEvmTx(routerTx(routerBuy(0n, ETH, 0n), AMOUNT), routerPolicy).ok, false, 'zero fee');
  // With no referrer the whole fee reaches the treasury, so the shave has to
  // go below the TREASURY minimum to be caught — and it is.
  assert.equal(checkEvmTx(routerTx(routerBuy(TREASURY_WEI - 1n, ETH, 0n), AMOUNT + TREASURY_WEI - 1n), routerPolicy).ok, false, 'shaved fee');
  assert.equal(checkEvmTx(routerTx(routerBuy(FEE - 1n, ETH, 0n), AMOUNT + FEE - 1n), routerPolicy).ok, true, 'a fee still above the treasury minimum is fine');
  assert.equal(checkEvmTx(routerTx(routerBuy(FEE, REFERRER, FEE)), routerPolicy).ok, false, 'referrer takes it all — treasury short');
  assert.equal(carriesRouterFee(routerBuy(FEE, REFERRER, FEE + 1n), TREASURY_WEI), false, 'referrer share above the fee');
});

ok('a routed buy whose value does not cover amount plus fee is refused before the contract would revert it', () => {
  const v = checkEvmTx(routerTx(routerBuy(FEE, REFERRER, REFERRER_WEI), AMOUNT + FEE - 1n), routerPolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /value/);
});

ok('under a curve-router interlock, a direct curve buy is refused — the crack that skips the router cannot buy', () => {
  const buy = encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [AMOUNT, 0n, ME] });
  const p = policy({ allow: [{ to: CURVE, selectors: ['0x59a87bc1'], maxValueWei: AMOUNT }], requireFeeLeg: { treasury: TREASURY, minWei: TREASURY_WEI, via: 'curve-router' } });
  assert.equal(checkEvmTx(tx(buy, AMOUNT, CURVE), p).ok, false);
});

console.log(`\n${passed} evm fee-leg cases passed`);
