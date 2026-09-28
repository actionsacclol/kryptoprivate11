// User automation — the rule engine, and the walls around a script.
//
// A script exists to spend money without a human at the button, so the
// bugs that matter are the ways it could spend MORE than it was allowed
// to, act on a fact it does not have, or keep going after it should have
// stopped. Each rule of the house in automation.ts is pinned here.

import assert from 'node:assert';
import { parseInputs } from './.scriptinputs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auto from './.automation.mjs';
import { sandboxPageHtml } from './.scriptprotocol.mjs';
import {
  conditionHolds,
  actionAvailableOn,
  triggerAvailableOn,
  contextFromEvmLaunch,
  contextFromLaunch,
  contextFromPosition,
  fieldAvailableOn,
  scriptChain,
  defaultRules,
  defaultScript,
  describeRules,
  describeAction,
  nativeText,
  nativeFieldLabel,
  evaluateRules,
  positionPnl,
  validateRules,
  validateScript,
  aiPromptPack,
  fieldGuideText,
  RULE_FIELDS,
  SCRIPT_API,
  SCRIPT_API_DOC,
  SCRIPT_EVENTS_DOC,
  emptyContext,
  withLaunchLinks,
  withLaunchIntel,
  withMarket,
  marketFactsFromSummary,
  scriptLinksFromSummary,
  scriptLaunchIntelFromReport,
  scriptSecurityFromReport,
  scriptSettingsView,
  scrubForScript,
  mergeSnapshot,
} from './.automationshared.mjs';
import { SCRIPT_EVENTS, SCRIPT_METHODS } from './.scriptprotocol.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const MINT = 'CopyMint111111111111111111111111111111111';
const MINT2 = 'CopyMint222222222222222222222222222222222';
const MINT3 = 'CopyMint333333333333333333333333333333333';

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
  // `buyChains` / `sellChains` are recorded SEPARATELY because several pinned
  // assertions deepEqual `buys` against { mint, sol, mode } and must keep
  // exactly that shape — the same rule copytrade.test.mjs follows for `opts`.
  const calls = { buys: [], buyChains: [], buyCaps: [], sells: [], sellChains: [], toasts: [], notifies: [], watches: [], replies: [], dispatched: [], started: [], stopped: [], orders: [], templates: [], alerts: [], subscribed: [], pins: [], reads: [], housekeeping: [] };
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
    buy: async (mint, sol, mode, chain, ownCapSol, opts) => {
      // `opts` only when the call carried some, so the older deep-equals hold.
      calls.buys.push(opts ? { mint, sol, mode, opts } : { mint, sol, mode });
      calls.buyChains.push(chain ?? null);
      calls.buyCaps.push(ownCapSol ?? null);
      if (over.buyResult) return over.buyResult;
      book[mode].push(pos(mint, sol));
      return { ok: true, message: 'bought' };
    },
    sell: async (mint, pct, mode, chain, opts) => {
      calls.sells.push(opts ? { mint, pct, mode, opts } : { mint, pct, mode });
      calls.sellChains.push(chain ?? null);
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
    cancelOrders: (mint, kinds) => {
      const hit = (o) => o.mint === mint && (!kinds || kinds.includes(o.kind));
      const n = calls.orders.filter(hit).length;
      calls.orders = calls.orders.filter((o) => !hit(o));
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
    // The rest of what the app knows about a token (2026-09-20). `over`
    // supplies the answers; analyze counts its calls on `over` so a test can
    // see how many times the key would have been spent.
    links: (mint) => over.links?.[mint] ?? null,
    security: async (mint) => over.security?.[mint] ?? null,
    creator: async (mint) => over.creator?.[mint] ?? null,
    // The Launch tab's cohorts and every other read (2026-09-27). Each
    // counts its calls on `over` so a test can see what the host was asked.
    launchIntel: async (mint) => {
      over.launchIntelCalls = (over.launchIntelCalls ?? 0) + 1;
      return over.launchIntel?.[mint] ?? null;
    },
    launchIntelCached: (mint) => over.launchIntelCached?.[mint] ?? null,
    holders: async (mint, limit) => {
      calls.reads.push({ method: 'holders', mint, limit });
      return over.holders?.[mint] ?? null;
    },
    trades: async (mint, limit) => {
      calls.reads.push({ method: 'trades', mint, limit });
      return over.trades?.[mint] ?? null;
    },
    candles: async (mint, interval, limit) => {
      calls.reads.push({ method: 'candles', mint, interval, limit });
      return over.candles?.[mint] ?? null;
    },
    search: async (query) => {
      calls.reads.push({ method: 'search', query });
      return over.search ?? [];
    },
    discover: async (column, limit, chain) => {
      calls.reads.push({ method: 'discover', column, limit, chain });
      return over.discover?.[column] ?? [];
    },
    callouts: async (limit) => {
      calls.reads.push({ method: 'callouts', limit });
      return over.callouts ?? null;
    },
    history: (limit) => (over.history ?? []).slice(0, limit),
    holdings: async (chain) => {
      calls.reads.push({ method: 'holdings', chain });
      return over.holdings === undefined ? [] : over.holdings;
    },
    solUsd: async () => over.solUsd ?? null,
    walletScores: (chain, window, limit, only) => ({ onRecord: 0, filtered: only, rows: [], chain, window, limit }),
    walletRecord: (address, chain) => over.walletRecord?.[address] ?? null,
    copyConfigs: () => ({ configs: [], stats: {}, liveExecutable: false, liveBlockedReason: 'not armed' }),
    alerts: () => over.alerts ?? [],
    cancelOrder: (id) => {
      calls.housekeeping.push({ method: 'cancelOrder', id });
      return { ok: true, message: `cancelled ${id}` };
    },
    resumeOrders: () => {
      calls.housekeeping.push({ method: 'resumeOrders' });
      return { ok: true, message: 'resumed 2' };
    },
    removeAlert: (id) => {
      calls.housekeeping.push({ method: 'removeAlert', id });
      return { ok: true, message: 'removed' };
    },
    muteAlert: (id, muted) => {
      calls.housekeeping.push({ method: 'muteAlert', id, muted });
      return { ok: true, message: muted ? 'muted' : 'unmuted' };
    },
    clearFiredAlerts: () => {
      calls.housekeeping.push({ method: 'clearFiredAlerts' });
      return { ok: true, message: 'cleared 3' };
    },
    saveTemplate: (t) => {
      calls.housekeeping.push({ method: 'saveTemplate', t });
      return t.name ? { ok: true, message: `Saved “${t.name}”` } : { ok: false, message: 'Give the template a name' };
    },
    deleteTemplate: (id) => {
      calls.housekeeping.push({ method: 'deleteTemplate', id });
      return { ok: true, message: 'deleted' };
    },
    setActiveTemplate: (id) => {
      calls.housekeeping.push({ method: 'setActiveTemplate', id });
      return { ok: true, message: id === null ? 'Auto-sell is off' : 'armed' };
    },
    settings: () => over.settings ?? { mode: 'paper', execution: { liveSlippagePct: 15 }, strategy: {}, data: { hasBirdeyeKey: false, hasJupiterKey: false }, alerts: {}, evm: {} },
    analyze: async (mint) => {
      over.analyzeCalls = (over.analyzeCalls ?? 0) + 1;
      if (over.analyzeError) throw new Error(over.analyzeError);
      return over.analysis ?? { score: 61, verdict: 'cautious', summary: 'fine', bullish: ['a'], bearish: ['b'], provider: 'openai', model: 'm', at: Date.now(), mint };
    },
    log: () => {},
    toast: (level, message) => calls.toasts.push({ level, message }),
    changed: () => {},
    sandbox: {
      start: async (id) => {
        calls.started.push(id);
        if (over.startFails) return { ok: false, message: 'boom' };
        // `failStarts: n` fails the first n starts the way a stalled sandbox
        // does — retryable — and succeeds after that.
        if (over.failStarts && calls.started.length <= over.failStarts) {
          return { ok: false, message: 'the sandbox bridge never loaded', retryable: true };
        }
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
  // The app's MANUAL per-trade cap is NOT a second limit on a script
  // (2026-09-22). Its own budget is the authority on its size: two caps for
  // one decision meant keeping them in step, with the smaller winning
  // silently to whoever set the other. A rule inside its budget saves
  // whatever the manual cap happens to be.
  const under = { ...s, budget: { ...s.budget, maxSolPerTrade: 0.05 }, rules: { ...s.rules, actions: [{ type: 'buy', sol: 0.04 }] } };
  assert.equal(validateScript(under).ok, true, 'a rule inside the script’s own budget saves');
  assert.equal(validateScript(under, { maxLiveSol: 0.05 }).ok, true);
  assert.equal(validateScript(under).ok, true, 'no cap known → budget rule only');
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

test('a per-mint cooldown survives a restart — it is a wall the user set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-auto-cd-'));
  auto._reset();
  auto.init(dir);
  const h = makeHost();
  auto.attach(h);
  const s = saved(rulesScript({ name: 'CD' }, { oncePerMint: false, cooldownSec: 3600 }));
  auto.setEnabled(s.id, true);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow() });
  await tick(30);
  assert.equal(h.calls.buys.length, 1);
  await auto.shutdown();
  auto._reset();
  auto.init(dir);
  const h2 = makeHost();
  auto.attach(h2);
  const back = auto.all()[0];
  assert.equal(back.enabled, true, 'a paper script resumes');
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow() });
  await tick(30);
  assert.equal(h2.calls.buys.length, 0, 'the cooldown came back with it');
  auto.stopTimers();
  fs.rmSync(dir, { recursive: true, force: true });
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
  // The script must have OPENED these: a script may only sell what it bought,
  // never a bag the user opened by hand.
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'buy', args: [MINT2, 0.02] });
  await tick();
  h.book.paper.push(h.pos(MINT, 0.1, -35));
  h.book.paper.push(h.pos(MINT2, 0.1, +10));
  await auto.pollPositions();
  assert.deepEqual(h.calls.sells, [{ mint: MINT, pct: 100, mode: 'paper' }], 'only the loser is sold');
});

test('a position rule never even fires on a bag the user opened by hand', async () => {
  const h = setup();
  const s = saved(rulesScript({}, { trigger: 'position', conditions: [{ field: 'pnlPct', op: 'lte', value: -30 }], actions: [{ type: 'notify', message: 'down: {symbol}' }] }));
  auto.setEnabled(s.id, true);
  h.book.paper.push(h.pos(MINT, 5, -60)); // the user's own bag, deep in the red
  await auto.pollPositions();
  assert.deepEqual(h.calls.notifies, [], 'not this scripts position, not its business');
  // `held` is false for it too, so no rule anywhere can read it as one.
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'positions', args: [] });
  await tick();
  assert.deepEqual(h.calls.replies.find((r) => r.cid === 1).value, [], 'and bot.positions does not list it');
});

test('a script may NOT sell a position it did not open', async () => {
  const h = setup();
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  h.book.paper.push(h.pos(MINT, 5)); // the user's own bag
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'sell', args: [MINT, 100] });
  await tick();
  assert.equal(h.calls.sells.length, 0, 'a hand-bought bag is not the scripts to sell');
  assert.match(h.calls.replies.find((r) => r.cid === 1).value.message, /does not hold it/);
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
  // The script opens them first — it can only sell what it bought.
  auto.onSandboxMessage(c.id, { t: 'call', id: 90, method: 'buy', args: [MINT, 0.5] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 91, method: 'buy', args: [MINT2, 0.5] });
  await tick();
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

test('LIVE: blocked = refused with the reason; the script’s OWN budget is the size cap', async () => {
  const h = setup({ liveBlocked: 'the engine is not armed', maxLiveSol: 0.05 });
  const c = saved(codeScript({ mode: 'live', budget: { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 100 } }));
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick();
  assert.equal(h.calls.buys.length, 0);
  assert.match(h.calls.replies[0].value.message, /not executed — the engine is not armed/);
  // THE APP'S MANUAL PER-TRADE CAP IS NOT A SECOND LIMIT (2026-09-22). The
  // script's own budget is the authority on its size — it is set on the same
  // screen as its code and is what its author actually decided. Two caps for
  // one decision meant keeping them in step, with the smaller one winning
  // silently to whoever set the other.
  const h2 = setup({ maxLiveSol: 0.05 });
  const c2 = saved(codeScript({ mode: 'live', budget: { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 100 } }));
  auto.setEnabled(c2.id, true);
  auto.onSandboxMessage(c2.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.1] });
  await tick();
  assert.deepEqual(h2.calls.buys, [{ mint: MINT, sol: 0.1, mode: 'live' }], 'over the MANUAL cap, inside its own budget: it buys');
  // And the buy carries the script's own cap, so the backstop in the engine
  // enforces that number rather than the manual one.
  assert.deepEqual(h2.calls.buyCaps, [1], 'the host is handed the script’s own cap, so the engine enforces that one');
  // Its own budget still refuses, and says which limit bit.
  auto.onSandboxMessage(c2.id, { t: 'call', id: 2, method: 'buy', args: [MINT, 2] });
  await tick();
  assert.equal(h2.calls.buys.length, 1);
  assert.match(h2.calls.replies[1].value.message, /over the script's max per trade/);
});

test('paper never touches the live gate; a sell of something not held is refused', async () => {
  const h = setup({ liveBlocked: 'live is off' });
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick();
  assert.equal(h.calls.buys.length, 1, 'paper buys while live is blocked');
  // The user closed that bag by hand: the script still counts it as its own,
  // but there is nothing left in the book to sell.
  h.book.paper.length = 0;
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 50] });
  await tick();
  assert.equal(h.calls.sells.length, 0);
  assert.match(h.calls.replies.find((r) => r.cid === 2).value.message, /nothing held in paper mode/);
  // A mint it never opened is refused before the book is even consulted.
  auto.onSandboxMessage(c.id, { t: 'call', id: 3, method: 'sell', args: [MINT2, 50] });
  await tick();
  assert.equal(h.calls.sells.length, 0);
  assert.match(h.calls.replies.find((r) => r.cid === 3).value.message, /does not hold it/);
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

test('five errors in a row PAUSE a code script, it restarts by itself, and the fourth pause in 24 h turns it off', async () => {
  // Scripts run for days; the errors that trip the wall are mostly a parked
  // provider or a network hour, which clear. Off-until-noticed was the old
  // answer (2026-09-27). Never silent: log, toast and a desktop notification.
  auto._setRecoveryBackoff([60]);
  try {
    const h = setup({ dispatchResult: { ok: false, error: 'TypeError: x is not a function' } });
    const c = saved(codeScript({ mode: 'live' }));
    auto.setEnabled(c.id, true);
    await tick();
    auto.onSandboxMessage(c.id, { t: 'ready' });
    const burst = async (k) => {
      for (let i = 0; i < 5; i++) {
        auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: `Mint${k}${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` }) });
        await tick(20);
      }
    };
    for (let pause = 1; pause <= 3; pause++) {
      const startedBefore = h.calls.started.length;
      await burst(pause);
      const st = auto.snapshot().stats[c.id];
      assert.equal(auto.all()[0].enabled, true, `pause ${pause}: still armed, not disabled`);
      assert.equal(typeof st.pausedUntil, 'number', `pause ${pause}: paused`);
      assert.equal(st.running, false, 'nothing runs while paused');
      assert.match(st.lastError, /^paused until .* 5 errors in a row .*TypeError/);
      assert.ok(h.calls.notifies.some((n) => /restarts at .*\(LIVE\)/.test(n)), 'a desktop notification says when, and that it is live');
      assert.ok(h.calls.toasts.some((t) => /paused until/.test(t.message)));
      // Nothing is dispatched while paused.
      const sent = h.calls.dispatched.length;
      auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: 'MintPausedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }) });
      await tick(20);
      assert.equal(h.calls.dispatched.length, sent, 'a paused script hears nothing');
      await tick(90);
      assert.equal(h.calls.started.length, startedBefore + 1, `pause ${pause}: restarted by itself`);
      assert.equal(auto.snapshot().stats[c.id].pausedUntil, null);
      assert.equal(auto.snapshot().stats[c.id].errorsInARow, 0, 'the streak starts over');
      assert.ok(auto.snapshot().logs[c.id].some((l) => /restarting after its pause — LIVE/.test(l.line)));
    }
    await burst(4);
    assert.equal(auto.all()[0].enabled, false, 'the fourth trip in a day turns it off');
    assert.match(auto.snapshot().logs[c.id].at(-1).line, /DISABLED — .*stays off/);
    const startedAtOff = h.calls.started.length;
    await tick(90);
    assert.equal(h.calls.started.length, startedAtOff, 'and it does not come back');

    // Turning it off during a pause cancels the restart.
    const h3 = setup({ dispatchResult: { ok: false, error: 'boom' } });
    const c3 = saved(codeScript());
    auto.setEnabled(c3.id, true);
    await tick();
    for (let i = 0; i < 5; i++) {
      auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: `MintOff${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` }) });
      await tick(20);
    }
    assert.equal(typeof auto.snapshot().stats[c3.id].pausedUntil, 'number');
    auto.setEnabled(c3.id, false);
    await tick(90);
    assert.equal(h3.calls.started.length, 1, 'off means off');

    // A crash loop pauses too, rather than restarting forever or dying for good.
    const h4 = setup();
    const c4 = saved(codeScript());
    auto.setEnabled(c4.id, true);
    await tick();
    for (let i = 0; i < 6; i++) {
      auto.onSandboxGone(c4.id, 'renderer crashed');
      await tick();
    }
    const st4 = auto.snapshot().stats[c4.id];
    assert.equal(auto.all()[0].enabled, true);
    assert.match(st4.lastError ?? '', /paused until .*(restarted \d+ times in a minute|errors in a row)/);
    const n4 = h4.calls.started.length;
    await tick(90);
    assert.equal(h4.calls.started.length, n4 + 1, 'back after the pause');
  } finally {
    auto._setRecoveryBackoff(null);
  }
});

test('wantsTicks: an armed script following a coin (subscribed or opened) wants its ticks; a disarmed one does not', async () => {
  const h = setup();
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  assert.equal(auto.wantsTicks(MINT), false);
  assert.equal(auto.wantsAnyTicks(), false, 'nothing followed yet');
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'subscribe', args: [MINT] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'buy', args: [MINT2, 0.01] });
  await tick(30);
  assert.equal(auto.wantsTicks(MINT), true, 'subscribed');
  assert.equal(auto.wantsTicks(MINT2), true, 'opened');
  assert.equal(auto.wantsTicks(MINT3), false);
  assert.equal(auto.wantsAnyTicks(), true, 'something followed: the amm feed decodes');
  assert.equal(h.calls.buys.length, 1);
  auto.onSandboxMessage(c.id, { t: 'call', id: 3, method: 'unsubscribe', args: [MINT] });
  await tick();
  assert.equal(auto.wantsTicks(MINT), false, 'unsubscribed');
  auto.setEnabled(c.id, false);
  assert.equal(auto.wantsTicks(MINT2), false, 'a disarmed script follows nothing');
});

test('a script’s own state is saved within seconds and coalesced; a buy is saved at once and carries it', async () => {
  // Every save rewrites the whole file, every script's source included. The
  // soak measured ~17 writes a minute from one script's setStates (2026-09-27).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-soft-'));
  const h = setup();
  auto.init(dir);
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick(400);
  const real = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = function (f, ...rest) {
    if (String(f).endsWith('automation.json.tmp')) writes += 1;
    return real.call(this, f, ...rest);
  };
  try {
    for (let i = 0; i < 5; i++) {
      auto.onSandboxMessage(c.id, { t: 'call', id: 10 + i, method: 'setState', args: [{ n: i }] });
      await tick(20);
    }
    await tick(400);
    assert.equal(writes, 0, 'five setStates, no write yet');
    auto.onSandboxMessage(c.id, { t: 'call', id: 20, method: 'buy', args: [MINT, 0.01] });
    await tick(450);
    assert.equal(writes, 1, 'the buy is written within 300 ms');
    const saved1 = JSON.parse(fs.readFileSync(path.join(dir, 'automation.json'), 'utf8'));
    assert.deepEqual(saved1.runtime[c.id].kv, { n: 4 }, 'and carries the state set before it');
    assert.ok(saved1.runtime[c.id].opened[MINT], 'and the position');
    auto.onSandboxMessage(c.id, { t: 'call', id: 21, method: 'setState', args: [{ n: 9 }] });
    await tick(3_300);
    assert.equal(writes, 2, 'a lone setState is written within 3 s');
    assert.equal(h.calls.buys.length, 1);
  } finally {
    fs.writeFileSync = real;
    await auto.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bot.positions REJECTS when the wallet read failed — unknown is not empty', async () => {
  // The host answers a failed holdings read with []; a script that believed
  // it decided every bag was "no longer held" and cancelled its own stops
  // (2026-09-27, found reviewing scorenow for multi-day runs).
  const h = setup();
  let readOk = true;
  h.heldMints = async (mode) => (readOk ? new Set(h.book[mode].map((p) => p.mint)) : null);
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.01] });
  await tick(30);
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'positions', args: [] });
  await tick(30);
  const r2 = h.calls.replies.find((r) => r.cid === 2);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.value.map((x) => x.mint), [MINT]);
  readOk = false;
  h.book.paper = []; // what a failed read looks like to positions()
  auto.onSandboxMessage(c.id, { t: 'call', id: 3, method: 'positions', args: [] });
  await tick(30);
  const r3 = h.calls.replies.find((r) => r.cid === 3);
  assert.equal(r3.ok, false, 'a failed read is refused, not answered with []');
  assert.match(r3.error, /could not be read .* unknown, not empty/);
});

test('a restarted script does not inherit the last run’s bot.every timer', async () => {
  const h = setup();
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'every', args: [30] });
  await tick();
  assert.equal(auto._diag().scripts[c.id].intervalSec, 30);
  auto.onSandboxGone(c.id, 'renderer crashed');
  await tick();
  assert.equal(h.calls.started.length, 2, 'restarted');
  assert.equal(auto._diag().scripts[c.id].intervalSec, 0, 'the old timer is gone until the new run asks again');
  auto.stopTimers();
});

test('a running script writes an hourly health line: events, drops, handler times, restarts, memory, state', async () => {
  // Scripts run for days; app.log said nothing between a script's own lines,
  // so a slow degradation could not be seen after the fact (2026-09-27).
  auto._setHealthEvery(80);
  try {
    const h = setup();
    const lines = [];
    h.log = (level, line) => lines.push(line);
    h.sandbox.memoryMB = () => 87;
    const c = saved(codeScript({ name: 'healthy' }));
    auto.setEnabled(c.id, true);
    await tick();
    auto.onSandboxMessage(c.id, { t: 'ready' });
    auto.startTimers();
    for (let i = 0; i < 3; i++) {
      auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: `MintH${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` }) });
      await tick(10);
    }
    auto.onSandboxGone(c.id, 'renderer crashed');
    await tick(120);
    const line = lines.find((l) => /script "healthy" health/.test(l));
    assert.ok(line, 'a health line was written');
    assert.match(line, /up \d+m · 3 events, 0 failed, 0 dropped \(queue full\) · handler p50 \d+ ms, p95 \d+ ms, max \d+ ms · 1 restart\(s\) · sandbox 87 MB · state 0\.0 KB/);
  } finally {
    auto.stopTimers();
    auto._setHealthEvery(null);
  }
});

test('a stalled positions read cannot pile up event contexts without bound', async () => {
  // Each event's context awaits the positions read before it is queued; a read
  // that hangs (RPC, a network hour) used to retain one per launch, update and
  // tick until it returned (2026-09-27).
  const h = setup();
  let release;
  const gate = new Promise((r) => (release = r));
  const realPositions = h.positions;
  h.positions = async (mode) => {
    await gate;
    return realPositions(mode);
  };
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  for (let i = 0; i < 500; i++) auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: 'MintB' + String(i).padStart(4, 'x') + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }) });
  await tick();
  assert.equal(auto._diag().scripts[c.id].building, 200, 'at most 200 in flight');
  auto.onEngineEvent({ kind: 'runner', runner: { mint: MINT, name: 'n', symbol: 'R', creator: 'c', flaggedAt: Date.now(), windowS: 60, bucket: 'top5_10', observedPct: 10, basePct: 2, n: 10, line: '', mult3Line: null, priceSol: 1e-8, curvePct: 5, uniqueBuyers: 9, netInflowSol: 1, tradesSeen: 9 } });
  await tick();
  assert.equal(auto._diag().scripts[c.id].building, 201, 'a runner flag is never dropped for it');
  release();
  await tick(60);
  assert.equal(auto._diag().scripts[c.id].building, 0, 'all settle once the read returns');
  assert.ok(h.calls.dispatched.some((d) => d.name === 'runner'), 'and the flag is delivered');

  // A read that NEVER settles must not hold the ceiling shut for good: the
  // soak's did, and launch/tick events stopped for the life of the app.
  auto._setBuildTimeout(40);
  try {
    let hang = true;
    h.positions = async (mode) => {
      if (hang) await new Promise(() => undefined);
      return realPositions(mode);
    };
    for (let i = 0; i < 300; i++) auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: 'MintN' + String(i).padStart(4, 'x') + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }) });
    await tick();
    assert.equal(auto._diag().scripts[c.id].building, 200);
    await tick(120);
    assert.equal(auto._diag().scripts[c.id].building, 0, 'given up, not held forever');
    hang = false;
    const before = h.calls.dispatched.length;
    auto.onEngineEvent({ kind: 'launch', launch: launchRow({ mint: 'MintAfterxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }) });
    await tick(40);
    assert.equal(h.calls.dispatched.length, before + 1, 'and launches flow again');
  } finally {
    auto._setBuildTimeout(null);
  }
});

test('a sandbox that dies is restarted while enabled', async () => {
  const h2 = setup();
  const c2 = saved(codeScript());
  auto.setEnabled(c2.id, true);
  await tick();
  auto.onSandboxGone(c2.id, 'renderer crashed');
  await tick();
  assert.equal(h2.calls.started.length, 2, 'restarted once');
  assert.equal(auto.all()[0].enabled, true);
});

test('a stalled start is retried, not disarmed; a script that throws is disarmed at once', async () => {
  // The failure users hit read "DISABLED — could not start: no ready within
  // 8000 ms". A stall is usually the machine or a parked provider, and
  // disarming on the first one made them re-arm by hand for nothing.
  const h = setup({ failStarts: 1 });
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick(30);
  assert.equal(h.calls.started.length, 1, 'one attempt so far');
  assert.equal(auto.all()[0].enabled, true, 'still armed while it retries');
  assert.ok(auto.snapshot().logs[c.id].some((l) => /trying again in \d+ s \(attempt 1 of 3\)/.test(l.line)));
  await tick(2600);
  assert.equal(h.calls.started.length, 2, 'it tried again on its own');
  assert.equal(auto.all()[0].enabled, true);
  assert.ok(auto.snapshot().logs[c.id].some((l) => /sandbox running/.test(l.line)), 'and came up');

  // A body that throws fails identically every time, so it disarms at once.
  const h2 = setup({ startFails: true });
  const c2 = saved(codeScript({ name: 'thrower' }));
  auto.setEnabled(c2.id, true);
  await tick(30);
  assert.equal(h2.calls.started.length, 1, 'no retry for a script that cannot load');
  assert.equal(auto.all()[0].enabled, false, 'disarmed straight away');
});

test('disarming a script cancels a start retry that was already scheduled', async () => {
  const h = setup({ failStarts: 5 });
  const c = saved(codeScript());
  auto.setEnabled(c.id, true);
  await tick(30);
  assert.equal(h.calls.started.length, 1);
  auto.setEnabled(c.id, false);
  await tick(2600);
  assert.equal(h.calls.started.length, 1, 'a disarmed script does not come back');
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

// 2026-09-25 10:36: a restart paused WAIFU/PGPU's stop and take-profits and
// the script never heard — the orders diff treats a first sighting as its
// baseline. On start, a live script is TOLD (never resumed for it).
test('a live script starting up is told about paused orders on the coins it holds, and nothing is resumed', async () => {
  const h = setup();
  const c = saved(codeScript({ mode: 'live' }));
  // The script buys MINT (so it holds it), then the app restarts it.
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick(30);
  assert.deepEqual(auto._runtimeOf(c.id).opened, [MINT]);
  auto.setEnabled(c.id, false);
  await tick();
  const ord = (id, mint, kind, state) => ({ id, mint, symbol: 'COPY', kind, state, triggerBasis: 'pct', triggerValue: 100, amount: 50 });
  h.calls.orders = [
    ord('p1', MINT, 'take_profit', 'paused'),
    ord('p2', MINT, 'stop_loss', 'paused'),
    ord('p3', MINT2, 'take_profit', 'paused'), // a coin this script does not hold
    ord('a1', MINT, 'take_profit', 'armed'),
  ];
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  await tick(30);
  const evs = h.calls.dispatched.filter((d) => d.name === 'order');
  assert.deepEqual(evs.map((e) => [e.payload.orderKind, e.payload.orderState]).sort(), [['stop_loss', 'paused'], ['take_profit', 'paused']]);
  assert.ok(evs.every((e) => e.payload.mint === MINT), 'only the coin the script holds');
  assert.deepEqual(h.calls.orders.map((o) => o.state), ['paused', 'paused', 'paused', 'armed'], 'nothing resumed');
  assert.ok(auto.snapshot().logs[c.id].some((l) => /2 order\(s\) on 1 coin\(s\) this script holds came back PAUSED/.test(l.line)));

  // A paper script places no real orders, so it has none to be told about.
  const h2 = setup();
  const p = saved(codeScript({ mode: 'paper' }));
  auto.setEnabled(p.id, true);
  await tick();
  auto.onSandboxMessage(p.id, { t: 'ready' });
  auto.onSandboxMessage(p.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick(30);
  auto.setEnabled(p.id, false);
  await tick();
  h2.calls.orders = [ord('p1', MINT, 'take_profit', 'paused')];
  auto.setEnabled(p.id, true);
  await tick();
  auto.onSandboxMessage(p.id, { t: 'ready' });
  await tick(30);
  assert.equal(h2.calls.dispatched.filter((d) => d.name === 'order').length, 0);
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
  h.book.paper.push(h.pos(MINT, 0.1), h.pos(MINT2, 0.1), h.pos(MINT3, 9));
  // "Sell everything" means everything THIS SCRIPT holds. It opens two; the
  // third is the user's own bag and must survive.
  auto.onSandboxMessage(s.id, { t: 'call', id: 80, method: 'buy', args: [MINT, 0.02] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 81, method: 'buy', args: [MINT2, 0.02] });
  await tick();
  await auto._fireSchedule(s.id, '23:55');
  assert.deepEqual(h.calls.notifies, ['low wallet: 0.200 SOL']);
  assert.equal(h.calls.sells.length, 2, 'sell everything sold only what the script opened');
  assert.deepEqual(h.calls.sells.map((x) => x.mint).sort(), [MINT, MINT2].sort(), 'the users own bag is untouched');
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

test('daily times follow the wall clock: never early, on time fires, a time slept through is skipped and said', async () => {
  // One timer for up to 24 h ran on the process clock, which does not follow
  // the wall across a laptop sleep, a clock correction or a DST change
  // (2026-09-27). Now the wall clock is checked in short steps.
  assert.equal(auto.scheduleStep(1_000, 999), 'wait');
  assert.equal(auto.scheduleStep(1_000, 1_000), 'fire');
  assert.equal(auto.scheduleStep(1_000, 1_000 + auto.AT_LATE_MS), 'fire', 'a check that woke a little late still fires');
  assert.equal(auto.scheduleStep(1_000, 1_001 + auto.AT_LATE_MS), 'missed', 'asleep through it: skipped, not fired hours late');
  const realNow = Date.now;
  auto._setAtStep(15);
  try {
    const h = setup();
    const c = saved(codeScript({ name: 'sleepy' }));
    auto.setEnabled(c.id, true);
    await tick();
    auto.onSandboxMessage(c.id, { t: 'ready' });
    let fake = new Date(2026, 8, 27, 9, 29, 30).getTime();
    Date.now = () => fake;
    auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'at', args: ['09:30'] });
    const fired = () => h.calls.dispatched.filter((d) => d.name === 'schedule').length;
    await tick(60);
    assert.equal(fired(), 0, 'not before 09:30');
    fake += 60_000; // 09:30:30
    await tick(60);
    assert.equal(fired(), 1, 'fires at 09:30 by the wall clock');
    // Asleep through the NEXT day's 09:30, woken at 11:00.
    fake = new Date(2026, 8, 28, 11, 0, 0).getTime();
    await tick(60);
    assert.equal(fired(), 1, 'not fired an hour and a half late');
    assert.ok(auto.snapshot().logs[c.id].some((l) => /daily 09:30 missed/.test(l.line)), 'and it says so');
    assert.deepEqual(auto._runtimeOf(c.id).atTimers, ['09:30'], 're-armed for the day after');
  } finally {
    Date.now = realNow;
    auto._setAtStep(null);
    auto.stopTimers();
  }
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
  // 09-24: the placement line read like a fill ("take profit +100% sell 50% on X").
  assert.ok(auto.snapshot().logs[live.id].some((l) => l.line.startsWith('armed limit buy 0.05 SOL at $20000 mcap on COPY')), 'a placed order says it was ARMED, not that it traded');
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
  // 09-27 (REGULARS): a moonbag drops its stop and KEEPS its take-profit rungs.
  // cancelOrders takes a list of kinds; anything that is not a list of kinds
  // is refused — never read as "cancel everything".
  auto.onSandboxMessage(live.id, { t: 'call', id: 7, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 40, amount: 100 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 8, method: 'order', args: [{ mint: MINT2, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 300, amount: 50 }] });
  await tick();
  auto.onSandboxMessage(live.id, { t: 'call', id: 9, method: 'cancelOrders', args: [MINT2, ['stop_loss', 'trailing_stop']] });
  await tick();
  assert.equal(h2.calls.replies.find((r) => r.cid === 9).value.cancelled, 1, 'only the stop went');
  assert.deepEqual(h2.calls.orders.filter((o) => o.mint === MINT2).map((o) => o.kind), ['take_profit'], 'the take-profit rung is still armed');
  auto.onSandboxMessage(live.id, { t: 'call', id: 10, method: 'cancelOrders', args: [MINT2, ['bogus']] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 11, method: 'cancelOrders', args: [MINT2, []] });
  await tick();
  assert.equal(h2.calls.replies.find((r) => r.cid === 10).ok, false, 'an unknown kind is refused');
  assert.equal(h2.calls.replies.find((r) => r.cid === 11).ok, false, 'an empty list is refused, never "all"');
  assert.equal(h2.calls.orders.filter((o) => o.mint === MINT2).length, 1, 'nothing else was cancelled');
});

test('a limit order needs an absolute level: a percent basis is refused, not read as a market cap', async () => {
  const h = setup();
  const c = saved(codeScript({ mode: 'live' }));
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'order', args: [{ mint: MINT, kind: 'limit_buy', triggerBasis: 'pct', triggerValue: 20, amount: 0.01 }] });
  await tick();
  assert.equal(h.calls.orders.length, 0, 'no order armed at $20 market cap');
  const reply = h.calls.replies.find((r) => r.cid === 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /price_sol or mcap_usd/);
});

test('a disabled script gets no answers, and a market lookup costs an action', async () => {
  const h = setup({ market: { [MINT]: { liquidityUsd: 1 } } });
  const c = saved(codeScript({ budget: { maxSolPerTrade: 0.05, maxBuysPerDay: 10, maxLossSolPerDay: 1, maxOpenPositions: 5, maxActionsPerMinute: 2 } }));
  auto.setEnabled(c.id, true);
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'market', args: [MINT] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'market', args: [MINT] });
  auto.onSandboxMessage(c.id, { t: 'call', id: 3, method: 'market', args: [MINT] });
  await tick(30);
  assert.equal(h.calls.replies.find((r) => r.cid === 3).ok, false, 'the third is over the minute budget');
  assert.match(h.calls.replies.find((r) => r.cid === 3).error, /actions in a minute/);
  auto.setEnabled(c.id, false);
  auto.onSandboxMessage(c.id, { t: 'call', id: 4, method: 'wallet', args: [] });
  await tick();
  const off = h.calls.replies.find((r) => r.cid === 4);
  assert.equal(off.ok, false);
  assert.match(off.error, /disabled/);
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
  // `local` entries are answered inside the sandbox and never cross the wire,
  // so they are documented without being SCRIPT_METHODS. The flag lives on the
  // table rather than in a list of names here, which used to drift.
  for (const a of SCRIPT_API) if (!a.local) assert.ok(SCRIPT_METHODS.includes(a.method), `every documented method exists in the sandbox: ${a.method}`);
  for (const m of ['on', 'log', 'now', 'chain', 'nativeSymbol']) assert.ok(SCRIPT_API.find((a) => a.method === m)?.local, `${m} is marked local`);
  assert.ok(pack.includes('as **unknown, never as zero**'), 'the null rule is stated');
  assert.match(pack, /Output only the script/);
  assert.ok(pack.length > 8_000 && pack.length < 60_000, `a pasteable size (${pack.length} chars)`);
  // 09-22: the prose that is NOT generated from a table drifted — the pack
  // said handlers die at 3 s (a 30 s ceiling since 09-21), called the app
  // Solana-only, and never showed how to write an @inputs form.
  assert.match(pack, /up to \*\*30 seconds\*\*/, 'the real handler ceiling');
  assert.doesNotMatch(pack, /longer than \*\*3 seconds\*\* is killed/, 'not the old 3 s rule');
  assert.match(pack, /Solana, Robinhood Chain and BNB Chain/, 'every chain a script runs on');
  assert.match(pack, /bot\.nativeSymbol/, 'and how amounts are named');
  assert.match(pack, /Public actions/, 'callouts, follows and likes are public, and nothing on paper');
  const block = pack.slice(pack.indexOf('/* @inputs'), pack.indexOf('*/', pack.indexOf('/* @inputs')) + 2);
  const parsed = parseInputs(block);
  assert.equal(parsed.error, null, `the @inputs example the pack teaches parses: ${parsed.error}`);
  assert.equal(Object.keys(parsed.specs).length, 5, 'all five example fields');
  for (const t of ['text', 'lines', 'number', 'range', 'mint', 'wallet', 'pumpAccounts', 'select', 'toggle']) {
    assert.ok(pack.includes(t), `input type ${t} is named`);
  }
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

// ── Chains (2026-09-14) ────────────────────────────────────
//
// A script runs on ONE chain. The failure that matters is money on the wrong
// rail: a Solana launch firing a BNB script, or an EVM buy falling through to
// the Solana pipeline. The second failure that matters is silent: a rule built
// on a fact its chain cannot measure looks armed and can never fire.

test('a script hears only its OWN chain — a Solana launch never fires a BNB script', async () => {
  const h = setup();
  const sol = saved(rulesScript({ name: 'S', chain: 'solana' }, { conditions: [], actions: [{ type: 'buy', sol: 0.005 }] }));
  const bnb = saved(rulesScript({ name: 'B', chain: 'bnb' }, { conditions: [], actions: [{ type: 'buy', sol: 0.005 }] }));
  auto.setEnabled(sol.id, true);
  auto.setEnabled(bnb.id, true);
  auto.onEngineEvent({ kind: 'launchUpdate', launch: launchRow({ mint: MINT }) });
  await tick(30);
  assert.equal(h.calls.buys.length, 1, 'exactly one script acted');
  assert.equal(h.calls.buyChains[0], 'solana');
});

test('an EVM launch reaches its chain, and carries that chain to the buy', async () => {
  const h = setup();
  const bnb = saved(rulesScript({ name: 'B', chain: 'bnb' }, { conditions: [], actions: [{ type: 'buy', sol: 0.005 }] }));
  const sol = saved(rulesScript({ name: 'S', chain: 'solana' }, { conditions: [], actions: [{ type: 'buy', sol: 0.005 }] }));
  auto.setEnabled(bnb.id, true);
  auto.setEnabled(sol.id, true);
  auto.onEvmLaunch('bnb', {
    chain: 'bnb', token: '0xabc', name: 'T', symbol: 'T', creator: '0xc', seenAt: Date.now(), blockNumber: 1,
    windows: [
      { windowS: 60, buys: 4, sells: 0, uniqueBuyers: 9, netNative: 0.4, volumeNative: 0.5, curvePct: 5, creatorSold: false },
      { windowS: 120, buys: 9, sells: 1, uniqueBuyers: 20, netNative: 1.5, volumeNative: 2, curvePct: 12, creatorSold: false },
    ],
    graduatedAt: null, quote: 'native', call: null,
  });
  await tick(30);
  assert.equal(h.calls.buys.length, 1, 'only the BNB script acted');
  assert.equal(h.calls.buyChains[0], 'bnb', 'the buy goes out on the BNB rail');
  assert.equal(h.calls.buys[0].mint, '0xabc');
});

test('an EVM context fills only what that chain measures, and leaves the rest unknown', () => {
  const ctx = contextFromEvmLaunch({
    chain: 'bnb', token: '0xabc', name: 'T', symbol: 'T', creator: '0xc', seenAt: Date.now() - 60_000, blockNumber: 1,
    windows: [{ windowS: 60, buys: 9, sells: 1, uniqueBuyers: 20, netNative: 1.5, volumeNative: 2, curvePct: 12, creatorSold: false }],
    graduatedAt: null, quote: 'native', call: null,
  }, Date.now());
  assert.equal(ctx.uniqueBuyers, 20);
  assert.equal(ctx.buys, 9);
  assert.equal(ctx.netInflowSol, 1.5);
  assert.equal(ctx.creatorSold, false);
  assert.ok(ctx.ageSec >= 59 && ctx.ageSec <= 61);
  // Pump intel has no counterpart here and must stay UNKNOWN, never 0.
  for (const f of ['score', 'hardRisk', 'topHolderShare', 'creatorPriorRugs', 'smartBuyerCount']) {
    assert.equal(ctx[f], null, `${f} must be unknown on an EVM chain`);
  }
  assert.equal(conditionHolds({ field: 'score', op: 'gte', value: 0 }, ctx).ok, false);
});

test('money is unknown, not zero, when an EVM curve is not quoted in the chain coin', () => {
  // 78% of BNB curves were not BNB-quoted when this was audited. Summing them
  // as if they were is the bug; a null that cannot satisfy a rule is the fix.
  const ctx = contextFromEvmLaunch({
    chain: 'bnb', token: '0xabc', name: 'T', symbol: 'T', creator: '0xc', seenAt: Date.now(), blockNumber: 1,
    windows: [{ windowS: 60, buys: 9, sells: 1, uniqueBuyers: 20, netNative: null, volumeNative: null, curvePct: 12, creatorSold: false }],
    graduatedAt: null, quote: 'other', call: null,
  }, Date.now());
  assert.equal(ctx.netInflowSol, null);
  assert.equal(ctx.buyVolumeSol, null);
  assert.equal(ctx.uniqueBuyers, 20, 'a COUNT is still a count on any curve');
  assert.equal(conditionHolds({ field: 'netInflowSol', op: 'gt', value: 0 }, ctx).ok, false);
});

test('a rule its chain could never answer is refused at save, not left to fail quietly', () => {
  setup();
  const bad = auto.upsert(rulesScript({ chain: 'bnb' }, { conditions: [{ field: 'score', op: 'gte', value: 70 }], actions: [{ type: 'buy', sol: 0.005 }] }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not measured on BNB Smart Chain/);
  const badAction = auto.upsert(rulesScript({ chain: 'bnb' }, { conditions: [], actions: [{ type: 'stop_loss', pct: 20 }] }));
  assert.equal(badAction.ok, false);
  assert.match(badAction.message, /Solana-only/);
  // The same rule on Solana is fine.
  assert.equal(auto.upsert(rulesScript({ chain: 'solana' }, { conditions: [{ field: 'score', op: 'gte', value: 70 }], actions: [{ type: 'buy', sol: 0.005 }] })).ok, true);
});


test('a trigger its chain never fires is refused too', () => {
  setup();
  for (const t of ['tick', 'runner', 'order', 'alert']) {
    assert.equal(triggerAvailableOn(t, 'bnb'), false, `${t} cannot fire on BNB`);
    const r = auto.upsert(rulesScript({ chain: 'bnb' }, { trigger: t, conditions: [], actions: [{ type: 'buy', sol: 0.005 }] }));
    assert.equal(r.ok, false, `${t} should be refused on BNB`);
    assert.match(r.message, /never happens on BNB Smart Chain/);
  }
  // The ones both rails really do fire.
  for (const t of ['launch', 'launch_update', 'position', 'leader_trade', 'schedule']) {
    assert.equal(triggerAvailableOn(t, 'bnb'), true, `${t} should be available on BNB`);
  }
  assert.equal(triggerAvailableOn('tick', 'solana'), true, 'Solana keeps every trigger');
});

test('facts with no source on a rail are not offered there', () => {
  // The EVM bridge carries liquidity and market cap and nothing else, so
  // holders and priceUsd must not be buildable into a rule on those chains.
  for (const f of ['holders', 'priceUsd', 'launchpad']) assert.equal(fieldAvailableOn(f, 'bnb'), false, f);
  for (const f of ['marketCapUsd', 'liquidityUsd']) assert.equal(fieldAvailableOn(f, 'bnb'), true, f);
  for (const f of ['holders', 'priceUsd', 'launchpad', 'marketCapUsd', 'liquidityUsd']) {
    assert.equal(fieldAvailableOn(f, 'solana'), true, `${f} on Solana`);
  }
});


test('a code script is told its chain and its coin, without a round trip', () => {
  // bot.chain / bot.nativeSymbol ride along with the code in `init`. They are
  // getters because `bot` is frozen before init lands, and they exist before
  // the first event so a handler can branch on them immediately.
  const html = sandboxPageHtml();
  assert.match(html, /get chain\(\)/);
  assert.match(html, /get nativeSymbol\(\)/);
  assert.match(html, /m\.chain === 'string'/, 'init carries the chain');
  // Default before init, so a message that omits them is never undefined.
  assert.match(html, /let chain = 'solana'/);
  assert.match(html, /let nativeSymbol = 'SOL'/);
  // The mode is deliberately absent: a script that behaves differently on
  // paper is not a rehearsal of the live one.
  assert.ok(!/get mode\(\)/.test(html), 'mode is not exposed');
});

test('the chain capability tables agree with themselves', () => {
  assert.equal(fieldAvailableOn('score', 'solana'), true);
  assert.equal(fieldAvailableOn('score', 'bnb'), false);
  assert.equal(fieldAvailableOn('uniqueBuyers', 'bnb'), true, 'a count every chain measures');
  assert.equal(actionAvailableOn('buy', 'robinhood'), true, 'buying and selling work on every rail');
  assert.equal(actionAvailableOn('sell', 'robinhood'), true);
  assert.equal(actionAvailableOn('alert', 'robinhood'), false);
  // Absent chain reads as Solana, so every script saved before chains existed
  // keeps every field it had.
  assert.equal(scriptChain({}), 'solana');
  assert.equal(scriptChain({ chain: 'bnb' }), 'bnb');
});

test("an EVM chain's starter rule is built only from facts it can measure", () => {
  for (const chain of ['bnb', 'robinhood']) {
    for (const c of defaultRules(chain).conditions) {
      assert.ok(fieldAvailableOn(c.field, chain), `${c.field} must be measurable on ${chain}`);
    }
  }
});

// ── Release audit 2026-09-09: three walls that were not there ─────────

test('a script sells its OWN slice, not the whole wallet bag', async () => {
  const h = setup();
  const s = saved(rulesScript({ name: 'Slice' }));
  auto.setEnabled(s.id, true);
  // The script buys 0.02 SOL of it...
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick();
  // ...and the user then hand-adds to the same bag, so the wallet position is
  // 1.0 SOL. Before the fix, `sell 100%` here emptied all of it: the guard was
  // mint-granular (did this script open it?) but never size-granular.
  h.book.paper[0].costSol = 1.0;
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 100] });
  await tick(30);
  assert.equal(h.calls.sells.length, 1, 'the sell went through');
  assert.equal(h.calls.sells[0].pct, 2, '100% of a 0.02/1.0 share is 2% of the wallet holding');
});

// 09-25: every timed exit of a bag only the script bought sold 92–99% — its
// share was the REQUESTED 0.0165 SOL against the wallet's all-in 0.01711
// (priority fee + ATA rent), and the dust cost more to sell than it was worth.
test('a live script\'s share is priced from the chain, so "sell 100%" of its own bag sells all of it', async () => {
  const budget = { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 100 };
  const run = async (walletCost, chainSpent) => {
    const h = setup({ buyResult: { ok: true, message: 'bought', signature: 'SIG1' } });
    const seen = [];
    h.spentSolFor = (sigs) => { seen.push(sigs); return chainSpent; };
    const c = saved(codeScript({ mode: 'live', budget }));
    auto.setEnabled(c.id, true);
    await tick();
    auto.onSandboxMessage(c.id, { t: 'ready' });
    auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.0165] });
    await tick(30);
    h.book.live.push(h.pos(MINT, walletCost));
    auto.onSandboxMessage(c.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 100] });
    await tick(30);
    return { pct: h.calls.sells[0]?.pct, seen };
  };
  const own = await run(0.01711, 0.01711);
  assert.equal(own.pct, 100, 'all of a bag only the script bought');
  assert.deepEqual(own.seen, [['SIG1']], 'priced from the buy the script made');
  const handAdded = await run(0.01711 + 1.0, 0.01711);
  assert.equal(handAdded.pct, 2, 'a hand-added bag is still protected');
  const unreconciled = await run(0.01711, null);
  assert.equal(unreconciled.pct, 96, 'no chain price yet: the requested SOL stands in, as before');
});

test('a share too small to round to a percent can still exit', async () => {
  const h = setup();
  const s = saved(rulesScript({ name: 'Dust' }));
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.001] });
  await tick();
  h.book.paper[0].costSol = 1000;
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 100] });
  await tick(30);
  // 0.0001% rounds to 0, and a limit must never block an exit — so it floors
  // at 1, never at nothing.
  assert.equal(h.calls.sells[0].pct, 1, 'a rounding-to-zero share still sells 1%');
});

test('changing mode drops the positions the script claimed in the other one', async () => {
  const h = setup();
  const s = saved(rulesScript({ name: 'Flip' }));
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  await tick();
  assert.deepEqual(auto._runtimeOf(s.id).opened, [MINT], 'the paper buy is claimed');

  // `opened` is the authority to SELL. Carried into live, a script that only
  // ever rehearsed on paper could market-sell a real hand-bought bag on its
  // first live action.
  const after = saved({ ...auto.all().find((x) => x.id === s.id), mode: 'live' });
  assert.equal(after.mode, 'live');
  assert.deepEqual(auto._runtimeOf(s.id).opened, [], 'and dropped on the way across');
  assert.equal(after.enabled, false, 'switching to live still disarms');
});

test('bot.order cannot arm more buys than the budget allows, however fast it is called', async () => {
  const h = setup();
  const s = saved(rulesScript({ name: 'Race', mode: 'live', budget: { ...defaultScript('rules').budget, maxBuysPerDay: 1, maxSolPerTrade: 0.05, maxActionsPerMinute: 120 } }));
  auto.setEnabled(s.id, true);
  // buy_on_migration has no rule form, so it places directly — the one
  // spending path that used to sit outside the per-script chain. Measured
  // before the fix: 36 orders armed and 1.80 SOL committed against this exact
  // budget.
  for (let i = 0; i < 12; i++) {
    auto.onSandboxMessage(s.id, {
      t: 'call',
      id: 100 + i,
      method: 'order',
      args: [{ mint: MINT, kind: 'buy_on_migration', triggerBasis: 'price_sol', triggerValue: 0.001, amount: 0.05 }],
    });
  }
  await tick(200);
  const armed = h.calls.orders.filter((o) => o.kind === 'buy_on_migration');
  assert.equal(armed.length, 1, `the budget is 1 buy a day, ${armed.length} were armed`);
  assert.equal(auto._runtimeOf(s.id).buysToday, 1, 'and exactly one was reserved');
});

// ── A script's money is its CHAIN's money ─────────────────────────────
//
// The rule model stores every money field with a `Sol` id, because the ids
// are a saved rule's schema and renaming them would break every stored
// script. The LABELS were supposed to follow the chain — `nativeFieldLabel`
// was written for exactly that on 2026-09-11 and then never called anywhere.
// So a script on Robinhood Chain described itself in SOL at every turn, and
// a user reported believing their EVM script was trading SOL (2026-09-15).

test('a rule describes itself in the coin its chain actually spends', () => {
  const r = { ...defaultRules('robinhood'), actions: [{ type: 'buy', sol: 0.02 }] };
  assert.match(describeRules(r, 'robinhood'), /buy 0\.02 ETH/, describeRules(r, 'robinhood'));
  assert.match(describeRules(r, 'bnb'), /buy 0\.02 BNB/);
  assert.match(describeRules(r, 'solana'), /buy 0\.02 SOL/, 'and Solana is untouched');
  assert.match(describeRules(r), /buy 0\.02 SOL/, 'the default stays Solana for every existing caller');
});

test('an action describes itself in the chain coin, on every money-carrying kind', () => {
  assert.equal(describeAction({ type: 'buy', sol: 0.5 }, 'robinhood'), 'buy 0.5 ETH');
  assert.equal(describeAction({ type: 'limit_buy', sol: 0.5, basis: 'price_sol', value: 2 }, 'bnb'), 'limit buy 0.5 BNB at 2 BNB');
  assert.equal(describeAction({ type: 'limit_sell', pct: 50, basis: 'mcap_usd', value: 1000 }, 'bnb'), 'limit sell 50% at $1000 mcap', 'a USD level stays USD');
  assert.equal(describeAction({ type: 'sell', pct: 50 }, 'robinhood'), 'sell 50%', 'a percentage has no coin in it');
});

test('a condition label follows the chain, while the field ID does not move', () => {
  const f = RULE_FIELDS.find((x) => x.id === 'priceSol');
  assert.equal(f.label, 'Price (SOL)', 'the stored model is unchanged');
  assert.equal(nativeFieldLabel(f.label, 'robinhood', 'ETH'), 'Price (ETH)');
  assert.equal(nativeFieldLabel(f.label, 'solana', 'SOL'), 'Price (SOL)');
  // The id is a saved rule's schema: renaming it would break every script.
  assert.equal(f.id, 'priceSol');
});

test('prose follows the chain too — the sentence someone reads before arming', () => {
  const line = 'Live spends real SOL on its own.';
  assert.equal(nativeText(line, 'robinhood'), 'Live spends real ETH on its own.');
  assert.equal(nativeText(line, 'bnb'), 'Live spends real BNB on its own.');
  assert.equal(nativeText(line, 'solana'), line);
  // Only the whole word. "SOLANA" and "sold" must survive intact.
  assert.equal(nativeText('SOLANA sold 5 SOL', 'bnb'), 'SOLANA sold 5 BNB');
});

test('a save refused for size says the refusal in the right coin', () => {
  const s = {
    ...defaultScript('rules', 'robinhood'),
    name: 'Big',
    mode: 'live',
    rules: { ...defaultRules('robinhood'), conditions: [], actions: [{ type: 'buy', sol: 9 }] },
  };
  // Refused by the script's OWN budget now — the manual cap no longer applies
  // to a script. The point of this case is the WORDING: an ETH script must not
  // be told off in SOL.
  const v = validateScript(s);
  assert.equal(v.ok, false);
  assert.match(v.message, /ETH/, v.message);
  assert.ok(!/SOL/.test(v.message), `no SOL in an ETH script's refusal: ${v.message}`);
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

// ── "Any data we can get, scripts should have" (2026-09-20) ────────────

const SUMMARY_EXTRAS = ['kryptScore', 'bondingCurvePct', 'devHoldingPct', 'top10Pct', 'insiderPct', 'bundledPct', 'sniperPct', 'smartHolders', 'volume5mUsd', 'buys5m', 'sells5m', 'priceChange5mPct'];
const LINK_FIELDS = ['hasTwitter', 'hasWebsite', 'hasTelegram', 'dexPaid', 'twitter', 'website', 'telegram', 'xLinkKind', 'xHandle', 'xReuseCount', 'xFollowers', 'xFollowing', 'xVerified', 'xLikes', 'xReposts', 'xReplies', 'xViews', 'xStatsAgeSec', 'tgMembers', 'tgOnline', 'tgKind', 'domainAgeDays', 'domainHostedOn', 'siteNamesContract', 'siteLinksX', 'siteOutboundHosts', 'siteMentionsConnectWallet'];
const fakeSummary = (over = {}) => ({
  mint: MINT,
  symbol: 'FAKE',
  name: 'Fake Coin',
  launchpad: 'pumpfun',
  priceSol: 0.000001,
  priceUsd: 0.0002,
  marketCapUsd: 200_000,
  liquidityUsd: 40_000,
  holders: 321,
  kryptScore: 72,
  bondingCurvePct: 55,
  devHoldingPct: 3.5,
  top10Pct: 22,
  insiderPct: 8,
  bundledPct: 12,
  sniperPct: 4,
  smartHolders: 2,
  stats: { '5m': { volumeUsd: 9_000, buys: 40, sells: 12, priceChangePct: 18.5 } },
  socials: { twitter: 'https://x.com/fakecoin', website: 'https://fake.coin', telegram: null, dexPaid: true },
  ...over,
});

test('the variable guide carries the provider extras and the links, on Solana only', () => {
  for (const id of [...SUMMARY_EXTRAS, ...LINK_FIELDS]) {
    const f = RULE_FIELDS.find((x) => x.id === id);
    assert.ok(f, `${id} is a variable`);
    assert.equal(f.scope, 'market', `${id} is a market fact`);
    assert.ok(f.nullWhen.length > 0, `${id} says when it is null`);
    assert.equal(fieldAvailableOn(id, 'solana'), true);
    assert.equal(fieldAvailableOn(id, 'bnb'), false, `${id} is not offered on an EVM chain — its host does not answer it`);
  }
  assert.equal(RULE_FIELDS.find((x) => x.id === 'hasTwitter').kind, 'boolean');
  assert.equal(RULE_FIELDS.find((x) => x.id === 'xLinkKind').kind, 'text');
  assert.equal(RULE_FIELDS.find((x) => x.id === 'xReuseCount').kind, 'number');
});

test('one summary becomes the facts a script sees, links classified, unknowns null', () => {
  const facts = marketFactsFromSummary(fakeSummary(), 3);
  const c = withMarket(emptyContext(MINT), facts);
  assert.equal(c.kryptScore, 72);
  assert.equal(c.bondingCurvePct, 55);
  assert.equal(c.devHoldingPct, 3.5);
  assert.equal(c.top10Pct, 22);
  assert.equal(c.insiderPct, 8);
  assert.equal(c.bundledPct, 12);
  assert.equal(c.sniperPct, 4);
  assert.equal(c.smartHolders, 2);
  assert.equal(c.volume5mUsd, 9_000);
  assert.equal(c.buys5m, 40);
  assert.equal(c.sells5m, 12);
  assert.equal(c.priceChange5mPct, 18.5);
  assert.equal(c.hasTwitter, true);
  assert.equal(c.hasWebsite, true);
  assert.equal(c.hasTelegram, false, 'a provider that answered with no Telegram is a real "none"');
  assert.equal(c.dexPaid, true);
  assert.equal(c.twitter, 'https://x.com/fakecoin');
  assert.equal(c.website, 'https://fake.coin');
  assert.equal(c.telegram, null);
  assert.equal(c.xLinkKind, 'profile');
  assert.equal(c.xHandle, 'fakecoin');
  assert.equal(c.xReuseCount, 3);
  // A post link is a post, not an account.
  const post = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary({ socials: { twitter: 'https://x.com/someone/status/1234567890', website: null, telegram: null, dexPaid: false } })));
  assert.equal(post.xLinkKind, 'post');
  assert.equal(post.xHandle, 'someone');
  assert.equal(post.hasWebsite, false);
  assert.equal(post.xReuseCount, null, 'not counted is null, never 0');
  // No 5-minute window, no score: null, never 0.
  const thin = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary({ stats: {}, kryptScore: null })));
  assert.equal(thin.volume5mUsd, null);
  assert.equal(thin.kryptScore, null);
  // An EVM host's facts carry none of this: every one stays null, not false.
  const evm = withMarket(emptyContext(MINT), { priceSol: 1, priceUsd: null, marketCapUsd: 5, liquidityUsd: 2, holders: null, launchpad: null });
  for (const id of [...SUMMARY_EXTRAS, ...LINK_FIELDS]) assert.equal(evm[id], null, `${id} is unknown, not a claim`);
});

test('a fresh runner gets its links from the launch metadata when no provider has answered', () => {
  // The bug: hasTwitter/hasWebsite came ONLY from a provider summary, which a
  // just-flagged runner rarely has, so a link filter waited and then dropped it.
  const bare = withLaunchLinks(withMarket(emptyContext(MINT), null), { twitter: true, website: false, telegram: true });
  assert.equal(bare.hasTwitter, true);
  assert.equal(bare.hasWebsite, false, 'the metadata file said no website: a real none');
  assert.equal(bare.hasTelegram, true);
  assert.equal(bare.twitter, null, 'no address known: none is invented');
  // With the cached metadata file, the addresses come along — the only way a
  // "website" that is really an X search can be seen.
  const withUrls = withLaunchLinks(emptyContext(MINT), { twitter: true, website: true, telegram: false, twitterUrl: 'https://x.com/someone', websiteUrl: 'https://x.com/search?q=coin', telegramUrl: null });
  assert.equal(withUrls.website, 'https://x.com/search?q=coin');
  assert.equal(withUrls.twitter, 'https://x.com/someone');
  assert.equal(withUrls.xLinkKind, 'profile');
  assert.equal(withUrls.telegram, null);
  // A provider that answered wins.
  const answered = withLaunchLinks(withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary())), { twitter: false, website: false, telegram: true });
  assert.equal(answered.hasTwitter, true);
  assert.equal(answered.hasTelegram, false);
  // Metadata not resolved: still unknown, never false.
  const unread = withLaunchLinks(emptyContext(MINT), null);
  assert.equal(unread.hasTwitter, null);
  assert.equal(unread.hasWebsite, null);
});

test('bot.links answers from cached facts with the launchpad page and the X reuse', () => {
  const links = scriptLinksFromSummary('solana', fakeSummary(), { handle: 2, post: 0 });
  assert.equal(links.twitter, 'https://x.com/fakecoin');
  assert.equal(links.website, 'https://fake.coin');
  assert.equal(links.telegram, null);
  assert.equal(links.launchpadLabel, 'pump.fun');
  assert.equal(links.launchpadUrl, `https://pump.fun/coin/${MINT}`);
  assert.deepEqual(links.x, { kind: 'profile', handle: 'fakecoin', postId: null, label: links.x.label, accountReuse: 2, postReuse: 0, stats: null, statsReadAt: null });
  // What the Links panel read off the page rides along when a person opened it there.
  const read = scriptLinksFromSummary('solana', fakeSummary(), { handle: 0, post: 0 }, { stats: { page: 'profile', handle: 'fakecoin', followers: 12300, following: 40, joined: 'March 2021', verified: false, likes: null, reposts: null, replies: null, views: null, bookmarks: null, loginWall: false, title: 't' }, readAt: 7 });
  assert.equal(read.x.stats.followers, 12300);
  assert.equal(read.x.statsReadAt, 7);
  const profileRead = { stats: { page: 'profile', handle: 'fakecoin', followers: 12300, following: 40, joined: 'March 2021', verified: true, likes: null, reposts: null, replies: null, views: null, bookmarks: null, loginWall: false, title: 't' }, readAt: Date.now() - 90_000 };
  const withRead = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary(), null, profileRead));
  assert.equal(withRead.xFollowers, 12300, 'every number the page showed is a rule variable');
  assert.equal(withRead.xFollowing, 40);
  assert.equal(withRead.xVerified, true);
  assert.equal(withRead.xLikes, null, 'a profile has no likes');
  assert.ok(withRead.xStatsAgeSec >= 89 && withRead.xStatsAgeSec <= 95, `age in seconds (${withRead.xStatsAgeSec})`);
  const postRead = { stats: { page: 'post', handle: 'fakecoin', followers: null, following: null, joined: null, verified: null, likes: 1203, reposts: 210, replies: 88, views: 45200, bookmarks: 12, loginWall: false, title: 't' }, readAt: Date.now() };
  const withPost = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary(), null, postRead));
  assert.equal(withPost.xLikes, 1203);
  assert.equal(withPost.xReposts, 210);
  assert.equal(withPost.xReplies, 88);
  assert.equal(withPost.xViews, 45200);
  assert.equal(withPost.xFollowers, null, 'a post has no followers');
  const unread = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary()));
  for (const id of ['xFollowers', 'xFollowing', 'xVerified', 'xLikes', 'xReposts', 'xReplies', 'xViews', 'xStatsAgeSec']) assert.equal(unread[id], null, `${id}: nobody read it is null, never 0`);
  const none = scriptLinksFromSummary('solana', fakeSummary({ launchpad: 'unknown', socials: { twitter: null, website: null, telegram: null, dexPaid: false } }), { handle: 0, post: 0 });
  assert.equal(none.launchpadUrl, null, 'no page the app knows = no link, not a guess');
  assert.equal(none.x.kind, 'none');
  // Telegram's preview, the domain record and the site read ride along the
  // same way (2026-09-20), and every one is null until looked up or read.
  assert.equal(links.telegramStats, null);
  assert.equal(links.domain, null);
  assert.equal(links.site, null);
  const intel = {
    telegram: { kind: 'channel', members: 149, countWord: 'subscribers', online: null, title: 'Krypt.cc', readAt: 5 },
    domain: { name: 'fake.coin', registeredAt: new Date(Date.now() - 400 * 86_400_000).toISOString(), registrar: 'NameCheap, Inc.', hostedOn: null, readAt: 6 },
  };
  const siteRead = { read: { url: 'https://fake.coin/', host: 'fake.coin', title: 'Fake', description: null, namesContract: true, xHandles: ['fakecoin'], telegramLinks: [], outboundHosts: 3, wordCount: 120, generator: null, mentionsConnectWallet: false }, readAt: 7 };
  const full = scriptLinksFromSummary('solana', fakeSummary(), { handle: 0, post: 0 }, null, intel, siteRead);
  assert.equal(full.telegramStats.members, 149);
  assert.equal(full.domain.registrar, 'NameCheap, Inc.');
  assert.equal(full.site.namesContract, true);
  assert.equal(full.site.readAt, 7);
  const withIntel = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary(), null, null, intel, siteRead));
  assert.equal(withIntel.tgMembers, 149);
  assert.equal(withIntel.tgOnline, null, 'a channel shows no online count: unknown');
  assert.equal(withIntel.tgKind, 'channel');
  assert.ok(withIntel.domainAgeDays >= 399 && withIntel.domainAgeDays <= 401, `age in days (${withIntel.domainAgeDays})`);
  assert.equal(withIntel.domainHostedOn, null);
  assert.equal(withIntel.siteNamesContract, true);
  assert.equal(withIntel.siteLinksX, true, 'the site links the token’s own X account');
  assert.equal(withIntel.siteOutboundHosts, 3);
  assert.equal(withIntel.siteMentionsConnectWallet, false);
  const hosted = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary(), null, null, { telegram: null, domain: { name: null, registeredAt: null, registrar: null, hostedOn: 'Vercel', readAt: 1 } }, null));
  assert.equal(hosted.domainHostedOn, 'Vercel');
  assert.equal(hosted.domainAgeDays, null, 'a shared platform has no age of the coin’s own');
  assert.equal(hosted.tgMembers, null);
  assert.equal(hosted.siteLinksX, null, 'nothing read off the site is unknown, not false');
  const noX = withMarket(emptyContext(MINT), marketFactsFromSummary(fakeSummary({ socials: { twitter: null, website: 'https://fake.coin', telegram: null, dexPaid: false } }), null, null, null, siteRead));
  assert.equal(noX.siteLinksX, null, 'no X link on the token = nothing to compare');
  assert.equal(noX.siteNamesContract, true);
});

test('links is free, security and creator cost an action, and analyze is capped per hour', async () => {
  const over = {
    links: { [MINT]: { twitter: 'https://x.com/a', website: null, telegram: null, launchpadLabel: 'pump.fun', launchpadUrl: 'https://pump.fun/coin/' + MINT, x: { kind: 'profile', handle: 'a', postId: null, label: 'X account @a', accountReuse: 0, postReuse: 0 } } },
    security: { [MINT]: { score: 80, checksResolved: 9, checksTotal: 10, checks: [{ id: 'mint', label: 'Mint authority', verdict: 'pass', detail: 'revoked' }], warnings: [] } },
    creator: { [MINT]: { address: 'Creator1', launches: 7, graduated: 1, graduationRate: 14.3, medianAthUsd: 20_000, bestAthUsd: 90_000, firstLaunchAt: 1, lastLaunchAt: 2, truncated: false } },
  };
  const h = setup(over);
  const s = saved({ ...rulesScript(), budget: { ...rulesScript().budget, maxActionsPerMinute: 30 } });
  auto.setEnabled(s.id, true);
  // 35 link reads: none is an action, so none is refused by the 30-a-minute guard.
  for (let i = 1; i <= 35; i++) auto.onSandboxMessage(s.id, { t: 'call', id: i, method: 'links', args: [MINT] });
  await tick();
  const linkReplies = h.calls.replies.filter((r) => r.cid <= 35);
  assert.equal(linkReplies.length, 35);
  assert.ok(linkReplies.every((r) => r.ok && r.value?.x?.handle === 'a'), 'every link read answered, free');
  auto.onSandboxMessage(s.id, { t: 'call', id: 101, method: 'security', args: [MINT] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 102, method: 'creator', args: [MINT] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 103, method: 'links', args: [MINT2] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 104, method: 'security', args: ['not a mint'] });
  await tick();
  const by = (cid) => h.calls.replies.find((r) => r.cid === cid);
  assert.equal(by(101).value.score, 80);
  assert.equal(by(101).value.checks[0].verdict, 'pass');
  assert.equal(by(102).value.launches, 7);
  assert.equal(by(103).value, null, 'nothing cached for the other mint is null');
  assert.equal(by(104).ok, false);
  assert.match(by(104).error, /bad mint/);
  // analyze: 20 an hour, then refused with the reason — and the host was not asked for the 21st.
  for (let i = 1; i <= 21; i++) auto.onSandboxMessage(s.id, { t: 'call', id: 200 + i, method: 'analyze', args: [MINT] });
  await tick();
  const ok = [];
  const refused = [];
  for (let i = 1; i <= 21; i++) (by(200 + i).ok ? ok : refused).push(i);
  assert.equal(ok.length, 20, `20 analyses answered (got ${ok.length})`);
  assert.equal(refused.length, 1);
  assert.match(by(221).error, /20 AI analyses in an hour/);
  assert.equal(over.analyzeCalls, 20, 'the key was spent exactly 20 times');
  assert.equal(by(201).value.score, 61);
});

test('an AI refusal (off, no key, bad reply) reaches the script as the reason, never as a crash', async () => {
  const over = { analyzeError: 'AI analysis is off, or the key for the selected provider is missing (Settings → AI).' };
  const h = setup(over);
  const s = saved(rulesScript());
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'analyze', args: [MINT] });
  await tick();
  const r = h.calls.replies.find((x) => x.cid === 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /AI analysis is off/);
});

test('the four new methods are sandbox methods and documented', () => {
  for (const m of ['links', 'security', 'creator', 'analyze']) {
    assert.ok(SCRIPT_METHODS.includes(m), `${m} is callable`);
    const a = SCRIPT_API.find((x) => x.method === m);
    assert.ok(a, `${m} is documented`);
    assert.ok(/Solana only/.test(a.notes), `${m} says it is Solana only`);
  }
  assert.equal(SCRIPT_API.find((x) => x.method === 'analyze').action, true, 'analyze is an action — it spends');
  assert.equal(SCRIPT_API.find((x) => x.method === 'links').action, false, 'links is a free read');
  assert.ok(/never visits/.test(SCRIPT_API.find((x) => x.method === 'links').notes), 'the app never visits the links');
});

// ── what a script author has to be told (2026-09-21) ─────────────────────
//
// From a real report: a script ran seven hours in paper across 1,770 launch
// updates and never bought. Nothing was broken — it waited for `score` to
// climb above 80, and the score is computed ONCE per launch. Every update
// carried the same number. The three facts below are what the guide now
// states, pinned here so the words cannot drift from the code that makes
// them true.

test('the score field warns that it never moves, and says what it typically is', () => {
  const f = RULE_FIELDS.find((x) => x.id === 'score');
  assert.ok(f, 'the score field exists');
  assert.match(f.hint, /fixed once|never moves/i, `a script author must be told it does not move: "${f.hint}"`);
  assert.match(f.hint, /do not wait for it to rise/i);
  // A typical range, so "> 80" reads as the 1-in-36 bet it is rather than a
  // round number someone picked.
  assert.match(f.hint, /[0-9]+\s*[\u2013-]\s*[0-9]+/, 'and roughly where it usually lands');
  assert.match(f.nullWhen, /never on the launch feed/);
});

test('the launchUpdate event leads with the score being fixed, not buries it', () => {
  const e = SCRIPT_EVENTS_DOC.find((x) => x.event === 'launchUpdate');
  assert.ok(e);
  assert.match(e.when, /SCORE DOES NOT CHANGE/, 'stated in the open, where it cannot be skimmed past');
  assert.match(e.when, /flow fields/i, 'and what DOES move is named');
  // It used to be the tail of one long sentence: a reader reached "the score
  // is fixed at decision time" after eighty words, and did not.
  assert.ok(e.when.indexOf('SCORE DOES NOT CHANGE') < 120, 'and near the front of the sentence');
});

test('creatorSold says what FALSE means, which is not what it looks like', () => {
  const f = RULE_FIELDS.find((x) => x.id === 'creatorSold');
  assert.ok(f);
  assert.match(f.hint, /seen YET/i, `false is "none seen yet", never "there will not be one": "${f.hint}"`);
  assert.match(f.hint, /not that there will not be one/i);
  assert.equal(f.kind, 'boolean');
  // And the tri-state is real: unknown must not read as either answer.
  const ctx = emptyContext('Mint1111111111111111111111111111111111111');
  assert.equal(ctx.creatorSold, null, 'unknown until a launch fills it in');
  const isFalse = conditionHolds({ field: 'creatorSold', op: 'is_false', value: '' }, ctx);
  assert.equal(isFalse.ok, false, 'an unknown creatorSold does not pass "is false"');
  assert.match(isFalse.why, /unknown/, 'and the reason says unknown, not that it is true');
  const isTrue = conditionHolds({ field: 'creatorSold', op: 'is_true', value: '' }, ctx);
  assert.equal(isTrue.ok, false, 'nor "is true" — unknown passes neither, which is the whole point');
});

// ── Script stats on a widget (09-22) ──────────────────────────────────
test('bot.stat values reach the snapshot, in order, updated in place, capped, and reset per run', () => {
  setup();
  const s = saved(codeScript());
  auto.onSandboxMessage(s.id, { t: 'stats', values: { Callouts: 1, Likes: 0 } });
  auto.onSandboxMessage(s.id, { t: 'stats', values: { 'PnL (SOL)': 0.25, Callouts: 2 } });
  let m = auto.snapshot().metrics[s.id];
  assert.deepEqual(m.map((x) => [x.name, x.value]), [['Callouts', 2], ['Likes', 0], ['PnL (SOL)', 0.25]], 'first-set order, same name replaced');
  // At most MAX_STAT_KEYS: a new name past the cap is dropped, an existing one still updates.
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
  auto.onSandboxMessage(s.id, { t: 'stats', values: many });
  auto.onSandboxMessage(s.id, { t: 'stats', values: { Callouts: 9 } });
  m = auto.snapshot().metrics[s.id];
  assert.equal(m.length, 24, 'capped at 24');
  assert.equal(m.find((x) => x.name === 'Callouts').value, 9, 'a shown name still updates at the cap');
  auto.onSandboxMessage(s.id, { t: 'stats', values: {}, clear: true });
  assert.equal(auto.snapshot().metrics[s.id].length, 0, 'clearStats empties it');
  auto.onSandboxMessage(s.id, { t: 'stats', values: { Trades: 3 } });
  auto.onSandboxMessage(s.id, { t: 'alive' });
  assert.equal(auto.snapshot().metrics[s.id].length, 0, 'a new run starts with an empty widget');
});

test('the Script monitor widget exists, shows metrics and the log, and new panels come on once', () => {
  const reg = fs.readFileSync('src/panels/registry.tsx', 'utf8');
  assert.match(reg, /id: 'scriptmonitor', HeaderControl: ScriptMonitorHeaderControl/);
  assert.match(reg, /snap\.metrics\?\.\[sc\.id\]/, 'reads the script’s own metrics');
  assert.match(reg, /snap\.logs\[sc\.id\]/, 'and its log');
  const ws = fs.readFileSync('src/pages/Workspace.tsx', 'utf8');
  assert.match(ws, /const SEEN_KEY = 'krypt\.panels\.seen\.v1'/);
  const load = ws.slice(ws.indexOf('function loadEnabled'), ws.indexOf('/** Pages that can be pinned'));
  assert.doesNotMatch(load, /return DEFAULT_ENABLED;/, 'no early return skips recording what was seen');
  assert.match(load, /setItem\(STORE_KEY[\s\S]{0,80}setItem\(SEEN_KEY/, 'the merged set and the seen-list are written together');
});

// ── The orphaned live buy (user report, 2026-09-24) ─────────────────────
// A live buy landed, the wallet held the tokens, and every sell after it was
// refused in 0.0 s with "this script does not hold it". The position poll
// pruned the script's registry against a holdings read that had failed or
// trailed the buy, and a failed read answered as an EMPTY wallet.

const LIVE_BUDGET = { maxSolPerTrade: 0.1, maxBuysPerDay: 20, maxLossSolPerDay: 1, maxOpenPositions: 5, maxActionsPerMinute: 60 };
const withClock = async (offsetMs, fn) => {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
};

test('a fresh live buy survives a holdings read that has not caught up, and can be sold', async () => {
  const h = setup();
  // The wallet read trails the landed buy: it knows nothing yet.
  h.heldMints = async () => new Set();
  h.book.live = [];
  h.buy = async (mint, sol, mode) => {
    h.calls.buys.push({ mint, sol, mode });
    return { ok: true, message: 'Landed' }; // …and NOT in the book yet
  };
  const s = saved(codeScript({ name: 'rapid', mode: 'live', budget: LIVE_BUDGET }));
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.03] });
  await tick();
  await auto.pollPositions();
  assert.deepEqual(auto._runtimeOf(s.id).opened, [MINT], 'the poll did not prune a buy the RPC has not shown yet');
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 100] });
  await tick(30);
  assert.equal(h.calls.sells.length, 1, 'the sell went to the chain instead of being refused');
  assert.equal(h.calls.sells[0].pct, 100, 'selling what was asked, since the basis is not read yet');
});

test('a FAILED holdings read never prunes, however old the position', async () => {
  const h = setup();
  h.heldMints = async () => null;
  const s = saved(codeScript({ name: 'rapid', mode: 'live', budget: LIVE_BUDGET }));
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.03] });
  await tick();
  await withClock(10 * 60_000, () => auto.pollPositions());
  assert.deepEqual(auto._runtimeOf(s.id).opened, [MINT], 'unknown is not "sold"');
});

test('a position really gone from a read that WORKED is pruned once the grace has passed', async () => {
  const h = setup();
  h.heldMints = async () => new Set();
  const s = saved(codeScript({ name: 'rapid', mode: 'live', budget: LIVE_BUDGET }));
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.03] });
  await tick();
  await withClock(auto.OPEN_GRACE_MS + 1_000, () => auto.pollPositions());
  assert.deepEqual(auto._runtimeOf(s.id).opened, [], 'sold by hand is still noticed');
  // Past the grace the old refusal stands — it is true now.
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 100] });
  await tick(30);
  assert.equal(h.calls.sells.length, 0);
});

test('a bag bought with another wallet is never pruned against the active wallet, and a full sell releases it', async () => {
  const h = setup();
  h.heldMints = async () => new Set();
  const OTHER = 'Other1111111111111111111111111111111111111';
  const walletCalls = [];
  h.walletBuy = async (address, mint, sol) => (walletCalls.push(['buy', address, mint, sol]), { ok: true, message: 'bought' });
  h.walletSell = async (address, mint, pct) => (walletCalls.push(['sell', address, mint, pct]), { ok: true, message: 'sold' });
  const s = saved(codeScript({ name: 'multi', mode: 'live', budget: LIVE_BUDGET }));
  auto.setEnabled(s.id, true);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.03, OTHER] });
  await tick();
  assert.equal(walletCalls.length, 1, 'the named-wallet buy went out');
  await withClock(10 * 60_000, () => auto.pollPositions());
  assert.deepEqual(auto._runtimeOf(s.id).opened, [MINT], 'the active wallet says nothing about another wallet’s bag');
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'sell', args: [MINT, 100, OTHER] });
  await tick(30);
  assert.deepEqual(walletCalls.at(-1), ['sell', OTHER, MINT, 100]);
  assert.deepEqual(auto._runtimeOf(s.id).opened, [], 'a full exit from that wallet ends the claim');
});

// Krypto Trader stage 3 (critic #6): a live session's (wallet, coin) pair is
// its own. A script buy into it — from the active wallet or a named one — is
// refused with the session named; a paper script (no wallet touched) and
// another coin are not.
test('LIVE: a Krypto Trader claim refuses a script buy on that coin, active or named wallet', async () => {
  const h = setup();
  const OTHER = 'Other1111111111111111111111111111111111111';
  const walletCalls = [];
  const asked = [];
  h.walletBuy = async (address, mint, sol) => (walletCalls.push(['buy', address, mint, sol]), { ok: true, message: 'bought' });
  auto.setTraderClaimCheck((ref, mint) => {
    asked.push(ref);
    return mint === MINT ? 'a live Krypto Trader session (KT, kt_abc) trades this coin from wallet Wa11et…' : null;
  });
  try {
    const s = saved(codeScript({ name: 'claims', mode: 'live', budget: LIVE_BUDGET }));
    auto.setEnabled(s.id, true);
    auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
    await tick();
    assert.equal(h.calls.buys.length, 0, 'the active-wallet buy is refused');
    assert.match(h.calls.replies[0].value.message, /Krypto Trader session \(KT, kt_abc\)/, 'and the refusal names the session');
    assert.deepEqual(asked[0], { walletId: null }, 'bot.buy is checked against the ACTIVE wallet');
    auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'buy', args: [MINT, 0.02, OTHER] });
    await tick();
    assert.equal(walletCalls.length, 0, 'a named-wallet buy is refused too');
    assert.deepEqual(asked.at(-1), { address: OTHER }, 'checked against the NAMED wallet');
    auto.onSandboxMessage(s.id, { t: 'call', id: 3, method: 'buy', args: [MINT2, 0.02] });
    await tick();
    assert.equal(h.calls.buys.length, 1, 'another coin buys');
    const p = saved(codeScript({ name: 'paperclaims', mode: 'paper', budget: LIVE_BUDGET }));
    auto.setEnabled(p.id, true);
    auto.onSandboxMessage(p.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
    await tick();
    assert.equal(h.calls.buys.length, 2, 'a paper script touches no wallet, so no claim applies');
  } finally {
    auto.setTraderClaimCheck(null);
  }
});

test('reset paper trades: paper scripts start over, live scripts are untouched', async () => {
  const h = setup();
  h.heldMints = async (mode) => new Set(h.book[mode].map((p) => p.mint));
  const paper = saved(codeScript({ name: 'p', mode: 'paper', budget: LIVE_BUDGET }));
  const live = saved(codeScript({ name: 'l', mode: 'live', budget: LIVE_BUDGET }));
  auto.setEnabled(paper.id, true);
  auto.setEnabled(live.id, true);
  auto.onSandboxMessage(paper.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.02] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 1, method: 'buy', args: [MINT2, 0.02] });
  await tick(30);
  assert.equal(auto.forgetPaper(), 1, 'one paper script started over');
  const p = auto._runtimeOf(paper.id);
  assert.deepEqual(p.opened, []);
  assert.equal(p.buysToday, 0);
  assert.equal(p.realizedToday, 0);
  assert.deepEqual(auto._runtimeOf(live.id).opened, [MINT2], 'live keeps its position');
  assert.equal(auto._runtimeOf(live.id).buysToday, 1, 'and its day');
});

test('a paper buy the book refused is reported as a failure, not a position', () => {
  const src = fs.readFileSync('electron/engine/engine.ts', 'utf8').split(String.fromCharCode(13)).join('');
  const refused = src.indexOf('PAPER buy not booked: ${opened.message}`);');
  assert.ok(refused > 0, 'the refusal is logged');
  assert.ok(src.slice(refused, refused + 200).includes('return { ...res, ok: false,'), 'not booked is not bought');
  const held = src.slice(src.indexOf('private async scriptHeldMints'), src.indexOf('private async scriptPositions'));
  assert.ok(held.includes('if (!h.ok || !h.data) return null;'), 'a failed holdings read is null, never an empty set');
});

test('reset a script: its own saved totals go; a live script keeps its positions and today’s budget', async () => {
  const h = setup();
  h.heldMints = async (mode) => new Set(h.book[mode].map((p) => p.mint));
  const live = saved(codeScript({ name: 'scorenow', mode: 'live', budget: LIVE_BUDGET }));
  const paper = saved(codeScript({ name: 'p', mode: 'paper', budget: LIVE_BUDGET }));
  auto.setEnabled(live.id, true);
  auto.setEnabled(paper.id, true);
  // What scorenow does: running totals in its saved state, painted into the widget.
  auto.onSandboxMessage(live.id, { t: 'call', id: 1, method: 'setState', args: [{ counts: { buys: 29, callouts: 23 } }] });
  auto.onSandboxMessage(live.id, { t: 'stats', values: { Buys: 29 } });
  auto.onSandboxMessage(live.id, { t: 'call', id: 2, method: 'buy', args: [MINT, 0.02] });
  auto.onSandboxMessage(paper.id, { t: 'call', id: 1, method: 'buy', args: [MINT2, 0.02] });
  await tick(30);
  assert.deepEqual(auto._runtimeOf(live.id).kv, { counts: { buys: 29, callouts: 23 } }, 'setup: the totals are saved');

  assert.equal(auto.resetScript(live.id).ok, true);
  const l = auto._runtimeOf(live.id);
  assert.deepEqual(l.kv, {}, 'the script’s own saved totals are gone');
  assert.equal(auto.snapshot().metrics[live.id].length, 0, 'and the widget');
  assert.deepEqual(l.opened, [MINT], 'but it can still sell what it holds');
  assert.equal(l.buysToday, 1, 'and today’s buy still counts against its cap');

  auto.resetScript(paper.id);
  const pp = auto._runtimeOf(paper.id);
  assert.deepEqual(pp.opened, [], 'paper forgets its positions');
  assert.equal(pp.buysToday, 0, 'and its day');
  assert.equal(auto.resetScript('nope').ok, false);
});


// 2026-09-25: a 78 KB script hit the 64 KB cap. The cap protected the live
// update, which carried every script's full code on every log line — so the
// live update no longer carries code, and the cap went up.
// 2026-09-26: the cap is gone entirely — a 1 MB script saves.
test('live updates carry no code; the window keeps its own; there is no size cap', () => {
  assert.ok(saved(codeScript({ name: 'Huge', code: `// ${'x'.repeat(1024 * 1024)}
bot.on('launch', () => {})` })), 'a 1 MB script saves');
  const big = saved(codeScript({ name: 'Big', code: `// ${'x'.repeat(100 * 1024)}
bot.on('launch', () => {})` }));
  assert.ok(big, 'a 100 KB script saves');
  const full = auto.snapshot();
  const live = auto.snapshot(false);
  assert.ok(full.scripts.find((x) => x.id === big.id).code.length > 100 * 1024, 'a full read carries the code');
  assert.equal(live.codeOmitted, true);
  assert.ok(live.scripts.every((x) => x.code === ''), 'a live update carries none');
  const m = mergeSnapshot(full, live);
  assert.equal(m.stale, false);
  assert.equal(m.snap.scripts.find((x) => x.id === big.id).code, full.scripts.find((x) => x.id === big.id).code, 'the window keeps the code it had');
  const unseen = mergeSnapshot(null, live);
  assert.equal(unseen.stale, true, 'a script the window never saw means: re-read the list');
  const edited = { ...full, scripts: full.scripts.map((x) => (x.id === big.id ? { ...x, updatedAt: x.updatedAt - 1 } : x)) };
  const e = mergeSnapshot(edited, live);
  assert.equal(e.stale, true, 'saved since → re-read');
  assert.ok(e.snap.scripts.find((x) => x.id === big.id).code.length > 0, 'but never blanks code it has in the meantime');
  assert.deepEqual(mergeSnapshot(null, full).snap, full, 'a full read passes straight through');
  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(eng.includes("snapshot: automation.snapshot(false)"), 'the engine sends the codeless snapshot live');
});

// 2026-09-27: with pump.fun parking this IP, bot.creator answered null for
// 25 of 37 classic flags, and a script that refuses unknown creators skipped
// them all. The host now falls back to Jupiter audit counts - both or none.
test('bot.creator falls back to Jupiter audit counts when pump is silent', () => {
  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  const i = eng.indexOf('creator: async (mint, chain) => {');
  assert.ok(i > 0, 'the host method exists');
  const body = eng.slice(i, i + 3000);
  assert.ok(body.includes('launchIntel.creatorHistory(creator)'), 'pump first');
  assert.ok(body.includes('audit.devMints'), 'then Jupiter mints');
  assert.ok(body.includes('audit.devMigrations'), 'and graduations');
  assert.ok(body.includes("if (typeof g !== 'number' || !Number.isFinite(g) || g < 0) return null;"), 'no graduation count = no record, never a made-up 0');
});

// 2026-09-27: a script ships with the app (bundled/scripts/*.js).
test('a shipped script is installed once, off and in paper; updates replace edited copies too, keeping the edit as its own script; a deleted one stays deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-bundled-'));
  auto._reset();
  auto.init(dir);
  auto.attach(makeHost());
  const v1 = { key: 'krypto-script', name: 'Krypto Script', code: "bot.log('v1');" };
  auto.seedBundled([v1]);
  let s = auto.all().find((x) => x.bundled?.key === 'krypto-script');
  assert.ok(s, 'installed');
  assert.equal(s.enabled, false, 'off');
  assert.equal(s.mode, 'paper', 'paper');
  auto.seedBundled([v1]);
  assert.equal(auto.all().filter((x) => x.bundled?.key === 'krypto-script').length, 1, 'never twice');
  // A new app version, the user has not edited it: the code follows.
  auto.seedBundled([{ ...v1, code: "bot.log('v2');" }]);
  s = auto.all().find((x) => x.bundled?.key === 'krypto-script');
  assert.equal(s.code, "bot.log('v2');", 'unedited copy updates');
  // The window can never mint or strip the mark.
  const other = saved(codeScript({ name: 'mine' }));
  auto.upsert({ ...auto.all().find((x) => x.id === other.id), bundled: { key: 'krypto-script', sha: 'x' } });
  assert.equal(auto.all().find((x) => x.id === other.id).bundled, undefined, 'a user script cannot claim to be shipped');
  // The user edits it: the shipped copy STILL follows the app (2026-09-28: a
  // broken shipped script must be fixed for everyone), and the edit is kept
  // as a script of its own — off, in paper, not marked shipped.
  auto.upsert({ ...s, code: "bot.log('mine');" });
  s = auto.all().find((x) => x.bundled?.key === 'krypto-script');
  assert.equal(s.bundled.edited, true, 'marked edited');
  auto.seedBundled([{ ...v1, code: "bot.log('v3');" }]);
  assert.equal(auto.all().find((x) => x.id === s.id).code, "bot.log('v3');", 'an edited copy is replaced too');
  const kept = auto.all().find((x) => x.name === 'Krypto Script (your edit)');
  assert.ok(kept, 'the edit is kept as its own script');
  assert.equal(kept.code, "bot.log('mine');");
  assert.equal(kept.enabled, false, 'off');
  assert.equal(kept.mode, 'paper', 'paper');
  assert.equal(kept.bundled, undefined, 'the kept copy is a user script');
  assert.equal(auto.all().filter((x) => x.bundled?.key === 'krypto-script').length, 1, 'still one shipped copy');
  auto.seedBundled([{ ...v1, code: "bot.log('v3');" }]);
  assert.equal(auto.all().filter((x) => x.name === 'Krypto Script (your edit)').length, 1, 'the same version never keeps a second copy');
  assert.equal(auto.resetBundled(s.id).ok, true);
  assert.equal(auto.all().find((x) => x.id === s.id).code, "bot.log('v3');", 'reset brings the shipped code');
  assert.equal(auto.resetBundled(other.id).ok, false, 'reset refuses a user script');
  // Deleted stays deleted, across a restart.
  auto.remove(s.id);
  await auto.shutdown();
  auto._reset();
  auto.init(dir);
  auto.seedBundled([v1]);
  assert.equal(auto.all().filter((x) => x.bundled?.key === 'krypto-script').length, 0, 'a deleted shipped script does not come back');
  // Invalid shipped code is never installed.
  auto.seedBundled([{ key: 'broken', name: 'Broken', code: '' }]);
  assert.equal(auto.all().some((x) => x.bundled?.key === 'broken'), false, 'invalid code is refused');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shipped script file itself passes the app’s own validation', async () => {
  const code = fs.readFileSync(new URL('../bundled/scripts/krypto-script.js', import.meta.url), 'utf8');
  const v = validateScript({ ...defaultScript('code'), name: 'Krypto Script', code });
  assert.equal(v.ok, true, v.message);
  // 2026-09-28: 5.3.0 shipped a script whose @inputs block the app refused
  // (33 fields against a 32 cap), so it installed with NO settings — buySol
  // undefined and all. The block must read, and every field must carry a
  // default, or the script has nothing to run on.
  const { parseInputs } = await import('./.scriptinputs.mjs');
  const parsed = parseInputs(code);
  assert.equal(parsed.error, null, `the shipped @inputs block reads: ${parsed.error}`);
  assert.ok(Object.keys(parsed.specs).length >= 30, 'the settings are all there');
  for (const [k, spec] of Object.entries(parsed.specs)) assert.ok('default' in spec, `${k} has a default`);
  const src = fs.readFileSync(new URL('../electron/engine/bundledScripts.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("bundled/scripts/krypto-script.js?raw"), 'built into the app from that file');
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('automation.seedBundled(BUNDLED_SCRIPTS)'), 'seeded at startup');
});

// ── The Launch tab's cohorts, and every other read (2026-09-27) ────────
//
// A user saw "bundle 44 %, snipers 34 %" on the Launch tab and null in the
// script's bundledPct / sniperPct for the same coin: the tab measures the
// launch window itself (shared/launchintel.ts) while those two fields were
// only ever the providers', and the providers index a new pump coin minutes
// later, if at all. The report now crosses to scripts three ways — a call, the
// facts object, and the security report's concentration block — and each is
// pinned here. The rules: an incomplete scan says nothing (never 0 wallets),
// held figures are never inferred from bought ones, a provider's number is
// never overwritten, and the cohorts ride into the facts object only from the
// memo — a launch event never buys a scan.

const cohort = (over = {}) => ({ wallets: 0, bought: 0, boughtPct: null, sol: 0, heldPct: null, retainedPct: null, stillHolding: null, ...over });
const fakeLaunchReport = (over = {}, analysisOver = {}) => ({
  mint: MINT,
  creator: 'Cre',
  supply: 1_000_000_000,
  analysis: {
    launchSlot: 100,
    launchTs: 1_700_000_000_000,
    complete: true,
    tradesScanned: 80,
    slotsSpanned: 40,
    dev: cohort({ wallets: 1, bought: 30_000_000, boughtPct: 3, sol: 1.2, heldPct: 3, retainedPct: 100, stillHolding: 1 }),
    bundle: cohort({ wallets: 12, bought: 440_000_000, boughtPct: 44, sol: 9.8, heldPct: 38, retainedPct: 86, stillHolding: 11 }),
    snipers: cohort({ wallets: 20, bought: 340_000_000, boughtPct: 34, sol: 8.1, heldPct: 2, retainedPct: 6, stillHolding: 3 }),
    wallets: [
      { address: 'B1', cohort: 'bundle', firstSlot: 100, slotOffset: 0, bought: 100_000_000, boughtPct: 10, sol: 2, soldInWindow: false, heldNow: 100_000_000, heldPct: 10 },
      { address: 'Cre', cohort: 'dev', firstSlot: 100, slotOffset: 0, bought: 30_000_000, boughtPct: 3, sol: 1.2, soldInWindow: false, heldNow: 30_000_000, heldPct: 3 },
    ],
    priced: true,
    top3BuyersPct: 27,
    ...analysisOver,
  },
  sniperWindowSlots: 20,
  source: 'pumpswap',
  note: null,
  balancesNote: null,
  generatedAt: Date.now(),
  ...over,
});

test('launch cohorts fold into the facts object: bought and held together, never inferred, provider shares left alone, incomplete scans say nothing', () => {
  const li = scriptLaunchIntelFromReport(fakeLaunchReport());
  // The mapping lifts the analysis and drops nothing.
  assert.equal(li.complete, true);
  assert.equal(li.bundle.boughtPct, 44);
  assert.equal(li.bundle.heldPct, 38);
  assert.equal(li.snipers.stillHolding, 3);
  assert.equal(li.wallets.length, 2);
  assert.equal(li.wallets[0].cohort, 'bundle');
  assert.equal(li.wallets[0].slotOffset, 0);
  assert.equal(li.sniperWindowSlots, 20);
  assert.equal(li.top3BuyersPct, 27);

  const c = withLaunchIntel(emptyContext(MINT), li);
  assert.equal(c.launchDevPct, 3);
  assert.equal(c.launchDevHeldPct, 3);
  assert.equal(c.launchBundlePct, 44);
  assert.equal(c.launchBundleHeldPct, 38);
  assert.equal(c.launchBundleRetainedPct, 86);
  assert.equal(c.launchBundleWallets, 12);
  assert.equal(c.launchBundleStillHolding, 11);
  assert.equal(c.launchSniperPct, 34);
  assert.equal(c.launchSniperHeldPct, 2);
  assert.equal(c.launchSniperRetainedPct, 6);
  assert.equal(c.launchSniperWallets, 20);
  assert.equal(c.launchSniperStillHolding, 3);
  assert.equal(c.launchTop3BuyersPct, 27);
  // No provider figure → the scan's fills the old field, so a script written
  // against bundledPct starts seeing a number on new pump coins.
  assert.equal(c.bundledPct, 44);
  assert.equal(c.sniperPct, 34);
  // A provider's figure is never overwritten.
  const withProvider = emptyContext(MINT);
  withProvider.bundledPct = 12;
  withProvider.sniperPct = 5;
  withLaunchIntel(withProvider, li);
  assert.equal(withProvider.bundledPct, 12);
  assert.equal(withProvider.sniperPct, 5);
  assert.equal(withProvider.launchBundlePct, 44, 'the launch field still carries the scan');
  // Unpriced: bought figures present, held figures null — never inferred.
  const unpriced = scriptLaunchIntelFromReport(
    fakeLaunchReport({}, { priced: false, bundle: cohort({ wallets: 12, bought: 440_000_000, boughtPct: 44, sol: 9.8 }), snipers: cohort({ wallets: 20, boughtPct: 34 }), dev: cohort({ wallets: 1, boughtPct: 3 }) }),
  );
  const u = withLaunchIntel(emptyContext(MINT), unpriced);
  assert.equal(u.launchBundlePct, 44);
  assert.equal(u.launchBundleHeldPct, null);
  assert.equal(u.launchBundleRetainedPct, null);
  assert.equal(u.launchBundleStillHolding, null);
  assert.equal(u.launchBundleWallets, 12, 'the count is known before the balances are');
  // Incomplete: the launch block was not isolated. Every field stays null —
  // not "0 wallets", which would be a confident claim about a block nobody saw.
  const inc = scriptLaunchIntelFromReport(fakeLaunchReport({ note: 'Too much launch traffic' }, { complete: false, dev: cohort(), bundle: cohort(), snipers: cohort(), wallets: [], priced: false, top3BuyersPct: null }));
  assert.equal(inc.complete, false);
  assert.equal(inc.note, 'Too much launch traffic');
  const i = withLaunchIntel(emptyContext(MINT), inc);
  for (const f of ['launchBundlePct', 'launchBundleWallets', 'launchSniperWallets', 'launchDevPct', 'launchTop3BuyersPct', 'bundledPct', 'sniperPct']) assert.equal(i[f], null, `${f} stays unknown on an incomplete scan`);
  // No report at all: untouched.
  const none = withLaunchIntel(emptyContext(MINT), null);
  assert.equal(none.launchBundlePct, null);
  // Every launch field is in the guide, Solana-only, scope market.
  for (const f of ['launchDevPct', 'launchDevHeldPct', 'launchBundlePct', 'launchBundleHeldPct', 'launchBundleRetainedPct', 'launchBundleWallets', 'launchBundleStillHolding', 'launchSniperPct', 'launchSniperHeldPct', 'launchSniperRetainedPct', 'launchSniperWallets', 'launchSniperStillHolding', 'launchTop3BuyersPct']) {
    const spec = RULE_FIELDS.find((x) => x.id === f);
    assert.ok(spec, `${f} is in the variable guide`);
    assert.equal(spec.scope, 'market');
    assert.equal(fieldAvailableOn(f, 'bnb'), false, `${f} is Solana only`);
    assert.equal(fieldAvailableOn(f, 'solana'), true);
  }
});

test('the security report crosses whole: concentration, rug, odds, creator verdict — and a first launch is no record, not a pass', () => {
  const report = {
    mint: MINT,
    score: 71,
    checksResolved: 9,
    checksTotal: 11,
    checks: [
      { id: 'mint', label: 'Mint authority', verdict: 'pass', detail: 'revoked', source: 'onchain', weight: 15 },
      { id: 'bundle_share', label: 'Bundle share', verdict: 'unknown', detail: '44 % bought, 38 % held', source: 'pumpswap', weight: 0, kind: 'fact' },
    ],
    concentration: { devPct: 3, top10Pct: 51, top20Pct: 60, insiderPct: null, sniperPct: 34, bundledPct: 44, bundledHeldPct: 38, sniperHeldPct: 2, source: 'pumpswap' },
    creator: { address: 'Cre', priorLaunches: 2, priorRugs: 0, source: 'derived', history: { address: 'Cre', launches: 7, graduated: 0, graduationRate: 0, firstLaunchAt: 1, lastLaunchAt: 2, medianAthUsd: null, bestAthUsd: null, recent: [], truncated: false, launchesInBusiestDay: 3 } },
    rug: { windowS: 60, measuredOn: '2026-07-27', population: 'p', flags: [{ id: 'sells_over_buys', label: 'Sells over buys', detail: 'd', badPct: 80, deadPct: 70, gradPct: 1, n: 100, severity: 'hide' }], states: { sells_over_buys: 'fired' }, hide: true, tradesSeen: 40 },
    volatility: [{ id: 'bundle', label: 'Bundle', detail: 'x', dumpedPct: 40, gradPct: 5, n: 300 }],
    odds: { model: '2026-07-27', windowS: 60, regime: 'classic', graduate: { bucket: 'top', observedPct: 30, n: 100, basePct: 5, line: 'l' }, mult3: null, mult5: null, footer: 'f', tradesSeen: 40 },
    descriptive: { socials: { hasAny: true, twitter: true, telegram: false, website: false }, dexPaid: { paid: true, paidAt: 5, boosts: 2, communityTakeover: false, source: 'dexscreener' }, note: 'n' },
    creatorRecord: { launches: 7, graduated: 0, devMints: 9, devMigrations: 0, rugcheckCreatorRugs: false, source: 'pumpfun' },
    generatedAt: 123,
  };
  const s = scriptSecurityFromReport(report, ['stale price']);
  assert.equal(s.score, 71);
  assert.deepEqual(s.warnings, ['stale price']);
  assert.equal(s.checks[0].kind, 'gate', 'an older row without kind is a gate');
  assert.equal(s.checks[1].kind, 'fact');
  assert.equal(s.checks[1].source, 'pumpswap');
  assert.equal(s.concentration.bundledPct, 44);
  assert.equal(s.concentration.bundledHeldPct, 38);
  assert.equal(s.concentration.sniperHeldPct, 2);
  assert.equal(s.concentration.insiderPct, null, 'unknown stays null');
  assert.equal(s.rug.hide, true);
  assert.equal(s.rug.flags[0].id, 'sells_over_buys');
  assert.equal(s.odds.graduate.observedPct, 30);
  assert.equal(s.volatility[0].id, 'bundle');
  assert.equal(s.dexPaid.paid, true);
  assert.equal(s.dexPaid.boosts, 2);
  assert.equal(s.creator.launches, 7);
  assert.equal(s.creator.graduated, 0);
  assert.equal(s.creator.launchesInBusiestDay, 3);
  assert.equal(s.creator.devMints, 9);
  assert.equal(s.creator.rugcheckCreatorRugs, false);
  assert.equal(s.creator.verdict, 'warn', '7 launches, none graduated');
  assert.match(s.creator.detail, /none graduated/);
  assert.equal(s.generatedAt, 123);
  // First launch: the absence of a record. Null, never green.
  const first = scriptSecurityFromReport({ ...report, creator: { ...report.creator, history: { ...report.creator.history, launches: 1, graduated: 0 } } }, []);
  assert.equal(first.creator.verdict, null);
  assert.match(first.creator.detail, /no record/);
  // No history at all: the Jupiter floor still reaches the script; verdict null.
  const none = scriptSecurityFromReport({ ...report, creator: { ...report.creator, history: null } }, []);
  assert.equal(none.creator.verdict, null);
  assert.equal(none.creator.launches, 7, 'creatorRecord.launches fills in');
  assert.equal(none.creator.graduationRate, null);
  // A factory reads fail.
  const factory = scriptSecurityFromReport({ ...report, creator: { ...report.creator, history: { ...report.creator.history, launches: 30, launchesInBusiestDay: 14 } } }, []);
  assert.equal(factory.creator.verdict, 'fail');
});

test('bot.launchIntel costs an action, answers null off Solana without asking, and the cached scan rides into bot.token', async () => {
  const report = fakeLaunchReport();
  const li = scriptLaunchIntelFromReport(report);
  const over = { launchIntel: { [MINT]: li }, launchIntelCached: { [MINT]: li }, market: { [MINT]: { priceSol: 0.001, priceUsd: 0.2, marketCapUsd: 200_000, liquidityUsd: 40_000, holders: 500, launchpad: 'pumpfun', symbol: 'COPY', name: 'Copy Coin' } } };
  const h = setup(over);
  const s = saved({ ...rulesScript(), budget: { ...rulesScript().budget, maxActionsPerMinute: 3 } });
  auto.setEnabled(s.id, true);
  const by = (cid) => h.calls.replies.find((r) => r.cid === cid);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'launchIntel', args: [MINT] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'launchIntel', args: ['not a mint'] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 3, method: 'launchIntel', args: [MINT] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 4, method: 'launchIntel', args: [MINT] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 5, method: 'launchIntel', args: [MINT] });
  await tick();
  assert.equal(by(1).ok, true);
  assert.equal(by(1).value.bundle.boughtPct, 44);
  assert.equal(by(1).value.bundle.heldPct, 38);
  assert.equal(by(1).value.wallets[0].address, 'B1');
  assert.equal(by(2).ok, false);
  assert.match(by(2).error, /bad mint/);
  assert.equal(by(5).ok, false, 'the 4th real call is over a 3-a-minute budget');
  assert.match(by(5).error, /actions in a minute/);
  assert.equal(over.launchIntelCalls, 3, 'the host was asked exactly three times');
  // The facts object carries the cached scan — and bundledPct from it — with
  // no extra request: bot.token is a free read and stays one.
  auto.onSandboxMessage(s.id, { t: 'call', id: 6, method: 'token', args: [MINT] });
  await tick();
  assert.equal(by(6).ok, true, by(6).error);
  assert.equal(by(6).value.launchBundlePct, 44);
  assert.equal(by(6).value.launchBundleHeldPct, 38);
  assert.equal(by(6).value.launchSniperStillHolding, 3);
  assert.equal(by(6).value.bundledPct, 44, 'no provider figure → the scan fills bundledPct');
  assert.equal(over.launchIntelCalls, 3, 'bot.token bought no scan');
  // Off Solana: null, and the host is never asked.
  const h2 = setup(over);
  over.launchIntelCalls = 0;
  const evm = saved({ ...defaultScript('rules', 'bnb'), name: 'E' });
  auto.setEnabled(evm.id, true);
  auto.onSandboxMessage(evm.id, { t: 'call', id: 1, method: 'launchIntel', args: [MINT] });
  await tick();
  assert.equal(h2.calls.replies.find((r) => r.cid === 1).value, null);
  assert.equal(over.launchIntelCalls, 0);
});

test('every other read: validated, the network ones charged, the in-memory ones free, an unreadable wallet is unknown not empty', async () => {
  const over = {
    holders: { [MINT]: { mint: MINT, totalSupply: 1e9, holderCount: 500, rows: [{ address: 'ta', owner: 'ow', amount: 1e8, pct: 10, tags: ['dev'], label: null }], source: 'onchain', note: null } },
    candles: { [MINT]: { mint: MINT, interval: '1m', candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 3 }], source: 'merged' } },
    discover: { new: [{ mint: MINT2, symbol: 'NEW' }] },
    callouts: [{ id: 'c1', mint: MINT, at: 5 }],
    history: [{ at: 9, mint: MINT, side: 'buy', requested: 0.1, solDelta: -0.102, state: 'reconciled' }],
    holdings: [{ mint: MINT, symbol: 'COPY', uiAmount: 1000, amountRaw: '1000000000', decimals: 6, tokenAccount: 'ta', programId: 'tok', warning: null }],
    solUsd: 150,
    alerts: [{ id: 'a1', kind: 'price_above' }],
  };
  const h = setup(over);
  const s = saved({ ...rulesScript(), budget: { ...rulesScript().budget, maxActionsPerMinute: 100 } });
  auto.setEnabled(s.id, true);
  const by = (cid) => h.calls.replies.find((r) => r.cid === cid);
  auto.onSandboxMessage(s.id, { t: 'call', id: 1, method: 'holders', args: [MINT, 500] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 2, method: 'candles', args: [MINT, '3m', 50] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 3, method: 'candles', args: [MINT] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 4, method: 'discover', args: ['hot'] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 5, method: 'discover', args: ['new', 1000] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 6, method: 'callouts', args: [] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 7, method: 'history', args: [] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 8, method: 'holdings', args: [] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 9, method: 'solUsd', args: [] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 10, method: 'walletScores', args: [{ window: 'year' }] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 11, method: 'walletScores', args: [{ limit: 7, onlyWorthALook: true }] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 12, method: 'walletRecord', args: [''] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 13, method: 'search', args: ['   '] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 14, method: 'alerts', args: [] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 15, method: 'copyConfigs', args: [] });
  auto.onSandboxMessage(s.id, { t: 'call', id: 16, method: 'trades', args: [MINT, 0] });
  await tick();
  assert.equal(by(1).value.rows[0].pct, 10);
  assert.equal(h.calls.reads.find((r) => r.method === 'holders').limit, 100, 'holders limit is held to 100');
  assert.equal(by(2).ok, false);
  assert.match(by(2).error, /interval must be one of/);
  assert.equal(by(3).value.candles.length, 1);
  assert.equal(h.calls.reads.find((r) => r.method === 'candles').interval, '1m', '1m by default');
  assert.equal(h.calls.reads.find((r) => r.method === 'candles').limit, 120, '120 bars by default');
  assert.equal(by(4).ok, false);
  assert.match(by(4).error, /list must be one of/);
  assert.equal(by(5).value[0].symbol, 'NEW');
  assert.equal(h.calls.reads.find((r) => r.method === 'discover').limit, 80, 'discover limit is held to 80');
  assert.equal(by(6).value[0].id, 'c1');
  assert.equal(by(7).value[0].solDelta, -0.102);
  assert.equal(by(8).value[0].uiAmount, 1000);
  assert.equal(by(9).value, 150);
  assert.equal(by(10).ok, false);
  assert.match(by(10).error, /window must be one of/);
  assert.equal(by(11).value.limit, 7);
  assert.equal(by(11).value.window, 'week', 'week by default');
  assert.equal(by(11).value.filtered, true);
  assert.equal(by(12).ok, false);
  assert.match(by(12).error, /wallet address/);
  assert.equal(by(13).ok, false);
  assert.match(by(13).error, /pass some text/);
  assert.equal(by(14).value[0].kind, 'price_above');
  assert.equal(by(15).value.liveBlockedReason, 'not armed');
  assert.equal(h.calls.reads.find((r) => r.method === 'trades').limit, 1, 'a zero limit is held to 1');
  // The network reads were charged; history, solUsd, walletScores, walletRecord, copyConfigs and alerts were not.
  const charged = auto.snapshot().scripts.find((x) => x.id === s.id);
  assert.ok(charged, 'snapshot has the script');
  const h2 = setup({ ...over, holdings: null });
  const s2 = saved({ ...rulesScript(), budget: { ...rulesScript().budget, maxActionsPerMinute: 6 } });
  auto.setEnabled(s2.id, true);
  auto.onSandboxMessage(s2.id, { t: 'call', id: 1, method: 'holdings', args: [] });
  // Six free reads never touch the budget…
  for (let i = 2; i <= 7; i++) auto.onSandboxMessage(s2.id, { t: 'call', id: i, method: 'history', args: [] });
  // …six charged ones do: holdings above plus five here fill it, the seventh is refused.
  for (let i = 8; i <= 13; i++) auto.onSandboxMessage(s2.id, { t: 'call', id: i, method: 'holders', args: [MINT] });
  await tick();
  const r2 = (cid) => h2.calls.replies.find((r) => r.cid === cid);
  assert.equal(r2(1).ok, false, 'an unreadable wallet rejects');
  assert.match(r2(1).error, /unknown, not empty/);
  for (let i = 2; i <= 7; i++) assert.equal(r2(i).ok, true, `history #${i} is free`);
  for (let i = 8; i <= 12; i++) assert.equal(r2(i).ok, true, `holders #${i} fits the budget`);
  assert.equal(r2(13).ok, false);
  assert.match(r2(13).error, /actions in a minute/);
  // Off Solana the Solana-only reads answer null / [] without asking the host.
  const h3 = setup(over);
  const evm = saved({ ...defaultScript('rules', 'robinhood'), name: 'E' });
  auto.setEnabled(evm.id, true);
  auto.onSandboxMessage(evm.id, { t: 'call', id: 1, method: 'holders', args: [MINT] });
  auto.onSandboxMessage(evm.id, { t: 'call', id: 2, method: 'callouts', args: [] });
  auto.onSandboxMessage(evm.id, { t: 'call', id: 3, method: 'alerts', args: [] });
  auto.onSandboxMessage(evm.id, { t: 'call', id: 4, method: 'discover', args: ['new'] });
  await tick();
  const r3 = (cid) => h3.calls.replies.find((r) => r.cid === cid);
  assert.equal(r3(1).value, null);
  assert.equal(r3(2).value, null);
  assert.deepEqual(r3(3).value, []);
  assert.equal(h3.calls.reads.some((r) => r.method === 'holders' || r.method === 'callouts'), false, 'the host was not asked');
  assert.equal(h3.calls.reads.find((r) => r.method === 'discover').chain, 'robinhood', 'discover follows the script’s chain');
});

test('bot.order refuses a market-cap stop instead of arming a percent one, and passes an expiry through', async () => {
  const h = setup();
  const live = saved(codeScript({ name: 'l', mode: 'live', budget: { maxSolPerTrade: 0.1, maxBuysPerDay: 5, maxLossSolPerDay: 1, maxOpenPositions: 5, maxActionsPerMinute: 60 } }));
  auto.setEnabled(live.id, true);
  // Hold the coin so a stop is allowed at all.
  auto.onSandboxMessage(live.id, { t: 'call', id: 1, method: 'buy', args: [MINT2, 0.05] });
  await tick();
  const by = (cid) => h.calls.replies.find((r) => r.cid === cid);
  assert.equal(by(1).value.ok, true, by(1).value.message);
  // Until 2026-09-27 this armed "sell when 20,000 % down" and said ok.
  auto.onSandboxMessage(live.id, { t: 'call', id: 2, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'mcap_usd', triggerValue: 20_000, amount: 100 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 3, method: 'order', args: [{ mint: MINT2, kind: 'take_profit', triggerBasis: 'price_sol', triggerValue: 0.01, amount: 50 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 4, method: 'order', args: [{ mint: MINT2, kind: 'trailing_stop', triggerBasis: 'mcap_usd', triggerValue: 1, amount: 100 }] });
  await tick();
  for (const id of [2, 3, 4]) {
    assert.equal(by(id).ok, false, `#${id} refused`);
    assert.match(by(id).error, /must be 'pct'/);
  }
  assert.equal(h.calls.orders.length, 0, 'nothing was armed');
  // An expiry rides through to the order; a bad one is refused, not NaN.
  const soon = Date.now() + 3_600_000;
  auto.onSandboxMessage(live.id, { t: 'call', id: 5, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100, expiresAt: soon }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 6, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100, expiresAt: 'tomorrow' }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 7, method: 'order', args: [{ mint: MINT2, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100, expiresAt: Date.now() - 1 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 8, method: 'order', args: [{ mint: MINT2, kind: 'sell_on_migration', triggerBasis: 'pct', triggerValue: null, amount: 100, expiresAt: soon }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 9, method: 'order', args: [{ mint: MINT2, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 100, amount: 50 }] });
  await tick();
  assert.equal(by(5).value.ok, true, by(5).value.message);
  assert.equal(h.calls.orders.find((o) => o.kind === 'stop_loss').expiresAt, soon, 'the rule path carries the expiry');
  assert.equal(by(6).ok, false);
  assert.match(by(6).error, /epoch milliseconds/);
  assert.equal(by(7).ok, false);
  assert.match(by(7).error, /in the past/);
  assert.equal(by(8).value.ok, true, by(8).value.message);
  assert.equal(h.calls.orders.find((o) => o.kind === 'sell_on_migration').expiresAt, soon, 'the direct path carries the expiry');
  assert.equal(h.calls.orders.find((o) => o.kind === 'take_profit').expiresAt, null, 'no expiry is null, never undefined or NaN');
});

test('the 2026-09-27 reads are sandbox methods, documented, and say what they cost', () => {
  // holdings answers on every chain (the EVM bridge's holdings); history is
  // Solana's ledger and says so (empty off Solana) — audit 2026-09-27.
  const solanaOnly = ['launchIntel', 'holders', 'trades', 'candles', 'search', 'callouts', 'history', 'alerts'];
  const anyChain = ['discover', 'holdings', 'solUsd', 'walletScores', 'walletRecord', 'copyConfigs'];
  for (const m of [...solanaOnly, ...anyChain]) {
    assert.ok(SCRIPT_METHODS.includes(m), `${m} is callable`);
    const a = SCRIPT_API.find((x) => x.method === m);
    assert.ok(a, `${m} is documented`);
    assert.equal(a.action, false, `${m} is a read`);
  }
  for (const m of solanaOnly) assert.ok(/Solana only/.test(SCRIPT_API.find((x) => x.method === m).notes), `${m} says it is Solana only`);
  for (const m of ['launchIntel', 'holders', 'trades', 'candles', 'search', 'discover', 'callouts', 'holdings']) {
    const a = SCRIPT_API.find((x) => x.method === m);
    assert.ok(/costs an action/i.test(a.notes), `${m} says it costs an action`);
    assert.equal(a.charged, true, `${m} is flagged charged, so the reference lists it under the charged reads`);
  }
  // Every row that says "costs an action" carries the flag, and the reference has the third group.
  for (const a of SCRIPT_API) if (!a.action && /costs an action/i.test(a.notes)) assert.equal(a.charged, true, `${a.method} is flagged charged`);
  assert.ok(SCRIPT_API_DOC.includes('// Reads that leave the machine'), 'the reference separates charged reads from free ones');
  assert.ok(/REJECTS \(throws\)/.test(SCRIPT_API.find((x) => x.method === 'holdings').notes), 'holdings says it rejects on an unreadable wallet — what the dispatcher does');
  for (const m of ['history', 'solUsd', 'walletScores', 'walletRecord', 'copyConfigs', 'alerts']) assert.ok(/Free/.test(SCRIPT_API.find((x) => x.method === m).notes), `${m} says it is free`);
  assert.ok(/never inferred/.test(SCRIPT_API.find((x) => x.method === 'security').notes), 'security says the held shares are measured, not inferred');
  assert.ok(/complete=false/.test(SCRIPT_API.find((x) => x.method === 'launchIntel').notes), 'launchIntel says what incomplete means');
  // The harness exposes each one.
  const body = sandboxPageHtml();
  for (const m of [...solanaOnly, ...anyChain]) assert.ok(new RegExp(`\\n\\s+${m}\\s*[:(]`).test(body), `${m} is on the bot object`);
  // And the prompt pack — generated from the same tables — names the new facts.
  const pack = aiPromptPack();
  assert.ok(pack.includes('launchBundleHeldPct'), 'the AI pack knows the launch fields');
  assert.ok(pack.includes('bot.launchIntel('), 'the AI pack knows the call');
});

// ── Per-trade options, token-amount sells, housekeeping, settings, events (2026-09-27, second pass) ──

const liveBudget = { maxSolPerTrade: 1, maxBuysPerDay: 100, maxLossSolPerDay: 10, maxOpenPositions: 50, maxActionsPerMinute: 100 };

test('bot.buy / bot.sell take an options object: slippage rides to the host bounded, tokens become the share they really are, bad values are refused not defaulted', async () => {
  const h = setup();
  const live = saved(codeScript({ mode: 'live', budget: liveBudget }));
  auto.setEnabled(live.id, true);
  const by = (cid) => h.calls.replies.find((r) => r.cid === cid);
  auto.onSandboxMessage(live.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.05, { slippagePct: 5 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 2, method: 'buy', args: [MINT2, 0.05] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 3, method: 'buy', args: [MINT3, 0.05, { slippagePct: 99 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 4, method: 'buy', args: [MINT3, 0.05, 42] });
  await tick();
  assert.equal(by(1).value.ok, true, by(1).value.message);
  assert.deepEqual(h.calls.buys[0].opts, { slippagePct: 5 }, 'the buy carried its own slippage');
  assert.equal(h.calls.buys[1].opts, undefined, 'no option → the execution setting (undefined at the host)');
  assert.equal(by(3).ok, false);
  assert.match(by(3).error, /slippagePct must be 0\.1–50/);
  assert.equal(by(4).ok, false, 'a number is neither an address nor options');
  assert.match(by(4).error, /wallet address or an options object/);
  assert.equal(h.calls.buys.length, 2, 'the refused buys never reached the host');
  // Sells. The stub position holds 1000 tokens and cost what the buy paid.
  // The 100 % sell goes LAST: it closes the position, as it should.
  auto.onSandboxMessage(live.id, { t: 'call', id: 5, method: 'sell', args: [MINT, { tokens: 250 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 7, method: 'sell', args: [MINT, { tokens: 250, pct: 10 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 8, method: 'sell', args: [MINT, { tokens: -1 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 9, method: 'sell', args: [MINT, 50, { slippagePct: 3 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 10, method: 'sell', args: [MINT, { pct: 20, slippagePct: 7 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 11, method: 'sell', args: [MINT, { tokens: 1 }, 'Wallet222222222222222222222222222222222222'] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 6, method: 'sell', args: [MINT, { tokens: 5000 }] });
  await tick();
  assert.equal(by(5).value.ok, true, by(5).value.message);
  assert.equal(h.calls.sells[0].pct, 25, '250 of 1000 tokens is 25 %');
  assert.equal(h.calls.sells[0].opts, undefined);
  assert.equal(by(7).ok, false);
  assert.match(by(7).error, /pct or tokens, not both/);
  assert.equal(by(8).ok, false);
  assert.match(by(8).error, /tokens must be a positive number/);
  assert.equal(by(9).value.ok, true, by(9).value.message);
  assert.equal(h.calls.sells[1].pct, 50);
  assert.deepEqual(h.calls.sells[1].opts, { slippagePct: 3 }, 'a percent sell carries its slippage');
  assert.equal(by(10).value.ok, true, by(10).value.message);
  assert.equal(h.calls.sells[2].pct, 20, 'pct inside the options object');
  assert.deepEqual(h.calls.sells[2].opts, { slippagePct: 7 });
  assert.equal(by(11).ok, false, 'another wallet sells a percent, not a count');
  assert.match(by(11).error, /percent, not a token count/);
  assert.equal(by(6).value.ok, true, by(6).value.message);
  assert.equal(h.calls.sells[3].pct, 100, 'more tokens than held sells everything, never more');
  // A QUANTITY is capped by the script's share of the bag, never scaled by it
  // (audit 2026-09-27): the wallet paid twice what this script did for MINT2,
  // so 800 of 1000 tokens is 80 % asked and 50 % allowed — not 40 %.
  h.book.live.find((p) => p.mint === MINT2).costSol = 0.1;
  auto.onSandboxMessage(live.id, { t: 'call', id: 20, method: 'sell', args: [MINT2, { tokens: 800 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 21, method: 'sell', args: [MINT2, { tokens: 250 }] });
  // Refused, never silently dropped: a slippage on another wallet, a wallet
  // named twice, a token count that is not a number.
  const W2 = 'Wallet222222222222222222222222222222222222';
  auto.onSandboxMessage(live.id, { t: 'call', id: 22, method: 'buy', args: [MINT3, 0.05, { wallet: W2, slippagePct: 2 }] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 23, method: 'sell', args: [MINT2, { pct: 10, wallet: W2 }, W2] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 24, method: 'sell', args: [MINT2, { pct: 10, slippagePct: 2 }, W2] });
  auto.onSandboxMessage(live.id, { t: 'call', id: 25, method: 'sell', args: [MINT2, { tokens: true }] });
  await tick();
  assert.equal(by(20).value.ok, true, by(20).value.message);
  assert.equal(h.calls.sells[4].pct, 50, 'capped at the script’s share, not scaled by it');
  assert.equal(by(21).value.ok, true, by(21).value.message);
  assert.equal(h.calls.sells[5].pct, 25, 'under the share it is exactly what was asked');
  for (const id of [22, 24]) {
    assert.equal(by(id).ok, false, `#${id} refused`);
    assert.match(by(id).error, /trading wallet only/);
  }
  assert.equal(by(23).ok, false);
  assert.match(by(23).error, /name the wallet once/);
  assert.equal(by(25).ok, false);
  assert.match(by(25).error, /positive number/);
  assert.equal(h.calls.sells.length, 6, 'the refused sells never reached the host');
  // A token sell needs a visible position: a live buy seconds old has none yet.
  const h2 = setup({ realized: 0 });
  const fresh = saved(codeScript({ mode: 'live', budget: liveBudget }));
  auto.setEnabled(fresh.id, true);
  auto.onSandboxMessage(fresh.id, { t: 'call', id: 1, method: 'buy', args: [MINT, 0.05] });
  await tick();
  h2.book.live.length = 0; // the holdings read has not caught up
  auto.onSandboxMessage(fresh.id, { t: 'call', id: 2, method: 'sell', args: [MINT, { tokens: 10 }] });
  auto.onSandboxMessage(fresh.id, { t: 'call', id: 3, method: 'sell', args: [MINT, 50] });
  await tick();
  const r2 = (cid) => h2.calls.replies.find((r) => r.cid === cid);
  assert.equal(r2(2).value.ok, false);
  assert.match(r2(2).value.message, /size is not known yet/);
  assert.equal(r2(3).value.ok, true, 'a percent sell of a fresh buy still goes (the rail reads the balance)');
});

test('housekeeping: one order, the paused orders, one alert, the fired alerts, the templates — page buttons a script may press', async () => {
  const h = setup();
  // LIVE first: orders and templates are live-only, so this is where the
  // calls go through. Paper is below.
  const s0 = saved(codeScript({ mode: 'live', budget: liveBudget }));
  auto.setEnabled(s0.id, true);
  const by = (cid) => h.calls.replies.find((r) => r.cid === cid);
  auto.onSandboxMessage(s0.id, { t: 'call', id: 1, method: 'cancelOrder', args: ['o_1'] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 2, method: 'cancelOrder', args: [''] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 3, method: 'resumeOrders', args: [] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 4, method: 'removeAlert', args: ['a_1'] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 5, method: 'muteAlert', args: ['a_2', false] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 6, method: 'muteAlert', args: ['a_3'] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 7, method: 'clearFiredAlerts', args: [] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 8, method: 'saveTemplate', args: [{ name: 'Moonbag', stopLossPct: 30, takeProfits: [{ gainPct: 100, sellPct: 50 }, { gainPct: 300, sellPct: 50 }], trailingPct: null, sellOnDevSell: true }] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 9, method: 'saveTemplate', args: [{ name: 'Too many', takeProfits: [{}, {}, {}, {}] }] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 10, method: 'saveTemplate', args: [{ stopLossPct: 30 }] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 11, method: 'deleteTemplate', args: [''] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 12, method: 'deleteTemplate', args: ['t_x'] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 13, method: 'setActiveTemplate', args: [null] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 14, method: 'setActiveTemplate', args: ['builtin-runner'] });
  auto.onSandboxMessage(s0.id, { t: 'call', id: 15, method: 'settings', args: [] });
  await tick();
  assert.equal(by(1).value.ok, true);
  assert.deepEqual(h.calls.housekeeping[0], { method: 'cancelOrder', id: 'o_1' });
  assert.equal(by(2).ok, false);
  assert.match(by(2).error, /pass an id/);
  assert.equal(by(3).value.ok, true, 'live and unblocked: resume goes through');
  assert.deepEqual(h.calls.housekeeping.find((x) => x.method === 'resumeOrders'), { method: 'resumeOrders' });
  assert.equal(by(4).value.ok, true);
  assert.deepEqual(h.calls.housekeeping.find((x) => x.method === 'muteAlert' && x.id === 'a_2'), { method: 'muteAlert', id: 'a_2', muted: false });
  assert.deepEqual(h.calls.housekeeping.find((x) => x.method === 'muteAlert' && x.id === 'a_3'), { method: 'muteAlert', id: 'a_3', muted: true }, 'muted by default');
  assert.equal(by(7).value.ok, true);
  assert.equal(by(8).value.ok, true, by(8).value.message);
  const saved8 = h.calls.housekeeping.find((x) => x.method === 'saveTemplate' && x.t.name === 'Moonbag').t;
  assert.match(saved8.id, /^t_/, 'a new template gets an id');
  assert.equal(saved8.takeProfits.length, 2);
  assert.equal(saved8.sellOnDevSell, true);
  assert.equal(saved8.trailingPct, null);
  assert.ok(Array.isArray(by(8).value.templates), 'the list comes back');
  assert.equal(by(9).ok, false);
  assert.match(by(9).error, /at most 3/);
  assert.equal(by(10).value.ok, false, 'the store’s validation reaches the script');
  assert.match(by(10).value.message, /name/);
  assert.equal(by(11).ok, false);
  assert.equal(by(12).value.ok, true);
  assert.equal(by(13).value.ok, true);
  assert.deepEqual(h.calls.housekeeping.find((x) => x.method === 'setActiveTemplate' && x.id === null), { method: 'setActiveTemplate', id: null });
  assert.equal(by(14).value.ok, true);
  assert.equal(by(15).value.execution.liveSlippagePct, 15);
  // PAPER: orders and templates are refused with the reason and the host is
  // never asked — a rehearsal must not pull a real stop or change what the
  // user's manual buys arm (audit 2026-09-27). Alerts are neither paper nor
  // live and still work.
  const hp = setup();
  const paper = saved(codeScript({ budget: liveBudget }));
  auto.setEnabled(paper.id, true);
  const gated = [['cancelOrder', ['o_1']], ['resumeOrders', []], ['saveTemplate', [{ name: 'X', stopLossPct: 30, takeProfits: [], trailingPct: null }]], ['deleteTemplate', ['t_x']], ['setActiveTemplate', [null]]];
  for (const [i, [m, a]] of gated.entries()) auto.onSandboxMessage(paper.id, { t: 'call', id: i + 1, method: m, args: a });
  auto.onSandboxMessage(paper.id, { t: 'call', id: 20, method: 'removeAlert', args: ['a_1'] });
  auto.onSandboxMessage(paper.id, { t: 'call', id: 21, method: 'clearFiredAlerts', args: [] });
  await tick();
  const rp = (cid) => hp.calls.replies.find((r) => r.cid === cid);
  for (let i = 1; i <= gated.length; i++) {
    assert.equal(rp(i).ok, true, `paper ${gated[i - 1][0]} answers, not throws`);
    assert.equal(rp(i).value.ok, false, `paper ${gated[i - 1][0]} is refused`);
    assert.match(rp(i).value.message, /paper/);
  }
  assert.equal(hp.calls.housekeeping.filter((x) => x.method !== 'removeAlert' && x.method !== 'clearFiredAlerts').length, 0, 'the host was never asked to touch an order or a template');
  assert.equal(rp(20).value.ok, true, 'alerts are neither paper nor live');
  assert.equal(rp(21).value.ok, true);
  // Live: resume goes through when live is possible, and is refused with the reason when not.
  const h2 = setup({ liveBlocked: 'not armed' });
  const live = saved(codeScript({ mode: 'live', budget: liveBudget }));
  auto.setEnabled(live.id, true);
  auto.onSandboxMessage(live.id, { t: 'call', id: 1, method: 'resumeOrders', args: [] });
  await tick();
  assert.equal(h2.calls.replies[0].value.ok, false);
  assert.match(h2.calls.replies[0].value.message, /not armed/);
  const h3 = setup();
  const live3 = saved(codeScript({ mode: 'live', budget: liveBudget }));
  auto.setEnabled(live3.id, true);
  auto.onSandboxMessage(live3.id, { t: 'call', id: 1, method: 'resumeOrders', args: [] });
  await tick();
  assert.equal(h3.calls.replies[0].value.ok, true);
  assert.deepEqual(h3.calls.housekeeping, [{ method: 'resumeOrders' }]);
  // Off Solana every one is refused by name.
  const h4 = setup();
  const evm = saved({ ...defaultScript('code', 'bnb'), name: 'E', code: "bot.on('launch', () => {})" });
  auto.setEnabled(evm.id, true);
  for (const [i, m] of ['cancelOrder', 'resumeOrders', 'removeAlert', 'muteAlert', 'clearFiredAlerts', 'saveTemplate', 'deleteTemplate', 'setActiveTemplate'].entries()) {
    auto.onSandboxMessage(evm.id, { t: 'call', id: i + 1, method: m, args: ['x'] });
  }
  await tick();
  for (const r of h4.calls.replies) {
    assert.equal(r.ok, false);
    assert.match(r.error, /Solana only/);
  }
  assert.equal(h4.calls.housekeeping.length, 0);
});

test('bot.settings is scrubbed: no key, token, URL or referrer crosses, and "a key is set" is all a script learns', () => {
  const fake = {
    settingsRevision: 3,
    rpc: { httpUrl: 'https://mainnet.helius-rpc.com/?api-key=SECRET-1', wssUrl: 'wss://x', heliusApiKey: 'SECRET-2', extraWssUrls: ['wss://y'] },
    strategy: { minScore: 70, minUniqueBuyers: 12, evalWindowSec: 15 },
    execution: { liveEnabled: true, maxLiveSol: 0.5, liveSlippagePct: 15, mevMode: 'fast', useJito: true, jitoTipPercentile: 75 },
    data: { networkDataEnabled: true, loadTokenImages: true, providers: { jupiter: true, birdeye: false }, birdeyeApiKey: 'SECRET-3', jupiterApiKey: '', giphyApiKey: 'SECRET-4', tenorApiKey: '', discoverLimit: 40 },
    alerts: { desktopNotifications: true, sound: false, repeatCooldownSec: 60 },
    ai: { provider: 'openai', apiKey: 'SECRET-5' },
    bots: { telegramToken: 'SECRET-6' },
    mcp: { token: 'SECRET-7', port: 4321 },
    evm: { slippagePct: 8, rpcUrl: 'https://evm.example/SECRET-8', referrer: '0xref' },
    referrer: 'RefWallet',
    hotkeys: { enabled: false },
  };
  const v = scriptSettingsView(fake);
  const text = JSON.stringify(v);
  for (const s of ['SECRET', 'https://', 'wss://', 'helius', 'RefWallet', '0xref', 'apiKey', 'telegramToken', '"token"', 'port']) assert.ok(!text.includes(s), `${s} never crosses`);
  assert.equal(v.data.loadTokenImages, true, 'a name the pattern catches but that is plainly no secret is let through (audit 2026-09-27)');
  assert.equal(v.mode, 'live');
  assert.equal(v.execution.liveSlippagePct, 15);
  assert.equal(v.execution.mevMode, 'fast');
  assert.equal(v.strategy.minScore, 70);
  assert.equal(v.data.providers.jupiter, true);
  assert.equal(v.data.hasBirdeyeKey, true, 'THAT a key is set is fine');
  assert.equal(v.data.hasJupiterKey, false);
  assert.equal(v.data.birdeyeApiKey, undefined);
  assert.equal(v.evm.slippagePct, 8);
  assert.equal(v.alerts.repeatCooldownSec, 60);
  assert.equal(v.rpc, undefined, 'the RPC block is not offered at all');
  assert.equal(v.ai, undefined);
  // The scrub itself: nested, arrays, functions.
  const s = scrubForScript({ a: 1, secretKey: 2, nested: { url: 'x', fine: 'y', list: ['https://z', 'ok'] }, fn: () => 1 });
  assert.deepEqual(s, { a: 1, nested: { fine: 'y', list: ['ok'] } });
});

test('new events: migration to every Solana script, devSell to holders and subscribers, holdings pushed, copyFill diffed by state, runnerExpired from the list', async () => {
  const h = setup();
  const c = saved(codeScript({ budget: liveBudget }));
  auto.setEnabled(c.id, true);
  await tick();
  auto.onSandboxMessage(c.id, { t: 'ready' });
  const named = (n) => h.calls.dispatched.filter((d) => d.name === n);
  // Migration: heard whether or not the coin is held.
  auto.onMigration(MINT);
  await tick(30);
  assert.equal(named('migration').length, 1);
  assert.equal(named('migration')[0].payload.mint, MINT);
  assert.equal(named('migration')[0].payload.migrated, true);
  // Dev sell: not held, not subscribed → silence. Subscribed → heard, with what was sold.
  auto.onDevSell(MINT2, { sol: 1.5, tokens: 20_000_000, priceSol: 0.00000008 });
  await tick(30);
  assert.equal(named('devSell').length, 0, 'a dev sell on a coin the script ignores is not delivered');
  auto.onSandboxMessage(c.id, { t: 'call', id: 1, method: 'subscribe', args: [MINT2] });
  await tick();
  auto.onDevSell(MINT2, { sol: 1.5, tokens: 20_000_000, priceSol: 0.00000008 });
  await tick(30);
  assert.equal(named('devSell').length, 1);
  assert.equal(named('devSell')[0].payload.devSoldSol, 1.5);
  assert.equal(named('devSell')[0].payload.devSoldTokens, 20_000_000);
  assert.equal(named('devSell')[0].payload.creatorSold, true);
  assert.equal(named('devSell')[0].payload.priceSol, 0.00000008);
  // Holdings: the engine's rows, in the script's shape; an unreadable mint is unknown, not fine.
  auto.onEngineEvent({ kind: 'holdings', at: 77, data: [{ mint: MINT, tokenAccount: 'ta', amountRaw: '1000000000', uiAmount: 1000, decimals: 6, symbol: 'COPY', warning: null }, { mint: MINT2, tokenAccount: 'tb', amountRaw: '5', uiAmount: 5, decimals: 0, symbol: null }] });
  await tick(30);
  assert.equal(named('holdings').length, 1);
  assert.equal(named('holdings')[0].payload.at, 77);
  assert.equal(named('holdings')[0].payload.holdings[0].warning, null);
  assert.match(named('holdings')[0].payload.holdings[1].warning, /unknown/);
  // Copy fills: a new row, a state change, never a repeat; another chain's row never reaches a Solana script.
  const row = { id: 'ct1', configId: 'cfg', mode: 'paper', wallet: 'Lead', mint: MINT, symbol: 'COPY', at: 5, theirSol: 2, ourSol: 0.05, entryPriceSol: 1e-8, exitPriceSol: null, closedAt: null, pnlSol: null, state: 'open', reason: null };
  const snap = (recent) => ({ configs: [], stats: {}, recent, liveExecutable: false, liveBlockedReason: null, watch: {}, leaders: {} });
  // The FIRST snapshot is reloaded history and only seeds the diff — it used
  // to push up to 100 stale rows into every script's 50-slot queue (audit
  // 2026-09-27). A repeat of it raises nothing either.
  auto.onEngineEvent({ kind: 'copy', snapshot: snap([row]) });
  auto.onEngineEvent({ kind: 'copy', snapshot: snap([row]) });
  await tick(30);
  assert.equal(named('copyFill').length, 0, 'the first snapshot seeds; a repeat is silent');
  auto.onEngineEvent({ kind: 'copy', snapshot: snap([{ ...row, state: 'closed', pnlSol: 0.01 }, { ...row, id: 'ct2', kind: 'exit', parentId: 'ct1', state: 'closed' }, { ...row, id: 'ct3', chain: 'bnb', state: 'skipped', reason: 'budget' }]) });
  await tick(30);
  assert.equal(named('copyFill').length, 2, 'a changed row and a new row; the BNB row is not a Solana script’s');
  const closed = named('copyFill').find((d) => d.payload.id === 'ct1');
  assert.equal(closed.payload.state, 'closed');
  assert.equal(closed.payload.pnlSol, 0.01);
  assert.equal(closed.payload.side, 'buy');
  assert.equal(closed.payload.configId, 'cfg');
  assert.equal(named('copyFill').find((d) => d.payload.id === 'ct2').payload.side, 'sell', 'a mirrored exit is a sell');
  assert.ok(!named('copyFill').some((d) => d.payload.id === 'ct3'), 'a BNB row is not a Solana script’s');
  auto.onEngineEvent({ kind: 'copy', snapshot: snap([{ ...row, state: 'closed', pnlSol: 0.01 }]) });
  await tick(30);
  assert.equal(named('copyFill').length, 2, 'the same state again is not an event');
  // Runner expiry: flagged, then gone from the list.
  const flag = { mint: MINT3, name: 'x', symbol: 'RUN', creator: 'c', flaggedAt: Date.now(), windowS: 60, bucket: 'top', observedPct: 30, basePct: 5, n: 100 };
  auto.onEngineEvent({ kind: 'runner', runner: flag });
  await tick(30);
  auto.onEngineEvent({ kind: 'runners', runners: [flag] });
  await tick(30);
  assert.equal(named('runnerExpired').length, 0, 'still listed → not expired');
  auto.onEngineEvent({ kind: 'runners', runners: [] });
  await tick(30);
  assert.equal(named('runnerExpired').length, 1);
  assert.equal(named('runnerExpired')[0].payload.mint, MINT3);
  // A rules script hears none of these (no trigger exists), and nothing throws.
  const h2 = setup();
  const r = saved(rulesScript());
  auto.setEnabled(r.id, true);
  auto.onMigration(MINT);
  auto.onEngineEvent({ kind: 'holdings', at: 1, data: [] });
  await tick(30);
  assert.equal(h2.calls.dispatched.length, 0);
  // Every event is documented, and every documented event exists.
  for (const e of SCRIPT_EVENTS) assert.ok(SCRIPT_EVENTS_DOC.some((d) => d.event === e), `${e} is documented`);
  for (const d of SCRIPT_EVENTS_DOC) assert.ok(SCRIPT_EVENTS.includes(d.event), `${d.event} exists`);
  const on = SCRIPT_API.find((a) => a.method === 'on');
  for (const e of ['migration', 'devSell', 'holdings', 'copyFill', 'runnerExpired']) assert.ok(on.notes.includes(e), `bot.on lists ${e}`);
});

await run();
