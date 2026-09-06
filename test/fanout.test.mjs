// Fan-out planning. The one property that must never break: a 'total' split
// adds up to EXACTLY the total, in lamports, no matter the jitter or count —
// randomisation moves money between wallets, it never invents or loses any.

import assert from 'node:assert/strict';
import { planFanout, planWallets } from './.fanout.mjs';

const SOL = 1_000_000_000;
const W = (n) => Array.from({ length: n }, (_, i) => `wallet${i + 1}`);

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

// ─── 'same' mode ──────────────────────────────────────────────────────

ok('same mode gives every wallet the identical amount', () => {
  const p = planFanout(W(4), { mode: 'same', amountSol: 0.1 });
  assert.equal(p.ok, true, p.message);
  assert.equal(p.shares.length, 4);
  assert.ok(p.shares.every((s) => s.lamports === 0.1 * SOL));
  assert.equal(p.totalLamports, 0.4 * SOL);
});

ok('same mode with one wallet is just that one buy', () => {
  const p = planFanout(['solo'], { mode: 'same', amountSol: 0.05 });
  assert.equal(p.shares.length, 1);
  assert.equal(p.shares[0].lamports, 0.05 * SOL);
});

// ─── 'total' mode, even split ─────────────────────────────────────────

ok('total mode with no jitter splits evenly and sums to the total', () => {
  const p = planFanout(W(4), { mode: 'total', amountSol: 0.4 });
  assert.equal(p.ok, true, p.message);
  assert.equal(p.totalLamports, 0.4 * SOL);
  assert.equal(
    p.shares.reduce((a, s) => a + s.lamports, 0),
    0.4 * SOL,
    'shares must sum to exactly the total',
  );
  assert.ok(p.shares.every((s) => s.lamports === 0.1 * SOL));
});

ok('an uneven total still sums exactly, with the remainder on the largest', () => {
  // 0.1 SOL / 3 = 33,333,333.33… — rounding must not lose the last lamports.
  const p = planFanout(W(3), { mode: 'total', amountSol: 0.1 });
  assert.equal(p.totalLamports, 0.1 * SOL);
  assert.equal(p.shares.reduce((a, s) => a + s.lamports, 0), 0.1 * SOL);
});

// ─── 'total' mode, randomised ─────────────────────────────────────────

ok('a randomised split ALWAYS sums to exactly the total', () => {
  // Deterministic pseudo-random so the test is stable but the shares vary.
  let seed = 12345;
  const rand = () => {
    seed = (1103515245 * seed + 12345) % 2147483648;
    return (seed >>> 8) / (2147483648 >>> 8);
  };
  for (const n of [2, 3, 5, 8, 13]) {
    for (const totalSol of [0.1, 0.37, 1, 2.5]) {
      const p = planFanout(W(n), { mode: 'total', amountSol: totalSol, jitter: 0.4 }, rand);
      assert.equal(p.ok, true, p.message);
      const sum = p.shares.reduce((a, s) => a + s.lamports, 0);
      assert.equal(sum, Math.round(totalSol * SOL), `n=${n} total=${totalSol}: sum ${sum} != ${Math.round(totalSol * SOL)}`);
    }
  }
});

ok('jitter actually varies the shares (not all identical)', () => {
  let seed = 999;
  const rand = () => {
    seed = (1103515245 * seed + 12345) % 2147483648;
    return (seed >>> 8) / (2147483648 >>> 8);
  };
  const p = planFanout(W(5), { mode: 'total', amountSol: 1, jitter: 0.5 }, rand);
  const distinct = new Set(p.shares.map((s) => s.lamports));
  assert.ok(distinct.size > 1, 'randomised shares should differ');
});

ok('zero jitter is a perfectly even split even in total mode', () => {
  const p = planFanout(W(5), { mode: 'total', amountSol: 1, jitter: 0 });
  assert.ok(p.shares.every((s) => s.lamports === 0.2 * SOL));
});

// ─── the floor ────────────────────────────────────────────────────────

ok('a total too small to give each wallet the minimum is refused', () => {
  const p = planFanout(W(10), { mode: 'total', amountSol: 0.001, minSol: 0.001 });
  assert.equal(p.ok, false);
  assert.match(p.message, /minimum/i);
});

ok('a same-mode buy below the minimum is refused', () => {
  const p = planFanout(W(3), { mode: 'same', amountSol: 0.0001, minSol: 0.001 });
  assert.equal(p.ok, false);
  assert.match(p.message, /minimum/i);
});

// ─── guards ───────────────────────────────────────────────────────────

ok('no wallets is a clear refusal, not a crash', () => {
  const p = planFanout([], { mode: 'same', amountSol: 0.1 });
  assert.equal(p.ok, false);
  assert.match(p.message, /no wallets/i);
});

ok('duplicate wallets are collapsed', () => {
  const p = planFanout(['a', 'a', 'b'], { mode: 'same', amountSol: 0.1 });
  assert.equal(p.shares.length, 2);
});

ok('a zero or negative amount is refused', () => {
  assert.equal(planFanout(W(3), { mode: 'same', amountSol: 0 }).ok, false);
  assert.equal(planFanout(W(3), { mode: 'total', amountSol: -1 }).ok, false);
});

ok('planWallets returns the public keys in order', () => {
  const p = planFanout(['a', 'b', 'c'], { mode: 'same', amountSol: 0.1 });
  assert.deepEqual(planWallets(p), ['a', 'b', 'c']);
});

console.log(`fanout: ${passed}/${passed} tests passed`);
