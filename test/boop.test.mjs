// Boop (boop.fun) decoder tests.
//
// Fixtures in test/fixtures/boop.json are REAL mainnet payloads captured
// 2026-08-24 — a buy, a sell, and a curve account — together with the values
// the chain reported for them.
//
// The layout was established by arithmetic on live data, not documentation:
// on a buy, `amountIn + fee` reproduced the instruction's own requested
// amount to the lamport (619144 + 6253 == 625397), and the trader field
// equalled the transaction's fee payer. Pricing the curve from the account
// reproduced GeckoTerminal's quoted price within 5-8% across six pools.

import assert from 'node:assert';
import fs from 'node:fs';
import { decodeLogs, decodeTradeEvent, priceLamportsPerToken, touchesBoop, BOOP_PROGRAM } from './.boop.mjs';
import { parsePoolAccount, poolFor, BOOP_DECIMALS } from './.boopaccounts.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const fx = JSON.parse(fs.readFileSync('test/fixtures/boop.json', 'utf8'));
const payload = (rec) => Buffer.from(rec.line.slice('Program data: '.length), 'base64');

// ── Real transactions ─────────────────────────────────────────────────

for (const side of ['buy', 'sell']) {
  test(`a real ${side.toUpperCase()} decodes to what the chain reported`, () => {
    const ev = decodeTradeEvent(payload(fx[side]));
    const want = fx[side].expect;
    assert.ok(ev, 'the fixture must decode');
    assert.equal(ev.isBuy, want.isBuy);
    assert.equal(ev.mint, want.mint, 'the mint comes from the event — no pool lookup needed');
    assert.equal(String(ev.amountIn), want.amountIn);
    assert.equal(String(ev.amountOut), want.amountOut);
    assert.equal(String(ev.fee), want.fee);
    assert.equal(ev.trader, want.trader, 'Boop names the trader; LaunchLab does not');
  });
}

test('direction comes from the event discriminator, not a flag byte', () => {
  const buy = decodeTradeEvent(payload(fx.buy));
  const sell = decodeTradeEvent(payload(fx.sell));
  assert.notEqual(buy.isBuy, sell.isBuy);
  // Same length, different leading 8 bytes — that IS the direction.
  assert.equal(payload(fx.buy).length, payload(fx.sell).length);
  assert.notEqual(payload(fx.buy).subarray(0, 8).toString('hex'), payload(fx.sell).subarray(0, 8).toString('hex'));
});

test('the buy fee reconciles with the instruction argument', () => {
  // This is the check that proved the field order. amountIn is NET of fee, so
  // amountIn + fee must equal what the trader actually asked to spend.
  const ev = decodeTradeEvent(payload(fx.buy));
  assert.equal(String(ev.amountIn + ev.fee), fx.buy.args[0]);
});

test('the trader is a real wallet, so this rail supports trader scan', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  assert.ok(ev.trader.length >= 32 && ev.trader.length <= 44);
  assert.notEqual(ev.trader, '', 'an empty trader would silently disable copy trading');
});

// ── Log streams ───────────────────────────────────────────────────────

test('decodeLogs picks the trade out of a realistic stream', () => {
  const logs = [
    `Program ${BOOP_PROGRAM} invoke [1]`,
    'Program log: Instruction: BuyToken',
    fx.buy.line,
    `Program ${BOOP_PROGRAM} success`,
  ];
  const evs = decodeLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].isBuy, true);
});

test('foreign Program data lines are skipped, not mis-parsed', () => {
  const logs = [
    'Program data: aGVsbG8=',
    'Program data: ' + Buffer.alloc(128).toString('base64'), // right size, wrong discriminator
    fx.sell.line,
  ];
  const evs = decodeLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].isBuy, false);
});

test('noise decodes to nothing rather than throwing', () => {
  assert.equal(decodeLogs([]).length, 0);
  assert.equal(decodeLogs(['Program data: !!!not base64!!!']).length, 0);
  assert.equal(decodeTradeEvent(Buffer.alloc(0)), null);
  assert.equal(decodeTradeEvent(payload(fx.buy).subarray(0, 100)), null);
  assert.equal(decodeTradeEvent(Buffer.alloc(128)), null, 'right length, zero discriminator');
});

test('touchesBoop recognises the program', () => {
  assert.equal(touchesBoop([`Program ${BOOP_PROGRAM} invoke [1]`]), true);
  assert.equal(touchesBoop(['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]']), false);
});

// ── Price ─────────────────────────────────────────────────────────────

test('buy price includes the fee the trader actually paid', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  const withFee = priceLamportsPerToken(ev, BOOP_DECIMALS);
  const withoutFee = (Number(ev.amountIn) / (Number(ev.amountOut) / 10 ** BOOP_DECIMALS));
  assert.ok(withFee > withoutFee, 'ignoring the fee would quote a price nobody can get');
});

test('price is null rather than Infinity on a zero amount', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  assert.equal(priceLamportsPerToken({ ...ev, amountOut: 0n }, BOOP_DECIMALS), null);
  assert.equal(priceLamportsPerToken({ ...ev, amountIn: 0n, fee: 0n }, BOOP_DECIMALS), null);
});

// ── Curve accounts ────────────────────────────────────────────────────

test('a real curve account parses, and its pool address is derivable', () => {
  const st = parsePoolAccount(fx.pool.address, Buffer.from(fx.pool.data, 'base64'));
  assert.ok(st, 'a real 125-byte curve account must parse');
  assert.equal(st.mint, fx.pool.mint, 'the account agrees with the mint it was derived from');
  assert.equal(poolFor(fx.pool.mint), fx.pool.address, 'derivation means no lookup is ever needed');
  assert.ok(st.progressPct !== null && st.progressPct >= 0 && st.progressPct < 100);
  assert.ok(st.priceLamports !== null && st.priceLamports > 0);
});

test('the graduation target is READ from the pool, never assumed', () => {
  const st = parsePoolAccount(fx.pool.address, Buffer.from(fx.pool.data, 'base64'));
  assert.ok(st.solTarget > 0n, 'the pool carries its own target');
  // A pool that reports no target gets an honest null, not a fabricated 0%.
  const buf = Buffer.from(Buffer.from(fx.pool.data, 'base64'));
  buf.writeBigUInt64LE(0n, 88);
  assert.equal(parsePoolAccount('p', buf).progressPct, null);
});

test('an account of the wrong size is refused rather than misread', () => {
  assert.equal(parsePoolAccount('p', Buffer.alloc(80)), null);
  assert.equal(parsePoolAccount('p', Buffer.alloc(0)), null);
  assert.equal(parsePoolAccount('p', Buffer.from(fx.pool.data, 'base64').subarray(0, 124)), null);
});

test('an empty curve prices as null instead of dividing by zero', () => {
  const buf = Buffer.from(Buffer.from(fx.pool.data, 'base64'));
  buf.writeBigUInt64LE(0n, 112); // tokenReserves = 0
  assert.equal(parsePoolAccount('p', buf).priceLamports, null);
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
  console.log(`boop: ${passed}/${cases.length} tests passed`);
}

await run();
