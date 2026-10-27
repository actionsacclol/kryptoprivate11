// Fixture tests for the Pump.fun Anchor event decoder. Layouts are pinned
// by constructing byte-exact synthetic events (discriminator = the Anchor
// spec sha256) and asserting the decoder reads them back — plus tolerance
// checks for the "newer layout appends fields" case.

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeEventData, decodeLogs } from './.decoder.mjs';

function disc(name) {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

const PK_A = Buffer.alloc(32, 1);
const PK_B = Buffer.alloc(32, 2);
const PK_C = Buffer.alloc(32, 3);
const PK_D = Buffer.alloc(32, 4);

// ── CreateEvent: classic layout (name, symbol, uri, mint, curve, user) ──
{
  const payload = Buffer.concat([
    disc('CreateEvent'),
    str('Test Token'), str('TEST'), str('https://example.com/meta.json'),
    PK_A, PK_B, PK_C,
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.kind, 'create');
  assert.equal(ev.name, 'Test Token');
  assert.equal(ev.symbol, 'TEST');
  assert.equal(ev.creator, ev.user, 'classic layout: creator falls back to user');
  assert.equal(ev.virtualSolReserves, null);
  console.log('ok  create (classic layout)');
}

// ── CreateEvent: extended layout (creator + timestamp + reserves) ──
{
  const payload = Buffer.concat([
    disc('CreateEvent'),
    str('T2'), str('T2'), str('u'),
    PK_A, PK_B, PK_C,
    PK_D,                       // creator
    u64(1721234567),            // timestamp (i64, positive)
    u64(1073000000000000n),     // virtualTokenReserves
    u64(30000000000n),          // virtualSolReserves
    u64(0), u64(0),             // trailing fields the decoder must tolerate
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.kind, 'create');
  assert.notEqual(ev.creator, ev.user, 'extended layout: creator is its own field');
  assert.equal(ev.virtualSolReserves, 30000000000n);
  assert.equal(ev.isMayhem, null, 'a layout that stops before is_mayhem_mode is unknown, not standard');
  console.log('ok  create (extended layout)');
}

// ── CreateEvent: is_mayhem_mode, off two REAL mainnet creates (2026-09-24) ──
// Both curves started at exactly 30 virtual SOL, so the reserves-based guess
// this replaced called every coin standard — the runner flag's `mayhem` and
// the Execution page's mayhem filter never matched once. The byte after
// token_program is the flag; the curve's byte 81 agreed on both coins.
{
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/create-mayhem.json', import.meta.url), 'utf8'));
  const may = decodeEventData(fx.mayhem.eventB64);
  const std = decodeEventData(fx.standard.eventB64);
  assert.equal(may.mint, fx.mayhem.mint);
  assert.equal(std.mint, fx.standard.mint);
  assert.equal(may.virtualSolReserves, std.virtualSolReserves, 'the reserves cannot tell them apart');
  assert.equal(may.isMayhem, true, 'CHIPS is a mayhem coin');
  assert.equal(std.isMayhem, false, 'FanFee is standard');

  // A byte that is neither 0 nor 1 is not trusted either way.
  // On the wire (09-24): 83 bytes follow token_total_supply — token_program
  // (32), then is_mayhem_mode (1), then fields the decoder does not read.
  const bad = Buffer.from(fx.standard.eventB64, 'base64');
  const at = bad.length - 83 + 32;
  assert.equal(bad[at], 0, 'the offset lands on the flag');
  bad[at] = 7;
  assert.equal(decodeEventData(bad.toString('base64')).isMayhem, null);

  // The engine reads the flag, never the reserves.
  const eng = readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(!/mayhemFromReserves/.test(eng), 'the reserves-based guess is gone');
  assert.ok(/const isMayhem = ev\.isMayhem;/.test(eng) && /mayhem: t\.createEvent\.isMayhem,/.test(eng), 'filter and runner flag both use the decoded byte');
  console.log('ok  create: is_mayhem_mode decoded from real mayhem + standard creates');
}

// ── TradeEvent ──
{
  const payload = Buffer.concat([
    disc('TradeEvent'),
    PK_A,                       // mint
    u64(500000000n),            // solAmount (0.5 SOL)
    u64(15000000000000n),       // tokenAmount
    Buffer.from([1]),           // isBuy
    PK_B,                       // user
    u64(1721234567),            // timestamp
    u64(30500000000n),          // virtualSolReserves
    u64(1058000000000000n),     // virtualTokenReserves
    u64(1), u64(2),             // trailing (real reserves) — tolerated
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.kind, 'trade');
  assert.equal(ev.isBuy, true);
  assert.equal(ev.solAmount, 500000000n);
  assert.equal(ev.virtualSolReserves, 30500000000n);
  console.log('ok  trade');
}

// ── Robustness: garbage, unknown discriminator, truncated body ──
{
  assert.equal(decodeEventData('!!!not base64!!!'), null);
  assert.equal(decodeEventData(Buffer.alloc(4).toString('base64')), null);
  assert.equal(decodeEventData(Buffer.concat([disc('SomethingElse'), PK_A]).toString('base64')), null);
  const truncated = Buffer.concat([disc('TradeEvent'), PK_A, u64(1)]); // far too short
  assert.equal(decodeEventData(truncated.toString('base64')), null, 'truncated event decodes to null, not a crash');
  console.log('ok  robustness');
}

// ── decodeLogs extracts only Program data lines ──
{
  const payload = Buffer.concat([
    disc('CompleteEvent'), PK_A, PK_B, PK_C, u64(1721234567),
  ]);
  const events = decodeLogs([
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
    'Program log: Instruction: Buy',
    `Program data: ${payload.toString('base64')}`,
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'complete');
  console.log('ok  decodeLogs');
}

// ── Real mainnet fixtures (harvested by test/harvest.fixtures.mjs) ──
// These pin the decoder against actual chain data. If Pump's event layout
// drifts, THIS is the test that goes red after a re-harvest.
{
  const { readFileSync, existsSync } = await import('node:fs');
  const path = new URL('./fixtures/live-logs.json', import.meta.url);
  if (existsSync(path)) {
    const { fixtures } = JSON.parse(readFileSync(path, 'utf8'));
    let events = 0;
    for (const fx of fixtures) {
      const decoded = decodeLogs(fx.logs);
      assert.ok(decoded.length > 0, `fixture ${fx.signature.slice(0, 12)}… must decode`);
      for (const kind of fx.expectKinds) {
        assert.ok(decoded.some((e) => e.kind === kind), `fixture ${fx.signature.slice(0, 12)}… missing ${kind}`);
      }
      for (const e of decoded) {
        if (e.kind === 'create') {
          assert.ok(e.mint.length >= 32 && e.symbol.length > 0);
        }
        if (e.kind === 'trade') {
          assert.equal(typeof e.solAmount, 'bigint');
          assert.ok(e.virtualSolReserves > 0n && e.virtualTokenReserves > 0n, 'reserves must be positive');
        }
      }
      events += decoded.length;
    }
    console.log(`ok  ${fixtures.length} real mainnet fixtures (${events} events)`);
  } else {
    console.log('..  no live fixtures yet (run test/harvest.fixtures.mjs)');
  }
}

// ── emit_cpi inner instruction, real block fixture (2026-08-30) ──
// The block feed hands the decoder the raw inner-instruction data:
// [8-byte Anchor CPI wrapper][8-byte event disc][body]. Same body as the
// log payload, so the two must agree field for field.
{
  const { decodeCpiEventData, decodeCpiEventDataEx, logsMentionPumpTrade, CPI_EVENT_WRAPPER } = await import('./.decoder.mjs');
  const { base58Decode } = await import('./.b58.mjs');
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/block-cpi.json', import.meta.url), 'utf8')).pump.tx;
  assert.equal(CPI_EVENT_WRAPPER.toString('hex'), 'e445a52e51cb9a1d');
  const inner = fx.meta.innerInstructions.flatMap((g) => g.instructions).map((ix) => Buffer.from(base58Decode(ix.data)));
  const wrapped = inner.filter((d) => d.length >= 16 && d.subarray(0, 8).equals(CPI_EVENT_WRAPPER));
  assert.equal(wrapped.length, 1, 'the fixture carries one emit_cpi event');
  const ev = decodeCpiEventData(wrapped[0]);
  assert.ok(ev && ev.kind === 'trade', 'inner ix decodes to a trade');
  const fromLog = decodeLogs(fx.meta.logMessages).find((e) => e.kind === 'trade');
  assert.ok(fromLog, 'the same tx still logs the trade today (double emit)');
  for (const k of ['mint', 'solAmount', 'tokenAmount', 'isBuy', 'user', 'timestamp', 'virtualSolReserves', 'virtualTokenReserves', 'creator']) {
    assert.deepEqual(ev[k], fromLog[k], `cpi.${k} equals log.${k}`);
  }
  // Non-wrapper inner instructions (token transfers, the real Buy ix) are
  // null without being a layout error; a wrapper with a broken body IS one.
  for (const d of inner.filter((d) => !wrapped.includes(d))) {
    const r = decodeCpiEventDataEx(d);
    assert.equal(r.event, null);
    assert.equal(r.layoutError, false);
  }
  const broken = Buffer.concat([wrapped[0].subarray(0, 16), Buffer.alloc(10)]);
  assert.equal(decodeCpiEventDataEx(broken).layoutError, true, 'truncated TradeEvent body is drift');
  assert.equal(decodeCpiEventData(Buffer.alloc(8)), null);
  // Watchdog helper: the instruction line, exact match only.
  assert.equal(logsMentionPumpTrade(fx.meta.logMessages), true);
  assert.equal(logsMentionPumpTrade(['Program log: Instruction: Create']), false);
  assert.equal(logsMentionPumpTrade(['Program log: Instruction: Sell']), true);
  assert.equal(logsMentionPumpTrade([]), false);
  console.log('ok  emit_cpi inner ix decodes to the same TradeEvent as the log (real fixture)');
}

console.log('decoder tests passed');

// ── TradeEvent on a QUOTE-paired curve, real mainnet fixture (2026-10-26) ──
// pump.fun launches coins against tokenized stocks since 2026-10. On such a
// curve the program writes ZERO into every SOL field and keeps the money in
// `quote_*` fields, in the quote token's raw units. Read as SOL, that priced
// a $15k coin at a few dollars and fought Birdeye for the chart bar (user
// report). The fixture is a real buy on 5skM7cwc…pump, quoted in RDDT
// (Backpack's tokenized Reddit stock, 6 decimals).
{
  const { readFileSync } = await import('node:fs');
  const { base58Decode } = await import('./.b58.mjs');
  const { decodeCpiEventData, CPI_EVENT_WRAPPER } = await import('./.decoder.mjs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/trade-quote-rddt.json', import.meta.url), 'utf8'));
  const raw = Buffer.from(fx.eventHex, 'hex');
  assert.equal(raw.length, 405);
  const ev = decodeEventData(raw.toString('base64'));
  assert.equal(ev.kind, 'trade');
  assert.equal(ev.mint, fx.mint);
  assert.equal(ev.isBuy, fx.expect.isBuy);
  assert.equal(ev.solAmount, BigInt(fx.expect.solAmount), 'the SOL amount is zero on the wire');
  assert.equal(ev.virtualSolReserves, BigInt(fx.expect.virtualSolReserves), 'the SOL reserve is zero on the wire');
  assert.equal(ev.virtualTokenReserves, BigInt(fx.expect.virtualTokenReserves));
  assert.equal(ev.quoteMint, fx.quoteMint, 'the quote mint is read');
  assert.equal(ev.quoteAmount, BigInt(fx.expect.quoteAmount));
  assert.equal(ev.virtualQuoteReserves, BigInt(fx.expect.virtualQuoteReserves));
  assert.equal(ev.realQuoteReserves, BigInt(fx.expect.realQuoteReserves));

  // The same body through the emit_cpi path decodes identically.
  const cpi = decodeCpiEventData(Buffer.concat([CPI_EVENT_WRAPPER, raw]));
  assert.deepEqual(cpi, ev, 'cpi path = log path');

  // A SOL curve's event carries the same tail with an all-zero quote mint
  // (and pump could write WSOL there one day): both read as "SOL", null.
  const at = raw.indexOf(Buffer.from(base58Decode(fx.quoteMint)));
  assert.ok(at > 0, 'the quote mint bytes are in the fixture');
  const zeroed = Buffer.from(raw);
  zeroed.fill(0, at, at + 32);
  const z = decodeEventData(zeroed.toString('base64'));
  assert.equal(z.quoteMint, null, 'all-zero quote_mint = SOL');
  assert.equal(z.quoteAmount, 140025n, 'the quote figures are still read (they mirror SOL on a SOL curve)');
  const wsol = Buffer.from(raw);
  Buffer.from(base58Decode('So11111111111111111111111111111111111111112')).copy(wsol, at);
  assert.equal(decodeEventData(wsol.toString('base64')).quoteMint, null, 'WSOL quote_mint = SOL');
  console.log('ok  trade on a quote-paired curve (real RDDT fixture)');
}

// ── A trade with an older, shorter tail is a SOL trade with no quote figures ──
{
  const payload = Buffer.concat([
    disc('TradeEvent'), PK_A, u64(500000000n), u64(15000000000000n), Buffer.from([1]), PK_B,
    u64(1721234567), u64(30500000000n), u64(1058000000000000n), u64(1), u64(2),
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.quoteMint, null);
  assert.equal(ev.quoteAmount, null);
  assert.equal(ev.virtualQuoteReserves, null);
  assert.equal(ev.realQuoteReserves, null);
  console.log('ok  trade with a short tail: SOL, no quote figures, no guess');
}

// ── CreateEvent: quote_mint + virtual_quote_reserves off the real creates ──
// 50 bytes follow is_mayhem_mode on the wire: is_cashback_enabled (1),
// quote_mint (32), virtual_quote_reserves (8), creator_fee_bps (8),
// is_holder_reward (1). Both real creates are SOL curves: a zero quote mint
// and a quote reserve that mirrors the SOL one.
{
  const { readFileSync } = await import('node:fs');
  const { base58Decode } = await import('./.b58.mjs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/create-mayhem.json', import.meta.url), 'utf8'));
  for (const k of ['mayhem', 'standard']) {
    const ev = decodeEventData(fx[k].eventB64);
    assert.equal(ev.quoteMint, null, `${k}: a SOL curve`);
    assert.equal(ev.virtualQuoteReserves, ev.virtualSolReserves, `${k}: the quote reserve mirrors the SOL one`);
  }
  // RDDT written into the standard create's quote_mint slot: a quote launch.
  const raw = Buffer.from(fx.standard.eventB64, 'base64');
  const at = raw.length - 83 + 32 + 1 + 1;
  const RDDT = 'RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh';
  Buffer.from(base58Decode(RDDT)).copy(raw, at);
  raw.writeBigUInt64LE(45130918n, at + 32);
  const q = decodeEventData(raw.toString('base64'));
  assert.equal(q.quoteMint, RDDT);
  assert.equal(q.virtualQuoteReserves, 45130918n);
  assert.equal(q.isMayhem, false, 'the flag before it still reads');
  // The engine: such a launch is not scanned, and every trade is converted
  // before anything SOL-shaped reads it (quoteCurve.ts).
  const eng = readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(/if \(ev\.quoteMint !== null\) \{\s*this\.counters\.seen\+\+;/.test(eng), 'onCreate skips a quote-paired launch');
  assert.ok(/tradeInSol\(ev, quoteRates\.solPerUnit\)/.test(eng), 'trades go through the quote conversion');
  assert.ok(/curveVSolLamports\(st, quoteRates\.solPerUnit\)/.test(eng), 'the curve-account tick converts too');
  assert.ok(/quoteSwapView\(event, 6, rate\)/.test(eng) && /if \(rate === null\) continue;/.test(eng), 'PumpSwap swaps on a quoted pool convert, or tick nothing');
  assert.ok(/this\.onComplete\(ev\.mint, ev\.quoteMint\)/.test(eng), 'a completion maps the pool derived with the quote');
  console.log('ok  create: quote_mint + virtual_quote_reserves (real SOL creates, synthetic RDDT create)');
}
