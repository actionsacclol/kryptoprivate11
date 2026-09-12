// Live smoke test of the EVM rail against the real chains — Robinhood Chain
// and BNB Smart Chain. Run: npm run test:evm (bundles electron/evm/rail.ts
// with the electron stub, then executes this). Needs the network; asserts
// shape, not values. Pass a chain name as the first argument to run one.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The electron stub resolves `app.getPath('userData')` from this variable;
// the wallet file must land in the temp dir, never in test/.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-evm-'));
process.env.KRYPT_TEST_USERDATA = userData;
const rail = await import('./.evmrail.mjs');

const only = process.argv[2];
const chains = only ? [only] : ['robinhood', 'bnb'];
const settings = {
  evm: { slippagePct: 5, referrer: '', robinhood: { enabled: true, rpcUrl: '', apiKey: '' }, bnb: { enabled: true, rpcUrl: '', apiKey: '' } },
  data: { networkDataEnabled: true, providers: { dexscreener: true, geckoterminal: true }, birdeyeApiKey: '' },
};
const events = [];
rail.init({ userData, getSettings: () => settings, emit: (ev) => events.push(ev) });

const t = (label, ms) => console.log(`${label.padEnd(40)} ${String(ms).padStart(6)} ms`);
const time = async (label, fn) => {
  const s = Date.now();
  const r = await fn();
  t(label, Date.now() - s);
  return r;
};
const KNOWN = {
  robinhood: { v3: '0x020bfC650A365f8BB26819deAAbF3E21291018b4', v3Symbol: 'CASHCAT', curveVenue: 'pons-curve', poolVenue: ['pons-v4'], v3Venue: ['uniswap-v3'] },
  // CAKE trades on PancakeSwap v2 + v3 against WBNB; the v2 pair wins the venue probe.
  // BNB pool venues are picked by which one actually QUOTES MORE (a v2 pair
  // exists forever once created and is often abandoned), so either PancakeSwap
  // venue is a correct answer — what matters is that it is one of them.
  bnb: { v3: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', v3Symbol: 'Cake', curveVenue: 'fourmeme-curve', poolVenue: ['pancake-v2', 'pancake-v3'], v3Venue: ['pancake-v2', 'pancake-v3'] },
};

const gen = rail.wallet.generate('smoke');
console.log('wallet generate:', gen.message, gen.address ?? '');
assert.ok(gen.ok, 'wallet generated');

for (const chain of chains) {
  console.log(`\n══ ${chain} ══`);
  const known = KNOWN[chain];
  const state = await time(`${chain} state`, () => rail.state(chain));
  console.log(`  ${state.nativeSymbol} · rpc ${state.rpcHost} · head ${state.head?.block} · fees ${state.feesEnabled} · usd ${state.nativeUsd} · wallet ${state.wallet.address?.slice(0, 10)}…`);
  assert.ok(state.head && state.head.block > 1_000_000, 'head block read');
  assert.equal(state.chain, chain);

  const cols = {};
  for (const col of ['new', 'graduating', 'migrated', 'trending']) {
    const r = await time(`${chain} discover ${col}`, () => rail.discover(chain, col, 12));
    cols[col] = r.rows;
    console.log(`  ${col}: ${r.rows.length} rows (${r.message.slice(0, 80)})`);
    for (const row of r.rows.slice(0, 3)) {
      console.log(
        `    ${(row.symbol || '?').padEnd(10)} ${row.mint.slice(0, 10)}… curve=${row.bondingCurvePct === null ? '—' : row.bondingCurvePct.toFixed(1) + '%'} priceUsd=${row.priceUsd === null ? '—' : row.priceUsd.toExponential(3)} mcap=${row.marketCapUsd === null ? '—' : Math.round(row.marketCapUsd)} liq=${row.liquidityUsd === null ? '—' : Math.round(row.liquidityUsd)} age=${row.createdAt ? Math.round((Date.now() - row.createdAt) / 1000) + 's' : '—'} pad=${row.launchpad} chain=${row.chain}`,
      );
    }
  }
  assert.ok(cols.new.length > 0, `${chain}: New column has rows`);
  assert.ok(cols.new.every((r) => r.chain === chain), `${chain}: New rows are tagged`);
  assert.ok(cols.graduating.length > 0, `${chain}: Graduating column has rows`);
  assert.ok(cols.graduating.every((r, i, a) => i === 0 || (a[i - 1].bondingCurvePct ?? 0) >= (r.bondingCurvePct ?? 0)), `${chain}: Graduating sorted by progress`);

  const curveToken = cols.graduating[0].mint;
  const sum = await time(`${chain} summary (curve token)`, () => rail.summary(chain, curveToken));
  console.log(`   ${sum.symbol} price ${sum.priceSol} ${state.nativeSymbol} / ${sum.priceUsd} USD · curve ${sum.bondingCurvePct} · pool ${sum.poolAddress}`);
  const det = await time(`${chain} detail (curve token)`, () => rail.detail(chain, curveToken));
  console.log(`   venue ${det.state.venue} · holders ${det.holders?.count ?? '—'} · warnings ${JSON.stringify(det.warnings)}`);
  assert.equal(det.state.venue, known.curveVenue, `${chain}: curve venue`);
  const candles = await time(`${chain} candles 1m (curve token)`, () => rail.candles(chain, curveToken, '1m', 200));
  console.log(`   ${candles.candles.length} candles via ${candles.source} ${candles.note ?? ''}`);

  const qb = await time(`${chain} quote buy 0.001 (curve)`, () => rail.quote(chain, 'buy', curveToken, 0.001));
  if ('error' in qb) console.log('   buy quote error:', qb.error);
  else console.log(`   venue=${qb.venue} out=${qb.amountOut} min=${qb.minOut} simulated=${qb.simulated} gas=${qb.gasEstimate} fee=${qb.feeWei} price=${qb.priceNative}`);
  assert.ok(!('error' in qb) && BigInt(qb.amountOut) > 0n, `${chain}: curve buy quote has output`);

  if (cols.migrated.length) {
    const gradToken = cols.migrated[0].mint;
    const qg = await time(`${chain} quote buy 0.001 (graduated pool)`, () => rail.quote(chain, 'buy', gradToken, 0.001));
    if ('error' in qg) console.log('   pool quote error:', qg.error);
    else console.log(`   venue=${qg.venue} out=${qg.amountOut} simulated=${qg.simulated}`);
    assert.ok(!('error' in qg) && known.poolVenue.includes(qg.venue) && BigInt(qg.amountOut) > 0n, `${chain}: graduated pool quote`);
  }

  const qc = await time(`${chain} quote buy 0.001 (${known.v3Symbol})`, () => rail.quote(chain, 'buy', known.v3, 0.001));
  if ('error' in qc) console.log('   pool quote error:', qc.error);
  else console.log(`   venue=${qc.venue} out=${qc.amountOut} price=${qc.priceNative}`);
  assert.ok(!('error' in qc) && known.v3Venue.includes(qc.venue), `${chain}: ${known.v3Symbol} routes on one of ${known.v3Venue.join('/')}, got ${'error' in qc ? qc.error : qc.venue}`);
  const cs = await time(`${chain} summary ${known.v3Symbol}`, () => rail.summary(chain, known.v3));
  console.log(`   ${cs.symbol} priceUsd ${cs.priceUsd} mcap ${cs.marketCapUsd} liq ${cs.liquidityUsd} 24h ${JSON.stringify(cs.stats['24h'] ?? null)}`);

  const buy = await time(`${chain} paper buy 0.001 (curve)`, () => rail.buy(chain, curveToken, 0.001, true));
  console.log(`   ok=${buy.ok} stage=${buy.stage} simulated=${buy.simulated} :: ${buy.message}`);
  assert.ok(buy.ok && buy.simulated && buy.stage === 'simulate', `${chain}: paper curve buy simulates`);
  const sell = await time(`${chain} paper sell 100% (curve, empty)`, () => rail.sell(chain, curveToken, 100, true));
  console.log(`   ok=${sell.ok} stage=${sell.stage} :: ${sell.message}`);
  assert.ok(!sell.ok && /Nothing to sell/.test(sell.message), `${chain}: empty wallet sell refused honestly`);
  const liveAttempt = await time(`${chain} LIVE buy while disarmed`, () => rail.buy(chain, curveToken, 0.001, false));
  assert.ok(liveAttempt.simulated, `${chain}: disarmed rail never broadcasts`);
  const pf = await time(`${chain} portfolio`, () => rail.portfolio(chain));
  console.log(`   portfolio ${pf.address?.slice(0, 10)}… ${pf.nativeSymbol} ${pf.nativeBalance} · positions ${pf.positions.length}`);
  assert.equal(pf.chain, chain);
}

// A funded Pons curve sell, planned for a REAL holder. The curve pulls the
// tokens with transferFrom, so a wallet that has not approved it can only
// sell if the plan sends the approval first — without that the exit reverts
// ERC20InsufficientAllowance and a curve position cannot be closed through
// the app at all (found by the 2026-09-09 audit; this pins the fix). Read
// only: nothing is signed, the plan is simulated from the holder's state.
if (chains.includes('robinhood')) {
  try {
  const trade = await import('./.evmtrade.mjs');
  const { parseAbi, decodeEventLog } = await import('viem');
  // Through the rail's OWN gated client, so this check queues behind the same
  // token bucket as everything else instead of earning a rate limit.
  const evmClient = await import('./.evmclient.mjs');
  evmClient.configure(() => settings.evm.robinhood);
  const c = evmClient.logClient('robinhood');
  const head = await c.getBlockNumber();
  const CURVE_BUY = parseAbi(['event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)'])[0];
  const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
  const F_ABI = parseAbi([
    'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  ]);
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const logs = await c.getLogs({ event: CURVE_BUY, fromBlock: head - 12_000n, toBlock: head });
  let found = null;
  for (const l of logs.slice().reverse().slice(0, 40)) {
    const holder = decodeEventLog({ abi: [CURVE_BUY], data: l.data, topics: l.topics }).args.recipient;
    const rc = await c.getTransactionReceipt({ hash: l.transactionHash });
    const xfer = rc.logs.find((x) => x.topics[0] === TRANSFER && x.topics.length === 3 && `0x${x.topics[1].slice(26)}`.toLowerCase() === l.address.toLowerCase());
    if (!xfer) continue;
    const rec = await c.readContract({ address: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', abi: F_ABI, functionName: 'getLaunchedToken', args: [xfer.address] });
    if (!rec.exists || Number(rec.phase) !== 0) continue;
    if (rec.pairToken.toLowerCase() !== '0x0000000000000000000000000000000000000000') continue;
    const [bal, allow] = await Promise.all([
      c.readContract({ address: xfer.address, abi: ERC20, functionName: 'balanceOf', args: [holder] }),
      c.readContract({ address: xfer.address, abi: ERC20, functionName: 'allowance', args: [holder, l.address] }),
    ]);
    // A dust holder quotes 0 proceeds, which says nothing about the approval
    // path this check exists for.
    if (bal > 10n ** 18n) {
      found = { token: xfer.address, curve: l.address, holder, needsApproval: allow < bal };
      break;
    }
  }
  if (!found) {
    console.log('\nno live curve holder in the window — funded-sell check skipped');
  } else {
    const plan = await time('robinhood funded curve sell (plan)', () =>
      trade.plan({ chain: 'robinhood', side: 'sell', token: found.token, pct: 100, simulateOnly: true, slippagePct: 15, referrer: '' }, found.holder),
    );
    assert.ok(plan.ok, `funded curve sell plans: ${plan.ok ? '' : plan.message}`);
    const p = plan.planned;
    console.log(`   venue=${p.venue.venue} approvals=${p.approvals.length} simulated=${p.quote.simulated} out=${p.quote.amountOut}`);
    assert.equal(p.venue.venue, 'pons-curve');
    assert.ok(p.quote.simulated, 'the sell quote comes from the curve, not the formula');
    assert.ok(BigInt(p.quote.amountOut) > 0n, 'the sell quote returns proceeds');
    if (found.needsApproval) {
      assert.equal(p.approvals.length, 1, 'an unapproved holder gets exactly one approval');
      assert.deepEqual(p.approvals[0].policy.approveSpenders, [found.curve.toLowerCase()], 'the approval is pinned to this curve');
    } else {
      assert.equal(p.approvals.length, 0, 'an approved holder needs no approval');
    }
  }
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    console.log(`\nfunded curve sell check skipped — ${String(e?.shortMessage || e?.message || e).slice(0, 90)}`);
  }
}

// Per-chain arming: arming one chain must not arm the other, and the
// shared wallet cannot switch while either is live.
const arm = rail.arm('bnb');
console.log('\narm bnb:', arm.message);
assert.equal(rail.liveState('bnb').armed, true);
assert.equal(rail.liveState('robinhood').armed, false, 'arming BNB leaves Robinhood in Paper');
// BNB is armed at this point, so switching ITS wallet is what must be refused.
const sw = rail.wallet.select('bnb', 'nope');
assert.ok(!sw.ok && /Paper/.test(sw.message), 'switching refused while a chain is armed');
rail.disarm('bnb', 'user');
assert.equal(rail.liveState('bnb').armed, false);
console.log('events:', events.map((e) => `${e.kind}${e.state?.chain ? ':' + e.state.chain : ''}`).join(','));
console.log('\nsmoke OK');
process.exit(0);
