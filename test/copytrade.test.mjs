// Copy-trading tests.
//
// A paper scorecard exists to inform a decision to risk real money, so the
// ways it can flatter itself are the bugs that matter:
//
//   • filling at the follower's price instead of the price after your delay;
//   • hiding the trades your filters rejected;
//   • ignoring the protocol fee a real round trip would have paid;
//   • letting a LIVE config resume armed after a restart.

import assert from 'node:assert';
import * as copy from './.copytrade.mjs';
import { copySize, defaultConfig, validateConfig, winRate } from './.copyshared.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const WALLET = 'Whale111111111111111111111111111111111111';
const MINT = 'CopyMint111111111111111111111111111111111';

function makeHost(over = {}) {
  const calls = { buys: [], toasts: [] };
  return {
    calls,
    host: {
      buy: async (mint, sol) => {
        calls.buys.push({ mint, sol });
        return over.buyResult ?? { ok: true, message: 'bought', signature: 'sig' };
      },
      liveBlockedReason: () => over.liveBlockedReason ?? null,
      priceSol: () => (over.priceSol === undefined ? 0.001 : over.priceSol),
      tokenFacts: async () =>
        over.facts ?? { liquidityUsd: 50_000, marketCapUsd: 100_000, kryptScore: 80, isPumpfun: true },
      log: () => {},
      toast: (level, message) => calls.toasts.push({ level, message }),
      changed: () => {},
    },
  };
}

function setup(over = {}) {
  copy._reset();
  const h = makeHost(over);
  copy.attach(h.host);
  return h;
}

const cfg = (over = {}) => ({ ...defaultConfig(WALLET, 'Sharky'), enabled: true, ...over });

const trade = (over = {}) => ({
  wallet: WALLET,
  mint: MINT,
  symbol: 'COPY',
  isBuy: true,
  sol: 1,
  priceSol: 0.001,
  at: Date.now(),
  ...over,
});

// ── Sizing ────────────────────────────────────────────────────────────

test('fixed sizing ignores their size; proportional follows it, both capped', () => {
  const fixed = { sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 };
  assert.equal(copySize(fixed, 10), 0.05);
  assert.equal(copySize(fixed, 0.01), 0.05);
  const prop = { sizing: 'proportional', sizeValue: 10, maxTradeSol: 0.5 };
  assert.equal(copySize(prop, 1), 0.1);
  assert.equal(copySize(prop, 100), 0.5, 'the cap must bind');
});

test('validation rejects configs that cannot work', () => {
  assert.equal(validateConfig(cfg({ wallet: 'short' })).ok, false);
  assert.equal(validateConfig(cfg({ sizeValue: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ maxTradeSol: 100 })).ok, false);
  assert.equal(validateConfig(cfg({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 0.1 })).ok, false);
  assert.equal(validateConfig(cfg({ delayMs: 120_000 })).ok, false);
  assert.equal(validateConfig(cfg({ dailyLossLimitSol: 0 })).ok, false);
  assert.equal(validateConfig(cfg()).ok, true);
});

test('a config defaults to PAPER and disabled', () => {
  const d = defaultConfig(WALLET, 'x');
  assert.equal(d.mode, 'paper');
  assert.equal(d.enabled, false);
});

// ── Paper honesty ─────────────────────────────────────────────────────

test('a paper fill uses the price AFTER the configured delay, not theirs', async () => {
  // Their trade prints at 0.001. By the time our delay elapses the tape is
  // at 0.0015 — that is what we would actually have paid.
  const h = setup({ priceSol: 0.0015 });
  copy.upsert(cfg({ delayMs: 5 }));
  copy.onWalletTrade(trade({ priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 60));

  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.ok(open, 'a copy should have opened');
  assert.equal(open.entryPriceSol, 0.0015, 'filling at their price would flatter the record');
});

test('a paper round trip pays BOTH sides of every fee a real one would', async () => {
  const h = setup({ priceSol: 0.001 });
  copy.upsert(cfg({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 }));
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));
  // They sell at exactly the entry price: a fee-free model would show 0.
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));

  const closed = copy.snapshot().recent.find((t) => t.state === 'closed');
  assert.ok(closed, 'the copy should have closed');
  assert.ok(closed.pnlSol < 0, 'a flat round trip must LOSE money, as it does in real life');
  // 1 % pump.fun + 0.5 % Krypt, charged on the way in AND on the way out:
  // 1.5 % a side, 3 % on a 1 SOL round trip. Charging one side only reported
  // a third of the real cost and flattered every paper record.
  assert.ok(Math.abs(closed.pnlSol - -0.03) < 1e-9, `expected ~-0.03, got ${closed.pnlSol}`);
});

test('filtered-out trades are RECORDED as skips with a reason', async () => {
  const h = setup({ facts: { liquidityUsd: 100, marketCapUsd: 1000, kryptScore: 10, isPumpfun: true } });
  copy.upsert(cfg({ minLiquidityUsd: 5000 }));
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));

  const rows = copy.snapshot().recent;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'skipped');
  assert.match(rows[0].reason, /liquidity below/);
  const st = Object.values(copy.snapshot().stats)[0];
  assert.equal(st.skipped, 1, 'a scorecard that hides skips measures the wrong thing');
  assert.equal(st.trades, 0);
});

test('each filter rejects for its own stated reason', async () => {
  const checks = [
    [{ maxMarketCapUsd: 50_000 }, { liquidityUsd: 99_000, marketCapUsd: 100_000, kryptScore: 90, isPumpfun: true }, /market cap above/],
    [{ minKryptScore: 70 }, { liquidityUsd: 99_000, marketCapUsd: 10_000, kryptScore: 30, isPumpfun: true }, /score 30 below/],
    [{ onlyPumpfun: true }, { liquidityUsd: 99_000, marketCapUsd: 10_000, kryptScore: 90, isPumpfun: false }, /not a pump\.fun token/],
  ];
  for (const [over, facts, re] of checks) {
    setup({ facts });
    copy.upsert(cfg({ minLiquidityUsd: null, ...over }));
    copy.onWalletTrade(trade());
    await new Promise((r) => setTimeout(r, 30));
    const rows = copy.snapshot().recent;
    assert.equal(rows[0].state, 'skipped');
    assert.match(rows[0].reason, re);
  }
});

test('paper mode never calls the live buy path', async () => {
  const h = setup();
  copy.upsert(cfg({ mode: 'paper' }));
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0, 'paper must not touch the signer');
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

// ── Live gating ───────────────────────────────────────────────────────

test('live mode calls the buy path and records the fill', async () => {
  const h = setup();
  copy.upsert(cfg({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 }));
  copy.onWalletTrade(trade({ sol: 5 }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 1);
  assert.equal(h.calls.buys[0].sol, 0.05);
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

test('a blocked live copy is skipped with the reason, and does not buy', async () => {
  const h = setup({ liveBlockedReason: 'the engine is not armed' });
  copy.upsert(cfg({ mode: 'live' }));
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /not armed/);
});

test('a failed live buy is recorded, not silently dropped', async () => {
  const h = setup({ buyResult: { ok: false, message: 'relayer rejected' } });
  copy.upsert(cfg({ mode: 'live' }));
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent[0].state, 'skipped');
  assert.match(copy.snapshot().recent[0].reason, /relayer rejected/);
});

// ── Limits ────────────────────────────────────────────────────────────

test('the daily trade limit stops further copies', async () => {
  setup();
  copy.upsert(cfg({ dailyTradeLimit: 2 }));
  for (let i = 0; i < 4; i++) {
    copy.onWalletTrade(trade({ mint: `Mint${i}${'1'.repeat(36)}` }));
    await new Promise((r) => setTimeout(r, 15));
  }
  const st = Object.values(copy.snapshot().stats)[0];
  assert.equal(st.trades, 2, 'only two should have opened');
  assert.equal(st.blocked, 2, 'the rest are recorded as limit-blocked');
});

test('other wallets are ignored', async () => {
  const h = setup();
  copy.upsert(cfg());
  copy.onWalletTrade(trade({ wallet: 'Someone1111111111111111111111111111111111' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent.length, 0);
});

test('a disabled config copies nothing', async () => {
  setup();
  copy.upsert(cfg({ enabled: false }));
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent.length, 0);
});

test('copySells off leaves the position open when they sell', async () => {
  setup();
  copy.upsert(cfg({ copySells: false, delayMs: 0 }));
  copy.onWalletTrade(trade({ isBuy: true }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.002 }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

// ── Stats ─────────────────────────────────────────────────────────────

test('win rate is null until something closes', () => {
  assert.equal(winRate({ wins: 0, losses: 0 }), null);
  assert.equal(winRate({ wins: 3, losses: 1 }), 75);
});

test('activeWallets lists only enabled configs', () => {
  setup();
  copy.upsert(cfg({ enabled: true }));
  copy.upsert(cfg({ wallet: 'Other111111111111111111111111111111111111', enabled: false }));
  const active = copy.activeWallets();
  assert.equal(active.has(WALLET), true);
  assert.equal(active.size, 1);
});

test('following the same wallet twice is refused', () => {
  setup();
  assert.equal(copy.upsert(cfg()).ok, true);
  assert.equal(copy.upsert(cfg()).ok, false);
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
  console.log(`copytrade: ${passed}/${cases.length} tests passed`);
}

await run();
