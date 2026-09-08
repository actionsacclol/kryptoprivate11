// User automation — the rule engine, and the walls around a script.
//
// A script exists to spend money without a human at the button, so the
// bugs that matter are the ways it could spend MORE than it was allowed
// to, act on a fact it does not have, or keep going after it should have
// stopped. Each rule of the house in automation.ts is pinned here.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auto from './.automation.mjs';
import {
  conditionHolds,
  contextFromLaunch,
  contextFromPosition,
  defaultRules,
  defaultScript,
  describeRules,
  evaluateRules,
  positionPnl,
  validateRules,
  validateScript,
  aiPromptPack,
  fieldGuideText,
  RULE_FIELDS,
  SCRIPT_API,
  SCRIPT_EVENTS_DOC,
} from './.automationshared.mjs';
import { SCRIPT_METHODS } from './.scriptprotocol.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const MINT = 'CopyMint111111111111111111111111111111111';
const MINT2 = 'CopyMint222222222222222222222222222222222';

function launchRow(over = {}) {
  return {
    mint: MINT,
    name: 'Copy Coin',
    symbol: 'COPY',
    uri: '',
    creator: 'Cre',
    bondingCurve: 'bc',
    signature: 'sig',
    slot: 1,
    detectedAt: Date.now() - 30_000,
    phase: 'evaluating',
    riskFlags: [],
    flow: {
      uniqueBuyers: 20, buys: 25, sells: 2, buyVolumeSol: 5, sellVolumeSol: 0.5, netInflowSol: 4.5, buyerAcceleration: 1.2,
      topBuyerShare: 0.1, creatorSold: false, curveProgressPct: 12, distinctSellers: 2, topHolderTokenShare: 0.08, earlyBuyerShare: 0.3,
    },
    score: { safety: 18, creator: 15, sellPressure: 15, entryTiming: 10, crowd: 6, concentration: 10, metadata: 8, penalties: 0, total: 82 },
    priceSol: 0.00000005,
    priceHistory: [],
    reason: null,
    creatorPriorLaunches: 1,
    creatorPriorRugs: 0,
    smartBuyerCount: 0,
    smartEarly: false,
    ...over,
  };
}

function makeHost(over = {}) {
  const calls = { buys: [], sells: [], toasts: [], notifies: [], watches: [], replies: [], dispatched: [], started: [], stopped: [], orders: [], templates: [], alerts: [], subscribed: [], pins: [] };
  const book = { paper: [], live: [] };
  const running = new Set();
  const launches = new Map();
  const pos = (mint, costSol, pnlPct = 0) => ({ mint, symbol: 'COPY', name: '', openedAt: Date.now(), costSol, tokens: 1000, entryPriceSol: costSol / 1000, currentPriceSol: (costSol / 1000) * (1 + pnlPct / 100), peakPriceSol: null, pnlSol: costSol * (pnlPct / 100), pnlPct });
  const host = {
    calls,
    book,
    launches,
    running,
    pos,
    buy: async (mint, sol, mode) => {
      calls.buys.push({ mint, sol, mode });
      if (over.buyResult) return over.buyResult;
      book[mode].push(pos(mint, sol));
      return { ok: true, message: 'bought' };
    },
    sell: async (mint, pct, mode) => {
      calls.sells.push({ mint, pct, mode });
      if (over.sellResult) return over.sellResult;
      if (pct >= 100) book[mode] = book[mode].filter((p) => p.mint !== mint);
      return { ok: true, message: 'sold', realizedSol: over.realized ?? -0.01 };
    },
    liveBlockedReason: () => over.liveBlocked ?? null,
    buyBlockedReason: () => over.buyBlocked ?? null,
    maxLiveSol: () => over.maxLiveSol ?? 1,
    priceSol: () => 0.001,
    launch: (mint) => launches.get(mint) ?? null,
    positions: async (mode) => book[mode].map((p) => ({ ...p })),
    marketCached: (mint) => over.market?.[mint] ?? null,
    market: async (mint) => over.market?.[mint] ?? null,
    wallet: () => ({ sol: over.walletSol ?? 1.5, address: 'Wallet111111111111111111111111111111111111' }),
    orders: (mint) => calls.orders.filter((o) => !mint || o.mint === mint),
    placeOrder: async (req) => {
      calls.orders.push({ id: 'o' + calls.orders.length, state: 'armed', symbol: '', ...req });
      return { ok: true, message: 'armed' };
    },
    cancelOrders: (mint) => {
      const n = calls.orders.filter((o) => o.mint === mint).length;
      calls.orders = calls.orders.filter((o) => o.mint !== mint);
      return { ok: true, message: 'cancelled ' + n, cancelled: n };
    },
    templates: () => [{ id: 'tpl1', name: 'Default' }],
    applyTemplate: async (mint, id) => {
      calls.templates.push({ mint, id });
      return { ok: true, message: 'armed 2' };
    },
    createAlert: (req) => {
      calls.alerts.push(req);
      return { ok: true, message: 'alert set' };
    },
    subscribeTicks: (mint) => calls.subscribed.push(mint),
    pin: (mint, on) => calls.pins.push({ mint, on }),
    runners: () => over.runners ?? [],
    leaders: () => [{ wallet: 'Lead', label: 'Sharky', enabled: true, mode: 'paper' }],
    notify: (_t, body) => calls.notifies.push(body),
    log: () => {},
    toast: (level, message) => calls.toasts.push({ level, message }),
    changed: () => {},
    sandbox: {
      start: async (id) => {
        calls.started.push(id);
        if (over.startFails) return { ok: false, message: 'boom' };
        running.add(id);
        return { ok: true, message: 'running' };
      },
      dispatch: async (id, name, payload) => {
        calls.dispatched.push({ id, name, payload });
        return over.dispatchResult ?? { ok: true };
      },
      reply: (id, cid, ok, value, error) => calls.replies.push({ id, cid, ok, value, error }),
      stop: async (id) => {
        running.delete(id);
        calls.stopped.push(id);
      },
      isRunning: (id) => running.has(id),
    },
  };
  return host;
}

function setup(over = {}) {
  auto._reset();
  const h = makeHost(over);
  auto.attach(h);
  return h;
}

const rulesScript = (over = {}, rules = {}) => ({
  ...defaultScript('rules'),
  name: 'R',
  rules: { ...defaultRules(), ...rules },
  ...over,
});

const codeScript = (over = {}) => ({ ...defaultScript('code'), name: 'C', code: "bot.on('launch', () => {})", ...over });

function saved(input) {
  const r = auto.upsert(input);
  assert.ok(r.ok, r.message);
  return auto.all().find((s) => s.id === r.id);
}

// ── Shared: evaluation ────────────────────────────────────────────────

test('a condition on an UNKNOWN fact never holds', () => {
  const ctx = contextFromLaunch(launchRow({ score: null }), Date.now());
  assert.equal(ctx.score, null);
  const r = conditionHolds({ field: 'score', op: 'gte', value: 0 }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.why, /unknown/);
  assert.equal(conditionHolds({ field: 'score', op: 'lt', value: 1000 }, ctx).ok, false, 'not even "less than a thousand"');
});

test('number, boolean, text and list operators', () => {
  const ctx = contextFromLaunch(launchRow({ riskFlags: [{ id: 'creator_rug_history', label: 'x', hard: true }] }), Date.now());
  assert.equal(conditionHolds({ field: 'score', op: 'gte', value: 82 }, ctx).ok, true);
  assert.equal(conditionHolds({ field: 'score', op: 'gt', value: 82 }, ctx).ok, false);
  assert.equal(conditionHolds({ field: 'creatorSold', op: 'is_false', value: '' }, ctx).ok, true);
  assert.equal(conditionHolds({ field: 'hardRisk', op: 'is_true', value: '' }, ctx).ok, true);
  assert.equal(conditionHolds({ field: 'symbol', op: 'contains', value: 'cop' }, ctx).ok, true, 'text is case-insensitive');
  assert.equal(conditionHolds({ field: 'riskFlags', op: 'contains', value: 'creator_rug_history' }, ctx).ok, true);
  assert.equal(conditionHolds({ field: 'riskFlags', op: 'not_contains', value: 'creator_rug_history' }, ctx).ok, false);
  assert.ok(ctx.ageSec >= 29 && ctx.ageSec <= 31);
});

test('evaluateRules is AND, and names the first miss', () => {
  const ctx = contextFromLaunch(launchRow(), Date.now());
  const r = evaluateRules({ ...defaultRules(), conditions: [{ field: 'score', op: 'gte', value: 70 }, { field: 'uniqueBuyers', op: 'gte', value: 50 }] }, ctx);
  assert.equal(r.fire, false);
  assert.match(r.why, /Unique buyers 20 not/);
  assert.equal(evaluateRules({ ...defaultRules(), conditions: [] }, ctx).fire, true, 'no conditions = always');
});

test('position facts: pnl, hold time, drawdown from peak', () => {
  const now = Date.now();
  const ctx = contextFromPosition({ mint: MINT, symbol: 'C', name: '', openedAt: now - 600_000, costSol: 1, tokens: 1000, entryPriceSol: 0.001, currentPriceSol: 0.0015, peakPriceSol: 0.002, pnlSol: 0.5, pnlPct: 50 }, null, now);
  assert.equal(ctx.pnlPct, 50);
  assert.ok(Math.abs(ctx.holdMinutes - 10) < 0.01);
  assert.ok(Math.abs(ctx.drawdownFromPeakPct - 25) < 1e-9);
  assert.deepEqual(positionPnl(1, 1000, 0.0015), { pnlSol: 0.5, pnlPct: 50 });
  assert.deepEqual(positionPnl(1, null, 0.0015), { pnlSol: null, pnlPct: null }, 'unknown tokens = unknown pnl');
});

test('validation: a launch rule cannot sell, a position rule cannot buy, scopes match triggers', () => {
  assert.equal(validateRules({ ...defaultRules(), actions: [{ type: 'sell', pct: 50 }] }).ok, true, 'a launch rule may sell what it holds (refused at run time when it holds nothing)');
  assert.equal(validateRules({ ...defaultRules(), trigger: 'position', actions: [{ type: 'buy', sol: 0.1 }] }).ok, false);
  assert.equal(validateRules({ ...defaultRules(), conditions: [{ field: 'runnerOddsPct', op: 'gt', value: 10 }] }).ok, false, 'runner odds only on the runner trigger');
  assert.equal(validateRules({ ...defaultRules(), trigger: 'position', conditions: [{ field: 'pnlPct', op: 'lt', value: -30 }], actions: [{ type: 'sell', pct: 100 }] }).ok, true);
  assert.equal(validateRules({ ...defaultRules(), conditions: [{ field: 'creatorSold', op: 'gt', value: 1 }] }).ok, false, 'operator must fit the field');
  const s = defaultScript('rules');
  assert.equal(validateScript({ ...s, budget: { ...s.budget, maxSolPerTrade: 0 } }).ok, false);
  assert.equal(validateScript({ ...s, rules: { ...s.rules, actions: [{ type: 'buy', sol: 5 }] } }).ok, false, 'a rule cannot buy more than its own budget cap');
  assert.equal(validateScript({ ...defaultScript('code'), code: '' }).ok, false);
  assert.match(describeRules(defaultRules()), /On Launch update when Krypt score ≥ 70 and Hard risk flag is false and Unique buyers ≥ 15: buy 0.02 SOL/);
});

// ── Engine: defaults and lifecycle ────────────────────────────────────

test('a saved script is paper and OFF; switching to live disarms it', () => {
  setup();
  const s = saved(rulesScript({ enabled: true, mode: 'live' }));
  assert.equal(s.enabled, false, 'saving never arms');
  assert.equal(s.mode, 'live');
  assert.ok(auto.setEnabled(s.id, true).ok);
  assert.equal(auto.all()[0].enabled, true);
  const r = auto.upsert({ ...s, id: s.id, mode: 'paper' });
  assert.ok(r.ok);
  const r2 = auto.upsert({ ...auto.all()[0], id: s.id, mode: 'live' });
  assert.ok(r2.ok);
  assert.equal(auto.all()[0].enabled, false, 'paper → live disarms');
});

test('a LIVE script never comes back armed after a restart; a paper one does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-auto-'));
  auto._reset();
  auto.init(dir);
  auto.attach(makeHost());
  const live = saved(rulesScript({ name: 'L', mode: 'live' }));
  const paper = saved(rulesScript({ name: 'P' }));
  auto.setEnabled(live.id, true);
  auto.setEnabled(paper.id, true);
  // persist is debounced; shutdown flushes synchronously
  return auto.shutdown().then(() => {
    auto._reset();
    auto.init(dir);
    const back = auto.all();
    assert.equal(back.find((s) => s.name === 'L').enabled, false, 'live disarmed');
    assert.equal(back.find((s) => s.name === 'P').enabled, true, 'paper resumes');
    assert.match(auto.snapshot().logs[back.find((s) => s.name === 'L').id].at(-1).line, /Disabled on restart/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── Engine: rules fire, once, through the host ────────────────────────

test('a rule fires on a launch update when every condition holds, buys through the host in PAPER, and only once per token', async () => {
  const h = setup();
  const s = saved(rulesScript());
  auto.setEnabled(s.id, true);
  const row = launchRow();
  h.launches.set(MINT, row);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: row });
  auto.onEngineEvent({ kind: 'launchUpdate', launch: row });
  await tick();
  assert.deepEqual(h.calls.buys, [{ mint: MINT, sol: 0.02, mode: 'paper' }]);
  const st = auto.snapshot().stats[s.id];
  assert.equal(st.buysToday, 1);
  assert.equal(st.openCount, 1);
  assert.equal(st.firedMints, 1);
  assert.ok(auto.snapshot().logs[s.id].some((l) => /fired on COPY/.test(l.line)));
});

test('a rule does NOT fire while a fact it needs is unknown', async () => {
  const h = setup();
  const s = saved(rulesScript());
  auto.setEnabled(s.id, true);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow({ score: null }) });
  await tick();
  assert.equal(h.calls.buys.length, 0);
});

test('the trigger is respected: a launch_update rule ignores runner and launch events', async () => {
  const h = setup();
  const s = saved(rulesScript());
  auto.setEnabled(s.id, true);
  auto.onEngineEvent({ kind: 'launch', launch: launchRow() });
  auto.onEngineEvent({ kind: 'runner', runner: { mint: MINT, name: 'x', symbol: 'COPY', creator: 'c', flaggedAt: Date.now(), windowS: 60, bucket: 'top', observedPct: 30, basePct: 5, n: 100 } });
  await tick();
  assert.equal(h.calls.buys.length, 0);
});

test('a position rule sells through the host when a held position drops', async () => {
  const h = setup();
  const s = saved(rulesScript({}, { trigger: 'position', conditions: [{ field: 'pnlPct', op: 'lte', value: -30 }], actions: [{ type: 'sell', pct: 100 }] }));
  auto.setEnabled(s.id, true);
  h.book.paper.push(h.pos(MINT, 0.1, -35));
  h.book.paper.push(h.pos(MINT2, 0.1, +10));
  await auto.pollPositions();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 100, mode: 'paper' }], 'only the loser is sold');
});

// ── Engine: the budget walls ──────────────────────────────────────────

test('a buy over the script cap is REFUSED, never shrunk', async () => {
  const h = setup();
  const s = saved(rulesScript({ budget: { maxSolPerTrade: 0.05, maxBuysPerDay: 10, maxLossSolPerDay: 1, maxOpenPositions: 5, maxActionsPerMinute: 30 } }, { actions: [{ type: 'buy', sol: 0.05 }] }));
  auto.setEnabled(s.id, true);
  // The saved rule buys 0.05; a code call for more is the same wall.
  const c = saved(codeScript({ budget: { ...s.budget } }));
  auto.setEnabled(c.id, true);
  h.launches.set(MINT, launchRow());
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.5] });
  await tick();
  assert.equal(h.calls.buys.length, 0, 'nothing bought');
  const reply = h.calls.replies.find((r) => r.cid === 1);
  assert.equal(reply.ok, true, 'the call itself succeeds — the answer is a refusal');
  assert.equal(reply.value.ok, false);
  assert.match(reply.value.message, /over the script's max per trade/);
  assert.ok(auto.snapshot().logs[c.id].some((l) => /refused/.test(l.line)));
});

test('buys per day, open positions and actions per minute are all capped', async () => {
  const h = setup();
  const c = saved(codeScript({ budget: { maxSolPerTrade: 1, maxBuysPerDay: 2, maxLossSolPerDay: 10, maxOpenPositions: 1, maxActionsPerMinute: 100 } }));
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.1] });
  await tick();
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'buy', args: [MINT2, 0.1] });
  await tick();
  assert.equal(h.calls.buys.length, 1, 'second token refused: one open position max');
  assert.match(h.calls.replies.find((r) => r.cid === 2).value.message, /already holding 1 positions/);
  // Adding to the SAME position is not a new position — but the day cap is 2.
  auto.onSandboxMessage(c.id, { t: 'call', id: 3, method: 'buy', args: [MINT, 0.1] });
  await tick();
  auto.onSandboxMessage(c.id, { t: 'call', id: 4, method: 'buy', args: [MINT, 0.1] });
  await tick();
  assert.equal(h.calls.buys.length, 2);
  assert.match(h.calls.replies.find((r) => r.cid === 4).value.message, /2 buys today already/);

  const r = saved(codeScript({ name: 'rate', budget: { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 2 } }));
  auto.setEnabled(r.id, true);
  for (let i = 0; i < 3; i++) {
    auto.onSandboxMessage(r.id, { t: 'call', id: 10 + i, method: 'notify', args: [`n${i}`] });
    await tick();
  }
  assert.equal(h.calls.notifies.length, 2, 'the third action in a minute is refused');
});

test('past the daily loss limit the script turns itself OFF', async () => {
  const h = setup({ realized: -0.3 });
  const c = saved(codeScript({ budget: { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 0.5, maxOpenPositions: 50, maxActionsPerMinute: 100 } }));
  auto.setEnabled(c.id, true);
  h.book.paper.push(h.pos(MINT, 0.5), h.pos(MINT2, 0.5));
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'sell', args: [MINT, 100] });
  await tick();
  assert.equal(auto.all()[0].enabled, true, 'one loss of 0.3 is inside the 0.5 limit');
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'sell', args: [MINT2, 100] });
  await tick();
  assert.equal(auto.all()[0].enabled, false, 'the second takes it past the limit');
  assert.ok(h.calls.toasts.some((t) => t.level === 'error' && /disabled/.test(t.message)));
  assert.ok(h.calls.stopped.includes(c.id), 'the sandbox is stopped');
  assert.ok(Math.abs(auto.snapshot().stats[c.id].realizedSolToday - -0.6) < 1e-9);
});

test('LIVE: blocked = refused with the reason; a live buy is also capped by the execution setting', async () => {
  const h = setup({ liveBlocked: 'the engine is not armed', maxLiveSol: 0.05 });
  const c = saved(codeScript({ mode: 'live', budget: { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 100 } }));
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick();
  assert.equal(h.calls.buys.length, 0);
  assert.match(h.calls.replies[0].value.message, /not executed — the engine is not armed/);
  const h2 = setup({ maxLiveSol: 0.05 });
  const c2 = saved(codeScript({ mode: 'live', budget: { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 100 } }));
  auto.setEnabled(c2.id, true);
  auto.onSandboxMessage(c2.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.1] });
  await tick();
  assert.equal(h2.calls.buys.length, 0);
  assert.match(h2.calls.replies[0].value.message, /over the execution cap/);
  auto.onSandboxMessage(c2.id, { t: 'call', id: 2, method: 'buy', args: [MINT, 0.04] });
  await tick();
  assert.deepEqual(h2.calls.buys, [{ mint: MINT, sol: 0.04, mode: 'live' }]);
});

test('paper never touches the live gate; a sell of something not held is refused', async () => {
  const h = setup({ liveBlocked: 'live is off' });
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick();
  assert.equal(h.calls.buys.length, 1, 'paper buys while live is blocked');
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'sell', args: [MINT2, 50] });
  await tick();
  assert.equal(h.calls.sells.length, 0);
  assert.match(h.calls.replies.find((r) => r.cid === 2).value.message, /nothing held in paper mode/);
});

test('the kill switch stops everything and blocks enabling until lifted', () => {
  const h = setup();
  const a = saved(rulesScript({ name: 'a' }));
  const c = saved(codeScript({ name: 'c' }));
  auto.setEnabled(a.id, true);
  auto.setEnabled(c.id, true);
  assert.ok(auto.setKillSwitch(true).ok);
  assert.ok(auto.all().every((s) => !s.enabled));
  assert.ok(h.calls.stopped.includes(c.id));
  assert.equal(auto.setEnabled(a.id, true).ok, false);
  assert.equal(auto.snapshot().killSwitch, true);
  auto.setKillSwitch(false);
  assert.ok(auto.setEnabled(a.id, true).ok);
});

// ── Engine: code scripts ──────────────────────────────────────────────

test('enabling a code script starts its sandbox; launch chatter reaches it at most every 2 s per token', async () => {
  const h = setup();
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  assert.deepEqual(h.calls.started, [c.id]);
  auto.onSandboxMessage(c.id, { t: 'ready' });
  const row = launchRow();
  auto.onEngineEvent({ kind: 'launch', launch: row });
  auto.onEngineEvent({ kind: 'launchUpdate', launch: row });
  auto.onEngineEvent({ kind: 'launchUpdate', launch: row });
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow({ mint: MINT2 }) });
  await tick(30);
  const names = h.calls.dispatched.map((d) => `${d.name}:${d.payload.mint.slice(0, 5)}`);
  assert.deepEqual(names, ['launch:CopyM', 'launchUpdate:CopyM', 'launchUpdate:CopyM'], 'one update per token in the window; the second token gets its own');
  assert.equal(h.calls.dispatched[1].payload.score, 82, 'the script sees the same facts a rule does');
});

test('five errors in a row disable a code script; a sandbox that dies is restarted while enabled', async () => {
  const h = setup({ dispatchResult: { ok: false, error: 'TypeError: x is not a function' } });
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  for (let i = 0; i < 5; i++) {
    auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` }) });
    await tick(20);
  }
  assert.equal(auto.all()[0].enabled, false, 'disabled after five');
  assert.match(auto.snapshot().stats[c.id].lastError, /TypeError/);

  const h2 = setup();
  const c2 = saved(codeScript());
  auto.setEnabled(c2.id, true);
  await tick();
  auto.onSandboxGone(c2.id, 'renderer crashed');
  await tick();
  assert.equal(h2.calls.started.length, 2, 'restarted once');
  assert.equal(auto.all()[0].enabled, true);
});

test('script state survives, is bounded, and timers have a floor', async () => {
  const h = setup();
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'setState', args: [{ seen: [MINT] }] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'getState', args: [] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 3, method: 'setState', args: [{ big: 'x'.repeat(20_000) }] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 4, method: 'every', args: [1] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 5, method: 'buy', args: ['not-a-mint', 0.01] });
  await tick();
  const by = (id) => h.calls.replies.find((r) => r.cid === id);
  assert.deepEqual(by(2).value, { seen: [MINT] });
  assert.equal(by(3).ok, false, 'over 16 KB is refused');
  assert.equal(by(4).value, 5, 'a 1 s timer becomes 5 s');
  assert.equal(by(5).ok, false, 'a bad mint never reaches the host');
  assert.equal(h.calls.buys.length, 0);
  auto.stopTimers();
});

// ── The wider surface (2026-09-08): ticks, followed wallets, orders, alerts, schedules ──

test('a tick reaches only scripts that hold or subscribed to the token, at most once a second', async () => {
  const h = setup();
  const s = saved(rulesScript({}, { trigger: 'tick', conditions: [{ field: 'priceSol', op: 'gt', value: 0 }], actions: [{ type: 'log', message: 'tick {symbol} {priceSol}' }], oncePerMint: false, cooldownSec: 0 }));
  auto.setEnabled(s.id, true);
  auto.onEngineEvent({ kind: 'tick', mint: MINT, time: 1, priceSol: 0.002, volSol: 1, isBuy: true });
  await tick();
  assert.equal(auto.snapshot().logs[s.id].filter((l) => /^tick/.test(l.line)).length, 0, 'not held, not subscribed: ignored');
  h.book.paper.push(h.pos(MINT, 0.1));
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'subscribe', args: [MINT2] }); // rules scripts have no sandbox; subscribe is a no-op for them
  await auto.pollPositions(); // opened is not required: holding suffices via subscribeTicks; here the tick gate is opened/subscribed
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'subscribe', args: [MINT] });
  await tick();
  auto.onEngineEvent({ kind: 'tick', mint: MINT, time: 2, priceSol: 0.002, volSol: 1, isBuy: true });
  auto.onEngineEvent({ kind: 'tick', mint: MINT, time: 3, priceSol: 0.003, volSol: 1, isBuy: true });
  await tick(30);
  const lines = auto.snapshot().logs[s.id].filter((l) => /^tick/.test(l.line));
  assert.equal(lines.length, 1, 'the second tick inside a second is dropped');
  assert.match(lines[0].line, /tick COPY 0\.002/);
});

test('a followed wallet trade reaches leader_trade rules with its facts; a code script gets leaderTrade', async () => {
  const h = setup();
  const s = saved(rulesScript({}, { trigger: 'leader_trade', conditions: [{ field: 'leaderSide', op: 'eq', value: 'buy' }, { field: 'leaderSol', op: 'gte', value: 0.5 }], actions: [{ type: 'buy', sol: 0.02 }] }));
  auto.setEnabled(s.id, true);
  const c = saved(codeScript({ name: 'lt' }));
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  auto.onLeaderTrade({ mint: MINT, symbol: 'COPY', wallet: 'Lead', label: 'Sharky', side: 'buy', sol: 1, priceSol: 0.001, soldFraction: null });
  auto.onLeaderTrade({ mint: MINT2, symbol: 'TWO', wallet: 'Lead', label: 'Sharky', side: 'sell', sol: 0.2, priceSol: 0.001, soldFraction: 0.4 });
  await tick(30);
  assert.deepEqual(h.calls.buys, [{ mint: MINT, sol: 0.02, mode: 'paper' }], 'only the buy of 1 SOL fired the rule');
  const evs = h.calls.dispatched.filter((d) => d.name === 'leaderTrade');
  assert.equal(evs.length, 2);
  assert.equal(evs[0].payload.leaderLabel, 'Sharky');
  assert.equal(evs[1].payload.leaderSoldPct, 40);
  assert.equal(evs[1].payload.leaderSide, 'sell');
});

test('order snapshots become order events only when a state CHANGES to a terminal state', async () => {
  const h = setup();
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  const snap = (state) => ({ kind: 'orders', snapshot: { orders: [{ id: 'o1', mint: MINT, symbol: 'COPY', kind: 'stop_loss', state, triggerValue: 30, triggerBasis: 'pct', amount: 100, referencePriceSol: 0.001, peakPriceSol: null, createdAt: 1, updatedAt: 1 }], executable: true, blockedReason: null } });
  auto.onEngineEvent(snap('armed'));
  auto.onEngineEvent(snap('armed'));
  auto.onEngineEvent(snap('triggered'));
  auto.onEngineEvent(snap('filled'));
  await tick(30);
  const evs = h.calls.dispatched.filter((d) => d.name === 'order');
  assert.deepEqual(evs.map((e) => e.payload.orderState), ['triggered', 'filled']);
  assert.equal(evs[0].payload.orderKind, 'stop_loss');
  assert.equal(evs[0].payload.orderAmount, 100);
});

test('an alert firing (lastFiredAt moved) reaches alert rules with its kind and threshold', async () => {
  const h = setup();
  const s = saved(rulesScript({}, { trigger: 'alert', conditions: [{ field: 'alertKind', op: 'eq', value: 'mcap_above' }], actions: [{ type: 'notify', message: '{symbol} crossed {alertThreshold}' }], oncePerMint: false, cooldownSec: 0 }));
  auto.setEnabled(s.id, true);
  const alert = (lastFiredAt) => ({ kind: 'alerts', alerts: [{ id: 'a1', kind: 'mcap_above', mint: MINT, symbol: 'COPY', threshold: 50000, state: 'fired', repeat: true, createdAt: 1, lastFiredAt, fireCount: 1, note: null }] });
  auto.onEngineEvent(alert(null));
  auto.onEngineEvent(alert(1000));
  auto.onEngineEvent(alert(1000));
  auto.onEngineEvent(alert(2000));
  await tick(30);
  assert.deepEqual(h.calls.notifies, ['COPY crossed 50000', 'COPY crossed 50000'], 'once per firing, never for the same firing twice');
});

test('a daily schedule fires its rule with only the global facts; a code script gets schedule', async () => {
  const h = setup({ walletSol: 0.2 });
  const s = saved(rulesScript({}, { trigger: 'schedule', atHHMM: '23:55', conditions: [{ field: 'walletSol', op: 'lt', value: 0.5 }], actions: [{ type: 'notify', message: 'low wallet: {walletSol} SOL' }, { type: 'sell_all' }] }));
  auto.setEnabled(s.id, true);
  assert.deepEqual(auto._runtimeOf(s.id).atTimers, ['23:55'], 'armed on enable');
  h.book.paper.push(h.pos(MINT, 0.1), h.pos(MINT2, 0.1));
  await auto._fireSchedule(s.id, '23:55');
  assert.deepEqual(h.calls.notifies, ['low wallet: 0.200 SOL']);
  assert.equal(h.calls.sells.length, 2, 'sell everything sold both');
  const c = saved(codeScript({ name: 'sched' }));
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'at', args: ['09:30'] });
  await tick();
  assert.deepEqual(auto._runtimeOf(c.id).atTimers, ['09:30']);
  await auto._fireSchedule(c.id, '09:30');
  await tick();
  assert.ok(h.calls.dispatched.some((d) => d.name === 'schedule' && d.payload.at === '09:30'));
  auto.stopTimers();
});

test('advanced orders: a PAPER script notes them; a LIVE script places them, and a limit buy counts as a buy', async () => {
  const h = setup();
  const paper = saved(rulesScript({ name: 'p' }, { trigger: 'launch_update', conditions: [], actions: [{ type: 'buy', sol: 0.02 }, { type: 'stop_loss', pct: 30 }, { type: 'take_profit', gainPct: 100, sellPct: 50 }] }));
  auto.setEnabled(paper.id, true);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow() });
  await tick(30);
  assert.equal(h.calls.buys.length, 1);
  assert.equal(h.calls.orders.length, 0, 'paper places no real orders');
  assert.ok(auto.snapshot().logs[paper.id].some((l) => /PAPER stop loss −30% on COPY — recorded, not placed/.test(l.line)));

  const h2 = setup();
  const live = saved(codeScript({ name: 'l', mode: 'live', budget: { maxSolPerTrade: 0.1, maxBuysPerDay: 2, maxLossSolPerDay: 1, maxOpenPositions: 5, maxActionsPerMinute: 60 } }));
  auto.setEnabled(live.id, true);
  h2.launches.set(MINT, launchRow());
  auto.onSandboxMessage(live.id, { t: 'call', id: 1, method: 'order', args: [{ mint: MINT, kind: 'limit_buy', triggerBasis: 'mcap_usd', triggerValue: 20000, amount: 0.05 }] });
  await tick();
  assert.equal(h2.calls.orders.length, 1);
  assert.equal(h2.calls.orders[0].kind, 'limit_buy');
  assert.equal(auto._runtimeOf(live.id).buysToday, 1, 'a limit buy spends a buy');
  auto.onSandboxMessage(live.id, { t: 'call', id: 2, method: 'order', args: [{ mint: MINT, kind: 'limit_buy', triggerBasis: 'mcap_usd', triggerValue: 20000, amount: 0.5 }] });
  await tick();
  assert.equal(h2.calls.orders.length, 1, 'over the per-trade cap: refused');
  assert.match(h2.calls.replies.find((r) => r.cid === 2).value.message, /over the script's max per trade/);
  // Stops on something not held are refused; on something held they are placed.
  auto.onSandboxMessage(live.id, { t: 'call', id: 3, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 }] });
  await tick();
  assert.match(h2.calls.replies.find((r) => r.cid === 3).value.message, /nothing held/);
  h2.book.live.push(h2.pos(MINT2, 0.1));
  auto.onSandboxMessage(live.id, { t: 'call', id: 4, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 }] });
  await tick(); // calls run as they arrive; the cancel must see the placed order
  auto.onSandboxMessage(live.id, { t: 'call', id: 5, method: 'cancelOrders', args: [MINT2] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 6, method: 'order', args: [{ mint: MINT2, kind: 'bogus', triggerBasis: 'pct', triggerValue: 1, amount: 1 }] });
  await tick();
  assert.equal(h2.calls.replies.find((r) => r.cid === 4).value.ok, true);
  assert.equal(h2.calls.replies.find((r) => r.cid === 5).value.cancelled, 1);
  assert.equal(h2.calls.replies.find((r) => r.cid === 6).ok, false, 'an unknown order kind never reaches the host');
});

test('watch pins and streams; alert, template, wallet, leaders, runners and disable all go through the host', async () => {
  const h = setup({ runners: [{ mint: MINT, name: 'x', symbol: 'COPY', creator: 'c', flaggedAt: 1, windowS: 60, bucket: 'top', observedPct: 33, basePct: 5, n: 10 }] });
  const c = saved(codeScript({ mode: 'live' }));
  auto.setEnabled(c.id, true);
  h.book.live.push(h.pos(MINT, 0.1));
  const calls = [
    [1, 'watch', [MINT]],
    [2, 'alert', [{ mint: MINT, kind: 'mcap_above', threshold: 100000 }]],
    [3, 'applyTemplate', [MINT, 'tpl1']],
    [4, 'wallet', []],
    [5, 'leaders', []],
    [6, 'runners', []],
    [7, 'templates', []],
    [8, 'unwatch', [MINT]],
  ];
  for (const [id, method, args] of calls) auto.onSandboxMessage(c.id, { t: 'call', id, method, args });
  await tick(30);
  const by = (id) => h.calls.replies.find((r) => r.cid === id);
  assert.deepEqual(h.calls.pins, [{ mint: MINT, on: true }, { mint: MINT, on: false }]);
  assert.ok(h.calls.subscribed.includes(MINT));
  assert.equal(h.calls.alerts[0].kind, 'mcap_above');
  assert.deepEqual(h.calls.templates, [{ mint: MINT, id: 'tpl1' }]);
  assert.equal(by(4).value.sol, 1.5);
  assert.equal(by(5).value[0].label, 'Sharky');
  assert.equal(by(6).value[0].runnerOddsPct, 33);
  assert.deepEqual(by(7).value, [{ id: 'tpl1', name: 'Default' }]);
  auto.onSandboxMessage(c.id, { t: 'call', id: 9, method: 'disable', args: ['done for today'] });
  await tick();
  assert.equal(auto.all()[0].enabled, false);
  assert.ok(auto.snapshot().logs[c.id].some((l) => /DISABLED — done for today/.test(l.line)));
});

test('validation of the wider surface: schedule needs a time, fields match their trigger, describe covers every action', () => {
  assert.equal(validateRules({ ...defaultRules(), trigger: 'schedule', actions: [{ type: 'sell_all' }] }).ok, false, 'no time');
  assert.equal(validateRules({ ...defaultRules(), trigger: 'schedule', atHHMM: '25:00', actions: [{ type: 'sell_all' }] }).ok, false, 'bad time');
  assert.equal(validateRules({ ...defaultRules(), trigger: 'schedule', atHHMM: '23:55', conditions: [], actions: [{ type: 'sell_all' }] }).ok, true);
  assert.equal(validateRules({ ...defaultRules(), trigger: 'schedule', atHHMM: '23:55', conditions: [], actions: [{ type: 'buy', sol: 0.1 }] }).ok, false, 'a schedule has no token to buy');
  assert.equal(validateRules({ ...defaultRules(), trigger: 'launch', conditions: [{ field: 'leaderSide', op: 'eq', value: 'buy' }] }).ok, false, 'leader facts only on leader trades');
  assert.equal(validateRules({ ...defaultRules(), trigger: 'tick', conditions: [{ field: 'drawdownFromPeakPct', op: 'gte', value: 20 }], actions: [{ type: 'sell', pct: 100 }] }).ok, true);
  assert.equal(validateRules({ ...defaultRules(), actions: [{ type: 'take_profit', gainPct: 0, sellPct: 50 }] }).ok, false);
  assert.equal(validateRules({ ...defaultRules(), actions: [{ type: 'alert', kind: 'nope', threshold: 1 }] }).ok, false);
  for (const spec of RULE_ACTIONS_LIST()) assert.ok(describeRules({ ...defaultRules(), trigger: spec.needsMint ? 'launch_update' : 'schedule', atHHMM: '10:00', actions: [spec.sample] }).length > 0, spec.id);
});

function RULE_ACTIONS_LIST() {
  return [
    { id: 'buy', needsMint: true, sample: { type: 'buy', sol: 0.1 } },
    { id: 'sell', needsMint: true, sample: { type: 'sell', pct: 50 } },
    { id: 'sell_all', needsMint: false, sample: { type: 'sell_all' } },
    { id: 'stop_loss', needsMint: true, sample: { type: 'stop_loss', pct: 30 } },
    { id: 'take_profit', needsMint: true, sample: { type: 'take_profit', gainPct: 100, sellPct: 50 } },
    { id: 'trailing_stop', needsMint: true, sample: { type: 'trailing_stop', pct: 25 } },
    { id: 'limit_buy', needsMint: true, sample: { type: 'limit_buy', basis: 'mcap_usd', value: 1000, sol: 0.1 } },
    { id: 'limit_sell', needsMint: true, sample: { type: 'limit_sell', basis: 'price_sol', value: 0.001, pct: 50 } },
    { id: 'cancel_orders', needsMint: true, sample: { type: 'cancel_orders' } },
    { id: 'apply_template', needsMint: true, sample: { type: 'apply_template', templateId: 'x' } },
    { id: 'alert', needsMint: true, sample: { type: 'alert', kind: 'mcap_above', threshold: 1 } },
    { id: 'watch', needsMint: true, sample: { type: 'watch' } },
    { id: 'unwatch', needsMint: true, sample: { type: 'unwatch' } },
    { id: 'notify', needsMint: false, sample: { type: 'notify', message: 'x' } },
    { id: 'log', needsMint: false, sample: { type: 'log', message: 'x' } },
    { id: 'disable_self', needsMint: false, sample: { type: 'disable_self' } },
  ];
}

test('the AI prompt pack and the variable guide name every field, event and method — and nothing else', () => {
  const pack = aiPromptPack();
  const guide = fieldGuideText();
  for (const f of RULE_FIELDS) {
    assert.ok(guide.includes(`- ${f.id} (`), `guide has ${f.id}`);
    assert.ok(pack.includes(`- ${f.id} (`), `pack has ${f.id}`);
  }
  for (const a of SCRIPT_API) assert.ok(pack.includes(a.signature), `pack has ${a.method}`);
  for (const e of SCRIPT_EVENTS_DOC) assert.ok(pack.includes(`\`${e.event}\``), `pack has event ${e.event}`);
  for (const m of SCRIPT_METHODS) assert.ok(SCRIPT_API.some((a) => a.method === m || (m === 'on' && a.method === 'on')), `every sandbox method is documented: ${m}`);
  for (const a of SCRIPT_API) if (a.method !== 'on' && a.method !== 'log' && a.method !== 'now') assert.ok(SCRIPT_METHODS.includes(a.method), `every documented method exists in the sandbox: ${a.method}`);
  assert.ok(pack.includes('as **unknown, never as zero**'), 'the null rule is stated');
  assert.match(pack, /Output only the script/);
  assert.ok(pack.length > 8_000 && pack.length < 60_000, `a pasteable size (${pack.length} chars)`);
});

test('a refused buy ends the firing — the "log bought" after it never runs — and tiny prices print with precision', async () => {
  // Seen in the live app: past the daily cap every firing logged "refused"
  // and then "X bought at 0.000" from the log action that followed.
  const h = setup();
  const s = saved(rulesScript({ budget: { maxSolPerTrade: 0.01, maxBuysPerDay: 1, maxLossSolPerDay: 1, maxOpenPositions: 5, maxActionsPerMinute: 60 } }, { conditions: [], actions: [{ type: 'buy', sol: 0.005 }, { type: 'log', message: '{symbol} bought at {priceSol}' }] }));
  auto.setEnabled(s.id, true);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow({ mint: MINT, priceSol: 0.00000005 }) });
  await tick(30);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow({ mint: MINT2, symbol: 'TWO' }) });
  await tick(30);
  const lines = auto.snapshot().logs[s.id].map((l) => l.line);
  assert.ok(lines.some((l) => l === 'COPY bought at 5.000e-8'), `precision on a 5e-8 price: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => /refused — buy TWO: 1 buys today already/.test(l)));
  assert.ok(!lines.some((l) => /^TWO bought/.test(l)), 'no "bought" line after a refused buy');
  assert.equal(h.calls.buys.length, 1);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
    } catch (err) {
      console.error(`FAIL ${c.name}\n  ${err.stack ?? err.message}`);
      process.exitCode = 1;
    }
  }
  auto._reset();
  console.log(`automation: ${passed}/${cases.length} passed`);
}
await run();
