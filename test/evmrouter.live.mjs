// Live check of contracts/KryptCurveRouter.sol against a REAL Pons curve,
// without deploying: the runtime bytecode is injected at a scratch address
// with an eth_call state override, then buys are simulated through it.
//
//   npm run test:router
//
// What is proven here, on the chain's own state:
//   • a routed buy fills (tokensOut > 0) and refunds nothing on a full fill;
//   • the fee legs land: treasury and referrer balances rise by exactly the
//     planned amounts (eth_simulateV1 with traceTransfers);
//   • a partial fill (buying more than the curve has left) refunds the
//     leftover to the buyer and the router ends the call with 0 balance;
//   • FeeTooHigh / ValueMismatch / ReferrerShareTooHigh revert.

import assert from 'node:assert';
import fs from 'node:fs';
import { createPublicClient, http, defineChain, encodeFunctionData, decodeFunctionResult, parseAbi, parseEther, decodeErrorResult } from 'viem';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const artifact = JSON.parse(fs.readFileSync(new URL('../contracts/build/KryptCurveRouter.json', import.meta.url), 'utf8'));
const chain = defineChain({ id: 4663, name: 'Robinhood', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } });
const c = createPublicClient({ chain, transport: http(RPC) });

const ROUTER = '0x000000000000000000000000000000000000c0de';
const ME = '0x1111111111111111111111111111111111111111';
const REFERRER = '0x3333333333333333333333333333333333333333';
const TREASURY = '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const factoryAbi = parseAbi(['event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)']);
const curveAbi = parseAbi(['function graduated() view returns (bool)', 'function isNativeQuote() view returns (bool)', 'function realQuoteReserve() view returns (uint256)', 'function graduationThreshold() view returns (uint256)', 'function sellableTokens() view returns (uint256)']);

const override = (balance = parseEther('50')) => [
  { address: ROUTER, code: artifact.deployedBytecode },
  { address: ME, balance },
];

const buyData = (curve, quoteIn, minOut, feeWei, referrer, refWei) =>
  encodeFunctionData({ abi: artifact.abi, functionName: 'buy', args: [curve, quoteIn, minOut, feeWei, referrer, refWei] });

async function callBuy(curve, quoteIn, feeWei, referrer, refWei, value = quoteIn + feeWei) {
  const data = buyData(curve, quoteIn, 0n, feeWei, referrer, refWei);
  try {
    // simulateContract decodes the contract's own custom errors by name.
    const r = await c.simulateContract({ account: ME, address: ROUTER, abi: artifact.abi, functionName: 'buy', args: [curve, quoteIn, 0n, feeWei, referrer, refWei], value, stateOverride: override() });
    const [tokensOut, refundWei] = r.result;
    const gas = await c.estimateGas({ account: ME, to: ROUTER, data, value, stateOverride: override() });
    return { ok: true, tokensOut, refundWei, gas };
  } catch (e) {
    let name = null;
    const rev = typeof e?.walk === 'function' ? e.walk((x) => x?.name === 'ContractFunctionRevertedError') : null;
    if (rev?.data?.errorName) name = rev.data.errorName;
    if (!name) {
      // Fall back to the raw revert bytes wherever the node put them.
      const raw = rev?.raw ?? e?.cause?.data ?? e?.data ?? null;
      try {
        if (raw && typeof raw === 'string' && raw.length >= 10) name = decodeErrorResult({ abi: artifact.abi, data: raw }).errorName;
      } catch {
        /* not one of ours */
      }
    }
    return { ok: false, error: name ?? (e.shortMessage || e.message).slice(0, 160) };
  }
}

/** eth_simulateV1 with transfer tracing: who received how much ETH. */
async function simulateTransfers(curve, quoteIn, feeWei, referrer, refWei) {
  const data = buyData(curve, quoteIn, 0n, feeWei, referrer, refWei);
  const res = await c.request({
    method: 'eth_simulateV1',
    params: [
      {
        blockStateCalls: [
          {
            stateOverrides: {
              [ROUTER]: { code: artifact.deployedBytecode },
              [ME]: { balance: `0x${parseEther('50').toString(16)}` },
            },
            calls: [{ from: ME, to: ROUTER, data, value: `0x${(quoteIn + feeWei).toString(16)}` }],
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      'latest',
    ],
  });
  const call = res[0].calls[0];
  // Transfer traces are synthetic ERC-20 Transfer logs from address 0xEeee…EEeE.
  const transfers = (call.logs ?? [])
    .filter((l) => l.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    .map((l) => ({ from: `0x${l.topics[1].slice(26)}`, to: `0x${l.topics[2].slice(26)}`, wei: BigInt(l.data) }));
  return { status: call.status, transfers, gasUsed: BigInt(call.gasUsed) };
}

const head = await c.getBlockNumber();
const logs = await c.getLogs({ address: FACTORY, event: factoryAbi[0], fromBlock: head - 20000n, toBlock: head });
const native = logs.filter((l) => l.args.pairToken === '0x0000000000000000000000000000000000000000').slice(-60);
const states = await c.multicall({
  allowFailure: true,
  contracts: native.flatMap((l) => [
    { address: l.args.curve, abi: curveAbi, functionName: 'graduated' },
    { address: l.args.curve, abi: curveAbi, functionName: 'realQuoteReserve' },
    { address: l.args.curve, abi: curveAbi, functionName: 'graduationThreshold' },
    { address: l.args.curve, abi: curveAbi, functionName: 'sellableTokens' },
  ]),
});
let live = null, nearFull = null, bestProgress = -1;
native.forEach((l, i) => {
  const g = states[i * 4].result, real = states[i * 4 + 1].result, thr = states[i * 4 + 2].result;
  if (g !== false || real === undefined) return;
  const progress = Number((real * 10000n) / thr) / 100;
  if (!live) live = l;
  if (progress > bestProgress) { bestProgress = progress; nearFull = l; }
});
assert.ok(live, 'need a live native curve');
console.log(`router runtime ${(artifact.deployedBytecode.length - 2) / 2} bytes · live curve ${live.args.curve} · fullest curve ${nearFull.args.curve} at ${bestProgress.toFixed(1)} %`);

const quoteIn = parseEther('0.001');
const feeWei = quoteIn / 200n; // 0.5 %
const refWei = feeWei / 5n; // 20 % of the fee
const treasuryWei = feeWei - refWei;

let passed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  console.log(`ok  ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

const full = await callBuy(live.args.curve, quoteIn, feeWei, REFERRER, refWei);
ok('routed buy fills on a live curve', full.ok && full.tokensOut > 0n, full.ok ? `tokensOut ${full.tokensOut} · refund ${full.refundWei} · gas ${full.gas}` : full.error);
ok('a full fill refunds nothing', full.ok && full.refundWei === 0n);

const noRef = await callBuy(live.args.curve, quoteIn, feeWei, '0x0000000000000000000000000000000000000000', 0n);
ok('routed buy without a referrer fills too', noRef.ok && noRef.tokensOut > 0n, noRef.ok ? `gas ${noRef.gas}` : noRef.error);

const sim = await simulateTransfers(live.args.curve, quoteIn, feeWei, REFERRER, refWei);
const paidTo = (addr) => sim.transfers.filter((t) => t.to.toLowerCase() === addr.toLowerCase() && t.from.toLowerCase() === ROUTER.toLowerCase()).reduce((a, t) => a + t.wei, 0n);
ok('eth_simulateV1 reports the call succeeded', sim.status === '0x1', `${sim.transfers.length} ETH transfers traced, gas ${sim.gasUsed}`);
ok('the treasury receives exactly its share in the same transaction', paidTo(TREASURY) === treasuryWei, `${paidTo(TREASURY)} wei`);
ok('the referrer receives exactly its share in the same transaction', paidTo(REFERRER) === refWei, `${paidTo(REFERRER)} wei`);
const toCurve = sim.transfers.filter((t) => t.to.toLowerCase() === live.args.curve.toLowerCase()).reduce((a, t) => a + t.wei, 0n);
ok('the curve receives exactly quoteIn', toCurve === quoteIn, `${toCurve} wei`);

// Partial fill: ask for far more than the fullest curve has left.
const big = parseEther('20');
const partial = await callBuy(nearFull.args.curve, big, big / 200n, REFERRER, big / 1000n);
ok('over-buying the fullest curve is clamped and the leftover comes back to the buyer', partial.ok && partial.refundWei > 0n, partial.ok ? `refund ${partial.refundWei} wei (${(Number(partial.refundWei) / 1e18).toFixed(4)} ETH) · tokensOut ${partial.tokensOut}` : partial.error);
const simPartial = await simulateTransfers(nearFull.args.curve, big, big / 200n, REFERRER, big / 1000n);
const backToMe = simPartial.transfers.filter((t) => t.to.toLowerCase() === ME.toLowerCase() && t.from.toLowerCase() === ROUTER.toLowerCase()).reduce((a, t) => a + t.wei, 0n);
const routerIn = simPartial.transfers.filter((t) => t.to.toLowerCase() === ROUTER.toLowerCase()).reduce((a, t) => a + t.wei, 0n);
const routerOut = simPartial.transfers.filter((t) => t.from.toLowerCase() === ROUTER.toLowerCase()).reduce((a, t) => a + t.wei, 0n);
ok('the refund reaches the buyer and the router ends with nothing', simPartial.status === '0x1' && backToMe > 0n && routerIn === routerOut, `in ${routerIn} = out ${routerOut}, refund ${backToMe}`);

const tooHigh = await callBuy(live.args.curve, quoteIn, quoteIn / 10n, REFERRER, 0n);
ok('a 10 % fee is refused (FeeTooHigh)', !tooHigh.ok && /FeeTooHigh/.test(tooHigh.error), tooHigh.error);
const mismatch = await callBuy(live.args.curve, quoteIn, feeWei, REFERRER, refWei, quoteIn);
ok('sending less than quoteIn + fee is refused (ValueMismatch)', !mismatch.ok && /ValueMismatch/.test(mismatch.error), mismatch.error);
const refTooHigh = await callBuy(live.args.curve, quoteIn, feeWei, REFERRER, feeWei + 1n);
ok('a referrer share above the fee is refused', !refTooHigh.ok && /ReferrerShareTooHigh/.test(refTooHigh.error), refTooHigh.error);

console.log(`\nrouter: ${passed} checks passed against the live chain (nothing deployed, nothing spent)`);
process.exit(0);
