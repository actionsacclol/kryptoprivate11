// Trading from a paired chat. These are the rules that stand between a
// stolen Telegram session and someone's wallet, so they are tested harder
// than the feature they enable.
import assert from 'node:assert';
import {
  CONFIRM_TTL_MS,
  DEFAULT_BOT_TRADE_POLICY,
  MAX_TRADES_PER_MINUTE,
  checkConfirm,
  checkTradeAllowed,
  describeIntent,
  makeConfirmCode,
  parseTradeCommand,
} from './.bottrading.mjs';

const MINT = 'So11111111111111111111111111111111111111112';
const now = 1_700_000_000_000;
const ON = { ...DEFAULT_BOT_TRADE_POLICY, enabled: true, allowBuys: true };

{
  // Defaults must be the safe ones: a fresh install trades nothing from chat.
  assert.equal(DEFAULT_BOT_TRADE_POLICY.enabled, false, 'chat trading is off by default');
  assert.equal(DEFAULT_BOT_TRADE_POLICY.allowBuys, false, 'and buying is off even when it is on');
  assert.equal(DEFAULT_BOT_TRADE_POLICY.requireConfirm, true, 'and confirmation is required');
  console.log('ok  the defaults spend nothing');
}

{
  assert.deepEqual(parseTradeCommand(`/buy ${MINT} 0.05`).intent, { kind: 'buy', mint: MINT, amount: 0.05 });
  assert.deepEqual(parseTradeCommand(`/sell ${MINT} 50`).intent, { kind: 'sell', mint: MINT, amount: 50 });
  assert.deepEqual(parseTradeCommand(`/sell ${MINT}`).intent, { kind: 'sell', mint: MINT, amount: 100 }, 'a bare sell is the whole bag');
  assert.equal(parseTradeCommand('/status'), null, 'other commands are not trades');
  assert.equal(parseTradeCommand('hello'), null);
  // Malformed spending commands explain themselves rather than doing something.
  assert.match(parseTradeCommand('/buy').error, /Usage/);
  assert.match(parseTradeCommand('/buy notamint 1').error, /Usage/);
  assert.match(parseTradeCommand(`/buy ${MINT}`).error, /How much/);
  assert.match(parseTradeCommand(`/buy ${MINT} -1`).error, /How much/);
  assert.match(parseTradeCommand(`/buy ${MINT} abc`).error, /How much/);
  assert.match(parseTradeCommand(`/sell ${MINT} 0`).error, /between 1 and 100/);
  assert.match(parseTradeCommand(`/sell ${MINT} 101`).error, /between 1 and 100/);
  console.log('ok  commands parse, and a malformed one never becomes a trade');
}

{
  // The master switch, then the buy switch.
  const off = checkTradeAllowed({ kind: 'sell', mint: MINT, amount: 100 }, DEFAULT_BOT_TRADE_POLICY, [], now);
  assert.equal(off.ok, false);
  assert.match(off.reason, /off/);
  const sellsOnly = { ...DEFAULT_BOT_TRADE_POLICY, enabled: true };
  assert.equal(checkTradeAllowed({ kind: 'sell', mint: MINT, amount: 100 }, sellsOnly, [], now).ok, true, 'selling is the point');
  const buyBlocked = checkTradeAllowed({ kind: 'buy', mint: MINT, amount: 0.01 }, sellsOnly, [], now);
  assert.equal(buyBlocked.ok, false, 'buying needs its own switch');
  assert.match(buyBlocked.reason, /only selling/);
  console.log('ok  selling and buying are gated separately');
}

{
  // Per-trade and hourly caps on buys.
  assert.equal(checkTradeAllowed({ kind: 'buy', mint: MINT, amount: 0.1 }, ON, [], now).ok, true);
  const tooBig = checkTradeAllowed({ kind: 'buy', mint: MINT, amount: 0.11 }, ON, [], now);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason, /per-trade limit/);

  const spent = [
    { at: now - 10 * 60_000, kind: 'buy', sol: 0.3 },
    { at: now - 20 * 60_000, kind: 'buy', sol: 0.15 },
  ];
  const overHour = checkTradeAllowed({ kind: 'buy', mint: MINT, amount: 0.1 }, ON, spent, now);
  assert.equal(overHour.ok, false, '0.45 spent + 0.1 passes the 0.5 hourly cap');
  assert.match(overHour.reason, /hourly limit/);
  assert.match(overHour.reason, /0\.050 SOL left/, 'and says how much is left');

  // An old buy has aged out of the window.
  const old = [{ at: now - 61 * 60_000, kind: 'buy', sol: 0.5 }];
  assert.equal(checkTradeAllowed({ kind: 'buy', mint: MINT, amount: 0.1 }, ON, old, now).ok, true);
  // Sells are never blocked by the SOL caps — an exit must not be rationed.
  assert.equal(checkTradeAllowed({ kind: 'sell', mint: MINT, amount: 100 }, ON, spent, now).ok, true);
  console.log('ok  buys are capped per trade and per hour; exits are not rationed');
}

{
  // Flood control applies to both sides.
  const burst = Array.from({ length: MAX_TRADES_PER_MINUTE }, (_, i) => ({ at: now - i * 1000, kind: 'sell', sol: 0 }));
  const flooded = checkTradeAllowed({ kind: 'sell', mint: MINT, amount: 100 }, ON, burst, now);
  assert.equal(flooded.ok, false);
  assert.match(flooded.reason, /Too many trades/);
  const aged = burst.map((b) => ({ ...b, at: b.at - 61_000 }));
  assert.equal(checkTradeAllowed({ kind: 'sell', mint: MINT, amount: 100 }, ON, aged, now).ok, true);
  console.log('ok  a flood of commands is stopped');
}

{
  const pending = { code: '4242', intent: { kind: 'buy', mint: MINT, amount: 0.05 }, createdAt: now };
  assert.equal(checkConfirm('/yes 4242', pending, now).ok, true);
  assert.equal(checkConfirm('/confirm 4242', pending, now).ok, true, 'either word works');
  assert.equal(checkConfirm('/yes 9999', pending, now).ok, false, 'a wrong code does not trade');
  assert.match(checkConfirm('/yes 9999', pending, now).reason, /Wrong code/);
  assert.equal(checkConfirm('/yes 4242', pending, now + CONFIRM_TTL_MS + 1).ok, false, 'and it expires');
  assert.match(checkConfirm('/yes 4242', pending, now + CONFIRM_TTL_MS + 1).reason, /expired/);
  assert.equal(checkConfirm('/yes 4242', null, now).ok, false, 'nothing pending, nothing happens');
  assert.equal(checkConfirm('/status', pending, now).ok, false, 'an unrelated message is not a confirmation');
  // Codes are four digits, always, so they are readable on a phone.
  for (const seed of [0, 7, 12345, 99999, -3]) assert.match(makeConfirmCode(seed), /^\d{4}$/);
  console.log('ok  a trade needs the right code, in time, once');
}

{
  assert.equal(describeIntent({ kind: 'buy', mint: MINT, amount: 0.05 }, 'BONK'), 'BUY 0.05 SOL of BONK');
  assert.equal(describeIntent({ kind: 'sell', mint: MINT, amount: 50 }, ''), `SELL 50% of ${MINT.slice(0, 6)}…`);
  console.log('ok  the confirmation says exactly what will happen');
}
console.log('bottrading: all tests passed');
