// Feed-health (reserve continuity) tests — the live version of the tape
// analysis that measured ~20% websocket event loss:
// - a trade's vSol delta must equal its solAmount (fee inside tolerance)
// - a delta far larger than the trade = dropped events in between
// - loss estimate only reported once statistically meaningful

import assert from 'node:assert/strict';
import { ReserveContinuity } from './.feedhealth.mjs';

const SOL = 1_000_000_000n;
const V0 = 30n * SOL; // launch virtual SOL reserves

// First observation of a mint is a baseline, never a verdict.
{
  const c = new ReserveContinuity();
  assert.equal(c.observe('mintA', true, SOL, V0 + SOL), 'first');
  assert.equal(c.snapshot().checked, 0);
  console.log('ok  first observation is baseline-only');
}

// Consistent buy chain: vSol grows by exactly solAmount.
{
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL);
  assert.equal(c.observe('m', true, 2n * SOL, V0 + 3n * SOL), 'ok');
  assert.equal(c.observe('m', false, SOL, V0 + 2n * SOL), 'ok');
  assert.equal(c.snapshot().mismatched, 0);
  console.log('ok  consistent buy/sell chain');
}

// Sell fee rounding sits inside the absolute tolerance (0.05 SOL).
{
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL);
  const fee = 10_000_000n; // 0.01 SOL short of the full delta
  assert.equal(c.observe('m', false, SOL, V0 + fee), 'ok');
  console.log('ok  fee-sized slack tolerated');
}

// The real corruption fingerprint from the tape: a 0.068 SOL buy that moves
// reserves by ~6.8 SOL means events between the two were dropped.
{
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL);
  const r = c.observe('m', true, 68_318_000n, V0 + SOL + 6_792_518_183n);
  assert.equal(r, 'mismatch');
  assert.equal(c.snapshot().mismatched, 1);
  console.log('ok  dropped-event fingerprint flagged');
}

// Loss estimate: null until enough checks, then the measured rate.
{
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL);
  let v = V0 + SOL;
  for (let i = 0; i < 100; i++) {
    v += SOL;
    assert.equal(c.observe('m', true, SOL, v), 'ok');
  }
  assert.equal(c.snapshot().lossPct, null, 'below threshold stays null');
  for (let i = 0; i < 150; i++) {
    if (i % 10 === 0) {
      v += 5n * SOL; // simulate a dropped event: unexplained 4-SOL gap
      assert.equal(c.observe('m', true, SOL, v), 'mismatch');
    } else {
      v += SOL;
      assert.equal(c.observe('m', true, SOL, v), 'ok');
    }
  }
  const s = c.snapshot();
  assert.equal(s.checked, 250);
  assert.equal(s.mismatched, 15);
  assert.equal(s.lossPct, 6);
  console.log('ok  loss estimate gating + rate');
}

// Baseline map is capped: the oldest mint is evicted and re-baselines.
{
  const c = new ReserveContinuity();
  c.observe('evictme', true, SOL, V0 + SOL);
  for (let i = 0; i < 4_100; i++) c.observe(`m${i}`, true, SOL, V0 + SOL);
  assert.equal(c.observe('evictme', true, SOL, V0 + 2n * SOL), 'first');
  console.log('ok  LRU eviction re-baselines');
}

console.log('feedhealth: all tests passed');
