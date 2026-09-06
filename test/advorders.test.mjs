// Advanced-order state machine tests.
//
// This module signs real transactions, so the properties below are the ones
// that decide whether a bug costs money:
//
//   • an order leaves `armed` at most once (no double sell);
//   • a met condition that CANNOT execute does not consume the order
//     (protection is not silently spent);
//   • a restart brings orders back paused, never armed;
//   • a trailing stop never triggers on the same tick that sets a new peak;
//   • a market-cap trigger never falls back to comparing a SOL price.

import assert from 'node:assert';
import * as ord from './.advorders.mjs';
import { validateOrder, triggerPriceSol, describeOrder } from './.ordersshared.mjs';

// The runner AWAITS every case and runs them one at a time. Most of these
// tests are async and they all share this module's global order list, so a
// fire-and-forget runner would both interleave state between cases and let
// failed assertions escape as unhandled rejections — which is exactly what
// it did on the first run here, printing "22 passed" over a real failure.
let passed = 0;
const cases = [];
const test = (name, fn) => {
  cases.push({ name, fn });
};

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
  console.log(`advorders: ${passed}/${cases.length} tests passed`);
}

const MINT = 'OrderMint111111111111111111111111111111111';

/** A host that records what it was asked to do. */
function makeHost(over = {}) {
  const calls = { buys: [], sells: [], toasts: [], logs: [], changed: 0 };
  return {
    calls,
    host: {
      buy: async (mint, sol) => {
        calls.buys.push({ mint, sol });
        return over.buyResult ?? { ok: true, message: 'bought', signature: 'sigbuy' };
      },
      sell: async (mint, percent) => {
        calls.sells.push({ mint, percent });
        return over.sellResult ?? { ok: true, message: 'sold', signature: 'sigsell' };
      },
      blockedReason: () => over.blockedReason ?? null,
      buyBlockedReason: () => over.buyBlockedReason ?? null,
      maxLiveSol: () => over.maxLiveSol ?? 1,
      log: (level, line) => calls.logs.push({ level, line }),
      toast: (level, message) => calls.toasts.push({ level, message }),
      changed: () => { calls.changed++; },
    },
  };
}

function setup(over = {}) {
  ord._reset();
  const h = makeHost(over);
  ord.attach(h.host);
  return h;
}

const mk = (kind, triggerValue, opts = {}) =>
  ord.create(
    {
      mint: MINT,
      symbol: 'TEST',
      kind,
      triggerValue,
      triggerBasis: opts.basis ?? (['take_profit', 'stop_loss', 'trailing_stop'].includes(kind) ? 'pct' : 'price_sol'),
      amount: opts.amount ?? (kind === 'limit_buy' || kind === 'buy_on_migration' ? 0.1 : 50),
    },
    { referencePriceSol: opts.ref ?? 0.001 },
  );

// ── Validation ────────────────────────────────────────────────────────

test('validation rejects impossible orders', () => {
  const base = { mint: MINT, symbol: 'T', triggerBasis: 'pct', amount: 50 };
  assert.equal(validateOrder({ ...base, kind: 'stop_loss', triggerValue: 0 }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'stop_loss', triggerValue: 100 }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'take_profit', triggerValue: -5 }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'trailing_stop', triggerValue: 150 }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'stop_loss', triggerValue: null }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'stop_loss', triggerValue: 30, amount: 0 }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'stop_loss', triggerValue: 30, amount: 101 }).ok, false);
  assert.equal(validateOrder({ ...base, kind: 'stop_loss', triggerValue: 30 }).ok, true);
});

test('conditional orders need no trigger value', () => {
  const r = validateOrder({ mint: MINT, symbol: 'T', kind: 'sell_on_dev_sell', triggerValue: null, triggerBasis: 'pct', amount: 100 });
  assert.equal(r.ok, true);
});

test('a percentage order cannot be created without a reference price', () => {
  setup();
  const r = ord.create(
    { mint: MINT, symbol: 'T', kind: 'stop_loss', triggerValue: 30, triggerBasis: 'pct', amount: 100 },
    { referencePriceSol: null },
  );
  assert.equal(r.ok, false, 'should refuse — it would sit armed forever and never fire');
});

test('a buy over the per-trade cap is refused at creation', () => {
  setup({ maxLiveSol: 0.05 });
  const r = mk('limit_buy', 0.0005, { amount: 0.5 });
  assert.equal(r.ok, false);
  assert.match(r.message, /cap/i);
});

// ── Triggering ────────────────────────────────────────────────────────

test('stop loss fires below the reference, not above', async () => {
  const h = setup();
  mk('stop_loss', 30, { ref: 0.001, amount: 100 });
  ord.onTick({ mint: MINT, priceSol: 0.0008, mcapUsd: null }); // −20%, no
  assert.equal(h.calls.sells.length, 0);
  ord.onTick({ mint: MINT, priceSol: 0.0007, mcapUsd: null }); // −30%, yes
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 1);
  assert.equal(h.calls.sells[0].percent, 100);
});

test('take profit fires above the reference', async () => {
  const h = setup();
  mk('take_profit', 50, { ref: 0.001, amount: 25 });
  ord.onTick({ mint: MINT, priceSol: 0.0014, mcapUsd: null });
  assert.equal(h.calls.sells.length, 0);
  ord.onTick({ mint: MINT, priceSol: 0.0015, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 1);
  assert.equal(h.calls.sells[0].percent, 25);
});

test('an order fires AT MOST ONCE even under a burst of ticks', async () => {
  const h = setup();
  mk('stop_loss', 20, { ref: 0.001, amount: 100 });
  for (let i = 0; i < 50; i++) ord.onTick({ mint: MINT, priceSol: 0.0005, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 1, 'a 50-tick burst must produce exactly one sell');
  assert.equal(ord.all()[0].state, 'filled');
});

test('trailing stop tracks the peak and never fires on the tick that sets it', async () => {
  const h = setup();
  mk('trailing_stop', 20, { ref: 0.001, amount: 100 });
  ord.onTick({ mint: MINT, priceSol: 0.002, mcapUsd: null }); // new peak
  ord.onTick({ mint: MINT, priceSol: 0.004, mcapUsd: null }); // new peak
  assert.equal(h.calls.sells.length, 0);
  assert.equal(ord.all()[0].peakPriceSol, 0.004);
  ord.onTick({ mint: MINT, priceSol: 0.0033, mcapUsd: null }); // −17.5% from peak
  assert.equal(h.calls.sells.length, 0);
  ord.onTick({ mint: MINT, priceSol: 0.0032, mcapUsd: null }); // −20% from peak
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 1);
});

test('a market-cap trigger never falls back to the SOL price', async () => {
  const h = setup();
  // 60000 USD target. The SOL price (0.001) is far BELOW that number, so a
  // buggy fallback comparing price to trigger would fire a limit_sell never,
  // and a limit_buy instantly. Assert the limit_buy does not fire.
  mk('limit_buy', 60_000, { basis: 'mcap_usd', amount: 0.1 });
  for (let i = 0; i < 5; i++) ord.onTick({ mint: MINT, priceSol: 0.001, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.buys.length, 0, 'no market cap means no market-cap decision');
  ord.onTick({ mint: MINT, priceSol: 0.001, mcapUsd: 55_000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.buys.length, 1);
});

test('conditional orders fire on the event, with no usable price', async () => {
  const h = setup();
  ord.create(
    { mint: MINT, symbol: 'T', kind: 'sell_on_dev_sell', triggerValue: null, triggerBasis: 'pct', amount: 100 },
    { referencePriceSol: null },
  );
  ord.onTick({ mint: MINT, priceSol: 0, mcapUsd: null }); // nothing observed
  assert.equal(h.calls.sells.length, 0);
  ord.onTick({ mint: MINT, priceSol: 0, mcapUsd: null, creatorSold: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 1, 'a migration/dev-sell event must not need a price');
});

test('orders for other mints are untouched', async () => {
  const h = setup();
  mk('stop_loss', 20, { ref: 0.001, amount: 100 });
  ord.onTick({ mint: 'OtherMint11111111111111111111111111111111', priceSol: 0.0000001, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 0);
});

// ── The money-critical property ───────────────────────────────────────

test('a met condition that CANNOT execute does not consume the order', async () => {
  const h = setup({ blockedReason: 'live execution is off in settings' });
  mk('stop_loss', 20, { ref: 0.001, amount: 100 });
  ord.onTick({ mint: MINT, priceSol: 0.0005, mcapUsd: null });
  await new Promise((r) => setImmediate(r));

  assert.equal(h.calls.sells.length, 0, 'nothing should have been sold');
  const o = ord.all()[0];
  assert.equal(o.state, 'armed', 'the order MUST still be armed — the user still expects protection');
  assert.match(o.note, /NOT executed/);
  assert.ok(h.calls.toasts.some((t) => t.level === 'warn'), 'the user must be told, loudly');
});

test('once unblocked, the still-armed order fires', async () => {
  const over = { blockedReason: 'the engine is not armed' };
  ord._reset();
  const calls = { sells: [], toasts: [] };
  ord.attach({
    buy: async () => ({ ok: true, message: 'ok' }),
    sell: async (mint, percent) => { calls.sells.push({ mint, percent }); return { ok: true, message: 'sold', signature: 's' }; },
    blockedReason: () => over.blockedReason,
    buyBlockedReason: () => null,
    maxLiveSol: () => 1,
    log: () => {},
    toast: (level, message) => calls.toasts.push({ level, message }),
    changed: () => {},
  });
  mk('stop_loss', 20, { ref: 0.001, amount: 100 });

  ord.onTick({ mint: MINT, priceSol: 0.0005, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.sells.length, 0);

  over.blockedReason = null; // user turns live execution on
  ord.onTick({ mint: MINT, priceSol: 0.0005, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.sells.length, 1, 'protection resumes the moment it can');
});

test('a breaker blocks a BUY but never a SELL', async () => {
  // A circuit breaker that stops someone closing a position turns a stop
  // loss into a trap, so buyBlockedReason applies to buys only.
  const h = setup({ buyBlockedReason: 'entries are paused (loss limit)' });
  mk('stop_loss', 20, { ref: 0.001, amount: 100 });
  mk('limit_buy', 0.0005, { amount: 0.1 });

  ord.onTick({ mint: MINT, priceSol: 0.0005, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(h.calls.sells.length, 1, 'the sell must go through');
  assert.equal(h.calls.buys.length, 0, 'the buy must be refused');
  const buy = ord.all().find((o) => o.kind === 'limit_buy');
  assert.equal(buy.state, 'failed');
  assert.match(buy.note, /entries are paused/);
});

test('a failed execution is NOT retried', async () => {
  const h = setup({ sellResult: { ok: false, message: 'relayer rejected trade' } });
  mk('stop_loss', 20, { ref: 0.001, amount: 100 });
  for (let i = 0; i < 20; i++) ord.onTick({ mint: MINT, priceSol: 0.0005, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 1, 'exactly one attempt — a retry against unknown state double-spends');
  assert.equal(ord.all()[0].state, 'failed');
});

// ── Lifecycle ─────────────────────────────────────────────────────────

test('cancel stops an armed order from firing', async () => {
  const h = setup();
  const r = mk('stop_loss', 20, { ref: 0.001, amount: 100 });
  ord.cancel(r.order.id);
  ord.onTick({ mint: MINT, priceSol: 0.0000001, mcapUsd: null });
  await new Promise((r2) => setImmediate(r2));
  assert.equal(h.calls.sells.length, 0);
  assert.equal(ord.all()[0].state, 'cancelled');
});

test('an expired order does not fire', async () => {
  const h = setup();
  ord.create(
    { mint: MINT, symbol: 'T', kind: 'stop_loss', triggerValue: 20, triggerBasis: 'pct', amount: 100, expiresAt: Date.now() - 1000 },
    { referencePriceSol: 0.001 },
  );
  ord.onTick({ mint: MINT, priceSol: 0.0000001, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 0);
  assert.equal(ord.all()[0].state, 'expired');
});

test('restored orders come back PAUSED and do not evaluate', async () => {
  const h = setup();
  ord._load([
    { id: 'a', mint: MINT, symbol: 'T', kind: 'stop_loss', state: 'paused', triggerValue: 20,
      triggerBasis: 'pct', amount: 100, referencePriceSol: 0.001, peakPriceSol: null,
      createdAt: 1, updatedAt: 1, triggeredAt: null, note: null, signature: null, expiresAt: null },
  ]);
  ord.onTick({ mint: MINT, priceSol: 0.0000001, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 0, 'a paused order must never fire on its own');
  assert.equal(ord.pausedCount(), 1);
});

test('resume re-arms paused orders and resets a stale trailing peak', async () => {
  const h = setup();
  ord._load([
    { id: 'a', mint: MINT, symbol: 'T', kind: 'trailing_stop', state: 'paused', triggerValue: 20,
      triggerBasis: 'pct', amount: 100, referencePriceSol: 0.001, peakPriceSol: 0.05,
      createdAt: 1, updatedAt: 1, triggeredAt: null, note: null, signature: null, expiresAt: null },
  ]);
  ord.resumePaused();
  const o = ord.all()[0];
  assert.equal(o.state, 'armed');
  assert.equal(o.peakPriceSol, 0.001, 'a peak from an unobserved window would fire the stop instantly');
  ord.onTick({ mint: MINT, priceSol: 0.001, mcapUsd: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.sells.length, 0, 'resuming must not immediately dump the position');
});

test('an order that was mid-flight at shutdown is NOT auto-resumed', () => {
  setup();
  ord._load([
    { id: 'a', mint: MINT, symbol: 'T', kind: 'stop_loss', state: 'paused', triggerValue: 20,
      triggerBasis: 'pct', amount: 100, referencePriceSol: 0.001, peakPriceSol: null,
      createdAt: 1, updatedAt: 1, triggeredAt: 2,
      note: 'The app closed while this order was executing. Check your wallet before resuming.',
      signature: null, expiresAt: null },
  ]);
  ord.resumePaused();
  assert.equal(ord.all()[0].state, 'paused', 'the tx may already have landed — a human must check');
});

// ── Display helpers ───────────────────────────────────────────────────

test('triggerPriceSol resolves the chart line for each kind', () => {
  const base = { mint: MINT, symbol: 'T', amount: 100, referencePriceSol: 0.001, peakPriceSol: null,
    createdAt: 1, updatedAt: 1, triggeredAt: null, note: null, signature: null, expiresAt: null, state: 'armed', id: 'x' };
  assert.equal(triggerPriceSol({ ...base, kind: 'limit_sell', triggerBasis: 'price_sol', triggerValue: 0.002 }), 0.002);
  assert.equal(triggerPriceSol({ ...base, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 50 }), 0.0015);
  assert.ok(Math.abs(triggerPriceSol({ ...base, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30 }) - 0.0007) < 1e-12);
  assert.equal(triggerPriceSol({ ...base, kind: 'trailing_stop', triggerBasis: 'pct', triggerValue: 20, peakPriceSol: 0.004 }), 0.0032);
  assert.equal(triggerPriceSol({ ...base, kind: 'sell_on_dev_sell', triggerBasis: 'pct', triggerValue: null }), null);
  assert.equal(triggerPriceSol({ ...base, kind: 'limit_buy', triggerBasis: 'mcap_usd', triggerValue: 50000 }), null);
});

test('describeOrder says what will happen for every kind', () => {
  const base = { mint: MINT, symbol: 'T', referencePriceSol: 0.001, peakPriceSol: null,
    createdAt: 1, updatedAt: 1, triggeredAt: null, note: null, signature: null, expiresAt: null, state: 'armed', id: 'x' };
  const cases = [
    [{ ...base, kind: 'limit_buy', triggerBasis: 'mcap_usd', triggerValue: 50000, amount: 0.5 }, /Buy 0\.5 SOL at or below \$50,000 market cap/],
    [{ ...base, kind: 'limit_sell', triggerBasis: 'price_sol', triggerValue: 0.002, amount: 50 }, /Sell 50% at or above 0\.002 SOL/],
    [{ ...base, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 100, amount: 25 }, /Sell 25% at \+100%/],
    [{ ...base, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 20, amount: 100 }, /Sell 100% at .20%/],
    [{ ...base, kind: 'trailing_stop', triggerBasis: 'pct', triggerValue: 15, amount: 100 }, /falls 15% from its peak/],
    [{ ...base, kind: 'sell_on_dev_sell', triggerBasis: 'pct', triggerValue: null, amount: 100 }, /if the creator sells/],
    [{ ...base, kind: 'sell_on_migration', triggerBasis: 'pct', triggerValue: null, amount: 100 }, /when it migrates/],
    [{ ...base, kind: 'buy_on_migration', triggerBasis: 'pct', triggerValue: null, amount: 0.2 }, /Buy 0\.2 SOL when it migrates/],
  ];
  for (const [o, re] of cases) assert.match(describeOrder(o), re, o.kind);
});

await run();
