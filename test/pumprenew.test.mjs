// A pump.fun session that has expired renews itself (2026-10-22): a 401 on a
// call that carried a session token asks the renewer for a fresh token and
// sends the same request once more; pumpAuth registers the renewer, limits it,
// and main starts the keep-alive. Behaviour on the real gate with fetch stubbed.
import assert from 'node:assert';
import fs from 'node:fs';
import * as wall from './.pumpwall.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const json = (status) => new Response('{}', { status, headers: { 'content-type': 'application/json' } });
const URL_ = 'https://frontend-api-v3.pump.fun/auth/my-profile';

{
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    const a = new Headers(init?.headers).get('authorization');
    seen.push(a);
    return a === 'Bearer NEW' ? json(200) : json(401);
  };
  const asked = [];
  try {
    wall._reset();
    wall.setSessionRenewer(async (t) => {
      asked.push(t);
      return 'NEW';
    });
    const hdr = { authorization: 'Bearer OLD', cookie: 'auth_token=OLD' };
    const r = await wall.pumpFetch(URL_, { headers: hdr });
    assert.equal(r.status, 200);
    assert.deepEqual(asked, ['OLD']);
    assert.deepEqual(seen, ['Bearer OLD', 'Bearer NEW']);

    seen.length = 0;
    asked.length = 0;
    assert.equal((await wall.pumpFetch('https://frontend-api-v3.pump.fun/users/x')).status, 401, 'no token, no renewal');
    assert.deepEqual(asked, []);

    wall.setSessionRenewer(async () => null);
    seen.length = 0;
    assert.equal((await wall.pumpFetch(URL_, { headers: hdr })).status, 401);
    assert.equal(seen.length, 1, 'nothing to renew with: the 401 is the answer');

    let n = 0;
    wall.setSessionRenewer(async () => `T${++n}`);
    seen.length = 0;
    assert.equal((await wall.pumpFetch(URL_, { headers: hdr })).status, 401);
    assert.equal(seen.length, 2, 'one retry, never a loop');
  } finally {
    wall._reset();
    globalThis.fetch = realFetch;
  }
  ok('a 401 renews the session and retries once, with the new token in both headers');
}

{
  const a = fs.readFileSync('electron/system/pumpAuth.ts', 'utf8').replace(/\r\n/g, '\n');
  assert.match(a, /setSessionRenewer\(async \(stale\)/, 'pumpAuth registers the renewer');
  assert.match(a, /s\.via === 'wallet'/, 'only wallet sessions renew; a web sign-in has no key');
  assert.match(a, /RENEW_COOLDOWN_MS = 5 \* 60_000/);
  assert.match(a, /now - \(renewTriedAt\.get\(walletId\) \?\? 0\) < RENEW_COOLDOWN_MS/, 'a wallet is not signed in again in a loop');
  assert.match(a, /if \(await renewSession\(walletId\)\) return;[\s\S]*sessions\.delete\(walletId\)/, 'refreshProfile renews before it drops a session');
  assert.match(a, /lapsed\.delete\(walletId\);\n  needs\.delete\(walletId\);\n  lastError = null;/, 'signing out forgets a lapsed wallet (and its signed-out notice)');
  assert.match(a, /export function startSessionKeepAlive/);
  const m = fs.readFileSync('electron/main.ts', 'utf8');
  assert.match(m, /pumpAuth\.startSessionKeepAlive\(\)/, 'main starts the keep-alive');
  ok('pumpAuth renews wallet sessions (limited, signed-out stays out) and main starts the keep-alive');
}

console.log(`\npumprenew: ${passed}/${passed} passed`);
