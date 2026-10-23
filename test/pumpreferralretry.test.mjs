// A referral pump did not settle is retried (2026-10-22): kept on disk, asked
// again by the sweep, removed on a final answer, dropped when the 24 h window
// is over or the account is signed out. Real files in a temp dir, fetch stubbed.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-refretry-'));
process.env.KRYPT_TEST_USERDATA = dir;
const { pumpSocial, pumpAuth } = await import('./.pumpreferralretry.mjs');

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const file = path.join(dir, 'pump-referral-pending.json');
const queue = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).pending : []);

let applyAnswer = { status: 503, body: 'busy' };
let applyCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/referral/apply')) {
    applyCalls += 1;
    return new Response(typeof applyAnswer.body === 'string' ? applyAnswer.body : JSON.stringify(applyAnswer.body), { status: applyAnswer.status });
  }
  return new Response('{}', { status: 200 }); // register and everything else
};

try {
  pumpAuth._put({ address: 'AddrRetry111111111111111111111111111', walletId: 'w-retry', token: 't', at: Date.now(), username: null, via: 'wallet' });

  // 1. pump busy: not settled, so it is queued.
  assert.equal(await pumpSocial.applyReferral('w-retry'), 'unknown');
  assert.equal(queue().length, 1, 'a failed attempt is kept on disk');
  assert.equal(queue()[0].walletId, 'w-retry');
  const since = queue()[0].since;
  ok('a referral pump could not answer is queued on disk');

  // 2. Too soon: the sweep leaves it alone.
  const before = applyCalls;
  await pumpSocial.sweepReferrals(Date.now() + 60_000);
  assert.equal(applyCalls, before, 'not asked again inside the retry interval');
  ok('the sweep waits out the retry interval');

  // 3. Later, pump answers: applied, and the queue empties.
  applyAnswer = { status: 200, body: { outcome: 'applied', referral: { appliedUsername: 'kryptcc' } } };
  await pumpSocial.sweepReferrals(Date.now() + 6 * 60_000);
  assert.equal(applyCalls, before + 1, 'asked again once it was due');
  assert.equal(queue().length, 0, 'applied leaves the queue (file removed)');
  assert.ok(!fs.existsSync(file));
  ok('a retry that pump accepts clears the queue');

  // 4. A queued account whose window is over is dropped without asking.
  pumpAuth._put({ address: 'AddrOld2222222222222222222222222222', walletId: 'w-old', token: 't2', at: Date.now(), username: null, via: 'wallet' });
  fs.writeFileSync(file, JSON.stringify({ version: 1, pending: [{ address: 'AddrOld2222222222222222222222222222', walletId: 'w-old', since: 1_000, lastTried: 1_000, tries: 3, last: 'unknown' }] }));
  const calls2 = applyCalls;
  await pumpSocial.sweepReferrals(1_000 + 25 * 3_600_000);
  assert.equal(applyCalls, calls2, 'nothing is asked after the window');
  assert.equal(queue().length, 0, 'and the entry is gone');
  ok('an expired entry is dropped without a request');

  // 5. Signed out: the entry is dropped too.
  fs.writeFileSync(file, JSON.stringify({ version: 1, pending: [{ address: 'AddrGone33333333333333333333333333', walletId: 'w-gone', since: Date.now(), lastTried: 0, tries: 1, last: 'unknown' }] }));
  await pumpSocial.sweepReferrals(Date.now() + 6 * 60_000);
  assert.equal(queue().length, 0, 'no session, nothing to refer');
  ok('a signed-out account leaves the queue');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\npumpreferralretry: ${passed}/${passed} passed`);
process.exit(0);
