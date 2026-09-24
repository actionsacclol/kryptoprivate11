// What pump says about you as a caller, and renaming accounts in bulk.
//
// Since 2026-09-22 the stats come from pump's PUBLIC
// `GET /users/{address}/callout-stats`, read from their route table and
// CONFIRMED live (the shape below is a real answer). The old guess —
// `/callout/leaderboard-stats/{userId}` — answered leaderboard streaks, not
// performance, and the panel could only say it recognised nothing. A window
// pump did not send stays unknown; a zero it did send is a real zero.

import assert from 'node:assert';
import fs from 'node:fs';
import { STATS_WINDOWS, callerStatsFrom, callerStatsPath, nameListProblem, namesFromList } from './.pumpstats.mjs';
import { PUMP_SESSION_DAYS, sessionDaysLeft, sessionStale } from './.pumpauth.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // THE ADDRESS GOES INTO A PATH, so it may only ever be a plain base58
  // address. Nothing to escape, nothing to traverse.
  const A = 'Ff4Mw51MqPt6wgcY1TsLFdHp94Cqx9Bris9EapMyvNkm';
  assert.equal(callerStatsPath(A), `/users/${A}/callout-stats`);
  for (const bad of ['', '../../users', 'a/b', `${A}/x`, `${A}?x=1`, 'short']) {
    assert.equal(callerStatsPath(bad), null, `refused: ${bad}`);
  }
  ok('the stats path is built from a plain address only');
}

{
  // A REAL ANSWER (Krypt's own account, 2026-09-22), trimmed.
  const real = callerStatsFrom({
    daily: { totalCallouts: 2, calloutsWithMultiple: 2, twoXPercent: 0, onePointFiveXPercent: 50, onePointTwoXPercent: 50, averageMultiple: 1.3015, medianMultiple: 1.3015, averageTimeToPeakMs: 232687, distribution: [] },
    weekly: { totalCallouts: 3, twoXPercent: 0, onePointFiveXPercent: 33.3, onePointTwoXPercent: 33.3, averageMultiple: 1.209, medianMultiple: 1.024, averageTimeToPeakMs: 145336 },
    computedAt: '2026-09-23T02:12:45.651Z',
  });
  assert.deepEqual(Object.keys(real.windows), ['daily', 'weekly'], 'only the windows pump sent');
  assert.equal(real.windows.daily.totalCallouts, 2);
  assert.equal(real.windows.daily.oneFiveXPct, 50);
  assert.equal(real.windows.daily.twoXPct, 0, 'a zero pump sent is a real zero');
  assert.equal(real.windows.weekly.averageTimeToPeakMs, 145336);
  assert.equal(real.windows.monthly, undefined, 'a window it did not send is unknown, not zeros');
  assert.equal(real.computedAt, '2026-09-23T02:12:45.651Z');
  // Their "fails open to {}" answer: nothing known, nothing invented.
  const down = callerStatsFrom({});
  assert.deepEqual(down.windows, {});
  assert.equal(callerStatsFrom({ daily: { totalCallouts: 'x' } }).windows.daily.totalCallouts, null, 'a non-number is unknown');
  assert.deepEqual([...STATS_WINDOWS], ['daily', 'weekly', 'monthly', 'allTime']);
  ok('pump\'s callout stats are read per window, and a missing one stays unknown');
}

{
  // The account's profile comes from pump's PUBLIC profile route. It used to
  // come from /auth/my-profile, which carries only the session's claims — so
  // the editor opened blank and the empty-bio check saw every bio as empty.
  const prof = src('../electron/system/pumpProfile.ts');
  const read = prof.slice(prof.indexOf('export async function readProfile('), prof.indexOf('export async function writeProfile('));
  assert.match(read, /readPublicProfile\(address\)/, 'the editor reads the public profile');
  assert.doesNotMatch(prof, /['`"]\/auth\/my-profile/, 'never fetches the session claims');
  assert.match(read, /if \(!r\) return null; \/\/ unreadable/, 'an unreadable profile is null — never an empty one');
  const auth = src('../electron/system/pumpAuth.ts');
  assert.match(auth, /\/users\/\$\{encodeURIComponent\(s\.address\)\}/, 'the display name comes from the public profile too');
  // When pump will not answer (30 a minute), the EDITOR falls back to what this
  // app last read or wrote — and says so. The empty-bio check never does: it
  // must see pump's real bio or write nothing.
  const editor = prof.slice(prof.indexOf('export async function readProfileForEditor('), prof.indexOf('export async function readProfile('));
  assert.match(editor, /cacheMap\(\)\.get\(address\)/, 'the editor falls back to the cache');
  assert.match(editor, /cachedAt: hit\.at/, 'and says how old it is');
  assert.match(prof, /remember\(address, landed\)/, 'a save updates the cache');
  const stamp = prof.slice(prof.indexOf('export async function stampEmptyBio('), prof.indexOf('export async function stampEmptyBio(') + 600);
  assert.match(stamp, /await readProfile\(walletId\)/, 'the empty-bio check reads live');
  assert.doesNotMatch(stamp, /cacheMap|ForEditor/, 'and never from the cache');
  assert.match(prof, /res\.status === 429 && attempt === 0/, 'a 429 is waited out once');
  ok('profiles are read from pump\'s public profile, and unreadable is never empty');
}

{
  // NAMES IN BULK. A repeat is refused before anything is sent: pump almost
  // certainly wants them unique, and half a rename leaves nobody able to say
  // which half worked.
  assert.deepEqual(namesFromList('a\n\n b \nc', 10), ['a', 'b', 'c']);
  assert.equal(namesFromList('a\nb\nc', 2).length, 2, 'never more names than accounts');
  assert.equal(nameListProblem(['a', 'b'], 3), null);
  assert.match(nameListProblem([], 3), /at least one/);
  assert.match(nameListProblem(['a', 'b', 'c'], 2), /3 names for 2/);
  assert.match(nameListProblem(['a', 'A'], 3), /twice/, 'case does not make it a different name');
  ok('a list of names is refused whole rather than applied half');
}

{
  // SESSIONS LAPSE QUIETLY, so the age is on screen and staleness is flagged
  // early. The fourteen days is an OBSERVATION — nothing expires a session on
  // it, and a 401 from pump stays the only authority.
  const day = 86_400_000;
  const now = Date.now();
  assert.ok(Math.abs(sessionDaysLeft({ at: now }, now) - PUMP_SESSION_DAYS) < 0.01);
  assert.equal(sessionStale({ at: now }, now), false, 'a fresh session is not stale');
  assert.equal(sessionStale({ at: now - 10 * day }, now), false);
  assert.equal(sessionStale({ at: now - 12 * day }, now), true, 'flagged with days to spare');
  assert.ok(sessionDaysLeft({ at: now - 20 * day }, now) < 0, 'past due goes negative, not to zero');

  // Nothing in main deletes a session on the clock.
  const auth = src('../electron/system/pumpAuth.ts');
  assert.doesNotMatch(auth, /sessionStale|PUMP_SESSION_DAYS/, 'main never expires a session by estimate');
  assert.match(auth, /res\.status === 401/, 'a 401 is what signs one out');
  ok('session age is shown and flagged early, but only pump expires a session');
}

{
  // Bulk work is a loop in MAIN, not the renderer firing N calls: a page that
  // could fire twenty could fire two hundred, and main can report per wallet.
  const ipc = src('../electron/ipc.ts');
  const many = ipc.slice(ipc.indexOf("ipcMain.handle('pump:signInMany'"), ipc.indexOf("ipcMain.handle('pump:setUsernames'"));
  assert.ok(many.length > 0, 'the handler exists');
  assert.match(many, /for \(const id of ids\)/, 'one after another');
  assert.match(many, /slice\(0, MAX_BULK\)/, 'and bounded');
  assert.match(many, /results\.push\(\{ walletId: id/, 'each result names its wallet');
  const names = ipc.slice(ipc.indexOf("ipcMain.handle('pump:setUsernames'"), ipc.indexOf("ipcMain.handle('pump:callerStats'"));
  assert.match(names, /nameListProblem\(/, 'a duplicate name stops the whole run');
  ok('bulk account work loops in main, bounded, and names what failed');
}

console.log(`\npumpstats: ${passed}/${passed} passed`);
