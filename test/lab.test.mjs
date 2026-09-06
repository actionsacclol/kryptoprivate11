// Wallet Lab planners and validators.
import assert from 'node:assert';
import {
  planFund, validateFollow, validateRandom, DEFAULT_FOLLOW, DEFAULT_RANDOM,
  pickTradeSol, lossCapHit, RENT_EXEMPT_LAMPORTS, FUND_HEADROOM_LAMPORTS, LAMPORTS_PER_SOL,
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
{
  assert.equal(validateFollow(DEFAULT_FOLLOW).ok, true);
  assert.equal(validateFollow({ ...DEFAULT_FOLLOW, delayMaxMs: 10, delayMinMs: 20 }).ok, false);
  assert.equal(validateFollow({ ...DEFAULT_FOLLOW, ratio: 0 }).ok, false);
  assert.equal(validateFollow({ ...DEFAULT_FOLLOW, maxTradeSol: 50 }).ok, false);
  assert.equal(validateRandom(DEFAULT_RANDOM).ok, true);
  assert.equal(validateRandom({ ...DEFAULT_RANDOM, tradeSolMax: 0.001, tradeSolMin: 0.01 }).ok, false);
  assert.equal(validateRandom({ ...DEFAULT_RANDOM, holdSecMin: 1 }).ok, false, 'a 1 s hold is a wash, not a trade');
  assert.equal(validateRandom({ ...DEFAULT_RANDOM, universe: 'moon' }).ok, false);
  console.log('ok  validators bound every knob');
}
{
  const r = { ...DEFAULT_RANDOM, tradeSolMin: 0.01, tradeSolMax: 0.02 };
  const fixed = () => 0.5;
  assert.equal(pickTradeSol(r, 1, fixed), 0.015);
  assert.equal(pickTradeSol(r, 0.012, fixed), null, 'a wallet that cannot cover the minimum sits out');
  assert.equal(pickTradeSol(r, 0.02, fixed), 0.015, 'capped by what the wallet can spare');
  assert.equal(pickTradeSol(r, 0.0165, fixed), 0.0125);
  console.log('ok  random size respects the range and the wallet');
}
{
  assert.equal(lossCapHit(-0.05, 0.05), true);
  assert.equal(lossCapHit(-0.049, 0.05), false);
  assert.equal(lossCapHit(0.1, 0.05), false);
  console.log('ok  loss cap is on realised PnL');
}
console.log('lab: all tests passed');
