// electron/evm/policy.ts — the last gate before a Robinhood Chain signature.
//
// Every case is built from the exact calldata the builders produce (viem's
// encoder, the real ABIs), so a refusal here is a refusal the signer would
// make on the real bytes. The rules pinned: chain id, target allowlist,
// selector per target, ETH ceiling, gas and fee caps, the plain-transfer
// shape, and the two approval spender rules.

import assert from 'node:assert';
import { encodeFunctionData, parseAbi } from 'viem';
import {
  checkEvmTx,
  selectorOf,
  wordAddress,
  decodeApproveSpender,
  decodePermit2Spender,
  APPROVE_SELECTOR,
  PERMIT2_APPROVE_SELECTOR,
  DEFAULT_MAX_GAS,
  DEFAULT_MAX_FEE_PER_GAS,
  SELL_MAX_GAS,
  SELL_MAX_FEE_PER_GAS,
  SELL_MAX_GAS_COST_WEI,
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
const CURVE = '0xec8DAA33ec6eb33258af6f29d7590afe8e8b0f42';
const ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const TOKEN = '0xc7410e5136ac803e167782316c4a939a4f5097d5';
const TREASURY = '0x2222222222222222222222222222222222222222';
const ME = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x9999999999999999999999999999999999999999';

const curveAbi = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
]);
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const permit2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

const SEL = { buy: '0x59a87bc1', sell: '0xd04c6983', execute: '0x3593564c', approve: '0x095ea7b3', permit2Approve: '0x87517c45' };

const buyData = encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [10n ** 15n, 0n, ME] });
const sellData = encodeFunctionData({ abi: curveAbi, functionName: 'sell', args: [10n ** 20n, 0n, ME] });
const executeData = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x10', ['0x'], 1n] });
const approveToPermit2 = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, (1n << 256n) - 1n] });
const approveToStranger = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, (1n << 256n) - 1n] });
const permit2ToRouter = encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [TOKEN, ROUTER, (1n << 160n) - 1n, 1_800_000_000] });
const permit2ToStranger = encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [TOKEN, STRANGER, (1n << 160n) - 1n, 1_800_000_000] });

const AMOUNT = 10n ** 15n;
const base = { chainId: CHAIN, gas: 150_000n, maxFeePerGas: 500_000_000n };

const tradePolicy = (allow, extra = {}) => ({
  chainId: CHAIN,
  intent: 'trade',
  allow,
  maxGas: DEFAULT_MAX_GAS,
  maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS,
  approveSpenders: [],
  permit2Spenders: [],
  ...extra,
});

const curveBuyPolicy = tradePolicy([{ to: CURVE, selectors: [SEL.buy], maxValueWei: AMOUNT }]);

// ── selectors and decoding ────────────────────────────────────────────

ok('the builders produce the selectors the policy names', () => {
  assert.equal(selectorOf(buyData), SEL.buy);
  assert.equal(selectorOf(sellData), SEL.sell);
  assert.equal(selectorOf(executeData), SEL.execute);
  assert.equal(selectorOf(approveToPermit2), APPROVE_SELECTOR);
  assert.equal(selectorOf(permit2ToRouter), PERMIT2_APPROVE_SELECTOR);
  assert.equal(APPROVE_SELECTOR, SEL.approve);
  assert.equal(PERMIT2_APPROVE_SELECTOR, SEL.permit2Approve);
});

ok('selectorOf / wordAddress / spender decoders return null on short or garbage data', () => {
  assert.equal(selectorOf('0x'), null);
  assert.equal(selectorOf('0x1234'), null);
  assert.equal(selectorOf('garbage'), null);
  assert.equal(selectorOf(undefined), null);
  assert.equal(wordAddress('0x095ea7b3', 0), null);
  assert.equal(wordAddress(approveToPermit2, 5), null);
  assert.equal(decodeApproveSpender(buyData), null);
  assert.equal(decodeApproveSpender('0x095ea7b3ff'), null);
  assert.equal(decodePermit2Spender(approveToPermit2), null);
  assert.equal(decodePermit2Spender('0x87517c45'), null);
  // A word whose upper 12 bytes are not zero is not an address.
  const dirty = '0x095ea7b3' + 'ff'.repeat(12) + '11'.repeat(20) + '00'.repeat(32);
  assert.equal(wordAddress(dirty, 0), null);
});

ok('spender decoders read the right word', () => {
  assert.equal(decodeApproveSpender(approveToPermit2).toLowerCase(), PERMIT2.toLowerCase());
  assert.equal(decodeApproveSpender(approveToStranger).toLowerCase(), STRANGER.toLowerCase());
  assert.equal(decodePermit2Spender(permit2ToRouter).toLowerCase(), ROUTER.toLowerCase());
  assert.equal(decodePermit2Spender(permit2ToStranger).toLowerCase(), STRANGER.toLowerCase());
});

// ── a well-formed trade passes ────────────────────────────────────────

ok('a curve buy with exactly the sized value passes', () => {
  const v = checkEvmTx({ ...base, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy);
  assert.equal(v.ok, true, v.message);
});

ok('target matching is case-insensitive (checksum vs lowercase)', () => {
  const v = checkEvmTx({ ...base, to: CURVE.toLowerCase(), value: AMOUNT, data: buyData }, curveBuyPolicy);
  assert.equal(v.ok, true, v.message);
});

ok('a router execute with value = amount + fee passes under its own ceiling', () => {
  const fee = 5n * 10n ** 12n;
  const p = tradePolicy([{ to: ROUTER, selectors: [SEL.execute], maxValueWei: AMOUNT + fee }]);
  assert.equal(checkEvmTx({ ...base, to: ROUTER, value: AMOUNT + fee, data: executeData }, p).ok, true);
  assert.equal(checkEvmTx({ ...base, to: ROUTER, value: AMOUNT + fee + 1n, data: executeData }, p).ok, false);
});

// ── refusals ──────────────────────────────────────────────────────────

ok('wrong chain id is refused before anything else', () => {
  const v = checkEvmTx({ ...base, chainId: 1, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /chain 1/);
});

ok('a target the trade did not name is refused', () => {
  const v = checkEvmTx({ ...base, to: STRANGER, value: AMOUNT, data: buyData }, curveBuyPolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /did not name/);
});

ok('a malformed recipient is refused', () => {
  assert.equal(checkEvmTx({ ...base, to: '0x1234', value: 0n, data: buyData }, curveBuyPolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, to: undefined, value: 0n, data: buyData }, curveBuyPolicy).ok, false);
});

ok('the wrong selector on an allowed target is refused (sell under a buy policy)', () => {
  const v = checkEvmTx({ ...base, to: CURVE, value: 0n, data: sellData }, curveBuyPolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /not allowed/);
});

ok('calldata with no selector is refused', () => {
  const v = checkEvmTx({ ...base, to: CURVE, value: 0n, data: '0x' }, curveBuyPolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /selector/);
});

ok('one wei over the value ceiling is refused', () => {
  const v = checkEvmTx({ ...base, to: CURVE, value: AMOUNT + 1n, data: buyData }, curveBuyPolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /at most/);
});

ok('a sell policy allows no ETH at all', () => {
  const p = tradePolicy([{ to: CURVE, selectors: [SEL.sell], maxValueWei: 0n }]);
  assert.equal(checkEvmTx({ ...base, to: CURVE, value: 0n, data: sellData }, p).ok, true);
  assert.equal(checkEvmTx({ ...base, to: CURVE, value: 1n, data: sellData }, p).ok, false);
});

ok('gas over the policy maximum, or zero, is refused', () => {
  assert.equal(checkEvmTx({ ...base, gas: DEFAULT_MAX_GAS + 1n, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, gas: 0n, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, gas: DEFAULT_MAX_GAS, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy).ok, true);
});

ok('a fee cap over the ceiling, or zero, is refused', () => {
  assert.equal(checkEvmTx({ ...base, maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS + 1n, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, maxFeePerGas: 0n, to: CURVE, value: AMOUNT, data: buyData }, curveBuyPolicy).ok, false);
});

ok('negative value is refused', () => {
  assert.equal(checkEvmTx({ ...base, to: CURVE, value: -1n, data: buyData }, curveBuyPolicy).ok, false);
});

// ── plain transfers (the curve fee leg) ───────────────────────────────

const feePolicy = {
  chainId: CHAIN,
  intent: 'fee',
  allow: [{ to: TREASURY, selectors: 'transfer', maxValueWei: 5n * 10n ** 12n }],
  maxGas: 60_000n,
  maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS,
  approveSpenders: [],
  permit2Spenders: [],
};

ok('a transfer entry accepts empty calldata up to its ceiling', () => {
  assert.equal(checkEvmTx({ ...base, gas: 21_000n, to: TREASURY, value: 5n * 10n ** 12n, data: '0x' }, feePolicy).ok, true);
  assert.equal(checkEvmTx({ ...base, gas: 21_000n, to: TREASURY, value: 5n * 10n ** 12n + 1n, data: '0x' }, feePolicy).ok, false);
});

ok('a transfer entry refuses calldata — a "fee" that calls a contract is not a fee', () => {
  const v = checkEvmTx({ ...base, gas: 21_000n, to: TREASURY, value: 10n ** 12n, data: buyData }, feePolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /no calldata/);
});

ok('a transfer entry is an allowlist: exactly "0x", not even one zero byte (2026-09-09 audit)', () => {
  assert.equal(checkEvmTx({ ...base, gas: 21_000n, to: TREASURY, value: 10n ** 12n, data: '0x00' }, feePolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, gas: 21_000n, to: TREASURY, value: 10n ** 12n, data: '0x0000' }, feePolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, gas: 21_000n, to: TREASURY, value: 10n ** 12n, data: '0x' }, feePolicy).ok, true);
});

ok('a transfer to anyone but the named recipient is refused', () => {
  assert.equal(checkEvmTx({ ...base, gas: 21_000n, to: STRANGER, value: 10n ** 12n, data: '0x' }, feePolicy).ok, false);
});

// ── approvals ─────────────────────────────────────────────────────────

const approvePolicy = {
  chainId: CHAIN,
  intent: 'approve',
  allow: [{ to: TOKEN, selectors: [SEL.approve], maxValueWei: 0n }],
  maxGas: 200_000n,
  maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS,
  approveSpenders: [PERMIT2],
  permit2Spenders: [ROUTER],
};

ok('ERC-20 approve to Permit2 passes', () => {
  const v = checkEvmTx({ ...base, to: TOKEN, value: 0n, data: approveToPermit2 }, approvePolicy);
  assert.equal(v.ok, true, v.message);
});

ok('ERC-20 approve to any other spender is refused — an approval is a standing drain', () => {
  const v = checkEvmTx({ ...base, to: TOKEN, value: 0n, data: approveToStranger }, approvePolicy);
  assert.equal(v.ok, false);
  assert.match(v.message, /spender/);
});

// ── revocation: the one deliberate exception to the spender allowlist ──
//
// Setting an allowance to ZERO conveys nothing to the spender named, so the
// allowlist does not apply. Without it the app could never revoke an approval
// a user picked up elsewhere — and the only alternative is advice that sends
// them to a revocation site, which is exactly what drainers impersonate within
// hours of any incident. These tests exist to keep the exception NARROW.

ok('approve(stranger, 0) passes — a revocation grants nothing', () => {
  const revokeStranger = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 0n] });
  const v = checkEvmTx({ ...base, to: TOKEN, value: 0n, data: revokeStranger }, approvePolicy);
  assert.equal(v.ok, true, v.message);
});

ok('approve(stranger, 1) is STILL refused — one wei of allowance is a grant', () => {
  const grantOne = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 1n] });
  const v = checkEvmTx({ ...base, to: TOKEN, value: 0n, data: grantOne }, approvePolicy);
  assert.equal(v.ok, false, 'the exception must be exactly zero, not "small"');
  assert.match(v.message, /spender/);
});

ok('a revocation still may not carry ETH', () => {
  const revokeStranger = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 0n] });
  const p = { ...approvePolicy, allow: [{ to: TOKEN, selectors: [SEL.approve], maxValueWei: 10n }] };
  const v = checkEvmTx({ ...base, to: TOKEN, value: 1n, data: revokeStranger }, p);
  assert.equal(v.ok, false);
});

ok('an approval carrying ETH is refused', () => {
  const p = { ...approvePolicy, allow: [{ to: TOKEN, selectors: [SEL.approve], maxValueWei: 10n }] };
  const v = checkEvmTx({ ...base, to: TOKEN, value: 1n, data: approveToPermit2 }, p);
  assert.equal(v.ok, false);
  assert.match(v.message, /must not carry ETH/);
});

ok('an approve policy with no allowed spenders refuses every approve', () => {
  const p = { ...approvePolicy, approveSpenders: [] };
  assert.equal(checkEvmTx({ ...base, to: TOKEN, value: 0n, data: approveToPermit2 }, p).ok, false);
});

const permit2Policy = {
  ...approvePolicy,
  allow: [{ to: PERMIT2, selectors: [SEL.permit2Approve], maxValueWei: 0n }],
};

ok('Permit2 approve naming the router passes; naming anyone else is refused', () => {
  assert.equal(checkEvmTx({ ...base, to: PERMIT2, value: 0n, data: permit2ToRouter }, permit2Policy).ok, true);
  const v = checkEvmTx({ ...base, to: PERMIT2, value: 0n, data: permit2ToStranger }, permit2Policy);
  assert.equal(v.ok, false);
  assert.match(v.message, /not the router/);
});

ok('a Permit2 approve carrying ETH is refused', () => {
  const p = { ...permit2Policy, allow: [{ to: PERMIT2, selectors: [SEL.permit2Approve], maxValueWei: 10n }] };
  assert.equal(checkEvmTx({ ...base, to: PERMIT2, value: 1n, data: permit2ToRouter }, p).ok, false);
});

ok('the ERC-20 approve selector on the Permit2 contract is refused (selector is per target)', () => {
  assert.equal(checkEvmTx({ ...base, to: PERMIT2, value: 0n, data: approveToPermit2 }, permit2Policy).ok, false);
});

// ── a sell must survive an expensive network ──────────────────────────

ok('an exit is bounded by total gas COST, not by the two ceilings alone', () => {
  const sellPolicy = tradePolicy([{ to: CURVE, selectors: [SEL.sell], maxValueWei: 0n }], {
    maxGas: SELL_MAX_GAS,
    maxFeePerGasWei: SELL_MAX_FEE_PER_GAS,
    maxGasCostWei: SELL_MAX_GAS_COST_WEI,
  });
  const sell = (gas, fee) => checkEvmTx({ chainId: CHAIN, gas, maxFeePerGas: fee, to: CURVE, value: 0n, data: sellData }, sellPolicy);

  // A fee spike well past the old 50 gwei cap still exits: at a real swap's
  // gas, 100 gwei costs 0.015 native, which is a price worth paying to get
  // out. The old ceiling refused it outright.
  assert.ok(100_000_000_000n > DEFAULT_MAX_FEE_PER_GAS, 'the case really is past the old cap');
  assert.equal(sell(150_000n, 100_000_000_000n).ok, true, '100 gwei exit must pass');

  // What is refused is the total burn, not the rate: the same 100 gwei on a
  // pathological gas limit is a different amount of money.
  assert.equal(sell(1_000_000n, 100_000_000_000n).ok, false, '0.1 native of gas is not an exit');
  const tooMuch = sell(SELL_MAX_GAS, SELL_MAX_FEE_PER_GAS);
  assert.equal(tooMuch.ok, false, 'max gas at max rate burns more than an exit may');
  assert.match(tooMuch.message, /gas cost/i);

  // And the product bound is exact at the boundary.
  const gas = 200_000n;
  const exact = SELL_MAX_GAS_COST_WEI / gas;
  assert.equal(sell(gas, exact).ok, true, 'exactly at the ceiling is allowed');
  assert.equal(sell(gas, exact + 1n).ok, false, 'one wei over is not');
});

ok('a buy keeps the tight ceilings — the relaxation is exit-only', () => {
  assert.equal(checkEvmTx({ ...base, to: CURVE, value: AMOUNT, maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS + 1n, data: buyData }, curveBuyPolicy).ok, false);
  assert.equal(checkEvmTx({ ...base, to: CURVE, value: AMOUNT, gas: DEFAULT_MAX_GAS + 1n, data: buyData }, curveBuyPolicy).ok, false);
});


console.log(`\n${passed} evm policy cases passed`);
