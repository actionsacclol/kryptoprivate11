// Honest-fill paper book: entries and exits book at post-latency reserves;
// live-sell hook (onExitTriggered) fires at TRIGGER time, not fill time.
import assert from 'node:assert/strict';
import { PositionManager } from './.positions.mjs';

const ok = (name) => console.log(`ok  ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETTINGS = {
  positionSizeSol: 0.05,
  maxOpenPositions: 3,
  stopLossPct: 0.35,
  takeProfit1Pct: 0.6,
  takeProfit2Pct: 1.5,
  trailingPct: 0.25,
  timeStopSec: 90,
  exitOnCreatorSell: true,
  exitOnFlowReversal: true,
};

function makeMarket() {
  return {
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000n,
    recentBuyVolSol: 0,
    recentSellVolSol: 0,
    creatorSold: false,
    curveComplete: false,
  };
}

{
  // Entry books at post-latency reserves, not decision-time reserves.
  const m = makeMarket();
  const events = [];
  const pm = new PositionManager(
    () => SETTINGS,
    () => m,
    {
      onOpen: () => events.push('open'),
      onUpdate: () => {},
      onClose: () => events.push('close'),
      onExitTriggered: (_p, reason) => events.push(`trigger:${reason}`),
    },
  );
  const p = pm.open('MINT1', 'Test', 'TST');
  assert.ok(p);
  assert.equal(p.tokenAmount, 0); // nothing booked yet
  pm.tick();
  assert.equal(p.tokenAmount, 0); // still inside the latency window

  // Price doubles before our fill lands (vSol up ~41%, vTok down):
  m.virtualSolReserves = 42_430_000_000n;
  m.virtualTokenReserves = 758_800_000_000_000n;
  await sleep(850);
  pm.tick();
  assert.ok(p.tokenAmount > 0, 'entry filled after latency');
  const spotAtFill = Number(m.virtualSolReserves) / 1e9 / (Number(m.virtualTokenReserves) / 1e6);
  // Fill price reflects the RUN-UP reserves (worse than decision-time),
  // within fee+impact of the fill-time spot.
  assert.ok(p.entryPriceSol > spotAtFill, 'entry price includes fee+impact above fill-time spot');
  assert.ok(p.entryPriceSol < spotAtFill * 1.1, 'but within ~10% of fill-time spot');
  ok('entry fills at post-latency reserves (run-up priced in)');
}

{
  // Exit trigger: hook fires immediately, book fills at post-latency
  // (crashed) reserves — the honest fill is far below the trigger price.
  const m = makeMarket();
  let triggeredAt = 0;
  let closedAt = 0;
  let closedPnlSol = null;
  const pm = new PositionManager(
    () => SETTINGS,
    () => m,
    {
      onOpen: () => {},
      onUpdate: () => {},
      onClose: (p) => {
        closedAt = Date.now();
        closedPnlSol = p.pnlSol;
      },
      onExitTriggered: () => {
        triggeredAt = Date.now();
      },
    },
  );
  const p = pm.open('MINT2', 'Rug', 'RUG');
  await sleep(850);
  pm.tick(); // entry fills

  m.creatorSold = true; // creator dumps → exit trigger
  pm.tick();
  assert.ok(triggeredAt > 0, 'live-sell hook fired at trigger time');
  assert.equal(closedAt, 0, 'paper close has NOT booked yet');
  assert.equal(p.state, 'open'); // exit pending, not closed

  // The dump: price collapses 60% before our paper sell can land.
  m.virtualSolReserves = 18_000_000_000n;
  m.virtualTokenReserves = 1_788_300_000_000_000n;
  await sleep(850);
  pm.tick();
  assert.ok(closedAt > 0, 'paper close booked after latency');
  assert.ok(closedAt - triggeredAt >= 750, 'fill lagged the trigger');
  assert.equal(p.exitReason, 'creator_sell');
  // Honest accounting: the loss reflects the crashed fill, roughly -40%
  // (price −60% cushioned by our own buy-side impact), not trigger-price.
  assert.ok(closedPnlSol < -0.05 * 0.3, `loss books the crash (got ${closedPnlSol})`);
  ok('exit: hook at trigger, book at crashed post-latency reserves');
}

{
  // killAll books immediately (engine stopping) and still fires the hook.
  const m = makeMarket();
  const triggers = [];
  const pm = new PositionManager(
    () => SETTINGS,
    () => m,
    {
      onOpen: () => {},
      onUpdate: () => {},
      onClose: () => {},
      onExitTriggered: (_p, reason) => triggers.push(reason),
    },
  );
  const p = pm.open('MINT3', 'Halt', 'HLT');
  await sleep(850);
  pm.tick();
  pm.killAll('engine_stopped');
  assert.equal(p.state, 'closed');
  assert.deepEqual(triggers, ['engine_stopped']);
  ok('killAll closes immediately and fires the live hook once');
}

console.log('positions: all tests passed');
