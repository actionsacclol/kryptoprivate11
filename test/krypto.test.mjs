// $KRYPTO — the pinned mint behind the Hub's buy button.
//
// The one thing that must never ship: a card pointing at a malformed or
// mistyped mint. Null is fine (the card hides); anything else must be a
// well-formed Solana address.

import assert from 'node:assert';
import fs from 'node:fs';
import { KRYPTO_HOLDER_FEE_SHARE_BPS, KRYPTO_HOLDER_TOKENS, KRYPTO_TOKEN, holderFeeBps, holderRateApplies, isValidMint, kryptoDisclosure, kryptoPumpUrl, kryptoTokenLive } from './.krypto.mjs';

const nl0 = '\n';
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
  // The holder rate is the most material fact about the maker's stake:
  // holding it makes the maker's software cheaper for you, which is a reason
  // to buy it. Saying so beside the fee the maker earns is the point of this
  // paragraph — and it says HALVES, since 2026-09-20, not waives.
  assert.match(d, /halves/i, d);
  assert.doesNotMatch(d, /waives/i, 'the old full waiver is not promised anywhere');
  assert.match(d, /referral share/i, 'and says the referrer keeps earning');
  assert.match(d, /1,000,000/, 'and names what it takes');
  assert.match(d, /reason to buy/i, 'and does not dress it up as a gift');
  ok('the disclosure names the issuer, the non-recommendation, the fee and the downside');
}


// ── The holder rate ───────────────────────────────────────────────────
//
// This function decides how much Krypt gets paid. The case that matters is
// not "does a million qualify" — it is what happens when the app CANNOT
// TELL, and the answer has to be "full rate", or breaking one balance read
// becomes the cheapest way to trade cheaper.

{
  // A TOKEN count, not a dollar value: a dollar threshold on a memecoin moves
  // under the holder, and it needs a price, which is a second thing that can
  // be unreadable. 1,000,000 of a 1,000,000,000 supply.
  assert.equal(KRYPTO_HOLDER_TOKENS, 1_000_000);
  assert.equal(holderRateApplies(1_000_000), true, 'exactly the threshold qualifies');
  assert.equal(holderRateApplies(1_000_001), true);
  assert.equal(holderRateApplies(999_999), false, 'just under does not');
  assert.equal(holderRateApplies(999_999.99), false, 'and a fraction under is still under');
  assert.equal(holderRateApplies(0), false);
  ok('the threshold is a token count, inclusive, and holds at the boundary');
}

{
  // Every shape of "we do not know". None of them may waive.
  for (const unknown of [null, undefined, NaN, Infinity, -Infinity, '25', '', {}, [], true]) {
    assert.equal(holderRateApplies(unknown), false, `${String(unknown)} MUST NOT earn the holder rate`);
  }
  // Including a negative, which no real holding is but a broken read might be.
  assert.equal(holderRateApplies(-100), false);
  // A string that LOOKS like enough is still not a number. JS would have
  // compared '2000000' >= 1000000 as true had the guard been loose.
  assert.equal(holderRateApplies('2000000'), false);
  ok('an unknown, unreadable or nonsense holding is charged in full, never discounted');
}

{
  // The rate is a fact about a holding, not about a wallet: the caller sums
  // across wallets and this only ever sees the total. A test that pins the
  // SHAPE, so a future refactor cannot quietly make it per-wallet.
  assert.equal(holderRateApplies(600_000 + 400_000), true, '600k in one wallet and 400k in another is a million');
  assert.equal(holderRateApplies(600_000 + 399_999), false);
  ok('the threshold is on the total across wallets, not on any one of them');
}

{
  // HALF, not nothing (2026-09-20). A full waiver paid the referrer 20 % of
  // zero, which broke the referral programme for the users most likely to be
  // referred. The holder pays half the fee, and the referrer's share — a
  // share OF the fee — halves with it instead of vanishing.
  assert.equal(KRYPTO_HOLDER_FEE_SHARE_BPS, 5000);
  assert.equal(holderFeeBps(50, true), 25, 'the 0.5 % fee becomes 0.25 %');
  assert.equal(holderFeeBps(50, false), 50, 'a non-holder pays the ordinary rate');
  assert.equal(holderFeeBps(5, true), 2, 'whole basis points, floored');
  assert.equal(holderFeeBps(1, true), 1, 'never rounds a positive fee to nothing');
  assert.equal(holderFeeBps(0, true), 0, 'a zero base stays zero');
  assert.equal(holderFeeBps(NaN, true), NaN, 'garbage in stays garbage — the split refuses it');
  ok('a holder pays half the fee, never nothing');
}

{
  // Every surface that CHARGES the fee must also say what removes it, and
  // say it legibly. The Solana panel's hint shipped in text-krypt-muted/45
  // - 45% of a muted grey on a dark panel - and the EVM panel and the swap
  // card did not carry it at all, so two of the three places a user is
  // charged never mentioned the waiver (user report, 2026-09-18).
  //
  // Source-read on purpose: the rendering is JSX and this is about whether
  // the component is THERE, which a regex answers in a millisecond.
  const SURFACES = [
    'src/components/terminal/TradePanel.tsx',
    'src/components/terminal/EvmTradePanel.tsx',
    'src/components/terminal/SwapCard.tsx',
  ];
  for (const f of SURFACES) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(src.includes('<WaiverHint'), f + ' offers the waiver where it charges the fee');
  }
  const hint = fs.readFileSync(new URL('../src/components/terminal/WaiverHint.tsx', import.meta.url), 'utf8');
  // A bright yellow, not a specific one: the exact token has already moved
  // once (arc-gold -> amber-300, when the muted gold still did not stand out
  // on a dense fee line). What must not come back is a grey, or a colour at
  // reduced opacity.
  assert.match(hint, /text-(amber|yellow)-(200|300|400)\b|text-arc-gold\b/, 'the hint is a bright yellow, not a muted grey');
  // Code only: the comment at the top of that file quotes the class the bug
  // shipped in, and a test that reads prose would fail on its own history.
  const hintCode = hint.split(nl0).filter((l) => !l.trim().startsWith('//')).join(nl0);
  assert.ok(!/text-[a-z-]+\/(?:[0-5]?[0-9])\b/.test(hintCode), 'the hint never renders at reduced opacity');
  assert.ok(hint.includes('kryptoTokenLive'), 'and never advertises a token that does not exist yet');
  ok('every fee-charging surface offers the waiver, in bright yellow, at full opacity');

  // The Hub card is where someone who does not yet hold any finds out the
  // waiver exists. It used to be wrapped in `held.at > 0` - a completed
  // balance read - so a fresh install, or anyone whose read had not landed,
  // saw nothing at all (user report, 2026-09-18). The OFFER is a fact about
  // the product and does not depend on reading anybody's wallet; only the
  // line about their own holding does.
  const card = fs.readFileSync(new URL('../src/components/KryptoCard.tsx', import.meta.url), 'utf8');
  assert.ok(!/\{held\.at > 0 && \(/.test(card), 'the Hub card never hides the waiver behind a completed balance read');
  assert.match(card, /text-(amber|yellow)-(200|300|400)\b|text-arc-gold\b/, 'and states it in the same bright yellow');
  assert.ok(card.includes('KRYPTO_HOLDER_TOKENS'), 'naming the actual holding it takes');
  ok('the Hub card states the offer whether or not a balance has been read');
}

{
  // The bridge, and the button.
  //
  // main answered 'krypto:holding' and global.d.ts declared it, but preload
  // never exposed it. Every renderer call threw on `window.krypt.krypto`
  // inside the hook's catch, and the Hub card told a holder their wallets
  // were "not checked yet" — while their trades were already going out with
  // the fee waived (user report, 2026-09-19). Nothing typechecks preload
  // against global.d.ts; this does, for the one entry the fee depends on.
  const preload = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
  assert.match(
    preload,
    /krypto:\s*\{\s*holding:\s*\(refresh\?: boolean\) => ipcRenderer\.invoke\('krypto:holding', refresh === true\)/,
    'preload exposes krypto.holding and passes the refresh flag as a boolean',
  );
  const hook = fs.readFileSync(new URL('../src/state/useKryptoWaiver.ts', import.meta.url), 'utf8');
  assert.ok(hook.includes('window.krypt.krypto.holding(fresh)'), 'the shared hook passes the refresh flag through');
  assert.match(hook, /export function refreshKryptoWaiver\(\): Promise<string \| null>/, 'a forced read reports why it did not land, so a button can show it');
  const card = fs.readFileSync(new URL('../src/components/KryptoCard.tsx', import.meta.url), 'utf8');
  assert.ok(card.includes('await refreshKryptoWaiver()'), 'the Hub card has a Scan control that forces a fresh read');
  assert.ok(card.includes("'Scanning…' : 'Scan'"), 'labelled Scan');
  // A read that ran and failed is reported as such, AHEAD of "not checked
  // yet": only one of those is something the user can act on.
  const problemAt = card.indexOf('{held.problem');
  const uncheckedAt = card.indexOf('held.at === 0');
  assert.ok(problemAt > 0 && uncheckedAt > problemAt, 'the card reports a failed read before it says "not checked yet"');
  ok('preload exposes the holding, the card can force a read, and a failed read is never "not checked yet"');
}

console.log(`\nkrypto: ${passed}/${passed} passed`);
