// Setting a pump.fun account's username, bio and picture.
//
// Every shape here was OBSERVED from a real profile edit on 2026-09-22, not
// guessed — `POST /users` with one field per request. The two things these
// checks are really protecting:
//
//   • only CHANGED fields are sent. A write that re-sent everything would
//     overwrite a bio set on pump itself with whatever the form was showing,
//     which is the kind of quiet data loss nobody reports.
//
//   • the picture is a URL, and it is not cut to a username's length. The
//     observed link is 80 characters; capping it at 64 would post a dead one.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  EMPTY_PROFILE,
  accountLookupFrom,
  publicUserPath,
  BIO_WATERMARK,
  stripBioWatermark,
  withBioWatermark,
  MAX_BIO,
  MAX_USERNAME,
  PROFILE_PATH,
  profileFrom,
  profileProblem,
  profileUpdates,
} from './.pumpprofile.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The real link from the captured request — 80 characters. */
const PIC = 'https://ipfs.io/ipfs/bafkreiepkuo4ncuveueyf5vba647hrugwwmny3phyzwhvlbuaapp3xskou';

{
  assert.equal(PROFILE_PATH, '/users', 'the route pump’s own client posts to');
  // One body per field, exactly as their client sends them. The captured
  // requests were 28 bytes for the username and 99 for the picture — each is
  // that one key and that one value and nothing else.
  const both = profileUpdates({ username: 'kryptobottest', bio: 'bio test', profileImage: '' }, EMPTY_PROFILE);
  assert.equal(both.length, 2, 'two changed fields are two requests');
  assert.deepEqual(both[0], { username: 'kryptobottest' });
  assert.deepEqual(both[1], { bio: 'bio test' });
  assert.equal(JSON.stringify(both[0]).length, 28, 'byte for byte the captured username body');
  const pic = profileUpdates({ ...EMPTY_PROFILE, profileImage: PIC }, EMPTY_PROFILE);
  assert.equal(JSON.stringify(pic[0]).length, 99, 'and the captured picture body');
  ok('one request per field, in the shape pump’s own client sends');
}

{
  // ONLY WHAT CHANGED. The rest is somebody else's writing.
  const current = { username: 'me', bio: 'my bio', profileImage: PIC };
  assert.deepEqual(profileUpdates({ ...current }, current), [], 'an unchanged profile sends nothing');
  assert.deepEqual(profileUpdates({ ...current, bio: 'new' }, current), [{ bio: 'new' }], 'only the edited field goes');
  // Whitespace is not an edit.
  assert.deepEqual(profileUpdates({ ...current, username: ' me ' }, current), [], 'trimming is not a change');
  // But CLEARING is: that is a person deleting their bio, not an untouched field.
  assert.deepEqual(profileUpdates({ ...current, bio: '' }, current), [{ bio: '' }], 'an emptied field is still a change');
  ok('a partial edit stays partial, and clearing a field is an edit');
}

{
  // THE PICTURE IS NOT TEXT. It is a URL, longer than a username may be.
  assert.ok(PIC.length > MAX_USERNAME, 'the real link is longer than the username cap');
  assert.equal(profileUpdates({ ...EMPTY_PROFILE, profileImage: PIC }, EMPTY_PROFILE)[0].profileImage, PIC, 'it is sent whole');
  // The text fields ARE capped, so nothing absurd is sent.
  const long = profileUpdates({ username: 'u'.repeat(500), bio: 'b'.repeat(5000), profileImage: '' }, EMPTY_PROFILE);
  assert.equal(long[0].username.length, MAX_USERNAME);
  assert.equal(long[1].bio.length, MAX_BIO);
  ok('the picture link survives whole; the text fields are capped');
}

{
  // What the app knows it may refuse. Whether a username is taken or allowed
  // is pump's to say, and its answer is what gets shown.
  assert.equal(profileProblem(EMPTY_PROFILE), null, 'an empty draft is not an error');
  assert.equal(profileProblem({ ...EMPTY_PROFILE, profileImage: PIC }), null);
  assert.match(profileProblem({ ...EMPTY_PROFILE, profileImage: 'data:image/png;base64,AAA' }), /https link/);
  assert.match(profileProblem({ ...EMPTY_PROFILE, profileImage: 'file:///C:/pic.png' }), /https link/);
  assert.match(profileProblem({ ...EMPTY_PROFILE, username: 'u'.repeat(MAX_USERNAME + 1) }), /longer than/);
  ok('a picture nobody else could load is refused before it is posted');
}

{
  // Reading it back: anything unreadable is blank, never invented.
  assert.deepEqual(profileFrom(null), EMPTY_PROFILE);
  assert.deepEqual(profileFrom({ username: 'a', bio: 'b', profileImage: PIC }), { username: 'a', bio: 'b', profileImage: PIC });
  assert.equal(profileFrom({ name: 'fallback' }).username, 'fallback', 'their other name field is read too');
  assert.equal(profileFrom({ username: 42 }).username, '', 'a number is not a username');
  ok('a profile read back is what pump said, with anything else left blank');
}

{
  // THE SENDER. Same cookie-plus-bearer as the callout path, the same constant
  // host, and it stops at the first refusal rather than leaving an account
  // half-edited with no account of what landed.
  const eng = src('../electron/system/pumpProfile.ts');
  assert.match(eng, /cookie: `auth_token=\$\{token\}`/, 'the session cookie their guard reads');
  assert.match(eng, /authorization: `Bearer \$\{token\}`/, 'and a bearer beside it');
  assert.match(eng, /origin: 'https:\/\/pump\.fun'/, 'with the origin their client sends');
  assert.match(eng, /return \{ ok: false, message: msg, written \}/, 'a refusal stops the run and names what got through');
  // The current profile is read HERE, at write time — not passed in from a
  // form that may have been open while somebody edited on pump itself.
  assert.ok(
    eng.indexOf('await readProfile(walletId)') < eng.indexOf('profileUpdates(next, current)'),
    'the diff is against what pump holds now',
  );
  assert.match(eng, /await pumpAuth\.refreshProfile\(walletId\)/, 'and the displayed name is re-read, not assumed');
  ok('the write carries the cookie, diffs against pump, and stops at a refusal');
}

{
  // MAIN OWNS THE HOST AND THE PATH. The renderer sends a wallet id and three
  // strings; it cannot name where they go.
  const ipc = src('../electron/ipc.ts');
  const set = ipc.slice(ipc.indexOf("ipcMain.handle('pump:setProfile'"), ipc.indexOf("ipcMain.handle('pump:pinImage'"));
  assert.ok(set.length > 0, 'the handler exists');
  assert.doesNotMatch(set, /https?:\/\//, 'no URL crosses IPC');
  // Rebuilt field by field — one forgotten is one silently never written.
  for (const f of ['username', 'bio', 'profileImage']) {
    assert.ok(set.includes(`${f}: str(d.${f})`), `${f} is carried through the rebuild`);
  }
  // The picture is named by HANDLE, never by path: the renderer has never
  // seen one, which is what the 2026-09-11 audit fixed for launches.
  const pin = ipc.slice(ipc.indexOf("ipcMain.handle('pump:pinImage'"), ipc.indexOf("ipcMain.handle('pump:pinImage'") + 600);
  assert.match(pin, /pickedImages\.get\(handle\)/, 'the path is looked up in main');
  assert.doesNotMatch(pin, /filePath|d\.path/, 'and never taken from the renderer');

  const pre = src('../electron/preload.ts');
  for (const ch of ['pump:profile', 'pump:setProfile', 'pump:pinImage']) {
    assert.ok(pre.includes(ch), `${ch} has a bridge`);
  }
  ok('the renderer names a wallet and three strings, never a host or a path');
}

{
  // THE PICTURE IS SHOWN THROUGH THE APP'S OWN IMAGE HANDLER. img-src does not
  // allow https:, deliberately — a remote host must not learn this install's
  // IP from a picture. A raw <img src={url}> here would be blocked by the CSP
  // and would have been the wrong thing even if it were not.
  const ui = src('../src/components/terminal/PumpAccountsSection.tsx');
  assert.match(ui, /imageSrc\(draft\.profileImage\)/, 'the pinned link goes through the proxy');
  assert.doesNotMatch(ui, /src=\{draft\.profileImage\}/, 'and never straight at the remote host');
  const csp = src('../electron/system/webSecurity.ts');
  // The DIRECTIVE lines, not the comment above them explaining why they
  // are the way they are.
  const imgLines = csp.split(/\r?\n/).filter((l) => /["`]img-src /.test(l));
  assert.ok(imgLines.length > 0, 'there is an img-src directive');
  for (const l of imgLines) assert.ok(!l.includes('https:'), `img-src still refuses remote origins: ${l.trim()}`);
  ok('a profile picture is shown without telling its host who is looking');
}

{
  // EXISTING ACCOUNTS. Bodies as pump answered GET /users/<address> on
  // 2026-09-22, trimmed to the fields read.
  const real = '81x8PBiix6Tnr1MmjsWqgkBqNshYNkgRo4DAwYVakPu9';
  const acct = accountLookupFrom(200, { address: real, is_pump_user: true, is_banned: false, username: 'RichDawnCheck', followers: 10 }, real);
  assert.deepEqual(acct, { kind: 'account', username: 'RichDawnCheck', followers: 10, banned: false });
  const sys = '11111111111111111111111111111111';
  const rec = accountLookupFrom(200, { address: sys, is_pump_user: false, username: 'lateoctopus4697', followers: 19 }, sys);
  assert.equal(rec.kind, 'record', 'pump’s own auto-made profile is not a signed-in account');
  assert.deepEqual(accountLookupFrom(404, { message: 'User not found' }, real), { kind: 'none' });
  // The wrong direction to be wrong in: an unreadable answer is never "none".
  assert.equal(accountLookupFrom(429, null, real).kind, 'unknown', 'a rate limit is not "no account"');
  assert.equal(accountLookupFrom(500, null, real).kind, 'unknown');
  assert.equal(accountLookupFrom(200, 'x', real).kind, 'unknown');
  assert.equal(accountLookupFrom(200, { address: real }, real).kind, 'unknown', 'no is_pump_user, no claim');
  assert.equal(accountLookupFrom(200, { address: sys, is_pump_user: true }, real).kind, 'unknown', 'an answer about another address');
  assert.equal(accountLookupFrom(200, { address: real, is_pump_user: true, is_banned: true }, real).banned, true);
  assert.equal(accountLookupFrom(200, { address: real, is_pump_user: true, followers: 'many' }, real).followers, null, 'unknown followers are null, not 0');
  ok('an existing pump account is recognised, and an unreadable answer never reads as none');
}

{
  // Only an address goes in the path, and only one that looks like one.
  assert.equal(publicUserPath('81x8PBiix6Tnr1MmjsWqgkBqNshYNkgRo4DAwYVakPu9'), '/users/81x8PBiix6Tnr1MmjsWqgkBqNshYNkgRo4DAwYVakPu9');
  for (const bad of ['', '../auth/my-profile', 'abc', '0OIl' + 'a'.repeat(40), 'x'.repeat(45)]) {
    assert.equal(publicUserPath(bad), null, `refused: ${bad}`);
  }
  ok('the public lookup path takes a base58 address and nothing else');
}

{
  // The bridge, both ways: a handler with no preload entry is dead, a preload
  // entry with no handler hangs. And the import goes through the SAME
  // importSecret as the Wallet page, so a pump import is not a second key
  // parser.
  const ipc = src('../electron/ipc.ts');
  const pre = src('../electron/preload.ts');
  for (const ch of ['pump:lookup', 'pump:importAccount']) {
    assert.ok(ipc.includes(`ipcMain.handle('${ch}'`), `${ch} is handled`);
    assert.ok(pre.includes(`ipcRenderer.invoke('${ch}'`), `${ch} is bridged`);
  }
  const body = ipc.slice(ipc.indexOf("ipcMain.handle('pump:importAccount'"));
  const handler = body.slice(0, body.indexOf('\n  });') + 6);
  assert.match(handler, /wallet\.importSecret\(/, 'the one key parser');
  assert.doesNotMatch(handler, /logger\.[a-z]+\([^)]*secret/, 'the secret is never logged');
  // Lookups take wallet ids, not addresses from the renderer.
  const look = ipc.slice(ipc.indexOf("ipcMain.handle('pump:lookup'"));
  assert.match(look.slice(0, look.indexOf('\n  });')), /wallet\.publicKeyOf\(id\)/, 'main resolves the address');
  ok('lookup and import are bridged, and import reuses the wallet import path');
}

{
  // THE BIO'S LAST LINE, as asked 09-22: "I find and flag runners" / "Using krypt.cc/bot".
  assert.equal(BIO_WATERMARK, 'Using krypt.cc/bot');
  assert.equal(withBioWatermark('I find and flag runners'), 'I find and flag runners\nUsing krypt.cc/bot');
  assert.equal(withBioWatermark(''), BIO_WATERMARK, 'an empty bio is just the line');
  const once = withBioWatermark('gm');
  assert.equal(withBioWatermark(once), once, 'stamping twice changes nothing');
  assert.equal(stripBioWatermark(once), 'gm', 'the form edits the words only');
  assert.ok(withBioWatermark('x'.repeat(MAX_BIO)).length <= MAX_BIO, 'a full bio still fits');
  assert.ok(withBioWatermark('x'.repeat(MAX_BIO)).endsWith(BIO_WATERMARK), 'and keeps its line');
  // Re-saving what pump holds is not a change — so an untouched, already
  // marked bio is never re-sent.
  const held = { username: 'me', bio: once, profileImage: '' };
  assert.deepEqual(profileUpdates({ ...held, bio: withBioWatermark(stripBioWatermark(once)) }, held), []);
  ok('every bio ends with its own line, once, and the form edits only the words');
}

{
  // THE RENAME THAT WIPED PROFILES (fixed 09-22). The bulk rename passed
  // bio '' and profileImage '', and a cleared field is a delete — so every
  // rename deleted the bio and picture. Main now takes a PARTIAL: an unpassed
  // field keeps what pump holds, and the bio is stamped in main.
  const ipc = src('../electron/ipc.ts');
  assert.doesNotMatch(ipc, /writeProfile\([^)]*bio: ''/, 'no caller passes a blank bio it did not mean');
  assert.match(ipc, /writeProfile\(j\.walletId, \{ username: j\.username \}\)/, 'the rename sends the username only');
  const main = src('../electron/system/pumpProfile.ts');
  assert.match(main, /patch\.bio !== undefined \? withBioWatermark\(patch\.bio\) : current\.bio/, 'bio stamped in main, kept when not passed');
  assert.match(main, /patch\.profileImage \?\? current\.profileImage/, 'picture kept when not passed');
  const setProfile = ipc.slice(ipc.indexOf("ipcMain.handle('pump:setProfile'"));
  assert.match(setProfile.slice(0, setProfile.indexOf('\n  });')), /string \| undefined/, 'a missing field stays missing over IPC');
  ok('renaming an account never touches its bio or picture');
}

console.log(`\npumpprofile: ${passed}/${passed} passed`);
