// Clickwrap acceptance record.
//
// This is evidence. If it is wrong, the failure mode is not a crash — it is
// discovering years later that nobody can show what any user agreed to.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  init,
  append,
  all,
  newRecord,
  parseLog,
  hasAccepted,
  latest,
  expiredRows,
  purge,
  sha256,
  logPath,
} from './.acceptance.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-accept-'));
  init(d, 'legal-acceptance.jsonl');
  return d;
}

const base = {
  product: 'Krypto Terminal',
  appVersion: '1.0.0',
  platform: 'win32 x64',
  locale: 'en-GB',
  documents: [{ id: 'terms', sha256: sha256('terms text') }],
};

// ─── Recording ────────────────────────────────────────────────────────

ok('an acceptance is written and can be read back', () => {
  freshDir();
  assert.equal(append(newRecord({ ...base, termsVersion: '2026-08-25.1' })), true);
  const rows = all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].termsVersion, '2026-08-25.1');
  assert.equal(rows[0].product, 'Krypto Terminal');
  assert.match(rows[0].acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(rows[0].id.length > 10, 'every row needs its own id');
});

ok('the log is APPEND-ONLY — a second acceptance never overwrites the first', () => {
  freshDir();
  append(newRecord({ ...base, termsVersion: '2026-08-25.1', now: Date.parse('2026-08-25T10:00:00Z') }));
  append(newRecord({ ...base, termsVersion: '2027-01-01.1', now: Date.parse('2027-01-01T10:00:00Z') }));
  const rows = all();
  assert.equal(rows.length, 2, 'history must survive');
  assert.equal(rows[0].termsVersion, '2026-08-25.1', 'the old acceptance is still there');
});

ok('the record stores a hash of the exact text, not just a version label', () => {
  // A version string proves a label was clicked. A hash proves WHICH words
  // were on the screen when it was.
  freshDir();
  const docs = [
    { id: 'terms', sha256: sha256('the original terms') },
    { id: 'privacy', sha256: sha256('the original privacy policy') },
  ];
  append(newRecord({ ...base, termsVersion: 'v1', documents: docs }));
  const row = all()[0];
  assert.equal(row.documents.length, 2);
  assert.notEqual(row.documents[0].sha256, row.documents[1].sha256, 'each document hashes separately');
  assert.equal(row.documents[0].sha256, sha256('the original terms'));
  assert.notEqual(row.documents[0].sha256, sha256('the AMENDED terms'), 'changed text must not match');
});

ok('no IP address is recorded in any form', () => {
  // legalcheck.md: never store raw IPs. Locally we do not even know one, and
  // inventing a lookup to obtain it would create the exact risk being avoided.
  freshDir();
  append(newRecord({ ...base, termsVersion: 'v1' }));
  const raw = fs.readFileSync(logPath(), 'utf8');
  assert.ok(!/\bip\b/i.test(raw), 'no ip field');
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(raw), 'no dotted quad anywhere');
});

// ─── The version bump — the one legalcheck.md says to test ────────────

ok('a version bump re-prompts: accepting v1 does NOT satisfy v2', () => {
  freshDir();
  append(newRecord({ ...base, termsVersion: '2026-08-25.1' }));
  const rows = all();
  assert.equal(hasAccepted(rows, '2026-08-25.1'), true, 'the accepted version passes');
  assert.equal(hasAccepted(rows, '2026-09-01.1'), false, 'a new version must re-prompt');
});

ok('accepting the new version does not erase the record of the old one', () => {
  freshDir();
  append(newRecord({ ...base, termsVersion: 'v1', now: Date.parse('2026-01-01T00:00:00Z') }));
  append(newRecord({ ...base, termsVersion: 'v2', now: Date.parse('2026-06-01T00:00:00Z') }));
  const rows = all();
  assert.equal(hasAccepted(rows, 'v1'), true);
  assert.equal(hasAccepted(rows, 'v2'), true);
  assert.equal(latest(rows).termsVersion, 'v2', 'latest is the most recent by time');
});

// ─── Robustness ───────────────────────────────────────────────────────

ok('a corrupted row does not destroy the evidence of every other acceptance', () => {
  const rows = parseLog(
    ['{"termsVersion":"v1","acceptedAt":"2026-01-01T00:00:00Z"}', 'not json at all', '', '{"half']
      .join('\n'),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].termsVersion, 'v1');
});

ok('a torn final write is tolerated', () => {
  freshDir();
  append(newRecord({ ...base, termsVersion: 'v1' }));
  fs.appendFileSync(logPath(), '{"termsVersion":"v2","acce');
  assert.equal(all().length, 1, 'the complete row still reads');
});

ok('a log that cannot be written does not throw — the user is not locked out', () => {
  // legalcheck.md: "failing to log must never block the user's action".
  init(path.join(os.tmpdir(), 'krypt-accept-\0bad'), 'x.jsonl');
  let result;
  assert.doesNotThrow(() => {
    result = append(newRecord({ ...base, termsVersion: 'v1' }));
  });
  assert.equal(result, false, 'it reports failure rather than pretending');
});

ok('no log yet is a normal first run, not an error', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-accept-empty-'));
  init(d, 'nothing-here.jsonl');
  assert.deepEqual(all(), []);
  assert.equal(hasAccepted(all(), 'v1'), false);
  assert.equal(latest(all()), null);
});

// ─── Retention — the promise the privacy policy makes ─────────────────

ok('rows past the retention period are identified', () => {
  const now = Date.parse('2026-08-25T00:00:00Z');
  const rows = [
    { termsVersion: 'old', acceptedAt: '2018-01-01T00:00:00Z' },
    { termsVersion: 'new', acceptedAt: '2026-08-01T00:00:00Z' },
  ];
  const expired = expiredRows(rows, now, 2555);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].termsVersion, 'old');
});

ok('purge enforces the policy and keeps everything still in period', () => {
  freshDir();
  append(newRecord({ ...base, termsVersion: 'ancient', now: Date.parse('2010-01-01T00:00:00Z') }));
  append(newRecord({ ...base, termsVersion: 'current', now: Date.parse('2026-08-01T00:00:00Z') }));
  const removed = purge(Date.parse('2026-08-25T00:00:00Z'), 2555);
  assert.equal(removed, 1);
  const rows = all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].termsVersion, 'current', 'the wrong row must not be the one kept');
});

ok('purge with nothing expired rewrites nothing', () => {
  freshDir();
  append(newRecord({ ...base, termsVersion: 'current', now: Date.parse('2026-08-01T00:00:00Z') }));
  const before = fs.readFileSync(logPath(), 'utf8');
  assert.equal(purge(Date.parse('2026-08-25T00:00:00Z'), 2555), 0);
  assert.equal(fs.readFileSync(logPath(), 'utf8'), before, 'untouched');
});

ok('an unparseable date is never silently treated as expired', () => {
  // Deleting evidence because a timestamp was odd is the worst possible bug
  // in a retention purge.
  const rows = [{ termsVersion: 'weird', acceptedAt: 'not a date' }];
  assert.equal(expiredRows(rows, Date.now(), 1).length, 0);
});

console.log(`acceptance: ${passed}/${passed} tests passed`);
