// An exit must fit the wallet. This is the rule that would have prevented a
// real position being unsellable on 2026-09-05: the sell path asked for a
// 0.002 SOL priority fee, the wallet held 0.00167, and the transaction could
// not even be loaded.
import assert from 'node:assert';
import { BASE_FEE_LAMPORTS, LEAN_EXIT_LAMPORTS, explainFeeFailure, planExitBudget } from './.exitbudget.mjs';

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
console.log('exitbudget: all tests passed');
