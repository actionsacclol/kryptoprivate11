// The account step pump added on 2026-10-22.
//
// OBSERVED that day with throwaway keys: a new address can no longer sign in
// until it registers — login → 404 ACCOUNT_NOT_FOUND → POST /auth/register
// (the same signed body, plus an Origin header) → login works. A wallet that
// already has an account never sees the 404.

import assert from 'node:assert';
import fs from 'node:fs';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};

{
  const s = src('../shared/pumpAuth.ts');
  assert.match(s, /export const PUMP_REGISTER_PATH = '\/auth\/register';/);
  assert.match(s, /export const PUMP_NO_ACCOUNT = 'ACCOUNT_NOT_FOUND';/);
  ok('the register route and pump’s no-account code are constants');
}

{
  // Register ONLY on pump's "no account" answer, with the Origin header its
  // guard asks for, then a FRESH signature for the login proper.
  const a = src('../electron/system/pumpAuth.ts');
  const reg = a.slice(a.indexOf('async function register('), a.indexOf('export async function signIn('));
  assert.match(reg, /pumpAuthFetch\(urlFor\(PUMP_REGISTER_PATH\)/, 'register goes to the constant route, through the Cloudflare stand-down (pumpWall.ts)');
  assert.match(reg, /origin: 'https:\/\/pump\.fun'/, 'with the Origin header (400 without it)');
  assert.match(reg, /redirect: 'error'/);
  assert.match(a, /res\.status === 404 && r\.code === PUMP_NO_ACCOUNT/, 'only ACCOUNT_NOT_FOUND triggers it');
  const sign = a.slice(a.indexOf('export async function signIn('), a.indexOf('export async function refreshProfile('));
  const at = sign.indexOf('register(first.body)');
  assert.ok(at > 0 && sign.indexOf('first = signedBody(walletId)', at) > 0, 'a fresh signature is made after register, not a replay');
  ok('a new wallet is registered on ACCOUNT_NOT_FOUND, with Origin, then signs in fresh');
}

console.log(`\npumpregister: ${passed}/${passed} passed`);
