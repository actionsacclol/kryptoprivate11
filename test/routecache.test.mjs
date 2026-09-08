// Route-cache tests (renderer, 2026-09-08).
//
// What a page opens on when the user navigates back to it: the last thing
// it painted, refreshed in the background. The properties pinned here are
// the ones a wrong cache would break quietly — an event from the engine
// replaces the copy, a wallet switch drops everything that belonged to the
// old signer (but not token rows, which are the same for everyone), the
// subscription is made once however many components ask, and the age stamp
// says nothing while the copy is fresh.

import assert from 'node:assert';
import {
  lastRows,
  rememberRows,
  cachedPortfolio,
  rememberPortfolio,
  cachedHoldings,
  rememberHoldings,
  ensureRouteCacheSubscribed,
  ageLabel,
} from './.routecache.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const row = (mint, extra = {}) => ({ mint, symbol: mint.slice(0, 4), priceUsd: 1, ...extra });
const summary = (tag) => ({ positions: [], paper: { positions: [], model: tag }, pendingFills: 0, generatedAt: 1 });

// The engine bridge the cache subscribes to: records every subscription and
// lets a test push events as main would.
const listeners = [];
globalThis.window = {
  krypt: {
    engine: {
      onEvent(cb) {
        listeners.push(cb);
        return () => {};
      },
    },
  },
};
const push = (ev) => listeners.forEach((cb) => cb(ev));

test('rows are kept by mint, newest last, and a re-seen mint moves to the end', () => {
  lastRows.clear();
  rememberRows([row('A'), row('B'), row('C')]);
  assert.deepStrictEqual([...lastRows.keys()], ['A', 'B', 'C']);
  rememberRows([row('A', { priceUsd: 2 })]);
  assert.deepStrictEqual([...lastRows.keys()], ['B', 'C', 'A']);
  assert.strictEqual(lastRows.get('A').priceUsd, 2, 'the newer row replaces the older one');
});

test('rows without a mint are ignored', () => {
  lastRows.clear();
  rememberRows([row('A'), { symbol: 'X' }, null, undefined]);
  assert.deepStrictEqual([...lastRows.keys()], ['A']);
});

test('the row cache is capped at 300, oldest out first', () => {
  lastRows.clear();
  rememberRows(Array.from({ length: 305 }, (_, i) => row(`M${i}`)));
  assert.strictEqual(lastRows.size, 300);
  assert.ok(!lastRows.has('M0') && !lastRows.has('M4'), 'the first five were evicted');
  assert.ok(lastRows.has('M5') && lastRows.has('M304'));
});

test('portfolio and holdings start empty and return what was remembered', () => {
  assert.strictEqual(cachedPortfolio(), null);
  assert.strictEqual(cachedHoldings(), null);
  const p = summary('remembered');
  rememberPortfolio(p);
  assert.strictEqual(cachedPortfolio(), p, 'the same object, not a copy');
  rememberHoldings([{ mint: 'A', uiAmount: 1 }], 1234);
  assert.deepStrictEqual(cachedHoldings(), { data: [{ mint: 'A', uiAmount: 1 }], at: 1234 });
});

test('the engine subscription is made once, however often it is asked for', () => {
  ensureRouteCacheSubscribed();
  ensureRouteCacheSubscribed();
  ensureRouteCacheSubscribed();
  assert.strictEqual(listeners.length, 1);
});

test("a 'portfolio' event replaces the kept build; a 'holdings' event the kept read", () => {
  const p = summary('pushed');
  push({ kind: 'portfolio', summary: p });
  assert.strictEqual(cachedPortfolio(), p);
  push({ kind: 'holdings', data: [{ mint: 'B', uiAmount: 2 }], at: 5678 });
  assert.deepStrictEqual(cachedHoldings(), { data: [{ mint: 'B', uiAmount: 2 }], at: 5678 });
});

test('unrelated engine events leave the cache alone', () => {
  const before = cachedPortfolio();
  push({ kind: 'status', state: 'running' });
  push({ kind: 'fill', mint: 'B', state: 'landed' });
  assert.strictEqual(cachedPortfolio(), before);
  assert.strictEqual(cachedHoldings().at, 5678);
});

test('a wallet switch drops the signer-scoped copies but keeps token rows', () => {
  lastRows.clear();
  rememberRows([row('A')]);
  assert.ok(cachedPortfolio() && cachedHoldings(), 'precondition: both kept');
  push({ kind: 'walletSwitched', publicKey: 'NewSigner' });
  assert.strictEqual(cachedPortfolio(), null, 'the old signer’s positions must not seed the new one’s page');
  assert.strictEqual(cachedHoldings(), null);
  assert.ok(lastRows.has('A'), 'a token’s price is the same for everyone');
});

test('ageLabel is silent while fresh and reads naturally after', () => {
  const now = Date.now();
  assert.strictEqual(ageLabel(null), '');
  assert.strictEqual(ageLabel(undefined), '');
  assert.strictEqual(ageLabel(0), '');
  assert.strictEqual(ageLabel(now - 2_000), '', 'under the 5 s freshness window');
  assert.strictEqual(ageLabel(now - 12_000), '12 s ago');
  assert.strictEqual(ageLabel(now - 3 * 60_000 - 500), '3 min ago');
  assert.strictEqual(ageLabel(now - 2 * 3_600_000 - 1000), '2 h ago');
  assert.strictEqual(ageLabel(now - 2_000, 1_000), '2 s ago', 'the window is a parameter');
});

for (const c of cases) {
  try {
    c.fn();
    passed += 1;
    console.log(`  ok   ${c.name}`);
  } catch (err) {
    console.log(`  FAIL ${c.name}\n       ${err.message}`);
  }
}
console.log(`\nroutecache: ${passed}/${cases.length} passed`);
if (passed !== cases.length) process.exit(1);
