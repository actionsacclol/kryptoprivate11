// Dip-buy shadow detector tests — the state machine that measures the one
// strategy family that survived the tape analysis:
// - does not arm before the token is old enough / crashed enough
// - arms on a >50% drawdown past 45s, confirms on a 3-buy 15% bounce
// - only enters with real liquidity left in the curve
// - v2: entry AND exits fill at the first tick ≥800ms after their trigger,
//   at that tick's reserves (no fill-at-trigger mirage), and each entry runs
//   the full exit-variant matrix in parallel (one tagged exit per variant)

import assert from 'node:assert/strict';
import { DipShadow } from './.dipshadow.mjs';

const SOL = 1_000_000_000n;
const V_SOL_0 = 40n * SOL; // ~10 real SOL in the curve
const V_TOK_0 = 900_000_000_000_000n;

// A trade at given reserves; price = vSol/vTok so we drive price via reserves.
function trade(mint, isBuy, vSol, vTok, createdAtMs, nowMs) {
  return { mint, isBuy, vSol, vTok, createdAtMs, nowMs };
}

// Drive a fresh detector through peak → crash → 3-buy bounce; the entry
// TRIGGERS at t=64s and FILLS on the next tick the caller sends (≥800ms later).
function primeToEntryTrigger(d, mint = 'm') {
  d.observe(trade(mint, true, 80n * SOL, V_TOK_0, 0, 1_000)); // peak
  d.observe(trade(mint, false, 32n * SOL, V_TOK_0, 0, 60_000)); // -60% at 60s → arm
  d.observe(trade(mint, false, 32n * SOL, V_TOK_0, 0, 61_000)); // low
  d.observe(trade(mint, true, 34n * SOL, V_TOK_0, 0, 62_000)); // buy 1
  d.observe(trade(mint, true, 36n * SOL, V_TOK_0, 0, 63_000)); // buy 2
  const ev = d.observe(trade(mint, true, 40n * SOL, V_TOK_0, 0, 64_000)); // buy 3, +25% off low → trigger
  assert.equal(ev.length, 0, 'trigger emits nothing — the buy is in flight');
  return d;
}

// No arm before MIN_AGE even with a deep crash.
{
  const d = new DipShadow();
  d.observe(trade('m', true, V_SOL_0, V_TOK_0, 0, 1000)); // peak
  const ev = d.observe(trade('m', false, V_SOL_0 / 4n, V_TOK_0, 0, 20_000)); // -75% but only 20s old
  assert.equal(ev.length, 0);
  assert.equal(d.stats().open, 0);
  console.log('ok  no arm before min age');
}

// Full happy path with latency: trigger → latency fill → rip → trail exits
// fire per-variant, each filling one tick after its own trigger.
{
  const d = primeToEntryTrigger(new DipShadow());
  // First tick ≥800ms after the 64s trigger fills the entry at ITS reserves.
  let ev = d.observe(trade('m', true, 40n * SOL, V_TOK_0, 0, 65_000));
  assert.equal(ev.length, 1, 'entry fill emits the signal');
  assert.equal(ev[0].kind, 'signal');
  assert.equal(ev[0].detail.entrySlipPct, 0, 'same reserves → no slip');
  assert.equal(ev[0].detail.fillDelayMs, 1000);
  assert.equal(d.stats().open, 1);
  // Rip up +50% (arms every trail), then fall 26.7% off the hold peak →
  // ALL variants trigger trailing (trail 10/15/25 all exceeded, no stop hit).
  d.observe(trade('m', true, 60n * SOL, V_TOK_0, 0, 70_000));
  ev = d.observe(trade('m', false, 44n * SOL, V_TOK_0, 0, 75_000));
  assert.equal(ev.length, 0, 'exit triggers emit nothing — sells in flight');
  ev = d.observe(trade('m', false, 44n * SOL, V_TOK_0, 0, 76_000)); // fill tick
  assert.equal(ev.length, 4, 'one exit per variant');
  for (const e of ev) {
    assert.equal(e.kind, 'exit');
    assert.equal(e.detail.reason, 'trailing');
    assert.equal(e.detail.exitSlipPct, 0);
  }
  const keys = ev.map((e) => e.detail.variant).sort();
  assert.deepEqual(keys, ['trail10_sl15_t180', 'trail15_sl25_t180', 'trail15_sl25_t600', 'trail25_sl35_t600'].sort());
  assert.equal(d.stats().open, 0);
  assert.equal(d.stats().trades, 1, 'baseline variant alone feeds stats');
  console.log('ok  peak→crash→bounce→latency fill→per-variant trailing exits');
}

// Stop-loss: -30% off entry trips sl15 and both sl25 variants but NOT sl35;
// the survivor keeps holding.
{
  const d = primeToEntryTrigger(new DipShadow());
  d.observe(trade('m', true, 40n * SOL, V_TOK_0, 0, 65_000)); // entry fill @40
  let ev = d.observe(trade('m', false, 28n * SOL, V_TOK_0, 0, 66_000)); // -30% → 3 triggers
  assert.equal(ev.length, 0, 'stop triggers, fill pending');
  ev = d.observe(trade('m', false, 28n * SOL, V_TOK_0, 0, 67_000)); // fill tick
  assert.equal(ev.length, 3, 'sl15 + two sl25 variants exit; sl35 holds');
  for (const e of ev) assert.equal(e.detail.reason, 'stop_loss');
  assert.ok(!ev.some((e) => e.detail.variant === 'trail25_sl35_t600'));
  assert.equal(d.stats().open, 1, 'sl35 variant still holding');
  assert.equal(d.stats().trades, 1, 'baseline exit already booked');
  console.log('ok  stop-loss exits per-variant, loose variant survives');
}

// Entry slippage is measured: fill tick at higher reserves → positive slip,
// and the worse entry is what the round-trip books against.
{
  const d = primeToEntryTrigger(new DipShadow());
  const ev = d.observe(trade('m', true, 44n * SOL, V_TOK_0, 0, 65_000)); // bounce ran on during our 800ms
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.entrySlipPct, 10, 'paid 10% above trigger price');
  console.log('ok  entry slippage measured at fill tick');
}

// Silent tape past the abandon window → entry abandoned, recorded as such.
{
  const d = primeToEntryTrigger(new DipShadow());
  const ev = d.observe(trade('m', false, 40n * SOL, V_TOK_0, 0, 64_000 + 31_000));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'signal');
  assert.equal(ev[0].detail.abandoned, true);
  assert.equal(d.stats().open, 0);
  console.log('ok  silent tape abandons the entry');
}

// No entry when curve liquidity is below the floor at bounce time.
{
  const d = new DipShadow();
  d.observe(trade('m', true, 80n * SOL, V_TOK_0, 0, 1_000));
  d.observe(trade('m', false, 31n * SOL, V_TOK_0, 0, 60_000)); // arm but below 32 SOL floor
  d.observe(trade('m', false, 31n * SOL, V_TOK_0, 0, 61_000));
  d.observe(trade('m', true, 31n * SOL + SOL / 2n, V_TOK_0, 0, 62_000));
  d.observe(trade('m', true, 31n * SOL + SOL, V_TOK_0, 0, 63_000));
  d.observe(trade('m', true, 31n * SOL + 2n * SOL, V_TOK_0, 0, 64_000)); // bounce, but <32 SOL
  const ev = d.observe(trade('m', true, 31n * SOL + 2n * SOL, V_TOK_0, 0, 65_000)); // would be the fill tick
  assert.equal(ev.length, 0, 'liquidity floor blocks entry');
  assert.equal(d.stats().open, 0);
  console.log('ok  liquidity floor blocks thin entries');
}

console.log('dipshadow: all tests passed');
