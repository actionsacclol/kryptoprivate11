// Raydium LaunchLab decoder tests.
//
// The fixtures in test/fixtures/launchlab.json are REAL `Program data:` log
// lines captured from mainnet on 2026-08-24, with the values the chain itself
// reported alongside them. That matters more than usual here: a decoder that
// reads the right bytes from the wrong offsets produces confident numbers
// that are silently wrong, which is exactly how a mis-sliced field turned an
// earlier feature into a no-op.
//
// The layout was verified two ways before being written down:
//   • `amountIn` equalled the trade instruction's own `amount_in` argument in
//     6 of 6 sampled transactions;
//   • the direction byte read 0 on three buys and 1 on three sells.

import assert from 'node:assert';
import fs from 'node:fs';
import { parsePoolAccount, statusLabel } from './.launchlabaccounts.mjs';
import {
  curveProgressPct,
  decodeLogs,
  decodeTradeEvent,
  priceLamportsPerToken,
  touchesLaunchLab,
  LAUNCHLAB_PROGRAM,
} from './.launchlab.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const fx = JSON.parse(fs.readFileSync('test/fixtures/launchlab.json', 'utf8'));
const payload = (rec) => Buffer.from(rec.line.slice('Program data: '.length), 'base64');

// ── Real transactions ─────────────────────────────────────────────────

test('a real BUY decodes to the amounts the chain reported', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  assert.ok(ev, 'the fixture must decode');
  assert.equal(ev.isBuy, true);
  assert.equal(ev.pool, fx.buy.pool, 'pool comes from the event body');
  assert.equal(String(ev.amountIn), fx.buy.expect.amountIn);
  assert.equal(String(ev.amountOut), fx.buy.expect.amountOut);
});

test('a real SELL decodes, and the direction byte flips', () => {
  const ev = decodeTradeEvent(payload(fx.sell));
  assert.ok(ev);
  assert.equal(ev.isBuy, false);
  assert.equal(ev.pool, fx.sell.pool);
  assert.equal(String(ev.amountIn), fx.sell.expect.amountIn);
  assert.equal(String(ev.amountOut), fx.sell.expect.amountOut);
});

test('buy and sell are distinguishable — the two fixtures disagree', () => {
  // Guards against a direction that is hardcoded or read from a constant byte.
  const buy = decodeTradeEvent(payload(fx.buy));
  const sell = decodeTradeEvent(payload(fx.sell));
  assert.notEqual(buy.isBuy, sell.isBuy);
});

test('reserves move in the direction the trade implies', () => {
  const buy = decodeTradeEvent(payload(fx.buy));
  // A buy takes base out of the curve and puts quote in.
  assert.equal(buy.realBaseAfter - buy.realBaseBefore, buy.amountOut, 'base moves by amountOut');
  assert.ok(buy.realQuoteAfter > buy.realQuoteBefore, 'quote goes up on a buy');
});

test('the curve config is read from the event, never assumed', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  assert.ok(ev.totalBaseSell > 0n);
  assert.ok(ev.virtualBase > 0n);
  assert.ok(ev.virtualQuote > 0n);
});

// ── Decoding from a log stream ────────────────────────────────────────

test('decodeLogs finds the trade in a realistic log stream', () => {
  const logs = [
    `Program ${LAUNCHLAB_PROGRAM} invoke [2]`,
    'Program log: Instruction: BuyExactIn',
    fx.buy.line,
    `Program ${LAUNCHLAB_PROGRAM} success`,
  ];
  const evs = decodeLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].isBuy, true);
});

test('foreign Program data lines are skipped, not mis-parsed', () => {
  // Other programs write `Program data:` too. Decoding one of those into a
  // trade would inject a fabricated trade into the tape.
  const logs = [
    'Program data: aGVsbG8gd29ybGQ=',
    'Program data: ' + Buffer.alloc(147).toString('base64'), // right length, wrong discriminator
    fx.sell.line,
  ];
  const evs = decodeLogs(logs);
  assert.equal(evs.length, 1, 'only the real event survives');
  assert.equal(evs[0].isBuy, false);
});

test('an empty or noisy log stream yields nothing rather than throwing', () => {
  assert.equal(decodeLogs([]).length, 0);
  assert.equal(decodeLogs(['Program log: Instruction: BuyExactIn', 'not base64 at all']).length, 0);
  assert.equal(decodeLogs(['Program data: !!!!not-base64!!!!']).length, 0);
});

test('touchesLaunchLab identifies the program in a log stream', () => {
  assert.equal(touchesLaunchLab([`Program ${LAUNCHLAB_PROGRAM} invoke [1]`]), true);
  assert.equal(touchesLaunchLab(['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]']), false);
});

// ── Malformed input ───────────────────────────────────────────────────

test('a truncated payload is refused', () => {
  assert.equal(decodeTradeEvent(payload(fx.buy).subarray(0, 100)), null);
  assert.equal(decodeTradeEvent(Buffer.alloc(0)), null);
  assert.equal(decodeTradeEvent(Buffer.alloc(147)), null, 'right length, zero discriminator');
});

test('the emit_cpi form decodes to the same event as the log form', () => {
  // The inner-instruction copy is the log payload with Anchor's event-CPI
  // marker in front. Both must land on the same numbers.
  const log = payload(fx.buy);
  const cpi = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), log]);
  const a = decodeTradeEvent(log);
  const b = decodeTradeEvent(cpi);
  assert.ok(b);
  assert.equal(b.pool, a.pool);
  assert.equal(String(b.amountIn), String(a.amountIn));
  assert.equal(b.isBuy, a.isBuy);
});

// ── Derived numbers ───────────────────────────────────────────────────

test('curve progress is a percentage of the pool OWN total, or null', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  const pct = curveProgressPct(ev);
  assert.ok(pct !== null && pct >= 0 && pct <= 100, `got ${pct}`);
  // A pool reporting no total gets an honest null, never a fabricated 0%.
  assert.equal(curveProgressPct({ ...ev, totalBaseSell: 0n }), null);
});

test('price is computed from what was exchanged, both directions', () => {
  const buy = decodeTradeEvent(payload(fx.buy));
  const sell = decodeTradeEvent(payload(fx.sell));
  const pb = priceLamportsPerToken(buy, 6);
  const ps = priceLamportsPerToken(sell, 6);
  assert.ok(pb !== null && pb > 0, `buy price ${pb}`);
  assert.ok(ps !== null && ps > 0, `sell price ${ps}`);
});

test('price is null rather than Infinity when an amount is zero', () => {
  const ev = decodeTradeEvent(payload(fx.buy));
  assert.equal(priceLamportsPerToken({ ...ev, amountOut: 0n }, 6), null);
  assert.equal(priceLamportsPerToken({ ...ev, amountIn: 0n }, 6), null);
});

// ── Pool state accounts ───────────────────────────────────────────────
//
// The offsets were not read from documentation. A live trade event was
// decoded first, then the pool account was searched for the exact u64 values
// that event reported. These fixtures are real accounts captured the same
// day, covering the three shapes that behave differently.

const poolBuf = (key) => Buffer.from(fx.pools[key].data, 'base64');

test('an ACTIVE pool parses with progress between 0 and 100', () => {
  const st = parsePoolAccount(fx.pools.active.pool, poolBuf('active'));
  assert.ok(st, 'a real pool account must parse');
  assert.equal(st.isMigrated, false);
  assert.equal(st.isSolQuoted, true);
  assert.ok(st.progressPct > 0 && st.progressPct < 100, `progress ${st.progressPct}`);
  assert.ok(st.totalBaseSell > 0n && st.realBase <= st.totalBaseSell);
  assert.equal(st.baseMint.length >= 32, true);
});

test('a MIGRATED pool is flagged from its status byte, not from 100%', () => {
  // A pool can sit at the threshold before it actually moves, so migration is
  // read from the status byte — which correlated perfectly with progress
  // across 10 sampled pools (status 2 on every finished one).
  const st = parsePoolAccount(fx.pools.migrated.pool, poolBuf('migrated'));
  assert.ok(st);
  assert.equal(st.isMigrated, true);
  assert.equal(st.status, 2);
});

test('a USDC/USDT-quoted pool is marked NOT SOL-quoted', () => {
  // 3 of 10 sampled pools quoted in a stablecoin. Their reserves are not
  // lamports, and showing them as SOL would be wrong by orders of magnitude.
  const st = parsePoolAccount(fx.pools.nonSol.pool, poolBuf('nonSol'));
  assert.ok(st);
  assert.equal(st.isSolQuoted, false);
  assert.notEqual(st.quoteMint, 'So11111111111111111111111111111111111111112');
  assert.equal(st.quoteDecimals, 6, 'a stablecoin quote has 6 decimals, SOL has 9');
});

test('the quote decimals distinguish SOL from a stablecoin pool', () => {
  assert.equal(parsePoolAccount('p', poolBuf('active')).quoteDecimals, 9);
  assert.equal(parsePoolAccount('p', poolBuf('nonSol')).quoteDecimals, 6);
});

test('an account of the wrong size is refused rather than misread', () => {
  // A different length means a different layout. Parsing it anyway would
  // produce confident numbers from the wrong offsets.
  assert.equal(parsePoolAccount('p', Buffer.alloc(200)), null);
  assert.equal(parsePoolAccount('p', Buffer.alloc(0)), null);
  assert.equal(parsePoolAccount('p', poolBuf('active').subarray(0, 428)), null);
});

test('a pool reporting no target yields null progress, not a fake zero', () => {
  const buf = Buffer.from(poolBuf('active'));
  buf.writeBigUInt64LE(0n, 29); // totalBaseSell = 0
  const st = parsePoolAccount('p', buf);
  assert.ok(st);
  assert.equal(st.progressPct, null);
});

test('an unknown status says so instead of guessing', () => {
  assert.match(statusLabel(0), /curve/i);
  assert.match(statusLabel(2), /migrated/i);
  assert.match(statusLabel(7), /unknown/i);
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
  console.log(`launchlab: ${passed}/${cases.length} tests passed`);
}

await run();
