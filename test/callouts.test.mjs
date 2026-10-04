// pump.fun callouts — reading someone else's feed without repeating its lies.
//
// test/fixtures/pump-callouts.json is a REAL `GET /home-feed` payload captured
// 2026-09-18, trimmed to one row per chain: solana, bsc, robinhood, and `arc`
// — a chain this app has no rail for, which is in the feed whether we like it
// or not and is the reason `chain` is nullable.
//
// The rules pinned here are all one rule wearing different hats: this feed is
// not ours, we cannot fix it, and a number we cannot stand behind must render
// as an em dash rather than as a confident zero next to someone's money.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  calloutChain,
  calloutsFor,
  coinCallsLabel,
  newestFirst,
  parseCoinCallouts,
  parseHomeFeed,
  parseMintPositions,
  skinInTheGame,
  derivedMultiple,
} from './.callouts.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const feed = JSON.parse(fs.readFileSync('test/fixtures/pump-callouts.json', 'utf8'));
const rows = parseHomeFeed(feed);

{
  assert.equal(rows.length, 4, 'every fixture row parses');
  const sol = rows.find((r) => r.rawChain === 'solana');
  assert.ok(sol, 'the solana row is there');
  assert.equal(sol.chain, 'solana');
  assert.ok(sol.id && sol.mint, 'id and mint survive');
  assert.ok(sol.at > 1_700_000_000_000, 'the ISO timestamp became ms');
  assert.ok(typeof sol.thesis === 'string' && sol.thesis.length > 0, 'the thesis comes through');
  ok('a real /home-feed payload parses into callouts');
}

{
  // pump says `bsc`; this app has always called that chain `bnb`, and a rail
  // keyed on the wrong string would silently drop every BNB call.
  assert.equal(calloutChain('bsc'), 'bnb');
  assert.equal(calloutChain('BSC'), 'bnb');
  assert.equal(calloutChain('solana'), 'solana');
  assert.equal(calloutChain('robinhood'), 'robinhood');
  // A chain this app cannot trade maps to null rather than to a default. A
  // default here would offer to open an `arc` coin on Solana.
  assert.equal(calloutChain('arc'), null);
  assert.equal(calloutChain('hyperevm'), null);
  assert.equal(calloutChain(undefined), null);
  const arc = rows.find((r) => r.rawChain === 'arc');
  assert.ok(arc, 'the arc row is kept');
  assert.equal(arc.chain, null, 'but it is not claimed for a chain we have');
  ok('bsc is bnb, and a chain this app has no rail for is null, not a default');
}

{
  // The multiple is DERIVED, not repeated. Measured 2026-09-18: for the same
  // call with the same `calledOutAtMcap`, /home-feed said 3.413 while
  // /callout/top said 5; 1.206 vs 1.6; 15.77 vs 60.9. Both cannot be the
  // multiple, so the app computes one it can explain from two numbers on the
  // same row and shows neither of pump's.
  const row = feed.coins[0];
  const [r] = parseHomeFeed({ coins: [{ ...row, marketCap: 8602, position: { ...row.position, callout: { ...row.position.callout, calledOutAtMcap: 4301, multiple: 999 } } }] });
  assert.equal(r.multiple, 2, '8602 now against 4301 called is 2x, whatever pump says');
  assert.equal(r.calledAtMcapUsd, 4301);
  assert.equal(r.mcapUsdNow, 8602, 'both sides of the sum stay on the row, so the number can be checked');

  // Either side missing means no multiple. 1x here would read as flat.
  assert.equal(derivedMultiple(null, 100), null);
  assert.equal(derivedMultiple(100, null), null);
  assert.equal(derivedMultiple(0, 100), null, 'called at zero is not a multiple, it is a divide by zero');
  assert.equal(derivedMultiple(100, 0), null);
  assert.equal(derivedMultiple(-5, 100), null);
  assert.equal(derivedMultiple(1e-9, 1e6), null, 'a 1e15x is a unit error, not a moonshot');
  assert.equal(derivedMultiple(50, 25), 0.5, 'a call that is down reports that it is down');

  // The per-coin route serves no current market cap. It has its own
  // `multiple` field and that field is the one measured disagreeing, so the
  // parser refuses to carry it at all.
  const top = parseCoinCallouts({ callouts: [{ calloutId: 'x', createdAt: 1789707057360, multiple: 60.9, maxMultiplier: 60.9, marketCap: 4407 }] }, 'M', 'solana');
  assert.equal(top[0].multiple, null, 'not repeated');
  assert.equal(top[0].peakMultiple, null, 'and neither is its peak');
  assert.equal(top[0].calledAtMcapUsd, 4407, 'what it IS trusted for: the size at the call, which both routes agree on');
  ok("the multiple is derived from the row, and pump's own multiple is never shown");
}

{
  // The feature's whole point: the caller's own position in what they called.
  const sol = rows.find((r) => r.rawChain === 'solana');
  assert.ok(sol.caller.wallet, 'the caller carries a wallet — the key into Wallet Scout');
  assert.ok(sol.caller.holds > 0, 'the fixture caller holds their call');
  assert.equal(skinInTheGame(sol), 'holding');

  // Synthetic, because all four captured rows happened to be holders. The
  // shapes are the payload's own fields, only the values are made up.
  const sold = { ...sol, caller: { ...sol.caller, holds: 0, boughtUsd: 250, realizedUsd: 80 } };
  assert.equal(skinInTheGame(sold), 'sold', 'held none, bought once = out');

  const never = { ...sol, caller: { ...sol.caller, holds: 0, boughtUsd: 0, realizedUsd: 0 } };
  assert.equal(skinInTheGame(never), 'never', 'held none, bought none = never bought it');

  // And the case that matters most: not knowing. `/callout/top` carries no
  // position at all, so every row from it must answer null — an unread fact
  // must never render as an accusation.
  const unknown = { ...sol, caller: { ...sol.caller, holds: null, boughtUsd: null, realizedUsd: null } };
  assert.equal(skinInTheGame(unknown), null, 'unknown is unknown');
  ok('skin in the game: holding / sold / never / unknown, and unknown says nothing');
}

{
  // A row missing the parts that make it a callout is dropped whole. Half a
  // row in a list read at a glance is worse than no row.
  const noMint = { coins: [{ ...feed.coins[0], coinMint: null }] };
  assert.equal(parseHomeFeed(noMint).length, 0, 'no mint, no row');
  const noCallout = { coins: [{ ...feed.coins[0], position: { ...feed.coins[0].position, callout: null } }] };
  assert.equal(parseHomeFeed(noCallout).length, 0, 'no callout, no row');
  const noTime = { coins: [{ ...feed.coins[0], position: { ...feed.coins[0].position, callout: { ...feed.coins[0].position.callout, calloutTimestamp: 'whenever' } } }] };
  assert.equal(parseHomeFeed(noTime).length, 0, 'an unparseable time is not a time');
  ok('an incomplete row is dropped, not filled in');
}

{
  // The feed must never be able to take the window down: pump owns its shape
  // and can change it any day.
  assert.deepEqual(parseHomeFeed(null), []);
  assert.deepEqual(parseHomeFeed({}), []);
  assert.deepEqual(parseHomeFeed({ coins: 'soon' }), []);
  assert.deepEqual(parseHomeFeed({ coins: [null, 3, 'x'] }), []);
  assert.deepEqual(parseCoinCallouts(null, 'M', 'solana'), []);
  assert.deepEqual(parseCoinCallouts({ callouts: {} }, 'M', 'solana'), []);
  ok('a payload that changed shape is an empty list, never a throw');
}

{
  // `/callout/top/{mint}` is a different shape from the feed: flat, and the
  // wallet is in `userId`.
  const top = {
    callouts: [
      {
        calloutId: 'fe2da63b-7864-4e1b-9116-0872d7b88baf',
        userId: 'EuhR1Q5qGEUdYZ3iBKdtf7MVqE76gukY5RSZpWzCm4YN',
        user_uuid: 'a1612e60-990c-4750-83a1-8dd739c9fac6',
        coinMint: '7U5NzDtMd6BYEtXZi1y4LR625zkpgHtpXK37s3mpump',
        marketCap: 156265707,
        createdAt: 1789707057360,
        multiple: 1.7,
        thesis: 'can you buy my callout',
        username: 'redxranger',
      },
    ],
  };
  const [r] = parseCoinCallouts(top, '7U5NzDtMd6BYEtXZi1y4LR625zkpgHtpXK37s3mpump', 'solana');
  assert.equal(r.caller.wallet, 'EuhR1Q5qGEUdYZ3iBKdtf7MVqE76gukY5RSZpWzCm4YN', 'userId is the WALLET on this route');
  assert.equal(r.caller.name, 'redxranger');
  assert.equal(r.at, 1789707057360, 'a numeric createdAt is taken as ms');
  assert.equal(r.chain, 'solana', 'the chain comes from the caller, not the payload');
  assert.equal(skinInTheGame(r), null, 'this route carries no position, so it claims nothing');
  ok('/callout/top parses, and says nothing it was not told');
}

{
  // The feed arrives in pump's recommendation rank, which is not time order.
  const sorted = newestFirst(rows);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.ok(sorted[i].at >= sorted[i + 1].at, 'newest first');
  }
  assert.equal(rows.length, 4, 'sorting does not mutate the input');
  const mint = rows[0].mint;
  const forMint = calloutsFor(rows, mint.toUpperCase());
  assert.ok(forMint.length >= 1, 'a mint lookup is case-insensitive');
  ok('newest-first sorting is a copy, and a per-mint lookup ignores case');
}

{
  // The feed's `position.totalCallouts` is the COIN's call count, not the
  // caller's: measured 2026-09-26, feed rows said 87 / 9 / 11 / 47 where each
  // caller's own /users/{address}/callout-stats said 477 / 1405 / 1776 / 2693
  // all-time. Labelling it as the caller's count was the bug.
  const sol = rows.find((r) => r.rawChain === 'solana');
  assert.equal(sol.coinCallouts, feed.coins[0].position.totalCallouts, 'the count is carried — as the coin’s');
  for (const r of rows) assert.equal(r.caller.totalCallouts, null, 'and never as the caller’s');
  const top = parseCoinCallouts({ callouts: [{ calloutId: 'x', createdAt: 1789707057360 }] }, 'M', 'solana');
  assert.equal(top[0].coinCallouts, null, 'a route that does not carry it says nothing');
  const noCount = parseHomeFeed({ coins: [{ ...feed.coins[0], position: { ...feed.coins[0].position, totalCallouts: 'many' } }] });
  assert.equal(noCount[0].coinCallouts, null, 'a non-number is unknown, not 0');

  assert.equal(coinCallsLabel([sol]), sol.coinCallouts > 1 ? `1 of ${sol.coinCallouts} calls` : '1 call');
  assert.equal(coinCallsLabel([{ ...sol, coinCallouts: 87 }]), '1 of 87 calls', 'one feed row of 87 says so');
  assert.equal(coinCallsLabel([{ ...sol, coinCallouts: null }]), '1 call', 'unknown count adds nothing');
  assert.equal(coinCallsLabel([{ ...sol, coinCallouts: null }, { ...sol, id: 'y', coinCallouts: null }]), '2 calls');
  assert.equal(coinCallsLabel([{ ...sol, coinCallouts: 1 }]), '1 call', 'a count that is not larger is not repeated');
  ok('position.totalCallouts is the coin’s count (coinCallouts), never the caller’s');
}

{
  // test/fixtures/pump-mint-positions.json is a REAL `GET /mint-positions/{mint}`
  // payload (withThesis=false) captured 2026-09-30: two holders of HalloCate,
  // one with a callout and one without. Only the call becomes a row, with the
  // caller's own position, and no multiple — this route serves no current cap.
  const raw = JSON.parse(fs.readFileSync('test/fixtures/pump-mint-positions.json', 'utf8'));
  const mint = raw.positions[0].coinMint;
  const rows = parseMintPositions(raw, mint, 'solana');
  const withCall = raw.positions.filter((x) => x.callout);
  assert.equal(rows.length, withCall.length, 'a holder without a callout is not a row');
  const [r] = rows;
  assert.equal(r.id, withCall[0].callout.calloutId);
  assert.equal(r.at, Date.parse(withCall[0].callout.calloutTimestamp), 'at = when they called');
  assert.equal(r.caller.wallet, withCall[0].walletAddress);
  assert.equal(r.caller.holds, withCall[0].amountHeld);
  assert.equal(r.calledAtMcapUsd, withCall[0].callout.calledOutAtMcap);
  assert.equal(r.multiple, null, 'pump’s own multiple is not repeated');
  assert.equal(skinInTheGame(r), 'holding');
  assert.deepEqual(parseMintPositions(null, mint, 'solana'), []);
  assert.deepEqual(parseMintPositions({ positions: [{ callout: { calloutId: 'x' } }] }, mint, 'solana'), [], 'a call with no timestamp is dropped');
  ok('/mint-positions parses one row per CALL, with the caller’s position');
}

console.log(`\ncallouts: ${passed}/${passed} passed`);
