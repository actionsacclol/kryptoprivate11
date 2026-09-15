// Wallet Lab: the funding planner.
import assert from 'node:assert';
import {
  planFund, RENT_EXEMPT_LAMPORTS, FUND_HEADROOM_LAMPORTS, LAMPORTS_PER_SOL,
} from './.lab.mjs';

const W = [
  { walletId: 'a', publicKey: 'A' },
  { walletId: 'b', publicKey: 'B' },
  { walletId: 'c', publicKey: 'C' },
];

{
  const p = planFund(W, 'each', 0.01, 1);
  assert.equal(p.ok, true);
  assert.equal(p.targets.length, 3);
  assert.equal(p.totalLamports, 3 * 10_000_000);
  const t = planFund(W, 'total', 0.03, 1);
  assert.equal(t.ok, true);
  assert.equal(t.targets[0].sol, 0.01);
  console.log('ok  fund: each vs total split');
}
{
  const p = planFund(W, 'each', 0.0005, 1);
  assert.equal(p.ok, false);
  assert.match(p.message, /rent/);
  console.log('ok  fund: a target below rent-exemption is refused (it would revert the whole tx)');
}
{
  const bal = (3 * 10_000_000 + FUND_HEADROOM_LAMPORTS - 1) / LAMPORTS_PER_SOL;
  assert.equal(planFund(W, 'each', 0.01, bal).ok, false, 'one lamport short of headroom refuses');
  assert.equal(planFund(W, 'each', 0.01, bal + 1e-9).ok, true);
  assert.equal(planFund([], 'each', 0.01, 1).ok, false);
  assert.equal(planFund(W, 'each', 0, 1).ok, false);
  console.log('ok  fund: source headroom and empty inputs');
}
// The planner mirrors the fund handler's bounds, so the confirm is never
// followed by a refusal.
{
  const p = planFund(W, 'each', 51, null);
  assert.equal(p.ok, false);
  assert.match(p.message, /per wallet/);
  const t = planFund(W, 'each', 40, null);
  assert.equal(t.ok, false);
  assert.match(t.message, /per batch/);
  assert.equal(planFund(W, 'each', 30, null).ok, true, '3 × 30 = 90 is under the 100 batch cap');
  console.log('ok  planFund mirrors the fund handler bounds (50 SOL per wallet, 100 per batch)');
}
console.log('lab: all tests passed');
