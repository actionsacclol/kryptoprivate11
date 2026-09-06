// Measured rug rules — pure, offline.
//
// Every rate in shared/rugrules.ts is an observed number on a named day, and
// the rule that carries it must fire on exactly the condition it was measured
// on — a threshold drifting by one trade quietly turns "90 % dead" into a
// claim about a different population. Each of the five rules is pinned three
// ways: fires, clears, unknown. The honest-null rule is pinned too: unknown
// never fires and never reads as clear.

import assert from 'node:assert';
import {
  evaluateRugRules,
  rugInputsFromTrades,
  volatilityNotes,
  HIDE_TRADEOFF,
  RUG_RULES,
  RUG_RULES_MEASURED_ON,
} from './.rugrules.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** A fully known, clean launch. Each test perturbs one thing. */
const clean = () => ({
  windowS: 60,
  trades: 12,
  buys: 10,
  sells: 2,
  uniqueBuyers: 8,
  buySol: 4,
  sellSol: 0.5,
  largestBuySol: 1,
  creatorSold: false,
  curveProgress: 0.1,
  creatorLaunches: 3,
  creatorGraduations: 1,
  complete: true,
});

const state = (i, id) => evaluateRugRules(i).states[id];
const flag = (i, id) => evaluateRugRules(i).flags.find((f) => f.id === id);

// ── R1 one_buy_dominates ──────────────────────────────────────────────

test('R1 fires when one buy is ≥ 50 % of SOL bought, clears below', () => {
  assert.equal(state({ ...clean(), buySol: 4, largestBuySol: 2 }, 'one_buy_dominates'), 'fired', 'exactly half');
  assert.equal(state({ ...clean(), buySol: 4, largestBuySol: 1.99 }, 'one_buy_dominates'), 'clear');
});

test('R1 is unknown only when nothing was seen on an incomplete scan', () => {
  assert.equal(state({ ...clean(), trades: 0, buys: 0, buySol: 0, complete: false }, 'one_buy_dominates'), 'unknown');
  assert.equal(state({ ...clean(), trades: 0, buys: 0, buySol: 0, complete: true }, 'one_buy_dominates'), 'clear');
});

// ── R2 sells_over_buys ────────────────────────────────────────────────

test('R2 fires at sells ≥ 1.5× buys, clears below', () => {
  assert.equal(state({ ...clean(), buys: 2, sells: 3 }, 'sells_over_buys'), 'fired');
  assert.equal(state({ ...clean(), buys: 2, sells: 2 }, 'sells_over_buys'), 'clear');
});

test('R2 with no buys: sells alone fire; nothing seen on an incomplete scan is unknown', () => {
  assert.equal(state({ ...clean(), buys: 0, sells: 1 }, 'sells_over_buys'), 'fired');
  assert.equal(state({ ...clean(), trades: 0, buys: 0, sells: 0, complete: false }, 'sells_over_buys'), 'unknown');
});

// ── R3 creator_sold_empty_curve ───────────────────────────────────────

test('R3 fires only when the creator sold AND the curve is < 2 % filled', () => {
  assert.equal(state({ ...clean(), creatorSold: true, curveProgress: 0.01 }, 'creator_sold_empty_curve'), 'fired');
  assert.equal(state({ ...clean(), creatorSold: true, curveProgress: 0.02 }, 'creator_sold_empty_curve'), 'clear');
  assert.equal(state({ ...clean(), creatorSold: false, curveProgress: 0.01 }, 'creator_sold_empty_curve'), 'clear');
});

test('R3 is unknown without the creator or without the curve', () => {
  assert.equal(state({ ...clean(), creatorSold: null, curveProgress: 0.01 }, 'creator_sold_empty_curve'), 'unknown');
  assert.equal(state({ ...clean(), creatorSold: true, curveProgress: null }, 'creator_sold_empty_curve'), 'unknown');
});

// ── R4 few_buyers_big_sol ─────────────────────────────────────────────

test('R4 fires at ≤ 2 buyers with ≥ 3 SOL, clears on either side', () => {
  assert.equal(state({ ...clean(), uniqueBuyers: 2, buySol: 3 }, 'few_buyers_big_sol'), 'fired');
  assert.equal(state({ ...clean(), uniqueBuyers: 3, buySol: 3 }, 'few_buyers_big_sol'), 'clear');
  assert.equal(state({ ...clean(), uniqueBuyers: 2, buySol: 2.99 }, 'few_buyers_big_sol'), 'clear');
});

test('R4 is unknown when an incomplete scan saw nothing', () => {
  assert.equal(state({ ...clean(), trades: 0, uniqueBuyers: 0, buySol: 0, complete: false }, 'few_buyers_big_sol'), 'unknown');
});

// ── R5 factory_creator ────────────────────────────────────────────────

test('R5 fires at ≥ 30 prior launches and zero graduations', () => {
  assert.equal(state({ ...clean(), creatorLaunches: 30, creatorGraduations: 0 }, 'factory_creator'), 'fired');
  assert.equal(state({ ...clean(), creatorLaunches: 29, creatorGraduations: 0 }, 'factory_creator'), 'clear');
  assert.equal(state({ ...clean(), creatorLaunches: 80, creatorGraduations: 1 }, 'factory_creator'), 'clear');
});

test('R5 is unknown without creator history', () => {
  assert.equal(state({ ...clean(), creatorLaunches: null, creatorGraduations: 0 }, 'factory_creator'), 'unknown');
  assert.equal(state({ ...clean(), creatorLaunches: 40, creatorGraduations: null }, 'factory_creator'), 'unknown');
});

// ── Report shape ──────────────────────────────────────────────────────

test('a clean launch fires nothing and hide is false', () => {
  const r = evaluateRugRules(clean());
  assert.equal(r.flags.length, 0);
  assert.equal(r.hide, false);
  assert.equal(r.tradesSeen, 12);
  assert.equal(r.measuredOn, RUG_RULES_MEASURED_ON);
});

test('hide is true for each of R1–R4 alone, and never for R5 alone', () => {
  assert.equal(evaluateRugRules({ ...clean(), largestBuySol: 4 }).hide, true, 'R1');
  assert.equal(evaluateRugRules({ ...clean(), buys: 2, sells: 3 }).hide, true, 'R2');
  assert.equal(evaluateRugRules({ ...clean(), creatorSold: true, curveProgress: 0 }).hide, true, 'R3');
  assert.equal(evaluateRugRules({ ...clean(), uniqueBuyers: 1, buySol: 5 }).hide, true, 'R4');
  const r5 = evaluateRugRules({ ...clean(), creatorLaunches: 50, creatorGraduations: 0 });
  assert.equal(r5.flags.length, 1);
  assert.equal(r5.flags[0].severity, 'warn');
  assert.equal(r5.hide, false, 'R5 warns, never hides');
});

test('an all-unknown launch fires nothing and hide is false — unknown is not clear', () => {
  const r = evaluateRugRules({
    ...clean(),
    trades: 0, buys: 0, sells: 0, uniqueBuyers: 0, buySol: 0, largestBuySol: 0,
    creatorSold: null, curveProgress: null, creatorLaunches: null, creatorGraduations: null, complete: false,
  });
  assert.equal(r.flags.length, 0);
  assert.equal(r.hide, false);
  for (const id of Object.keys(r.states)) assert.equal(r.states[id], 'unknown', id);
});

test('every fired flag carries its n and the measured date in the detail', () => {
  const i = {
    ...clean(),
    largestBuySol: 4, buys: 2, sells: 3, uniqueBuyers: 1, buySol: 5,
    creatorSold: true, curveProgress: 0, creatorLaunches: 50, creatorGraduations: 0,
  };
  const r = evaluateRugRules(i);
  assert.equal(r.flags.length, 5, 'all five fire on this input');
  for (const f of r.flags) {
    const spec = RUG_RULES.find((s) => s.id === f.id);
    assert.ok(f.detail.includes(spec.n.toLocaleString('en-US')), `${f.id} detail names n`);
    assert.ok(f.detail.includes('2026-07-27'), `${f.id} detail names the day`);
    assert.equal(f.n, spec.n);
  }
});

test('a non-60 s window is caveated in the detail; 60 s is not', () => {
  const at30 = evaluateRugRules({ ...clean(), largestBuySol: 4, windowS: 30 });
  assert.match(at30.flags[0].detail, /measured at 60 s; you are seeing it at 30 s/);
  assert.equal(at30.windowS, 30);
  const at60 = evaluateRugRules({ ...clean(), largestBuySol: 4 });
  assert.ok(!/you are seeing it at/.test(at60.flags[0].detail));
});

// ── rugInputsFromTrades ───────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const DEV = 'DEVwa11et';
const tr = (secs, user, sol, isBuy = true) => ({
  slot: 1000 + secs,
  ts: T0 + secs * 1000,
  user,
  isBuy,
  base: sol * 1_000_000,
  sol,
  program: 'pump',
  tx: `tx${user}${secs}`,
});
const base = { creator: DEV, curveProgress: 0.05, creatorLaunches: 1, creatorGraduations: 0, complete: true };

test('inputs freeze at the window: a trade at 61 s is not counted, one at 60 s is', () => {
  const i = rugInputsFromTrades([tr(0, 'a', 1), tr(60, 'b', 1), tr(61, 'c', 5)], base);
  assert.equal(i.trades, 2);
  assert.equal(i.buys, 2);
  assert.equal(i.buySol, 2);
  assert.equal(i.largestBuySol, 1, 'the 5 SOL buy at 61 s is outside the window');
  assert.equal(i.windowS, 60);
});

test('the window is measured from the FIRST trade, whatever order they arrive in', () => {
  const i = rugInputsFromTrades([tr(70, 'c', 1), tr(10, 'a', 1), tr(50, 'b', 1)], base);
  assert.equal(i.trades, 3, '10 s → 70 s spans exactly 60 s');
});

test('a custom window is honoured and reported', () => {
  const i = rugInputsFromTrades([tr(0, 'a', 1), tr(20, 'b', 1), tr(40, 'c', 1)], { ...base, windowS: 30 });
  assert.equal(i.trades, 2);
  assert.equal(i.windowS, 30);
});

test('buyers are counted once each; sellers are not buyers', () => {
  const i = rugInputsFromTrades([tr(0, 'a', 1), tr(1, 'a', 1), tr(2, 'b', 1), tr(3, 'z', 0.5, false)], base);
  assert.equal(i.uniqueBuyers, 2);
  assert.equal(i.buys, 3);
  assert.equal(i.sells, 1);
  assert.equal(i.sellSol, 0.5);
});

test('a creator sell inside the window is detected; one outside it is not', () => {
  const sold = rugInputsFromTrades([tr(0, DEV, 1), tr(5, DEV, 0.5, false)], base);
  assert.equal(sold.creatorSold, true);
  const late = rugInputsFromTrades([tr(0, DEV, 1), tr(65, DEV, 0.5, false)], base);
  assert.equal(late.creatorSold, false);
  const bought = rugInputsFromTrades([tr(0, DEV, 1), tr(5, 'x', 0.5, false)], base);
  assert.equal(bought.creatorSold, false, 'someone else selling is not the creator selling');
});

test('without a creator, creatorSold is null — not false', () => {
  const i = rugInputsFromTrades([tr(0, 'a', 1), tr(5, 'a', 0.5, false)], { ...base, creator: null });
  assert.equal(i.creatorSold, null);
  assert.equal(evaluateRugRules(i).states.creator_sold_empty_curve, 'unknown');
});

test('no trades gives zero counts and passes the other inputs through', () => {
  const i = rugInputsFromTrades([], { ...base, complete: false, curveProgress: null });
  assert.equal(i.trades, 0);
  assert.equal(i.uniqueBuyers, 0);
  assert.equal(i.curveProgress, null);
  assert.equal(i.complete, false);
});

// ── volatilityNotes ───────────────────────────────────────────────────

const ids = (notes) => notes.map((n) => n.id);
const quiet = { top3Pct: 5, bundlePct: 5, sniperPct: 5, creatorHoldsPct: 1, creatorSold: false };

test('top-3 threshold is 25 %', () => {
  assert.deepEqual(ids(volatilityNotes({ ...quiet, top3Pct: 25 })), ['top3']);
  assert.deepEqual(ids(volatilityNotes({ ...quiet, top3Pct: 24.9 })), []);
});

test('bundle threshold is 40 %', () => {
  assert.deepEqual(ids(volatilityNotes({ ...quiet, bundlePct: 40 })), ['bundle']);
  assert.deepEqual(ids(volatilityNotes({ ...quiet, bundlePct: 39.9 })), []);
});

test('sniper threshold is 25 %', () => {
  assert.deepEqual(ids(volatilityNotes({ ...quiet, sniperPct: 25 })), ['sniper']);
  assert.deepEqual(ids(volatilityNotes({ ...quiet, sniperPct: 24.9 })), []);
});

test('creator-holds threshold is 10 %', () => {
  assert.deepEqual(ids(volatilityNotes({ ...quiet, creatorHoldsPct: 10 })), ['creator_holds']);
  assert.deepEqual(ids(volatilityNotes({ ...quiet, creatorHoldsPct: 9.9 })), []);
});

test('creator sold is a note; null inputs produce nothing', () => {
  assert.deepEqual(ids(volatilityNotes({ ...quiet, creatorSold: true })), ['creator_sold']);
  assert.deepEqual(
    ids(volatilityNotes({ top3Pct: null, bundlePct: null, sniperPct: null, creatorHoldsPct: null, creatorSold: null })),
    [],
  );
});

test('every volatility note carries BOTH numbers and states them in the detail', () => {
  const notes = volatilityNotes({ top3Pct: 50, bundlePct: 50, sniperPct: 50, creatorHoldsPct: 50, creatorSold: true });
  assert.equal(notes.length, 5);
  for (const n of notes) {
    assert.ok(n.dumpedPct > 0 && n.gradPct > 0, `${n.id} has both rates`);
    assert.ok(n.detail.includes(`${n.dumpedPct} %`), `${n.id} detail shows the dumped rate`);
    assert.ok(n.detail.includes(`${n.gradPct} %`), `${n.id} detail shows the graduation rate`);
    assert.ok(n.detail.includes(n.n.toLocaleString('en-US')), `${n.id} detail shows n`);
  }
});

// ── The trade-off line ────────────────────────────────────────────────

test('HIDE_TRADEOFF states the graduation cost', () => {
  assert.match(HIDE_TRADEOFF.text, /graduation/i);
  assert.match(HIDE_TRADEOFF.text, /1 in 10/);
  assert.equal(HIDE_TRADEOFF.graduationsHiddenPct, 9.6);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`rugrules: ${passed}/${cases.length} tests passed`);
}

await run();
