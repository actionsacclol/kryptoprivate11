// `/callout/top/{mint}` answers 404 "Cannot GET" since 2026-09-26. Pinned:
// the provider retires it on a 404 (one wasted call, not one per coin),
// falls back to the coin's rows in the global feed, and never answers `[]`
// from that fallback — a coin missing from the feed has not been shown to
// have no calls. A throttle is not a gone route. No network: fetch is stubbed.
import assert from 'node:assert';
import fs from 'node:fs';
import { calloutsForMint, resetCoinRouteForTests, lastCalloutError } from './.pumpcallouts.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const feed = JSON.parse(fs.readFileSync('test/fixtures/pump-callouts.json', 'utf8'));
const CALLED = feed.coins[0].coinMint;
const NOT_IN_FEED = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

let hits = [];
function stub(handler) {
  hits = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    hits.push(u.pathname);
    return handler(u);
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const routeGone = (u) =>
  u.pathname === '/home-feed' ? json(feed) : json({ statusCode: 404, message: `Cannot GET ${u.pathname}`, error: 'Not Found' }, 404);

{
  resetCoinRouteForTests();
  stub(routeGone);
  const rows = await calloutsForMint(CALLED, 'solana');
  assert.ok(Array.isArray(rows) && rows.length === 1, 'the feed’s row for this coin comes back');
  assert.equal(rows[0].mint, CALLED);
  assert.equal(rows[0].coinCallouts, feed.coins[0].position.totalCallouts, 'with the coin’s own count, so the panel can say "1 of N"');
  assert.deepEqual(hits, [`/callout/top/${CALLED}`, '/home-feed']);
  ok('a gone /callout/top falls back to the coin’s feed rows');
}

{
  // The route is retired: the next coin does not ask it again.
  stub(routeGone);
  const rows = await calloutsForMint(NOT_IN_FEED, 'solana');
  assert.equal(rows, null, 'not in the feed is NOT "no calls" — it is unanswered');
  assert.ok(!hits.some((p) => p.startsWith('/callout/top/')), 'no second request to a route proven gone');
  assert.ok(/no longer serves/.test(lastCalloutError() ?? ''), `and the reason is said: ${lastCalloutError()}`);
  ok('a coin missing from the feed is null with a reason, never []; the dead route is not re-asked');
}

{
  // If pump brings the route back, it is used again once the retry is due.
  resetCoinRouteForTests();
  stub((u) => (u.pathname.startsWith('/callout/top/') ? json({ callouts: [] }) : json(feed)));
  // A different chain is a different memo key, so this is a fresh read.
  const rows = await calloutsForMint(NOT_IN_FEED, 'robinhood');
  assert.deepEqual(rows, [], 'the real route’s [] IS "no calls"');
  assert.deepEqual(hits, [`/callout/top/${NOT_IN_FEED}`]);
  ok('a working /callout/top is still read first and its [] is an answer');
}

{
  // Last: a 429 parks the host. A throttle says nothing about the route.
  resetCoinRouteForTests();
  stub(() => new Response('error code: 1015', { status: 429, headers: { 'retry-after': '1' } }));
  const rows = await calloutsForMint(CALLED, 'bnb');
  assert.equal(rows, null);
  assert.deepEqual(hits, [`/callout/top/${CALLED}`], 'no fallback on a throttle, and no feed call into a park');
  ok('a 429 is unanswered, not a gone route');
}

console.log(`\npumpcalloutsroute: ${passed}/${passed} passed`);
