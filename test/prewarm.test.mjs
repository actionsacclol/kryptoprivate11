// Prewarm — the invariant between the heartbeat and what it keeps warm.
//
// The bug this exists for (measured 2026-09-18): the cached blockhash expires
// after BLOCKHASH_TTL_MS (20 s) but the prewarm heartbeat ran every 30 s, so
// from t=20 s to t=30 s the cache was expired and `buildLocalTrade` paid an
// inline getLatestBlockhash — roughly one order in three, for ~60–105 ms it
// did not need to spend. Nothing was broken enough to fail a test; the order
// was just quietly slower a third of the time.
//
// Two constants in two files, each reasonable alone, wrong together. So the
// beat is DERIVED from the TTL now, and this pins the relationship rather than
// either number: whichever a future edit changes, the refresh must still land
// before the thing it refreshes goes stale.

import assert from 'node:assert';
import { BLOCKHASH_BEAT_MS } from './.prewarmconst.mjs';
import { BLOCKHASH_TTL_MS } from './.txbuilder.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  assert.ok(
    BLOCKHASH_BEAT_MS < BLOCKHASH_TTL_MS,
    `the blockhash is refreshed every ${BLOCKHASH_BEAT_MS} ms but goes stale after ${BLOCKHASH_TTL_MS} ms — ` +
      `builds in the ${BLOCKHASH_TTL_MS - BLOCKHASH_BEAT_MS} ms gap pay an inline round trip`,
  );
  ok(`the blockhash is refreshed (${BLOCKHASH_BEAT_MS} ms) before it expires (${BLOCKHASH_TTL_MS} ms)`);
}

{
  // `primeBlockhash` itself only refetches once the cache is half-expired, so
  // a beat slower than half the TTL still leaves a window.
  assert.ok(
    BLOCKHASH_BEAT_MS <= BLOCKHASH_TTL_MS / 2,
    'the beat must be at least as often as primeBlockhash is willing to refetch',
  );
  ok('and often enough that primeBlockhash actually acts on the beat');
}

{
  // The other direction: this timer runs forever while armed, so it must not
  // become a hot loop if someone drops the TTL.
  assert.ok(BLOCKHASH_BEAT_MS >= 5_000, 'the beat is floored so a small TTL cannot spin the timer');
  ok('the beat has a floor — a small TTL cannot turn it into a poll');
}

console.log(`\nprewarm: ${passed}/${passed} passed`);
