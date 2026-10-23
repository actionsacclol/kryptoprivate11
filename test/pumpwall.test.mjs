// The pump.fun Cloudflare wall (electron/data/pumpWall.ts, 2026-10-22).
//
// Every pump.fun host started answering `cf-mitigated: challenge` after a day
// of the app's own 429 strikes. The rules pinned here:
//   1. one challenge anywhere stops EVERY pump.fun call, app-wide — the
//      account code, the callouts, and the provider layer alike;
//   2. when the wall lapses exactly ONE call goes through to look, and a
//      repeat doubles the wall up to its cap;
//   3. any real answer (even a plain 403 from pump) takes the wall down;
//   4. nothing that talks to pump.fun calls fetch around the gate.
// No network: fetch is stubbed.
import assert from 'node:assert';
import fs from 'node:fs';
import * as wall from './.pumpwall.mjs';
import { getJson } from './.http.mjs';

let hits = 0;
let reply = 'challenge';
globalThis.fetch = async () => {
  hits += 1;
  if (reply === 'throw') throw new Error('fetch failed');
  if (reply === 'challenge') {
    return new Response('<!DOCTYPE html><title>Just a moment...</title>', {
      status: 403,
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    });
  }
  if (reply === 'pump403') return new Response('{"message":"Forbidden"}', { status: 403 });
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const MIN = 60_000;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const rejectsWall = (p) => assert.rejects(p, (e) => e.pumpWall === true && /Cloudflare/.test(e.message) && /wallet and account are fine/.test(e.message));

await test('pump.fun and its subdomains are one zone; lookalikes are not', () => {
  assert.ok(wall.isPumpHost('pump.fun'));
  assert.ok(wall.isPumpHost('frontend-api-v3.pump.fun'));
  assert.ok(wall.isPumpHost('Swap-API.pump.fun'));
  assert.ok(!wall.isPumpHost('notpump.fun'));
  assert.ok(!wall.isPumpHost('pump.fun.evil.com'));
  assert.ok(!wall.isPumpHost('pumpportal.fun'));
});

await test('a challenge throws the wall error, not a 403 the caller reads as "refused"', async () => {
  wall._reset();
  hits = 0;
  reply = 'challenge';
  await rejectsWall(wall.pumpFetch('https://frontend-api-v3.pump.fun/auth/login/token', { method: 'POST' }));
  assert.strictEqual(hits, 1);
  assert.ok(wall.wallUp());
  assert.strictEqual(wall.wallRemainingMs(), 15 * MIN);
});

await test('while the wall stands nothing is sent, on any pump host', async () => {
  hits = 0;
  reply = 'ok';
  await rejectsWall(wall.pumpFetch('https://swap-api.pump.fun/v2/coins/x/trades'));
  await rejectsWall(wall.pumpFetch('https://pump.fun/api/ipfs'));
  assert.strictEqual(hits, 0);
});

await test('when it lapses exactly one call goes to look; a repeat doubles the wall', async () => {
  clock += 15 * MIN;
  hits = 0;
  reply = 'challenge';
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => {
    await gate;
    return realFetch(...a);
  };
  const probe = wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed');
  // A second caller while the probe is out is held back without a request.
  await rejectsWall(wall.pumpFetch('https://frontend-api-v3.pump.fun/users/x'));
  release();
  await rejectsWall(probe);
  globalThis.fetch = realFetch;
  assert.strictEqual(hits, 1);
  assert.strictEqual(wall.wallRemainingMs(), 30 * MIN);
});

await test('the wall is capped at two hours', async () => {
  reply = 'challenge';
  for (let i = 0; i < 6; i += 1) {
    clock += wall.wallRemainingMs();
    await rejectsWall(wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed'));
  }
  assert.strictEqual(wall.wallRemainingMs(), 120 * MIN);
});

await test('a probe that fails without an answer lets the next call look', async () => {
  clock += wall.wallRemainingMs();
  reply = 'throw';
  await assert.rejects(wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed'), /fetch failed/);
  assert.ok(wall.wallUp());
  hits = 0;
  reply = 'ok';
  const res = await wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(hits, 1);
});

await test('a real answer takes the wall down — even a 403 that is pump talking', async () => {
  assert.ok(!wall.wallUp());
  assert.strictEqual(wall.wallRemainingMs(), 0);
  reply = 'challenge';
  await rejectsWall(wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed'));
  clock += wall.wallRemainingMs();
  reply = 'pump403';
  const res = await wall.pumpFetch('https://frontend-api-v3.pump.fun/callout/create', { method: 'POST' });
  assert.strictEqual(res.status, 403);
  assert.ok(!wall.wallUp());
  // …and the next challenge starts the ladder over at fifteen minutes.
  reply = 'challenge';
  await rejectsWall(wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed'));
  assert.strictEqual(wall.wallRemainingMs(), 15 * MIN);
  wall._reset();
});

await test('provider layer: a challenge on one pump route stands every pump provider down', async () => {
  hits = 0;
  reply = 'challenge';
  const first = await getJson('pumpfun', '/coins-v3/abc');
  assert.strictEqual(first.ok, false);
  assert.match(first.message, /Cloudflare browser check/);
  assert.strictEqual(hits, 1);
  // A different route, a different pump host, and a priority call: none sent.
  hits = 0;
  reply = 'ok';
  const list = await getJson('pumpfun', '/coins?creator=x&limit=1');
  const swap = await getJson('pumpswap', '/v2/coins/abc/trades');
  const prio = await getJson('pumpfun', '/coins-v3/abc', { priority: true });
  for (const r of [list, swap, prio]) {
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /Cloudflare browser check/);
  }
  assert.strictEqual(hits, 0);
});

await test('provider layer: the wall leaves no route park behind once it lifts', async () => {
  clock += 15 * MIN;
  hits = 0;
  reply = 'ok';
  const r = await getJson('pumpfun', '/coins-v3/abc');
  assert.strictEqual(r.ok, true);
  const again = await getJson('pumpfun', '/coins-v3/def');
  assert.strictEqual(again.ok, true);
  assert.strictEqual(hits, 2);
});

await test('nothing that talks to pump.fun calls fetch around the gate', () => {
  const files = [
    'electron/system/pumpAuth.ts',
    'electron/system/pumpProfile.ts',
    'electron/system/pumpRewards.ts',
    'electron/system/pumpSocial.ts',
    'electron/system/launchMeta.ts',
    'electron/engine/autoCallout.ts',
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/(?<![\w.])fetch\(/.test(src), `${f} calls fetch directly`);
    assert.ok(src.includes('pumpFetch('), `${f} no longer uses pumpFetch`);
  }
  const http = fs.readFileSync('electron/data/http.ts', 'utf8');
  assert.ok(http.includes('(pump ? pumpFetch : fetch)('), 'http.ts sends pump calls around the gate');
});

Date.now = realNow;
console.log(`\n${passed} passed`);
