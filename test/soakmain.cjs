// Runs INSIDE Electron (see scriptsoak.live.mjs): a long soak of the REAL
// script machinery — automation.ts (registry, act(), queues, error streak,
// restarts) driving the REAL sandbox (a hidden sandboxed renderer per script)
// — with a mock engine host and a synthetic market pushed at many times the
// real event rate.
//
// Question it answers: can a heavy script run for days without degrading
// (handler latency, queue drops), dying (restarts, auto-disable) or leaking
// (main heap, sandbox renderer heap, automation's own maps)?
//
// Env:
//   SOAK_SCRIPT   path to the script source (default: a built-in heavy one)
//   SOAK_MINUTES  wall-clock minutes (default 5)
//   SOAK_OUT      directory for samples.jsonl + summary.json
//   SOAK_SPEED    timer compression for bot.every / the position poll (6)
//   SOAK_FLAGS_PER_MIN  runner flags a minute (real ≈ 2; default 40)
//   SOAK_FAULTS   '0' to run without the fault schedule
//
// Faults (as fractions of the run): a 20-minute-equivalent provider outage
// (market/creator/security reject, price null), a forced renderer crash, a
// 40 s main-process freeze (what a laptop sleep looks like to main), and a
// window where bot.positions never answers (a hung host read).

const { app, session, webContents } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Never the user's profile: a private userData for this run.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-soak-'));
app.setPath('userData', scratch);
// Unbucketed performance.memory in the sandbox, or the heap reads as a flat step.
app.commandLine.appendSwitch('enable-precise-memory-info');
// gc() in main and in the sandbox, called before every sample, so the curve
// is live memory and not wherever the collector happened to be.
app.commandLine.appendSwitch('js-flags', '--expose-gc');

const MINUTES = Number(process.env.SOAK_MINUTES || 5);
const SPEED = Number(process.env.SOAK_SPEED || 6);
const FLAGS_PER_MIN = Number(process.env.SOAK_FLAGS_PER_MIN || 40);
// The scripts' own per-minute action budget. The user's is 30; at many times
// the real flag rate that refuses most lookups, so the soak raises it to let
// the buy / callout / Discord paths run too.
const ACTIONS_PER_MIN = Number(process.env.SOAK_ACTIONS_PER_MIN || 120); // the budget's own ceiling
const FAULTS = process.env.SOAK_FAULTS !== '0';
const OUT = process.env.SOAK_OUT || path.join(scratch, 'out');
fs.mkdirSync(OUT, { recursive: true });

// Compress the long timers (bot.every, the 5 s position poll) so hours of
// passes fit into the run. Only main-process intervals of 5 s or more.
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...rest) => realSetInterval(fn, ms >= 5000 ? Math.max(250, Math.round(ms / SPEED)) : ms, ...rest);

// Count automation.json writes (every persist() rewrites the whole file).
let persistWrites = 0;
let persistBytes = 0;
const realWrite = fs.writeFileSync;
fs.writeFileSync = function (p, data, ...rest) {
  if (typeof p === 'string' && p.endsWith('automation.json.tmp')) {
    persistWrites += 1;
    persistBytes += typeof data === 'string' ? data.length : (data?.length ?? 0);
  }
  return realWrite.call(this, p, data, ...rest);
};

// Sandboxes are the only windows here; one crashing must not end the run
// (the real app has its main window, and its own window-all-closed rule).
app.on('window-all-closed', () => undefined);

const sb = require('./.sandbox/scriptsandbox.cjs');
const auto = require('./.sandbox/automation.cjs');

const out = (...a) => process.stdout.write(`${a.join(' ')}\n`);
const uncaught = [];
process.on('uncaughtException', (e) => {
  uncaught.push(String((e && e.stack) || e));
  out('UNCAUGHT:', String((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  uncaught.push(`rejection: ${String((e && e.stack) || e)}`);
  out('UNHANDLED REJECTION:', String((e && e.stack) || e));
});

// ── A synthetic market ────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let mintSeq = 0;
const newMint = () => {
  mintSeq += 1;
  let s = '';
  for (let i = 0; i < 40; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return s + 'pump';
};
const SOL_USD = 200;
const SUPPLY = 1e9;
/** mint → coin. Bounded like the engine's own launch list. */
const coins = new Map();
const COIN_CAP = 3000;
function launchCoin() {
  const mint = newMint();
  const sym = `S${mintSeq.toString(36).toUpperCase()}`;
  const classic = Math.random() < 0.3;
  const px = 2.8e-8 * (0.8 + Math.random() * 0.8);
  const c = {
    mint,
    symbol: sym,
    name: `Soak ${sym}`,
    creator: newMint().slice(0, 44),
    detectedAt: Date.now(),
    priceSol: px,
    // Most coins drift down; one in eight runs.
    drift: Math.random() < 0.125 ? 0.02 + Math.random() * 0.03 : -0.004 - Math.random() * 0.01,
    buyers: 1,
    regime: classic ? 'classic' : 'mixed',
    twitter: Math.random() < 0.5 ? `https://x.com/${sym.toLowerCase()}` : null,
    website: Math.random() < 0.4 ? `https://${sym.toLowerCase()}.xyz` : null,
    devLaunches: Math.random() < 0.6 ? 1 + Math.floor(Math.random() * 3) : 5 + Math.floor(Math.random() * 400),
    creatorSold: Math.random() < 0.3,
    history: [px],
  };
  coins.set(mint, c);
  if (coins.size > COIN_CAP) {
    // Oldest unflagged, unheld coin first: a flagged coin is what the
    // scripts watch for up to an hour, and deleting it (10 min of launches
    // at this rate) left every watch without a price.
    for (const [m, x] of coins) {
      if (x.flagged || book.has(m)) continue;
      coins.delete(m);
      break;
    }
  }
  return c;
}
function stepPrices() {
  for (const c of coins.values()) {
    if (Date.now() - c.detectedAt > 90 * 60_000 && !book.has(c.mint)) continue;
    const shock = (Math.random() - 0.5) * 0.08;
    c.priceSol = Math.max(1e-10, c.priceSol * (1 + c.drift / 6 + shock));
    c.buyers += Math.random() < 0.3 ? 1 : 0;
    c.history.push(c.priceSol);
    if (c.history.length > 120) c.history.splice(0, c.history.length - 120);
  }
}
const mcOf = (c) => c.priceSol * SUPPLY * SOL_USD;
function row(c) {
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    uri: '',
    creator: c.creator,
    bondingCurve: 'bc',
    signature: 'sig',
    slot: 1,
    detectedAt: c.detectedAt,
    phase: 'evaluating',
    riskFlags: [],
    flow: {
      uniqueBuyers: c.buyers,
      buys: c.buyers + 3,
      sells: 2,
      buyVolumeSol: 3,
      sellVolumeSol: 1,
      netInflowSol: 2,
      buyerAcceleration: 1.1,
      topBuyerShare: 0.1,
      creatorSold: c.creatorSold,
      curveProgressPct: Math.min(99, Math.round((mcOf(c) / 69000) * 100)),
      distinctSellers: 2,
      topHolderTokenShare: 0.08,
      earlyBuyerShare: 0.3,
    },
    score: { safety: 18, creator: 15, sellPressure: 15, entryTiming: 10, crowd: 6, concentration: 10, metadata: 8, penalties: 0, total: 68 },
    priceSol: c.priceSol,
    priceHistory: c.history.slice(-60),
    reason: null,
    creatorPriorLaunches: c.devLaunches,
    creatorPriorRugs: 0,
    smartBuyerCount: 0,
    smartEarly: false,
  };
}
function flagOf(c) {
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    creator: c.creator,
    flaggedAt: Date.now(),
    windowS: Math.random() < 0.7 ? 60 : 120,
    bucket: 'top5_10',
    observedPct: [9, 11, 15, 17.4][Math.floor(Math.random() * 4)],
    basePct: 2,
    n: 800,
    line: 'soak flag',
    mult3Line: null,
    priceSol: c.priceSol,
    curvePct: Math.min(99, Math.round((mcOf(c) / 69000) * 100)),
    uniqueBuyers: c.buyers + 5 + Math.floor(Math.random() * 40),
    netInflowSol: 1.2,
    tradesSeen: 40,
    creatorSoldAt: null,
    regime: c.regime,
    mayhem: c.regime === 'mixed' && Math.random() < 0.5,
  };
}
const flags = [];

// ── The mock engine host ──────────────────────────────────────────────
const book = new Map(); // mint → position (live)
const orders = []; // advanced orders
let orderSeq = 0;
const PUMP_ACCOUNTS = [newMint().slice(0, 44), newMint().slice(0, 44), newMint().slice(0, 44)];
const WALLETS = [{ address: PUMP_ACCOUNTS[0], label: 'Main', active: true }];

/** Fault switches. */
const fault = { outage: false, positionsHang: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.random() * (hi - lo);

const hostCalls = {};
const countCall = (name) => {
  hostCalls[name] = (hostCalls[name] ?? 0) + 1;
};

function position(c, p) {
  const cur = c ? c.priceSol : p.entryPriceSol;
  const value = p.tokens * cur;
  return {
    mint: p.mint,
    symbol: c?.symbol ?? '',
    name: c?.name ?? '',
    openedAt: p.openedAt,
    costSol: p.costSol,
    tokens: p.tokens,
    entryPriceSol: p.entryPriceSol,
    currentPriceSol: cur,
    peakPriceSol: null,
    pnlSol: value - p.costSol,
    pnlPct: ((value - p.costSol) / p.costSol) * 100,
  };
}
function ordersSnapshot() {
  auto.onEngineEvent({ kind: 'orders', snapshot: { orders: orders.map((o) => ({ ...o })) } });
}
function marketFacts(c) {
  return {
    priceSol: c.priceSol,
    priceUsd: c.priceSol * SOL_USD,
    marketCapUsd: mcOf(c),
    liquidityUsd: mcOf(c) * 0.2,
    holders: c.buyers,
    launchpad: 'pump.fun',
    symbol: c.symbol,
    name: c.name,
    imageUrl: null,
    kryptScore: 68,
    bondingCurvePct: Math.min(99, Math.round((mcOf(c) / 69000) * 100)),
    devHoldingPct: 3,
    top10Pct: 20,
    socials: { twitter: c.twitter, website: c.website, telegram: null, dexPaid: false },
  };
}

const host = {
  buy: async (mint, sol) => {
    countCall('buy');
    await sleep(jitter(300, 1500));
    const c = coins.get(mint);
    if (!c) return { ok: false, message: 'no such coin' };
    const prev = book.get(mint);
    const tokens = sol / c.priceSol;
    book.set(mint, prev ? { ...prev, tokens: prev.tokens + tokens, costSol: prev.costSol + sol } : { mint, tokens, costSol: sol, entryPriceSol: c.priceSol, openedAt: Date.now() });
    setTimeout(() => auto.onEngineEvent({ kind: 'fill', mint, side: 'buy', state: 'confirmed' }), 200);
    return { ok: true, message: 'bought', signature: `sig${Date.now()}${Math.random()}` };
  },
  sell: async (mint, pct) => {
    countCall('sell');
    await sleep(jitter(300, 1200));
    const p = book.get(mint);
    if (!p) return { ok: false, message: 'nothing held' };
    const c = coins.get(mint);
    const sold = p.tokens * (pct / 100);
    const realized = sold * (c?.priceSol ?? p.entryPriceSol) - p.costSol * (pct / 100);
    if (pct >= 100) book.delete(mint);
    else book.set(mint, { ...p, tokens: p.tokens - sold, costSol: p.costSol * (1 - pct / 100) });
    setTimeout(() => auto.onEngineEvent({ kind: 'fill', mint, side: 'sell', state: 'confirmed' }), 200);
    return { ok: true, message: 'sold', realizedSol: realized };
  },
  liveBlockedReason: () => null,
  buyBlockedReason: () => null,
  maxLiveSol: () => 1,
  priceSol: (mint) => {
    countCall('price');
    if (fault.outage) return null;
    return coins.get(mint)?.priceSol ?? null;
  },
  launch: (mint) => {
    const c = coins.get(mint);
    return c ? row(c) : null;
  },
  launchLinks: (mint) => {
    const c = coins.get(mint);
    return c ? { twitter: !!c.twitter, website: !!c.website, telegram: false } : null;
  },
  marketCached: (mint) => {
    const c = coins.get(mint);
    return c && !fault.outage && (c.flagged || Math.random() < 0.5) ? marketFacts(c) : null;
  },
  market: async (mint) => {
    countCall('market');
    await sleep(jitter(80, 1500));
    if (fault.outage) throw new Error('provider parked (soak outage)');
    const c = coins.get(mint);
    return c ? marketFacts(c) : null;
  },
  links: (mint) => {
    const c = coins.get(mint);
    if (!c) return null;
    return { twitter: c.twitter, website: c.website, telegram: null, launchpadLabel: 'pump.fun', launchpadUrl: null, x: { kind: c.twitter ? 'account' : 'none', handle: c.twitter ? c.symbol.toLowerCase() : null, postId: null, label: '', accountReuse: 0, postReuse: 0, stats: null, statsReadAt: null }, telegramStats: null };
  },
  security: async () => {
    countCall('security');
    await sleep(jitter(200, 2500));
    if (fault.outage) throw new Error('provider parked (soak outage)');
    return { score: 70, checksResolved: 5, checksTotal: 6, checks: [], warnings: [] };
  },
  creator: async (mint) => {
    countCall('creator');
    await sleep(jitter(200, 3000));
    if (fault.outage) throw new Error('provider parked (soak outage)');
    const c = coins.get(mint);
    if (!c) return null;
    return { address: c.creator, launches: c.devLaunches, graduated: 0, graduationRate: 0, medianAthUsd: null, bestAthUsd: null, firstLaunchAt: c.detectedAt - 3600_000, lastLaunchAt: c.detectedAt, truncated: false };
  },
  analyze: async () => {
    throw new Error('AI is off');
  },
  positions: async () => {
    countCall('positions');
    if (fault.positionsHang) await new Promise(() => undefined);
    return [...book.values()].map((p) => position(coins.get(p.mint), p));
  },
  heldMints: async () => new Set(book.keys()),
  wallet: () => ({ sol: 3.2, address: WALLETS[0].address }),
  orders: (mint) => orders.filter((o) => !mint || o.mint === mint).map((o) => ({ ...o })),
  placeOrder: async (req) => {
    countCall('placeOrder');
    await sleep(jitter(20, 200));
    orders.push({ id: `o${++orderSeq}`, mint: req.mint, symbol: req.symbol ?? '', kind: req.kind, state: 'armed', triggerBasis: req.triggerBasis, triggerValue: req.triggerValue, amount: req.amount, placedPx: coins.get(req.mint)?.priceSol ?? null });
    ordersSnapshot();
    return { ok: true, message: 'armed' };
  },
  cancelOrders: (mint) => {
    let n = 0;
    for (const o of orders) if (o.mint === mint && (o.state === 'armed' || o.state === 'paused')) {
      o.state = 'cancelled';
      n += 1;
    }
    if (n) ordersSnapshot();
    return { ok: true, message: `cancelled ${n}`, cancelled: n };
  },
  clearCompletedOrders: () => {
    const before = orders.length;
    for (let i = orders.length - 1; i >= 0; i--) if (!['armed', 'paused'].includes(orders[i].state)) orders.splice(i, 1);
    return { ok: true, message: 'cleared', cleared: before - orders.length };
  },
  templates: () => [],
  applyTemplate: async () => ({ ok: false, message: 'no templates' }),
  createAlert: () => ({ ok: true, message: 'alert set' }),
  subscribeTicks: () => undefined,
  pin: () => undefined,
  runners: () => flags.slice(-40),
  leaders: () => [],
  notify: () => undefined,
  callout: async (mint, thesis, wallet) => {
    countCall('callout');
    await sleep(jitter(300, 1500));
    return { ok: true, message: 'called', thesis: thesis || 'soak line', address: wallet || PUMP_ACCOUNTS[0], calloutId: `c${Date.now()}${Math.floor(Math.random() * 1e6)}` };
  },
  calloutReply: async (mint, content, wallet) => {
    countCall('calloutReply');
    await sleep(jitter(200, 900));
    return { ok: true, message: 'replied', thesis: content, address: wallet || PUMP_ACCOUNTS[0], calloutId: 'c1', replyId: 'r1' };
  },
  discord: async () => {
    countCall('discord');
    await sleep(jitter(150, 900));
    return { ok: true, message: 'posted', messageId: String(1_300_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e9))) };
  },
  discordEdit: async () => {
    countCall('discordEdit');
    await sleep(jitter(150, 900));
    return { ok: true, message: 'edited' };
  },
  pumpSocial: async (action, target, wallet) => {
    countCall(`social:${action}`);
    await sleep(jitter(150, 700));
    return { ok: true, message: `${action} ok`, address: wallet || PUMP_ACCOUNTS[0] };
  },
  wallets: () => WALLETS,
  walletBuy: async () => ({ ok: false, message: 'not in soak' }),
  walletSell: async () => ({ ok: false, message: 'not in soak' }),
  pumpAccounts: () => PUMP_ACCOUNTS.map((a, i) => ({ address: a, username: `soak${i}`, active: i === 0 })),
  log: (level, line) => noteLog(level, line),
  toast: (level, message) => noteLog(level === 'error' ? 'error' : 'info', `toast: ${message}`),
  changed: () => {
    changedCount += 1;
    // What the engine does on every change: a full snapshot for the UI.
    const snap = auto.snapshot(false);
    snapshotBytes += JSON.stringify(snap).length;
  },
  sandbox: null, // filled below
};
let changedCount = 0;
let snapshotBytes = 0;

// ── Counters and latency ──────────────────────────────────────────────
const counters = {
  starts: 0,
  startsFailed: 0,
  gone: 0,
  handlerKills: 0,
  stillWaiting: 0,
  scriptErrors: 0,
  disables: 0,
  floods: 0,
  stateOverCap: 0,
  refusedRate: 0,
  dispatches: 0,
  dispatchFails: 0,
  logLines: 0,
};
const goneReasons = [];
const errorSamples = [];
let lat = []; // per-minute dispatch latencies, ms
/** Bounded sample: past `cap`, a random slot is replaced. */
const keep = (arr, v, cap) => {
  if (arr.length < cap) arr.push(v);
  else arr[Math.floor(Math.random() * cap)] = v;
};
const latAll = [];
let latMaxAll = 0;
const perEvent = {};
function noteLog(level, line) {
  counters.logLines += 1;
  if (/: sandbox running$/.test(line)) counters.starts += 1;
  if (/still waiting after/.test(line)) counters.stillWaiting += 1;
  if (/ran past \d+ s — killed/.test(line)) counters.handlerKills += 1;
  if (/DISABLED —/.test(line)) {
    counters.disables += 1;
    out('DISABLE:', line.slice(0, 300));
  }
  if (/sandbox messages a second/.test(line)) counters.floods += 1;
  if (/state save over the 16 KB cap|over 16 KB/.test(line)) counters.stateOverCap += 1;
  if (/over \d+ actions in a minute/.test(line)) counters.refusedRate += 1;
  if (level === 'error' || (/^script "/.test(line) && /handler: |unhandled: |sandbox gone/.test(line))) {
    counters.scriptErrors += 1;
    if (errorSamples.length < 60) errorSamples.push(`${new Date().toISOString()} ${line.slice(0, 300)}`);
  }
  if (process.env.SOAK_VERBOSE) out('[log]', level, line.slice(0, 240));
}

host.sandbox = {
  start: async (id, code, info) => {
    const r = await sb.start(id, code, info);
    if (!r.ok) {
      counters.startsFailed += 1;
      out('START FAILED:', JSON.stringify(r));
    }
    return r;
  },
  dispatch: async (id, name, payload) => {
    const t0 = Date.now();
    const r = await sb.dispatch(id, name, payload);
    const ms = Date.now() - t0;
    counters.dispatches += 1;
    if (!r.ok) counters.dispatchFails += 1;
    lat.push(ms);
    keep(latAll, ms, 50_000);
    if (ms > latMaxAll) latMaxAll = ms;
    keep((perEvent[name] ??= []), ms, 20_000);
    return r;
  },
  reply: sb.reply,
  stop: sb.stop,
  isRunning: sb.isRunning,
};

const installSandbox = () => sb.install({
  onMessage: (id, m) => auto.onSandboxMessage(id, m),
  onGone: (id, reason) => {
    counters.gone += 1;
    goneReasons.push(`${new Date().toISOString()} ${reason.slice(0, 160)}`);
    auto.onSandboxGone(id, reason);
  },
  log: (level, line) => noteLog(level, line),
});

// ── The built-in heavy script, when no SOAK_SCRIPT is given ────────────
const BUILTIN = `
const seen = new Map();
const watch = new Map();
bot.on('runner', async (t) => {
  if (seen.has(t.mint)) return;
  seen.set(t.mint, bot.now());
  if (seen.size > 2000) seen.delete(seen.keys().next().value);
  const m = await Promise.race([bot.market(t.mint).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
  const c = await Promise.race([bot.creator(t.mint).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
  bot.log('SCORE ' + JSON.stringify({ mint: t.mint, mc: m && m.marketCapUsd, dev: c && c.launches }));
  if (watch.size < 25) { watch.set(t.mint, t.priceSol); bot.subscribe(t.mint).catch(() => null); }
});
bot.on('tick', async (t) => { const w = watch.get(t.mint); if (w && t.priceSol > w * 3) { watch.delete(t.mint); await bot.buy(t.mint, 0.01).catch(() => null); } });
bot.on('launchUpdate', async () => {});
bot.every(30, async () => {
  const st = await bot.getState();
  const prices = await Promise.all([...watch.keys()].map((m) => bot.price(m).catch(() => null)));
  for (const p of await bot.positions().catch(() => [])) if (p.pnlPct < -40 || p.pnlPct > 100) await bot.sell(p.mint, 100).catch(() => null);
  st.n = (st.n || 0) + 1;
  st.recent = [...(st.recent || []), ...prices.slice(0, 3)].slice(-200);
  await bot.setState(st).catch((e) => bot.warn('state: ' + e.message));
  bot.stats({ passes: st.n, watching: watch.size });
  for (const m of [...watch.keys()].slice(0, 3)) { watch.delete(m); bot.unsubscribe(m).catch(() => null); }
});
`;

// ── Run ───────────────────────────────────────────────────────────────
function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function sandboxMem() {
  const part = session.fromPartition('script-sandbox');
  const boxes = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === part);
  const metrics = app.getAppMetrics();
  const outRows = [];
  for (const wc of boxes) {
    const pid = wc.getOSProcessId();
    const m = metrics.find((x) => x.pid === pid);
    let heap = null;
    try {
      heap = await Promise.race([wc.executeJavaScript("(typeof gc === 'function' && gc(), performance.memory ? [performance.memory.usedJSHeapSize, performance.memory.totalJSHeapSize] : null)"), sleep(3000).then(() => 'timeout')]);
    } catch {
      heap = 'gone';
    }
    outRows.push({ pid, wsKB: m?.memory?.workingSetSize ?? null, privKB: m?.memory?.privateBytes ?? null, heapUsed: Array.isArray(heap) ? heap[0] : heap, heapTotal: Array.isArray(heap) ? heap[1] : null });
  }
  return outRows;
}

app.whenReady().then(async () => {
  installSandbox();
  // SOAK_SCRIPT may name several files, comma-separated: they run side by
  // side, as a user running two scripts at once does.
  const paths = (process.env.SOAK_SCRIPT || '').split(',').map((x) => x.trim()).filter(Boolean);
  const sources = paths.length ? paths.map((f) => ({ name: path.basename(f, '.js'), code: fs.readFileSync(f, 'utf8') })) : [{ name: 'builtin', code: BUILTIN }];
  const name = sources.map((x) => x.name).join('+');
  auto.attach(host);
  auto.init(scratch);
  // Answers for each script's @inputs: its own defaults, with every webhook a
  // fake Discord URL (the mock host posts nowhere) and every account list the
  // mock accounts, so the callout / like / Discord paths all run.
  const { parseInputs } = require('./.sandbox/scriptinputs.cjs');
  const ids = [];
  for (const src of sources) {
    const specs = parseInputs(src.code).specs;
    const inputs = {};
    for (const [k, spec] of Object.entries(specs)) {
      if (spec.type === 'webhook') inputs[k] = 'https://discord.com/api/webhooks/123456789012345678/soak-not-a-real-token';
      else if (spec.type === 'pumpAccounts') inputs[k] = PUMP_ACCOUNTS.slice(1);
      else if (spec.type === 'wallet') inputs[k] = WALLETS[0].address;
    }
    const up = auto.upsert({
      name: src.name,
      chain: 'solana',
      kind: 'code',
      enabled: false,
      mode: 'live',
      code: src.code,
      inputs,
      rules: { trigger: 'launch', conditions: [], actions: [], cooldownSec: 60, oncePerMint: true },
      budget: { maxSolPerTrade: 0.05, maxBuysPerDay: 500, maxLossSolPerDay: 100, maxOpenPositions: 20, maxActionsPerMinute: ACTIONS_PER_MIN },
    });
    if (!up.ok) {
      out('upsert failed:', up.message);
      app.exit(2);
      return;
    }
    ids.push(up.id);
    out('enable', src.name, JSON.stringify(auto.setEnabled(up.id, true)));
  }
  const id = ids[0];
  auto.startTimers();

  const t0 = Date.now();
  const endAt = t0 + MINUTES * 60_000;
  const at = (f) => t0 + f * MINUTES * 60_000;
  const faultPlan = FAULTS
    ? [
        { at: at(0.2), name: 'outage-start', run: () => (fault.outage = true) },
        // 20 minutes on a 60-minute run; scaled with the run otherwise.
        { at: at(0.2) + Math.min(20, MINUTES / 3) * 60_000, name: 'outage-end', run: () => (fault.outage = false) },
        {
          at: at(0.6),
          name: 'renderer-crash',
          run: () => {
            const part = session.fromPartition('script-sandbox');
            for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.session === part) wc.forcefullyCrashRenderer();
          },
        },
        {
          at: at(0.7),
          name: 'main-freeze-40s',
          run: () => {
            const until = Date.now() + 40_000;
            while (Date.now() < until) {
              /* what a laptop sleep looks like to main's timers */
            }
          },
        },
        { at: at(0.8), name: 'positions-hang-start', run: () => (fault.positionsHang = true) },
        { at: at(0.8) + 2 * 60_000, name: 'positions-hang-end', run: () => (fault.positionsHang = false) },
      ]
    : [];
  const faultLog = [];
  // SOAK_CRASH_EVERY_S: also crash every sandbox renderer on this period —
  // the watchdog's own kill path, many times over.
  const crashEvery = Number(process.env.SOAK_CRASH_EVERY_S || 0);
  if (crashEvery > 0) {
    for (let k = 1; t0 + k * crashEvery * 1000 < endAt - 30_000; k++) {
      faultPlan.push({
        at: t0 + k * crashEvery * 1000,
        name: `renderer-crash-${k}`,
        run: () => {
          const part = session.fromPartition('script-sandbox');
          for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.session === part) wc.forcefullyCrashRenderer();
        },
      });
    }
  }

  // Event pumps.
  let launches = 0;
  let flagsSent = 0;
  let ticksSent = 0;
  let updatesSent = 0;
  const launchTimer = realSetInterval(() => {
    for (let i = 0; i < 2; i++) {
      const c = launchCoin();
      launches += 1;
      auto.onEngineEvent({ kind: 'launch', launch: row(c) });
    }
  }, 400);
  const priceTimer = realSetInterval(stepPrices, 1000);
  const flagTimer = realSetInterval(() => {
    // A flag goes to a coin aged 60–120 s when there is one.
    const now = Date.now();
    const pool = [...coins.values()].filter((c) => now - c.detectedAt > 20_000 && now - c.detectedAt < 180_000 && !c.flagged);
    const c = pool.length ? pool[Math.floor(Math.random() * pool.length)] : launchCoin();
    c.flagged = true;
    if (Math.random() < 0.3) c.drift = 0.03 + Math.random() * 0.04; // flagged coins run more often
    const f = flagOf(c);
    flags.push(f);
    if (flags.length > 200) flags.shift();
    flagsSent += 1;
    auto.onEngineEvent({ kind: 'runner', runner: f });
  }, Math.max(100, Math.round(60_000 / FLAGS_PER_MIN)));
  const updateTimer = realSetInterval(() => {
    // launchUpdate for the last 300 launches (throttled 2 s/mint in automation).
    const list = [...coins.values()].slice(-300);
    for (let i = 0; i < 20; i++) {
      const c = list[Math.floor(Math.random() * list.length)];
      if (!c) break;
      updatesSent += 1;
      auto.onEngineEvent({ kind: 'launchUpdate', launch: row(c) });
    }
  }, 250);
  const tickTimer = realSetInterval(() => {
    // Ticks for everything the script subscribed to or holds (1/s/mint after
    // automation's own throttle); the real engine only ticks tape-subscribed
    // mints, so this is the generous case.
    const mints = new Set(book.keys());
    for (const sid of ids) for (const m of auto._runtimeOf(sid)?.subscribed ?? []) mints.add(m);
    for (const m of mints) {
      const c = coins.get(m);
      if (!c) continue;
      ticksSent += 1;
      auto.onEngineEvent({ kind: 'tick', mint: m, time: Date.now(), priceSol: c.priceSol, volSol: 0.1, isBuy: Math.random() < 0.5 });
    }
  }, 300);
  const orderTimer = realSetInterval(() => {
    // Advanced orders fire on price.
    let changed = false;
    for (const o of orders) {
      if (o.state !== 'armed') continue;
      const c = coins.get(o.mint);
      const p = book.get(o.mint);
      if (!c || !p) {
        o.state = 'failed';
        changed = true;
        continue;
      }
      const x = c.priceSol / p.entryPriceSol;
      const hit =
        (o.kind === 'take_profit' && x >= 1 + (o.triggerValue ?? 100) / 100) ||
        (o.kind === 'stop_loss' && x <= 1 - (o.triggerValue ?? 40) / 100) ||
        (o.kind === 'trailing_stop' && Math.random() < 0.01);
      if (hit) {
        o.state = 'filled';
        changed = true;
        const pctSell = o.kind === 'take_profit' ? (o.amount ?? 50) : 100;
        void host.sell(o.mint, pctSell);
      }
    }
    if (changed) ordersSnapshot();
  }, 1000);

  // Samples.
  const samplesFile = path.join(OUT, 'samples.jsonl');
  fs.writeFileSync(samplesFile, '');
  const samples = [];
  const sample = async (label) => {
    if (typeof global.gc === 'function') global.gc();
    const mu = process.memoryUsage();
    const d = auto._diag();
    const s = {
      t: Math.round((Date.now() - t0) / 1000),
      label,
      mainHeapMB: +(mu.heapUsed / 1048576).toFixed(1),
      mainRssMB: +(mu.rss / 1048576).toFixed(1),
      sandboxes: await sandboxMem(),
      latP50: pct(lat, 50),
      latP95: pct(lat, 95),
      latMax: lat.length ? Math.max(...lat) : null,
      dispatched: lat.length,
      counters: { ...counters },
      diag: d.scripts[id] ?? null,
      diags: Object.fromEntries(ids.map((x) => [x, d.scripts[x] ?? null])),
      global: d.global,
      running: ids.every((x) => sb.isRunning(x)),
      enabled: ids.every((x) => auto.all().find((s) => s.id === x)?.enabled === true),
      persistWrites,
      persistMB: +(persistBytes / 1048576).toFixed(1),
      changedCount,
      snapshotMB: +(snapshotBytes / 1048576).toFixed(1),
      events: { launches, flagsSent, updatesSent, ticksSent },
      world: { coins: coins.size, held: book.size, orders: orders.length },
      hostCalls: { ...hostCalls },
      fault: { ...fault },
    };
    lat = [];
    samples.push(s);
    fs.appendFileSync(samplesFile, JSON.stringify(s) + '\n');
    const sbx = s.sandboxes.map((x) => `pid${x.pid} ws${Math.round((x.wsKB ?? 0) / 1024)}MB heap${typeof x.heapUsed === 'number' ? (x.heapUsed / 1048576).toFixed(1) : x.heapUsed}MB`).join(' ');
    out(
      `[${String(s.t).padStart(5)}s] main heap ${s.mainHeapMB}MB rss ${s.mainRssMB}MB | ${sbx || 'NO SANDBOX'} | lat p50 ${s.latP50} p95 ${s.latP95} max ${s.latMax} n${s.dispatched} | starts ${counters.starts} gone ${counters.gone} kills ${counters.handlerKills} err ${counters.scriptErrors} dis ${counters.disables} flood ${counters.floods} | kv ${ids.map((x) => s.diags[x]?.kvBytes).join('/')} q ${ids.map((x) => s.diags[x]?.queue).join('/')} sub ${ids.map((x) => s.diags[x]?.subscribed).join('/')} build ${ids.map((x) => s.diags[x]?.building ?? '-').join('/')} | held ${book.size} buys ${hostCalls.buy ?? 0} calls ${hostCalls.callout ?? 0} dc ${hostCalls.discord ?? 0} | writes ${persistWrites} | enabled ${s.enabled} running ${s.running}${label ? ' | ' + label : ''}`,
    );
  };
  await sample('start');
  const sampleTimer = realSetInterval(() => void sample(''), 60_000);

  // Fault scheduler.
  const faultTimer = realSetInterval(() => {
    const now = Date.now();
    while (faultPlan.length && faultPlan[0].at <= now) {
      const f = faultPlan.shift();
      out(`FAULT ${f.name} at ${Math.round((now - t0) / 1000)} s`);
      faultLog.push({ t: Math.round((now - t0) / 1000), name: f.name });
      f.run();
      faultPlan.sort((a, b) => a.at - b.at);
    }
  }, 500);
  faultPlan.sort((a, b) => a.at - b.at);

  while (Date.now() < endAt) await sleep(1000);

  for (const t of [launchTimer, priceTimer, flagTimer, updateTimer, tickTimer, orderTimer, sampleTimer, faultTimer]) clearInterval(t);
  await sample('end');
  const perEventStats = Object.fromEntries(Object.entries(perEvent).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) }]));
  const first = samples.find((s) => s.t >= 120) ?? samples[0];
  const last = samples[samples.length - 1];
  const heapOf = (s) => s.sandboxes.reduce((a, x) => a + (typeof x.heapUsed === 'number' ? x.heapUsed : 0), 0) / 1048576;
  const summary = {
    minutes: MINUTES,
    speed: SPEED,
    flagsPerMin: FLAGS_PER_MIN,
    script: name,
    counters,
    goneReasons,
    errorSamples,
    faults: faultLog,
    perEvent: perEventStats,
    latAll: { n: counters.dispatches, p50: pct(latAll, 50), p95: pct(latAll, 95), p99: pct(latAll, 99), max: latMaxAll },
    mainHeapMB: { at2min: first.mainHeapMB, end: last.mainHeapMB },
    sandboxHeapMB: { at2min: +heapOf(first).toFixed(1), end: +heapOf(last).toFixed(1) },
    persistWrites,
    persistMB: +(persistBytes / 1048576).toFixed(1),
    changedCount,
    snapshotMB: +(snapshotBytes / 1048576).toFixed(1),
    stillEnabled: last.enabled,
    stillRunning: last.running,
    hostCalls,
    uncaught,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  out('SUMMARY', JSON.stringify(summary));
  await auto.shutdown();
  await sb.stopAll();
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  app.exit(uncaught.length ? 1 : 0);
});
