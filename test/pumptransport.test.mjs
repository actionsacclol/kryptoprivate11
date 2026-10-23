// pump.fun transport (2026-10-22, see fixpump.md): requests leave through
// Chromium's stack, sign-in/register fall back to a hidden pump.fun page, and
// only a challenge that survives BOTH raises the Cloudflare wall.

import assert from 'node:assert';
import fs from 'node:fs';
import * as wall from './.pumpwall.mjs';

let passed = 0;
async function test(name, fn) {
  wall._reset();
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const URL_AUTH = 'https://frontend-api-v3.pump.fun/auth/register';
const challenge = () =>
  new Response('<title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } });
const json404 = () => new Response('{"error":"ACCOUNT_NOT_FOUND"}', { status: 404, headers: { 'content-type': 'application/json' } });

await test('requests go out through the registered transport, not Node fetch', async () => {
  let main = 0;
  wall.setTransport(async () => {
    main += 1;
    return json404();
  });
  const r = await wall.pumpFetch('https://frontend-api-v3.pump.fun/users/x');
  assert.equal(r.status, 404);
  assert.equal(main, 1);
  assert.ok(!wall.wallUp(), 'a real answer from pump is not a wall');
});

await test('sign-in falls back to the hidden page when the transport is challenged', async () => {
  let page = 0;
  wall.setTransport(async () => challenge(), async () => {
    page += 1;
    return json404();
  });
  const r = await wall.pumpAuthFetch(URL_AUTH, { method: 'POST', body: '{}' });
  assert.equal(r.status, 404, 'pump’s own answer came back through the page');
  assert.equal(page, 1);
  assert.ok(!wall.wallUp(), 'no wall: the page got through');
});

await test('an ordinary call never uses the hidden page, and a challenge raises the wall', async () => {
  let page = 0;
  wall.setTransport(async () => challenge(), async () => {
    page += 1;
    return json404();
  });
  await assert.rejects(wall.pumpFetch('https://frontend-api-v3.pump.fun/home-feed'), (e) => e.pumpWall === true);
  assert.equal(page, 0);
  assert.ok(wall.wallUp());
});

await test('a challenge that survives the page too raises the wall', async () => {
  wall.setTransport(async () => challenge(), async () => challenge());
  await assert.rejects(wall.pumpAuthFetch(URL_AUTH, { method: 'POST', body: '{}' }), (e) => e.pumpWall === true && /Cloudflare/.test(e.message));
  assert.ok(wall.wallUp());
});

await test('a hidden page that cannot open fails safe into the wall, not a crash', async () => {
  wall.setTransport(async () => challenge(), async () => {
    throw new Error('no browser available');
  });
  await assert.rejects(wall.pumpAuthFetch(URL_AUTH, { method: 'POST', body: '{}' }), (e) => e.pumpWall === true);
  assert.ok(wall.wallUp());
});

await test('the hidden window is locked to one host, and only sign-in/register use it', async () => {
  const b = fs.readFileSync(new URL('../electron/system/pumpBrowser.ts', import.meta.url), 'utf8');
  assert.match(b, /u\.host !== PUMP_API_HOST/);
  assert.match(b, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(b, /setPermissionRequestHandler/);
  assert.match(b, /nodeIntegration: false/);
  const a = fs.readFileSync(new URL('../electron/system/pumpAuth.ts', import.meta.url), 'utf8');
  assert.equal((a.match(/pumpAuthFetch\(/g) ?? []).length, 2, 'login and register, nothing else');
  const t = fs.readFileSync(new URL('../electron/system/pumpTransport.ts', import.meta.url), 'utf8');
  assert.match(t, /setTransport\(pumpFetch\)/, 'the wall sends through pumpFetch');
  const f = fs.readFileSync(new URL('../electron/system/pumpFetch.ts', import.meta.url), 'utf8');
  assert.match(f, /credentials: 'omit'/, 'no cookie jar shared between wallets');
  const m = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(m, /installPumpTransport\(\)/, 'the transport is installed at startup');
  assert.match(m, /pumpSocial\.startReferralRetries\(\)/, 'leftover referrals resume at startup');
});

console.log(`\npumptransport: ${passed}/${passed} passed`);
