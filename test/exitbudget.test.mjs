// An exit must fit the wallet. This is the rule that would have prevented a
// real position being unsellable on 2026-09-05: the sell path asked for a
// 0.002 SOL priority fee, the wallet held 0.00167, and the transaction could
// not even be loaded.
import assert from 'node:assert';
import { BASE_FEE_LAMPORTS, LEAN_EXIT_LAMPORTS, explainFeeFailure, planExitBudget, planBuySize, UNATTENDED_MIN_FILL_SHARE, roundTripFeeShare, minUnattendedBuySol, shouldHoldAsDust, leanPriorityFeeSol, leanExec, laneRoundTripPrioritySol, LEAN_MIN_MICRO_PER_CU, LEAN_MAX_MICRO_PER_CU, FEE_LANES, paperFixedFeeSol } from './.exitbudget.mjs';

const SOL = 1e9;

{
  // The case from the log.
  const b = planExitBudget(0.00167515 * SOL, 0.002 * SOL);
  assert.equal(b.hopeless, false, 'it can still pay the base fee, so the sell can go out');
  assert.ok(b.priorityLamports < 0.002 * SOL, 'the priority fee is cut to fit');
  assert.ok(b.priorityLamports + BASE_FEE_LAMPORTS <= 0.00167515 * SOL, 'and what is paid is affordable');
  assert.equal(b.useTips, false, 'tips are dropped when SOL is short');
  assert.match(b.note, /low SOL/);
  console.log('ok  the wallet that could not sell now can');
}

{
  // A healthy wallet is untouched: this must never make a good exit worse.
  const b = planExitBudget(2 * SOL, 0.002 * SOL);
  assert.equal(b.priorityLamports, 0.002 * SOL, 'pays exactly what was asked');
  assert.equal(b.useTips, true);
  assert.equal(b.note, null, 'and says nothing');
  console.log('ok  a funded wallet pays the full priority fee and keeps its tips');
}

{
  // Right at the lean threshold.
  const rich = planExitBudget(LEAN_EXIT_LAMPORTS, 1_000);
  assert.equal(rich.useTips, true, 'at the threshold the exit is still fully equipped');
  const lean = planExitBudget(LEAN_EXIT_LAMPORTS - 1, 1_000);
  assert.equal(lean.useTips, false, 'one lamport below it goes lean');
  assert.equal(lean.priorityLamports, 1_000, 'but still pays what it can afford');
  console.log('ok  the lean threshold is a clean line');
}

{
  // Nothing left at all: say so rather than pretending.
  const b = planExitBudget(3_000, 0.002 * SOL);
  assert.equal(b.hopeless, true);
  assert.equal(b.priorityLamports, 0);
  assert.equal(b.useTips, false);
  assert.match(b.note, /not even the network fee/);
  // And the degenerate inputs.
  assert.equal(planExitBudget(0, 1000).hopeless, true);
  assert.equal(planExitBudget(-5, 1000).hopeless, true);
  assert.equal(planExitBudget(NaN, 1000).hopeless, true);
  assert.equal(planExitBudget(2 * SOL, NaN).priorityLamports, 0, 'a broken request pays nothing, not NaN');
  console.log('ok  an empty wallet is reported, not papered over');
}

{
  // The result is never MORE than was asked for — this can only ever cut.
  for (const bal of [0, 1e4, 1e6, 5e6, 1e7, 1e9]) {
    for (const want of [0, 1e5, 2e6, 1e7]) {
      const b = planExitBudget(bal, want);
      assert.ok(b.priorityLamports <= want, `${bal}/${want}: never pays more than asked`);
      assert.ok(b.priorityLamports >= 0, 'and never negative');
      if (!b.hopeless) assert.ok(b.priorityLamports + BASE_FEE_LAMPORTS <= bal, `${bal}/${want}: stays inside the balance`);
    }
  }
  console.log('ok  the budget only ever trims, and always fits');
}

{
  const bal = 0.00167515 * SOL;
  assert.match(explainFeeFailure('"InsufficientFundsForFee"', bal), /Not enough SOL to pay the network fee/);
  assert.match(explainFeeFailure('{"InstructionError":[2,{"Custom":1}]}', bal), /spend more SOL than the wallet holds/);
  assert.match(explainFeeFailure('"InsufficientFundsForFee"', bal), /0\.001675/, 'the actual balance is in the message');
  assert.equal(explainFeeFailure('{"InstructionError":[3,{"Custom":6002}]}', bal), null, 'other errors are left alone');
  assert.match(explainFeeFailure('"InsufficientFundsForFee"', null), /Send a little SOL/, 'works without a known balance');
  console.log('ok  the two fee failures explain themselves in plain words');
}

// ── A buy must never spend the money needed to sell ──────────────────
{
  const { planBuySize, EXIT_RESERVE_LAMPORTS, BUY_OVERHEAD_LAMPORTS } = await import('./.exitbudget.mjs');
  const RESERVE = EXIT_RESERVE_LAMPORTS + BUY_OVERHEAD_LAMPORTS;

  // A comfortable wallet is untouched.
  const plenty = planBuySize(1 * SOL, 0.1 * SOL);
  assert.equal(plenty.lamports, 0.1 * SOL);
  assert.equal(plenty.note, null);

  // "Buy it all" is trimmed, not refused, and says why.
  const all = planBuySize(0.05 * SOL, 0.05 * SOL);
  assert.ok(all.lamports > 0 && all.lamports < 0.05 * SOL);
  assert.equal(all.lamports, 0.05 * SOL - RESERVE, 'exactly the reserve is held back');
  assert.match(all.note, /held back so you can pay to sell/);
  assert.equal(all.refused, false);

  // The wallet from the incident could not have funded a buy at all.
  const broke = planBuySize(0.00167515 * SOL, 0.001 * SOL);
  assert.equal(broke.refused, true);
  assert.equal(broke.lamports, 0, 'nothing is traded');
  assert.match(broke.note, /not enough to buy and still afford to sell/);

  // Whatever is left is always enough to pay for an exit.
  for (const bal of [0.02 * SOL, 0.1 * SOL, 3 * SOL]) {
    const p = planBuySize(bal, bal * 10);
    const left = bal - p.lamports;
    assert.ok(left >= EXIT_RESERVE_LAMPORTS, `${bal}: leaves the exit reserve intact`);
    assert.equal(planExitBudget(left, 0.002 * SOL).hopeless, false, 'and that reserve can pay for a sell');
  }
  // Degenerate inputs trade nothing rather than something strange.
  assert.equal(planBuySize(1 * SOL, 0).refused, true);
  assert.equal(planBuySize(NaN, 1e9).refused, true);
  console.log('ok  a buy always leaves enough SOL to sell the position again');
}

{
  // pump's own revert codes, read from its on-chain IDL on 2026-09-10.
  // Reported from the field as two red FAILED orders quoting {"Custom":6022}
  // and {"Custom":6025} — which told the user nothing about what happened.
  const bal = 0.12 * SOL;

  // 6022 SellZeroAmount and 6025 Truncation are the same story from two
  // directions: the amount is too small for the curve to price.
  for (const code of [6022, 6023, 6025]) {
    const msg = explainFeeFailure(`{"InstructionError":[3,{"Custom":${code}}]}`, bal);
    assert.match(msg, /Nothing left to sell/, `${code} reads as an empty bag`);
  }

  assert.match(explainFeeFailure('{"InstructionError":[3,{"Custom":6024}]}', bal), /Overflow \(6024\)/);

  // The guard that stops 60250 being read as 6025. This line once held a
  // literal backspace byte instead of a word boundary, which silently
  // disabled the whole mapping — hence the explicit case.
  assert.equal(explainFeeFailure('{"InstructionError":[3,{"Custom":60250}]}', bal), null, 'a longer code is not a prefix match');
  assert.equal(explainFeeFailure('{"InstructionError":[3,{"Custom":6019}]}', bal), null, 'a code outside the table falls through');

  console.log('ok  pump revert codes read as English, and only the real ones match');
}
{
  // 2026-09-28: an UNATTENDED buy is refused rather than shrunk. The last buy
  // of a drained wallet that night asked for 0.0151 SOL and got 0.0063.
  const bal = 0.0213 * SOL;
  const want = Math.round(0.0151 * SOL);
  const clicked = planBuySize(bal, want);
  assert.equal(clicked.refused, false, 'a click is trimmed, as before');
  assert.ok(clicked.lamports > 0 && clicked.lamports < want);
  const script = planBuySize(bal, want, { minShare: UNATTENDED_MIN_FILL_SHARE });
  assert.equal(script.refused, true, 'a script is refused');
  assert.equal(script.lamports, 0);
  assert.match(script.note, /refused rather than shrunk below 80%/);
  // Just over the bar: 85 % affordable is still a trim, not a refusal.
  const nearly = planBuySize(0.015 * SOL + 0.85 * want, want, { minShare: UNATTENDED_MIN_FILL_SHARE });
  assert.equal(nearly.refused, false);
  assert.ok(nearly.lamports >= 0.85 * want - 1);
  const fine = planBuySize(0.1 * SOL, want, { minShare: UNATTENDED_MIN_FILL_SHARE });
  assert.equal(fine.refused, false);
  assert.equal(fine.lamports, want);

  // The fee floors' share of a round trip, and the size they imply.
  assert.ok(Math.abs(roundTripFeeShare(0.016) - 0.1875) < 1e-9, '0.003 of 0.016');
  assert.equal(roundTripFeeShare(0), Infinity);
  assert.equal(minUnattendedBuySol(), 0.03);
  assert.equal(minUnattendedBuySol('fast'), 0.03, 'the fast lane is the old rule, unchanged');

  // Dust: a KNOWN estimate under the priority fee holds the sell; unknown never does.
  assert.equal(shouldHoldAsDust(1_500_000, 2_005_000), true);
  assert.equal(shouldHoldAsDust(3_000_000, 2_005_000), false);
  assert.equal(shouldHoldAsDust(undefined, 2_005_000), false, 'unknown never blocks an exit');
  assert.equal(shouldHoldAsDust(null, 2_005_000), false);
  assert.equal(shouldHoldAsDust(1_000, 0), false, 'no fee, nothing to hold for');
  console.log('ok  an unattended buy is refused rather than shrunk; the fee share and the dust rule');
}
console.log('exitbudget: all tests passed');

{
  // Fee lanes (2026-09-29). The farm's 95 round trips lost 0.693 SOL and the
  // priority fee was half of it; pump curve trades land at a median 0.000032
  // SOL of priority. 'lean' prices from the live median with no floor.
  assert.deepEqual([...FEE_LANES], ['fast', 'lean']);
  // micro-lamports/CU × CU → SOL is ÷ 1e15 (a ÷ 1e12 slip would be 1,000× too dear).
  assert.ok(Math.abs(leanPriorityFeeSol(100_000, 120_000) - 0.000012) < 1e-12, '100k µlam × 120k CU = 12,000 lamports');
  assert.ok(Math.abs(leanPriorityFeeSol(1, 120_000) - (LEAN_MIN_MICRO_PER_CU * 120_000) / 1e15) < 1e-15, 'never under the floor price');
  assert.ok(Math.abs(leanPriorityFeeSol(9e9, 120_000) - (LEAN_MAX_MICRO_PER_CU * 120_000) / 1e15) < 1e-15, 'a wild estimate is capped');
  assert.ok(Math.abs(leanPriorityFeeSol(null, 120_000) - 0.000012) < 1e-12, 'no estimate = the default price');
  assert.ok(Math.abs(leanPriorityFeeSol(NaN, 0) - 0.000012) < 1e-12, 'nonsense in, the default out');
  // Every lean fee is far under the fast floors, at any estimate.
  assert.ok(leanPriorityFeeSol(9e9, 250_000) < 0.001 / 5, 'the lean ceiling is < a fifth of the buy floor');
  assert.ok(Math.abs(laneRoundTripPrioritySol('lean') - 0.00025) < 1e-12, 'guarded at the ceiling price and PumpSwap limit');
  assert.equal(laneRoundTripPrioritySol('fast'), 0.003);
  assert.equal(minUnattendedBuySol('lean'), 0.0025);
  assert.ok(roundTripFeeShare(0.02, 'lean') <= 0.1, 'a farm-sized 0.02 SOL bag passes the lean guard');
  assert.ok(roundTripFeeShare(0.02, 'fast') > 0.1, 'and not the fast one');
  const exec = { useJito: true, useHeliusSender: true, mevMode: 'fast', jitoTipPercentile: 75, liveSlippagePct: 10 };
  const lean = leanExec(exec);
  assert.deepEqual([lean.useJito, lean.useHeliusSender, lean.mevMode], [false, false, 'off'], 'no tips, public lane');
  assert.equal(lean.liveSlippagePct, 10, 'everything else is untouched');
  assert.equal(exec.useJito, true, 'the settings object itself is not mutated');
  console.log('ok  lean lane: live-median priority, no floor, no tips, guarded at its ceiling');
}

{
  // What a paper fill charges per side: the fast lane's floor + measured mean tip + base fee; the lean lane's default.
  assert.ok(Math.abs(paperFixedFeeSol('fast', 'buy') - 0.001061) < 1e-12);
  assert.ok(Math.abs(paperFixedFeeSol('fast', 'sell') - 0.002443) < 1e-12);
  assert.ok(Math.abs(paperFixedFeeSol('lean', 'buy') - 0.000017) < 1e-12);
  assert.ok(paperFixedFeeSol('lean', 'sell') * 100 < paperFixedFeeSol('fast', 'sell'), 'lean is two orders of magnitude cheaper on a sell');
  console.log('ok  paper fixed fees per lane and side');
}
