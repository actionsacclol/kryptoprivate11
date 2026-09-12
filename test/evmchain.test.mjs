// electron/evm/chain.ts — the ONLY place a Robinhood Chain contract address
// is written. One wrong character sends a user's money to a stranger, so
// every address, topic and selector is pinned here to the value read back
// from the live chain on 2026-09-08.

import assert from 'node:assert';
import { toEventSelector, toFunctionSelector } from 'viem';
import { ADDR, TOPIC, SELECTOR, PONS_SUPPLY, V3_FEE_TIERS, UR_COMMAND, V4_ACTION, UR_ADDR, ROBINHOOD, BLOCK_MS, LOGS_MAX_RESULTS } from './.evmchain.mjs';
import { CHAINS } from './.evmchains.mjs';

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

const same = (a, b, label) => assert.equal(String(a).toLowerCase(), String(b).toLowerCase(), label);

// ── addresses ─────────────────────────────────────────────────────────

// Krypt's curve router (contracts/KryptCurveRouter.sol). Empty until it is
// deployed; `npm run deploy:router -- --write` fills in BOTH this pin and
// ADDR.kryptRouter. Empty means curve buys go direct and bill afterwards.
const KRYPT_ROUTER = '';

const PINNED = {
  kryptRouter: KRYPT_ROUTER,
  native: '0x0000000000000000000000000000000000000000',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  v3QuoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  v3SwapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
  ponsFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  ponsMemeHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  ponsLaunchRouter: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  ponsLocker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
  ponsV1Factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
};

ok('every pinned address is present and exact (case-insensitive)', () => {
  for (const [k, v] of Object.entries(PINNED)) {
    assert.ok(k in ADDR, `ADDR.${k} missing`);
    same(ADDR[k], v, `ADDR.${k}`);
  }
});

ok('ADDR has no address that is not pinned here', () => {
  const extra = Object.keys(ADDR).filter((k) => !(k in PINNED));
  assert.deepEqual(extra, [], `unpinned addresses: ${extra.join(', ')} — pin them`);
});

ok('every address is a 20-byte hex string (the router may be empty until deployed)', () => {
  for (const [k, v] of Object.entries(ADDR)) {
    if (k === 'kryptRouter' && v === '') continue;
    assert.match(v, /^0x[0-9a-fA-F]{40}$/, k);
  }
});

ok('the router buy selector is the keccak of its signature', () => {
  same(SELECTOR.kryptRouterBuy, '0xf26c91bb');
  same(SELECTOR.kryptRouterBuy, toFunctionSelector('buy(address,uint256,uint256,uint256,address,uint256)'));
});

ok('the chain is 4663 with ETH gas, the Blockscout explorer and Multicall3 wired', () => {
  assert.equal(ROBINHOOD.id, 4663);
  assert.equal(ROBINHOOD.nativeCurrency.symbol, 'ETH');
  assert.equal(ROBINHOOD.nativeCurrency.decimals, 18);
  assert.equal(ROBINHOOD.rpcUrls.default.http[0], 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(ROBINHOOD.blockExplorers.default.url, 'https://robinhoodchain.blockscout.com');
  same(ROBINHOOD.contracts.multicall3.address, PINNED.multicall3);
});

// ── event topics ──────────────────────────────────────────────────────

ok('topics computed from the ABI signatures match the pinned hashes', () => {
  assert.equal(toEventSelector('TokenLaunched(address,address,address,address,uint256,uint256)'), TOPIC.tokenLaunched);
  assert.equal(toEventSelector('CurveBuy(address,address,uint256,uint256,uint256,uint256)'), TOPIC.curveBuy);
  assert.equal(toEventSelector('CurveSell(address,address,uint256,uint256,uint256,uint256)'), TOPIC.curveSell);
  assert.equal(toEventSelector('SnipeTaxCharged(address,uint256)'), TOPIC.snipeTaxCharged);
  assert.equal(toEventSelector('CurveBuyRefunded(address,uint256)'), TOPIC.curveBuyRefunded);
  assert.equal(toEventSelector('Transfer(address,address,uint256)'), TOPIC.erc20Transfer);
});

ok('topics read from the chain (signature not published) are pinned verbatim', () => {
  assert.equal(TOPIC.tokenLaunched, '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607');
  assert.equal(TOPIC.launchSwept, '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4');
  assert.equal(TOPIC.poolGraduated, '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259');
  assert.equal(TOPIC.graduationLocked, '0xa0a18f5bf205becee8b268d7cf69addab8548ae8ef361791464cf0e0e17c1361');
  assert.equal(TOPIC.curveBuy, '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455');
  assert.equal(TOPIC.curveSell, '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df');
  assert.equal(TOPIC.snipeTaxCharged, '0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934');
  assert.equal(TOPIC.curveBuyRefunded, '0xa69e8258ccc7b9bbb70ab953fc2d1062b4ee28b8ca827534097e1732e87b0262');
  assert.equal(TOPIC.erc20Transfer, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  for (const v of Object.values(TOPIC)) assert.match(v, /^0x[0-9a-f]{64}$/);
});

// ── selectors ─────────────────────────────────────────────────────────

ok('selectors are the keccak of the functions the policy allows', () => {
  assert.equal(toFunctionSelector('buy(uint256,uint256,address)'), SELECTOR.curveBuy);
  assert.equal(toFunctionSelector('sell(uint256,uint256,address)'), SELECTOR.curveSell);
  assert.equal(toFunctionSelector('execute(bytes,bytes[],uint256)'), SELECTOR.execute);
  assert.equal(toFunctionSelector('approve(address,uint256)'), SELECTOR.approve);
  assert.equal(toFunctionSelector('approve(address,address,uint160,uint48)'), SELECTOR.permit2Approve);
});

ok('selectors pinned verbatim', () => {
  assert.equal(SELECTOR.curveBuy, '0x59a87bc1');
  assert.equal(SELECTOR.curveSell, '0xd04c6983');
  assert.equal(SELECTOR.execute, '0x3593564c');
  assert.equal(SELECTOR.approve, '0x095ea7b3');
  assert.equal(SELECTOR.permit2Approve, '0x87517c45');
});

// ── router constants ──────────────────────────────────────────────────

ok('Universal Router command bytes and v4 action bytes', () => {
  // V2_SWAP_EXACT_IN (0x08) joined on 2026-09-09 for PancakeSwap v2 on BNB;
  // the byte values are shared by Uniswap's and PancakeSwap's routers.
  assert.deepEqual(UR_COMMAND, { V3_SWAP_EXACT_IN: 0x00, PERMIT2_TRANSFER_FROM: 0x02, V2_SWAP_EXACT_IN: 0x08, SWEEP: 0x04, TRANSFER: 0x05, PAY_PORTION: 0x06, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 });
  assert.deepEqual(V4_ACTION, { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f, TAKE_PORTION: 0x10 });
  same(UR_ADDR.ETH, PINNED.native);
  same(UR_ADDR.MSG_SENDER, '0x0000000000000000000000000000000000000001');
  same(UR_ADDR.ADDRESS_THIS, '0x0000000000000000000000000000000000000002');
});

// ── chain facts ───────────────────────────────────────────────────────

ok('Pons supply is exactly one billion tokens at 18 decimals', () => {
  assert.equal(PONS_SUPPLY, 1_000_000_000n * 10n ** 18n);
  assert.equal(PONS_SUPPLY, 10n ** 27n);
});

ok('v3 fee tiers are probed richest-first, and the chain facts are stated', () => {
  assert.deepEqual([...V3_FEE_TIERS], [10_000, 3_000, 500, 100]);
  assert.equal(BLOCK_MS, 100);
  assert.equal(LOGS_MAX_RESULTS, 10_000);
});

// ── which endpoint serves what (API swarm, 2026-09-09) ────────────────
//
// Robinhood's official RPC is genuinely good — archive receipts, a
// 200,000-block eth_getLogs window in 1.28 s, eth_simulateV1 — with exactly
// two holes: it prunes STATE at ~4,096–16,384 blocks (7–27 minutes at 100 ms
// blocks, `-32000 "metadata is not found"`), and its WSS handshake fails.
// Those two are the only capabilities that may point elsewhere.

ok('Robinhood keeps receipts, logs, simulation and broadcast on its own RPC', () => {
  const e = CHAINS.robinhood.endpoints;
  for (const cap of ['receipts', 'logs', 'simulate', 'broadcast']) {
    assert.equal(e[cap], '', `${cap} should stay on the chain's main endpoint`);
  }
  // The result cap the official RPC enforces is exactly LOGS_MAX_RESULTS, so
  // the constant above is the right one to chunk against.
  assert.equal(LOGS_MAX_RESULTS, 10_000);
});

ok('Robinhood prices fills from an endpoint that still holds the block', () => {
  const state = CHAINS.robinhood.endpoints.state;
  assert.notEqual(state, '', 'the official RPC prunes state at ~7–27 minutes, so state cannot be blank');
  assert.match(state, /^https:\/\//);
  assert.notEqual(state, CHAINS.robinhood.meta.publicRpc);
  // ordofi key-gates eth_simulateV1 and txpool_status, so it must never become
  // the general read or simulation endpoint.
  assert.notEqual(state, CHAINS.robinhood.endpoints.simulate);
});

ok('Robinhood has a WSS endpoint even though its own RPC offers none', () => {
  assert.match(CHAINS.robinhood.endpoints.ws, /^wss:\/\//);
  assert.notEqual(CHAINS.robinhood.endpoints.ws, 'wss://rpc.mainnet.chain.robinhood.com');
});

console.log(`\n${passed} evm chain cases passed`);
