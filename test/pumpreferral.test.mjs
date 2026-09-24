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
  assert.match(settle, /ensureRegistered[\s\S]*applyReferral[\s\S]*stampEmptyBio/, 'register, then refer, then the bio');
  assert.equal((ipc.match(/settlePumpAccount\(/g) ?? []).length, 4, 'every sign-in path settles the account');
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

console.log(`\npumpreferral: ${passed}/${passed} passed`);
