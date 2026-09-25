// What an MCP tool call does (electron/engine/mcpTools.ts), against a fake host.
//
// The server test proves the door is a door. This proves that what comes
// through it is bounded: arguments are refused rather than coerced, unknown
// fields never reach a trade, the budget is reserved BEFORE the app is asked
// (so two calls in flight cannot both spend the same allowance), and a paper
// connection never reaches the live pipeline.

import assert from 'node:assert';
import * as tools from './.mcptools.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const MINT = 'CopyMint111111111111111111111111111111111';
const WALLET = 'Whae1111111111111111111111111111111111111';

let access = 'live';
let budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 4 };
let calls;
let answers;

function setup(over = {}) {
  tools._reset();
  calls = { buys: [], sells: [], orders: [], cancels: [], reads: [] };
  answers = { buy: { ok: true, message: 'bought' }, sell: { ok: true, message: 'sold' }, order: { ok: true, message: 'armed' }, ...over.answers };
  const read = (name) => async (...args) => {
    calls.reads.push({ name, args });
    return over[name] !== undefined ? over[name] : { name };
  };
  tools.attach({
    access: () => access,
    budget: () => budget,
    defaultChain: () => 'solana',
    walletInfo: read('walletInfo'),
    positions: async (paper, chain) => {
      calls.reads.push({ name: 'positions', args: [paper, chain] });
      return { paper, chain };
    },
    token: read('token'),
    discover: read('discover'),
    chart: read('chart'),
    tokenLinks: read('tokenLinks'),
    runnerAlerts: read('runnerAlerts'),
    callouts: read('callouts'),
    scoutBoard: read('scoutBoard'),
    scoutWallet: read('scoutWallet'),
    copyConfigs: read('copyConfigs'),
    orders: read('orders'),
    trades: read('trades'),
    buy: async (mint, amount, paper, chain) => {
      calls.buys.push({ mint, amount, paper, chain });
      return answers.buy;
    },
    sell: async (mint, percent, paper, chain) => {
      calls.sells.push({ mint, percent, paper, chain });
      return answers.sell;
    },
    placeOrder: async (req, paper) => {
      calls.orders.push({ req, paper });
      return answers.order;
    },
    cancelOrders: async (mint) => {
      calls.cancels.push(mint);
      return { ok: true, message: 'Cancelled 2 order(s).', cancelled: 2 };
    },
    log: () => {},
  });
}

// ── arguments are refused, never coerced ─────────────────────────────────
{
  setup();
  access = 'live';
  const bad = [
    ['buy_token', { mint: 'not-base58', amount: 0.01 }, /not a Solana mint/],
    ['buy_token', { mint: MINT }, /amount is required/],
    ['buy_token', { mint: MINT, amount: '0.1' }, /amount must be a number/],
    ['buy_token', { mint: MINT, amount: Number.NaN }, /amount must be a number/],
    ['sell_token', { mint: MINT, percent: 0 }, /at least 1/],
    ['sell_token', { mint: MINT, percent: 101 }, /at most 100/],
    ['find_tokens', {}, /list is required/],
    ['find_tokens', { list: 'hot' }, /list must be one of/],
    ['find_tokens', { list: 'new', limit: 500 }, /at most 50/],
    ['get_wallet_record', { address: 'nope' }, /is not an address/],
    ['get_wallet_scores', { chain: 'ethereum' }, /chain must be one of/],
    ['place_order', { mint: MINT, kind: 'limit_buy', triggerBasis: 'pct', triggerValue: 20, amount: 0.05 }, /needs an absolute level/],
    ['place_order', { mint: MINT, kind: 'moon', triggerBasis: 'pct', triggerValue: 1, amount: 1 }, /kind must be one of/],
  ];
  for (const [name, args, re] of bad) {
    const r = await tools.call(name, args);
    assert.equal(r.ok, false, `${name} ${JSON.stringify(args)} should be refused`);
    assert.match(r.text, re, `${name}: ${r.text}`);
  }
  assert.equal(calls.buys.length + calls.sells.length + calls.orders.length, 0, 'not one of them reached the app');

  // A field nobody agreed to read must never ride along into a trade.
  const smuggled = await tools.call('buy_token', { mint: MINT, amount: 0.01, feeBps: 0, slippage: 99 });
  assert.equal(smuggled.ok, false);
  assert.match(smuggled.text, /does not take feeBps, slippage/);
  assert.equal(calls.buys.length, 0);
  ok('bad arguments are refused with the reason, and an unknown field is refused rather than ignored');
}

// ── the access ladder reaches the tools themselves ───────────────────────
{
  setup();
  access = 'read';
  for (const name of ['buy_token', 'sell_token', 'place_order', 'cancel_orders']) {
    const r = await tools.call(name, { mint: MINT, amount: 0.01, percent: 50, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 20 });
    assert.equal(r.ok, false, `${name} on a read connection`);
    assert.match(r.text, /read only/i);
  }
  assert.equal(calls.buys.length + calls.sells.length + calls.orders.length + calls.cancels.length, 0);
  // Reads still work, and say which mode they are in.
  const w = await tools.call('get_wallet', {});
  assert.equal(w.ok, true);
  assert.match(w.text, /READ ONLY/, 'a read-only connection is told it cannot trade at all — not that it is in paper, which would invite it to try');
  assert.equal(w.data.mode, 'read-only');
  ok('a read-only connection is refused every trade tool inside the tool layer too, not only at the door');
}

// ── paper never touches the live pipeline ────────────────────────────────
{
  setup();
  access = 'paper';
  const b = await tools.call('buy_token', { mint: MINT, amount: 0.05 });
  assert.equal(b.ok, true);
  assert.deepEqual(calls.buys, [{ mint: MINT, amount: 0.05, paper: true, chain: 'solana' }], 'paper is passed down, not assumed');
  assert.match(b.text, /Paper buy/);
  const s = await tools.call('sell_token', { mint: MINT, percent: 50 });
  assert.equal(calls.sells[0].paper, true);
  assert.match(s.text, /Paper sell/);
  // Paper is not bounded by the value caps — a record built under tighter
  // limits measures a strategy nobody intends to run.
  const big = await tools.call('buy_token', { mint: MINT, amount: 999 });
  assert.equal(big.ok, true);
  assert.equal(calls.buys.at(-1).amount, 999);
  const pos = await tools.call('get_positions', {});
  assert.deepEqual(pos.data, { paper: true, chain: 'solana' }, 'and positions read the paper book');
  ok('a paper connection passes paper all the way down, reads the paper book, and is not held to the spending caps');
}

// ── a read-only connection reads the book the APP is using ───────────────
// 09-24: a read-only connection on a live app read the paper book and said
// the wallet held nothing while it held a coin.
{
  setup({ walletInfo: { appMode: 'live' } });
  access = 'read';
  assert.deepEqual((await tools.call('get_positions', {})).data, { paper: false, chain: 'solana' }, 'live app: the real book');
  setup({ walletInfo: { appMode: 'paper' } });
  access = 'read';
  assert.deepEqual((await tools.call('get_positions', {})).data, { paper: true, chain: 'solana' }, 'paper app: the paper book');
  setup({ walletInfo: {} });
  access = 'read';
  assert.equal((await tools.call('get_positions', {})).data.paper, true, 'an unknown app mode never claims the live book');
  ok('a read-only connection reads the book the app is using, not always the paper one');
}

// ── live spending is bounded, and reserved before the app is asked ───────
{
  setup();
  access = 'live';
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.25, maxTradesPerMinute: 10 };

  const over = await tools.call('buy_token', { mint: MINT, amount: 0.5 });
  assert.equal(over.ok, false);
  assert.match(over.text, /0\.1 per-trade limit/);
  assert.equal(calls.buys.length, 0, 'a refusal never reaches the app');

  for (let i = 0; i < 2; i++) assert.equal((await tools.call('buy_token', { mint: MINT, amount: 0.1 })).ok, true);
  assert.equal(calls.buys.length, 2);
  const capped = await tools.call('buy_token', { mint: MINT, amount: 0.1 });
  assert.equal(capped.ok, false, '0.2 spent + 0.1 passes the 0.25 hourly cap');
  assert.match(capped.text, /hourly limit/);
  assert.equal(calls.buys.length, 2);

  // The reservation rule: the attempt is recorded BEFORE the app answers, so
  // two calls in flight cannot both read an allowance neither has spent.
  setup();
  budget = { maxBuySol: 1, hourlyCapSol: 1, maxTradesPerMinute: 10 };
  let release;
  answers.buy = new Promise((r) => (release = r));
  const a = tools.call('buy_token', { mint: MINT, amount: 0.6 });
  const b = tools.call('buy_token', { mint: MINT, amount: 0.6 });
  release({ ok: true, message: 'bought' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, 'exactly one of two concurrent buys passed the cap');
  assert.equal(calls.buys.length, 1, 'and only one reached the app');

  // The rate limit counts every trade, buy or sell.
  setup();
  budget = { maxBuySol: 1, hourlyCapSol: 10, maxTradesPerMinute: 2 };
  assert.equal((await tools.call('sell_token', { mint: MINT, percent: 10 })).ok, true);
  assert.equal((await tools.call('sell_token', { mint: MINT, percent: 10 })).ok, true);
  const third = await tools.call('sell_token', { mint: MINT, percent: 10 });
  assert.equal(third.ok, false);
  assert.match(third.text, /2 trades in a minute/);
  ok('live buys meet the per-trade and hourly caps, the allowance is reserved before the app is asked, and the rate limit counts sells too');
}

// ── a limit buy commits funds, so it meets the same caps ─────────────────
{
  setup();
  access = 'live';
  budget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 10 };
  const over = await tools.call('place_order', { mint: MINT, kind: 'limit_buy', triggerBasis: 'price_sol', triggerValue: 0.001, amount: 5 });
  assert.equal(over.ok, false, 'an order that would spend 5 SOL when it fires is not a way around a 0.1 cap');
  assert.equal(calls.orders.length, 0);
  // An exit is never value-capped: the worst case is a sale into the user's
  // own wallet.
  const stop = await tools.call('place_order', { mint: MINT, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 });
  assert.equal(stop.ok, true);
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].paper, false);
  ok('a limit buy is checked against the buy caps; a stop loss, which only ever sells, is not');
}

{
  // MCP-1 (audit 2026-09-23): arming a sell-type order still counts against
  // the per-minute rate limit, so a live agent cannot arm unlimited
  // stop_loss/take_profit/limit_sell orders in a burst.
  setup();
  access = 'live';
  budget = { maxBuySol: 1, hourlyCapSol: 10, maxTradesPerMinute: 2 };
  const a = await tools.call('place_order', { mint: MINT, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 });
  const b = await tools.call('place_order', { mint: MINT, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 50, amount: 100 });
  const c = await tools.call('place_order', { mint: MINT, kind: 'limit_sell', triggerBasis: 'price_sol', triggerValue: 0.001, amount: 100 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, false, 'the third arming in the minute is over the rate limit');
  assert.match(c.text ?? c.message ?? JSON.stringify(c), /trades in a minute/);
  assert.equal(calls.orders.length, 2, 'only the two that passed the limit were armed');
  ok('arming sell-type orders is rate-limited, not just limit buys');
}

// ── reads pass their arguments through and say what they are ─────────────
{
  setup({ token: null, scoutWallet: null });
  access = 'read';
  const missing = await tools.call('get_token', { mint: MINT });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /could not read that token/);
  const noRec = await tools.call('get_wallet_record', { address: WALLET });
  assert.equal(noRec.ok, false);
  assert.match(noRec.text, /Read from the chain/, 'and says how to fill the record in');

  setup();
  const scores = await tools.call('get_wallet_scores', { chain: 'bnb', window: 'month', limit: 5, onlyWorthALook: true });
  assert.equal(scores.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, ['bnb', 'month', 5, true], 'every argument reaches the host as given');
  assert.match(scores.text, /not an edge/, 'and the answer repeats what the score is not');
  const hist = await tools.call('get_trade_history', {});
  assert.deepEqual(calls.reads.at(-1).args, [25], 'the documented default is the one used');
  assert.match(hist.text, /already include fees/);
  ok('reads pass their arguments through unchanged, default as documented, and each answer carries the caveat the number needs');
}

// ── three chains, where the app has three ────────────────────────────────
{
  setup();
  access = 'live';
  budget = { maxBuySol: 10, hourlyCapSol: 100, maxTradesPerMinute: 60 };
  const EVM_TOKEN = '0x' + 'ab'.repeat(20);

  // An EVM address is refused on Solana and vice versa — a buy that fell
  // through to the wrong chain would spend SOL on another chain's address.
  assert.match((await tools.call('buy_token', { mint: EVM_TOKEN, amount: 0.1 })).text, /not a Solana mint/);
  assert.match((await tools.call('buy_token', { mint: MINT, amount: 0.1, chain: 'bnb' })).text, /not a contract address on BNB/);
  assert.equal(calls.buys.length, 0);

  // The right pairing routes, and the chain travels all the way down.
  assert.equal((await tools.call('buy_token', { mint: EVM_TOKEN, amount: 0.1, chain: 'bnb' })).ok, true);
  assert.deepEqual(calls.buys.at(-1), { mint: EVM_TOKEN, amount: 0.1, paper: false, chain: 'bnb' });
  assert.equal((await tools.call('sell_token', { mint: EVM_TOKEN, percent: 50, chain: 'robinhood' })).ok, true);
  assert.equal(calls.sells.at(-1).chain, 'robinhood');
  // EVM addresses are stored lower-cased, as the rest of the app keys them.
  await tools.call('buy_token', { mint: '0x' + 'AB'.repeat(20), amount: 0.1, chain: 'bnb' });
  assert.equal(calls.buys.at(-1).mint, EVM_TOKEN, 'the address is lower-cased on the way in');

  // Reads follow the chain too.
  await tools.call('get_positions', { chain: 'bnb' });
  assert.deepEqual(calls.reads.at(-1).args, [false, 'bnb']);
  await tools.call('get_token', { mint: EVM_TOKEN, chain: 'robinhood' });
  assert.deepEqual(calls.reads.at(-1).args, [EVM_TOKEN, 'robinhood']);
  await tools.call('find_tokens', { list: 'new', chain: 'bnb' });
  assert.deepEqual(calls.reads.at(-1).args, ['new', 20, 'bnb']);

  // The four Solana-only tools take no chain at all, so passing one is an
  // unknown field rather than a silently ignored hint.
  for (const [name, args] of [
    ['place_order', { mint: MINT, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 20, amount: 100, chain: 'bnb' }],
    ['cancel_orders', { mint: MINT, chain: 'bnb' }],
    ['get_chart', { mint: MINT, chain: 'bnb' }],
    ['get_token_links', { mint: MINT, chain: 'bnb' }],
  ]) {
    const r = await tools.call(name, args);
    assert.equal(r.ok, false, `${name} should refuse a chain it cannot honour`);
    assert.match(r.text, /does not take chain/, `${name}: ${r.text}`);
  }
  ok('trades and reads route to all three chains, an address of the wrong shape is refused, and the Solana-only tools refuse a chain outright');
}

// ── the four readers added 2026-09-21 ────────────────────────────────────
{
  setup();
  access = 'read';
  const chart = await tools.call('get_chart', { mint: MINT, interval: '5m', limit: 50 });
  assert.equal(chart.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, [MINT, '5m', 50]);
  assert.match(chart.text, /5m candles, oldest first/);
  await tools.call('get_chart', { mint: MINT });
  assert.deepEqual(calls.reads.at(-1).args, [MINT, '1m', 120], 'the documented defaults are the ones used');
  assert.match((await tools.call('get_chart', { mint: MINT, interval: '3h' })).text, /interval must be one of/);

  const runners = await tools.call('get_runner_alerts', { chain: 'bnb', limit: 5 });
  assert.equal(runners.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, ['bnb', 5]);
  assert.match(runners.text, /most flagged launches still do not graduate/, 'a flag is never reported as a prediction');

  const calls_ = await tools.call('get_callouts', {});
  assert.equal(calls_.ok, true);
  assert.deepEqual(calls.reads.at(-1).args, [20]);
  assert.match(calls_.text, /what THEY report about themselves/, 'pump’s own numbers are labelled as pump’s');

  // "Nobody has looked yet" and "there is nothing there" are different, and
  // each says which — an empty chart is not a flat price.
  setup({ chart: [], tokenLinks: null, callouts: null });
  assert.match((await tools.call('get_chart', { mint: MINT })).text, /may have none/);
  assert.match((await tools.call('get_token_links', { mint: MINT })).text, /Look it up with get_token first/);
  assert.match((await tools.call('get_callouts', {})).text, /not answering right now/);
  ok('the four readers pass their arguments, default as documented, and tell an empty answer apart from an unread one');
}

console.log(`\nmcptools: ${passed}/10 passed`);
