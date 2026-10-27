// Krypt's pump.fun referral (2026-09-22).
//
// Every pump account made or signed in through the app is referred by Krypt's
// own pump.fun account. Pinned the way the fee treasury is: the code is one
// constant, every sign-in path applies it inside pump's 24 h window, and the
// terms, the clickwrap summary and the screen where accounts are made all say
// so. A change to any of those should fail here first.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  KRYPT_REFERRAL_CODE,
  REFERRAL_APPLY_PATH,
  REFERRAL_NOTICE,
  SETTLED_OUTCOMES,
  referralOutcomeFrom,
  REFERRAL_WINDOW_MS,
  REFERRAL_RETRY_MS,
  referralDue,
  referralExpired,
  referralQueueAfter,
} from './.pumpreferral.mjs';
import { ALL_DOCUMENTS, PRIVACY_POLICY, CLICKWRAP_SUMMARY } from './.legaldocs.mjs';

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok   ${name}`);
};

{
  // pump.fun username Ff4Mw51MqPt6wgcY1TsLFdHp94Cqx9Bris9EapMyvNkm, checked 09-22.
  assert.equal(KRYPT_REFERRAL_CODE, 'kryptcc', 'the referral code is Krypt’s pump username');
  assert.equal(REFERRAL_APPLY_PATH, '/referral/apply');
  ok('the code is pinned');
}

{
  assert.equal(referralOutcomeFrom({ outcome: 'applied', referral: {} }), 'applied');
  assert.equal(referralOutcomeFrom({ outcome: 'unknownUsername' }), 'unknownUsername', 'seen live 09-22 for a made-up code');
  assert.equal(referralOutcomeFrom({ outcome: 'somethingNew' }), 'unknown', 'a new outcome is unknown, not success');
  assert.equal(referralOutcomeFrom(null), 'unknown');
  assert.ok(SETTLED_OUTCOMES.includes('applyWindowClosed'), 'an account past its window is not asked again');
  assert.ok(!SETTLED_OUTCOMES.includes('unknownUsername'), 'our code going wrong is never remembered as settled');
  ok('pump’s answer is read as one of its own outcomes, and unknown otherwise');
}

{
  const ipc = fs.readFileSync('electron/ipc.ts', 'utf8');
  const main = fs.readFileSync('electron/system/pumpSocial.ts', 'utf8');
  const settle = ipc.slice(ipc.indexOf('async function settlePumpAccount'), ipc.indexOf('async function settlePumpAccount') + 600);
  assert.match(settle, /ensureRegistered[\s\S]*applyReferral[\s\S]*ensureBioMark/, 'register, then refer, then the bio');
  // 7 since 10-25: + the browser sign-in and both paths that move a browser session onto an imported wallet.
  assert.equal((ipc.match(/settlePumpAccount\(/g) ?? []).length, 7, 'every sign-in path settles the account');
  assert.match(main, /JSON\.stringify\(\{ username: KRYPT_REFERRAL_CODE \}\)/, 'the body is the pinned code and nothing else');
  assert.match(main, /PUMP_API_HOST/, 'to the constant host');
  ok('every account signed in through the app is referred');
}

{
  const terms = ALL_DOCUMENTS.flatMap((d) => d.sections).find((s) => /Fees/.test(s.heading)).body.join('\n');
  assert.match(terms, new RegExp(`referral code \\("${KRYPT_REFERRAL_CODE}"\\)`), 'the terms name the code');
  assert.match(terms, /deducts from that account's reward/, 'and say it comes out of the user’s rewards');
  assert.match(terms, /not optional/i, 'and that it is not optional');
  const point = CLICKWRAP_SUMMARY.find((p) => /referred/.test(p.title));
  assert.ok(point && point.flagged, 'the summary accepted before first use carries it, flagged');
  const privacy = PRIVACY_POLICY.sections.map((s) => s.body.join('\n')).join('\n');
  assert.match(privacy, /referred by our pump\.fun account/, 'the privacy policy says it too');
  assert.match(REFERRAL_NOTICE, /share of the callout rewards/, 'and so does the screen where accounts are made');
  for (const f of ['src/pages/PumpAccounts.tsx', 'src/components/terminal/PumpAccountsSection.tsx']) {
    assert.match(fs.readFileSync(f, 'utf8'), /\{REFERRAL_NOTICE\}/, `${f} shows the notice`);
  }
  ok('it is disclosed in the terms, the summary, the privacy policy and where accounts are made');
}

{
  // A referral pump did not settle is kept and asked again; a final answer ends it.
  const who = { address: 'AddrA', walletId: 'w1' };
  const t0 = 1_000_000;
  let q = referralQueueAfter([], who, 'unknown', t0);
  assert.equal(q.length, 1, 'a failed attempt is queued');
  assert.equal(q[0].since, t0);
  q = referralQueueAfter(q, who, 'unknown', t0 + REFERRAL_RETRY_MS);
  assert.equal(q.length, 1, 'still one entry per account');
  assert.equal(q[0].since, t0, 'the window is counted from the FIRST failure, not the latest');
  assert.equal(q[0].tries, 2);
  q = referralQueueAfter(q, who, 'unknownUsername', t0 + 2 * REFERRAL_RETRY_MS);
  assert.equal(q.length, 1, 'our code going wrong is retried, not treated as final');
  assert.equal(referralQueueAfter(q, who, 'applied', t0 + 3 * REFERRAL_RETRY_MS).length, 0, 'applied leaves the queue');
  assert.equal(referralQueueAfter(q, who, 'applyWindowClosed', t0 + 3 * REFERRAL_RETRY_MS).length, 0, 'a closed window leaves it too');
  const other = referralQueueAfter(q, { address: 'AddrB', walletId: 'w2' }, 'unknown', t0);
  assert.equal(referralQueueAfter(other, who, 'applied', t0).length, 1, 'settling one account leaves the other queued');
  ok('an unsettled referral stays queued from its first failure; a final answer removes it');
}

{
  const p = { address: 'A', walletId: 'w', since: 0, lastTried: 0, tries: 1, last: 'unknown' };
  assert.ok(!referralDue(p, REFERRAL_RETRY_MS - 1), 'not asked again before the interval');
  assert.ok(referralDue(p, REFERRAL_RETRY_MS), 'asked again after it');
  assert.ok(!referralExpired(p, 60_000));
  assert.ok(referralExpired(p, REFERRAL_WINDOW_MS), 'past 24 h it is dropped');
  assert.ok(referralExpired(p, REFERRAL_WINDOW_MS - 5 * 60_000), 'and a little before, when an answer would be too late');
  assert.ok(!referralDue({ ...p, lastTried: REFERRAL_WINDOW_MS }, REFERRAL_WINDOW_MS + REFERRAL_RETRY_MS), 'never due once expired');
  ok('retries run every few minutes and stop when pump’s 24 h window is over');
}

{
  const soc = fs.readFileSync('electron/system/pumpSocial.ts', 'utf8');
  assert.match(soc, /const outcome = await attemptReferral\(walletId\)/, 'every apply goes through the queue');
  assert.match(soc, /pump-referral-pending\.json/);
  assert.match(soc, /referralQueueAfter\(/);
  const main = fs.readFileSync('electron/main.ts', 'utf8');
  assert.match(main, /pumpSocial\.startReferralRetries\(\)/, 'leftovers from an earlier run are retried at startup');
  ok('the queue is on the apply path and is restarted at launch');
}

console.log(`\npumpreferral: ${passed}/${passed} passed`);
