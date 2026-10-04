// All-in-One speed tiers + the float (2026-10-03). Pure rules:
//   · tiers stay inside honest bounds (Robinhood never pays more for nothing);
//   · the float never moves on an unread balance, never drains its source,
//     moves one chain at a time, and only by enough to reach the target.
import assert from 'node:assert/strict';
import { solanaDepositPrice, evmFeeMultiplier, arrivalPollMs, abandonAfterMs, SOLANA_DEPOSIT_CU_LIMIT, isAioSpeed } from './.aiospeed.mjs';
import { nextFloatRefill, FLOAT_MIN_MOVE_USD } from './.aiofloat.mjs';

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok  ${m}`);
};

// ── tiers ──────────────────────────────────────────────────────────────
{
  const est = { p50: 20_000, p75: 120_000, p90: 900_000 };
  assert.equal(solanaDepositPrice('cheap', est), 20_000);
  assert.equal(solanaDepositPrice('normal', est), 120_000);
  assert.equal(solanaDepositPrice('fast', est), 900_000);
  assert.equal(solanaDepositPrice('fast', { p50: 1, p75: 1, p90: 50_000_000 }), 2_000_000, 'Fast is capped');
  assert.equal(solanaDepositPrice('normal', null), 50_000, 'no estimate: the old fixed price');
  assert.ok(solanaDepositPrice('cheap', est) <= solanaDepositPrice('normal', est) && solanaDepositPrice('normal', est) <= solanaDepositPrice('fast', est));
  // Worst case at Fast is well inside the deposit's 0.001 SOL loss-guard slack.
  assert.ok((2_000_000 * SOLANA_DEPOSIT_CU_LIMIT) / 1e6 < 1_000_000);
  ok('Solana deposit price follows the tier, bounded, and fits the cost guard');

  assert.equal(evmFeeMultiplier('fast', 'bnb'), 2);
  assert.equal(evmFeeMultiplier('fast', 'robinhood'), 1, 'Robinhood ignores tips: never pay more for nothing');
  assert.equal(evmFeeMultiplier('normal', 'bnb'), 1);
  ok('EVM: only BNB Fast pays more');

  assert.ok(arrivalPollMs('fast') < arrivalPollMs('normal') && arrivalPollMs('normal') < arrivalPollMs('cheap'));
  assert.ok(abandonAfterMs('fast') < abandonAfterMs('normal') && abandonAfterMs('normal') < abandonAfterMs('cheap'));
  assert.equal(isAioSpeed('fast'), true);
  assert.equal(isAioSpeed('turbo'), false);
  ok('faster tiers check arrival more often and wait less');
}

// ── float ──────────────────────────────────────────────────────────────
{
  const sol = (held) => ({ chain: 'solana', held, priceUsd: 120, reserve: 0.015 });
  const bnb = (held) => ({ chain: 'bnb', held, priceUsd: 600, reserve: 0.0005 });
  const hood = (held) => ({ chain: 'robinhood', held, priceUsd: 2700, reserve: 0.0001 });

  const m = nextFloatRefill([sol(1), bnb(0), hood(0.02)], 25);
  assert.ok(m, 'BNB is empty: refill it');
  assert.equal(m.from, 'solana', 'from the chain holding the most');
  assert.equal(m.to, 'bnb');
  assert.ok(Math.abs(m.usd - 25) < 1e-9 && Math.abs(m.amountFrom - 25 / 120) < 1e-9, 'just enough to reach the target');

  assert.equal(nextFloatRefill([sol(1), bnb(0.03), hood(0.02)], 25), null, 'every chain at or near target: nothing');
  assert.equal(nextFloatRefill([sol(1), bnb(null), hood(0.02)], 25), null, 'an unread balance moves nothing');
  assert.equal(nextFloatRefill([{ ...sol(1), priceUsd: null }, bnb(0), hood(0.02)], 25), null, 'an unknown price moves nothing');
  assert.equal(nextFloatRefill([sol(0.4), bnb(0), hood(0)], 25), null, '$48 on Solana cannot spare $25 and keep its own $25 + reserve');
  assert.equal(nextFloatRefill([sol(1), bnb(0), hood(0)], 2), null, `a target under $${FLOAT_MIN_MOVE_USD} is never moved`);
  assert.equal(nextFloatRefill([sol(1)], 25), null, 'one chain: nothing to balance');
  const first = nextFloatRefill([sol(2), bnb(0), hood(0.0001)], 25);
  assert.equal(first.to, 'bnb', 'one at a time, the emptiest first');
  ok('the float: never on a guess, never drains its source, one refill at a time');
}

console.log(`\naiospeed: ${passed}/${passed} passed`);
