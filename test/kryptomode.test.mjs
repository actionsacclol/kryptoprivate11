// $Krypto Mode (shared/kryptoMode.ts + electron/engine/kryptoMode.ts).
//
// What must never break: no bot runs on a coin whose metadata does not name
// its wallet; the disclosure survives any description; every driver passes
// the same guard (budget, pacing, no churn); a live book comes from the
// chain; a paper MCP connection cannot move a live session.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as K from './.kryptomodeshared.mjs';
import * as M from './.kryptomode.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const BOT = 'KryptoBot1111111111111111111111111111111111';
const MINT = 'Coin1111111111111111111111111111111111pump';

// ── disclosure ────────────────────────────────────────────────────────────
{
  const d = K.withKryptoDisclosure('my coin', BOT);
  const lines = d.split('\n');
  assert.equal(lines[0], 'my coin');
  assert.equal(lines[1], K.kryptoDisclosure(BOT), 'the disclosure is its own line');
  assert.ok(lines[1].includes(BOT), 'the FULL address, not a shortened one');
  assert.equal(lines.length, 3, 'then the launch mark');
  assert.equal(K.parseKryptoDisclosure(d), BOT);
  // Idempotent, and a re-upload with a different wallet replaces the old line.
  const again = K.withKryptoDisclosure(d, BOT);
  assert.equal(again.split('\n').filter((l) => l.startsWith('Krypto Mode:')).length, 1, 'never two disclosures');
  const other = 'Zther1111111111111111111111111111111111111';
  const swapped = K.withKryptoDisclosure(d, other);
  assert.equal(K.parseKryptoDisclosure(swapped), other);
  assert.ok(!swapped.includes(BOT), 'the old wallet is gone');
  // Over the limit: the user's words give way, never the disclosure or mark.
  const long = K.withKryptoDisclosure('x'.repeat(2000), BOT);
  assert.ok(long.length <= 500, `fits pump's 500 (${long.length})`);
  assert.equal(K.parseKryptoDisclosure(long), BOT);
  assert.equal(long.split('\n').length, 3);
  // Empty description still declares.
  assert.equal(K.parseKryptoDisclosure(K.withKryptoDisclosure('', BOT)), BOT);
  assert.throws(() => K.withKryptoDisclosure('x', 'not an address'));
  assert.equal(K.parseKryptoDisclosure('a normal description'), null);
  assert.equal(K.parseKryptoDisclosure(null), null);
  ok('the disclosure names the full wallet, survives any description, never doubles');
}

// ── options ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(K.kryptoOptionProblems(K.DEFAULT_KRYPTO_OPTIONS), [], 'off = no problems');
  const on = { ...K.DEFAULT_KRYPTO_OPTIONS, enabled: true };
  assert.deepEqual(K.kryptoOptionProblems(on), []);
  assert.equal(K.kryptoOptionProblems({ ...on, budgetSol: 0.001 }).length, 1);
  assert.equal(K.kryptoOptionProblems({ ...on, budgetSol: 99 }).length, 1);
  const parsed = K.kryptoOptionsOf({ enabled: true, driver: 'evil', strategy: 'x', budgetSol: 'nope', live: 'yes' });
  assert.equal(parsed.driver, 'strategy');
  assert.equal(parsed.strategy, 'ladder');
  assert.equal(parsed.live, false, 'live only when literally true');
  assert.equal(K.DEFAULT_KRYPTO_OPTIONS.live, false, 'paper by default');
  ok('options: paper by default, malformed input falls back, budget bounded');
}

// ── strategies ────────────────────────────────────────────────────────────
const view = (o = {}) => ({
  now: 1_000_000,
  priceSol: 1e-7,
  tokensHeld: 0,
  netSpentSol: 0,
  budgetSol: 0.1,
  entered: false,
  entryPriceSol: null,
  peakPriceSol: 1e-7,
  lots: [],
  rungsDone: [],
  lastTradeAt: null,
  lastSide: null,
  recentTrades: [],
  ...o,
});
{
  const open = K.strategyIntent('ladder', view());
  assert.equal(open.action, 'buy');
  assert.equal(open.sol, 0.05, 'opens with half the budget');
  const held = { entered: true, tokensHeld: 1000, entryPriceSol: 1e-7 };
  assert.equal(K.strategyIntent('ladder', view({ ...held, priceSol: 1.5e-7 })).action, 'hold');
  const r2 = K.strategyIntent('ladder', view({ ...held, priceSol: 2.1e-7 }));
  assert.equal(r2.action, 'sell');
  assert.equal(r2.rung, 2);
  assert.equal(r2.pct, 25, 'first of four rungs = a quarter');
  const r3 = K.strategyIntent('ladder', view({ ...held, priceSol: 3.2e-7, rungsDone: [2] }));
  assert.equal(r3.rung, 3);
  assert.ok(Math.abs(r3.pct - 100 / 3) < 1e-9, 'a third of what is left');
  const r10 = K.strategyIntent('ladder', view({ ...held, priceSol: 11e-7, rungsDone: [2, 3, 5] }));
  assert.equal(r10.pct, 100, 'last rung sells the rest');
  const gap = K.strategyIntent('ladder', view({ ...held, priceSol: 6e-7 }));
  assert.equal(gap.rung, 5, 'a jump past several rungs takes the highest');
  const stop = K.strategyIntent('ladder', view({ ...held, priceSol: 0.49e-7 }));
  assert.equal(stop.pct, 100);
  assert.ok(stop.exit);
  assert.equal(K.strategyIntent('ladder', view({ priceSol: null })).action, 'hold', 'nothing trades on an unknown price');
  ok('ladder: half in, quarter at 2x/3x/5x, rest at 10x, out at -50%');
}
{
  const held = { entered: true, tokensHeld: 1000, entryPriceSol: 1e-7 };
  assert.equal(K.strategyIntent('trail', view({ ...held, priceSol: 0.59e-7, peakPriceSol: 1.1e-7 })).pct, 100, 'stop before arming');
  assert.equal(K.strategyIntent('trail', view({ ...held, priceSol: 0.7e-7, peakPriceSol: 1.1e-7 })).action, 'hold');
  assert.equal(K.strategyIntent('trail', view({ ...held, priceSol: 1.6e-7, peakPriceSol: 2e-7 })).action, 'hold', '20% off the high: hold');
  const t = K.strategyIntent('trail', view({ ...held, priceSol: 1.5e-7, peakPriceSol: 2e-7 }));
  assert.equal(t.action, 'sell');
  assert.equal(t.pct, 100);
  ok('trail: -40% stop, then out at 25% off the high');
}
{
  assert.equal(K.strategyIntent('dip', view({ entered: true, priceSol: 0.9e-7, peakPriceSol: 1e-7 })).action, 'hold', 'no dip, no buy');
  const b = K.strategyIntent('dip', view({ entered: true, priceSol: 0.7e-7, peakPriceSol: 1e-7 }));
  assert.equal(b.action, 'buy');
  assert.equal(b.sol, 0.025, 'a quarter of the budget');
  assert.equal(K.strategyIntent('dip', view({ entered: true, priceSol: 0.1e-7, peakPriceSol: 1e-7 })).action, 'hold', 'not catching a dead coin');
  const lot = { priceSol: 0.7e-7, tokens: 500, sol: 0.035, at: 1 };
  assert.equal(K.strategyIntent('dip', view({ entered: true, priceSol: 0.65e-7, peakPriceSol: 1e-7, lots: [lot], tokensHeld: 500 })).action, 'hold', 'not far enough below the last piece');
  const s = K.strategyIntent('dip', view({ entered: true, priceSol: 0.95e-7, peakPriceSol: 1e-7, lots: [lot, { ...lot, priceSol: 0.5e-7 }], tokensHeld: 1000 }));
  assert.equal(s.action, 'sell');
  assert.equal(s.pct, 50, 'sells just that piece');
  ok('dip: a quarter per 25% dip, each piece out at +30%');
}

// ── the guard ─────────────────────────────────────────────────────────────
{
  const buy = { action: 'buy', sol: 1, reason: 'x' };
  const c = K.checkKryptoIntent(buy, view({ netSpentSol: 0.08 }));
  assert.ok(c.ok);
  assert.ok(Math.abs(c.intent.sol - 0.02) < 1e-9, 'clipped to what is left of the budget');
  assert.equal(K.checkKryptoIntent(buy, view({ netSpentSol: 0.099 })).ok, false, 'budget in use');
  assert.equal(K.checkKryptoIntent(buy, view({ lastTradeAt: 1_000_000 - 5_000, lastSide: 'buy' })).ok, false, 'pacing');
  const rebuy = K.checkKryptoIntent(buy, view({ lastTradeAt: 1_000_000 - 30_000, lastSide: 'sell' }));
  assert.equal(rebuy.ok, false);
  assert.match(rebuy.reason, /buying back/);
  assert.ok(K.checkKryptoIntent(buy, view({ lastTradeAt: 1_000_000 - 61_000, lastSide: 'sell' })).ok);
  const busy = Array.from({ length: 20 }, (_, i) => 1_000_000 - (i + 1) * 60_000);
  assert.equal(K.checkKryptoIntent(buy, view({ recentTrades: busy })).ok, false, 'hourly cap');
  assert.equal(K.checkKryptoIntent({ action: 'sell', pct: 50, reason: 'x' }, view()).ok, false, 'nothing to sell');
  assert.equal(K.checkKryptoIntent(buy, view({ priceSol: null })).ok, false);
  assert.equal(K.checkKryptoIntent({ action: 'sell', pct: 500, reason: 'x' }, view({ tokensHeld: 1 })).intent.pct, 100);
  ok('guard: budget clip, 15 s pacing, no buy-back within a minute, 20/hour');
}
{
  assert.deepEqual(K.parseKryptoIntent('sure! {"action":"buy","sol":0.01,"reason":"dip"}'), { action: 'buy', sol: 0.01, reason: 'dip' });
  assert.equal(K.parseKryptoIntent('{"action":"sell","percent":150}'), null, 'out-of-range sell is unusable');
  assert.equal(K.parseKryptoIntent('{"action":"yolo"}'), null);
  assert.equal(K.parseKryptoIntent('no json'), null);
  const facts = K.kryptoFacts(view({ tokensHeld: 10, entryPriceSol: 1e-7 }), { symbol: 'X', ageSec: null, marketCapUsd: null, holders: null, change5mPct: null });
  assert.match(facts, /Market cap: unknown/, 'unknown is unknown, never 0');
  assert.doesNotMatch(facts, /[1-9A-HJ-NP-Za-km-z]{32,44}/, 'no wallet address goes to the model');
  ok('AI replies parse strictly; the facts carry no address and no invented zeros');
}

// ── the session manager ───────────────────────────────────────────────────
function fakeHost(o = {}) {
  const h = {
    t: 10_000_000,
    price: 1e-7,
    blocked: null,
    chain: { lamports: 0, tokens: 0 },
    buys: [],
    sells: [],
    funds: [],
    logs: [],
    now: () => h.t,
    priceSol: async () => h.price,
    market: () => ({ symbol: 'KM', ageSec: 60, marketCapUsd: 5000, holders: 10, change5mPct: 3 }),
    liveBlocked: () => h.blocked,
    buy: async (walletId, mint, sol) => {
      h.buys.push({ walletId, mint, sol });
      h.chain.lamports -= Math.round(sol * 1.01 * 1e9);
      h.chain.tokens += sol / h.price;
      return { ok: true, message: 'Landed', signature: 'sigB' };
    },
    sell: async (walletId, mint, pct) => {
      h.sells.push({ walletId, mint, pct });
      const sold = h.chain.tokens * (pct / 100);
      h.chain.tokens -= sold;
      h.chain.lamports += Math.round(sold * h.price * 0.99 * 1e9);
      return { ok: true, message: 'Landed', signature: 'sigS' };
    },
    balances: async () => ({ ...h.chain }),
    fund: async (from, to, lamports) => {
      h.funds.push({ from, to, lamports });
      h.chain.lamports += lamports;
      return { ok: true, message: 'sent' };
    },
    collect: async () => ({ ok: true, message: 'collected' }),
    ask: async () => o.aiReply ?? null,
    watch: () => {},
    emit: () => {},
    log: (level, line) => h.logs.push(line),
    ...o,
  };
  return h;
}
const OPTS = { enabled: true, driver: 'strategy', strategy: 'ladder', budgetSol: 0.1, live: false };
{
  M._reset();
  const h = fakeHost();
  M.init('', h);
  const r = await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/undeclared', launchWalletId: 'L', options: OPTS });
  assert.equal(r.ok, false, 'no declaration, no bot');
  assert.match(r.message, /does not declare/);
  assert.equal(M.list().length, 0);
  ok('THE ONE DOOR: a coin whose metadata did not declare the wallet gets no bot');
}
{
  M._reset();
  const h = fakeHost();
  M.init('', h);
  M.declare('https://x/meta', 'W1', BOT);
  assert.equal(M.unusedDeclaredWallet().walletId, 'W1', 'a re-upload reuses the unused wallet');
  const r = await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: OPTS });
  assert.ok(r.ok, r.message);
  assert.equal(r.session.mode, 'paper');
  assert.equal(r.session.address, BOT);
  assert.equal(M.unusedDeclaredWallet(), null, 'now used');
  // Even after the session is removed, that wallet is named in the old coin's
  // description — it is never offered to another coin.
  M.setStatus(r.session.id, 'stopped');
  M.remove(r.session.id);
  assert.equal(M.unusedDeclaredWallet(), null, 'a wallet that ran a session is never reused');
  M._reset();
  M.init('', h);
  M.declare('https://x/meta', 'W1', BOT);
  assert.ok((await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: OPTS })).ok);
  assert.equal((await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: OPTS })).ok, false, 'one session per coin');
  await M.tick();
  let s = M.list()[0];
  assert.equal(s.trades[0].side, 'buy');
  assert.equal(s.trades[0].mode, 'paper');
  assert.ok(s.tokensHeld > 0);
  assert.equal(h.buys.length, 0, 'paper signs nothing');
  // 2x → first rung.
  h.t += 20_000;
  h.price = 2.1e-7;
  await M.tick();
  s = M.list()[0];
  assert.equal(s.trades[0].side, 'sell');
  assert.deepEqual(s.rungsDone, [2]);
  // A crash to the stop ends the round and stops the strategy.
  h.t += 20_000;
  h.price = 0.4e-7;
  await M.tick();
  s = M.list()[0];
  assert.equal(s.tokensHeld, 0);
  assert.equal(s.status, 'stopped');
  ok('paper session: opens, takes the 2x rung, stops out, signs nothing');
}
{
  M._reset();
  const h = fakeHost();
  M.init('', h);
  M.declare('https://x/meta', 'W1', BOT);
  const r = await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: { ...OPTS, live: true } });
  assert.ok(r.ok);
  let s = M.list()[0];
  assert.equal(s.mode, 'live');
  assert.equal(h.funds.length, 1);
  assert.equal(h.funds[0].from, 'L', 'funded from the launch wallet');
  assert.equal(h.funds[0].to, BOT);
  assert.equal(h.funds[0].lamports, 100_000_000 + M.FEE_HEADROOM_LAMPORTS);
  await M.tick();
  s = M.list()[0];
  assert.equal(h.buys.length, 1);
  assert.equal(h.buys[0].walletId, 'W1', 'signed by the bot wallet');
  assert.ok(Math.abs(s.netSpentSol - 0.0505) < 1e-6, `net spend read from the chain, fees included (${s.netSpentSol})`);
  assert.equal(s.tokensHeld, h.chain.tokens, 'tokens read from the chain');
  // Blocked live: waits, does not stop.
  h.blocked = 'live execution is not armed';
  h.t += 20_000;
  h.price = 2.5e-7;
  await M.tick();
  assert.equal(h.sells.length, 0);
  assert.match(M.list()[0].note, /waiting/);
  h.blocked = null;
  await M.tick();
  assert.equal(h.sells.length, 1);
  assert.equal(h.sells[0].pct, 25);
  // Sell all, withdraw.
  const sa = await M.sellAll(s.id);
  assert.ok(sa.ok);
  assert.equal(M.list()[0].status, 'stopped');
  assert.equal(M.list()[0].tokensHeld, 0);
  assert.ok((await M.withdraw(s.id)).ok);
  ok('live session: funded from the launch wallet, signed by the bot wallet, book from the chain');
}
{
  M._reset();
  const h = fakeHost();
  M.init('', h);
  M.declare('https://x/meta', 'W1', BOT);
  await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: { ...OPTS, driver: 'mcp' } });
  await M.tick();
  assert.equal(M.list()[0].trades.length, 0, 'an MCP session waits for the tool');
  const b = await M.tradeFromMcp(MINT, 'buy', 0.03, false);
  assert.ok(b.ok, b.message);
  const fast = await M.tradeFromMcp(MINT, 'sell', 50, false);
  assert.equal(fast.ok, false, 'the same pacing guard applies to MCP');
  h.t += 20_000;
  assert.ok((await M.tradeFromMcp(MINT, 'sell', 50, false)).ok);
  h.t += 20_000;
  const rebuy = await M.tradeFromMcp(MINT, 'buy', 0.01, false);
  assert.equal(rebuy.ok, false, 'no buying back within a minute');
  // Live session + paper connection.
  await M.goLive(M.list()[0].id);
  h.t += 120_000;
  const paperConn = await M.tradeFromMcp(MINT, 'buy', 0.01, false);
  assert.equal(paperConn.ok, false);
  assert.match(paperConn.message, /paper-only/);
  assert.ok((await M.tradeFromMcp(MINT, 'buy', 0.01, true)).ok);
  // A strategy session refuses MCP.
  M._reset();
  M.init('', fakeHost());
  M.declare('https://x/m2', 'W2', BOT);
  await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/m2', launchWalletId: 'L', options: OPTS });
  assert.equal((await M.tradeFromMcp(MINT, 'buy', 0.01, true)).ok, false, 'a strategy session is not MCP’s to drive');
  ok('MCP: only MCP sessions, same guard, a paper connection never moves a live session');
}
{
  M._reset();
  const h = fakeHost({ aiReply: { ok: true, message: 'ok', text: '{"action":"buy","sol":5,"reason":"dip"}' } });
  M.init('', h);
  M.declare('https://x/meta', 'W1', BOT);
  await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: { ...OPTS, driver: 'ai' } });
  await M.tick();
  const s = M.list()[0];
  assert.equal(s.trades.length, 1);
  assert.ok(s.trades[0].sol <= 0.1 + 1e-9, 'the AI asked for 5 SOL; the budget is 0.1');
  h.t += 20_000;
  await M.tick();
  assert.equal(M.list()[0].trades.length, 1, 'the AI is asked at most once a minute');
  ok('AI key: asked once a minute, clipped to the budget by the same guard');
}
{
  M._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-'));
  fs.writeFileSync(path.join(dir, 'krypto-mode.json'), '{not json');
  const h = fakeHost();
  M.init(dir, h);
  assert.ok(M.failure());
  M.declare('https://x/meta', 'W1', BOT);
  const r = await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: OPTS });
  assert.equal(r.ok, false, 'read-only run starts nothing');
  assert.equal(fs.readFileSync(path.join(dir, 'krypto-mode.json'), 'utf8'), '{not json', 'the unreadable file is left alone');
  // And a good file round-trips.
  M._reset();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'km-'));
  M.init(dir2, fakeHost());
  M.declare('https://x/meta', 'W1', BOT);
  await M.start({ mint: MINT, symbol: 'KM', metadataUri: 'https://x/meta', launchWalletId: 'L', options: OPTS });
  M._reset();
  M.init(dir2, fakeHost());
  assert.equal(M.list().length, 1);
  assert.equal(M.declaredFor('https://x/meta').address, BOT);
  M._reset();
  ok('persistence: a corrupt file is never overwritten; a good one round-trips');
}

// ── the wiring, read from source ──────────────────────────────────────────
{
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const ipc = src('../electron/ipc.ts');
  const upload = ipc.slice(ipc.indexOf("ipcMain.handle('launch:upload'"), ipc.indexOf("ipcMain.handle('launch:upload'") + 2400);
  assert.ok(upload.includes('withKryptoDisclosure(words, bot.address)'), 'main stamps the bot wallet into the description itself');
  assert.ok(upload.indexOf('withKryptoDisclosure(') < upload.indexOf('uploadLaunchMetadata('), 'stamped BEFORE the pin');
  assert.ok(upload.indexOf('kryptoMode.declare(') > upload.indexOf('uploadLaunchMetadata('), 'declared only after the stamped file is pinned');
  const send = ipc.slice(ipc.indexOf("ipcMain.handle('launch:send'"), ipc.indexOf("ipcMain.handle('launch:send'") + 2400);
  assert.ok(send.includes('kryptoMode.start('), 'the bot starts from the launch');
  assert.ok(send.includes('metadataUri: draft.metadataUri'), 'keyed by the metadata file the mint points at');
  assert.equal(ipc.split('kryptoMode.start(').length - 1, 1, 'and from nowhere else');
  const engine = src('../electron/engine/engine.ts');
  const body = (name) => engine.slice(engine.indexOf(`  ${name}(`), engine.indexOf(`  ${name}(`) + 300);
  assert.ok(body('kryptoBuy').includes('return this.labBuy('), 'a bot buy is the ordinary wallet-lab buy');
  assert.ok(body('kryptoSell').includes('return this.labSell('), 'and a bot sell the ordinary sell');
  const launch = src('../shared/launch.ts');
  assert.ok(launch.includes("krypto: { enabled: false, driver: 'strategy', strategy: 'ladder', budgetSol: 0.1, live: false }"), 'a new draft has Krypto Mode off, and paper');
  ok('wiring: stamped before the pin, declared after it, started only by the launch, traded through the normal path');
}

console.log(`kryptomode: ${passed}/14 passed`);
if (passed !== 14) process.exitCode = 1;
