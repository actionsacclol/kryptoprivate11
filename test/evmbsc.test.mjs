// electron/evm/bsc.ts + chains.ts — every BNB Smart Chain address, topic and
// selector the rail sends money through, pinned verbatim.
//
// A wrong character in any of these pays a stranger forever, so each entry
// is compared to the value read back from the chain on 2026-09-09
// (eth_getCode non-empty, four.meme buys simulated, PancakeSwap quotes
// answered). Topics and selectors are ALSO recomputed from their ABI
// signatures with viem, so a pinned hash and its signature cannot drift
// apart.

import assert from 'node:assert';
import { toEventSelector, toFunctionSelector } from 'viem';
import { ADDR_BSC, TOPIC_BSC, SELECTOR_BSC, FOURMEME_SUPPLY, FOURMEME_CURVE_SUPPLY, PANCAKE_V3_FEE_TIERS, BSC, FOURMEME_MANAGER_ABI, FOURMEME_HELPER_ABI } from './.evmbsc.mjs';
import { CHAINS, chainConfig } from './.evmchains.mjs';

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

const PINNED = {
  native: '0x0000000000000000000000000000000000000000',
  wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  permit2: '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768',
  universalRouter: '0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB',
  v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  v3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  v3QuoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  v3SmartRouter: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  fourMemeManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
  fourMemeHelper: '0xF251F83e40a78868FcfA3FA4599Dad6494E46034',
  // Krypt's curve router for four.meme buys: not deployed. Empty means a
  // curve buy goes direct and bills afterwards.
  kryptRouter: '',
};

ok('every pinned address is present and exact (case-insensitive)', () => {
  for (const [k, v] of Object.entries(PINNED)) {
    assert.ok(k in ADDR_BSC, `ADDR_BSC.${k} missing`);
    same(ADDR_BSC[k], v, `ADDR_BSC.${k}`);
  }
});

ok('ADDR_BSC has no address that is not pinned here', () => {
  const extra = Object.keys(ADDR_BSC).filter((k) => !(k in PINNED));
  assert.deepEqual(extra, [], `unpinned addresses: ${extra.join(', ')} — pin them`);
});

ok('every address is a 20-byte hex string (the router may be empty until deployed)', () => {
  for (const [k, v] of Object.entries(ADDR_BSC)) {
    if (k === 'kryptRouter' && v === '') continue;
    assert.match(v, /^0x[0-9a-fA-F]{40}$/, k);
  }
});

ok('PancakeSwap’s Permit2 is NOT Uniswap’s canonical one — the router pulls through its own', () => {
  assert.notEqual(ADDR_BSC.permit2.toLowerCase(), '0x000000000022d473030f116ddee9f6b43ac78ba3');
});

ok('the chain is 56 with BNB gas, BscScan, the public RPC and Multicall3 wired', () => {
  assert.equal(BSC.id, 56);
  assert.equal(BSC.nativeCurrency.symbol, 'BNB');
  assert.equal(BSC.nativeCurrency.decimals, 18);
  assert.equal(BSC.rpcUrls.default.http[0], 'https://bsc-rpc.publicnode.com');
  assert.equal(BSC.blockExplorers.default.url, 'https://bscscan.com');
  same(BSC.contracts.multicall3.address, PINNED.multicall3);
});

// ── event topics ──────────────────────────────────────────────────────

ok('topics are the keccak of the four.meme event signatures', () => {
  assert.equal(toEventSelector('TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)'), TOPIC_BSC.tokenCreate);
  assert.equal(toEventSelector('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)'), TOPIC_BSC.tokenPurchase);
  assert.equal(toEventSelector('TokenSale(address,address,uint256,uint256,uint256,uint256,uint256,uint256)'), TOPIC_BSC.tokenSale);
});

ok('topics pinned verbatim, as read from the chain', () => {
  assert.equal(TOPIC_BSC.tokenCreate, '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20');
  assert.equal(TOPIC_BSC.tokenPurchase, '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942');
  assert.equal(TOPIC_BSC.tokenSale, '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19');
  assert.deepEqual(Object.keys(TOPIC_BSC).sort(), ['tokenCreate', 'tokenPurchase', 'tokenSale']);
  for (const v of Object.values(TOPIC_BSC)) assert.match(v, /^0x[0-9a-f]{64}$/);
});

ok('the ABI events carry the same signatures the topics were computed from', () => {
  const sig = (e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
  const events = Object.fromEntries(FOURMEME_MANAGER_ABI.filter((x) => x.type === 'event').map((e) => [e.name, toEventSelector(sig(e))]));
  assert.equal(events.TokenCreate, TOPIC_BSC.tokenCreate);
  assert.equal(events.TokenPurchase, TOPIC_BSC.tokenPurchase);
  assert.equal(events.TokenSale, TOPIC_BSC.tokenSale);
  // None of the four.meme trade events index a parameter: everything is in
  // `data`, which is how the decoder reads them.
  for (const e of FOURMEME_MANAGER_ABI.filter((x) => x.type === 'event')) for (const i of e.inputs) assert.equal(!!i.indexed, false, `${e.name}.${i.name}`);
});

// ── selectors ─────────────────────────────────────────────────────────

ok('selectors are the keccak of the four.meme functions the policy allows', () => {
  assert.equal(toFunctionSelector('buyTokenAMAP(address,uint256,uint256)'), SELECTOR_BSC.fourMemeBuy);
  assert.equal(toFunctionSelector('buyTokenAMAP(uint256,address,address,uint256,uint256)'), SELECTOR_BSC.fourMemeBuyTo);
  assert.equal(toFunctionSelector('sellToken(address,uint256,uint256)'), SELECTOR_BSC.fourMemeSell);
  assert.equal(toFunctionSelector('sellToken(uint256,address,uint256,uint256,uint256,address)'), SELECTOR_BSC.fourMemeSellWithFee);
});

ok('selectors pinned verbatim', () => {
  assert.equal(SELECTOR_BSC.fourMemeBuy, '0x87f27655');
  assert.equal(SELECTOR_BSC.fourMemeBuyTo, '0x5e56c39a');
  assert.equal(SELECTOR_BSC.fourMemeSell, '0x3e11741f');
  assert.equal(SELECTOR_BSC.fourMemeSellWithFee, '0x06e7b98f');
  assert.deepEqual(Object.keys(SELECTOR_BSC).sort(), ['fourMemeBuy', 'fourMemeBuyTo', 'fourMemeSell', 'fourMemeSellWithFee']);
});

ok('the manager ABI carries exactly the buy/sell overloads the selectors name, and the helper the quote views', () => {
  const sig = (f) => `${f.name}(${f.inputs.map((i) => i.type).join(',')})`;
  const fns = FOURMEME_MANAGER_ABI.filter((x) => x.type === 'function').map(sig).sort();
  assert.deepEqual(fns, [
    'buyTokenAMAP(address,uint256,uint256)',
    'buyTokenAMAP(uint256,address,address,uint256,uint256)',
    'sellToken(address,uint256,uint256)',
    'sellToken(uint256,address,uint256,uint256,uint256,address)',
  ]);
  const payable = FOURMEME_MANAGER_ABI.filter((x) => x.type === 'function' && x.stateMutability === 'payable').map(sig);
  assert.deepEqual(payable.sort(), ['buyTokenAMAP(address,uint256,uint256)', 'buyTokenAMAP(uint256,address,address,uint256,uint256)'], 'only the buys take BNB');
  const views = FOURMEME_HELPER_ABI.filter((x) => x.type === 'function').map((f) => f.name).sort();
  assert.deepEqual(views, ['getPancakePair', 'getTokenInfo', 'tryBuy', 'trySell']);
  for (const f of FOURMEME_HELPER_ABI.filter((x) => x.type === 'function')) assert.equal(f.stateMutability, 'view', f.name);
});

// ── chain facts ───────────────────────────────────────────────────────

ok('four.meme supply is one billion tokens at 18 decimals, 800 million of them on the curve', () => {
  assert.equal(FOURMEME_SUPPLY, 10n ** 27n);
  assert.equal(FOURMEME_CURVE_SUPPLY, 8n * 10n ** 26n);
  assert.equal(FOURMEME_CURVE_SUPPLY * 10n, FOURMEME_SUPPLY * 8n);
});

ok('PancakeSwap v3 fee tiers are probed richest-first', () => {
  assert.deepEqual([...PANCAKE_V3_FEE_TIERS], [10_000, 2_500, 500, 100]);
});

// ── per-chain config ──────────────────────────────────────────────────

ok('CHAINS carries exactly the two EVM chains with the right ids', () => {
  assert.deepEqual(Object.keys(CHAINS).sort(), ['bnb', 'robinhood']);
  assert.equal(CHAINS.robinhood.viem.id, 4663);
  assert.equal(CHAINS.bnb.viem.id, 56);
  assert.equal(CHAINS.robinhood.kind, 'robinhood');
  assert.equal(CHAINS.bnb.kind, 'bnb');
  assert.equal(chainConfig('bnb'), CHAINS.bnb);
  assert.equal(chainConfig('robinhood'), CHAINS.robinhood);
});

ok('fee rules: Robinhood caps at twice the base fee with no tip, BNB pays the node’s gas price with a 0.05 gwei floor', () => {
  assert.equal(CHAINS.robinhood.feeRule, 'base2x');
  assert.equal(CHAINS.robinhood.minFeePerGas, 10_000_000n);
  assert.equal(CHAINS.bnb.feeRule, 'gasPrice');
  assert.equal(CHAINS.bnb.minFeePerGas, 50_000_000n);
});

ok('each chain’s config points at its own router, Permit2 and wrapped native', () => {
  same(CHAINS.bnb.addr.universalRouter, PINNED.universalRouter);
  same(CHAINS.bnb.addr.permit2, PINNED.permit2);
  same(CHAINS.bnb.addr.wrapped, PINNED.wbnb);
  same(CHAINS.bnb.addr.v3Factory, PINNED.v3Factory);
  same(CHAINS.bnb.addr.v3QuoterV2, PINNED.v3QuoterV2);
  same(CHAINS.bnb.addr.multicall3, PINNED.multicall3);
  assert.equal(CHAINS.bnb.addr.kryptRouter, '');
  same(CHAINS.robinhood.addr.universalRouter, '0x8876789976decbfcbbbe364623c63652db8c0904');
  same(CHAINS.robinhood.addr.permit2, '0x000000000022D473030F116dDEE9F6B43aC78BA3');
  same(CHAINS.robinhood.addr.wrapped, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
  assert.notEqual(CHAINS.bnb.addr.universalRouter.toLowerCase(), CHAINS.robinhood.addr.universalRouter.toLowerCase());
  assert.deepEqual([...CHAINS.bnb.v3FeeTiers], [10_000, 2_500, 500, 100]);
  assert.deepEqual([...CHAINS.robinhood.v3FeeTiers], [10_000, 3_000, 500, 100]);
});

ok('block times and public rate gates match the measured chains', () => {
  assert.equal(CHAINS.robinhood.meta.blockMs, 100);
  assert.equal(CHAINS.bnb.meta.blockMs, 450);
  for (const c of Object.values(CHAINS)) {
    assert.ok(c.publicRate.rate > 0 && c.publicRate.burst >= c.publicRate.rate, c.kind);
    assert.ok(c.receiptTimeoutMs >= 30_000, c.kind);
  }
});

// ── the per-capability endpoint map (API swarm, 2026-09-09) ───────────
//
// BNB has NO single free endpoint that does everything. 28 were probed
// read-only and they split three ways: the official dataseeds serve receipts
// and eth_simulateV1 but ZERO logs (disabled by policy, `-32005 limit
// exceeded` even for one block) and ~110 blocks of state; publicnode serves
// logs near head and eth_simulateV1 but NO receipts at any depth and ≤20
// blocks of state; rpc-bnb.blockmachine.io serves archival logs, receipts and
// state but refuses eth_simulateV1. Modelling that as one `receiptRpc` field
// capped the launch index at ~67 minutes and priced fills from pruned state.
// These pins are what stop somebody folding it back into one endpoint.

const DATASEEDS = /bnbchain\.org|defibit\.io|ninicoin\.io|nariox\.org|binance\.org|bsc\.nodereal\.io/;
const PUBLICNODE = /publicnode\.com/;

ok('every chain names an endpoint for all six capabilities', () => {
  for (const c of Object.values(CHAINS)) {
    assert.ok(c.endpoints && typeof c.endpoints === 'object', `${c.kind} has an endpoint map`);
    for (const cap of ['receipts', 'state', 'logs', 'simulate', 'broadcast', 'ws']) {
      assert.equal(typeof c.endpoints[cap], 'string', `${c.kind}.${cap}`);
    }
    assert.equal(c.receiptRpc, undefined, `${c.kind} no longer carries the single receiptRpc field`);
  }
});

ok('BNB receipts do NOT go to publicnode — it refuses them at every depth', () => {
  const url = CHAINS.bnb.endpoints.receipts || CHAINS.bnb.meta.publicRpc;
  assert.ok(!PUBLICNODE.test(url), `receipts must not be publicnode, got ${url}`);
  assert.match(url, DATASEEDS);
});

ok('BNB logs go to an ARCHIVAL endpoint — never a dataseed, never publicnode', () => {
  const url = CHAINS.bnb.endpoints.logs || CHAINS.bnb.meta.publicRpc;
  // A dataseed answers `-32005 limit exceeded` to eth_getLogs for ANY range;
  // publicnode 403s past ~9,000 blocks, which is the ~67-minute index cap the
  // BNB audit left open. Either choice silently guts Discover.
  assert.ok(!DATASEEDS.test(url), `logs must not be a dataseed (getLogs is disabled there), got ${url}`);
  assert.ok(!PUBLICNODE.test(url), `logs must not be publicnode (~9,000-block archive wall), got ${url}`);
  assert.match(url, /^https:\/\//);
});

ok('BNB fill pricing does NOT read state through the 110-block dataseed', () => {
  const state = CHAINS.bnb.endpoints.state || CHAINS.bnb.meta.publicRpc;
  const receipts = CHAINS.bnb.endpoints.receipts || CHAINS.bnb.meta.publicRpc;
  // The dataseed's historical state bisected to 110–119 blocks on three hosts
  // — geth's 128-block trie, ≈50 s at 450 ms blocks — against a 60,000 ms
  // receipt timeout. A fill confirmed near the timeout would be priced from
  // state the endpoint had already dropped.
  assert.ok(!DATASEEDS.test(state), `state must not be a dataseed (~50 s window), got ${state}`);
  assert.ok(!PUBLICNODE.test(state), `state must not be publicnode (≤20 blocks), got ${state}`);
  assert.notEqual(state, receipts, 'receipts and state are different capabilities on BNB');
  assert.ok(CHAINS.bnb.receiptTimeoutMs > 50_000, 'the receipt timeout is what outran the old state window');
});

ok('BNB simulation stays on an endpoint that serves eth_simulateV1', () => {
  const url = CHAINS.bnb.endpoints.simulate || CHAINS.bnb.meta.publicRpc;
  // blockmachine answers -32603 "global signer not initialized for mining
  // mode"; blastapi 401s it. Only publicnode and the dataseeds serve it.
  assert.ok(!/blockmachine|blastapi/.test(url), `simulate must serve eth_simulateV1, got ${url}`);
  assert.notEqual(url, CHAINS.bnb.endpoints.logs, 'the logs endpoint cannot simulate');
});

ok('the BNB broadcast target is a stated choice, and its MEV policy is written down', () => {
  const url = CHAINS.bnb.endpoints.broadcast || CHAINS.bnb.meta.publicRpc;
  assert.match(url, /^https:\/\//);
  // Today that resolves to publicnode, which states "MEV protection enabled by
  // default": sends bypass the public mempool. Deliberate, and documented in
  // chains.ts — this pin exists so a change of target is a decision, not a
  // side effect of someone re-pointing the read endpoints.
  assert.equal(url, 'https://bsc-rpc.publicnode.com');
});

ok('both chains name a WSS endpoint, and it is a socket URL', () => {
  for (const c of Object.values(CHAINS)) {
    assert.match(c.endpoints.ws, /^wss:\/\//, `${c.kind} ws`);
  }
  // The official Robinhood RPC's WSS handshake fails and BNB's dataseeds have
  // none, so neither can simply be `meta.publicRpc` with the scheme swapped.
  assert.notEqual(CHAINS.robinhood.endpoints.ws, CHAINS.robinhood.meta.publicRpc.replace('https', 'wss'));
});

console.log(`\n${passed} evm bsc cases passed`);
