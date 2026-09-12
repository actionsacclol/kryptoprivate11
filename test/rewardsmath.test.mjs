// Reward-rate dilution — the one number that turns a headline into an answer.
//
// Every tool in this category shows the rate BEFORE you arrive. Merkl's own
// APR is `dailyRewards × 365 / tvl`, so what you would actually earn is the
// same division with your deposit in the denominator. The research measured a
// 292.9% headline becoming 149.0% with $100k added.
//
// The rules pinned here are the honest-null ones: unknown in, unknown out,
// never a zero — a rate the app cannot compute must render as an em dash, not
// as "0%", which would read as "this pays nothing".

import assert from 'node:assert';
import { dilutedAprPct } from './.rewardsmath.mjs';

let passed = 0;
const cases = [];
const test = (n, f) => cases.push({ n, f });
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

test('adding nothing reproduces the published rate', () => {
  // 4.75% on $319,012,693 at $41,519/day — the live headline campaign.
  const apr = dilutedAprPct(41_519, 319_012_693, 0);
  assert.ok(near(apr, 4.75, 0.01), `expected ~4.75, got ${apr}`);
});

test('your own deposit dilutes the rate', () => {
  // A small pool is where it bites: $831/day over $103,600 reads ~292.8%.
  const before = dilutedAprPct(831, 103_600, 0);
  const after = dilutedAprPct(831, 103_600, 100_000);
  assert.ok(before > 280 && before < 300, `headline ~292%, got ${before}`);
  assert.ok(after < before / 1.9, `adding $100k to a $103.6k pool roughly halves it: ${before} → ${after}`);
});

test('a big pool barely moves', () => {
  const before = dilutedAprPct(41_519, 319_012_693, 0);
  const after = dilutedAprPct(41_519, 319_012_693, 10_000);
  assert.ok(near(before, after, 0.001), 'a $10k deposit into $319M is noise, and the column should say so');
});

test('unknown in, unknown out — never zero', () => {
  assert.equal(dilutedAprPct(null, 100, 1000), null, 'unknown rewards');
  assert.equal(dilutedAprPct(100, null, 1000), null, 'unknown TVL');
  assert.equal(dilutedAprPct(NaN, 100, 1000), null);
  assert.equal(dilutedAprPct(100, Infinity, 1000), null);
  assert.equal(dilutedAprPct(100, 100, NaN), null);
});

test('an empty pool is unknown, not infinite', () => {
  // tvl 0 and no deposit would divide by zero; a rate of Infinity rendered as
  // a number would be the most misleading value on the page.
  assert.equal(dilutedAprPct(100, 0, 0), null);
  // But a real deposit into an empty pool IS computable.
  assert.ok(dilutedAprPct(100, 0, 1000) > 0);
});

test('a negative deposit is refused rather than inverted', () => {
  assert.equal(dilutedAprPct(100, 1000, -500), null);
});

const run = async () => {
  for (const c of cases) {
    try {
      await c.f();
      passed += 1;
      console.log(`ok  ${c.n}`);
    } catch (e) {
      console.log(`FAIL ${c.n}\n  ${e.message}`);
    }
  }
  console.log(`rewardsmath: ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
};
await run();
