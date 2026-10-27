// Signing in to pump.fun in the user's own browser (2026-10-25).
//
// pump refuses a wallet sign-in for an account with an email or social login
// (409 "Wallet belongs to an existing Privy account", seen 10-23), and Google
// refuses OAuth in a browser with a debugging port. So the window the user
// signs in through must NEVER have a port; only the headless read after it
// closes does.
import assert from 'node:assert';
import fs from 'node:fs';
import * as b from './.pumpbrowsersignin.mjs';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};

{
  assert.deepEqual(b.parseDevToolsActivePort('53123\n/devtools/browser/0b5c-9f2e\n'), { port: 53123, wsPath: '/devtools/browser/0b5c-9f2e' });
  assert.deepEqual(b.parseDevToolsActivePort('9222\r\n/devtools/browser/abc'), { port: 9222, wsPath: '/devtools/browser/abc' });
  assert.equal(b.parseDevToolsActivePort(''), null);
  assert.equal(b.parseDevToolsActivePort('0\n/devtools/browser/x'), null);
  assert.equal(b.parseDevToolsActivePort('70000\n/devtools/browser/x'), null);
  assert.equal(b.parseDevToolsActivePort('9222\n//evil.example/devtools/browser/x'), null, 'the path cannot carry a host');
  assert.equal(b.parseDevToolsActivePort('9222\n/devtools/page/x'), null);
  ok('DevToolsActivePort: a port and a browser path, nothing else');
}

{
  const jwt = (n) => `eyJ${n}.eyJb.sig${n}`;
  const got = b.pumpSessionCookies([
    { name: 'auth_token', value: jwt(1), domain: '.pump.fun', expires: 100 },
    { name: 'auth_token', value: jwt(2), domain: 'frontend-api-v3.pump.fun', expires: 900 },
    { name: 'auth_token', value: jwt(3), domain: '.notpump.fun', expires: 999 },
    { name: 'auth_token', value: jwt(4), domain: 'pump.fun.evil.com', expires: 999 },
    { name: 'auth_token', value: 'not-a-jwt', domain: '.pump.fun', expires: 999 },
    { name: 'NID', value: jwt(5), domain: '.google.com', expires: 999 },
    { name: 'privy-token', value: jwt(6), domain: '.pump.fun', expires: 999 },
  ]);
  assert.deepEqual(got, [jwt(2), jwt(1)], 'pump.fun domains only, JWT-shaped, newest expiry first');
  assert.deepEqual(b.pumpSessionCookies(null), []);
  const names = b.pumpCookieNames([
    { name: 'cf_clearance', value: 'secret', domain: '.pump.fun' },
    { name: 'x', value: 'y', domain: 'pump.fun', session: true },
    { name: 'NID', value: 'z', domain: '.google.com' },
  ]);
  assert.deepEqual(names, ['cf_clearance', 'x (session)']);
  assert.ok(!names.join().includes('secret'), 'names only, never a value');
  ok('only pump’s auth_token is taken; the log sees cookie names, never values');
}

{
  assert.equal(b.isPrivyRefusal(409, 'pump.fun: Wallet belongs to an existing Privy account'), true);
  assert.equal(b.isPrivyRefusal(401, 'Privy'), false);
  assert.equal(b.isPrivyRefusal(409, 'conflict'), false);
  const w = b.browserCandidates('win32', { LOCALAPPDATA: 'C:\\L', PROGRAMFILES: 'C:\\P', 'PROGRAMFILES(X86)': 'C:\\X' });
  assert.equal(w[0], 'C:\\L\\Google\\Chrome\\Application\\chrome.exe', 'Chrome first');
  assert.ok(w.indexOf('C:\\X\\Microsoft\\Edge\\Application\\msedge.exe') > w.indexOf('C:\\X\\Google\\Chrome\\Application\\chrome.exe'), 'then Edge');
  assert.ok(b.browserCandidates('linux', {}).length > 0);
  ok('the Privy refusal is recognised; Chrome is tried before Edge');
}

{
  const m = src('../electron/system/pumpBrowserSignIn.ts');
  const win = m.slice(m.indexOf('async function signInWindow('), m.indexOf('function devtools('));
  assert.match(win, /spawn\(exe, \[`--user-data-dir=\$\{dir\}`, \.\.\.COMMON_ARGS, '--new-window', PUMP_SIGNIN_URL\]/);
  assert.doesNotMatch(win, /remote-debugging|headless|enable-automation/, 'the sign-in window has no debugging port — Google refuses OAuth with one');
  const read = m.slice(m.indexOf('async function readSession('), m.indexOf('export async function signIn('));
  assert.match(read, /'--headless=new', '--remote-debugging-port=0'/, 'the port is opened only headless, after the window closed');
  assert.match(read, /ws:\/\/127\.0\.0\.1:/, 'loopback only');
  assert.match(read, /Browser\.close/);
  assert.match(m, /pumpAuth\.adoptWebSession\(tok\)/, 'pump says whose session it is; nothing is trusted from the cookie');
  assert.doesNotMatch(m, /logger\.\w+\([^)]*tok\b/, 'a token is never logged');
  const ipc = src('../electron/ipc.ts');
  assert.match(ipc, /ipcMain\.handle\('pump:browserSignIn', async \(\) =>/, 'the renderer supplies nothing — no URL, no wallet');
  assert.match(src('../electron/preload.ts'), /browserSignIn: \(\) => ipcRenderer\.invoke\('pump:browserSignIn'\)/);
  ok('sign-in window without a port; headless loopback read after; pump decides whose session it is');
}

{
  const a = src('../electron/system/pumpAuth.ts');
  assert.match(a, /if \(isPrivyRefusal\(res\.status, why\)\) \{\n\s+return \{ tok: null, why: PRIVY_MESSAGE, noAccount: false, privy: true \};/);
  const renew = a.slice(a.indexOf('export function renewSession('), a.indexOf('setSessionRenewer('));
  assert.match(renew, /if \(r\.privy \|\| gone\) \{\n\s+lapsed\.delete\(walletId\);/, 'a Privy refusal or a deleted wallet stops the 3-hourly retry');
  assert.match(renew, /const gone = all\.length > 0 && !all\.some/, 'an empty wallet list is not "deleted" (fail-open rule)');
  const adopt = a.slice(a.indexOf('export async function adoptWebSession('), a.indexOf('export function claimWebSession('));
  assert.match(adopt, /via: 'web' \}\);\n[\s\S]*lapsed\.delete\(walletId\);/, 'a browser session ends the wallet-key retries for that wallet');
  ok('pumpAuth: Privy refusal named, retries stop, a browser session is filed as web');
}

{
  // A session that ends on its own is SHOWN (10-25: Mainify's died quietly and
  // the page said nothing). Retry, then the browser when pump wants it.
  const a = src('../electron/system/pumpAuth.ts');
  const drop = a.slice(a.indexOf('is no longer valid; signed out'), a.indexOf("lastError = 'A pump.fun session expired"));
  assert.match(drop, /markNeeds\(walletId, s\.address, s\.via === 'web' \? 'browser' : 'expired'\)/, 'a dropped session is listed, a browser one as browser');
  assert.match(a, /if \(r\.privy\) \{\n\s+markNeeds\(walletId, address, 'browser'\);/, 'a Privy refusal lists the wallet for the browser');
  assert.match(a, /reason: prev\?\.reason === 'browser' \? 'browser' : reason/, 'browser is never downgraded to a key retry');
  for (const where of ["via: 'wallet' });\n    needs.delete(walletId);", 'lapsed.delete(walletId);\n  needs.delete(walletId);', 'needs.delete(from);\n  needs.delete(walletId);']) {
    assert.ok(a.includes(where), `cleared on a good sign-in: ${where.slice(0, 30)}`);
  }
  const signOut = a.slice(a.indexOf('export function signOut('), a.indexOf('function tokenFrom('));
  assert.match(signOut, /needs\.clear\(\)/);
  assert.match(signOut, /needs\.delete\(walletId\)/, 'signing out on purpose is not "invalid"');
  assert.match(a, /needsSignIn: \[\.\.\.needs\.values\(\)\]/, 'kept across a restart, with no token in it');
  const page = src('../src/pages/PumpAccounts.tsx');
  assert.match(page, /session invalid/);
  assert.match(page, /n\.reason === 'browser'\)\) \{[\s\S]{0,200}await openBrowser\(\)/, 'Retry falls through to the browser when pump wants the email login');
  ok('an ended session shows as invalid with Retry, and Retry falls through to the browser sign-in');
}

console.log(`\npumpbrowsersignin: ${passed}/${passed} passed`);
