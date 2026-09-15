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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as copy from './.copytrade.mjs';
import { COPY_LATENCY_FLOOR_MS, MIN_TRIPS_FOR_RANK, TOO_FAST_FLAG_PCT, copySize, defaultConfig, emptyLeaderStats, leaderTooFast, leaderWinRate, rankLeaders, validateConfig, winRate } from './.copyshared.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// Base58 has no lowercase L, and validateConfig now checks the real
// alphabet rather than a bare length, so "Whale" is not a valid address.
const WALLET = 'Whae1111111111111111111111111111111111111';
const MINT = 'CopyMint111111111111111111111111111111111';

function makeHost(over = {}) {
  // `opts` is recorded SEPARATELY: the pinned sell assertion is a deepEqual
  // on { mint, pct } and must stay exactly that shape.
  const calls = { buys: [], sells: [], toasts: [], buyOpts: [], sellOpts: [] };
  const host = {
    buy: async (mint, sol, opts) => {
      calls.buys.push({ mint, sol });
      calls.buyOpts.push(opts);
      if (over.buyMs) await new Promise((r) => setTimeout(r, over.buyMs));
      return over.buyResult ?? { ok: true, message: 'bought', signature: 'sig' };
    },
    sell: async (mint, pct, opts) => {
      calls.sells.push({ mint, pct });
      calls.sellOpts.push(opts);
      return over.sellResult ?? { ok: true, message: 'sold', signature: 'sellsig' };
    },
    liveBlockedReason: () => over.liveBlockedReason ?? null,
    priceSol: () => (over.priceSol === undefined ? 0.001 : over.priceSol),
    tokenFacts: async () =>
      over.facts ?? { liquidityUsd: 50_000, marketCapUsd: 100_000, kryptScore: 80, isPumpfun: true },
    log: () => {},
    toast: (level, message) => calls.toasts.push({ level, message }),
    changed: () => {},
  };
  // The optional methods exist only when a test asks for them — the module
  // must work against a host that implements none of them.
  if (over.ourCostBasisSol !== undefined) host.ourCostBasisSol = () => over.ourCostBasisSol;
  if (over.buyBlockedReason !== undefined) host.buyBlockedReason = () => over.buyBlockedReason;
  if (over.maxLiveSol !== undefined) host.maxLiveSol = () => over.maxLiveSol;
  if (over.leaderHolding !== undefined) {
    calls.holdingReads = [];
    host.leaderHolding = async (w, m) => {
      calls.holdingReads.push({ wallet: w, mint: m });
      if (typeof over.leaderHolding === 'function') return over.leaderHolding();
      return over.leaderHolding;
    };
  }
  return { calls, host };
}

function setup(over = {}) {
  copy._reset();
  const h = makeHost(over);
  copy.attach(h.host);
  return h;
}

const cfg = (over = {}) => ({ ...defaultConfig(WALLET, 'Sharky'), enabled: true, ...over });

// Creating a LIVE follower never arms it — one `copy:save` must not be able to
// start spending real SOL — so a test that wants an armed live config saves
// twice, which is exactly what the user does.
const save = (over = {}) => {
  const c = cfg(over);
  const r = copy.upsert(c);
  if (!r.ok) return r;
  const made = copy.all().find((x) => x.wallet === c.wallet);
  if (made && c.enabled && !made.enabled) return copy.upsert({ ...c, id: made.id });
  return r;
};

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
  save({ delayMs: 5 });
  copy.onWalletTrade(trade({ priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 60));

  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.ok(open, 'a copy should have opened');
  assert.equal(open.entryPriceSol, 0.0015, 'filling at their price would flatter the record');
});

test('a paper round trip pays BOTH sides of every fee a real one would', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 20));
  // They sell at exactly the entry price: a fee-free model would show 0.
  copy.onWalletTrade(trade({ isBuy: false, priceSol: 0.001, soldFraction: 1 }));
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
  save({ minLiquidityUsd: 5000 });
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
    save({ minLiquidityUsd: null, ...over });
    copy.onWalletTrade(trade());
    await new Promise((r) => setTimeout(r, 30));
    const rows = copy.snapshot().recent;
    assert.equal(rows[0].state, 'skipped');
    assert.match(rows[0].reason, re);
  }
});

test('paper mode never calls the live buy path', async () => {
  const h = setup();
  save({ mode: 'paper' });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0, 'paper must not touch the signer');
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

// ── Live gating ───────────────────────────────────────────────────────

test('live mode calls the buy path and records the fill', async () => {
  const h = setup();
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ sol: 5 }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 1);
  assert.equal(h.calls.buys[0].sol, 0.05);
  assert.equal(copy.snapshot().recent[0].state, 'open');
});

test('a blocked live copy is skipped with the reason, and does not buy', async () => {
  const h = setup({ liveBlockedReason: 'the engine is not armed' });
  save({ mode: 'live' });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /not armed/);
});

test('a failed live buy is recorded, not silently dropped', async () => {
  const h = setup({ buyResult: { ok: false, message: 'relayer rejected' } });
  save({ mode: 'live' });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent[0].state, 'skipped');
  assert.match(copy.snapshot().recent[0].reason, /relayer rejected/);
});

// ── Limits ────────────────────────────────────────────────────────────

test('the daily trade limit stops further copies', async () => {
  setup();
  save({ dailyTradeLimit: 2 });
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
  save();
  copy.onWalletTrade(trade({ wallet: 'Someone1111111111111111111111111111111111' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent.length, 0);
});

test('a disabled config copies nothing', async () => {
  setup();
  save({ enabled: false });
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(copy.snapshot().recent.length, 0);
});

// ── Mirrored sells (2026-09-08) ───────────────────────────────────────
//
// A user's report: copied buys landed, then "the first TP sold 40 %" and
// the history said the later sells happened while the wallet still held
// the coins. The 40 % was their own take-profit ladder; the copier had
// never placed a sell at all — a leader's sell only flipped the record to
// "closed". These pin the real thing: a live copy sells the leader's share
// of what WE hold, through the host, and the record moves only on a fill.

const tick = () => new Promise((r) => setTimeout(r, 25));

async function openLiveCopy(over = {}) {
  const h = setup({ priceSol: 0.001, ...over });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'buy1' }));
  await tick();
  assert.equal(h.calls.buys.length, 1, 'the copy bought');
  return h;
}

test('LIVE: a leader who sells 40 % makes us sell 40 % of OUR holding, and only that share is closed', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sell1' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }], 'one sell of 40 % of what we hold');
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(parent.state, 'open', 'most of the copy is still held');
  assert.equal(parent.remainingPct, 60);
  assert.equal(exit.state, 'closed');
  assert.equal(exit.soldPct, 40);
  assert.equal(exit.signature, 'sellsig');
  assert.ok(Math.abs(exit.ourSol - 0.4) < 1e-9, 'the slice is 40 % of the 1 SOL cost basis');
  // Doubled price, fees on both sides: 0.4 × (2 × 0.985 − 1.015) = 0.382
  assert.ok(Math.abs(exit.pnlSol - 0.382) < 1e-9, `slice PnL ${exit.pnlSol}`);
  assert.ok(Math.abs(parent.realizedSol - 0.382) < 1e-9, 'the copy carries what it has realised so far');
  assert.equal(parent.pnlSol, null, 'and no PnL of its own, so nothing counts twice');
  const stats = snap.stats[snap.configs[0].id];
  assert.equal(stats.trades, 1, 'an exit is not a trade');
  assert.ok(Math.abs(stats.realizedPnlSol - 0.382) < 1e-9);
  assert.ok(Math.abs(stats.openCostSol - 0.6) < 1e-9, 'open cost is what is still held');
  assert.ok(h.calls.toasts.some((t) => t.level === 'success' && /Copied sell: 40%/.test(t.message)));
});

test('LIVE: a second sell mirrors the share of what is LEFT, and the last one closes the copy', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sell1' }));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1.2, priceSol: 0.002, soldFraction: 1, signature: 'sell2' }));
  await tick();
  await tick();
  assert.deepEqual(h.calls.sells.map((s) => s.pct), [40, 100], 'they sold the rest, so we sell all of what is left');
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exits = snap.recent.filter((t) => t.kind === 'exit');
  assert.equal(parent.state, 'closed');
  assert.equal(parent.remainingPct, 0);
  assert.equal(exits.length, 2);
  const total = exits.reduce((a, e) => a + e.pnlSol, 0);
  // The whole 1 SOL went out at double: 1 × (2 × 0.985 − 1.015) = 0.955
  assert.ok(Math.abs(total - 0.955) < 1e-9, `both slices together ${total}`);
  assert.ok(Math.abs(parent.realizedSol - 0.955) < 1e-9);
});

test('LIVE: a sell that fails leaves the copy open and records why — never a phantom fill', async () => {
  const h = await openLiveCopy({ sellResult: { ok: false, message: 'Simulation reverted: Overflow (6024)' } });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 0.5, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(parent.state, 'open');
  assert.equal(parent.remainingPct ?? 100, 100, 'nothing was sold, nothing is closed');
  assert.equal(exit.state, 'skipped');
  assert.match(exit.reason, /Overflow/);
  assert.ok(h.calls.toasts.some((t) => t.level === 'error' && /Copy sell failed/.test(t.message)));
});

test('LIVE: a sell while live is blocked is recorded as not executed, and does not call the host', async () => {
  const h = await openLiveCopy();
  h.host.liveBlockedReason = () => 'the engine is not armed';
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0);
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.match(snap.recent.find((t) => t.kind === 'exit').reason, /not executed — the engine is not armed/);
});

test('LIVE: when our own orders already emptied the bag, the copy closes with that said, not a fill', async () => {
  const h = await openLiveCopy({ sellResult: { ok: false, message: 'nothing to sell (zero token balance)' } });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 'sell1' }));
  await tick();
  const parent = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(parent.state, 'closed');
  assert.equal(parent.pnlSol, null, 'we do not know what our own exit made — the ledger does');
  assert.match(parent.reason, /nothing left to sell/);
  assert.equal(copy.snapshot().recent.filter((t) => t.kind === 'exit').length, 0);
});

test('LIVE: an unrecoverable fraction is NOT mirrored — a trim must never become a dump', async () => {
  const h = await openLiveCopy();
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0);
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.match(snap.recent.find((t) => t.kind === 'exit').reason, /could not be read/);
  // And the user is TOLD they still hold it — this is the case where doing
  // nothing leaves them fully exposed, so it must not be a quiet warning.
  const said = h.calls.toasts.at(-1);
  assert.equal(said.level, 'error');
  assert.match(said.message, /still hold it|sell by hand/i);
});

// ── Recovering a sell size the transaction did not carry ──────────────
//
// The user-facing bug (2026-09-13): "when someone sells and they can't tell
// how much it is, it just doesn't sell". `soldFraction` is decoded from the
// transaction's pre-balances, which carry an `owner` only on newer RPC
// replies; without it the fraction is null and the mirror gave up. Their
// holding AFTER the sell plus the tokens it moved is what they held before,
// so one balance read recovers the exact fraction.

test('an unreadable sell size is RECOVERED from the leader’s balance', async () => {
  // They sold 600 and have 400 left → they sold 60 % of their bag.
  const h = await openLiveCopy({ leaderHolding: 400 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, tokens: 600, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1, 'the sell is mirrored, not skipped');
  assert.equal(h.calls.sells[0].pct, 60);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').remainingPct, 40);
});

test('a leader who fully exits is mirrored as a FULL exit', async () => {
  // Nothing left: the case that matters most, and the one that used to sell
  // nothing at all.
  const h = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, tokens: 1000, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 1);
  assert.equal(h.calls.sells[0].pct, 100);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('recovery needs the token count — without it nothing is guessed', async () => {
  const h = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'no count, no read, no mirror');
  assert.equal(h.calls.holdingReads.length, 0, 'and no request spent on it');
});

test('an unreadable balance leaves the sell unmirrored — never a guessed dump', async () => {
  const h = await openLiveCopy({ leaderHolding: null });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: null, tokens: 600, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.holdingReads.length, 1, 'it tried');
  assert.equal(h.calls.sells.length, 0, 'and refused to invent a size');
});

test('a fraction the transaction DID carry is used as-is, with no balance read', async () => {
  const h = await openLiveCopy({ leaderHolding: 0 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 0.25, tokens: 250, signature: 'sell1' }));
  await tick();
  assert.equal(h.calls.sells[0].pct, 25);
  assert.equal(h.calls.holdingReads.length, 0, 'the cheap path stays cheap');
});

test('PAPER: a partial sell is bookkeeping only — same slices, no order', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.5, priceSol: 0.002, soldFraction: 0.25, signature: 's' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'paper never sells');
  const snap = copy.snapshot();
  const parent = snap.recent.find((t) => t.kind !== 'exit');
  const exit = snap.recent.find((t) => t.kind === 'exit');
  assert.equal(parent.state, 'open');
  assert.equal(parent.remainingPct, 75);
  assert.equal(exit.soldPct, 25);
  assert.equal(exit.signature, null);
});

test('exits do not spend the daily copy limit, but their losses count toward the daily loss limit', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0, dailyTradeLimit: 2, dailyLossLimitSol: 0.5 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  // They scale out in three sells at a quarter of entry — three exits, one copy.
  for (const [i, f] of [0.3, 0.5, 1].entries()) {
    copy.onWalletTrade(trade({ isBuy: false, sol: 0.1, priceSol: 0.00025, soldFraction: f, signature: `s${i}` }));
    await tick();
  }
  assert.equal(h.calls.sells.length, 3);
  const stats = copy.snapshot().stats[copy.snapshot().configs[0].id];
  assert.equal(stats.trades, 1, 'three exits are still one trade');
  assert.ok(stats.realizedPnlSol < -0.5, `the round trip lost ${stats.realizedPnlSol}`);
  // Second copy: the count limit (2) is not hit by the exits, the LOSS limit is.
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b2' }));
  await tick();
  assert.equal(h.calls.buys.length, 1, 'no second buy');
  assert.match(copy.snapshot().recent[0].reason, /limit: down/);
});

test('copySells off leaves the position open when they sell', async () => {
  setup();
  save({ copySells: false, delayMs: 0 });
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
  save({ enabled: true });
  save({ wallet: 'Other111111111111111111111111111111111111', enabled: false });
  const active = copy.activeWallets();
  assert.equal(active.has(WALLET), true);
  assert.equal(active.size, 1);
});

test('following the same wallet twice is refused', () => {
  setup();
  assert.equal(save().ok, true);
  assert.equal(save().ok, false);
});

test('a copy config carries the wallet it signs with, and refuses a wallet that is not one', () => {
  // A config names the wallet it signs with (2026-09-11), or leaves it on
  // the active one. A blank or a non-string is refused — a wallet id that
  // is not a wallet is not "the active wallet by accident".
  assert.equal(validateConfig(cfg({})).ok, true, 'absent means the active wallet');
  assert.equal(validateConfig(cfg({ walletId: null })).ok, true, 'null means the active wallet');
  assert.equal(validateConfig(cfg({ walletId: 'w_abc' })).ok, true, 'a wallet id is accepted here; main checks it is ours');
  assert.equal(validateConfig(cfg({ walletId: '' })).ok, false, 'a blank is not a wallet');
  assert.equal(validateConfig(cfg({ walletId: 42 })).ok, false, 'nor is a number');
  assert.equal(defaultConfig('', '').walletId, null, 'a new config starts on the active wallet');
});

// ── Every chain (2026-09-11) ────────────────────────────────────────────
//
// A config lives on a chain. Robinhood Chain and BNB leaders arrive from the
// Observatory's trade feed with `chain` set and 0x addresses; the engine's
// math is the same, the units are that chain's coin, and the host is told
// which chain every buy, sell, price and fact is for.

const EVM_LEADER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const EVM_MINT = '0x9C4C60cEEa0000000000000000000000000000AA';

test('a config on an EVM chain wants a 0x address; a Solana one wants base58', () => {
  assert.equal(validateConfig(cfg({ chain: 'robinhood', wallet: EVM_LEADER })).ok, true);
  assert.equal(validateConfig(cfg({ chain: 'bnb', wallet: EVM_LEADER })).ok, true);
  assert.equal(validateConfig(cfg({ chain: 'robinhood', wallet: WALLET })).ok, false, 'a Solana address is not a Robinhood one');
  assert.equal(validateConfig(cfg({ chain: 'solana', wallet: EVM_LEADER })).ok, false, 'nor the other way');
  assert.equal(validateConfig(cfg({ wallet: WALLET })).ok, true, 'no chain means Solana, as every saved config did');
  assert.equal(defaultConfig('', '', 'bnb').chain, 'bnb');
  assert.equal(defaultConfig('', '').chain, 'solana');
});

test('an EVM leader is matched by chain and case-insensitively, and the host is told the chain', async () => {
  const h = setup();
  // The address is stored lower-cased; the helper re-finds it by that.
  save({ chain: 'robinhood', wallet: EVM_LEADER.toLowerCase(), mode: 'live' });
  // The same address string on BNB is a different leader: nothing fires.
  copy.onWalletTrade(trade({ chain: 'bnb', wallet: EVM_LEADER.toLowerCase(), mint: EVM_MINT, sol: 0.5, priceSol: 0.001 }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.calls.buys.length, 0, 'a BNB trade does not fire a Robinhood config');
  // On the right chain, in any case, it does — and the buy is told the chain.
  copy.onWalletTrade(trade({ chain: 'robinhood', wallet: EVM_LEADER.toUpperCase().replace('0X', '0x'), mint: EVM_MINT, sol: 0.5, priceSol: 0.001, signature: '0xaa' }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.calls.buys.length, 1, 'a Robinhood trade fires it');
  assert.equal(h.calls.buys[0].mint, EVM_MINT.toLowerCase(), 'the mint is lower-cased on entry');
  assert.equal(h.calls.buyOpts[0].chain, 'robinhood', 'the host knows which rail to buy on');
  const open = copy.snapshot().recent.find((t) => t.state === 'open');
  assert.ok(open, 'the copy is recorded');
  assert.equal(open.chain, 'robinhood', 'and remembers its chain');
});

test('a mark-to-market for one chain leaves the same mint on another alone', () => {
  const h = setup();
  copy._load(
    [{ ...cfg({ id: 'r', chain: 'robinhood', wallet: EVM_LEADER.toLowerCase(), mode: 'paper' }), id: 'r', createdAt: 1 }],
    [
      { id: 'a', configId: 'r', mode: 'paper', chain: 'robinhood', wallet: EVM_LEADER.toLowerCase(), mint: EVM_MINT.toLowerCase(), symbol: 'X', at: 1, theirSol: 1, ourSol: 0.1, entryPriceSol: 0.001, exitPriceSol: null, closedAt: null, pnlSol: null, state: 'open', reason: null },
      { id: 'b', configId: 'r', mode: 'paper', chain: 'bnb', wallet: EVM_LEADER.toLowerCase(), mint: EVM_MINT.toLowerCase(), symbol: 'X', at: 1, theirSol: 1, ourSol: 0.1, entryPriceSol: 0.001, exitPriceSol: null, closedAt: null, pnlSol: null, state: 'open', reason: null },
    ],
  );
  copy.markToMarket(EVM_MINT.toLowerCase(), 0.002, 'robinhood');
  const rows = copy.snapshot().recent;
  assert.equal(rows.find((t) => t.id === 'a').exitPriceSol, 0.002, 'the Robinhood copy is marked');
  assert.equal(rows.find((t) => t.id === 'b').exitPriceSol, null, 'the BNB copy of the same address is not');
  assert.deepEqual(copy.openMints('bnb'), [EVM_MINT.toLowerCase()]);
  assert.deepEqual([...copy.activeWallets('bnb')], [], 'no BNB config is enabled');
  void h;
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

// ── The same transaction from two feeds is one trade ─────────────────
// A leader's pump.fun trade arrives from the curve firehose AND from the
// wallet watcher's own subscription; the signature dedupes the pair.
test('a signature seen twice is evaluated once', async () => {
  const h = setup({ priceSol: 0.001 });
  save();
  copy.onWalletTrade(trade({ signature: 'sigSame' }));
  copy.onWalletTrade(trade({ signature: 'sigSame' }));
  await new Promise((r) => setTimeout(r, 40));
  const mine = copy.snapshot().recent.filter((t) => t.mint === MINT);
  assert.equal(mine.length, 1, 'one record for one transaction');
  // Trades without a signature (the simulator, tests) are not deduped.
  copy.onWalletTrade(trade());
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(copy.snapshot().recent.filter((t) => t.mint === MINT).length, 3);
  assert.deepEqual(copy.openMints(), [MINT], 'open copies name their mints for the price poll');
});

// ── The leader's own record ───────────────────────────────────────────
//
// The copy scorecard answers "what did following them do for ME"; this
// answers "are they any good" — scored from every swap seen, whether or not
// a copy happened, and never from proceeds whose cost was not seen.

const sell = (over = {}) => trade({ isBuy: false, ...over });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('LEADER: a buy and a full sell make one scored round trip with THEIR result, copied or not', async () => {
  setup();
  save({ minKryptScore: 99 }); // the copy itself is filtered out…
  const t0 = Date.now() - 60_000;
  copy.onWalletTrade(trade({ at: t0 })); // 1 SOL → 1000 tokens
  copy.onWalletTrade(sell({ sol: 1.5, priceSol: 0.0015, soldFraction: 1, at: t0 + 30_000 }));
  await new Promise((r) => setTimeout(r, 40));
  const s = copy.snapshot();
  assert.equal(s.stats[s.configs[0].id].skipped, 1, '…and recorded as such');
  const L = s.leaders[WALLET];
  assert.equal(L.buys, 1);
  assert.equal(L.sells, 1);
  assert.equal(L.roundTrips, 1);
  assert.equal(L.wins, 1);
  assert.equal(L.losses, 0);
  assert.ok(near(L.realizedPnlSol, 0.5), 'they made +0.5');
  assert.ok(near(L.returnPct, 50));
  assert.ok(near(L.volumeSol, 1));
  assert.equal(L.openCount, 0);
  assert.equal(L.avgHoldMs, 30_000);
  assert.equal(L.bestSol, L.worstSol);
  assert.equal(L.recentTrips[0].symbol, 'COPY');
  assert.equal(L.watchedSince, t0);
});

test('LEADER: a partial sell scores its share; the rest stays open and marks to the last price', async () => {
  setup();
  save();
  copy.onWalletTrade(trade()); // 1 SOL, 1000 tokens
  copy.onWalletTrade(sell({ sol: 0.6, priceSol: 0.0015, soldFraction: 0.4 })); // 400 tokens for 0.6
  await new Promise((r) => setTimeout(r, 40));
  let L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 0);
  assert.equal(L.openCount, 1);
  assert.ok(near(L.realizedPnlSol, 0.2), '0.6 back against 0.4 of cost');
  assert.ok(near(L.openCostSol, 0.6));
  assert.ok(near(L.unrealizedPnlSol, 600 * 0.0015 - 0.6), 'marked at their fill');
  copy.markToMarket(MINT, 0.002);
  L = copy.snapshot().leaders[WALLET];
  assert.ok(near(L.unrealizedPnlSol, 600 * 0.002 - 0.6), 'marked at the tape');
  copy.onWalletTrade(sell({ sol: 1.2, priceSol: 0.002, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 40));
  L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 1);
  assert.ok(near(L.realizedPnlSol, 0.8), '+0.2 then +0.6');
  assert.equal(L.openCount, 0);
  assert.equal(L.unrealizedPnlSol, null);
});

test('LEADER: a sell of tokens bought before we watched is counted, never scored', async () => {
  setup();
  save();
  copy.onWalletTrade(sell({ sol: 3, priceSol: 0.003, soldFraction: 1 }));
  await new Promise((r) => setTimeout(r, 40));
  const L = copy.snapshot().leaders[WALLET];
  assert.equal(L.sells, 1);
  assert.equal(L.unscoredSells, 1);
  assert.equal(L.roundTrips, 0);
  assert.equal(L.realizedPnlSol, 0);
  assert.equal(L.returnPct, null);
});

test('LEADER: a sell bigger than the tracked position scores only the tracked share', async () => {
  setup();
  save();
  copy.onWalletTrade(trade()); // 1000 tracked
  copy.onWalletTrade(sell({ sol: 4, priceSol: 0.002, tokens: 2000, soldFraction: 1 })); // they sold 2000
  await new Promise((r) => setTimeout(r, 40));
  const L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 1);
  assert.ok(near(L.realizedPnlSol, 1), 'half the proceeds (2 SOL) against the 1 SOL cost');
  assert.equal(L.unscoredSells, 1, 'the other half had no known cost');
});

test('LEADER: a losing trip is a loss; best/worst, rate and order follow', async () => {
  setup();
  save();
  const M2 = 'CopyMint222222222222222222222222222222222';
  copy.onWalletTrade(trade());
  copy.onWalletTrade(sell({ sol: 0.5, priceSol: 0.0005, soldFraction: 1 })); // −0.5
  copy.onWalletTrade(trade({ mint: M2, symbol: 'TWO' }));
  copy.onWalletTrade(sell({ mint: M2, symbol: 'TWO', sol: 2, priceSol: 0.002, soldFraction: 1 })); // +1
  await new Promise((r) => setTimeout(r, 40));
  const L = copy.snapshot().leaders[WALLET];
  assert.equal(L.roundTrips, 2);
  assert.equal(L.wins, 1);
  assert.equal(L.losses, 1);
  assert.ok(near(L.realizedPnlSol, 0.5));
  assert.ok(near(L.bestSol, 1));
  assert.ok(near(L.worstSol, -0.5));
  assert.ok(near(L.tradesPerDay, 4), 'four swaps inside the first day');
  assert.equal(L.recentTrips[0].symbol, 'TWO', 'newest first');
});

test('LEADER: the record survives a reload, resets on request, and goes with the last config', async () => {
  setup();
  save();
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 40));
  const book = JSON.parse(JSON.stringify(copy._leaders()));
  const configs = copy.all();
  copy._reset();
  copy.attach(makeHost().host);
  copy._load(configs, [], book);
  assert.equal(copy.snapshot().leaders[WALLET].openCount, 1, 'reloaded from the file');
  assert.equal(copy.resetLeader('Nobody11111111111111111111111111111111111').ok, false);
  assert.equal(copy.resetLeader(WALLET).ok, true);
  assert.equal(copy.snapshot().leaders[WALLET].buys, 0, 'cleared; the config stays');
  copy.onWalletTrade(trade());
  await new Promise((r) => setTimeout(r, 40));
  copy.remove(configs[0].id);
  assert.equal(copy.snapshot().leaders[WALLET], undefined, 'gone with the last config');
});

test('rankLeaders: the chosen key, small samples last, unknowns after everything', () => {
  const mk = (wallet, over) => ({ ...emptyLeaderStats(wallet), ...over });
  const list = [
    mk('small-but-huge', { roundTrips: 2, wins: 2, realizedPnlSol: 9 }),
    mk('steady', { roundTrips: 8, wins: 6, losses: 2, realizedPnlSol: 1.2, returnPct: 20 }),
    mk('loser', { roundTrips: 6, wins: 1, losses: 5, realizedPnlSol: -2, returnPct: -40 }),
    mk('unknown', { roundTrips: 5, wins: 3, losses: 2, realizedPnlSol: 0.4, returnPct: null }),
  ];
  assert.deepEqual(rankLeaders(list, 'realizedPnlSol').map((l) => l.wallet), ['steady', 'unknown', 'loser', 'small-but-huge']);
  assert.deepEqual(rankLeaders(list, 'returnPct').map((l) => l.wallet), ['steady', 'loser', 'unknown', 'small-but-huge']);
  assert.deepEqual(rankLeaders(list, 'winRatePct').map((l) => l.wallet), ['steady', 'unknown', 'loser', 'small-but-huge']);
  assert.equal(leaderWinRate(list[0]), 100);
  assert.equal(leaderWinRate(emptyLeaderStats('x')), null);
});

// ── Followability (2026-09-14) ────────────────────────────────────────
//
// Measured over 9.3M curve trades across two day-pairs six weeks apart
// (docs/wallet-convergence-2026-09-14.md), the MEDIAN profitable pump wallet
// holds six seconds. Its edge is latency, and a copy cannot take it: the trade
// is over before the follower's buy lands. Ranking by the wallet's own profit
// therefore surfaces exactly the wallets a user cannot copy, which is why the
// flag exists — and why it must stay a WARNING and never become a score.

test('leaderTooFast: flags wallets whose trips end before a copy could join', () => {
  const mk = (wallet, over) => ({ ...emptyLeaderStats(wallet), ...over });
  const sniper = mk('sniper', { roundTrips: 10, tooFastPct: 90, medianHoldMs: 6_000 });
  const slow = mk('slow', { roundTrips: 10, tooFastPct: 5, medianHoldMs: 20 * 60_000 });
  assert.equal(leaderTooFast(sniper), true);
  assert.equal(leaderTooFast(slow), false);

  // Unmeasured is NOT fast. A wallet with no closed trips must never be
  // labelled — the honest-null rule; an em dash, never an accusation.
  assert.equal(leaderTooFast(mk('fresh', { roundTrips: 10, tooFastPct: null })), false);
  assert.equal(leaderTooFast(emptyLeaderStats('empty')), false);

  // Too small a sample cannot earn the flag either, same floor as the ranking.
  assert.equal(leaderTooFast(mk('tiny', { roundTrips: MIN_TRIPS_FOR_RANK - 1, tooFastPct: 100 })), false);

  // The boundary is inclusive, and it is the documented constant.
  assert.equal(leaderTooFast(mk('edge', { roundTrips: 5, tooFastPct: TOO_FAST_FLAG_PCT })), true);
  assert.equal(leaderTooFast(mk('under', { roundTrips: 5, tooFastPct: TOO_FAST_FLAG_PCT - 0.1 })), false);
});

test('Hold time ranks longest first, and an unmeasured hold sorts last', () => {
  const mk = (wallet, over) => ({ ...emptyLeaderStats(wallet), ...over });
  const list = [
    mk('sniper', { roundTrips: 9, medianHoldMs: 6_000 }),
    mk('swing', { roundTrips: 9, medianHoldMs: 45 * 60_000 }),
    mk('unknown', { roundTrips: 9, medianHoldMs: null }),
    mk('scalp', { roundTrips: 9, medianHoldMs: 90_000 }),
  ];
  assert.deepEqual(
    rankLeaders(list, 'medianHoldMs').map((l) => l.wallet),
    ['swing', 'scalp', 'sniper', 'unknown'],
  );
});

test('the copy-latency floor stays a minute, and above any realistic sniper hold', () => {
  // Pinned because lowering it would quietly un-flag the six-second wallets
  // the measurement was about.
  assert.equal(COPY_LATENCY_FLOOR_MS, 60_000);
  assert.ok(COPY_LATENCY_FLOOR_MS > 6_000, 'must exceed the measured median sniper hold');
});

// ── The pump rail's mirrored sell (copy-13, 2026-09-09) ───────────────
//
// A leader's pump.fun sell arrives twice. The curve firehose reads a LOG,
// which has no pre-balance, so its delivery carries no soldFraction; the
// wallet watcher has the fraction but must fetch the transaction first and
// therefore always arrives second. Deduping on the signature alone threw
// away the only delivery that could be mirrored, so the mirrored sell was
// dead for every pump.fun leader — the exact bug it was written to fix.

test('a sell delivered firehose-then-watcher sells exactly ONCE, on the delivery that knows the share', async () => {
  const h = await openLiveCopy();
  // 1. The firehose: same signature, no fraction.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, signature: 'sellDup' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'nothing can be sized from a log-only delivery');
  assert.equal(copy.snapshot().recent.filter((x) => x.kind === 'exit').length, 1, 'the skip is on the record');

  // 2. The watcher: SAME signature, now with the share they sold.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sellDup' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }], 'exactly one sell, of the share they sold');

  const snap = copy.snapshot();
  const parent = snap.recent.find((x) => x.kind !== 'exit');
  const exits = snap.recent.filter((x) => x.kind === 'exit');
  assert.equal(parent.remainingPct, 60, 'and only that share is closed');
  assert.equal(exits.length, 1, 'the superseded "could not tell" row is withdrawn');
  assert.equal(exits[0].state, 'closed');
  assert.equal(exits[0].soldPct, 40);
});

test('a third delivery of the same sell changes nothing, in either order', async () => {
  const h = await openLiveCopy();
  // Watcher first this time, then the firehose's fraction-less duplicate.
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sellOnce' }));
  await tick();
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, signature: 'sellOnce' }));
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sellOnce' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }], 'still one sell');
  assert.equal(copy.snapshot().recent.filter((x) => x.kind === 'exit').length, 1, 'and one exit row');
});

// ── Budgets are checked against copies in flight (copy-1) ─────────────

test('a burst of trades in one slot cannot out-run the daily limit', async () => {
  // Every check used to read a counter that only moved after the buy came
  // back, so eight swaps delivered together passed the same check eight
  // times. A slot is taken before the first await now.
  const h = setup({ buyMs: 40 });
  save({ mode: 'live', dailyTradeLimit: 2, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  for (let i = 0; i < 8; i++) copy.onWalletTrade(trade({ mint: `Burst${i}${'1'.repeat(35)}`, signature: `b${i}` }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.calls.buys.length, 2, `two buys, not eight: ${h.calls.buys.length}`);
  const st = Object.values(copy.snapshot().stats)[0];
  assert.equal(st.trades, 2);
  assert.equal(st.blocked, 6, 'the other six are recorded as limit-blocked');
});

test('the per-minute wall refuses a burst even when the day has room', async () => {
  const h = setup({ buyMs: 20 });
  save({ mode: 'live', dailyTradeLimit: 50, maxCopiesPerMinute: 3, sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  for (let i = 0; i < 7; i++) copy.onWalletTrade(trade({ mint: `Fast${i}${'1'.repeat(36)}`, signature: `f${i}` }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.calls.buys.length, 3, `three copies a minute: ${h.calls.buys.length}`);
  const blocked = copy.snapshot().recent.filter((x) => /per minute/.test(x.reason ?? ''));
  assert.equal(blocked.length, 4, 'and the rest say why');
});

test('validation accepts a config with no per-minute field, and rejects a silly one', () => {
  const { maxCopiesPerMinute, ...without } = cfg();
  assert.equal(validateConfig(without).ok, true, 'an older saved config still loads');
  assert.equal(validateConfig(cfg({ maxCopiesPerMinute: 0 })).ok, false);
  assert.equal(validateConfig(cfg({ maxCopiesPerMinute: 500 })).ok, false);
  assert.equal(validateConfig(cfg({ maxCopiesPerMinute: 5 })).ok, true);
});

// ── A sell is a share of the WALLET, not of the copy (copy-2) ─────────

test('the mirrored percentage is scaled by the copy share of what we paid for the bag', async () => {
  // h.sell sells a percentage of the whole token account. We paid 1 SOL
  // through this copy but hold 5 SOL of the same token, so mirroring "they
  // sold 40 %" as 40 % would sell 2 SOL — 1.6 of it hand-bought.
  const h = await openLiveCopy({ ourCostBasisSol: 5 });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sc' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 8 }], '40 % of our fifth of the bag');
  const parent = copy.snapshot().recent.find((x) => x.kind !== 'exit');
  assert.equal(parent.remainingPct, 60, 'the RECORD still moves by the share they sold');
});

test('a host that cannot say what we paid mirrors the share unscaled', async () => {
  const h = await openLiveCopy({ ourCostBasisSol: null });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sc2' }));
  await tick();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 40 }]);
});

test('one save can never create an ARMED live follower', () => {
  setup();
  const r = copy.upsert(cfg({ mode: 'live', enabled: true }));
  assert.equal(r.ok, true);
  assert.equal(copy.all()[0].enabled, false, 'born live means born disarmed');
  assert.match(r.message, /disarmed/i, 'and it says so');
});

// ── A paper row can never cause a real sell (copy-3) ──────────────────

test('flipping a config to live does not sell the paper position it opened', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'pb' }));
  await tick();
  const id = copy.snapshot().configs[0].id;
  // The flip to live disarms it; arming again is a second, deliberate save.
  copy.upsert({ ...cfg({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 }), id });
  assert.equal(copy.all()[0].enabled, false, 'paper to live never stays armed');
  copy.upsert({ ...cfg({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 }), id });

  copy.onWalletTrade(trade({ isBuy: false, sol: 0.5, priceSol: 0.002, soldFraction: 0.5, signature: 'ps' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'a paper row is not a reason to broadcast');
  const exits = copy.snapshot().recent.filter((x) => x.kind === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].mode, 'paper', 'and the exit is labelled for what it was');
  assert.equal(exits[0].signature, null, 'with no transaction against it');
});

test('flipping a LIVE config back to paper leaves the real position open and says so', async () => {
  const h = await openLiveCopy();
  const id = copy.snapshot().configs[0].id;
  copy.upsert({ ...cfg({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1 }), id });
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'lp' }));
  await tick();
  assert.equal(h.calls.sells.length, 0, 'paper mode places no order');
  const snap = copy.snapshot();
  assert.equal(snap.recent.find((x) => x.kind !== 'exit').state, 'open', 'the wallet still holds it');
  assert.match(snap.recent.find((x) => x.kind === 'exit').reason, /still held/);
});

// ── Filters refuse what they cannot check (copy-4) ────────────────────

test('a filter set against a fact the app cannot read REFUSES the copy', async () => {
  const h = setup({ facts: { liquidityUsd: null, marketCapUsd: null, kryptScore: null, isPumpfun: true } });
  save({ mode: 'live', minLiquidityUsd: 5_000 });
  copy.onWalletTrade(trade({ signature: 'unk1' }));
  await tick();
  assert.equal(h.calls.buys.length, 0, 'unknown is not "fine"');
  assert.match(copy.snapshot().recent[0].reason, /liquidity unknown/);
});

test('an unset filter still lets an unknown fact through', async () => {
  const h = setup({ facts: { liquidityUsd: null, marketCapUsd: null, kryptScore: null, isPumpfun: true } });
  save({ mode: 'live', minLiquidityUsd: null, maxMarketCapUsd: null, minKryptScore: null });
  copy.onWalletTrade(trade({ signature: 'unk2' }));
  await tick();
  assert.equal(h.calls.buys.length, 1, 'a filter you did not set cannot refuse anything');
});

// ── Size, price and caps come from the host (copy-5, copy-8) ──────────

test('a broadcast that has not confirmed opens the position, with that ON the record', async () => {
  const h = setup({ priceSol: 0.001, buyResult: { ok: false, pending: true, message: 'broadcast', signature: 'psig' } });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ signature: 'pend' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.state, 'open', 'the token was bought; the record must be able to close it');
  assert.match(row.reason, /not confirmed/);
});

test('the size and price on the record are what the host actually spent and filled', async () => {
  const h = setup({
    priceSol: 0.001,
    buyResult: { ok: true, message: 'bought', signature: 'sig', spentSol: 0.037, fillPriceSol: 0.0012 },
  });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ signature: 'spent' }));
  await tick();
  const row = copy.snapshot().recent[0];
  assert.equal(row.ourSol, 0.037, 'not the 0.05 we asked for');
  assert.equal(row.entryPriceSol, 0.0012, 'and not the spot price we guessed');
});

test('a copy above the live per-trade cap is REFUSED, never quietly shrunk', async () => {
  const h = setup({ priceSol: 0.001, maxLiveSol: 0.02 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 0.05, maxTradeSol: 0.1 });
  copy.onWalletTrade(trade({ signature: 'cap' }));
  await tick();
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /above your live cap/);
});

// ── The rest of the gates (copy-7, copy-9, copy-11) ───────────────────

test('the configured slippage reaches the host on both sides', async () => {
  const h = await openLiveCopy();
  assert.equal(h.calls.buyOpts[0].slippagePct, 15, 'the buy carries it');
  copy.onWalletTrade(trade({ isBuy: false, sol: 0.8, priceSol: 0.002, soldFraction: 0.4, signature: 'sl' }));
  await tick();
  assert.equal(h.calls.sellOpts[0].slippagePct, 15, 'and so does the sell');
});

test('a buy-side block stops a live copy even when selling is still allowed', async () => {
  const h = setup({ buyBlockedReason: 'the launch feed is stale' });
  save({ mode: 'live' });
  copy.onWalletTrade(trade({ signature: 'bb' }));
  await tick();
  assert.equal(h.calls.buys.length, 0);
  assert.match(copy.snapshot().recent[0].reason, /launch feed is stale/);
});

test('unfollowing a wallet mid-copy stops the copy that was in flight', async () => {
  const h = setup({ priceSol: 0.001, buyMs: 60 });
  save({ mode: 'live', delayMs: 30 });
  const id = copy.snapshot().configs[0].id;
  copy.onWalletTrade(trade({ signature: 'gone' }));
  await new Promise((r) => setTimeout(r, 10));
  copy.remove(id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.calls.buys.length, 0, 'the delay had not elapsed, and the config is gone');
  assert.equal(copy.snapshot().recent.length, 0, 'no orphan row against a config that no longer exists');
});

// ── The store on disk (copy-6, copy-10) ───────────────────────────────

function tempStore(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-copytest-'));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'copytrade.json'), contents, 'utf8');
  return dir;
}

test('a LIVE config does not resume armed after a restart; a paper one does', () => {
  copy._reset();
  const dir = tempStore(
    JSON.stringify({
      version: 1,
      configs: [
        { ...defaultConfig(WALLET, 'Live one'), id: 'c1', createdAt: 1, mode: 'live', enabled: true },
        { ...defaultConfig('Paper11111111111111111111111111111111111', 'Paper one'), id: 'c2', createdAt: 1, mode: 'paper', enabled: true },
      ],
      trades: [],
    }),
  );
  copy.init(dir);
  const [live, paper] = copy.all();
  assert.equal(live.enabled, false, 'an app closed for a week must not wake up spending');
  assert.equal(paper.enabled, true, 'paper costs nothing, and an interrupted experiment is useless');
  assert.equal(copy.failure(), null);
});

test('an unreadable store is NOT an empty one — nothing is overwritten', () => {
  copy._reset();
  const dir = tempStore(JSON.stringify({ version: 1, configs: [{ ...defaultConfig(WALLET, 'MY WHALE'), id: 'c1', createdAt: 1 }], trades: [] }));
  const file = path.join(dir, 'copytrade.json');
  fs.writeFileSync(file, '{"version":1,"configs":[{"wal', 'utf8'); // truncated write
  copy.init(dir);
  assert.equal(copy.all().length, 0, 'nothing could be loaded');
  assert.ok(copy.failure(), 'and the module knows it');
  assert.match(copy.snapshot().loadFailure, /corrupt/);

  // The proof: a save now must not blow away what is still on disk.
  save({ label: 'A NEW ONE' });
  return new Promise((r) =>
    setTimeout(() => {
      assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"configs":[{"wal', 'the file is untouched');
      r();
    }, 400),
  );
});

test('a first run writes normally — a missing file is not a failure', () => {
  copy._reset();
  const dir = tempStore();
  copy.init(dir);
  assert.equal(copy.failure(), null);
  save();
  return new Promise((r) =>
    setTimeout(() => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
      assert.equal(raw.configs.length, 1);
      r();
    }, 400),
  );
});

// ── The leader exits while our buy is still in flight ─────────────────
//
// `copyOnce` is slow on purpose: token facts, the configured delay, then a
// broadcast. The copy row does not exist until all of it returns, and a
// leader who sold inside that window used to hit `closeOpen`, find no open
// row, and return — the sell dropped on the floor, the buy landing a moment
// later into a position with no exit queued. A user reported 15 of 16
// matched buys recorded AFTER the leader had already exited (2026-09-13).

test('a leader sell during an in-flight buy is REMEMBERED, not dropped', async () => {
  // The buy takes 120 ms; the sell lands 20 ms in, while it is unrecallable.
  const h = setup({ priceSol: 0.001, buyMs: 120, leaderHolding: 0 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.buys.length, 1, 'the buy was already sent — it cannot be recalled');
  assert.equal(h.calls.sells.length, 1, 'and the parked sell fires the moment the row exists');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('a buy the leader exited BEFORE we sent is abandoned, not bought', async () => {
  // The delay is the window: nothing has been broadcast yet, so there is
  // still a real choice to make, and entering a position they have already
  // left is not copying them.
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 120 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.buys.length, 0, 'no real money went into a position they had left');
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(row.state, 'skipped');
  assert.match(row.reason, /already sold before this copy was sent/);
});

test('PAPER honours the same staleness rule, or the scorecard measures a strategy live would refuse', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 120 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 20));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.buys.length, 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'skipped');
});

// ── Rows whose tokens left through some other door ────────────────────

test('a live copy whose tokens are gone from the wallet is closed, not left open forever', async () => {
  const h = await openLiveCopy();
  const row = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(row.state, 'open');
  // Sold by hand, or by a stop-loss: the wallet holds none of it now.
  const n = copy.reconcileHoldings(new Set(), { graceMs: 0 });
  assert.equal(n, 1);
  const after = copy.snapshot().recent.find((t) => t.kind !== 'exit');
  assert.equal(after.state, 'closed');
  assert.equal(after.pnlSol, null, 'we never saw the exit price — a made-up one would poison the scorecard');
  assert.match(after.reason, /no longer in the wallet/);
  assert.equal(h.calls.sells.length, 0, 'nothing is sold by a reconcile');
});

test('a copy whose tokens ARE still held is left alone', async () => {
  await openLiveCopy();
  assert.equal(copy.reconcileHoldings(new Set([MINT]), { graceMs: 0 }), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
});

test('a freshly broadcast copy is inside the grace window and is NOT closed', async () => {
  await openLiveCopy();
  // The default grace: a buy that has not landed yet is not a sold position.
  assert.equal(copy.reconcileHoldings(new Set()), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
});

test('a PAPER copy is never reconciled against the chain — it was never on it', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  assert.equal(copy.reconcileHoldings(new Set(), { graceMs: 0 }), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  assert.equal(h.calls.sells.length, 0);
});

test('a reconcile scoped to other configs leaves this one alone', async () => {
  // A config can sign with a wallet that is not the active one; that
  // wallet's holdings say nothing about these tokens. Closing on them would
  // be the same bug pointed the other way.
  await openLiveCopy();
  const mine = copy.all()[0];
  assert.equal(copy.reconcileHoldings(new Set(), { graceMs: 0, configIds: new Set(['someone-else']) }), 0);
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  // Named explicitly, it closes.
  assert.equal(copy.reconcileHoldings(new Set(), { graceMs: 0, configIds: new Set([mine.id]) }), 1);
});

// ── Clearing paper results without losing anything else ───────────────
//
// "Remove" was the only way to start a paper record over, and it takes the
// config, the live history and the leader's own record with it — three
// different things (user report, 2026-09-13).

test('resetPaper clears paper rows and keeps configs, live rows and leader records', async () => {
  const h = setup({ priceSol: 0.001 });
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'live1' }));
  await tick();
  assert.equal(h.calls.buys.length, 1);
  const liveCfg = copy.all()[0];
  // A paper config on a second wallet, with a copy of its own.
  const W2 = 'Whae2222222222222222222222222222222222222';
  copy.upsert({ ...cfg({ wallet: W2, label: 'Paper', mode: 'paper' }) });
  const made = copy.all().find((c) => c.wallet === W2);
  copy.upsert({ ...cfg({ wallet: W2, label: 'Paper', mode: 'paper' }), id: made.id });
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'paper1' }));
  await tick();

  const leadersBefore = Object.keys(copy._leaders()).length;
  assert.ok(leadersBefore > 0, 'the leaders have a record to preserve');

  const r = copy.resetPaper();
  assert.equal(r.ok, true);
  assert.equal(r.cleared, 1, 'only the paper row went');

  const snap = copy.snapshot();
  assert.equal(copy.all().length, 2, 'both configs stay');
  assert.equal(copy.all().find((c) => c.wallet === W2).mode, 'paper', 'and their paper/live setting stays');
  assert.equal(snap.recent.filter((t) => t.mode === 'paper').length, 0);
  assert.equal(snap.recent.filter((t) => t.mode === 'live').length, 1, 'real money history is never rewritten');
  assert.equal(Object.keys(copy._leaders()).length, leadersBefore, 'their record is theirs, not a function of your paper run');
  assert.equal(snap.stats[liveCfg.id].trades, 1, 'the live scorecard is untouched');
});

test('resetPaper can target ONE config', async () => {
  setup({ priceSol: 0.001 });
  save({ mode: 'paper', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const W2 = 'Whae2222222222222222222222222222222222222';
  copy.upsert({ ...cfg({ wallet: W2, label: 'Other', mode: 'paper' }) });
  const other = copy.all().find((c) => c.wallet === W2);
  copy.upsert({ ...cfg({ wallet: W2, label: 'Other', mode: 'paper' }), id: other.id });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'p1' }));
  copy.onWalletTrade(trade({ wallet: W2, isBuy: true, signature: 'p2' }));
  await tick();
  assert.equal(copy.snapshot().recent.filter((t) => t.kind !== 'exit').length, 2);
  const mine = copy.all().find((c) => c.wallet === WALLET);
  copy.resetPaper(mine.id);
  const left = copy.snapshot().recent.filter((t) => t.kind !== 'exit');
  assert.equal(left.length, 1);
  assert.equal(left[0].configId, other.id, "the other wallet's run keeps going");
});

test('resetPaper refuses an id that does not exist, and clears nothing', () => {
  setup({ priceSol: 0.001 });
  save({ mode: 'paper' });
  const r = copy.resetPaper('nope');
  assert.equal(r.ok, false);
  assert.equal(r.cleared, 0);
  assert.equal(copy.all().length, 1);
});

// ── Restarts during pending orders ────────────────────────────────────
//
// Explicitly asked for in the 2026-09-13 report, and the gap the in-memory
// fix left behind: a sell the leader made while our buy was in flight is an
// INSTRUCTION, and it has to survive the process, not just the async gap.
// A crash or a quit at the wrong moment used to drop it, leaving the
// position open with nothing left remembering it was meant to close.

/** Round-trip the module through disk, the way a restart does. */
async function restart(dir) {
  await new Promise((r) => setTimeout(r, 400)); // the 300 ms debounced write
  copy._reset();
  copy.init(dir);
  return dir;
}

test('a parked exit SURVIVES a restart and is mirrored on the way back up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-restart-'));
  copy._reset();
  copy.init(dir);
  const h1 = makeHost({ priceSol: 0.001, buyMs: 60, leaderHolding: 0 });
  copy.attach(h1.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await new Promise((r) => setTimeout(r, 10));
  // The leader exits mid-buy; the buy is already out, so the exit parks.
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h1.calls.sells.length, 1, 'in one process it mirrors immediately');

  // Now the same race, but the process dies before the buy returns.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-restart2-'));
  copy._reset();
  copy.init(dir2);
  const h2 = makeHost({ priceSol: 0.001, buyMs: 5_000, leaderHolding: 0 });
  copy.attach(h2.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b2' }));
  await new Promise((r) => setTimeout(r, 10));
  copy.onWalletTrade(trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's2' }));
  await new Promise((r) => setTimeout(r, 450)); // persisted, buy still hanging
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir2, 'copytrade.json'), 'utf8'));
  assert.equal(onDisk.pendingExits.length, 1, 'the instruction reached disk');
  assert.equal(onDisk.pendingExits[0].trade.mint, MINT);
});

test('after a restart a FRESH parked exit fires, once a position exists to close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-resume-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'open');
  // Hand-write the state a crash would have left: an open row, and an exit
  // parked against it. After the 300 ms debounced write, or there is no file.
  await new Promise((r) => setTimeout(r, 400));
  const cfgId = copy.all()[0].id;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [
    { key: `${cfgId}:${MINT}`, trade: { ...trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }), at: Date.now() } },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h2.host);
  const out = copy.resumePendingExits();
  await tick();
  assert.equal(out.fired, 1);
  assert.equal(h2.calls.sells.length, 1, 'the exit the crash interrupted is honoured');
  assert.equal(copy.snapshot().recent.find((t) => t.kind !== 'exit').state, 'closed');
});

test('an exit resumed on a config the restart PAUSED still fires, and says so', async () => {
  // The restart disarm is about not resuming ENTRIES. An exit must stay
  // possible while entries are paused — but the panel is showing "Paused"
  // while this sells, so the toast has to explain the pair or a user is
  // right to distrust both.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-paused-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  await new Promise((r) => setTimeout(r, 400));
  const cfgId = copy.all()[0].id;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [
    { key: `${cfgId}:${MINT}`, trade: { ...trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }), at: Date.now() } },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h2.host);
  assert.equal(copy.all()[0].enabled, false, 'the restart disarmed the live config');
  const out = copy.resumePendingExits();
  await tick();
  assert.equal(out.fired, 1, 'the exit still runs — entries are what a restart pauses');
  assert.equal(h2.calls.sells.length, 1);
  const said = h2.calls.toasts.find((t) => /paused/i.test(t.message));
  assert.ok(said, 'the user is told why a paused config just sold');
});

test('a STALE parked exit is never traded on late — it is recorded, and says you still hold it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-stale-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  copy.onWalletTrade(trade({ isBuy: true, signature: 'b1' }));
  await tick();
  await new Promise((r) => setTimeout(r, 400));
  const cfgId = copy.all()[0].id;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  // The app was shut for an hour.
  raw.pendingExits = [
    {
      key: `${cfgId}:${MINT}`,
      trade: { ...trade({ isBuy: false, sol: 1, priceSol: 0.002, soldFraction: 1, signature: 's1' }), at: Date.now() - 60 * 60_000 },
    },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001, leaderHolding: 0 });
  copy.attach(h2.host);
  const out = copy.resumePendingExits();
  await tick();
  assert.equal(out.fired, 0, 'an hour-old sell is not a trade anyone made today');
  assert.equal(out.expired, 1);
  assert.equal(h2.calls.sells.length, 0);
  const exit = copy.snapshot().recent.find((t) => t.kind === 'exit');
  assert.match(exit.reason, /while the app was closed/);
  assert.match(exit.reason, /still hold it/);
  const said = h2.calls.toasts.at(-1);
  assert.equal(said.level, 'error', 'never silent — the user is still holding the bag');
});

test('a parked exit whose buy never opened a row does nothing on restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-norow-'));
  copy._reset();
  copy.init(dir);
  const h = makeHost({ priceSol: 0.001 });
  copy.attach(h.host);
  save({ mode: 'live', sizing: 'fixed', sizeValue: 1, maxTradeSol: 1, delayMs: 0 });
  const cfgId = copy.all()[0].id;
  await new Promise((r) => setTimeout(r, 400));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [
    { key: `${cfgId}:${MINT}`, trade: { ...trade({ isBuy: false, soldFraction: 1, signature: 's1' }), at: Date.now() } },
  ];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');

  await restart(dir);
  const h2 = makeHost({ priceSol: 0.001 });
  copy.attach(h2.host);
  const out = copy.resumePendingExits();
  await tick();
  // The buy died with the process and never opened anything, so there is
  // nothing held and nothing to sell. Selling here would be a phantom order.
  assert.equal(out.fired, 0);
  assert.equal(out.expired, 0);
  assert.equal(h2.calls.sells.length, 0);
});

test('a corrupt pendingExits list does not stop the configs loading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-badpending-'));
  copy._reset();
  copy.init(dir);
  copy.attach(makeHost({ priceSol: 0.001 }).host);
  save({ mode: 'paper' });
  await new Promise((r) => setTimeout(r, 400));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'copytrade.json'), 'utf8'));
  raw.pendingExits = [null, 42, { key: 'x' }, { trade: {} }];
  fs.writeFileSync(path.join(dir, 'copytrade.json'), JSON.stringify(raw), 'utf8');
  await restart(dir);
  copy.attach(makeHost({ priceSol: 0.001 }).host);
  assert.equal(copy.all().length, 1, 'the configs still loaded');
  assert.deepEqual(copy.resumePendingExits(), { fired: 0, expired: 0 });
});

await run();
