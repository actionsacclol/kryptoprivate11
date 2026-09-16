// $KRYPTO — the pinned mint behind the Hub's buy button.
//
// The one thing that must never ship: a card pointing at a malformed or
// mistyped mint. Null is fine (the card hides); anything else must be a
// well-formed Solana address.

import assert from 'node:assert';
import { KRYPTO_FEE_WAIVER_TOKENS, KRYPTO_TOKEN, isValidMint, kryptoDisclosure, kryptoPumpUrl, kryptoTokenLive, waivesFee } from './.krypto.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  assert.ok(KRYPTO_TOKEN.mint === null || isValidMint(KRYPTO_TOKEN.mint), `the pinned mint is null or a real address (got ${KRYPTO_TOKEN.mint})`);
  assert.equal(kryptoTokenLive(), KRYPTO_TOKEN.mint !== null, 'the card shows exactly when a mint is pinned');
  assert.equal(KRYPTO_TOKEN.chain, 'solana');
  ok('the pinned mint is either absent or well-formed');
}

{
  assert.equal(isValidMint('So11111111111111111111111111111111111111112'), true);
  assert.equal(isValidMint('J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n'), true);
  assert.equal(isValidMint('0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a'), false, 'an EVM address is not a mint');
  assert.equal(isValidMint('So1111111111111111111111111111111111111111O'), false, 'base58 has no O');
  assert.equal(isValidMint(''), false);
  assert.equal(isValidMint(null), false);
  ok('mint validation accepts base58 addresses and refuses everything else');
}

{
  assert.equal(kryptoPumpUrl('So11111111111111111111111111111111111111112'), 'https://pump.fun/coin/So11111111111111111111111111111111111111112');
  const d = kryptoDisclosure();
  assert.match(d, /issued by Krypt/);
  assert.match(d, /not a recommendation/);
  assert.match(d, /creator fees/);
  assert.match(d, /go to zero/);
  // The waiver is the most material fact about the maker's stake: holding it
  // makes the maker's software cheaper for you, which is a reason to buy it.
  // Saying so beside the fee the maker earns is the point of this paragraph.
  assert.match(d, /waives/i, d);
  assert.match(d, /1,000,000/, 'and names what it takes');
  assert.match(d, /reason to buy/i, 'and does not dress it up as a gift');
  ok('the disclosure names the issuer, the non-recommendation, the fee and the downside');
}


// ── The fee waiver ────────────────────────────────────────────────────
//
// This function decides whether Krypt gets paid. The case that matters is
// not "does a million qualify" — it is what happens when the app CANNOT
// TELL, and the answer has to be "charge", or breaking one balance read
// becomes the cheapest way to trade for free.

{
  // A TOKEN count, not a dollar value: a dollar threshold on a memecoin moves
  // under the holder, and it needs a price, which is a second thing that can
  // be unreadable. 1,000,000 of a 1,000,000,000 supply.
  assert.equal(KRYPTO_FEE_WAIVER_TOKENS, 1_000_000);
  assert.equal(waivesFee(1_000_000), true, 'exactly the threshold qualifies');
  assert.equal(waivesFee(1_000_001), true);
  assert.equal(waivesFee(999_999), false, 'just under does not');
  assert.equal(waivesFee(999_999.99), false, 'and a fraction under is still under');
  assert.equal(waivesFee(0), false);
  ok('the threshold is a token count, inclusive, and holds at the boundary');
}

{
  // Every shape of "we do not know". None of them may waive.
  for (const unknown of [null, undefined, NaN, Infinity, -Infinity, '25', '', {}, [], true]) {
    assert.equal(waivesFee(unknown), false, `${String(unknown)} MUST NOT waive the fee`);
  }
  // Including a negative, which no real holding is but a broken read might be.
  assert.equal(waivesFee(-100), false);
  // A string that LOOKS like enough is still not a number. JS would have
  // compared '2000000' >= 1000000 as true had the guard been loose.
  assert.equal(waivesFee('2000000'), false);
  ok('an unknown, unreadable or nonsense holding is charged, never waived');
}

{
  // The waiver is a fact about a holding, not about a wallet: the caller sums
  // across wallets and this only ever sees the total. A test that pins the
  // SHAPE, so a future refactor cannot quietly make it per-wallet.
  assert.equal(waivesFee(600_000 + 400_000), true, '600k in one wallet and 400k in another is a million');
  assert.equal(waivesFee(600_000 + 399_999), false);
  ok('the threshold is on the total across wallets, not on any one of them');
}

console.log(`\nkrypto: ${passed}/${passed} passed`);
