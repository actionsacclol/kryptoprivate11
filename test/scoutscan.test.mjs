// Wallet Scout — the manual scan runner.
//
// A scan replays hours of trades into the same book the live feed writes.
// Two things make that safe and they are what is pinned here: the feed order
// (a sell before its buy scores nothing), and the duplicate guard (a trade the
// feed already recorded must not be counted again). Driven by fake sources —
// the chain adapters are wiring over readers that have their own tests.

import assert from 'node:assert';
import { _reset, _store as scout, cancel, start, status, wait } from './.scoutscan.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const NOW = Date.now();
const W = 'ScannedWallet111111111111111111111111111111';
const trade = (mint, isBuy, native, tokens, at, tx, address = W) => ({ address, mint, isBuy, native, tokens, at, tx });
const book = (chain, address) => scout.wallets(chain).find((w) => w.address === address.toLowerCase());
const sum = (w, field) => w.days.reduce((n, d) => n + d[field], 0);
const fresh = () => {
  _reset();
  scout._reset();
};

{
  // A batch arrives in any order; the sell is listed FIRST here. Fed as-is it
  // would find no basis and score nothing. The wallet's first two buys are
  // sightings (the store promotes on the third), so the trip that can close
  // is on the mint bought at promotion.
  fresh();
  const batch = {
    calls: 2,
    units: 1,
    trades: [
      trade('m2', false, 0.3, 1000, NOW - 10_000, 't5'),
      trade('m0', true, 0.1, 1000, NOW - 50_000, 't1'),
      trade('m1', true, 0.1, 1000, NOW - 40_000, 't2'),
      trade('m2', true, 0.1, 1000, NOW - 30_000, 't3'),
      trade('m3', true, 0.1, 1000, NOW - 20_000, 't4'),
    ],
  };
  const source = async function* () {
    yield batch;
  };
  assert.equal(start('solana', 6, source).ok, true);
  await wait('solana');
  const st = status('solana');
  assert.equal(st.running, false);
  assert.equal(st.read, 5);
  assert.equal(st.fed, 5);
  assert.equal(st.duplicates, 0);
  assert.equal(st.calls, 2);
  assert.equal(st.units, 1);
  assert.equal(st.unitsDone, 1);
  assert.equal(st.cancelled, false);
  assert.equal(st.trackedBefore, 0);
  assert.equal(st.trackedAfter, 1);
  const w = book('solana', W);
  assert.ok(w, 'the wallet is on record');
  assert.equal(sum(w, 'roundTrips'), 1, 'the sell closed the trip although it was listed first');
  assert.ok(Math.abs(sum(w, 'pnl') - 0.2) < 1e-9, 'and it is priced against the buy it closed');
  assert.equal(w.firstSeen, NOW - 30_000, 'firstSeen is the oldest trade on the book, not the arrival time');
  ok('a batch is fed oldest-first, so a sell listed before its buy still closes a round trip');
}

{
  // The live feed recorded a buy an hour ago; a scan over the same hour reads
  // the same buy again. It must be refused, or every round trip the feed
  // scored while the scan runs is doubled.
  fresh();
  for (let i = 0; i < 3; i++) scout.note('solana', W, 'p' + i, true, 0.1, 1000, NOW - 100_000, 'live' + i);
  assert.equal(scout.note('solana', W, 'x', true, 0.5, 1000, NOW - 5_000, 'sigX'), 'noted');
  const source = async function* () {
    yield {
      calls: 1,
      units: 1,
      trades: [trade('x', true, 0.5, 1000, NOW - 5_000, 'sigX'), trade('x', false, 1.0, 1000, NOW - 1_000, 'sigY')],
    };
  };
  start('solana', 1, source);
  await wait('solana');
  const st = status('solana');
  assert.equal(st.read, 2);
  assert.equal(st.duplicates, 1, 'the buy the feed already had is a duplicate');
  assert.equal(st.fed, 1, 'the sell is new');
  const w = book('solana', W);
  assert.ok(Math.abs(sum(w, 'volume') - 0.6) < 1e-9, 'volume counts the buy once (0.1 at promotion + 0.5)');
  assert.equal(sum(w, 'roundTrips'), 1);
  assert.ok(Math.abs(sum(w, 'pnl') - 0.5) < 1e-9);
  ok('a trade the live feed already recorded is refused by the scan, not counted twice');
}

{
  // Cancel stops after the current unit; a second start while one runs is
  // refused; and the chain can be scanned again afterwards.
  fresh();
  let yielded = 0;
  const source = async function* () {
    for (let i = 0; i < 50; i++) {
      yielded += 1;
      yield { calls: 1, units: 50, trades: [] };
    }
  };
  assert.equal(start('robinhood', 6, source).ok, true);
  assert.equal(start('robinhood', 6, source).ok, false, 'one scan per chain at a time');
  assert.equal(cancel('robinhood'), true);
  await wait('robinhood');
  const st = status('robinhood');
  assert.equal(st.running, false);
  assert.equal(st.cancelled, true);
  assert.ok(st.unitsDone < 50 && yielded < 50, `stopped early (${st.unitsDone} of 50)`);
  assert.equal(cancel('robinhood'), false, 'nothing to cancel once it has stopped');
  assert.equal(start('robinhood', 6, source).ok, true, 'and it can run again');
  await wait('robinhood');
  assert.equal(status('robinhood').cancelled, false);
  ok('a scan can be cancelled, refuses a second start while running, and runs again after');
}

{
  // A source that fails mid-way leaves what it fed, says why, and is not
  // "running" forever.
  fresh();
  const source = async function* () {
    yield { calls: 1, units: 3, trades: [], note: 'first note' };
    yield { calls: 1, trades: [], note: 'second note' };
    throw new Error('RPC fell over');
  };
  start('bnb', 24, source);
  await wait('bnb');
  const st = status('bnb');
  assert.equal(st.running, false);
  assert.equal(st.unitsDone, 2);
  assert.equal(st.calls, 2);
  assert.equal(st.message, 'first note', 'the first thing that went wrong is the one reported');
  assert.ok(st.finishedAt !== null);
  const failing = async function* () {
    throw new Error('RPC fell over');
    // eslint-disable-next-line no-unreachable
    yield { calls: 0, trades: [] };
  };
  start('bnb', 24, failing);
  await wait('bnb');
  assert.match(status('bnb').message, /RPC fell over/, 'a throw with no earlier note is the message');
  ok('a failing source stops the scan cleanly and says what happened');
}

{
  // A source restating its total (an EVM chunk that had to be halved) is
  // believed; the last word is the honest one.
  fresh();
  const source = async function* () {
    yield { calls: 1, units: 4, trades: [] };
    yield { calls: 1, units: 7, trades: [] };
  };
  start('robinhood', 1, source);
  await wait('robinhood');
  assert.equal(status('robinhood').units, 7);
  assert.equal(status('robinhood').unitsDone, 2);
  ok('a restated unit total replaces the earlier estimate');
}

{
  // The user's own wallet in a scanned page is not fed — the store refuses
  // it, and the scan counts it as neither fed nor duplicate.
  fresh();
  const MINE = 'MyOwnWallet1111111111111111111111111111111';
  scout.setOwnAddresses('solana', [MINE]);
  const source = async function* () {
    yield { calls: 1, units: 1, trades: [trade('m', true, 1, 1, NOW, 'a', MINE), trade('m', false, 2, 1, NOW, 'b', MINE)] };
  };
  start('solana', 1, source);
  await wait('solana');
  const st = status('solana');
  assert.equal(st.read, 2);
  assert.equal(st.fed, 0);
  assert.equal(st.duplicates, 0);
  assert.equal(scout.wallets('solana').length, 0);
  ok('a scan cannot put the user\'s own wallet on the board either');
}

console.log(`\nscoutscan: ${passed}/${passed} passed`);
