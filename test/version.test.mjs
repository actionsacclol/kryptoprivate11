// "Is there a newer build?" — and the four honest answers.
//
// The rule this file exists to pin is the one that is easy to get wrong and
// expensive to get wrong: **we could not check** must never render as **you
// are up to date**. A user told they are current, by an app that never
// actually asked, stops checking — which is the opposite of what an update
// notice is for.
//
// That is not hypothetical here. krypt.cc is a static site with a catch-all
// route, so `GET /version.json` answers HTTP 200 with the site's own HTML
// (measured 2026-09-11). Every guard below is aimed at that shape.

import assert from 'node:assert';
import { MAX_NOTE_LENGTH, compareVersions, parseVersion, readVersionDoc, updateStatus } from './.version.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const at = { checkedAt: 1_700_000_000_000, failure: null };

{
  assert.deepEqual(parseVersion('2.0.0'), [2, 0, 0]);
  assert.deepEqual(parseVersion('v2.0.0'), [2, 0, 0], 'a leading v is accepted');
  assert.deepEqual(parseVersion(' 1.1.0 '), [1, 1, 0], 'and surrounding space');
  // This repo has shipped 1.0.0-beta.9. A checker that choked on a
  // pre-release would go silent on exactly the builds most likely to need an
  // update.
  assert.deepEqual(parseVersion('1.0.0-beta.9'), [1, 0, 0, 'beta.9'], 'and the tag is kept');
  assert.deepEqual(parseVersion('2.0.0+build7'), [2, 0, 0], 'build metadata is not');
  // A beta is OLDER than its final, so the day 2.0.0 ships every
  // 2.0.0-beta.N install hears about it.
  assert.equal(compareVersions(parseVersion('2.0.0-beta.7'), parseVersion('2.0.0')), -1);
  assert.equal(compareVersions(parseVersion('2.0.0'), parseVersion('2.0.0-beta.7')), 1);
  assert.equal(compareVersions(parseVersion('2.0.0-beta.7'), parseVersion('2.0.0-beta.7')), 0);
  assert.equal(compareVersions(parseVersion('2.0.0-beta.10'), parseVersion('2.0.0-beta.9')), 1, 'beta.10 is after beta.9 — numeric identifiers compare as numbers');
  assert.equal(compareVersions(parseVersion('2.0.0-alpha'), parseVersion('2.0.0-beta')), -1);
  for (const bad of ['', '2.0', 'two.oh.oh', '2.0.0.1', null, 42, {}, '<script>']) {
    assert.equal(parseVersion(bad), null, `${JSON.stringify(bad)} is not a version`);
  }
  ok('versions parse, including pre-releases, and nonsense is refused');
}

{
  assert.equal(compareVersions([1, 0, 0], [2, 0, 0]), -1);
  assert.equal(compareVersions([2, 0, 0], [2, 0, 0]), 0);
  assert.equal(compareVersions([2, 1, 0], [2, 0, 9]), 1, 'minor outranks patch');
  assert.equal(compareVersions([1, 9, 9], [2, 0, 0]), -1, 'major outranks both');
  // The one a string comparison gets wrong, and the reason this is numeric.
  assert.equal(compareVersions([2, 10, 0], [2, 9, 0]), 1, '2.10.0 is newer than 2.9.0');
  ok('comparison is numeric, so 2.10.0 beats 2.9.0');
}

{
  // THE case. A 200 carrying the site's HTML parses as nothing, yields no
  // document, and must land on "unknown" — never "current".
  const s = updateStatus('2.0.0', null, { checkedAt: at.checkedAt, failure: 'krypt.cc is not publishing a version document yet' });
  assert.equal(s.state, 'unknown');
  assert.equal(s.latest, null);
  assert.match(s.detail, /could not check/i);
  assert.ok(!/up to date|latest version/i.test(s.detail), 'and it never claims the user is current');
  ok('a check that produced no answer is "unknown", never "up to date"');
}

{
  const never = updateStatus('2.0.0', null, { checkedAt: null, failure: null });
  assert.equal(never.state, 'unknown');
  assert.equal(never.checkedAt, null);
  assert.match(never.detail, /have not checked/i);
  ok('before the first check the app says so, rather than guessing');
}

{
  const s = updateStatus('2.0.0', { version: '2.1.0' }, at);
  assert.equal(s.state, 'update');
  assert.equal(s.latest, '2.1.0');
  assert.equal(s.important, false);
  assert.match(s.detail, /2\.1\.0/);
  assert.match(s.detail, /2\.0\.0/, 'and it says which build you are on');
  ok('a newer published version is an update, and both versions are named');
}

{
  const s = updateStatus('2.0.0', { version: '2.0.0' }, at);
  assert.equal(s.state, 'current');
  assert.match(s.detail, /latest version/i);
  ok('the same version is "current" — the one state that may say so');
}

{
  // A dev tree is ahead of what is published. Telling that user to "update"
  // to an older build is worse than saying nothing.
  const s = updateStatus('2.1.0', { version: '2.0.0' }, at);
  assert.equal(s.state, 'ahead');
  assert.ok(!/update/i.test(s.detail), 'and it does not tell them to downgrade');
  ok('a build newer than the published one is "ahead", not an update');
}

{
  const s = updateStatus('2.0.0', { version: '2.0.1', important: true, note: 'Fixes a sell that could be refused.' }, at);
  assert.equal(s.state, 'update');
  assert.equal(s.important, true);
  assert.match(s.detail, /important/i);
  assert.match(s.detail, /Fixes a sell/);
  // The flag is only meaningful on a real answer.
  assert.equal(updateStatus('2.0.0', null, at).important, false, 'an unread answer carries no flag');
  ok('an important release says so, and only when there is an answer to flag');
}

{
  // A build whose own version is unreadable cannot be compared with anything.
  const s = updateStatus('nightly', { version: '2.0.0' }, at);
  assert.equal(s.state, 'unknown');
  assert.ok(!/update|latest/i.test(s.detail) || /does not name/.test(s.detail));
  ok('a build that does not name a comparable version reports unknown');
}

// ── The document itself is untrusted text ───────────────────────────────

{
  assert.equal(readVersionDoc({ version: '2.1.0' }).version, '2.1.0');
  assert.equal(readVersionDoc({ version: '2.1.0' }).important, false, 'important defaults to false');
  assert.equal(readVersionDoc({ version: '2.1.0', important: 'yes' }).important, false, 'and only `true` sets it');
  ok('a minimal document reads, and `important` must be exactly true');
}

{
  for (const bad of [null, undefined, 'v2.1.0', 42, [], [{ version: '2.1.0' }], {}, { version: 'soon' }, { version: 2.1 }]) {
    assert.equal(readVersionDoc(bad), null, `${JSON.stringify(bad) ?? String(bad)} is not a version document`);
  }
  ok('anything that is not an object naming a version is refused outright');
}

{
  // The note is rendered to the user, so it is bounded and markup-free. It is
  // DROPPED rather than truncated or escaped — a half-sentence attributed to
  // us is worse than no sentence.
  assert.equal(readVersionDoc({ version: '2.1.0', note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }).note, undefined);
  assert.equal(readVersionDoc({ version: '2.1.0', note: '<b>hi</b>' }).note, undefined);
  assert.equal(readVersionDoc({ version: '2.1.0', note: '  Fixes a crash.  ' }).note, 'Fixes a crash.');
  assert.equal(readVersionDoc({ version: '2.1.0', note: '' }).note, undefined);
  ok('a note is trimmed, bounded and markup-free, or it is not shown at all');
}

console.log(`\nversion: ${passed}/${passed} passed`);
