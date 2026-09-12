// $KRYPTO — the pinned mint behind the Hub's buy button.
//
// The one thing that must never ship: a card pointing at a malformed or
// mistyped mint. Null is fine (the card hides); anything else must be a
// well-formed Solana address.

import assert from 'node:assert';
import { KRYPTO_TOKEN, isValidMint, kryptoDisclosure, kryptoPumpUrl, kryptoTokenLive } from './.krypto.mjs';

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
  ok('the disclosure names the issuer, the non-recommendation, the fee and the downside');
}

console.log(`\nkrypto: ${passed}/${passed} passed`);
