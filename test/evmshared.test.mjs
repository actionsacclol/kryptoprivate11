// shared/evm.ts — the renderer-safe EVM contract (Robinhood Chain + BNB
// Smart Chain).
//
// Pure helpers only: chain metadata, address shape, RPC resolution per
// chain, the fee split (and the pinned treasury), unit conversions that
// money passes through, and curve progress.

import assert from 'node:assert';
import {
  CHAIN_KINDS,
  EVM_CHAINS,
  EVM_CHAIN_META,
  isEvmChain,
  isChainKind,
  nativeSymbolOf,
  isEvmAddress,
  chainOfAddress,
  explorerTx,
  explorerAddress,
  explorerToken,
  resolveEvmRpcUrl,
  evmRpcUrlProblem,
  DEFAULT_EVM_SETTINGS,
  ROBINHOOD_CHAIN_ID,
  BNB_CHAIN_ID,
  ROBINHOOD_PUBLIC_RPC,
  WETH_ADDRESS,
  WBNB_ADDRESS,
  NATIVE_ADDRESS,
  VENUE_LABEL,
  EVM_FEE_BPS,
  EVM_REFERRAL_SHARE_BPS,
  EVM_MIN_FEE_WEI,
  EVM_TREASURY_ADDRESS,
  ZERO_EVM_SPLIT,
  evmFeesEnabled,
  splitEvmFee,
  evmReferralProblem,
  weiToEth,
  ethToWei,
  rawToAmount,
  portionRaw,
  applySlippage,
  curveProgressPct,
  WEI,
  EVM_RPC_CAPABILITIES,
  evmClosedTrips,
} from './.evmshared.mjs';

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

const ADDR = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'; // WETH on Robinhood Chain
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── chains ────────────────────────────────────────────────────────────

ok('three chain kinds, two of them EVM, in a fixed order', () => {
  assert.deepEqual(CHAIN_KINDS, ['solana', 'robinhood', 'bnb']);
  assert.deepEqual(EVM_CHAINS, ['robinhood', 'bnb']);
  assert.equal(isEvmChain('robinhood'), true);
  assert.equal(isEvmChain('bnb'), true);
  assert.equal(isEvmChain('solana'), false);
  assert.equal(isEvmChain('ethereum'), false);
  assert.equal(isEvmChain(56), false);
  assert.equal(isChainKind('solana'), true);
  assert.equal(isChainKind('bnb'), true);
  assert.equal(isChainKind('base'), false);
  assert.equal(isChainKind(undefined), false);
});

ok('Robinhood Chain metadata: 4663, ETH, Blockscout, Pons, 100 ms blocks, WETH', () => {
  const m = EVM_CHAIN_META.robinhood;
  assert.equal(m.kind, 'robinhood');
  assert.equal(m.id, 4663);
  assert.equal(m.nativeSymbol, 'ETH');
  assert.equal(m.explorer, 'https://robinhoodchain.blockscout.com');
  assert.equal(m.publicRpc, 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(m.blockMs, 100);
  assert.equal(m.launchpad, 'pons');
  assert.equal(m.geckoNetwork, 'robinhood');
  assert.equal(m.dexscreenerChain, 'robinhood');
  assert.equal(m.wrappedNative, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
  assert.equal(ROBINHOOD_CHAIN_ID, 4663);
  assert.equal(ROBINHOOD_PUBLIC_RPC, m.publicRpc);
  assert.equal(WETH_ADDRESS, m.wrappedNative);
});

ok('BNB Smart Chain metadata: 56, BNB, BscScan, four.meme, 450 ms blocks, WBNB', () => {
  const m = EVM_CHAIN_META.bnb;
  assert.equal(m.kind, 'bnb');
  assert.equal(m.id, 56);
  assert.equal(m.nativeSymbol, 'BNB');
  assert.equal(m.explorer, 'https://bscscan.com');
  assert.equal(m.publicRpc, 'https://bsc-rpc.publicnode.com');
  assert.equal(m.blockMs, 450);
  assert.equal(m.launchpad, 'fourmeme');
  assert.equal(m.geckoNetwork, 'bsc');
  assert.equal(m.dexscreenerChain, 'bsc');
  assert.equal(m.wrappedNative, '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
  assert.equal(BNB_CHAIN_ID, 56);
  assert.equal(WBNB_ADDRESS, m.wrappedNative);
});

ok('the native symbol per chain, and address(0) as the native sentinel', () => {
  assert.equal(nativeSymbolOf('solana'), 'SOL');
  assert.equal(nativeSymbolOf('robinhood'), 'ETH');
  assert.equal(nativeSymbolOf('bnb'), 'BNB');
  assert.equal(NATIVE_ADDRESS, '0x0000000000000000000000000000000000000000');
});

ok('every venue has a label, including the BNB ones', () => {
  for (const v of ['pons-curve', 'pons-v4', 'uniswap-v3', 'fourmeme-curve', 'pancake-v2', 'pancake-v3', 'unknown']) {
    assert.equal(typeof VENUE_LABEL[v], 'string', v);
    assert.ok(VENUE_LABEL[v].length > 0, v);
  }
});

// ── address shape ─────────────────────────────────────────────────────

ok('a 0x + 40 hex string is an EVM address, checksum or not', () => {
  assert.equal(isEvmAddress(ADDR), true);
  assert.equal(isEvmAddress(ADDR.toLowerCase()), true);
  assert.equal(isEvmAddress(ADDR.toUpperCase().replace('0X', '0x')), true);
});

ok('a Solana mint, a short hex, a missing prefix and a non-string are not', () => {
  assert.equal(isEvmAddress(SOL_MINT), false);
  assert.equal(isEvmAddress('0x1234'), false);
  assert.equal(isEvmAddress(ADDR.slice(2)), false);
  assert.equal(isEvmAddress(ADDR + '0'), false);
  assert.equal(isEvmAddress(null), false);
  assert.equal(isEvmAddress(42), false);
});

ok('chainOfAddress: Solana by shape, EVM to the caller’s default (an 0x address cannot name its chain)', () => {
  assert.equal(chainOfAddress(SOL_MINT), 'solana');
  assert.equal(chainOfAddress(SOL_MINT, 'bnb'), 'solana');
  assert.equal(chainOfAddress(ADDR), 'robinhood');
  assert.equal(chainOfAddress(ADDR, 'bnb'), 'bnb');
});

ok('explorer links are chain-first: Blockscout for Robinhood, BscScan for BNB', () => {
  assert.equal(explorerTx('robinhood', '0xabc'), 'https://robinhoodchain.blockscout.com/tx/0xabc');
  assert.equal(explorerTx('bnb', '0xabc'), 'https://bscscan.com/tx/0xabc');
  assert.equal(explorerAddress('bnb', ADDR), `https://bscscan.com/address/${ADDR}`);
  assert.equal(explorerToken('robinhood', ADDR), `https://robinhoodchain.blockscout.com/token/${ADDR}`);
});

// ── RPC resolution ────────────────────────────────────────────────────

ok('Robinhood: a key wins and becomes the Alchemy URL', () => {
  assert.equal(
    resolveEvmRpcUrl('robinhood', { rpcUrl: 'https://my.node/rpc', apiKey: '  abc123  ' }),
    'https://robinhood-mainnet.g.alchemy.com/v2/abc123',
  );
});

ok('BNB: a key is ignored — the URL or the public endpoint is used', () => {
  assert.equal(resolveEvmRpcUrl('bnb', { rpcUrl: 'https://my.node/rpc', apiKey: 'abc123' }), 'https://my.node/rpc');
  assert.equal(resolveEvmRpcUrl('bnb', { rpcUrl: '', apiKey: 'abc123' }), EVM_CHAIN_META.bnb.publicRpc);
});

ok('without a key an https URL is used verbatim, on either chain', () => {
  assert.equal(resolveEvmRpcUrl('robinhood', { rpcUrl: 'https://my.node/rpc', apiKey: '' }), 'https://my.node/rpc');
  assert.equal(resolveEvmRpcUrl('bnb', { rpcUrl: 'https://bsc.my.node/rpc', apiKey: '' }), 'https://bsc.my.node/rpc');
});

ok('an http URL is refused in favour of the chain’s public endpoint', () => {
  assert.equal(resolveEvmRpcUrl('robinhood', { rpcUrl: 'http://my.node/rpc', apiKey: '' }), ROBINHOOD_PUBLIC_RPC);
  assert.equal(resolveEvmRpcUrl('bnb', { rpcUrl: 'http://my.node/rpc', apiKey: '' }), EVM_CHAIN_META.bnb.publicRpc);
});

ok('blank settings fall back to the chain’s public endpoint', () => {
  assert.equal(resolveEvmRpcUrl('robinhood', { rpcUrl: '', apiKey: '' }), ROBINHOOD_PUBLIC_RPC);
  assert.equal(resolveEvmRpcUrl('robinhood', { rpcUrl: '   ', apiKey: ' ' }), ROBINHOOD_PUBLIC_RPC);
  assert.equal(resolveEvmRpcUrl('bnb', { rpcUrl: '', apiKey: '' }), 'https://bsc-rpc.publicnode.com');
});

ok('evmRpcUrlProblem: blank is fine, http is not, user:pass is not, https is fine', () => {
  assert.equal(evmRpcUrlProblem(''), null);
  assert.equal(evmRpcUrlProblem('https://rpc.example.com/v1/key'), null);
  assert.match(evmRpcUrlProblem('http://rpc.example.com'), /https/);
  assert.match(evmRpcUrlProblem('https://user:pw@rpc.example.com'), /user:pass/);
  assert.match(evmRpcUrlProblem('not a url'), /https/);
});

ok('default settings: shared slippage + referrer, one enabled block per chain, nothing keyed', () => {
  assert.equal(DEFAULT_EVM_SETTINGS.slippagePct, 5);
  assert.equal(DEFAULT_EVM_SETTINGS.referrer, '');
  for (const chain of EVM_CHAINS) {
    const cs = DEFAULT_EVM_SETTINGS[chain];
    assert.deepEqual(
      cs,
      // The runner filter is per chain, and its defaults are the conservative
      // ones — pinned in full here so a loosened default cannot slip in as a
      // one-word change (evmrunners.test.mjs pins what they mean).
      // `webhookUrl: ''` is OFF. It must ship empty: it is the one field in
      // the app that accepts a URL from the renderer, and a default pointing
      // anywhere would be a default that posts your flags somewhere.
      { enabled: true, rpcUrl: '', apiKey: '', runnerAlerts: { enabled: true, minBucket: 11, maxPerHour: 12, requireBeatsBase: true, webhookUrl: '' } },
      chain,
    );
    assert.equal(resolveEvmRpcUrl(chain, cs), EVM_CHAIN_META[chain].publicRpc, `${chain} default resolves to the public endpoint`);
  }
  assert.deepEqual(Object.keys(DEFAULT_EVM_SETTINGS).sort(), ['bnb', 'referrer', 'robinhood', 'slippagePct']);
});

// ── fees ──────────────────────────────────────────────────────────────

ok('fee constants: 0.5 % per side, 20 % referral share, 0.000001 native dust floor', () => {
  assert.equal(EVM_FEE_BPS, 50);
  assert.equal(EVM_REFERRAL_SHARE_BPS, 2000);
  assert.equal(EVM_MIN_FEE_WEI, 1_000_000_000_000n);
});

ok('fees are enabled exactly when the treasury is a real address', () => {
  assert.equal(evmFeesEnabled(), isEvmAddress(EVM_TREASURY_ADDRESS));
});

// A blank EVM treasury is no longer a legal build: canaries 13-18 read it as
// tampering and their level is shared with Solana, so such a build would
// corrode its own buys. scripts/gen-fee-integrity.mjs refuses to generate one.
ok('the treasury is set and well formed (a blank one is not a shippable build)', () => {
  assert.notEqual(EVM_TREASURY_ADDRESS, '', 'the EVM treasury must be set');
  assert.equal(isEvmAddress(EVM_TREASURY_ADDRESS), true, 'treasury must be a 0x address');
});

// The treasury, pinned EXACTLY (set 2026-09-08). Changing it is a deliberate
// act that edits this line too — the same rule as test/fees.test.mjs on
// Solana. Verified before it went in: EIP-55 checksum valid, a plain account
// (no code) on chain 4663 and on Ethereum mainnet, a bare transfer and a
// router buy carrying the fee leg to it both simulated OK. One address
// serves every EVM chain — an address is a key, not a chain.
ok('the treasury is exactly Krypt’s EVM address', () => {
  assert.equal(EVM_TREASURY_ADDRESS, '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a');
  assert.equal(evmFeesEnabled(), true);
  const s = splitEvmFee(WEI, true);
  assert.equal(s.totalWei, 5_000_000_000_000_000n); // 0.5 % of 1 ETH
  assert.equal(s.referrerWei, 1_000_000_000_000_000n); // 20 % of the fee
  assert.equal(s.treasuryWei, 4_000_000_000_000_000n);
});

ok('a $KRYPTO holder pays half on the EVM rails too, and the referrer still earns', () => {
  if (!evmFeesEnabled()) return;
  const s = splitEvmFee(WEI, true, 25);
  assert.equal(s.totalWei, 2_500_000_000_000_000n, '0.25 % of 1 native');
  assert.equal(s.referrerWei, 500_000_000_000_000n, '20 % of the halved fee');
  assert.equal(s.treasuryWei, 2_000_000_000_000_000n);
  // Never a surcharge: a rate above the ordinary one falls back to it.
  assert.equal(splitEvmFee(WEI, false, 500).totalWei, 5_000_000_000_000_000n);
  assert.equal(splitEvmFee(WEI, false, 0).totalWei, 5_000_000_000_000_000n);
});

ok('the split arithmetic (runs against whatever the treasury state is)', () => {
  const basis = WEI; // 1 native
  const s = splitEvmFee(basis, true);
  if (!evmFeesEnabled()) {
    assert.deepEqual(s, ZERO_EVM_SPLIT);
    return;
  }
  assert.equal(s.totalWei, (basis * 50n) / 10_000n);
  assert.equal(s.referrerWei, (s.totalWei * 2000n) / 10_000n);
  assert.equal(s.treasuryWei, s.totalWei - s.referrerWei);
  const noRef = splitEvmFee(basis, false);
  assert.equal(noRef.referrerWei, 0n);
  assert.equal(noRef.treasuryWei, noRef.totalWei);
  // Dust floor: a fee under 1e12 wei is skipped outright.
  assert.deepEqual(splitEvmFee(10n ** 13n, false), ZERO_EVM_SPLIT);
  assert.deepEqual(splitEvmFee(0n, true), ZERO_EVM_SPLIT);
  assert.deepEqual(splitEvmFee(-1n, true), ZERO_EVM_SPLIT);
});

ok('referral problems: blank fine, garbage refused, self refused, treasury refused', () => {
  assert.equal(evmReferralProblem('', { self: ADDR }), null);
  assert.equal(evmReferralProblem('   ', { self: ADDR }), null);
  assert.match(evmReferralProblem('abc', { self: null }), /EVM address/);
  assert.match(evmReferralProblem(SOL_MINT, { self: null }), /EVM address/);
  assert.match(evmReferralProblem(ADDR.toLowerCase(), { self: ADDR }), /yourself/);
  assert.equal(evmReferralProblem(ADDR, { self: null }), null);
  if (evmFeesEnabled()) assert.match(evmReferralProblem(EVM_TREASURY_ADDRESS, { self: null }), /treasury/);
  // The referrer is ONE setting for every EVM chain, but the chains can hold
  // different wallets, so a self-referral has to be caught against all of
  // them and not just the page you happen to be looking at (2026-09-21).
  const OTHER = '0x' + 'ab'.repeat(20);
  assert.match(evmReferralProblem(OTHER, { self: ADDR, alsoMine: [OTHER] }), /yourself/);
  assert.equal(evmReferralProblem(OTHER, { self: ADDR, alsoMine: [null] }), null);
  assert.equal(evmReferralProblem(OTHER, { self: ADDR }), null);
});

// ── unit conversions ──────────────────────────────────────────────────

ok('weiToEth: whole units, 0.001, and sub-wei precision that Number cannot hold', () => {
  assert.equal(weiToEth(WEI), 1);
  assert.equal(weiToEth('1000000000000000'), 0.001);
  assert.equal(weiToEth(0n), 0);
  assert.equal(weiToEth(123n), 1.23e-16);
  const almostOne = weiToEth(WEI + 1n);
  assert.ok(Math.abs(almostOne - 1) < 1e-15);
  assert.equal(weiToEth(2_500_000_000_000_000_000n), 2.5);
});

ok('ethToWei rounds to 1e-12 and refuses non-positive or non-finite input', () => {
  assert.equal(ethToWei(0.001), 10n ** 15n);
  assert.equal(ethToWei(1), WEI);
  assert.equal(ethToWei(0.1), 10n ** 17n);
  assert.equal(ethToWei(1.234567891234), 1_234_567_891_234_000_000n);
  assert.equal(ethToWei(0), 0n);
  assert.equal(ethToWei(-1), 0n);
  assert.equal(ethToWei(Number.NaN), 0n);
  assert.equal(ethToWei(Number.POSITIVE_INFINITY), 0n);
});

ok('ethToWei ∘ weiToEth round-trips the amounts a trade panel sends (ETH and BNB presets)', () => {
  for (const eth of [0.001, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]) {
    assert.equal(weiToEth(ethToWei(eth)), eth, `round trip ${eth}`);
  }
});

ok('rawToAmount honours decimals and accepts strings', () => {
  assert.equal(rawToAmount(10n ** 18n, 18), 1);
  assert.equal(rawToAmount(1_500_000n, 6), 1.5);
  assert.equal(rawToAmount('2', 0), 2);
  assert.equal(rawToAmount(0n, 18), 0);
  // 1e9 tokens at 18 decimals — the Pons and four.meme supply — exactly.
  assert.equal(rawToAmount(1_000_000_000n * 10n ** 18n, 18), 1_000_000_000);
});

ok('portionRaw: 100 % is everything, 50 % is half, fractions floor, out-of-range clamps', () => {
  assert.equal(portionRaw(1000n, 100), 1000n);
  assert.equal(portionRaw(1000n, 50), 500n);
  assert.equal(portionRaw(1001n, 33.33), 333n);
  assert.equal(portionRaw(1000n, 0), 0n);
  assert.equal(portionRaw(1000n, 150), 1000n);
  assert.equal(portionRaw(1000n, -5), 0n);
  assert.equal(portionRaw(7n, 100), 7n);
});

ok('applySlippage floors and clamps', () => {
  assert.equal(applySlippage(1000n, 5), 950n);
  assert.equal(applySlippage(1001n, 0.5), 995n);
  assert.equal(applySlippage(1000n, 0), 1000n);
  assert.equal(applySlippage(1000n, 100), 0n);
  assert.equal(applySlippage(1000n, 250), 0n);
  assert.equal(applySlippage(1000n, -3), 1000n);
});

// ── curve progress ────────────────────────────────────────────────────

ok('curveProgressPct: the live Pons curve read on 2026-09-08 sat at 84.02 %', () => {
  assert.equal(curveProgressPct(3_529_185_642_258_913_225n, 4_200_000_000_000_000_000n, false), 84.02);
});

ok('curveProgressPct: a four.meme curve at 9 of 18 BNB is 50 %', () => {
  assert.equal(curveProgressPct(9n * 10n ** 18n, 18n * 10n ** 18n, false), 50);
});

ok('curveProgressPct clamps: graduated is 100, zero threshold is 0, over-threshold caps at 99.99', () => {
  assert.equal(curveProgressPct(0n, 4_200_000_000_000_000_000n, true), 100);
  assert.equal(curveProgressPct(10n, 0n, false), 0);
  assert.equal(curveProgressPct(5_000_000_000_000_000_000n, 4_200_000_000_000_000_000n, false), 99.99);
  assert.equal(curveProgressPct(0n, 4_200_000_000_000_000_000n, false), 0);
});

// ── RPC capabilities ──────────────────────────────────────────────────

ok('the six capabilities an EVM endpoint is asked for are named, and carry no URLs', () => {
  // Neither chain has one free endpoint that does all six (docs/api-swarm-
  // 2026-09-09.md §2), so the rail resolves an endpoint PER capability. The
  // names live here, renderer-safe; the URLs live in electron/evm/chains.ts
  // and never cross IPC.
  assert.deepEqual(EVM_RPC_CAPABILITIES, ['receipts', 'state', 'logs', 'simulate', 'broadcast', 'ws']);
  assert.equal(new Set(EVM_RPC_CAPABILITIES).size, EVM_RPC_CAPABILITIES.length);
  for (const cap of EVM_RPC_CAPABILITIES) assert.ok(!/https?:|wss?:/.test(cap), cap);
});

ok('state is a capability of its own, not an alias for receipts', () => {
  // On BNB the endpoint that answers a receipt keeps only ~50 seconds of state
  // behind it, against a 60 s receipt timeout — see test/evmbsc.test.mjs.
  assert.ok(EVM_RPC_CAPABILITIES.includes('state'));
  assert.ok(EVM_RPC_CAPABILITIES.includes('receipts'));
});

ok('round trips fold the fills into the Solana shape, closed only when the wallet is flat and every leg is read', () => {
  // Round trips from the rail's fills, in the Solana shape (2026-09-11) —
  // so the Trades page's rows, card and replay serve every chain.
  const fill = (o) => ({
    id: o.hash, chain: 'robinhood', token: '0xABC', symbol: 'T', side: o.side, at: o.at, hash: o.hash,
    requested: 0, nativeDeltaWei: o.wei, tokenDeltaRaw: o.tok, decimals: 18, gasWei: null, feeWei: null,
    state: o.state ?? 'reconciled', note: null, wallet: '0x1', venue: 'pons-curve',
  });
  const E = 10n ** 18n;
  const buy = fill({ side: 'buy', at: 1_000, hash: 'a', wei: (-2n * E).toString(), tok: (1000n * E).toString() });
  const sell = fill({ side: 'sell', at: 5_000, hash: 'b', wei: (3n * E).toString(), tok: (-1000n * E).toString() });
  const trips = evmClosedTrips([sell, buy]); // order on input does not matter
  assert.equal(trips.length, 1);
  const tr = trips[0];
  assert.equal(tr.mint, '0xabc', 'lower-cased token');
  assert.equal(tr.costSol, 2, 'cost is the net native that left, gas included');
  assert.equal(tr.proceedsSol, 3);
  assert.equal(tr.pnlSol, 1);
  assert.equal(tr.pnlPct, 50);
  assert.equal(tr.tokensBought, 1000);
  assert.equal(tr.entryPriceSol, 0.002);
  assert.equal(tr.exitPriceSol, 0.003);
  assert.deepEqual([tr.buys, tr.sells, tr.holdMs], [1, 1, 4_000]);
  // A partial sell leaves the trip OPEN: nothing is counted yet.
  const half = fill({ side: 'sell', at: 5_000, hash: 'c', wei: (2n * E).toString(), tok: (-500n * E).toString() });
  assert.equal(evmClosedTrips([buy, half]).length, 0, 'half a bag sold is not a round trip');
  // A dust remainder (under 0.1 % of what was bought) still closes it.
  const almost = fill({ side: 'sell', at: 5_000, hash: 'd', wei: (3n * E).toString(), tok: (-(1000n * E) + 5n * 10n ** 17n).toString() });
  assert.equal(evmClosedTrips([buy, almost]).length, 1, 'dust does not keep a trip open');
  // A fill the chain has not answered for keeps the trip out — never guessed.
  const pendingSell = fill({ side: 'sell', at: 5_000, hash: 'e', wei: null, tok: null, state: 'pending' });
  assert.equal(evmClosedTrips([buy, pendingSell]).length, 0, 'an unreconciled leg is not counted');
  // A sell with no buy before it is a bag from elsewhere, not a trip.
  assert.equal(evmClosedTrips([sell]).length, 0);
});

console.log(`\n${passed} evm shared cases passed`);
