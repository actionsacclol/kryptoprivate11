// Signing into pump.fun with a wallet this app holds (2026-09-22).
//
// The property that matters here is not what the code does, it is what it
// CANNOT do: there must be no way, from anywhere, to hand this app's wallet a
// blob of bytes and get a signature back. That is the primitive wallet
// phishing is built on, and adding it beside keys that hold real positions
// would undo the reason every other signing path is a named door with its own
// intent.
//
// The rest pins the honest-refusal behaviour: while the message template is
// unknown, sign-in refuses rather than guessing, because a guess fails at
// pump's server and their error blames our signature.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  loginBodyProblem,
  MAX_ADDRESS_CHARS,
  MAX_SIGNATURE_CHARS,
  PUMP_API_HOST,
  PUMP_LOGIN_PATH,
  pumpLoginMessage,
  pumpLoginReady,
  pumpTimestamp,
  sessionForWallet,
  viewOf,
} from './.pumpauth.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // THE INVARIANT. `signPumpLogin` takes a wallet id and a NUMBER. If anyone
  // ever widens it to take the message, a caller chooses the bytes — and the
  // whole point is that no caller can.
  const w = src('../electron/system/wallet.ts');
  const sig = /export function signPumpLogin\(\s*([^)]*)\)/.exec(w);
  assert.ok(sig, 'signPumpLogin exists');
  const params = sig[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(
    params.map((p) => p.replace(/\s+/g, ' ')),
    ['walletId: string', 'timestamp: number'],
    'signPumpLogin takes only a wallet id and a timestamp — never a message, never bytes',
  );
  // And it builds the message itself rather than being handed one.
  const body = w.slice(w.indexOf('export function signPumpLogin'), w.indexOf('export function publicKeyOf'));
  assert.match(body, /pumpLoginMessage\(timestamp\)/, 'the message is built from the shared template, inside the door');
  assert.match(body, /secret\.fill\(0\)/, 'and the key material is zeroed afterwards, like every other path here');
  ok('the signing door takes a wallet id and a number — bytes cannot reach a signature');
}

{
  // No generic message signer anywhere in main, under any name.
  const files = [
    '../electron/system/wallet.ts',
    '../electron/system/pumpAuth.ts',
    '../electron/ipc.ts',
    '../electron/preload.ts',
  ];
  for (const f of files) {
    const s = src(f);
    // ed25519.sign is the raw primitive: it may appear ONLY inside the named
    // door in wallet.ts, never in a module the renderer can steer.
    if (!f.endsWith('wallet.ts')) {
      assert.doesNotMatch(s, /ed25519\.sign\(/, `${f} must not sign anything itself`);
    }
    assert.doesNotMatch(s, /signMessage\s*[(:]/, `${f} must not expose a generic message signer`);
  }
  const w = src('../electron/system/wallet.ts');
  assert.equal((w.match(/ed25519\.sign\(/g) ?? []).length, 1, 'exactly one place in the app signs a bare message');
  ok('no generic message signer exists in main, and the raw primitive is used in exactly one place');
}

{
  // The renderer can name a wallet and nothing else, and it never receives a
  // token — `status` says WHO is signed in, not what proves it.
  const pre = src('../electron/preload.ts');
  const bridge = pre.slice(pre.indexOf('pump: {'), pre.indexOf('pump: {') + 460);
  assert.match(bridge, /signIn: \(walletId: string\) => ipcRenderer\.invoke\('pump:signIn', walletId\)/, 'sign-in passes a wallet id, nothing more');
  assert.doesNotMatch(bridge, /token/i, 'no token crosses the preload bridge');

  const auth = src('../electron/system/pumpAuth.ts');
  // The function BODY only — the next declaration's doc comment mentions the
  // word and is not what is being checked.
  const statusAt = auth.indexOf('export function status()');
  const status = auth.slice(statusAt, auth.indexOf('\n}', statusAt) + 2);
  assert.doesNotMatch(status, /\btoken\b/, 'the status handed to the renderer carries no token');
  assert.match(status, /\.map\(viewOf\)/, 'every session leaves main through the token-stripping view');
  // The token getter NAMES its wallet, so a caller cannot act as the wrong
  // account by accident.
  assert.match(auth, /export function token\(walletId: string\)/, 'reading a token requires naming the wallet');
  ok('the renderer names a wallet, and no session token ever crosses IPC');
}

{
  // ONE ACCOUNT PER WALLET. Three wallets are three pump accounts, all live at
  // once, because pump ties an account to the address that signed in.
  const auth = src('../electron/system/pumpAuth.ts');
  assert.match(auth, /const sessions = new Map<string, PumpSession>\(\)/, 'sessions are keyed by wallet, not a single slot');
  assert.match(auth, /sessions\.set\(walletId,/, 'signing in files the session under its wallet');
  assert.match(auth, /sessions\.get\(walletId\)/, 'and everything else looks it up by wallet');
  // Signing one wallet out must not touch the others.
  const out = auth.slice(auth.indexOf('export function signOut'), auth.indexOf('function tokenFrom'));
  assert.match(out, /sessions\.delete\(walletId\)/, 'a named wallet is signed out on its own');
  assert.match(out, /sessions\.clear\(\)/, 'and only an unnamed call clears them all');

  // And no second "active account" pointer, which would drift out of step with
  // the app's one idea of which wallet is acting.
  assert.doesNotMatch(auth, /activeAccount|activeSession|activePump/i, 'there is no separate active-account pointer to drift');
  ok('one account per wallet, all live at once, signed out one at a time');
}

{
  // The shared view helpers: a session leaves main without its credential, and
  // "is this wallet signed in" is answered the same way on both sides.
  const s = { address: 'Addr1', walletId: 'w1', token: 'SECRET.JWT.VALUE', at: 5, username: 'me', userId: 'u7' };
  const v = viewOf(s);
  assert.equal('token' in v, false, 'the view has no token field at all');
  // `userId` is pump's own account id, added 2026-09-22 so the caller stats
  // can be asked for. It is an identifier, not a credential — the token is
  // what proves anything, and it is still absent.
  assert.deepEqual(v, { address: 'Addr1', walletId: 'w1', at: 5, username: 'me', userId: 'u7', via: 'wallet' }, 'a row from before 2026-09-23 reads as a wallet sign-in');
  assert.equal(viewOf({ ...s, userId: undefined }).userId, null, 'an id pump never sent is null, not missing');
  assert.doesNotMatch(JSON.stringify(v), /SECRET/, 'and the credential is nowhere in it');

  const status = { ready: true, lastError: null, sessions: [viewOf(s), viewOf({ ...s, walletId: 'w2', address: 'Addr2' })] };
  assert.equal(sessionForWallet(status, 'w2')?.address, 'Addr2');
  assert.equal(sessionForWallet(status, 'nope'), null, 'an unsigned wallet is null, not a guess');
  ok('a session leaves main stripped of its token, and is looked up by wallet');
}

{
  // The host is a constant. Same rule as launchMeta.ts: nothing takes a URL,
  // a host or a path component from a caller, so it cannot be pointed away.
  const auth = src('../electron/system/pumpAuth.ts');
  assert.equal(PUMP_API_HOST, 'frontend-api-v3.pump.fun');
  // The parameter is `route`, not `path` — `path` is the node module imported
  // at the top of that file, and shadowing it there would be a trap.
  assert.match(auth, /const urlFor = \(route: string\): string => `https:\/\/\$\{PUMP_API_HOST\}\$\{route\}`/, 'the URL is assembled from the constant host plus a route');
  // And every path it is ever given is a module constant, never a value that
  // arrived from outside — that is what keeps the host guarantee real.
  const routes = auth.slice(auth.indexOf('const LOGIN_ROUTES'), auth.indexOf('let session'));
  // The object literals only — `path: string` in the type annotation above is
  // a declaration, not a route.
  for (const m of routes.matchAll(/\{ path: ([A-Za-z_$][\w$]*),/g)) {
    assert.match(m[1], /^PUMP_LOGIN(_FALLBACK)?_PATH$/, `the login routes are constants, found ${m[1]}`);
  }
  assert.doesNotMatch(auth, /urlFor\([^)]*\$\{/, 'no URL is ever built from an interpolated value at a call site');
  assert.match(auth, /redirect: 'error'/, 'a redirect out of the allowlisted host is refused');
  // Every request, not just one.
  const fetches = (auth.match(/await fetch\(|= fetch\(|fetch\(`/g) ?? []).length;
  assert.ok(fetches >= 3, `found the requests (${fetches})`);
  assert.equal((auth.match(/redirect: 'error'/g) ?? []).length, fetches, 'every request refuses redirects');
  assert.ok(PUMP_LOGIN_PATH.startsWith('/'), 'the path is a constant too');
  ok('the host is a constant and redirects are refused on every request');
}

{
  // THE MESSAGE, byte for byte.
  //
  // Read off a real sign-in on 2026-09-22 — the text Phantom itself displayed
  // before signing — and then confirmed end to end: a throwaway key signing
  // exactly this string was accepted by /auth/login/token with a 200 and a
  // bearer token. It could not have been derived, because pump answers a wrong
  // message and a wrong key identically.
  //
  // Every character is load-bearing. One space after the colon, no trailing
  // punctuation, capital S. If this test is ever "fixed" by loosening it, the
  // signature stops verifying and pump's error blames our key.
  assert.equal(pumpLoginReady(), true, 'the template is known');
  assert.equal(
    pumpLoginMessage(1790047569405),
    'Sign in to pump.fun: 1790047569405',
    'the message matches the one observed in the wallet prompt, exactly',
  );
  // Milliseconds, thirteen digits — the observed prompt settles it.
  assert.equal(String(pumpTimestamp(1790047569405)).length, 13, 'the timestamp is milliseconds');
  assert.equal(pumpTimestamp(1790047569405), 1790047569405);
  // Non-numbers get no message at all rather than "…: NaN".
  assert.equal(pumpLoginMessage(0), null);
  assert.equal(pumpLoginMessage(NaN), null);
  assert.equal(pumpLoginMessage(-1), null);
  ok('the signed message is the exact string pump displayed, in milliseconds');
}

{
  // The refusal path still exists for the day pump changes the wording: with
  // no template, both layers refuse rather than signing something that cannot
  // verify.
  const w = src('../electron/system/wallet.ts');
  assert.match(w, /is not known in this build yet/, 'the signing door can still refuse');
  const auth = src('../electron/system/pumpAuth.ts');
  assert.match(auth, /if \(!pumpLoginReady\(\)\)/, 'and so can sign-in, before any request goes out');
  ok('the refusal path survives for the day the wording changes');
}

{
  // A malformed body is OUR error in OUR words, caught before the request —
  // pump answers every bad body "Invalid signature", which would read to a
  // user as "your key is wrong" when it is not.
  const good = { address: 'A'.repeat(43), signature: 'S'.repeat(88), timestamp: 1790039844000, authType: 'non_custodial' };
  assert.equal(loginBodyProblem(good), null);
  assert.match(loginBodyProblem({ ...good, address: '' }), /address/);
  assert.match(loginBodyProblem({ ...good, address: 'A'.repeat(MAX_ADDRESS_CHARS + 1) }), /address/);
  assert.match(loginBodyProblem({ ...good, signature: '' }), /nothing was signed/);
  assert.match(loginBodyProblem({ ...good, signature: 'S'.repeat(MAX_SIGNATURE_CHARS + 1) }), /89 characters/);
  assert.match(loginBodyProblem({ ...good, timestamp: 0 }), /timestamp/);
  assert.match(loginBodyProblem({ ...good, timestamp: NaN }), /timestamp/);
  ok('a body pump would reject is caught here first, and said in our own words');
}

{
  // The timestamp unit is recorded in one place rather than inlined, because
  // seconds-versus-milliseconds is one of the things the capture settles.
  const t = pumpTimestamp(1790039844000);
  assert.ok(t === 1790039844000 || t === 1790039844, 'the timestamp is the configured unit');
  const shared = src('../shared/pumpAuth.ts');
  assert.match(shared, /PUMP_TIMESTAMP_UNIT/, 'the unit is a named constant');
  // The bearer arm, confirmed working 2026-09-22. Their own site uses the
  // cookie arm, which needs an Origin header this app has no honest claim to.
  assert.equal(PUMP_LOGIN_PATH, '/auth/login/token', 'the bearer route is the one a desktop app uses');
  ok('the unit, the template and the route are named constants, verified against the live endpoint');
}

{
  // The token is a credential and is kept like one: encrypted at rest with the
  // same OS facility the wallet secrets use, and NEVER written in the clear —
  // a machine without encryption available simply does not remember it.
  const auth = src('../electron/system/pumpAuth.ts');
  assert.match(auth, /safeStorage\.encryptString\(tok\)/, 'the token is encrypted before it is written');
  assert.match(auth, /if \(!sealed\) \{/, 'and a failure to encrypt is handled');
  const persist = auth.slice(auth.indexOf('function persist()'), auth.indexOf('export function status()'));
  assert.doesNotMatch(persist, /JSON\.stringify\(session\b/, 'the session is never serialised with its live token');
  assert.match(persist, /token: sealed/, 'only the sealed token reaches disk');
  // And the field is named so the support bundle redacts it.
  const diag = src('../electron/system/diagnostics.ts');
  const rule = /const SECRET_KEYS = \/\(([^/]+)\)\//.exec(diag);
  assert.ok(rule && /token/.test(rule[1]), 'a field named token is treated as a secret by the support bundle');
  ok('the session token is encrypted at rest and redacted from the support bundle');
}

{
  // The wallet page's pump section. Three things here are easy to get wrong in
  // a way nothing would catch at runtime.
  const ui = src('../src/components/terminal/PumpAccountsSection.tsx');

  // 1. It must never render a credential. The status it receives has none, but
  // a future edit reaching for one should fail here rather than ship.
  assert.doesNotMatch(ui, /\.token\b/, 'the section never touches a token');

  // 2. Sign-out is PER WALLET. Calling it with no argument signs every account
  // out, which is a one-character mistake with a very visible cost.
  assert.match(ui, /pump\.signOut\(walletId\)/, 'sign-out names the wallet');
  assert.doesNotMatch(ui, /pump\.signOut\(\)/, 'and never signs every account out from a per-row button');

  // 3. "Create account", not "Sign in", for a wallet with no session. pump has
  // no separate registration step — signing in with a new address IS the
  // creation — so asking someone to "sign in" to an account they do not have
  // yet would be asking for something that does not exist.
  assert.match(ui, /Create account/, 'a wallet with no account is offered creation');

  // And it uses the SHARED lookup rather than matching sessions itself, so the
  // UI and main cannot disagree about what "signed in" means for a wallet.
  assert.match(ui, /sessionForWallet\(status, wal\.id\)/, 'the shared lookup decides, not a local find');

  // The not-ready state is shown rather than offering a button that cannot
  // work — the same rule as everywhere else here.
  assert.match(ui, /!status\.ready/, 'a build that cannot sign in says so');
  assert.match(ui, /disabled=\{working \|\| !status\.ready\}/, 'and the buttons are disabled while it cannot');
  ok('the wallet page section names its wallet, offers creation, and shows no credential');
}

console.log(`\npumpauth: ${passed}/${passed} passed`);
