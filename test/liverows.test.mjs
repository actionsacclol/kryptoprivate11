// A Discover row built from our own tape.
//
// The New column used to be entirely provider-fed, so a pump.fun park froze
// the fastest list in the app. The scanner already decodes every create off
// the websocket for free; this turns one into a row. The rules that matter:
//
//   1. it never invents what the tape cannot see (volume, holders, a
//      5-minute change on a four-second-old token);
//   2. a provider row keeps its own richer fields and takes only the two
//      numbers the tape is genuinely fresher about;
//   3. an old launch the tape still remembers is not "new".

import assert from 'node:assert';
import {
  summaryFromLaunch,
  fillFromLive,
  mergeLiveLaunches,
  newLiveRows,
  impliedSolUsd,
  PUMP_TOTAL_SUPPLY,
} from './.liverows.mjs';
import { emptySummary } from './.marketshared.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const launch = (over = {}) => ({
  mint: 'Mnt1',
  name: 'Test Coin',
  symbol: 'TEST',
  uri: '',
  creator: 'Crt1',
  bondingCurve: 'Curve1',
  signature: 'Sig1',
  slot: 1,
  detectedAt: Date.now(),
  phase: 'live',
  riskFlags: [],
  flow: { uniqueBuyers: 3, buys: 4, sells: 0, buyVolumeSol: 1, sellVolumeSol: 0, netInflowSol: 1, buyerAcceleration: 1, topBuyerShare: 0.2, creatorSold: false, curveProgressPct: 12.5, distinctSellers: 0, topHolderTokenShare: 0.1, earlyBuyerShare: 0.3 },
  score: null,
  priceSol: 0.00000004,
  priceHistory: [],
  reason: null,
  creatorPriorLaunches: 0,
  creatorPriorRugs: 0,
  smartBuyerCount: 0,
  smartEarly: false,
  ...over,
});

{
  const r = summaryFromLaunch(launch(), 200);
  assert.equal(r.mint, 'Mnt1');
  assert.equal(r.symbol, 'TEST');
  assert.equal(r.launchpad, 'pumpfun');
  assert.equal(r.priceSol, 0.00000004);
  assert.equal(r.priceUsd, 0.00000004 * 200);
  assert.equal(r.marketCapUsd, 0.00000004 * 200 * PUMP_TOTAL_SUPPLY);
  assert.equal(r.bondingCurvePct, 12.5);
  assert.equal(r.liveTracked, true, 'the engine IS tracking it — that is where the row came from');
  assert.equal(r.sources.price, 'engine');
  ok('a launch becomes a row with price, market cap and curve progress');
}

{
  // The honest-null rule, on the one surface most tempted to break it: a
  // four-second-old token has no 24h volume, and 0 would read as "nobody is
  // trading this" rather than "nobody has counted yet".
  const r = summaryFromLaunch(launch(), 200);
  assert.deepEqual(r.stats, {}, 'no window stats are invented');
  assert.equal(r.holders, null);
  assert.equal(r.liquidityUsd, null);
  assert.equal(r.top10Pct, null);
  assert.equal(r.kryptScore, null);
  assert.equal(r.imageUrl, null);
  ok('what the tape cannot see stays null, never zero');
}

{
  // No SOL price yet: the SOL figure still stands, the USD ones do not get
  // guessed at.
  const r = summaryFromLaunch(launch(), null);
  assert.equal(r.priceSol, 0.00000004);
  assert.equal(r.priceUsd, null);
  assert.equal(r.marketCapUsd, null, 'a market cap needs a SOL price — it is not 0');
  ok('with no SOL price, USD stays unknown rather than zero');
}

{
  const provider = emptySummary('Mnt1');
  provider.name = 'Test Coin';
  provider.symbol = 'TEST';
  provider.imageUrl = 'https://img/x.png';
  provider.marketCapUsd = 9_000;
  provider.liquidityUsd = 4_000;
  provider.holders = 41;
  provider.priceSol = 0.00000001; // a stale poll
  provider.bondingCurvePct = 4;
  provider.stats = { '5m': { priceChangePct: 12, volumeUsd: 500, buys: 9, sells: 1, traders: 7, organicVolumeUsd: null } };

  const merged = fillFromLive(provider, summaryFromLaunch(launch(), 200));
  assert.equal(merged.imageUrl, 'https://img/x.png', 'the provider keeps what only it has');
  assert.equal(merged.holders, 41);
  assert.equal(merged.liquidityUsd, 4_000);
  assert.deepEqual(merged.stats, provider.stats, 'and its window stats are untouched');
  assert.equal(merged.marketCapUsd, 9_000, "the venue's own market cap is not overruled by our arithmetic");
  assert.equal(merged.priceSol, 0.00000004, 'but the tape is fresher on price');
  assert.equal(merged.bondingCurvePct, 12.5, 'and on curve progress');
  assert.equal(merged.sources.price, 'engine');
  assert.equal(merged.liveTracked, true);
  ok('a provider row keeps its own fields and takes only what the tape is fresher about');
}

{
  const byMint = new Map();
  const fresh = launch({ mint: 'New1' });
  const old = launch({ mint: 'Old1', detectedAt: Date.now() - 6 * 60 * 60_000 });
  const added = mergeLiveLaunches(byMint, [fresh, old], 200, 60 * 60_000);
  assert.equal(added, 1, 'only the fresh one joined the column');
  assert.ok(byMint.has('New1'));
  assert.ok(!byMint.has('Old1'), 'a launch the tape still remembers from six hours ago is not new');
  ok('the column’s own age limit decides, not what the tape remembers');
}

{
  // The merge must not double-count a mint the providers already returned:
  // one card per token, or the column shows the same coin twice.
  const byMint = new Map();
  const existing = emptySummary('Mnt1');
  existing.symbol = 'TEST';
  byMint.set('Mnt1', existing);
  const added = mergeLiveLaunches(byMint, [launch()], 200, 60 * 60_000);
  assert.equal(added, 0, 'it enriched a row rather than adding one');
  assert.equal(byMint.size, 1);
  assert.equal(byMint.get('Mnt1').priceSol, 0.00000004);
  ok('a mint the providers already listed is enriched, never duplicated');
}

{
  // The scanner being off is not an error and not an empty market.
  const byMint = new Map();
  assert.equal(mergeLiveLaunches(byMint, [], 200, 60_000), 0);
  assert.equal(byMint.size, 0);
  ok('no scanner, no live rows, no complaints');
}

{
  // The renderer's half: ADDS only. Enriching a row that is already drawn
  // would hand every memoised card a new object every second, which is the
  // same screen rendered forty times as often - not a smoother one.
  const drawn = emptySummary('Mnt1');
  drawn.symbol = 'TEST';
  drawn.priceSol = 0.00000001;
  const rows = newLiveRows([drawn.mint], [launch(), launch({ mint: 'Mnt2', detectedAt: Date.now() - 10 })], 200, 60_000);
  assert.equal(rows.length, 1, 'only the mint nothing has drawn yet');
  assert.equal(rows[0].mint, 'Mnt2');
  assert.equal(drawn.priceSol, 0.00000001, 'the drawn row is untouched');
  ok('the between-polls pass adds rows and never rewrites the ones on screen');
}

{
  const a = launch({ mint: 'A', detectedAt: 1_000 });
  const b = launch({ mint: 'B', detectedAt: 3_000 });
  const c = launch({ mint: 'C', detectedAt: 2_000 });
  const rows = newLiveRows([], [a, b, c], 200, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(rows.map((r) => r.mint), ['B', 'C', 'A'], 'newest first');
  ok('live rows arrive newest first, whatever order the feed held them in');
}

{
  // The SOL price is already on screen: every priced row carries both sides
  // of it. Asking a provider again to label a one-second-old row would spend
  // a request to learn something the app can divide.
  const priced = emptySummary('P');
  priced.priceSol = 0.5;
  priced.priceUsd = 100;
  assert.equal(impliedSolUsd([emptySummary('X'), priced]), 200);
  assert.equal(impliedSolUsd([emptySummary('X')]), null, 'and it is null, not 0, when nothing is priced');
  const zero = emptySummary('Z');
  zero.priceSol = 0;
  zero.priceUsd = 0;
  assert.equal(impliedSolUsd([zero]), null, 'a zero price is not a rate');
  ok('the SOL rate is derived from rows already fetched, never re-requested');
}

console.log(`\nlive rows: ${passed}/${passed} passed`);
