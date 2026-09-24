// pump.fun follows and likes (2026-09-22).
//
// The routes were read from pump's own site code and confirmed live with two
// throwaway accounts. What these checks protect:
//
//   • a target is an ID of the right shape, never a path. Whatever a script
//     passes, the request goes to one of four fixed routes with one segment.
//
//   • accounts are REGISTERED before they act. Without /users/register a
//     fresh API sign-in is refused follows (409) and likes (403 "no
//     coin-communities profile") — that was the first thing the live test hit.
//
//   • paper does nothing. A follow is public; there is no rehearsal of it
//     other than saying what it would have done.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  REGISTER_PATH,
  SOCIAL_ACTIONS,
  calloutTarget,
  pumpUserTarget,
  socialLabel,
  socialRoute,
  socialTarget,
} from './.pumpsocial.mjs';
import { calloutIdFrom } from './.calloutauto.mjs';

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok   ${name}`);
};

const ADDR = 'DDia3RHCCb3GjTF1kRDXmHdyXz2Uhu1od9SbuxgkRC67';
const UUID = 'ffe8057d-da74-49d4-94d9-933a68d1bf0f';

{
  assert.equal(pumpUserTarget(ADDR), ADDR, 'a wallet address');
  assert.equal(pumpUserTarget(`  ${ADDR} `), ADDR, 'trimmed');
  assert.equal(pumpUserTarget(UUID.toUpperCase()), UUID, 'a pump user id, lower-cased');
  assert.equal(pumpUserTarget(`https://pump.fun/profile/${ADDR}`), ADDR, 'a pasted profile link');
  assert.equal(pumpUserTarget(`pump.fun/profile/${ADDR}?tab=coins`), ADDR, 'with a query after it');
  assert.equal(pumpUserTarget('NotARealWallet111'), null, 'too short for an address');
  assert.equal(pumpUserTarget(`${ADDR}/../../auth`), null, 'no extra path');
  assert.equal(pumpUserTarget(`https://evil.example/profile/${ADDR}`), null, 'another site’s link is not a pump profile');
  assert.equal(pumpUserTarget(42), null, 'not a string');
  ok('a follow target is an address, a user id or a pump profile link — nothing else');
}

{
  assert.equal(calloutTarget(UUID), UUID);
  assert.equal(calloutTarget(`https://pump.fun/coin/xyz?callout=${UUID}`), UUID, 'the id out of a pasted link');
  assert.equal(calloutTarget('12345'), null);
  assert.equal(socialTarget('like', ADDR), null, 'an address is not a callout');
  assert.equal(socialTarget('follow', UUID), UUID, 'a user id is a follow target');
  ok('a like target is a callout id');
}

{
  assert.deepEqual(socialRoute('follow', ADDR), { method: 'POST', path: `/following/v2/${ADDR}` });
  assert.deepEqual(socialRoute('unfollow', ADDR), { method: 'DELETE', path: `/following/${ADDR}` });
  assert.deepEqual(socialRoute('like', UUID), { method: 'POST', path: `/callout/${UUID}/like` });
  assert.deepEqual(socialRoute('unlike', UUID), { method: 'DELETE', path: `/callout/${UUID}/like` });
  assert.equal(REGISTER_PATH, '/users/register');
  assert.deepEqual([...SOCIAL_ACTIONS], ['follow', 'unfollow', 'like', 'unlike']);
  assert.match(socialLabel('follow', ADDR), /^followed DDia3RHC…$/);
  ok('the four routes are the ones confirmed live 09-22');
}

{
  const main = fs.readFileSync('electron/system/pumpSocial.ts', 'utf8');
  assert.match(main, /PUMP_API_HOST/, 'the host is the constant');
  assert.doesNotMatch(main, /fetch\(\s*(?:target|rawTarget|url)\b/, 'never fetches a caller’s string');
  assert.match(main, /socialTarget\(action, rawTarget\)/, 'every target is checked before use');
  assert.match(main, /redirect: 'error'/, 'redirects refused');
  ok('main builds every request from the constant host and a checked id');
}

{
  const ipc = fs.readFileSync('electron/ipc.ts', 'utf8');
  const cal = fs.readFileSync('electron/engine/autoCallout.ts', 'utf8');
  assert.match(ipc, /async function settlePumpAccount[\s\S]{0,200}ensureRegistered/, 'sign-in registers');
  assert.equal((ipc.match(/settlePumpAccount\(/g) ?? []).length, 4, 'all three sign-in paths settle (plus the definition)');
  assert.equal((cal.match(/await ensureRegistered\(walletId\)/g) ?? []).length, 2, 'callouts and replies register first');
  ok('every sign-in path and every callout registers the account');
}

{
  const auto = fs.readFileSync('electron/engine/automation.ts', 'utf8');
  const block = auto.slice(auto.indexOf("case 'follow':"), auto.indexOf("case 'pumpAccounts':"));
  const paper = block.indexOf("s.mode === 'paper'");
  const call = block.indexOf('h.pumpSocial(');
  assert.ok(paper > 0 && call > paper, 'paper returns before the hook is called');
  assert.match(block, /rateLimited\(/, 'counts against the script’s actions per minute');
  const proto = fs.readFileSync('shared/scriptProtocol.ts', 'utf8');
  const api = fs.readFileSync('shared/automation.ts', 'utf8');
  for (const m of SOCIAL_ACTIONS) {
    assert.match(proto, new RegExp(`'${m}',`), `${m} is a script method`);
    assert.match(api, new RegExp(`method: '${m}'`), `${m} is in the reference`);
  }
  ok('scripts get follow/unfollow/like/unlike; paper sends nothing');
}

{
  // A script likes the callout it just posted, so bot.callout must hand back
  // the id. pump's create answer was never observed, so it is read in any of
  // the likely shapes, and only a UUID counts.
  assert.equal(calloutIdFrom(JSON.stringify({ id: UUID })), UUID);
  assert.equal(calloutIdFrom(JSON.stringify({ calloutId: UUID.toUpperCase() })), UUID);
  assert.equal(calloutIdFrom(JSON.stringify({ callout: { id: UUID } })), UUID);
  assert.equal(calloutIdFrom(JSON.stringify({ id: 42 })), null);
  assert.equal(calloutIdFrom(''), null, 'an empty 201 has no id');
  const cal = fs.readFileSync('electron/engine/autoCallout.ts', 'utf8');
  assert.match(cal, /existingCalloutId \?\? null/, 'falls back to a second preflight');
  ok('a posted callout hands back its id');
}

{
  // "Like your own callouts" (09-22): on by default, kept on for a settings
  // file that predates it, and honoured by every path that posts.
  const types = fs.readFileSync('shared/types.ts', 'utf8');
  const store = fs.readFileSync('electron/system/settings-store.ts', 'utf8');
  const cal = fs.readFileSync('electron/engine/autoCallout.ts', 'utf8');
  const engine = fs.readFileSync('electron/engine/engine.ts', 'utf8');
  const ipc = fs.readFileSync('electron/ipc.ts', 'utf8');
  assert.match(types, /autoCallout: \{[^}]*likeOwn: true/, 'on by default');
  assert.match(store, /likeOwn: loaded\.autoCallout\?\.likeOwn !== false/, 'an old file without the key reads as on');
  assert.match(cal, /opts\.likeOwn && calloutId[\s\S]{0,80}socialAct\(walletId, 'like', calloutId\)/, 'the posting account likes it');
  assert.match(cal, /postNow\(walletId, mint, text, \{ likeOwn: settings\.likeOwn \}\)/, 'auto-callout on a buy (text = the filled thesis)');
  assert.match(engine, /postNow\(pick\.walletId, mint, text, \{ likeOwn: this\.getSettings\(\)\.autoCallout\.likeOwn \}\)/, 'scripts');
  assert.match(ipc, /postNow\(id, m, t, \{ likeOwn: store\.load\(\)\.autoCallout\.likeOwn \}\)/, 'the test button');
  ok('every callout the app posts is liked by its author unless switched off');
}

console.log(`\npumpsocial: ${passed}/${passed} passed`);
