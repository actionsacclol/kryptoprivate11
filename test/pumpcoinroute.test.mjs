// pump.fun's single-coin read moved on 2026-09-26 (~07:47Z): `/coins/{mint}`
// answers 404 "Cannot GET" for every mint; pump's web app reads
// `/coins-v3/{mint}` and `/coins-v2/{mint}` also answers, same record shape.
//
// Pinned here: the provider reads the new route, falls back in order when a
// route is GONE, and never mistakes "no such coin" for "route gone" (v3 says
// unknown with 200 null, v2 with 404) — and a 429 is not a reason to switch.
// No network: fetch is stubbed.
import assert from 'node:assert';
import { coinOrError, coinRouteIndex, resetCoinRoute, COIN_ROUTES } from './.pumpfunprovider.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

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
const cannotGet = (u) => json({ statusCode: 404, message: `Cannot GET ${u.pathname}`, error: 'Not Found' }, 404);
const MINT = 'CfHi2yep72TgLNVUrcVitqjZ3NnDWZcttqzrJfMJpump';
const rec = { mint: MINT, name: 'Doomscroll Fly', created_timestamp: 1790348707000, complete: false, creator: 'FZ5fnxCDRWpAfWbeuU4AphdyLjkTVQKSJbsNoYPm2tJg' };

{
  assert.ok(COIN_ROUTES[0].path(MINT).startsWith('/coins-v3/'), 'the web app’s own route is tried first');
  assert.equal(COIN_ROUTES[COIN_ROUTES.length - 1].path(MINT), `/coins/${MINT}`, 'the old route stays, last');
  resetCoinRoute();
  stub((u) => (u.pathname.startsWith('/coins-v3/') ? json(rec) : cannotGet(u)));
  const r = await coinOrError(MINT);
  assert.equal(r.coin?.mint, MINT);
  assert.equal(r.error, null);
  assert.deepEqual(hits, [`/coins-v3/${MINT}`], 'one call when the new route answers');
  ok('/coins-v3/{mint} is read first and its record comes back');
}

{
  // v3 answers an unknown coin with 200 null — that is "no such coin", and it
  // must not send the next read to another route.
  resetCoinRoute();
  stub(() => json(null));
  const r = await coinOrError('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  assert.equal(r.coin, null);
  assert.equal(r.error, null, 'unknown is not an error');
  assert.equal(hits.length, 1);
  assert.equal(coinRouteIndex(), 0, 'an unknown coin does not move the route');
  ok('an unknown coin on v3 (200 null) is null, one call, route unchanged');
}

{
  // v3 gone → v2; and the NEXT read goes straight to v2.
  resetCoinRoute();
  stub((u) => (u.pathname.startsWith('/coins-v2/') ? json(rec) : cannotGet(u)));
  const r = await coinOrError(MINT);
  assert.equal(r.coin?.mint, MINT);
  assert.deepEqual(hits, [`/coins-v3/${MINT}`, `/coins-v2/${MINT}`]);
  assert.equal(coinRouteIndex(), 1, 'the gone route is remembered');
  stub((u) => (u.pathname.startsWith('/coins-v2/') ? json(rec) : cannotGet(u)));
  await coinOrError(MINT);
  assert.deepEqual(hits, [`/coins-v2/${MINT}`], 'no second call to a route proven gone');
  ok('a 404 on v3 (which never 404s a coin) falls back to v2 and stays there');
}

{
  // v2 answers an unknown coin with 404 "Coin not found" — an ANSWER. It must
  // neither walk on to the dead legacy route nor retire v2.
  stub((u) => json({ statusCode: 404, message: `Coin not found for mint: x`, error: 'Not Found' }, 404));
  const r = await coinOrError('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  assert.equal(r.coin, null);
  assert.equal(r.error, null, 'a coin pump does not know is unknown, not a failure');
  assert.equal(hits.length, 1, 'no walk to the legacy route');
  assert.equal(coinRouteIndex(), 1, 'v2 is not retired by an unknown coin');
  ok('a 404 from v2 is "no such coin", not a gone route');
}

{
  // Last, because a 429 parks the provider: a throttle says nothing about
  // the route and must not switch it, and it is reported, not turned into null.
  resetCoinRoute();
  stub(() => new Response('error code: 1015', { status: 429, headers: { 'retry-after': '1' } }));
  const r = await coinOrError(MINT, { priority: true });
  assert.equal(r.coin, null);
  assert.ok(r.error && r.error.includes('429'), `the throttle is reported: ${r.error}`);
  assert.equal(hits.length, 1);
  assert.equal(coinRouteIndex(), 0, 'a 429 does not retire a route');
  ok('a 429 is reported as a failure and never moves the route');
}

console.log(`\npumpcoinroute: ${passed}/${passed} passed`);
