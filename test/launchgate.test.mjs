// shared/launch.ts — the gate in front of the launcher, and the draft rules.
//
// Everything here exists to keep one promise: a user who does not opt in is
// not affected. The signer enforces that (see walletpolicy.test.mjs, "with the
// launcher OFF, a create is refused exactly as before"); this pins the rules
// the UI applies before it ever gets that far — and, since the form was built,
// the rules that decide whether a draft may be sent at all.

import assert from 'node:assert';
import {
  DEFAULT_LAUNCH_CONFIG,
  LAUNCH_CHAINS,
  MAX_NAME,
  MIN_DEV_BUY,
  draftProblems,
  emptyDraft,
  launchWalletId,
  readiness,
} from './.launchgate.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const facts = (over = {}) => ({ activeWalletId: 'trade-1', walletBalance: 1, builderVerified: true, liveReady: true, ...over });
const on = { enabled: true, walletId: 'launch-1', evmWalletId: 'launch-evm-1' };

{
  assert.equal(DEFAULT_LAUNCH_CONFIG.enabled, false, 'launching is OFF out of the box');
  assert.equal(DEFAULT_LAUNCH_CONFIG.walletId, '', 'and no Solana wallet is nominated');
  assert.equal(DEFAULT_LAUNCH_CONFIG.evmWalletId, '', 'nor an EVM one');
  for (const c of LAUNCH_CHAINS) {
    const r = readiness(DEFAULT_LAUNCH_CONFIG, c, facts());
    assert.equal(r.ready, false);
    assert.equal(r.blocker, 'disabled', `${c} is blocked by the switch, not by anything else`);
  }
  ok('a fresh install cannot launch, on any chain, for the plainest reason');
}

{
  // The two chains keep separate wallet files with separate ids, so one
  // nomination must never be read as the other. A Solana wallet chosen and an
  // EVM one not chosen means Solana can launch and Robinhood cannot.
  const solOnly = { enabled: true, walletId: 'launch-1', evmWalletId: '' };
  assert.equal(launchWalletId(solOnly, 'solana'), 'launch-1');
  assert.equal(launchWalletId(solOnly, 'robinhood'), '');
  assert.equal(readiness(solOnly, 'solana', facts()).ready, true);
  assert.equal(readiness(solOnly, 'robinhood', facts()).blocker, 'no-wallet');
  ok('each chain has its own launch wallet, and one does not stand in for the other');
}

{
  // The separate-wallet rule. Launching from the trading wallet is the one
  // mistake that could cost someone their positions, so it is refused by name
  // rather than merely discouraged.
  const r = readiness({ enabled: true, walletId: 'trade-1', evmWalletId: 'x' }, 'solana', facts());
  assert.equal(r.ready, false);
  assert.equal(r.blocker, 'wallet-is-trading-wallet');
  ok('the active trading wallet can never be the launch wallet');
}

{
  const r = readiness({ enabled: true, walletId: '', evmWalletId: '' }, 'solana', facts());
  assert.equal(r.blocker, 'no-wallet', 'switched on but unnominated is its own state');
  ok('turning the switch on is not enough — a wallet has to be chosen');
}

{
  // An unverified builder blocks the chain. This is what stops the app
  // building a create instruction out of a guessed account list.
  const r = readiness(on, 'solana', facts({ builderVerified: false }));
  assert.equal(r.ready, false);
  assert.equal(r.blocker, 'builder-unverified');
  ok('a chain whose create instruction is unverified cannot launch');
}

{
  // Unknown balance is not empty balance.
  assert.equal(readiness(on, 'solana', facts({ walletBalance: null })).ready, true, 'an unreadable balance does not block');
  assert.equal(readiness(on, 'solana', facts({ walletBalance: 0 })).blocker, 'wallet-empty', 'a read zero does');
  ok('an unreadable balance is not reported as an empty wallet');
}

{
  // The Solana first buy goes through the ordinary trade path, so live
  // execution has to be on before the token is created — not discovered
  // afterwards, when the token already exists and cannot be un-created.
  // Robinhood buys inside Pons's own router call and needs no such thing.
  assert.equal(readiness(on, 'solana', facts({ liveReady: false })).blocker, 'live-off');
  assert.equal(readiness(on, 'robinhood', facts({ liveReady: false })).ready, true, 'Pons creates and buys in one call');
  ok('Solana refuses to create a token it could not then buy; Robinhood does not need to');
}

{
  const r = readiness(on, 'robinhood', facts());
  assert.equal(r.ready, true);
  assert.equal(r.blocker, null);
  ok('switched on, own wallet, funded and verified — that is the only way through');
}

{
  // Order matters: the switch is checked before anything else, so a user who
  // never opted in is never told about wallets or builders.
  const r = readiness({ enabled: false, walletId: 'trade-1', evmWalletId: '' }, 'solana', facts({ builderVerified: false, walletBalance: 0 }));
  assert.equal(r.blocker, 'disabled', 'the switch outranks every other complaint');
  ok('the master switch is checked first, so opting out ends the conversation');
}

// ── The draft ───────────────────────────────────────────────────────────

const good = (chain = 'solana', over = {}) => ({
  ...emptyDraft(chain),
  name: 'Test Coin',
  symbol: 'TEST',
  imageUrl: 'https://ipfs.io/ipfs/bafyimage',
  metadataUri: 'https://ipfs.io/ipfs/bafymeta',
  devBuy: MIN_DEV_BUY[chain],
  ...over,
});

{
  assert.deepEqual(draftProblems(good('solana')), [], 'a complete Solana draft has nothing wrong with it');
  assert.deepEqual(draftProblems(good('robinhood', { metadataUri: '' })), [], 'Robinhood stores an image, not a metadata JSON');
  ok('a complete draft passes on either chain');
}

{
  assert.equal(emptyDraft('solana').cashback, false, 'cashback is OFF unless asked for');
  assert.equal(emptyDraft('solana').mayhem, false, 'and so is mayhem');
  // Cashback gives the creator's entire fee away, permanently. 44 % of pump
  // launches use it, which is exactly why it must never be the default here.
  ok('the irreversible options default to off');
}

{
  // The first buy is required, and the reason is not cosmetic: every other
  // path that signs with the user's key is billed, and a free signing path is
  // a thing to be exploited rather than a feature.
  const none = draftProblems(good('solana', { devBuy: 0 }));
  assert.equal(none.length, 1);
  assert.match(none[0], /first buy/i);
  assert.equal(draftProblems(good('solana', { devBuy: MIN_DEV_BUY.solana / 2 })).length, 1, 'under the floor is still refused');
  assert.equal(draftProblems(good('solana', { devBuy: Number.NaN })).length, 1, 'and so is a number that is not one');
  ok('a launch with no first buy — including a NaN one — cannot be sent');
}

{
  // The links go into a token that exists forever. A local path, an http URL
  // or a blank must never be written into one.
  assert.match(draftProblems(good('solana', { imageUrl: '' }))[0], /image/i);
  assert.ok(
    draftProblems(good('solana', { imageUrl: 'http://example.com/a.png' })).some((p) => /https/.test(p)),
    'plain http is refused',
  );
  assert.ok(
    draftProblems(good('solana', { imageUrl: 'C:/Users/me/cat.png' })).some((p) => /https/.test(p)),
    'a local path most of all',
  );
  ok('only an https link may be written into a token');
}

{
  assert.match(draftProblems(good('solana', { name: '' }))[0], /name/i);
  assert.match(draftProblems(good('solana', { name: 'x'.repeat(MAX_NAME + 1) }))[0], /maximum/i);
  assert.match(draftProblems(good('solana', { symbol: '' }))[0], /ticker/i);
  assert.match(draftProblems(good('solana', { symbol: 'NOT OK' }))[0], /letters and digits/i);
  ok('the name and ticker are bounded, and the ticker is letters and digits');
}

{
  // Basis points, not percent. A user typing 50 means 0.5 %; a user typing
  // 5000 means half of every trade and is refused.
  assert.deepEqual(draftProblems(good('robinhood', { metadataUri: '', creatorTaxBps: 0 })), []);
  assert.deepEqual(draftProblems(good('robinhood', { metadataUri: '', creatorTaxBps: 500 })), []);
  assert.equal(draftProblems(good('robinhood', { metadataUri: '', creatorTaxBps: 501 })).length, 1);
  assert.equal(draftProblems(good('robinhood', { metadataUri: '', creatorTaxBps: -1 })).length, 1);
  assert.equal(draftProblems(good('robinhood', { metadataUri: '', creatorTaxBps: 1.5 })).length, 1, 'and it is a whole number');
  // The same field on Solana means nothing and must not block a launch there.
  assert.deepEqual(draftProblems(good('solana', { creatorTaxBps: 9_999 })), [], 'Solana does not read it at all');
  ok('the creator fee is bounded basis points on Robinhood, and ignored on Solana');
}

console.log(`\nlaunchgate: ${passed}/${passed} passed`);
