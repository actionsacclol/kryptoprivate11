// Feed-health (reserve continuity) tests — the live version of the tape
// analysis that measured ~20% websocket event loss:
// - a trade's vSol delta must equal its solAmount (fee inside tolerance)
// - a delta far larger than the trade = dropped events in between
// - loss estimate only reported once statistically meaningful

import assert from 'node:assert/strict';
import { ReserveContinuity, curveFeedIsTicking, CURVE_TICK_FRESH_MS } from './.feedhealth.mjs';

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

// ── Out-of-order arrivals are not losses ──────────────────────────────
//
// This check compares a trade against the LAST one seen for its mint, which
// is only a loss test if the two arrived in chain order. Nothing guarantees
// that: the feed races several sockets and takes whichever delivers a
// signature first, the block standby runs ~200 ms behind, and the priority
// socket runs ~150 ms ahead for held mints. Every inversion used to fail the
// reserve test exactly like a dropped event, so the racing pool working well
// inflated the "feed losing ~N% of events" warning it feeds.

{
  const c = new ReserveContinuity();
  // Two clean trades, in order, at rising slots.
  assert.equal(c.observe('m', true, SOL, V0 + SOL, 100), 'first');
  assert.equal(c.observe('m', true, SOL, V0 + 2n * SOL, 101), 'ok');
  // Now the slow socket's copy of an EARLIER trade turns up. Its reserves
  // disagree with where the mint has got to — but we HAVE that trade, so it
  // is not loss.
  assert.equal(c.observe('m', true, SOL, V0 + SOL, 100), 'stale');
  const s = c.snapshot();
  assert.equal(s.mismatched, 0, 'a late arrival is not a dropped event');
  assert.equal(s.stale, 1);
  assert.equal(s.checked, 1, 'and it does not pad the denominator either');
  console.log('ok  a provably late arrival is skipped, not counted as loss');
}

{
  // ...and it must not become the baseline. The next real trade continues
  // from where the mint actually is.
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL, 100);
  c.observe('m', true, SOL, V0 + 2n * SOL, 101);
  c.observe('m', true, SOL, V0 + SOL, 100); // stale
  assert.equal(c.observe('m', true, SOL, V0 + 3n * SOL, 102), 'ok', 'the stale view did not rewind the baseline');
  assert.equal(c.snapshot().mismatched, 0);
  console.log('ok  a stale arrival does not rewind the baseline');
}

{
  // Real loss still reads as loss. Over-suppressing would be worse than the
  // bug: a warning that never fires.
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL, 100);
  // Slot moves FORWARD and the reserves jumped far more than this trade —
  // events in between were dropped.
  assert.equal(c.observe('m', true, SOL, V0 + 9n * SOL, 105), 'mismatch');
  assert.equal(c.snapshot().mismatched, 1);
  console.log('ok  a genuine gap at a newer slot still counts as loss');
}

{
  // Same slot is still checked: the true order inside a slot is the
  // transaction index and we do not have it, so suppressing would hide real
  // loss on exactly the hottest mints.
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL, 100);
  assert.equal(c.observe('m', true, SOL, V0 + 9n * SOL, 100), 'mismatch');
  console.log('ok  trades sharing a slot are still checked');
}

{
  // A feed with no slot information behaves exactly as before.
  const c = new ReserveContinuity();
  c.observe('m', true, SOL, V0 + SOL);
  assert.equal(c.observe('m', true, SOL, V0 + 2n * SOL), 'ok');
  assert.equal(c.observe('m', true, SOL, V0 + 9n * SOL), 'mismatch');
  assert.equal(c.snapshot().stale, 0);
  console.log('ok  with no slot, the check is unchanged');
}

// ── Per-mint feed liveness: what the orders poller may skip ───────────
//
// The bug (user report, 2026-09-13): a trailing stop froze its peak at the
// moment its token graduated and never fired. The orders poller had skipped
// the mint because it was in the launch tracker, while the curve feed had
// stopped carrying it because it had migrated to pump-amm. Nothing evaluated
// the order at all. These pin the three facts that make up the real test,
// and — most importantly — that launch-list membership alone is NOT one.

const NOW = 1_700_000_000_000;
const live = (over = {}) => curveFeedIsTicking({
  tracked: true, curveComplete: false, lastTickAt: NOW - 1_000, now: NOW, ...over,
});

{
  assert.equal(live(), true, 'tracked, on its curve, trading a second ago');
  console.log('ok  a mint the feed is actually carrying is skipped by the poller');
}

// THE REGRESSION. A graduated token stays in the launch tracker for as long
// as it is inside LAUNCH_LIST_CAP, and its last curve tick can be seconds
// old — every input except `curveComplete` says "live". If this ever returns
// true again, every armed order on every graduating token goes blind.
{
  assert.equal(
    live({ curveComplete: true }),
    false,
    'graduated: still tracked, ticked a second ago — but the curve feed will never carry it again',
  );
  console.log('ok  GRADUATION hands the mint back to the poller');
}

{
  assert.equal(live({ lastTickAt: NOW - CURVE_TICK_FRESH_MS - 1 }), false, 'feed went quiet');
  assert.equal(live({ lastTickAt: NOW - CURVE_TICK_FRESH_MS + 1 }), true, 'just inside the window');
  console.log('ok  a feed that goes quiet hands the mint back');
}

{
  assert.equal(live({ tracked: false }), false, 'evicted past the launch cap');
  assert.equal(live({ lastTickAt: null }), false, 'tracked but never seen trading');
  console.log('ok  never-ticked and evicted mints are polled');
}

// Every uncertain case must answer false: false costs one slot in a batched
// price call, true costs the position.
{
  for (const over of [
    { tracked: false }, { curveComplete: true }, { lastTickAt: null },
    { lastTickAt: NOW - 60_000 }, { tracked: false, curveComplete: true },
  ]) assert.equal(live(over), false);
  console.log('ok  every uncertain case fails toward polling, never toward silence');
}

console.log('feedhealth: all tests passed');
