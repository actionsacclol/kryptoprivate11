// Splitting a position across your own wallets, spaced over time.
//
// The previous version of this feature was REMOVED on 2026-09-14 because it
// bought the same coin from every wallet at once, which reads as wash trading
// whatever the intent. It is back by request, shaped by that reasoning rather
// than in spite of it, and these are the rules that make the difference:
//
//   • buys are SEQUENTIAL and separated by a real gap, never simultaneous
//   • at most ten of your wallets per coin
//   • off entirely until the acknowledgement is given, to the current wording
//
// 2026-09-22: groups AND the Copier (other wallets copying your manual trades)
// were removed on the owner's call. What remains multi-wallet is a SCRIPT
// naming one of your wallets per call, behind the acknowledgement — and the
// launcher's single-wallet fan-out, which keeps these gates.
//
// The most load-bearing test here is the one asserting the execution loop is
// not `Promise.all`. Someone tidying that into a parallel map would silently
// restore the exact behaviour the feature was deleted for, and nothing at
// runtime would look wrong.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  consentValid,
  DEFAULT_GAP_MAX_MS,
  DEFAULT_GAP_MIN_MS,
  gapRange,
  maxRunMs,
  randomGap,
  MAX_GAP_MS,
  MAX_WALLETS_PER_TOKEN,
  MIN_GAP_MS,
  MULTI_WALLET_CONSENT_TEXT,
  MULTI_WALLET_CONSENT_VERSION,
  multiWalletProblem,
  NO_CONSENT,
  scheduleFor,
} from './.multiwallet.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const GOOD = { acceptedAt: 1_790_000_000_000, version: MULTI_WALLET_CONSENT_VERSION };

{
  // The numbers the whole thing rests on.
  assert.equal(MAX_WALLETS_PER_TOKEN, 10, 'ten wallets per coin (raised from five 09-22)');
  assert.equal(MIN_GAP_MS, 5_000, 'a five second floor between pieces');
  assert.equal(MAX_GAP_MS, 5 * 60_000, 'and a five minute ceiling on any one gap');
  assert.ok(DEFAULT_GAP_MIN_MS > MIN_GAP_MS, 'the default range starts above the floor, not on it');
  assert.ok(DEFAULT_GAP_MAX_MS > DEFAULT_GAP_MIN_MS, 'and it is a real range');
  assert.ok(DEFAULT_GAP_MAX_MS < MAX_GAP_MS, 'with room above it');
  // The worst case a user can produce is bounded and reasonable to reason
  // about: a queued buy is a decision made earlier and executed later, and on
  // a memecoin twenty minutes is already a different proposition.
  assert.equal(maxRunMs(MAX_WALLETS_PER_TOKEN, MAX_GAP_MS, MAX_GAP_MS), 45 * 60_000, 'ten wallets at the cap finish inside forty-five minutes');
  assert.equal(maxRunMs(1, MAX_GAP_MS, MAX_GAP_MS), 0, 'one wallet waits for nothing');
  ok('ten wallets, a five second floor, a five minute ceiling, forty-five minutes worst case');
}

{
  // THE FLOOR CANNOT BE ASKED AWAY. Every route to a shorter gap comes back
  // at or above it — this is the rule that separates spacing from a bundle.
  for (const asked of [0, -1, 1, 999, 4_999, NaN, Infinity, -Infinity]) {
    const r = gapRange(asked, asked);
    assert.ok(r.minMs >= MIN_GAP_MS, `asking for ${asked} still gets at least the floor`);
    assert.ok(randomGap(asked, asked) >= MIN_GAP_MS, `and a draw from it is never under the floor`);
  }
  assert.deepEqual(gapRange(10_000, 45_000), { minMs: 10_000, maxMs: 45_000 }, 'a sane range is honoured as asked');
  assert.deepEqual(gapRange(9e9, 9e9), { minMs: MAX_GAP_MS, maxMs: MAX_GAP_MS }, 'an absurd one is capped');
  // A max below the min is a mistake, not an instruction to go faster.
  assert.deepEqual(gapRange(60_000, 10_000), { minMs: 60_000, maxMs: 60_000 }, 'an inverted range collapses upward, never downward');
  ok('no caller can ask for a shorter gap than the floor, or invert the range to get one');
}

{
  // RANDOMISED, and inside its bounds. The draw is uniform over the range;
  // `rand` is injected so this asserts the arithmetic rather than sampling.
  assert.equal(randomGap(10_000, 45_000, () => 0), 10_000, 'the bottom of the range is reachable');
  assert.equal(randomGap(10_000, 45_000, () => 0.999999), 45_000, 'and so is the top');
  assert.equal(randomGap(10_000, 45_000, () => 0.5), 27_500, 'the middle is the middle');
  // A real sample stays inside the bounds and is not a constant.
  const draws = Array.from({ length: 4_000 }, () => randomGap(10_000, 45_000));
  assert.ok(Math.min(...draws) >= 10_000 && Math.max(...draws) <= 45_000, 'every draw is inside the range');
  assert.ok(new Set(draws).size > 100, 'the gaps actually vary — a fixed beat is its own signature');
  // A zero-width range is allowed and simply means "this exact gap".
  assert.equal(randomGap(30_000, 30_000), 30_000);
  ok('gaps are drawn at random from the range, inside its bounds, never constant');
}

{
  // Off until acknowledged, and an acknowledgement given to DIFFERENT wording
  // does not count.
  assert.equal(consentValid(null), false);
  assert.equal(consentValid(undefined), false);
  assert.equal(consentValid(NO_CONSENT), false, 'the never-accepted default is not consent');
  assert.equal(consentValid({ acceptedAt: 0, version: MULTI_WALLET_CONSENT_VERSION }), false, 'a zero timestamp is not consent');
  assert.equal(consentValid({ acceptedAt: 1, version: 'older-wording' }), false, 'consent to older wording does not carry');
  assert.equal(consentValid(GOOD), true);
  ok('it stays off until acknowledged, and old wording does not carry forward');
}

{
  // The refusals, in the order someone meets them.
  assert.match(multiWalletProblem(2, null), /off until you read and accept/);
  assert.match(multiWalletProblem(2, { acceptedAt: 1, version: 'old' }), /off until you read and accept/);
  assert.equal(multiWalletProblem(MAX_WALLETS_PER_TOKEN, GOOD), null, 'the cap itself is allowed');
  assert.match(multiWalletProblem(MAX_WALLETS_PER_TOKEN + 1, GOOD), /allows 10/, 'one over is refused and says the number');
  assert.match(multiWalletProblem(0, GOOD), /at least one/);
  assert.match(multiWalletProblem(2.5, GOOD), /at least one/, 'a non-integer count is not rounded into something');
  ok('every refusal says which limit was hit');
}

{
  // The schedule: first immediately, each one a fresh draw later, strictly
  // increasing, and never more entries than the cap however many wallets are
  // handed in.
  const fixed = scheduleFor(5, 20_000, 20_000);
  assert.deepEqual(fixed, [0, 20_000, 40_000, 60_000, 80_000], 'a zero-width range gives an exact ladder');

  const s = scheduleFor(5, 10_000, 45_000);
  assert.equal(s[0], 0, 'the first piece is immediate');
  for (let i = 1; i < s.length; i++) {
    const gap = s[i] - s[i - 1];
    assert.ok(gap >= MIN_GAP_MS, 'every gap clears the floor');
    assert.ok(gap <= MAX_GAP_MS, 'and none exceeds the ceiling');
    assert.ok(s[i] > s[i - 1], 'the schedule only moves forward');
  }
  assert.equal(scheduleFor(50, 10_000, 45_000).length, MAX_WALLETS_PER_TOKEN, 'more wallets than the cap are cut to the cap');
  assert.deepEqual(scheduleFor(0, 10_000, 45_000), []);
  // Asking for no gap at all still spaces them.
  const squeezed = scheduleFor(3, 0, 0);
  assert.ok(squeezed[1] >= MIN_GAP_MS && squeezed[2] - squeezed[1] >= MIN_GAP_MS, 'a zero request is still spaced');
  ok('pieces are spaced from the first, capped in number, and never squeezed together');
}

{
  // The wording names the thing rather than gesturing at "risks", and says
  // what the app does NOT do for a script — since 2026-09-22 scripts are the
  // only multi-wallet path, and the app neither spaces nor caps them.
  const text = MULTI_WALLET_CONSENT_TEXT.join(' ');
  assert.match(text, /wash trading/i, 'it says what the line is');
  assert.match(text, /not legal advice/i);
  assert.match(text, /script/i, 'it is about scripts now');
  assert.match(text, /does not space these trades out or limit how many of your wallets/i, 'and does not promise spacing it does not apply');
  assert.doesNotMatch(text, /at least \d+ seconds/, 'the old Copier wording is gone');
  assert.match(MULTI_WALLET_CONSENT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/, 'the version is sortable, so a bump is obvious');
  assert.notEqual(MULTI_WALLET_CONSENT_VERSION, '2026-09-22.1', 'new words, new version: the old acceptance is asked again');
  ok('the acknowledgement names wash trading and says what it does and does not do');
}

{
  // ── THE ONE THAT MATTERS ──
  //
  // The execution loop must be SEQUENTIAL. It used to be `Promise.all` over
  // the shares with a random delay of up to two seconds, defaulting to zero —
  // every wallet in the same slot. A future tidy-up back to a parallel map
  // would restore exactly what the feature was deleted for, and nothing at
  // runtime would look wrong.
  const eng = src('../electron/engine/engine.ts');
  const buy = eng.slice(eng.indexOf('async fanoutBuy('), eng.indexOf('/** Run a live trade serialized'));
  assert.ok(buy.length > 0, 'fanoutBuy is findable');
  assert.doesNotMatch(buy, /Promise\.all\(\s*plan\.shares/, 'the shares are NOT bought in parallel');
  assert.match(buy, /for \(const sh of plan\.shares\)/, 'they are bought one after another');
  assert.match(buy, /await new Promise\(\(r\) => setTimeout\(r, g\)\)/, 'with a wait between them');
  assert.match(buy, /gapRange\(opts\.gapMinMs \?\? 0, opts\.gapMaxMs \?\? 0\)/, 'the range is floored and capped by the shared rule, not a local number');
  // A FRESH draw inside the loop, not one interval computed once and reused —
  // reusing it would turn the spacing back into a fixed beat.
  assert.match(buy, /const g = randomGap\(spread\.minMs, spread\.maxMs\);/, 'each gap is drawn separately');
  assert.ok(buy.indexOf('randomGap(') > buy.indexOf('for (const sh of plan.shares)'), 'and the draw happens inside the loop');
  // The old two-second jitter is gone entirely.
  assert.doesNotMatch(eng, /staggerMaxMs/, 'the old sub-second stagger is gone');
  ok('fan-out buys run one at a time with a floored gap, never in parallel');
}

{
  // The gate is enforced in MAIN, and only when more than one wallet is
  // involved — the launcher comes through the same path with exactly one, and
  // demanding the acknowledgement for that would break launching to guard
  // something that is not happening.
  const eng = src('../electron/engine/engine.ts');
  const pre = eng.slice(eng.indexOf('async fanoutPreflight('), eng.indexOf('async fanoutBuy('));
  assert.match(pre, /if \(walletIds\.length > 1\)/, 'the gate applies only to a real multi-wallet buy');
  assert.match(pre, /multiWalletProblem\(walletIds\.length, s\.multiWallet\)/, 'and uses the shared rule');
  ok('main enforces the gate, and a single-wallet buy is untouched by it');
}

{
  // The consent lives in settings, where the validator compares a value's type
  // to its DEFAULT's type. `typeof null` is 'object', so a null default would
  // reject every real timestamp and the acceptance would silently never save.
  // That exact shape has bitten this codebase before.
  const types = src('../shared/types.ts');
  assert.match(types, /multiWallet: \{ acceptedAt: 0, version: '' \}/, 'never-accepted is 0, not null');
  const shared = src('../shared/multiWallet.ts');
  assert.match(shared, /acceptedAt: number;/, 'and the type is a plain number');
  assert.doesNotMatch(shared, /acceptedAt: number \| null/, 'no nullable timestamp to trip the validator');
  ok('the acceptance is stored as a number so the settings validator keeps it');
}

{
  // ── The Copier is gone (2026-09-22) ──
  //
  // No wallet repeats your manual trades any more. A manual buy, a manual sell
  // and a launch's dev buy trade from the one wallet that made them, and
  // nothing else follows.
  const eng = src('../electron/engine/engine.ts');
  assert.doesNotMatch(eng, /followManualTrade|followLaunchBuy/, 'the follow path does not exist');
  const ipc = src('../electron/ipc.ts');
  assert.doesNotMatch(ipc, /followLaunchBuy|lab:setCopy|lab:setFollow/, 'nothing calls or configures it');
  const store = src('../electron/system/walletStore.ts');
  assert.doesNotMatch(store, /copy\?: |setWalletCopy/, 'a wallet has no copy setting to store');
  ok('nothing copies the main wallet: no follow path, no setting, no channel');
}

{
  // The Wallet list makes wallets, switches the main one and signs pump.fun
  // accounts in. It never trades, and it offers nothing that copies.
  const page = src('../src/pages/lab/Creator.tsx');
  assert.doesNotMatch(page, /multiwallet\.buy|testTrade|manualSell/, 'the page places no trades of its own');
  assert.doesNotMatch(page, /setCopy|Copy main|MULTI_WALLET_CONSENT_TEXT/, 'and has no copy controls or acknowledgement');
  ok('the Wallet list has no copying on it');
}

{
  // ── The acknowledgement, end to end ──
  //
  // This is the switch everything hangs off, and every way of getting it
  // wrong is silent: the user sees a screen that looks on while main refuses
  // every trade, or the reverse.
  // On the Scripts page, with the only thing that uses it: a script trading
  // from one of your other wallets by address.
  const ui = src('../src/components/MultiWalletConsent.tsx');
  assert.match(src('../src/pages/Scripts.tsx'), /<MultiWalletConsent \/>/, 'the Scripts page shows it');
  assert.match(src('../shared/multiWallet.ts'), /Automation › Scripts › Trading from your other wallets/, 'and a refusal says where it is');

  // The words shown are the SHARED constant, not a copy. A second copy would
  // drift from the limits the code enforces, and someone would be accepting
  // wording that no longer describes what happens.
  assert.match(ui, /MULTI_WALLET_CONSENT_TEXT\.map/, 'the wording shown is the shared constant');
  assert.doesNotMatch(ui, /wash trading/i, 'and is not re-typed into the component');

  // Accepting goes through the dedicated handler, never a settings patch —
  // main stamps the wording version, so a renderer cannot claim consent to
  // words the user never saw.
  assert.match(ui, /multiwallet\.accept\(on\)/, 'accepting goes through its own handler');
  assert.doesNotMatch(ui, /updateSettings\(\{ multiWallet/, 'the renderer never patches the consent into settings itself');
  assert.match(ui, /consentValid\(settings\.multiWallet\)/, 'and the shared check decides whether it is on');

  const ipc = src('../electron/ipc.ts');
  const accept = ipc.slice(ipc.indexOf("ipcMain.handle('multiwallet:accept'"), ipc.indexOf("ipcMain.handle('multiwallet:accept'") + 900);
  assert.match(accept, /MULTI_WALLET_CONSENT_VERSION/, 'main stamps the version from the shared constant');
  // The only `version:` it writes is the constant — never a property read
  // off whatever the renderer sent.
  const versions = [...accept.matchAll(/version: ([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(versions)], ['MULTI_WALLET_CONSENT_VERSION'], `only the constant is written: ${versions.join(', ')}`);
  assert.doesNotMatch(accept, /accept.version|f.version|raw.version/, 'and no version is read from the caller');
  ok('the acknowledgement shows the shared wording and is stamped in main');
}

{
  // There is NO "split this buy across wallets" channel. It was built and
  // removed the same day: nothing called it, and a money-spending handler
  // with no caller is a liability rather than a feature. Someone who wants a
  // smaller position buys less on their trading wallet and lets the Copier's
  // followers do the rest — one path instead of two.
  const ipc = src('../electron/ipc.ts');
  const pre = src('../electron/preload.ts');
  for (const [name, text] of [['ipc.ts', ipc], ['preload.ts', pre]]) {
    assert.doesNotMatch(text, /multiwallet:buy/, `${name} has no split-buy channel`);
    assert.doesNotMatch(text, /multiwallet:preflight/, `${name} has no split-buy preflight either`);
  }
  // The engine keeps `fanoutBuy` — the LAUNCHER uses it for a single-wallet
  // dev buy — and keeps its gate, which is the right defence if a
  // multi-wallet caller is ever added back.
  const eng = src('../electron/engine/engine.ts');
  assert.match(eng, /async fanoutBuy\(/, 'the engine still has it for the launcher');
  assert.match(eng, /if \(walletIds\.length > 1\)/, 'and the gate is still on it');
  ok('no split-buy channel exists, and the engine gate stays for the launcher');
}

{
  // A launch's dev buy is a fan-out of ONE through the ordinary gates, and
  // nothing follows it any more.
  const ipc = src('../electron/ipc.ts');
  const dev = ipc.slice(ipc.indexOf('devBuy: async (mint, walletId, sol)'), ipc.indexOf('canBuy: (walletId, sol)'));
  assert.ok(dev.length > 0, 'the launcher has a dev buy');
  assert.match(dev, /fanoutBuy\(mint, \[walletId\]/, 'one wallet, through the ordinary gates');
  assert.doesNotMatch(dev, /follow/i, 'and no other wallet follows it');
  ok('a launch buys from its one wallet, and nothing follows it');
}

{
  // LOCKED IN THE UI, UNLOCKED FOR SCRIPTS (2026-09-22).
  //
  // The five-wallets-per-coin cap governs the AUTOMATIC path — a group whose
  // membership decides how many wallets touch a coin without anyone writing it
  // down. A script names one wallet per call, in code somebody wrote, and its
  // own budget is what bounds it. So the cap stays where it was and the script
  // path does not consult it.
  const eng = src('../electron/engine/engine.ts');
  const at = eng.indexOf('private async scriptWalletTrade(');
  const st = at < 0 ? '' : eng.slice(at, at + 1400);
  assert.ok(st.length > 0, 'a script can trade with a named wallet');
  assert.match(st, /multiWalletProblem\(1, s\.multiWallet\)/, 'the acknowledgement still applies');
  assert.doesNotMatch(st, /MAX_WALLETS_PER_TOKEN/, 'the per-coin cap does not');
  // The address must be the user's OWN. A wallet this app holds no key for is
  // refused rather than falling back to the active one.
  assert.match(st, /wallet\.list\(\)\.find\(\(w\) => w\.publicKey === address\)/, 'the address must be a wallet of theirs');
  assert.match(st, /no wallet of yours has the address/, 'and an unknown one is refused');

  // And a script's named-wallet buy is still its own budget's business.
  const autos = src('../electron/engine/automation.ts');
  const wt = autos.slice(autos.indexOf('async function walletTrade('), autos.indexOf('async function handleCall('));
  assert.match(wt, /buyGate\(s, rt, mint, amount, label\)/, 'the script budget gates it');
  assert.match(wt, /rateLimited\(/, 'so does its action rate');
  assert.match(wt, /s\.mode === 'paper'/, 'and paper spends nothing');
  assert.match(wt, /rt\.buysToday \+= 1/, 'a named-wallet buy counts as one of its buys');
  assert.match(wt, /if \(!rt\.opened\.has\(mint\)\)/, 'it can only sell a mint it opened');
  ok('a script trades from a named wallet of yours, behind the acknowledgement and its own budget');
}

{
  // GROUPS ARE GONE (2026-09-22): no channel creates, fills or lists one.
  const ipc = src('../electron/ipc.ts');
  const pre = src('../electron/preload.ts');
  for (const [name, text] of [['ipc.ts', ipc], ['preload.ts', pre]]) {
    assert.doesNotMatch(text, /wallet:(groups|createGroup|renameGroup|deleteGroup|setGroupMembers)|lab:setFollow|lab:setCopy/, `${name} has no group channel`);
  }
  ok('there is no way left to make or fill a wallet group');
}

console.log(`\nmultiwallet: ${passed}/${passed} passed`);
