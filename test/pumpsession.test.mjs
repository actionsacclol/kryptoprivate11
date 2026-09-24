// The pump.fun session STORE, exercised for real against a temp directory.
//
// test/pumpauth.test.mjs pins the shape of the code; this runs it. Three
// wallets, three accounts, all live at once — signing one out must leave the
// others alone, tokens must survive a restart, and no token may ever reach
// disk in the clear.
//
// Signing in is not exercised here: that needs the network and a real key.
// What is exercised is everything around it, which is where a multi-account
// store goes wrong.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-pump-'));
process.env.KRYPT_TEST_USERDATA = dir;

const auth = await import('./.pumpsession.mjs');
const storeFile = path.join(dir, 'pump-session.json');

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};

/** Put a session in without the network, the way signIn would. */
const put = (walletId, address, at, username = null) => auth._put({ walletId, address, token: `JWT.${walletId}.SECRET`, at, username });

{
  // Nothing signed in: an honest empty state, and no file left lying around.
  const s = auth.status();
  assert.deepEqual(s.sessions, [], 'no sessions to start');
  assert.equal(s.ready, true, 'the template is known, so sign-in is possible');
  assert.equal(fs.existsSync(storeFile), false, 'no store file until there is something to store');
  ok('an empty store reports no accounts and writes nothing');
}

{
  // THREE WALLETS, THREE ACCOUNTS, ALL AT ONCE.
  put('w1', 'AddrOne', 1000);
  put('w2', 'AddrTwo', 3000);
  put('w3', 'AddrThree', 2000);
  const s = auth.status();
  assert.equal(s.sessions.length, 3, 'all three are live at the same time');
  // Newest first, so the account just signed into is at the top.
  assert.deepEqual(s.sessions.map((x) => x.walletId), ['w2', 'w3', 'w1'], 'ordered newest first');
  // Each account is its own address.
  assert.deepEqual(s.sessions.map((x) => x.address).sort(), ['AddrOne', 'AddrThree', 'AddrTwo']);
  // And the token for one wallet is that wallet's, never another's.
  assert.equal(auth.token('w1'), 'JWT.w1.SECRET');
  assert.equal(auth.token('w3'), 'JWT.w3.SECRET');
  assert.equal(auth.token('nope'), null, 'an unknown wallet has no token, rather than borrowing one');
  assert.equal(auth.signedIn('w2'), true);
  assert.equal(auth.signedIn('nope'), false);
  ok('three wallets hold three separate accounts at once, each with its own token');
}

{
  // NO TOKEN REACHES DISK IN THE CLEAR, and none reaches the renderer.
  const raw = fs.readFileSync(storeFile, 'utf8');
  assert.doesNotMatch(raw, /JWT\.w[123]\.SECRET/, 'the plaintext token is nowhere in the file');
  assert.match(raw, /"token": "ZW5j/, 'what is written is the sealed form');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2, 'the file says which shape it is');
  assert.equal(parsed.sessions.length, 3);

  const shown = JSON.stringify(auth.status());
  assert.doesNotMatch(shown, /SECRET/, 'and no token appears in what the UI is handed');
  ok('tokens are sealed on disk and absent from the status the UI receives');
}

{
  // A RESTART keeps every account. This is the whole point of persisting.
  auth._reset();
  const s = auth.status();
  assert.equal(s.sessions.length, 3, 'all three came back');
  assert.equal(auth.token('w2'), 'JWT.w2.SECRET', 'and each token decrypts to its own value');
  assert.equal(auth.token('w1'), 'JWT.w1.SECRET');
  ok('every account survives a restart, each with the right token');
}

{
  // SIGNING ONE OUT LEAVES THE OTHERS ALONE. The bug a single-slot store makes
  // easy is dropping all three when the user meant one.
  const r = auth.signOut('w2');
  assert.equal(r.ok, true);
  const s = auth.status();
  assert.deepEqual(s.sessions.map((x) => x.walletId).sort(), ['w1', 'w3'], 'only w2 went');
  assert.equal(auth.token('w2'), null);
  assert.equal(auth.token('w1'), 'JWT.w1.SECRET', 'the others keep working');

  // And it stuck: the file no longer carries the one that left.
  auth._reset();
  assert.deepEqual(auth.status().sessions.map((x) => x.walletId).sort(), ['w1', 'w3'], 'the removal persisted');

  // Signing out a wallet that was never in says so rather than pretending.
  assert.match(auth.signOut('never').message, /not signed in/);
  ok('signing one wallet out leaves the rest signed in, and it persists');
}

{
  // Signing in again with the same wallet REPLACES that session — this is how
  // an expired one is refreshed — and does not add a duplicate.
  put('w1', 'AddrOne', 9000, 'renamed');
  const s = auth.status();
  assert.equal(s.sessions.filter((x) => x.walletId === 'w1').length, 1, 'one row per wallet, never two');
  assert.equal(s.sessions[0].walletId, 'w1', 'and the refreshed one is newest');
  assert.equal(s.sessions[0].username, 'renamed');
  assert.equal(auth.token('w1'), 'JWT.w1.SECRET');
  ok('signing in again refreshes that wallet rather than duplicating it');
}

{
  // Signing every account out clears the file entirely — no empty husk left
  // behind claiming there are sessions.
  const r = auth.signOut();
  assert.match(r.message, /2 pump\.fun accounts/);
  assert.deepEqual(auth.status().sessions, []);
  assert.equal(fs.existsSync(storeFile), false, 'the file is removed, not left empty');
  auth._reset();
  assert.deepEqual(auth.status().sessions, [], 'and it stays gone across a restart');
  ok('signing out of everything removes the store rather than leaving a husk');
}

{
  // A CORRUPT store is not "nobody is signed in". It says so, and the app
  // still starts — the fail-open rule from the 2026-09-09 audit.
  fs.writeFileSync(storeFile, '{ this is not json', 'utf8');
  auth._reset();
  const s = auth.status();
  assert.deepEqual(s.sessions, [], 'nothing is invented from a broken file');
  assert.match(s.lastError ?? '', /could not be read/, 'and the user is told, rather than it reading as a fresh install');
  ok('an unreadable store reports itself instead of pretending nobody signed in');
}

{
  // A session whose token will not decrypt — a different machine, a reset
  // keychain — is reported rather than silently dropped.
  // A row whose token cannot be recovered at all — a truncated write, or a
  // machine whose keychain no longer opens it. (The test stub's cipher is
  // reversible by design, so the token is absent rather than corrupt; the
  // path through the code is the same one.)
  fs.writeFileSync(
    storeFile,
    JSON.stringify({ version: 2, sessions: [{ address: 'AddrOne', walletId: 'w1', at: 1 }] }),
    'utf8',
  );
  auth._reset();
  const s = auth.status();
  assert.deepEqual(s.sessions, []);
  assert.match(s.lastError ?? '', /could not be decrypted/, 'the reason is specific, not a generic failure');
  ok('a session that will not decrypt on this machine says exactly that');
}

{
  // 2026-09-23: a username the sign-in read missed is filled in later.
  // Three of five real accounts showed an address where pump had a name.
  auth._reset();
  for (const s of auth.status().sessions) auth.signOut?.(s.walletId);
  put('n1', 'AddrNamed', 1000, 'already');
  put('n2', 'AddrBlank', 2000, null);
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('/users/')) return new Response(JSON.stringify({ username: u.endsWith('AddrBlank') ? 'FoundLater' : 'already' }), { status: 200 });
    return new Response('{}', { status: 200 }); // my-profile: the session is alive
  };
  try {
    const T0 = 10 ** 13;
    auth.refreshNamesSoon(T0);
    // The FIRST pass re-reads everyone, and AddrBlank is the SECOND id, so it is
    // fetched only after the 1.5 s inter-request gap. Poll well past that gap —
    // ~5 s max, breaking the instant it fills — so the wait never expires before
    // the fetch on a fast or idle machine (this raced at 1 s in CI, 2026-09-24).
    for (let i = 0; i < 250 && !auth.status().sessions.find((s) => s.walletId === 'n2')?.username; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(auth.status().sessions.find((s) => s.walletId === 'n2').username, 'FoundLater', 'the blank name is filled in');
    // The first pass after start reads everyone (names may have changed while
    // the app was closed); wait for it to finish its 1.5 s spacing.
    for (let i = 0; i < 150 && !asked.some((u) => u.endsWith('/users/AddrNamed')); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    let before = asked.length;
    auth.refreshNamesSoon(T0 + 60_000);
    assert.equal(asked.length, before, 'nothing missing and not due: no request at all');
    // A new blank name is retried within minutes, and ONLY that account is asked.
    put('n3', 'AddrNew', 3000, null);
    before = asked.length;
    auth.refreshNamesSoon(T0 + 6 * 60_000);
    for (let i = 0; i < 50 && !auth.status().sessions.find((s) => s.walletId === 'n3')?.username; i++) await new Promise((r) => setTimeout(r, 20));
    const second = asked.slice(before).filter((u) => u.includes('/users/'));
    assert.deepEqual(second.map((u) => u.split('/users/')[1]), ['AddrNew'], 'a retry asks only for the names that are missing');
    await new Promise((r) => setTimeout(r, 50));
    before = asked.length;
    auth.refreshNamesSoon(T0 + 7 * 3_600_000);
    for (let i = 0; i < 250 && asked.slice(before).filter((u) => u.includes('/users/')).length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(asked.slice(before).filter((u) => u.includes('/users/')).length, 3, 'every six hours every name is re-read, so a rename shows up');
    ok('a missed username is filled in later, and names refresh every six hours');
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // 2026-09-23: a session made on pump.fun ITSELF (email/Google) is kept —
  // but only after pump says which account it is, and it is filed by THAT.
  auth._reset();
  const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  let answer = { status: 200, body: { address: A, roles: [] } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/my-profile')) return new Response(JSON.stringify(answer.body), { status: answer.status });
    if (u.includes('/users/')) return new Response(JSON.stringify({ username: 'WebUser' }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  try {
    let r = await auth.adoptWebSession('eyJ.TOKEN-FOR-A.sig-long-enough');
    assert.equal(r.ok, true, r.message);
    assert.equal(r.walletId, `web:${A}`, 'an address that is not one of the wallets becomes a sign-in-only account');
    const s = auth.status().sessions.find((x) => x.address === A);
    assert.equal(s.via, 'web');
    assert.equal(auth.token(`web:${A}`), 'eyJ.TOKEN-FOR-A.sig-long-enough');
    assert.ok(!fs.readFileSync(storeFile, 'utf8').includes('TOKEN-FOR-A'), 'sealed on disk like every other session');

    answer = { status: 401, body: {} };
    r = await auth.adoptWebSession('eyJ.REJECTED.sig-long-enough-too');
    assert.equal(r.ok, false, 'pump refusing the token keeps nothing');
    assert.ok(!auth.status().sessions.some((x) => auth.token(x.walletId) === 'eyJ.REJECTED.sig-long-enough-too'));

    answer = { status: 200, body: { roles: [] } };
    r = await auth.adoptWebSession('eyJ.NO-ADDRESS.sig-long-enough');
    assert.equal(r.ok, false, 'a session pump will not name an account for is not kept');

    // The same address again replaces, never duplicates.
    answer = { status: 200, body: { address: A } };
    await auth.adoptWebSession('eyJ.NEWER-TOKEN-A.sig-long-enough');
    assert.equal(auth.status().sessions.filter((x) => x.address === A).length, 1);
    assert.equal(auth.token(`web:${A}`), 'eyJ.NEWER-TOKEN-A.sig-long-enough');

    // Outside the wallet cap, and unlimited (2026-09-23): eleven and more are fine.
    const addrs = [B, ...Array.from({ length: 9 }, (_, i) => `${'1'.repeat(40)}${'ABCDEFGHJK'[i]}${'x'.repeat(0)}`)].map((a) => a.slice(0, 44));
    for (const a of addrs.slice(0, 9)) {
      answer = { status: 200, body: { address: a } };
      await auth.adoptWebSession(`eyJ.T-${a}.sig-long-enough`);
    }
    const webCount = auth.status().sessions.filter((x) => x.walletId.startsWith('web:')).length;
    assert.equal(webCount, 10);
    answer = { status: 200, body: { address: addrs[9] } };
    r = await auth.adoptWebSession('eyJ.ELEVENTH.sig-long-enough');
    assert.equal(r.ok, true, 'an eleventh sign-in-only account is kept — no cap on external logins');
    assert.equal(auth.status().sessions.filter((x) => x.walletId.startsWith('web:')).length, 11);
    ok('a pump.fun web sign-in is kept only for the account pump names, sealed and deduplicated — and not capped');

    // An email account's key, exported from pump and imported: the session
    // moves onto the new wallet instead of being orphaned.
    assert.equal(auth.claimWebSession(A, 'w-imported'), true);
    assert.equal(auth.token('w-imported'), 'eyJ.NEWER-TOKEN-A.sig-long-enough');
    assert.equal(auth.token(`web:${A}`), null, 'no longer a sign-in-only account');
    assert.equal(auth.status().sessions.find((x) => x.walletId === 'w-imported').via, 'web');
    assert.equal(auth.claimWebSession(A, 'w-imported'), false, 'nothing to move twice');
    assert.equal(auth.claimWebSession('NotSignedIn1111111111111111111111', 'w-other'), false);
    ok('importing the key of a sign-in-only account makes it a full account on that wallet');
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // The in-app pump.fun web sign-in window (embedded + real-Chrome) was
  // removed 2026-09-23: Google refuses OAuth in both, so it never worked for
  // the login most people use. Accounts made on pump.fun come in through
  // export-key → import instead. Nothing may re-add a browser sign-in window.
  const root = new URL('../', import.meta.url);
  assert.ok(!fs.existsSync(new URL('electron/system/pumpLoginWindow.ts', root)), 'the embedded login window is gone');
  assert.ok(!fs.existsSync(new URL('electron/system/pumpLoginChrome.ts', root)), 'the real-Chrome login path is gone');
  const ipc = fs.readFileSync(new URL('electron/ipc.ts', root), 'utf8');
  assert.ok(!ipc.includes("ipcMain.handle('pump:webSignIn'"), 'no web sign-in IPC handler');
  assert.ok(!ipc.includes('remote-debugging-port') && !ipc.includes('openPumpLoginChrome'), 'no debug-port Chrome automation');
  const pre = fs.readFileSync(new URL('electron/preload.ts', root), 'utf8');
  assert.ok(!pre.includes('webSignIn'), 'no webSignIn bridge');
  ok('the pump.fun web sign-in window is removed; accounts come in by export-key → import');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\npumpsession: ${passed}/${passed} passed`);
