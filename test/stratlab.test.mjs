// Strategy Lab tests — tandem multi-strategy shadow runner (swarm-spec v2):
// - zone entries (age × vSol × drawdown cell) with TP/SL exits
// - runner entries on curve crossings with creator gate
// - creatorRecovery: creator-dump trigger → bid-return confirm → entry
// - conditional time-stop (fires only below a gain threshold)
// - graduation is never booked at the completion tick (the #1 backtest
//   poison); it is marked at a real post-migration AMM fill, or left
//   unresolved if the pool never trades
// - entry AND exit fill at the first tick ≥800ms post-trigger

import assert from 'node:assert/strict';
import { StratLab } from './.stratlab.mjs';

const SOL = 1_000_000_000n;
const V_TOK_0 = 900_000_000_000_000n;

function trade(mint, isBuy, vSolSol, nowMs, opts = {}) {
  return {
    mint,
    isBuy,
    user: opts.user ?? 'buyer1',
    solLamports: BigInt(Math.round((opts.sol ?? 0.05) * 1e9)),
    vSol: BigInt(Math.round(vSolSol * 1e9)),
    vTok: V_TOK_0,
    createdAtMs: 0,
    creator: 'creatorX',
    nowMs,
  };
}

const E0 = {
  ageMinS: null, ageMaxS: null, drawdownMin: null, drawdownMax: null, bounceMin: null, bounceMax: null,
  confirmBuys: null, vSolMinSol: null, vSolMaxSol: null, curvePctMin: null, requireNoCreatorSell: false,
  creatorSellMinSol: null, confirmBuyVolSol: null, confirmWindowS: null,
  breakoutOverWindowMax: null, windowRangeMax: null, athOverWindowMax: null, confirmBuySolS: null,
};
const X0 = { stop: null, tp: null, trail: null, trailArm: 0.05, timeoutS: null, timeoutIfBelow: null, exitOnCreatorSell: false };

const ZONE = {
  key: 'zone_test', family: 'zone',
  entry: { ...E0, ageMinS: 1800, ageMaxS: 3600, vSolMinSol: 55, vSolMaxSol: 80, drawdownMin: 0.25, drawdownMax: 0.5 },
  exit: { ...X0, stop: 0.35, tp: 1.6, timeoutS: 600 },
  oncePerMint: true, cooldownS: 0,
};

// Zone entry → latency fill → take-profit → latency fill; oncePerMint blocks re-entry.
{
  const lab = new StratLab([ZONE]);
  lab.observe(trade('m', true, 100, 10_000)); // price peak, age too young
  let ev = lab.observe(trade('m', true, 70, 2_000_000)); // dd 30%, vSol 70, age 2000s → trigger
  assert.equal(ev.length, 0, 'trigger emits nothing — buy in flight');
  ev = lab.observe(trade('m', true, 70, 2_001_000)); // fill
  assert.equal(ev.length, 1, 'entry signal');
  assert.equal(ev[0].strat, 'zone_test');
  assert.equal(ev[0].detail.entrySlipPct, 0);
  ev = lab.observe(trade('m', true, 112, 2_010_000)); // 1.6x → TP trigger
  assert.equal(ev.length, 0);
  ev = lab.observe(trade('m', true, 112, 2_011_000)); // fill
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.reason, 'take_profit');
  assert.ok(ev[0].detail.pnlSol > 0.02, 'TP round trip strongly positive');
  // Re-enter attempt: still in the cell, but oncePerMint → dead.
  ev = lab.observe(trade('m', true, 75, 2_100_000));
  ev = ev.concat(lab.observe(trade('m', true, 75, 2_101_000)));
  assert.equal(ev.length, 0, 'oncePerMint blocks re-entry');
  const st = lab.stats()[0];
  assert.equal(st.trades, 1);
  assert.equal(st.wins, 1);
  console.log('ok  zone entry → TP exit → oncePerMint');
}

// Runner: 70% curve crossing with fractional vSol floor + no-creator-sell gate.
{
  const RUNNER = {
    key: 'runner_test', family: 'runner',
    entry: { ...E0, curvePctMin: 70, vSolMinSol: 89.5, confirmBuys: 1, requireNoCreatorSell: true },
    exit: { ...X0, stop: 0.2, tp: 1.2 },
    oncePerMint: true, cooldownS: 0,
  };
  const lab = new StratLab([RUNNER]);
  lab.observe(trade('m', true, 85, 1_000)); // below 70%
  let ev = lab.observe(trade('m', true, 90, 2_000)); // crosses 70% (89.5 floor ok)
  assert.equal(ev.length, 0);
  ev = lab.observe(trade('m', true, 90, 3_000)); // fill
  assert.equal(ev.length, 1);
  assert.equal(ev[0].strat, 'runner_test');
  // Creator-sold variant never enters.
  const lab2 = new StratLab([RUNNER]);
  lab2.observe(trade('m', true, 85, 1_000));
  lab2.observe(trade('m', false, 84, 1_500, { user: 'creatorX' })); // creator sells
  lab2.observe(trade('m', true, 90, 2_000));
  const ev2 = lab2.observe(trade('m', true, 90, 3_000));
  assert.equal(ev2.length, 0, 'creator sell blocks runner entry');
  console.log('ok  runner crossing + creator gate');
}

// creatorRecovery: dump → bid confirm (vol + distinct buyers) → entry;
// a later creator sell forces the exit.
{
  const REC = {
    key: 'rec_test', family: 'creatorRecovery',
    entry: { ...E0, ageMinS: 120, vSolMinSol: 32, creatorSellMinSol: 0.25, confirmBuyVolSol: 0.2, confirmBuys: 2, confirmWindowS: 60 },
    exit: { ...X0, stop: 0.12, tp: 1.12, timeoutS: 90, timeoutIfBelow: 0.03, exitOnCreatorSell: true },
    oncePerMint: false, cooldownS: 120,
  };
  const lab = new StratLab([REC]);
  lab.observe(trade('m', true, 40, 1_000));
  lab.observe(trade('m', false, 39, 130_000, { user: 'creatorX', sol: 0.3 })); // creator dumps ≥0.25
  lab.observe(trade('m', true, 39.5, 135_000, { user: 'A', sol: 0.15 }));
  let ev = lab.observe(trade('m', true, 40, 140_000, { user: 'B', sol: 0.1 })); // vol 0.25, 2 buyers → trigger
  assert.equal(ev.length, 0, 'confirm tick triggers, buy in flight');
  ev = lab.observe(trade('m', true, 40, 141_000));
  assert.equal(ev.length, 1, 'entry after bid confirmation');
  assert.equal(ev[0].detail.confirmBuyers, 2);
  ev = lab.observe(trade('m', false, 40, 150_000, { user: 'creatorX', sol: 0.3 })); // creator sells again
  assert.equal(ev.length, 0, 'exit trigger, sell in flight');
  ev = lab.observe(trade('m', false, 39, 151_000));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.reason, 'creator_sell');
  console.log('ok  creatorRecovery confirm entry + creator-sell exit');
}

// Conditional time-stop: no timeout while gain ≥ threshold; fires below it.
{
  const REC = {
    key: 'cond_test', family: 'zone',
    entry: { ...E0, ageMinS: 100, vSolMinSol: 30, drawdownMin: 0.2 },
    exit: { ...X0, timeoutS: 90, timeoutIfBelow: 0.03 },
    oncePerMint: true, cooldownS: 0,
  };
  const lab = new StratLab([REC]);
  lab.observe(trade('m', true, 100, 1_000)); // peak
  lab.observe(trade('m', true, 70, 200_000)); // dd 30% → trigger
  let ev = lab.observe(trade('m', true, 70, 201_000)); // entry fill @70
  assert.equal(ev.length, 1);
  ev = lab.observe(trade('m', true, 74, 295_000)); // t+94s but gain 5.7% ≥ 3% → no timeout
  assert.equal(ev.length, 0, 'timeout suppressed while in profit');
  ev = lab.observe(trade('m', true, 71, 300_000)); // gain 1.4% < 3% → timeout triggers
  assert.equal(ev.length, 0);
  ev = lab.observe(trade('m', true, 71, 301_000)); // fill
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.reason, 'timeout');
  console.log('ok  conditional time-stop');
}

// Graduation while holding → never booked at the completion tick; the
// position waits in 'migrated' for a real post-migration AMM fill.
function holdThroughGraduation(lab) {
  lab.observe(trade('m', true, 100, 10_000));
  lab.observe(trade('m', true, 70, 2_000_000));
  const ev = lab.observe(trade('m', true, 70, 2_001_000)); // entry fill
  assert.equal(ev.length, 1);
  const entryPrice = ev[0].detail.entryPrice;
  const g = lab.onComplete('m', 2_050_000);
  assert.equal(g.length, 0, 'completion tick emits nothing — it cannot execute');
  const st = lab.stats()[0];
  assert.equal(st.trades, 0, 'graduation is NOT booked at completion');
  assert.equal(st.graduated, 1);
  assert.equal(st.open, 1, 'still an open position, awaiting its mark');
  return entryPrice;
}

// A trade inside the mark window only updates the mark; the first trade past
// it closes the position at that mark.
{
  const lab = new StratLab([ZONE]);
  const entryPrice = holdThroughGraduation(lab);

  let g = lab.onAmmTrade('m', entryPrice * 2, 2_060_000); // +10s: inside window
  assert.equal(g.length, 0, 'inside the mark window: record the mark, do not book');
  assert.equal(lab.stats()[0].trades, 0);

  g = lab.onAmmTrade('m', entryPrice * 0.5, 2_200_000); // +150s: past window
  assert.equal(g.length, 1);
  assert.equal(g[0].detail.reason, 'graduated');
  assert.equal(g[0].detail.resolved, true);
  assert.equal(g[0].detail.markPriceSol, entryPrice * 2, 'books the in-window mark, not the late tick');
  assert.ok(g[0].detail.pnlSol > 0, 'marked at 2x entry → profitable');

  const st = lab.stats()[0];
  assert.equal(st.trades, 1, 'now a realized trade');
  assert.equal(st.wins, 1);
  assert.equal(st.open, 0);
  console.log('ok  graduation marked at in-window AMM price');
}

// No trade inside the window: the first trade after it is the fill.
{
  const lab = new StratLab([ZONE]);
  const entryPrice = holdThroughGraduation(lab);
  const g = lab.onAmmTrade('m', entryPrice * 0.4, 2_400_000);
  assert.equal(g.length, 1);
  assert.equal(g[0].detail.markPriceSol, entryPrice * 0.4);
  assert.ok(g[0].detail.pnlSol < 0, 'marked below entry → a loss, booked honestly');
  assert.equal(lab.stats()[0].trades, 1);
  assert.equal(lab.stats()[0].wins, 0);
  console.log('ok  graduation with no in-window trade marks at first later fill');
}

// Pool never trades → falls back to the honest unresolved record, unbooked.
{
  const lab = new StratLab([ZONE]);
  holdThroughGraduation(lab);
  assert.equal(lab.sweepMigrated(2_100_000).length, 0, 'not yet past the resolve timeout');
  const g = lab.sweepMigrated(2_050_000 + 11 * 60_000);
  assert.equal(g.length, 1);
  assert.equal(g[0].detail.reason, 'graduated');
  assert.equal(g[0].detail.unresolved, true);
  assert.equal(g[0].detail.pnlSol, undefined, 'nothing invented');
  const st = lab.stats()[0];
  assert.equal(st.trades, 0, 'timeout must not book a trade');
  assert.equal(st.open, 0, 'but the slot is released');
  console.log('ok  graduation with no AMM trade at all → unresolved, unbooked');
}

// A stray curve tick after completion must not touch a migrated position.
{
  const lab = new StratLab([ZONE]);
  holdThroughGraduation(lab);
  const ev = lab.observe(trade('m', true, 5, 2_060_000)); // would be a huge loss
  assert.equal(ev.length, 0, 'curve ticks cannot settle a migrated position');
  assert.equal(lab.stats()[0].trades, 0);
  console.log('ok  post-completion curve ticks ignored');
}

console.log('stratlab: all tests passed');
