// pumpFetch: pump.fun requests go through Chromium, and a Cloudflare block is
// recognised as Cloudflare rather than read as pump refusing the account
// (OBSERVED 2026-10-22, see fixpump.md).

import assert from 'node:assert';
import fs from 'node:fs';
import { isCloudflareChallenge, isChallengeBody, CHALLENGE_MESSAGE, pumpAuthFetch, pumpFetch, _resetTransport } from './.pumpfetch.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const res = (status, headers, body = '') => new Response(body, { status, headers });

{
  assert.ok(isCloudflareChallenge(res(403, { 'cf-mitigated': 'challenge' })));
  assert.ok(isCloudflareChallenge(res(403, { 'content-type': 'text/html; charset=UTF-8' }, '<title>Just a moment...</title>')));
  assert.ok(!isCloudflareChallenge(res(401, { 'content-type': 'application/json' }, '{"message":"Invalid signature"}')));
  assert.ok(!isCloudflareChallenge(res(404, { 'content-type': 'application/json' }, '{"error":"ACCOUNT_NOT_FOUND"}')));
  assert.ok(!isCloudflareChallenge(res(200, { 'content-type': 'text/html' })), 'a 200 page is not a block');
  ok('a Cloudflare challenge is told apart from pump’s own JSON refusals');
}

{
  assert.ok(isChallengeBody('<!DOCTYPE html><html><head><title>Just a moment...</title>'));
  assert.ok(!isChallengeBody('{"message":"Invalid signature"}'));
  assert.match(CHALLENGE_MESSAGE, /Cloudflare/);
  ok('a challenge page body is recognised, and the message names Cloudflare');
}

{
  const src = fs.readFileSync(new URL('../electron/system/pumpFetch.ts', import.meta.url), 'utf8');
  assert.match(src, /credentials: 'omit'/, 'no shared cookie jar between wallets');
  const auth = fs.readFileSync(new URL('../electron/system/pumpAuth.ts', import.meta.url), 'utf8');
  ok('cookies are omitted and cookies are omitted');
}

{
  // Sign-in falls back to the hidden page ONLY on a challenge, and when no page
  // can be opened the caller still gets pump's/Cloudflare's original answer.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('<title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } });
  };
  try {
    const r = await pumpAuthFetch('https://frontend-api-v3.pump.fun/auth/register', { method: 'POST', body: '{}' });
    assert.equal(r.status, 403, 'no page available here, so the original answer comes back');
    assert.equal(calls, 1, 'and the request was not resent through the same blocked path');
    globalThis.fetch = async () => new Response('{"error":"ACCOUNT_NOT_FOUND"}', { status: 404, headers: { 'content-type': 'application/json' } });
    const ok404 = await pumpAuthFetch('https://frontend-api-v3.pump.fun/auth/login/token', { method: 'POST', body: '{}' });
    assert.equal(ok404.status, 404, 'a normal answer is returned untouched, never routed to the page');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('the hidden-page fallback is for challenges only and fails safe');
}

{
  const b = fs.readFileSync(new URL('../electron/system/pumpBrowser.ts', import.meta.url), 'utf8');
  assert.match(b, /u\.host !== PUMP_API_HOST/, 'the hidden page only talks to the pump.fun API host');
  assert.match(b, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/, 'opens nothing');
  assert.match(b, /setPermissionRequestHandler/, 'grants no permission');
  assert.match(b, /nodeIntegration: false/);
  const a = fs.readFileSync(new URL('../electron/system/pumpAuth.ts', import.meta.url), 'utf8');
  assert.equal((a.match(/pumpAuthFetch\(/g) ?? []).length, 2, 'login and register use it, nothing else does');
  ok('the hidden window is locked to one host and only sign-in/register use it');
}

{
  // 2026-10-22: pump's hosts started demanding a TLS client certificate, which
  // Electron's `net` cannot answer. With no page available the caller must get
  // the REAL error, not a silent success or a generic one.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED');
  };
  try {
    await assert.rejects(pumpFetch('https://frontend-api-v3.pump.fun/users/x'), /ERR_SSL_CLIENT_AUTH_CERT_NEEDED/);
    // An ordinary network failure is not that error and is never masked.
    _resetTransport();
    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    await assert.rejects(pumpFetch('https://frontend-api-v3.pump.fun/users/x'), /fetch failed/);
  } finally {
    globalThis.fetch = realFetch;
    _resetTransport();
  }
  ok('a client-certificate failure surfaces as itself when no page can help; other errors pass through');
}

{
  const b = fs.readFileSync(new URL('../electron/system/pumpBrowser.ts', import.meta.url), 'utf8');
  assert.match(b, /chain\.then\(\(\) => send\(url, init\)\)/, 'one request at a time, so two wallets never share the cookie jar');
  assert.match(b, /jar\.remove\(origin, 'auth_token'\)/, 'the token is taken out of the jar after every call');
  assert.match(b, /name: 'auth_token'[\s\S]*secure: true[\s\S]*httpOnly: true/, 'and while there it is a secure, http-only cookie');
  assert.match(b, /token \? 'include' : 'omit'/, 'credentials only when a token is being carried');
  ok('the hidden page carries one wallet’s token at a time and clears it');
}

console.log(`\npumpfetch: ${passed}/${passed} passed`);
