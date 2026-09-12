// Wallet Scout — the windowing and the ranking.
//
// This is a leaderboard, and a leaderboard is exactly where a small sample or
// a bot at the top does real damage: someone reads it and copies a wallet with
// their own money. The rules pinned here are the ones that stop it lying.

import assert from 'node:assert';
import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_MAX_TRACKED,
  SCOUT_RETENTION_DAYS,
  dayOf,
  looksAutomated,
  rankScout,
  rotate,
  summarise,
  tradeId,
} from './.walletscout.mjs';
import * as scout from './.walletscoutstore.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const NOW = new Date('2026-09-10T12:00:00').getTime();
const TODAY = dayOf(NOW);

const day = (offset, over = {}) => ({
  day: TODAY - offset,
  buys: 2,
  sells: 2,
  roundTrips: 2,
  wins: 1,
  losses: 1,
  pnl: 1,
  volume: 10,
  ...over,
});

const wallet = (days, over = {}) => ({
  chain: 'solana',
  address: '0xw',
  firstSeen: NOW - 86_400_000 * 30,
  lastSeen: NOW,
  days,
  openCount: 0,
  openCost: 0,
  medianHoldMs: null,
  ...over,
});

{
  // A window is a sum of the days inside it, and nothing outside.
  const w = wallet([day(0), day(1), day(3), day(9), day(40)]);
  assert.equal(summarise(w, 'day', NOW).roundTrips, 2, 'today is one bucket');
  assert.equal(summarise(w, 'week', NOW).roundTrips, 6, 'seven days covers offsets 0,1,3');
  assert.equal(summarise(w, 'month', NOW).roundTrips, 8, 'thirty days adds offset 9');
  assert.equal(summarise(w, 'all', NOW).roundTrips, 10, 'all time adds offset 40');
  ok('a window sums exactly the days inside it');
}

{
  // The sample floor. Two lucky trades must not sit above a real record.
  const thin = summarise(wallet([day(0, { roundTrips: 2, wins: 2, losses: 0, pnl: 500 })]), 'day', NOW);
  assert.equal(thin.ranked, false, `${MIN_TRIPS_FOR_RANK} trips are needed to rank`);
  assert.equal(thin.winRatePct, null, 'and a win rate off two trades is not reported at all');

  const solid = summarise(wallet([day(0, { roundTrips: 10, wins: 6, losses: 4, pnl: 1 })]), 'day', NOW);
  assert.equal(solid.ranked, true);
  assert.equal(solid.winRatePct, 60);

  const ordered = rankScout([thin, solid], 'pnl');
  assert.equal(ordered[0].roundTrips, 10, 'the ranked wallet outranks the huge thin one');
  ok('a thin sample cannot top the board, however profitable it looks');
}

{
  // Return is unknown when nothing was spent — not 0%.
  const nothing = summarise(wallet([day(0, { volume: 0, pnl: 0, buys: 0, sells: 1 })]), 'day', NOW);
  assert.equal(nothing.returnPct, null, 'no volume means no return to report');
  const real = summarise(wallet([day(0, { volume: 10, pnl: 2, roundTrips: 5, wins: 3, losses: 2 })]), 'day', NOW);
  assert.equal(real.returnPct, 20);
  ok('return is null without volume, and a real ratio with it');
}

{
  // Bots. The LP swarm's number-one liquidity provider was a JIT bot holding
  // positions for one block; a PnL board here will surface snipers the same
  // way, and they are not copyable by a person clicking a button.
  assert.equal(looksAutomated(4_000, 40), true, 'fast and frequent is automated');
  assert.equal(looksAutomated(4_000, 3), false, 'fast but rare is too small a sample to call');
  assert.equal(looksAutomated(600_000, 500), false, 'frequent but patient is a person');
  assert.equal(looksAutomated(null, 500), false, 'unknown hold time is never called a bot');

  const bot = { ...summarise(wallet([day(0, { roundTrips: 40, wins: 30, losses: 10, pnl: 900 })], { medianHoldMs: 3_000 }), 'day', NOW) };
  const human = { ...summarise(wallet([day(0, { roundTrips: 10, wins: 6, losses: 4, pnl: 5 })], { medianHoldMs: 900_000 }), 'day', NOW) };
  assert.equal(bot.looksAutomated, true);
  const ordered = rankScout([bot, human], 'pnl');
  assert.equal(ordered[0].address, human.address, 'a human ranks above a more profitable bot');
  assert.equal(ordered[0].pnl, 5, 'and it really is the less profitable one');
  ok('a bot is marked and ranked below a human, however much it made');
}

{
  // Daily rotation: anything past retention is dropped, newest first.
  const days = [day(0), day(5), day(SCOUT_RETENTION_DAYS - 1), day(SCOUT_RETENTION_DAYS), day(400)];
  const kept = rotate(days, NOW);
  assert.equal(kept.length, 3, 'buckets past retention roll off');
  assert.deepEqual(
    kept.map((d) => TODAY - d.day),
    [0, 5, SCOUT_RETENTION_DAYS - 1],
    'and what is left is newest first',
  );
  ok('history rotates daily and keeps the retention window, newest first');
}

{
  // Ranking by a measure nobody has is not a ranking: unknown goes last.
  const withRate = summarise(wallet([day(0, { roundTrips: 8, wins: 4, losses: 4, volume: 10, pnl: 1 })]), 'day', NOW);
  const noVolume = summarise(wallet([day(0, { roundTrips: 8, wins: 8, losses: 0, volume: 0, pnl: 0 })]), 'day', NOW);
  const ordered = rankScout([noVolume, withRate], 'returnPct');
  assert.equal(ordered[0].returnPct, 10, 'a known return sorts above an unknown one');
  assert.equal(ordered[1].returnPct, null);
  ok('an unknown measure sorts last rather than counting as zero');
}

{
  // Your own wallets are never on the leaderboard.
  //
  // This matters more than it looks: the Warmer buys and sells on a schedule
  // across the user's OWN wallets, which produces exactly the round trips this
  // page ranks on. Without this the app would manufacture activity and then
  // present it back as somebody's measured record.
  scout._reset();
  const MINE = 'MyOwnWallet1111111111111111111111111111111';
  const OTHER = 'SomeoneElse1111111111111111111111111111111';
  scout.setOwnAddresses('solana', [MINE]);

  // Enough sightings to be promoted, then a closing sell each.
  for (const who of [MINE, OTHER]) {
    for (let i = 0; i < 4; i++) scout.note('solana', who, 'mint' + i, true, 0.1, 1000, NOW);
    scout.note('solana', who, 'mint0', false, 0.2, 1000, NOW);
  }
  const addrs = scout.wallets('solana').map((w) => w.address.toLowerCase());
  assert.ok(addrs.includes(OTHER.toLowerCase()), 'a stranger is recorded');
  assert.ok(!addrs.includes(MINE.toLowerCase()), 'our own wallet is not');
  assert.equal(scout.isOwn('solana', MINE), true);
  assert.equal(scout.isOwn('solana', OTHER), false);
  ok("the user's own wallets are never recorded, so warming cannot reach the board");
}

{
  // A wallet recorded BEFORE it was known to be ours is purged, not left.
  scout._reset();
  const LATE = 'LaterMineWallet11111111111111111111111111';
  for (let i = 0; i < 4; i++) scout.note('solana', LATE, 'm' + i, true, 0.1, 1000, NOW);
  assert.equal(scout.wallets('solana').length, 1, 'recorded while unknown');
  scout.setOwnAddresses('solana', [LATE]);
  assert.equal(scout.wallets('solana').length, 0, 'and purged once we learn it is ours');
  ok('history recorded before a wallet was known to be ours is purged');
}

{
  // Ownership is per chain, like everything else here.
  scout._reset();
  const A = '0xabc0000000000000000000000000000000000001';
  scout.setOwnAddresses('robinhood', [A]);
  assert.equal(scout.isOwn('robinhood', A), true);
  assert.equal(scout.isOwn('bnb', A), false, 'the same address on another chain is a different question');
  ok('ownership is per chain, like everything else here');
}

{
  // The same trade twice is one trade. The live feed and a manual scan can
  // both carry it; whichever is second is refused.
  scout._reset();
  const A = 'DupWallet111111111111111111111111111111111';
  for (let i = 0; i < 3; i++) scout.note('solana', A, 'p' + i, true, 0.1, 1000, NOW, tradeId('sig' + i, 'p' + i, A, true));
  const id = tradeId('sigBuy', 'x', A, true);
  assert.equal(scout.note('solana', A, 'x', true, 0.5, 1000, NOW, id), 'noted');
  assert.equal(scout.note('solana', A, 'x', true, 0.5, 1000, NOW, id), 'duplicate');
  const w = scout.wallets('solana')[0];
  assert.ok(Math.abs(w.days.reduce((n, d) => n + d.volume, 0) - 0.6) < 1e-9, 'the second copy added nothing');
  assert.equal(w.openCount, 2, 'and opened nothing');
  // The id pins one fill inside a transaction: a bundle buying two mints in
  // one signature is two trades, and a sell is not its buy.
  assert.notEqual(tradeId('s', 'm1', A, true), tradeId('s', 'm2', A, true));
  assert.notEqual(tradeId('s', 'm1', A, true), tradeId('s', 'm1', A, false));
  assert.equal(tradeId('s', 'M1', A.toUpperCase(), true), tradeId('s', 'm1', A, true), 'case does not make a new trade');
  assert.equal(scout.note('solana', A, 'y', true, 0.5, 1000, NOW), 'noted', 'a call without an id is never refused');
  ok('a trade carrying an id is recorded once, whichever feed brings it second');
}

{
  // The cap. It used to evict by last-seen alone, so pump's flood of
  // three-trade addresses pushed a wallet with a real record off the book the
  // moment it went quiet — the rows the page exists to find were the ones
  // the bound ate. Thin records go first now.
  scout._reset();
  const RANKED = 'RankedWallet1111111111111111111111111111111';
  const OLD = NOW - 5 * 86_400_000;
  for (let i = 0; i < 3; i++) scout.note('solana', RANKED, 'r' + i, true, 0.1, 1000, OLD);
  for (let i = 3; i < 8; i++) scout.note('solana', RANKED, 'r' + i, true, 0.1, 1000, OLD);
  for (let i = 3; i < 8; i++) scout.note('solana', RANKED, 'r' + i, false, 0.2, 1000, OLD + 1000);
  const before = scout.wallets('solana').find((w) => w.address === RANKED.toLowerCase());
  assert.ok(before.days.reduce((n, d) => n + d.roundTrips, 0) >= MIN_TRIPS_FOR_RANK, 'setup: it is ranked');
  for (let n = 0; n < SCOUT_MAX_TRACKED + 25; n++) {
    const thin = `Thin${String(n).padStart(6, '0')}1111111111111111111111111111111`;
    for (let i = 0; i < 3; i++) scout.note('solana', thin, 't' + i, true, 0.1, 1000, NOW);
  }
  assert.equal(scout.counts('solana').tracked, SCOUT_MAX_TRACKED, 'the book holds exactly the cap');
  assert.equal(scout.counts('solana').cap, SCOUT_MAX_TRACKED, 'and says what the cap is');
  assert.ok(scout.wallets('solana').some((w) => w.address === RANKED.toLowerCase()), 'the five-day-old ranked record survived the flood');
  ok('at the cap, thin records are evicted before a ranked one, however long the ranked one has been quiet');
}

{
  // A saved wallet is never evicted either, ranked or not.
  scout._reset();
  const KEEP = 'SavedThinWallet111111111111111111111111111';
  for (let i = 0; i < 3; i++) scout.note('solana', KEEP, 'k' + i, true, 0.1, 1000, NOW - 86_400_000);
  scout.setSaved('solana', KEEP, true);
  for (let n = 0; n < SCOUT_MAX_TRACKED + 5; n++) {
    const thin = `Flood${String(n).padStart(6, '0')}111111111111111111111111111111`;
    for (let i = 0; i < 3; i++) scout.note('solana', thin, 't' + i, true, 0.1, 1000, NOW);
  }
  assert.ok(scout.wallets('solana').some((w) => w.address === KEEP.toLowerCase()));
  ok('a saved wallet survives the cap');
}

console.log(`\nwalletscout: ${passed}/${passed} passed`);
