// Pons `launchAndBuy` — pinned against a transaction that really happened.
//
// The whole reason the Launch page said "not ready" was that no create
// instruction in this app had been checked against the chain. This is that
// check, and it is the strongest kind available: take a real launch off
// Robinhood Chain, feed its inputs to our builder, and require the calldata to
// come out byte for byte identical to what the sender actually submitted.
//
// If that holds, the encoder is not "probably right" — it is the same bytes.
//
//   tx     0x39ddbf1cf28a253d0b0577c46d82479e92facc505d59433bd32c7a74ef71c18e
//   token  LUCEEE, launched with a 0.001 ETH creator buy
//
// The selector came from the public signature database and was then proven by
// this comparison; nothing here depends on trusting that lookup.

import assert from 'node:assert';
import fs from 'node:fs';
import { buildLaunch } from './.ponslaunch.mjs';
import { PONS_LAUNCH_CONFIG_ID, PONS_LAUNCH_FEE_WEI } from './.ponschain.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

/**
 * A real launch, captured from chain and stored beside this test.
 *
 * The fixture was written by a script that fetched the transaction AND ran our
 * builder against it, refusing to write unless the two were identical — so the
 * bytes below are the ones Robinhood Chain actually accepted, not a
 * transcription of them.
 */
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/pons-launch.json', import.meta.url), 'utf8'));
const REAL_INPUT = FIX.input;

const CREATOR = '0x28428fb26fd1b2a6620bf6803b0ee9a3ba060271';
const REAL = {
  name: 'LUCEEE',
  symbol: 'LUCEEE',
  image: 'https://img.koyen.fun/pons_7109371334_1789092939.jpg',
  website: 'https://x.com/nft_lucee',
  twitter: 'https://x.com/nft_lucee',
  telegram: 'https://t.me/Luceetyy',
  quoteIn: 1_000_000_000_000_000n,
  minTokensOut: BigInt('0x78f9011fcc435f57c49b'),
  creatorTaxBps: 200,
  creator: CREATOR,
  salt: '0x8ca677e78c602d1a762958b0b8ec84ca2f17bec9fb2fd50d15aa7dc03df9a4f1',
};

{
  const call = buildLaunch(REAL);
  assert.equal(call.data.toLowerCase(), REAL_INPUT.toLowerCase(), 'calldata must match the real launch byte for byte');
  ok('our builder reproduces a real on-chain launch exactly');
}

{
  const call = buildLaunch(REAL);
  // The router takes a flat fee on top of the buy: measured at 0.0005 ETH on
  // every sampled launch, and the LUCEEE transaction carried 0.0015 for a
  // 0.001 buy.
  assert.equal(call.value, 1_500_000_000_000_000n, 'value is the buy plus the launch fee');
  assert.equal(call.value.toString(), FIX.value, 'and it matches what the real transaction carried');
  assert.equal(call.value - REAL.quoteIn, PONS_LAUNCH_FEE_WEI);
  ok('value is the buy plus the router fee, and the fee is 0.0005 ETH');
}

{
  const call = buildLaunch(REAL);
  assert.equal(call.data.slice(0, 10), '0xf85f8e41', 'selector is launchAndBuy');
  assert.equal(call.to.toLowerCase(), FIX.to.toLowerCase(), 'and it goes where the real one went');
  ok('the call targets the Pons launch router with the right selector');
}

{
  // A launch with no creator buy is legal: the fee is still owed, and nothing
  // else about the encoding changes.
  const free = buildLaunch({ ...REAL, quoteIn: 0n, minTokensOut: 0n });
  assert.equal(free.value, PONS_LAUNCH_FEE_WEI, 'a zero-buy launch still pays the fee');
  assert.equal(free.data.slice(0, 10), '0xf85f8e41');
  ok('a launch with no creator buy encodes and pays only the fee');
}

{
  // The config id is constant across every launch sampled. If Pons ever ships
  // a second configuration this assertion is where we find out, rather than in
  // a user's failed transaction.
  assert.match(PONS_LAUNCH_CONFIG_ID, /^0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7$/);
  assert.ok(buildLaunch(REAL).data.toLowerCase().includes(PONS_LAUNCH_CONFIG_ID.slice(2)), 'and it is in the calldata');
  ok('the observed launch config id is the one we send');
}

console.log(`\nponslaunch: ${passed}/${passed} passed`);
