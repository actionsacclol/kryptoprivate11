// Auto-callout — posting a pump.fun callout on the coins you buy.
//
// A callout is a public statement under the user's name that other people
// trade against, so the rules here are about what goes out and when. The two
// that matter most:
//
//   • pump's own eligibility preflight is asked EVERY time and obeyed. It
//     knows things this app does not: whether the position is still held, how
//     many of the three attempts on that coin are left, and whether a cooldown
//     is running. Nothing here invents a limit pump does not have, and nothing
//     works around one it does.
//
//   • A failed callout must never read as a failed trade. This runs off the
//     back of a buy that already succeeded.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  CALLOUT_BODY_VERSION,
  CALLOUT_CREATE_PATH,
  CALLOUT_WATERMARK,
  CALLOUT_WATERMARKS,
  pickCalloutWatermark,
  THESIS_BUDGET,
  withCalloutWatermark,
  SOLANA_CHAIN_ID,
  DEFAULT_AUTO_CALLOUT,
  LAUNCH_CALLOUT_DELAY_MS,
  MAX_THESES,
  MAX_THESIS,
  MIN_CALLOUT_POSITION_USD,
  autoCalloutProblem,
  calloutBody,
  canPostCallouts,
  pickThesis,
  thesesOf,
  calloutReplyPath,
  calloutPageUrl,
  replyIdFrom,
  looksLikeCalloutId,
  replyBody,
  MAX_REPLY,
  REPLY_BUDGET,
  CALLOUT_VARS,
  fillCallout,
  shortUsd,
} from './.calloutauto.mjs';

// The mark rotates (2026-09-24), so tests check "ends with SOME variation" and
// "carries exactly one", not one fixed string.
const marked = (s) => CALLOUT_WATERMARKS.some((m) => s.endsWith(m));
// True when `s` is exactly `body`, a newline, then one whole mark and nothing
// after it — i.e. one mark, no doubling (marks contain no newline).
const oneMark = (s, body) => s.startsWith(`${body}\n`) && CALLOUT_WATERMARKS.includes(s.slice(`${body}\n`.length));

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // Off, and silent, until someone writes something and turns it on.
  assert.equal(DEFAULT_AUTO_CALLOUT.enabled, false, 'off by default');
  assert.equal(DEFAULT_AUTO_CALLOUT.text, '', 'with nothing to say');
  assert.equal(autoCalloutProblem(DEFAULT_AUTO_CALLOUT), null, 'and being off is not an error');
  // Switched on with no text is refused — a callout with nothing on it is not
  // worth making, and an empty one would still be a public post.
  assert.match(autoCalloutProblem({ ...DEFAULT_AUTO_CALLOUT, enabled: true }), /at least one line/);
  assert.match(autoCalloutProblem({ enabled: true, text: '   \n\n  ', minBuySol: 0 }), /at least one line/, 'whitespace is not text');
  assert.equal(autoCalloutProblem({ enabled: true, text: 'Runner', minBuySol: 0 }), null);
  assert.match(autoCalloutProblem({ enabled: true, text: 'Runner', minBuySol: -1 }), /between 0 and 100/);
  ok('off by default, and refuses to be switched on with nothing to post');
}

{
  // The variants: one per line, trimmed, blank lines dropped, both caps
  // applied.
  assert.deepEqual(thesesOf('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(thesesOf('  a  \n\n\n  b '), ['a', 'b'], 'blank lines and padding go');
  assert.deepEqual(thesesOf(''), []);
  assert.deepEqual(thesesOf('\n\n'), []);
  // Cut to the BUDGET, not the raw cap: the watermark is appended afterwards
  // and a line filling the whole cap would lose its tail to the slice.
  assert.equal(thesesOf('x'.repeat(MAX_THESIS + 50))[0].length, THESIS_BUDGET, 'a long line is cut to the budget');
  assert.equal(thesesOf(Array.from({ length: MAX_THESES + 10 }, (_, i) => `l${i}`).join('\n')).length, MAX_THESES, 'and the list is cut too');
  ok('the text is one variant per line, trimmed and capped');
}

{
  // RANDOMISED, and always one of the user's own lines — never generated,
  // never blended. `rand` is injected so this asserts the choice.
  const text = 'one\ntwo\nthree';
  assert.equal(pickThesis(text, () => 0), 'one', 'the first is reachable');
  assert.equal(pickThesis(text, () => 0.999999), 'three', 'and so is the last');
  assert.equal(pickThesis(text, () => 0.5), 'two');
  assert.equal(pickThesis('', () => 0), null, 'nothing configured picks nothing');
  // A real sample stays inside the set and does actually vary.
  const draws = Array.from({ length: 500 }, () => pickThesis(text));
  assert.ok(draws.every((d) => ['one', 'two', 'three'].includes(d)), 'every pick is one of the lines');
  assert.equal(new Set(draws).size, 3, 'and all of them get used');
  ok('a line is chosen at random, always one the user wrote');
}

{
  // THE PREFLIGHT IS THE GATE. Each of pump's refusals is read and obeyed
  // rather than worked around, and each one is explained in plain words.
  const eng = src('../electron/engine/autoCallout.ts');
  assert.match(eng, /callout\/eligibility\/\$\{encodeURIComponent\(mint\)\}/, 'eligibility is asked per coin');
  assert.match(eng, /existingCalloutId/, 'already-called is respected');
  assert.match(eng, /cooldownSeconds !== null && p\.cooldownSeconds > 0/, 'the cooldown is respected');
  assert.match(eng, /attemptsRemaining !== null && p\.attemptsRemaining <= 0/, 'the three attempts are respected');
  assert.match(eng, /INSUFFICIENT_BALANCE/, 'and the balance verdict is named');
  // Asked EVERY time, before every post — never cached or assumed.
  assert.ok(
    eng.indexOf('await preflight(mint, token)') < eng.indexOf('CALLOUT_CREATE_PATH)'),
    'the preflight runs before anything is posted',
  );
  // Unknown is null, not a permissive default: a shape change on their side
  // must not read as "no cooldown, attempts left".
  assert.match(eng, /typeof create\?\.attemptsRemaining === 'number' \? create\.attemptsRemaining : null/, 'an unreadable count is null');
  ok('pump’s preflight decides every post, and an unreadable answer is unknown');
}

{
  // The account that posts is the wallet that BOUGHT — it holds the coin, so
  // it is the only one pump would accept and the honest author of the call.
  const eng = src('../electron/engine/autoCallout.ts');
  assert.match(eng, /pumpAuth\.token\(walletId\)/, 'the posting account is named by wallet');
  assert.match(eng, /no pump\.fun account signed in/, 'a wallet without one does not post');

  // And a failed callout never reads as a failed trade.
  const engine = src('../electron/engine/engine.ts');
  const hook = engine.slice(engine.indexOf('private autoCallout('), engine.indexOf('/** Run a live trade serialized'));
  assert.match(hook, /void \(async \(\) => \{/, 'the post is fire-and-forget');
  assert.match(hook, /\.catch\(/, 'and its failure is caught');
  assert.match(hook, /if \(r\.ok\) \{/, 'only a success toasts');
  // A refusal is ordinary — three per coin, a cooldown — so it logs rather
  // than popping a notification on every buy.
  assert.match(hook, /not posted — \$\{r\.message\}/, 'a refusal is logged with its reason');

  // MANUAL buys only: a script/copy/order buy runs its own social flow, and
  // the app grabbing pump's one-callout-per-coin off the back of a script buy
  // is exactly the interference to avoid (2026-09-24). The trigger is gated on
  // opts.manual, the SAME gate the auto-sell templates use one line below.
  assert.match(
    engine,
    /if \(opts\.manual && !simulateOnly && res\.ok\) this\.autoCallout\(mint, capped\);/,
    'the on-buy callout fires only on a manual buy',
  );
  assert.match(
    engine,
    /if \(opts\.manual && !simulateOnly && res\.ok\) this\.armTemplateOrders\(mint\);/,
    'and the template orders keep the same manual-only gate beside it',
  );
  ok('the buying wallet posts on MANUAL buys only, and a refused callout never looks like a failed trade');
}

{
  // THE REQUEST, byte for byte as pump's own client sends it. Observed from a
  // real callout on 2026-09-22, then verified: a throwaway account holding
  // nothing was refused 403 INSUFFICIENT_BALANCE rather than 400 or 401,
  // which is what proves the route, the auth AND the shape were all accepted.
  //
  // `coinMint`, not `mint` — that is the field nobody would have guessed, and
  // the wrong name is a 400 on every buy that reads as a bug in our posting.
  assert.equal(CALLOUT_CREATE_PATH, '/callout/create');
  assert.equal(canPostCallouts(), true, 'posting is possible now that route and body are both known');
  // The thesis goes out WATERMARKED with one rotated mark — see the block below.
  {
    const b = calloutBody('MINT', 'gm');
    assert.equal(b.coinMint, 'MINT');
    assert.equal(b.chainId, SOLANA_CHAIN_ID);
    assert.equal(b.version, CALLOUT_BODY_VERSION);
    assert.ok(oneMark(b.thesis, 'gm'), 'the thesis is the words plus exactly one mark');
  }
  assert.equal(SOLANA_CHAIN_ID, 1_399_811_149, 'Solana mainnet, as pump names a chain');
  assert.equal(CALLOUT_BODY_VERSION, 2, 'the payload version their client sends');
  assert.equal(MIN_CALLOUT_POSITION_USD, 1, 'and pump’s own floor, in their words');

  // Neither half may be empty: a callout with no text is not one, and a
  // request with no mint is not either.
  assert.equal(calloutBody('MINT', ''), null);
  assert.equal(calloutBody('MINT', '   '), null, 'whitespace is not a thesis');
  assert.equal(calloutBody('', 'gm'), null);
  {
    const cut = calloutBody('MINT', 'x'.repeat(MAX_THESIS + 40)).thesis;
    assert.ok(cut.length <= MAX_THESIS, 'a long line is cut to fit under the cap');
    assert.ok(marked(cut), 'and still carries a mark');
  }
  ok('the request is exactly what pump’s client sends, and refuses to be half-formed');
}

{
  // THE WATERMARK. Disclosure before promotion: a callout posted the instant a
  // buy confirms is not the same thing as one someone sat down and wrote, and
  // a reader deciding whether to trade on it deserves to know which it is.
  // The mark ROTATES (2026-09-24) — pump flagged the identical trailer as spam.
  // Every variation still names Krypto Bot, so each is a real disclosure; the
  // rotation changes the wording, never whether it discloses.
  assert.equal(CALLOUT_WATERMARK, 'Called with krypt.cc/bot', 'the canonical mark is still the first variation');
  assert.ok(CALLOUT_WATERMARKS.length >= 5, 'there are several variations to rotate through');
  assert.ok(CALLOUT_WATERMARKS.every((m) => /krypt|Krypto Bot/i.test(m)), 'every variation names Krypto Bot or its URL — it always discloses');
  assert.ok(CALLOUT_WATERMARKS.includes(pickCalloutWatermark()), 'a pick is one of the variations');
  // On a line of its own, as asked 09-22: "Holy what a runner" / <a mark>.
  assert.ok(oneMark(withCalloutWatermark('Holy what a runner'), 'Holy what a runner'), 'words, a newline, one mark');
  // Text stamped with the OLD mark is re-stamped, never carries both.
  assert.ok(oneMark(withCalloutWatermark('Runner · via krypt.cc/tools/krypto'), 'Runner'), 'the legacy mark is stripped, not doubled');
  // Structurally idempotent — re-marking keeps the body and exactly one mark.
  const once = withCalloutWatermark('Runner');
  assert.ok(oneMark(once, 'Runner'));
  assert.ok(oneMark(withCalloutWatermark(once), 'Runner'), 're-marking never doubles the mark');
  // Applied on the way OUT, so nothing can post an unmarked one.
  assert.ok(marked(calloutBody('MINT', 'Runner').thesis), 'the posted thesis carries a mark');
  // The budget leaves room for the LONGEST mark: a line filling it still fits
  // once marked, and still ENDS with a mark rather than losing its tail.
  assert.ok(THESIS_BUDGET < MAX_THESIS);
  const full = calloutBody('MINT', 'x'.repeat(THESIS_BUDGET)).thesis;
  assert.ok(full.length <= MAX_THESIS, 'a full line still fits under the cap, whichever mark is picked');
  assert.ok(marked(full), 'and the mark survives the cap');
  // The form counts against the budget, not the raw cap.
  assert.equal(thesesOf('y'.repeat(MAX_THESIS + 50))[0].length, THESIS_BUDGET, 'a long line is cut to the budget');
  ok('every callout is marked as automatic, once, with a rotated mark and room left for it');
}

{
  // AUTH IS A COOKIE. pump's preflight answers
  // `access-control-allow-headers: content-type`, so their own browser client
  // cannot send an Authorization header at all — the session rides on the
  // `auth_token` cookie. This app is not a browser, so it sends BOTH: the
  // cookie their guard actually reads, and a bearer header in case it also
  // accepts one. Dropping the cookie would be a 401 on every post.
  const eng = src('../electron/engine/autoCallout.ts');
  const post = eng.slice(eng.indexOf('const res = await fetch(urlFor(CALLOUT_CREATE_PATH)'), eng.length);
  assert.match(post, /cookie: `auth_token=\$\{token\}`/, 'the session cookie is sent, under the name their login sets');
  assert.match(post, /authorization: `Bearer \$\{token\}`/, 'and a bearer header beside it');
  assert.match(post, /origin: 'https:\/\/pump\.fun'/, 'with the origin their own client sends');
  ok('the post carries the cookie their guard reads, plus a bearer and an origin');
}

{
  // ONE DOOR. Auto-callout on a buy, a script calling bot.callout, and the
  // test button on the page all go through `postNow` — so the preflight is
  // asked, the refusal obeyed and the watermark applied on every path. A
  // second place that built the create call would be a second place to forget
  // one of those.
  const eng = src('../electron/engine/autoCallout.ts');
  assert.equal((eng.match(/fetch\(urlFor\(CALLOUT_CREATE_PATH\)/g) ?? []).length, 1, 'the create call is built once');
  // Two senders, each built once: a callout and a reply to one.
  assert.equal((eng.match(/fetch\(urlFor\(route\)/g) ?? []).length, 1, 'and the reply call is built once');
  // Bounded to postCallout itself: replyNow lives below it and has a fetch
  // of its own, which is the reply route, not a second create.
  const auto = eng.slice(eng.indexOf('export async function postCallout('), eng.indexOf('export async function replyNow('));
  assert.doesNotMatch(auto, /fetch\(/, 'the auto path does not post on its own');
  assert.match(auto, /return postNow\(walletId, mint, (?:thesis|text)[,)]/, 'it goes through the one door');
  for (const f of ['../electron/ipc.ts', '../electron/engine/engine.ts', '../electron/engine/automation.ts']) {
    assert.doesNotMatch(src(f), /callout\/create/, `${f} does not build the create call itself`);
  }
  ok('every path that posts goes through the one door that runs the preflight');
}

{
  // A SCRIPT MAY POST ONE — deliberately, per call, in code the user wrote.
  // This is the whole of what was built beyond the active wallet: a script
  // can call out a coin, and there is no switch that makes N wallets call the
  // same coin.
  const proto = src('../shared/scriptProtocol.ts');
  assert.match(proto, /^  'callout',$/m, 'the wall allows the method');
  assert.match(proto, /callout: \(mint, text, wallet\) =>/, 'and the harness exposes it');
  assert.match(proto, /^  'pumpAccounts',$/m, 'and a script can list the accounts it may post from');

  const autos = src('../electron/engine/automation.ts');
  // Bounded to the callout case: calloutReply and pumpAccounts follow it.
  const c = autos.slice(autos.indexOf("case 'callout': {"), autos.indexOf("case 'calloutReply': {"));
  assert.ok(c.length > 0 && c.length < 3000, 'the dispatcher handles it');
  assert.match(c, /scriptChain\(s\) !== 'solana'/, 'Solana only — the chain id in the body says so');
  assert.match(c, /rateLimited\(/, 'it costs the action budget, like any other spend');
  assert.match(c, /THESIS_BUDGET/, 'the words are cut to the budget, leaving room for the mark');
  // A callout is public in whichever mode the script is in, so there is no
  // paper version of it to run. Paper says what it WOULD have said.
  assert.ok(c.indexOf("s.mode === 'paper'") > 0, 'paper is handled');
  assert.ok(c.indexOf("s.mode === 'paper'") < c.indexOf('await h.callout('), 'and checked before anything is posted');
  // NO ceiling of our own on how many of the user's accounts may call one
  // coin (dropped 2026-09-22). pump allows exactly one callout per coin per
  // account, so the real limit is how many accounts someone has; a second rule
  // on top of that only ever governed their own accounts.
  assert.doesNotMatch(c, /MAX_WALLETS_PER_TOKEN/, 'no invented cap on accounts per coin');
  // What is left is a DEDUPE, which is not a limit: it skips a request pump
  // would refuse anyway.
  assert.match(c, /called\.has\(wallet\)/, 'a script never calls twice from the same account');
  ok('a script posts one callout at a time, on Solana, never from paper');
}

{
  // WHICH ACCOUNT. Main names the wallet; the sandbox never can. A script
  // asking to post as some other wallet is not a thing the wire can express.
  const engine = src('../electron/engine/engine.ts');
  const at = engine.indexOf('callout: async (mint, thesis, who) =>');
  // Wide enough to reach calloutReply below it: the wallet-trading handlers
  // sit between the two, and this block is about both callout senders.
  const h = at < 0 ? '' : engine.slice(at, at + 3600);
  assert.ok(h.length > 0, 'the engine implements it');
  assert.match(h, /this\.pumpAccountFor\(who\)/, 'the account is resolved in main');
  assert.match(h, /postNow\(pick\.walletId, mint, text[,)]/, 'and the resolved id is what posts');
  assert.match(h, /pickThesis\(/, 'text left out falls back to the user’s own lines');
  // The reply handler shares that resolver rather than copying it — two
  // copies would be two places for a quiet fallback to creep back in.
  assert.match(h, /calloutReply: async \(mint, content, who\)/, 'replies go out as an account too');
  // Three since 09-22: follows and likes (pumpSocial) resolve the same way.
  assert.match(h, /pumpSocial: async \(action, target, who\)/, 'follows and likes go out as an account too');
  assert.equal((h.match(/this\.pumpAccountFor\(who\)/g) ?? []).length, 3, 'all three use the one resolver');

  // WHICH ACCOUNTS CAN BE NAMED: only sessions this app holds, and an unknown
  // name is REFUSED rather than falling back to the active wallet, which would
  // post under somebody else’s name.
  const rat = engine.indexOf('private pumpAccountFor(');
  const res = rat < 0 ? '' : engine.slice(rat, rat + 900);
  assert.ok(res.length > 0, 'the resolver exists');
  assert.match(res, /sessions\.find\(\(x\) => x\.address === who \|\| x\.username === who\)/, 'a named account must be the user’s own');
  assert.match(res, /if \(who && !picked\) return \{ error:/, 'an unknown name is refused, not swapped');
  assert.match(res, /wallet\.list\(\)\.find\(\(w\) => w\.active\)\?\.id/, 'the default is the active wallet');

  // The account list is addresses and names. A session token never leaves
  // main, and certainly never reaches a sandbox.
  const at2 = engine.indexOf('pumpAccounts: () =>');
  const list = at2 < 0 ? '' : engine.slice(at2, at2 + 400);
  assert.ok(list.length > 0, 'a script can list the accounts');
  assert.doesNotMatch(list, /token/i, 'and the list carries no credential');
  ok('a script posts as one of the user’s own accounts, resolved in main');
}

{
  // THE TEST BUTTON — one real post, by hand, to prove the chain works.
  // The renderer names a wallet, a mint and the words; it cannot name a host
  // or a route, and the watermark is still applied in main.
  const ipc = src('../electron/ipc.ts');
  const h = ipc.slice(ipc.indexOf("ipcMain.handle('pump:callout'"), ipc.indexOf("ipcMain.handle('launch:fees'"));
  assert.ok(h.length > 0, 'the handler exists');
  assert.match(h, /looksLikeSolAddress\(m\)/, 'the mint is checked');
  assert.match(h, /THESIS_BUDGET/, 'the words are capped');
  assert.match(h, /postNow\(id, m, t[,)]/, 'it posts through the one door');
  assert.doesNotMatch(h, /https?:\/\//, 'no URL crosses IPC');
  const pre = src('../electron/preload.ts');
  assert.match(pre, /callout: \(walletId: string, mint: string, text: string\)/, 'and the bridge is there to call it');
  ok('one callout can be posted by hand, with main still owning the host and the mark');
}

{
  // REPLIES. A callout is ONE per coin per account and no edit route is known,
  // so a reply is how a call is followed up. Observed 2026-09-22:
  //   POST /callout/<uuid>/replies   { "content": "…" }   69 bytes
  assert.equal(calloutReplyPath('df0ef615-21b0-43d8-a7f3-9a9a2b1163f3'), '/callout/df0ef615-21b0-43d8-a7f3-9a9a2b1163f3/replies');
  assert.ok(oneMark(replyBody('hi').content, 'hi'), 'a reply is marked like a call — words, a newline, one rotated mark');
  assert.equal(replyBody('   '), null, 'an empty reply is not a reply');
  const captured = 'Working on some insane tek right now. krypto never dies';
  assert.equal(JSON.stringify({ content: captured }).length, 69, 'byte for byte the captured body');

  // THE ID IS THE ONLY CALLER-ADJACENT PART OF THE PATH, so it must be a UUID
  // and nothing else. Everything below would otherwise be a path segment.
  assert.equal(looksLikeCalloutId('df0ef615-21b0-43d8-a7f3-9a9a2b1163f3'), true);
  for (const bad of ['', '../../users', 'df0ef615', 'df0ef615-21b0-43d8-a7f3-9a9a2b1163f3/../x', 'x'.repeat(36)]) {
    assert.equal(looksLikeCalloutId(bad), false, `refused: ${bad}`);
    assert.equal(calloutReplyPath(bad), null, `no path for: ${bad}`);
  }
  // The budget leaves room for the mark, same rule as a thesis.
  assert.ok(REPLY_BUDGET < MAX_REPLY);
  assert.ok(marked(replyBody('y'.repeat(REPLY_BUDGET)).content), 'a full reply keeps its mark');
  ok('a reply is one field, marked, and its id can only ever be a UUID');
}

{
  // THE COOLDOWN GATES REPLIES, NOT CREATES. It is read from
  // `preflight.reply.cooldownRemainingSeconds`, and using it to refuse a
  // create meant a coin nobody had called could be "cooling down" — the post
  // was skipped silently. Found when replies turned out to be a real action.
  const eng = src('../electron/engine/autoCallout.ts');
  const create = eng.slice(eng.indexOf('function refusal(p: Preflight)'), eng.indexOf('function replyRefusal('));
  assert.ok(create.length > 0, 'the create refusals exist');
  assert.doesNotMatch(create, /cooldownSeconds/, 'a reply cooldown no longer refuses a first callout');
  assert.match(create, /existingCalloutId/, 'one callout per coin still holds');

  const rep = eng.slice(eng.indexOf('function replyRefusal('), eng.indexOf('function replyRefusal(') + 500);
  assert.match(rep, /cooldownSeconds !== null && p\.cooldownSeconds > 0/, 'and it gates replies instead');
  assert.match(rep, /if \(!p\.existingCalloutId\)/, 'with nothing to reply to refused first');

  // The id comes from pump's preflight, never from a caller.
  const send = eng.slice(eng.indexOf('export async function replyNow('));
  assert.match(send, /calloutReplyPath\(pre\.existingCalloutId \?\? ''\)/, 'the id is pump’s, not ours');
  assert.match(send, /cookie: `auth_token=\$\{token\}`/, 'same cookie auth as a callout');
  ok('the reply cooldown gates replies, and the callout id comes from pump');
}

{
  // Reachable from a script and from the page, both through main.
  const proto = src('../shared/scriptProtocol.ts');
  assert.match(proto, /^  'calloutReply',$/m, 'the wall allows it');
  assert.match(proto, /calloutReply: \(mint, text, wallet\) =>/, 'the harness exposes it');

  const autos = src('../electron/engine/automation.ts');
  const c = autos.slice(autos.indexOf("case 'calloutReply': {"), autos.indexOf("case 'pumpAccounts':"));
  assert.ok(c.length > 0, 'the dispatcher handles it');
  assert.match(c, /scriptChain\(s\) !== 'solana'/, 'Solana only');
  assert.match(c, /s\.mode === 'paper'/, 'paper posts nothing');
  assert.match(c, /rateLimited\(/, 'it costs an action');
  // NOT capped by the per-coin account ceiling: that limits how many of your
  // accounts may CALL one coin, and a reply adds no new caller.
  assert.doesNotMatch(c, /MAX_WALLETS_PER_TOKEN/, 'the caller cap is not double-applied to replies');

  const ipc = src('../electron/ipc.ts');
  const h = ipc.slice(ipc.indexOf("ipcMain.handle('pump:calloutReply'"), ipc.indexOf("// ── The pump.fun profile"));
  assert.ok(h.length > 0, 'the handler exists');
  assert.doesNotMatch(h, /https?:\/\//, 'no URL crosses IPC');
  assert.match(h, /replyNow\(id, m, t\)/, 'it goes through the one sender');
  const pre = src('../electron/preload.ts');
  assert.match(pre, /calloutReply: \(walletId: string, mint: string, text: string\)/, 'and the bridge is there');
  ok('a reply can come from a script or the page, with main owning the route');
}

{
  // VARIABLES IN A LINE, so one list works across coins. The braces match the
  // app's own rule variables; <ticker> is accepted too, because that is what
  // someone types first and a public post reading "<ticker> looks good" is a
  // worse outcome than supporting one extra spelling.
  const facts = { ticker: 'CHAD', name: 'Chad Coin', mc: 1_234_567, price: 0.00042, holders: 812, buyers: 41, liq: 23_400, mint: 'So11111111111111111111111111111111111111112' };
  assert.equal(fillCallout('{ticker} at {mc}', facts), 'CHAD at $1.2M');
  assert.equal(fillCallout('<ticker> at <mc>', facts), 'CHAD at $1.2M', 'angle brackets too');
  assert.equal(fillCallout('{buyers} buyers, {holders} holders, {liq} liq', facts), '41 buyers, 812 holders, $23.4K liq');
  assert.equal(fillCallout('{mint}', facts), 'So111111');
  // UNKNOWN IS AN EM DASH, never 0 and never blank: "$0" is a claim, and a
  // missing word reads as a sentence somebody wrote badly.
  assert.equal(fillCallout('{ticker} at {mc}', {}), '— at —');
  assert.equal(shortUsd(null), '—');
  assert.equal(shortUsd(0), '$0.0');
  // A name nobody defined is left EXACTLY as written — a typo should look
  // like a typo, not vanish from a public post.
  assert.equal(fillCallout('{nope} and <alsonope>', facts), '{nope} and <alsonope>');
  // Everything the UI offers actually resolves.
  for (const v of CALLOUT_VARS) {
    assert.notEqual(fillCallout(`{${v.name}}`, facts), `{${v.name}}`, `${v.name} resolves`);
    assert.ok(v.means.length > 0, `${v.name} is explained`);
  }
  ok('a callout line can name the coin’s facts, and says so when it cannot');
}

{
  // Filled in MAIN, on the way to the sender, so both the script path and a
  // reply get them from one place and the watermark still lands last.
  const eng = src('../electron/engine/engine.ts');
  const at = eng.indexOf('private calloutFacts(mint: string)');
  const f = at < 0 ? '' : eng.slice(at, at + 900);
  assert.ok(f.length > 0, 'the engine can resolve them');
  // Read from what is already known, never fetched: a callout rides on a buy
  // that just happened, and waiting on a provider to fill in a word would
  // delay a public post.
  assert.match(f, /summaryIfCached\(mint\)/, 'from the cache');
  assert.doesNotMatch(f, /await /, 'and never a round trip');
  assert.match(eng, /fillCallout\(chosen, this\.calloutFacts\(mint\)\)/, 'a callout gets them');
  assert.match(eng, /fillCallout\(content, this\.calloutFacts\(mint\)\)/, 'and so does a reply');
  ok('the coin’s facts come from what the app already knows, with no extra wait');
}

// The public link a script can share (2026-09-23): pump's own share path.
{
  const MINT = '6e4kiW8dW67CiFLYUA68T4A1L57vqyyuRmfm3wo6pump';
  const ID = 'c58c3d62-1111-4222-8333-444455556666';
  const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal(calloutPageUrl(MINT, ID), `https://pump.fun/callouts/${MINT}/${ID}`);
  assert.equal(calloutPageUrl(MINT, ID, RID), `https://pump.fun/callouts/${MINT}/${ID}/${RID}`);
  assert.equal(calloutPageUrl(MINT, ID, 'nope'), `https://pump.fun/callouts/${MINT}/${ID}`, 'a bad reply id falls back to the callout');
  assert.equal(calloutPageUrl('../x', ID), null);
  assert.equal(calloutPageUrl(MINT, '../../x'), null, 'never a link built from a made-up id');
  assert.equal(replyIdFrom(JSON.stringify({ calloutId: ID, id: RID })), RID, 'a reply’s own id, not its parent’s');
  assert.equal(replyIdFrom('not json'), null);
  const autos = src('../electron/engine/automation.ts');
  assert.match(autos, /link: r\.calloutId \? calloutPageUrl\(mint, r\.calloutId\) : null/, 'bot.callout returns the link');
  assert.match(autos, /calloutPageUrl\(mint, r\.calloutId, r\.replyId\)/, 'and bot.calloutReply the reply’s');
  ok('a callout and a reply each come back with their public pump.fun link');
}

// The Auto-callout page's Discord webhook (2026-09-23).
{
  assert.equal(DEFAULT_AUTO_CALLOUT.discordWebhookUrl, '', 'off by default, and off is not a problem');
  assert.equal(autoCalloutProblem(DEFAULT_AUTO_CALLOUT), null);
  assert.match(
    autoCalloutProblem({ ...DEFAULT_AUTO_CALLOUT, discordWebhookUrl: 'https://evil.example/api/webhooks/1/2' }),
    /Discord webhook: only Discord webhooks/,
    'any other host is refused on the page',
  );
  assert.equal(
    autoCalloutProblem({ ...DEFAULT_AUTO_CALLOUT, discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' }),
    null,
  );

  const types = src('../shared/types.ts');
  assert.match(types, /autoCallout: \{[^}]*discordWebhookUrl: ''/, 'in DEFAULT_SETTINGS, or the validator drops it on save');
  const val = src('../electron/system/settingsValidation.ts');
  assert.match(val, /'autoCallout\.discordWebhookUrl',/, 'and held to Discord at the IPC boundary');
  const store = src('../electron/system/settings-store.ts');
  assert.match(store, /discordWebhookUrl:\s*typeof loaded\.autoCallout\?\.discordWebhookUrl === 'string' && !webhookUrlProblem/, 'and again on load');

  const eng = src('../electron/engine/engine.ts');
  const auto = eng.slice(eng.indexOf('private autoCallout(mint: string'), eng.indexOf('async postCalloutToDiscord('));
  assert.match(auto, /if \(hook\) await this\.postCalloutToDiscord\(hook, mint/, 'a successful auto-callout is posted');
  const post = eng.slice(eng.indexOf('async postCalloutToDiscord('), eng.indexOf('/** Run a live trade serialized'));
  assert.match(post, /redactWebhook\(hook\)/, 'and the log line never carries the URL');
  const ipc = src('../electron/ipc.ts');
  const t = ipc.slice(ipc.indexOf("ipcMain.handle('pump:testCalloutWebhook'"), ipc.indexOf("ipcMain.handle('pump:testCalloutWebhook'") + 800);
  assert.match(t, /store\.load\(\)\.autoCallout\.discordWebhookUrl/, 'the test reads the URL from the store, never the renderer');
  assert.match(src('../electron/preload.ts'), /testCalloutWebhook: \(mint\?: string\)/, 'and the bridge exists');
  const page = src('../src/pages/AutoCallout.tsx');
  assert.match(page, /const next = \{ \.\.\.draft, discordWebhookUrl \}/, 'the webhook saves through the draft, so a later Save cannot undo it');
  ok('auto-callouts can post to a Discord webhook, held to Discord and never logged');
}

// Auto-callout after a LAUNCH (2026-09-23): a delay + a USD floor, its own
// toggle, and it only fires for a Solana launch whose dev buy landed.
{
  assert.equal(DEFAULT_AUTO_CALLOUT.onLaunch, true, 'launch callouts are on by default');
  assert.equal(DEFAULT_AUTO_CALLOUT.launchMinUsd, 2, 'the default floor is $2');
  assert.ok(LAUNCH_CALLOUT_DELAY_MS >= 10_000, 'the call waits, so pump does not drop a same-second create');
  assert.equal(autoCalloutProblem({ ...DEFAULT_AUTO_CALLOUT, launchMinUsd: -1 }), 'The launch call minimum must be between 0 and 100,000 USD.');
  assert.equal(autoCalloutProblem({ ...DEFAULT_AUTO_CALLOUT, launchMinUsd: 5 }), null, 'a sane floor is fine');
  // A settings object from before the field existed is not malformed.
  assert.equal(autoCalloutProblem({ enabled: false, text: '', minBuySol: 0, likeOwn: true, discordWebhookUrl: '' }), null);

  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  const m = eng.slice(eng.indexOf('calloutAfterLaunch(walletId'), eng.indexOf('calloutAfterLaunch(walletId') + 1600);
  assert.match(m, /if \(!a\.onLaunch\) return;/, 'the launch toggle gates it');
  assert.match(m, /a\.launchMinUsd > 0[\s\S]*?market\.solUsd\(\)/, 'the USD floor uses the real SOL price');
  assert.match(m, /usd === null[\s\S]*?return;/, 'an unknown SOL price does not call, never guesses past the gate');
  assert.match(m, /LAUNCH_CALLOUT_DELAY_MS/, 'and it waits before posting');
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');
  assert.match(ipc, /r\.ok && r\.token && draft\.chain === 'solana' && !r\.buyFailed/, 'only a Solana launch whose dev buy landed is called');
  assert.match(ipc, /getEngine\(\)\.calloutAfterLaunch\(wid, r\.token, draft\.devBuy\)/, 'from the launch wallet');
  ok('a launch is called out from its wallet, delayed, only above the USD floor and only when the dev buy landed');
}

// 2026-09-23 audit fixes.
{
  // PUMP-2: fillCallout expands a template AFTER the per-line clamp, so the
  // watermark must survive an over-length thesis rather than being sliced off.
  const long = 'this coin is mooning '.repeat(30); // ~630 chars
  const body = calloutBody('SomeMint1111111111111111111111111111111111', long);
  assert.ok(marked(String(body.thesis)), 'the disclosure survives a long callout');
  assert.ok(String(body.thesis).length <= MAX_THESIS, 'and the whole thing stays within pump’s cap');
  const rep = replyBody(long);
  assert.ok(marked(String(rep.content)), 'the disclosure survives a long reply');
  assert.ok(String(rep.content).length <= MAX_REPLY);
  ok('the watermark is never the part truncated, however long the text');
}

{
  // SCRIPT-1 + SCRIPT-2 (audit): the multi-wallet trade path is serialized
  // through chain() like every other spending path, and bot.discord does not
  // post on paper (like callout/reply/follow/like).
  const autos = src('../electron/engine/automation.ts');
  assert.match(autos, /chain\(s, \(\) => walletTrade\(s, 'buy'/, 'a multi-wallet buy goes through chain() — budget serialized');
  assert.match(autos, /chain\(s, \(\) => walletTrade\(s, 'sell'/, 'and so does the sell');
  const disc = autos.slice(autos.indexOf("case 'discord': {"), autos.indexOf("case 'follow':"));
  assert.match(disc, /s\.mode === 'paper'[\s\S]*?paper: nothing was posted/, 'a paper script does not post to Discord for real');
  ok('multi-wallet trades are budget-serialized and paper never posts to Discord');
}

{
  // 2026-09-23 bug: the on-buy auto-callout posted the template LITERALLY
  // ("{ticker} {name}") because postCallout never filled the variables — only
  // the script and launch paths did. It must be given the coin's facts and
  // fill them.
  const eng = src('../electron/engine/engine.ts');
  assert.match(eng, /postCallout\(walletId, mint, s\.autoCallout, boughtSol, this\.calloutFacts\(mint\)\)/, 'the on-buy callout is handed the coin facts');
  const ac = src('../electron/engine/autoCallout.ts');
  assert.match(ac, /const text = facts \? fillCallout\(thesis, facts\) : thesis;/, 'and postCallout fills {ticker}/{mc}/… before posting');
  ok('the on-buy auto-callout fills its variables instead of posting the template literally');
}

console.log(`\nautocallout: ${passed}/${passed} passed`);
