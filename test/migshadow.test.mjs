// Migration-block shadow tests — the paper runner for the big-balance
// migration strategy (docs/migration-block-scope-2026-07-25.md):
// - mig_signal carries the 95%-crossing lead time (the decisive discriminator)
// - lanes fill at the observed pool state AFTER every trade that beat them in
//   (arrivalPos), never at their trigger time's future state
// - the 5% slippage cap converts lost races into recorded free aborts
// - exits sell at the hold-deadline state, BEFORE the deadline-crossing swap
// - quiet pools resolve via sweep: holding lanes close at last state, pending
//   lanes book as no-fills — nothing sits open forever

import assert from 'node:assert/strict';
import { MigShadow } from './.migshadow.mjs';

const SOL = 1_000_000_000n;
const B0 = 206_900_000_000_000n; // standard migration seed: 206.9M tokens
const Q0 = 85n * SOL;

function swap(pool, isBuy, quoteSol, { first = false, baseAmount = 1n } = {}) {
  return {
    kind: 'amm_swap',
    isBuy,
    quoteAmount: BigInt(Math.round(quoteSol * 1e9)),
    baseAmount,
    // Only the FIRST swap's pre-trade reserves may be read (they seed the
    // replay). Zeros afterwards make an accidental re-seed fail loudly.
    poolBaseReserves: first ? B0 : 0n,
    poolQuoteReserves: first ? Q0 : 0n,
    pool,
  };
}

// Signal carries lead time from the 95% crossing.
{
  const m = new MigShadow();
  m.onCurveTrade('mintA', 111n * SOL, 1000); // ≥95% curve progress
  const ev = m.onMigration('mintA', 'poolA', 1300);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'signal');
  assert.equal(ev[0].detail.leadMs, 300);
}

// No crossing observed → leadMs null; below-threshold ticks don't arm it.
{
  const m = new MigShadow();
  m.onCurveTrade('mintB', 100n * SOL, 500); // ~82% — below the 95% clock
  const ev = m.onMigration('mintB', 'poolB', 2000);
  assert.equal(ev[0].detail.leadMs, null);
}

// The core scenario: block0 fills at the seed (position 1), react400 fills
// one trade later (position 2), react800 loses the race and is saved by the
// slippage cap; the two fills exit at the hold deadline in profit.
{
  const m = new MigShadow();
  m.onCurveTrade('mintC', 111n * SOL, 900);
  m.onMigration('mintC', 'poolC', 1300); // lanes land at 1300 / 1700 / 2100

  // First observed trade arrives at t=1500: block0 (landed 1300) fills at the
  // untouched seed before this trade applies.
  let ev = m.onAmmSwap(swap('poolC', true, 1, { first: true }), 1500);
  assert.equal(ev.length, 0, 'fills are silent until exit');

  // t=1800: react400 fills at the post-trade-1 state — arrival position 2,
  // price moved (86/85)² − 1 ≈ +2.4%, inside the 5% cap.
  ev = m.onAmmSwap(swap('poolC', true, 2), 1800);
  assert.equal(ev.length, 0);

  // t=2500: react800 lands after two buys — price is now ≈ +7.2% off seed,
  // past the cap → free abort, recorded.
  ev = m.onAmmSwap(swap('poolC', true, 0.1), 2500);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.lane, 'react800');
  assert.equal(ev[0].detail.outcome, 'abort_slippage');
  assert.equal(ev[0].detail.arrivalPos, 2);
  assert.ok(ev[0].detail.movedPct > 0.05);
  assert.equal(ev[0].detail.pnlSol, undefined, 'aborts book no P&L');

  // t=7000: past both hold deadlines (6300 / 6700) — both close BEFORE this
  // swap applies, at the pumped pool state → positive P&L for block0.
  ev = m.onAmmSwap(swap('poolC', false, 0.05, { baseAmount: 1_000_000n }), 7000);
  assert.equal(ev.length, 2);
  const byLane = Object.fromEntries(ev.map((e) => [e.detail.lane, e.detail]));
  assert.equal(byLane.block0.outcome, 'filled');
  assert.equal(byLane.block0.arrivalPos, 0);
  assert.equal(byLane.block0.exitReason, 'hold');
  assert.ok(byLane.block0.pnlSol > 0, `block0 should profit on a pumped pool, got ${byLane.block0.pnlSol}`);
  assert.equal(byLane.react400.arrivalPos, 1);
  assert.ok(byLane.react400.pnlSol < byLane.block0.pnlSol, 'later arrival cannot beat position 1 on the same path');
  assert.equal(byLane.block0.leadMs, 400);

  const st = Object.fromEntries(m.stats().map((s) => [s.lane, s]));
  assert.equal(st.block0.fills, 1);
  assert.equal(st.react800.aborts, 1);
  assert.equal(st.block0.open, 0);
}

// Quiet pool: one early trade, then silence. Sweep closes the filled lane at
// its last state and books the never-landed lanes as no-fills.
{
  const m = new MigShadow();
  m.onMigration('mintD', 'poolD', 0);
  m.onAmmSwap(swap('poolD', true, 0.5, { first: true }), 100); // seeds; block0 fills
  const ev = m.sweep(120_001);
  assert.equal(ev.length, 3);
  const byLane = Object.fromEntries(ev.map((e) => [e.detail.lane, e.detail]));
  assert.equal(byLane.block0.outcome, 'filled');
  assert.equal(byLane.block0.exitReason, 'sweep');
  assert.equal(byLane.react400.outcome, 'no_fill');
  assert.equal(byLane.react800.outcome, 'no_fill');
  assert.equal(m.sweep(240_000).length, 0, 'watch is gone after sweep');
}

// Pool that never trades: everything resolves as no_trades.
{
  const m = new MigShadow();
  m.onMigration('mintE', 'poolE', 0);
  const ev = m.sweep(120_001);
  assert.equal(ev.length, 3);
  for (const e of ev) assert.equal(e.detail.outcome, 'no_trades');
}

// Swaps on unwatched pools are ignored.
{
  const m = new MigShadow();
  assert.equal(m.onAmmSwap(swap('poolZ', true, 1, { first: true }), 500).length, 0);
}

console.log('migshadow.test.mjs: all tests passed');
