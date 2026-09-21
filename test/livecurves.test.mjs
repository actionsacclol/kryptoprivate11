// The feed's own books for the Discover columns (electron/engine/liveCurves.ts).
//
// Pins the rules the Graduating and Migrated columns now stand on instead
// of pump.fun's lists: ranking by token-side progress, the completion cut,
// the idle cut-off, out-of-order arrivals never moving reserves backwards,
// the caps, and newest-first migrations with no duplicates.

import assert from 'node:assert';
import {
  GRADUATING_MAX_IDLE_MS,
  GRADUATING_MIN_PCT,
  LIVE_CURVES_CAP,
  LIVE_MIGRATIONS_CAP,
  LiveCurves,
  LiveMigrations,
} from './.livecurves.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const INITIAL_VTOK = 1_073_000_000_000_000n;
const SELLABLE = 793_100_000_000_000n;
/** vTok for a curve that has sold `pct` of its sellable supply. */
const vTokAt = (pct) => INITIAL_VTOK - (SELLABLE * BigInt(Math.round(pct * 100))) / 10_000n;
const vSol = 40_000_000_000n;

{
  let now = 1_000_000;
  const book = new LiveCurves(() => now);
  book.note('A', vSol, vTokAt(35), 'creatorA', now);
  book.note('B', vSol, vTokAt(90), null, now + 1);
  book.note('C', vSol, vTokAt(10), null, now + 2); // under the floor
  book.note('D', vSol, vTokAt(100), null, now + 3); // sold out → complete
  book.note('E', vSol, vTokAt(60), null, now + 4);
  const g = book.graduating(10);
  assert.deepEqual(g.map((c) => c.mint), ['B', 'E', 'A'], 'most progressed first; the floor and the sold-out curve are out');
  assert.ok(Math.abs(g[0].progressPct - 90) < 0.01, `progress is token-side: ${g[0].progressPct}`);
  assert.equal(book.get('D').complete, true, 'the token floor marks completion without any complete event');
  assert.equal(book.get('A').creator, 'creatorA');
  assert.equal(GRADUATING_MIN_PCT, 20);
  ok('graduating ranks incomplete curves by token-side progress, above a floor');
}

{
  let now = 1_000_000;
  const book = new LiveCurves(() => now);
  book.note('A', vSol, vTokAt(80), null, now);
  book.note('B', vSol, vTokAt(70), null, now);
  now += GRADUATING_MAX_IDLE_MS + 1;
  book.note('B', vSol, vTokAt(71), null, now);
  assert.deepEqual(book.graduating(10).map((c) => c.mint), ['B'], 'a curve nobody traded in fifteen minutes is not graduating today');
  assert.equal(book.graduating(10, { maxIdleMs: GRADUATING_MAX_IDLE_MS * 2 }).length, 2, 'the cut-off is a parameter');
  ok('idle curves fall out of the candidate set');
}

{
  const book = new LiveCurves(() => 0);
  book.note('A', vSol, vTokAt(50), null, 100);
  book.note('A', 30_000_000_000n, vTokAt(40), null, 90); // a late copy from a slower socket
  assert.equal(book.get('A').vSol, vSol, 'an older arrival never moves the reserves backwards');
  assert.ok(Math.abs(book.get('A').progressPct - 50) < 0.01);
  assert.equal(book.get('A').trades, 2, 'but it is still counted as a trade seen');
  book.complete('A');
  assert.equal(book.graduating(10).length, 0, 'complete() (the event, or a migration) removes it');
  ok('out-of-order arrivals and explicit completion');
}

{
  const book = new LiveCurves(() => 0);
  for (let i = 0; i < LIVE_CURVES_CAP + 50; i++) book.note(`M${i}`, vSol, vTokAt(30), null, i);
  assert.equal(book.size, LIVE_CURVES_CAP, 'bounded');
  assert.equal(book.get('M0'), null, 'the oldest went first');
  assert.ok(book.get(`M${LIVE_CURVES_CAP + 49}`), 'the newest stayed');
  const b2 = new LiveCurves(() => 0);
  b2.note('old', vSol, vTokAt(30), null, 0);
  b2.note('new', vSol, vTokAt(30), null, 60 * 60_000 + 5_000);
  assert.equal(b2.sweep(60 * 60_000 + 5_000), 1, 'an hour idle is swept');
  assert.equal(b2.size, 1);
  ok('the book is capped and sweeps what nobody trades');
}

{
  const migs = new LiveMigrations();
  migs.note('A', 'poolA', 85_000_000_000n, 1_000);
  migs.note('B', 'poolB', null, 2_000);
  migs.note('A', 'poolA2', null, 3_000); // the same mint again: a duplicate event
  assert.deepEqual(migs.recent(10).map((m) => m.mint), ['B', 'A'], 'newest first, one row per mint');
  assert.equal(migs.recent(10)[1].pool, 'poolA', 'the first record stands');
  assert.equal(migs.recent(1).length, 1);
  assert.equal(migs.has('B'), true);
  for (let i = 0; i < LIVE_MIGRATIONS_CAP + 10; i++) migs.note(`X${i}`, `p${i}`, null, 10_000 + i);
  assert.equal(migs.size, LIVE_MIGRATIONS_CAP, 'bounded');
  assert.equal(migs.has('A'), false, 'evicted mints may be noted again later');
  ok('migrations: newest first, deduplicated, capped');
}

console.log(`\nlivecurves: ${passed}/${passed} passed`);
