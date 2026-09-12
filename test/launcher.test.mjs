// The launcher's gate, in the MAIN process.
//
// shared/launch.ts holds the rules; launchgate.test.mjs pins them. This file
// pins the thing that matters more: that main applies them itself rather than
// trusting the page that drew the button. Every case below is a draft the
// renderer could send — because a renderer can send anything — and the answer
// main gives it.

import assert from 'node:assert';
import { _conv, launch, refuse } from './.launcher.mjs';
import { emptyDraft, MIN_DEV_BUY } from './.launchgate.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const draft = (chain = 'solana', over = {}) => ({
  ...emptyDraft(chain),
  name: 'Test Coin',
  symbol: 'TEST',
  imageUrl: 'https://ipfs.io/ipfs/bafyimage',
  metadataUri: 'https://ipfs.io/ipfs/bafymeta',
  devBuy: MIN_DEV_BUY[chain],
  ...over,
});

const deps = (over = {}) => ({
  cfg: { enabled: true, walletId: 'launch-sol', evmWalletId: 'launch-evm' },
  httpUrl: 'https://rpc.example',
  activeSolanaWalletId: 'trade-sol',
  activeEvmWalletId: 'trade-evm',
  referrer: '',
  liveReady: true,
  canBuy: async () => null,
  devBuy: async () => ({ ok: true, message: 'bought' }),
  ...over,
});

{
  assert.equal(refuse(draft(), deps()), null, 'a good draft with everything in place is not refused');
  ok('the gate lets a complete, properly configured launch through');
}

{
  // The master switch, checked in main. A renderer that never drew the switch
  // — or a page rebuilt by someone else — gets the same answer.
  const why = refuse(draft(), deps({ cfg: { enabled: false, walletId: 'launch-sol', evmWalletId: 'launch-evm' } }));
  assert.match(why, /switched off/i);
  ok('the master switch is enforced in main, not merely drawn in the renderer');
}

{
  // The separate-wallet rule, per chain. Its whole point is that a bug in the
  // launch path cannot reach the keys holding your positions, so it cannot
  // live only in the page that picks the wallet.
  const sol = refuse(draft('solana'), deps({ cfg: { enabled: true, walletId: 'trade-sol', evmWalletId: 'launch-evm' } }));
  assert.match(sol, /active trading wallet/i);
  const evm = refuse(draft('robinhood', { metadataUri: '' }), deps({ cfg: { enabled: true, walletId: 'launch-sol', evmWalletId: 'trade-evm' } }));
  assert.match(evm, /active trading wallet/i);
  ok('launching from the trading wallet is refused in main, on both chains');
}

{
  const why = refuse(draft(), deps({ cfg: { enabled: true, walletId: '', evmWalletId: '' } }));
  assert.match(why, /no launch wallet/i);
  ok('a chain with no launch wallet named is refused');
}

{
  // The one that stops the worst outcome this module can produce: a token
  // created on chain whose creator could not then buy it, because a gate that
  // was already closed refused the buy afterwards.
  assert.match(refuse(draft('solana'), deps({ liveReady: false })), /live execution/i);
  assert.equal(refuse(draft('robinhood', { metadataUri: '' }), deps({ liveReady: false })), null, 'Pons creates and buys in one call');
  ok('Solana will not create a token it could not then buy; Robinhood needs no such check');
}

{
  // The draft rules are re-run in main, not taken on trust. A renderer that
  // sends devBuy: 0 gets the same refusal a greyed-out button would have given.
  assert.match(refuse(draft('solana', { devBuy: 0 }), deps()), /first buy/i);
  assert.match(refuse(draft('solana', { imageUrl: '' }), deps()), /image/i);
  assert.match(refuse(draft('solana', { name: '' }), deps()), /name/i);
  ok('every draft rule is re-checked in main, whatever the page allowed');
}

{
  // A refusal must reach the caller as a refusal, and nothing may be built on
  // the way there. `launch` returns rather than throwing, and it returns the
  // gate's own words.
  const out = await launch(draft(), deps({ liveReady: false }), false);
  assert.equal(out.ok, false);
  assert.match(out.message, /live execution/i);
  assert.equal(out.token, undefined, 'and no token is reported');
  ok('a refused launch comes back as a refusal, with nothing created');
}

{
  // The token exists the moment the create confirms. If the creator's own buy
  // then fails, saying "the launch failed" would be false — and would send
  // someone to create a second token they already own. So ok stays true, the
  // mint comes back, and the buy's failure is reported separately.
  let called = null;
  const out = await launch(
    draft('solana'),
    deps({
      devBuy: async (mint, walletId, sol) => {
        called = { mint, walletId, sol };
        return { ok: false, message: 'engine refused the buy' };
      },
    }),
    false,
  ).catch((e) => ({ ok: false, message: e.message, _threw: true }));
  // Without a chain to talk to the create cannot land here, so this asserts
  // the shape of the refusal rather than the happy path — what must NOT
  // happen is a throw crossing the IPC boundary.
  assert.equal(typeof out.ok, 'boolean');
  assert.equal(out._threw, undefined, 'the launcher never throws at its caller');
  assert.equal(called, null, 'and no buy is placed when nothing was created');
  ok('an unreachable chain is a returned refusal, never a thrown one, and places no buy');
}

{
  // Native units, both chains. A wrong exponent here is the difference
  // between a 0.002 ETH first buy and a 2,000,000,000,000,000 wei one.
  assert.equal(_conv.wei(0.002), 2_000_000_000_000_000n);
  assert.equal(_conv.wei(1), 1_000_000_000_000_000_000n);
  assert.equal(_conv.lamports(0.01), 10_000_000);
  assert.equal(_conv.lamports(1), 1_000_000_000);
  ok('the native-unit conversions are the right size on both chains');
}

console.log(`\nlauncher: ${passed}/${passed} passed`);
