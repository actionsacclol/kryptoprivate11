// Meteora DBC decoder, pinned against REAL mainnet events.
//
// The fixtures in test/fixtures/dbc-events.json were harvested from mainnet
// on 2026-08-24 (see the harvest note below). Layouts were derived from the
// program's own on-chain Anchor IDL, so these tests are checking two
// independent things at once: that the IDL-derived offsets are right, and
// that they still match what the deployed program emits.
//
// If Meteora redeploys with a changed layout these fail loudly, which is the
// point — the alternative is a decoder that confidently reports nonsense
// prices into a trading UI.
//
// To re-harvest: getSignaturesForAddress on the DBC program, getTransaction
// for each, and collect inner instructions whose data starts with Anchor's
// event-CPI marker e445a52e51cb9a1d.

import assert from 'node:assert';
import fs from 'node:fs';
import * as dbc from './.dbcdecoder.mjs';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/dbc-events.json', import.meta.url), 'utf8'));

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Fixtures are present and complete ─────────────────────────────────

test('fixtures cover the events the terminal depends on', () => {
  for (const name of ['EvtSwap', 'EvtInitializePool', 'EvtCurveComplete']) {
    assert.ok(Array.isArray(fixtures[name]) && fixtures[name].length > 0, `missing fixtures for ${name}`);
  }
});

// ── Swap ──────────────────────────────────────────────────────────────

test('every EvtSwap fixture decodes with sane fields', () => {
  for (const f of fixtures.EvtSwap) {
    const { event, layoutError } = dbc.decodeDbcEventEx(bytes(f.data));
    assert.equal(layoutError, false, `layout drift on ${f.sig}`);
    assert.ok(event, `no event decoded from ${f.sig}`);
    assert.equal(event.kind, 'dbc_swap');
    assert.match(event.pool, MINT_RE, 'pool must be a valid base58 pubkey');
    assert.match(event.config, MINT_RE);
    assert.equal(typeof event.isBuy, 'boolean');
    assert.ok(event.amountIn > 0n, 'a swap must move something in');
    assert.ok(event.outputAmount > 0n, 'a swap must move something out');
    // Recorded on 2026-08-24; anything outside a wide sanity window means the
    // timestamp offset is wrong.
    const secs = Number(event.timestamp);
    assert.ok(secs > 1_700_000_000 && secs < 2_200_000_000, `implausible timestamp ${secs}`);
  }
});

test('executed price is a plausible memecoin price, not the inverse', () => {
  // The direction flag decides which side of the ratio is SOL. Getting it
  // backwards yields prices around 1-20 SOL per token, which no fresh
  // launch has — that is the failure this catches.
  for (const f of fixtures.EvtSwap) {
    const e = dbc.decodeDbcEvent(bytes(f.data));
    const price = dbc.executedPriceSol(e);
    assert.ok(price > 0, 'price must be positive');
    assert.ok(price < 0.01, `price ${price} SOL/token implies the direction flag is inverted`);
  }
});

test('swapSol and swapTokens pick the correct legs', () => {
  for (const f of fixtures.EvtSwap) {
    const e = dbc.decodeDbcEvent(bytes(f.data));
    const sol = dbc.swapSol(e);
    const tokens = dbc.swapTokens(e);
    assert.ok(sol > 0 && sol < 10_000, `implausible SOL amount ${sol}`);
    assert.ok(tokens > 0, 'token amount must be positive');
    // price === sol / tokens, by construction — this catches a leg swap.
    const price = dbc.executedPriceSol(e);
    assert.ok(Math.abs(price - sol / tokens) < 1e-18, 'price must equal sol/tokens');
  }
});

test('the v1 swap event reports curve progress as unknown, not as a guess', () => {
  for (const f of fixtures.EvtSwap) {
    const e = dbc.decodeDbcEvent(bytes(f.data));
    assert.equal(e.quoteReserve, null);
    assert.equal(e.migrationThreshold, null);
    assert.equal(dbc.curveProgressPct(e), null, 'v1 carries no threshold — null beats an estimate');
  }
});

// ── Initialize pool ───────────────────────────────────────────────────

test('every EvtInitializePool fixture decodes to real pubkeys', () => {
  for (const f of fixtures.EvtInitializePool) {
    const { event, layoutError } = dbc.decodeDbcEventEx(bytes(f.data));
    assert.equal(layoutError, false);
    assert.equal(event.kind, 'dbc_init_pool');
    for (const k of ['pool', 'config', 'creator', 'baseMint']) {
      assert.match(event[k], MINT_RE, `${k} is not a valid pubkey`);
    }
    assert.ok(event.baseMint !== event.pool, 'mint and pool must differ');
    assert.ok(event.activationPoint > 0n);
  }
});

// ── Curve complete ────────────────────────────────────────────────────

test('EvtCurveComplete reports the graduation reserves', () => {
  for (const f of fixtures.EvtCurveComplete) {
    const { event, layoutError } = dbc.decodeDbcEventEx(bytes(f.data));
    assert.equal(layoutError, false);
    assert.equal(event.kind, 'dbc_curve_complete');
    assert.match(event.pool, MINT_RE);
    assert.ok(event.baseReserve > 0n);
    // DBC's migration threshold is PER-CONFIG, not a protocol constant: of
    // the harvested fixtures, two graduate at exactly 12.000 SOL and one at
    // 0.000499. That is why EvtSwap2 carries `migrationThreshold` in the
    // event rather than leaving callers to assume one. So the assertion here
    // is only that the field is a sane u64 — a wrong offset yields values
    // around 1e19, which this catches, while a legitimate config change does
    // not fail the build.
    const sol = Number(event.quoteReserve) / 1e9;
    assert.ok(sol > 0, 'a completed curve must hold some quote');
    assert.ok(sol < 1_000_000, `quote reserve of ${sol} SOL implies a bad offset`);
    assert.ok(Number(event.baseReserve) < 1e18, 'base reserve implies a bad offset');
  }
});

test('base decimals are a caller input, not an assumption', () => {
  // The harvested pools are not all 6-decimal: one fixture only makes sense
  // at 9. `executedPriceSol` therefore takes decimals rather than hardcoding
  // them, and the engine passes the mint's real value.
  const e = dbc.decodeDbcEvent(bytes(fixtures.EvtSwap[0].data));
  const at6 = dbc.executedPriceSol(e, 6);
  const at9 = dbc.executedPriceSol(e, 9);
  assert.ok(Math.abs(at9 - at6 * 1000) < at6, 'decimals must scale the price by 10^diff');
});

// ── Rejection paths ───────────────────────────────────────────────────

test('non-event-CPI instruction data is ignored, not flagged as drift', () => {
  // A real nested instruction (a token transfer, say) must not look like
  // decoder drift or the breaker would trip constantly.
  const r = dbc.decodeDbcEventEx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]));
  assert.equal(r.event, null);
  assert.equal(r.layoutError, false);
});

test('short payloads are ignored safely', () => {
  for (const n of [0, 1, 8, 15]) {
    const r = dbc.decodeDbcEventEx(new Uint8Array(n));
    assert.equal(r.event, null);
    assert.equal(r.layoutError, false);
  }
});

test('an unmodelled DBC event is ignored, not flagged as drift', () => {
  // Anchor event-CPI marker + a discriminator we do not model (a fee claim).
  const buf = Buffer.concat([
    Buffer.from('e445a52e51cb9a1d', 'hex'),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    Buffer.alloc(64),
  ]);
  const r = dbc.decodeDbcEventEx(new Uint8Array(buf));
  assert.equal(r.event, null);
  assert.equal(r.layoutError, false, 'DBC emits ~20 events we do not model; none are drift');
});

test('a KNOWN event with the wrong payload size IS flagged as drift', () => {
  // This is the case that must never silently decode: right discriminator,
  // wrong length, because Meteora shipped a layout change.
  const truncated = Buffer.concat([
    Buffer.from('e445a52e51cb9a1d', 'hex'),
    Buffer.from([27, 60, 21, 213, 138, 170, 187, 147]), // EvtSwap
    Buffer.alloc(100), // should be 154
  ]);
  const r = dbc.decodeDbcEventEx(new Uint8Array(truncated));
  assert.equal(r.event, null);
  assert.equal(r.layoutError, true, 'a size change must trip the breaker, not decode garbage');
});

test('base58 decoding path matches the raw path', () => {
  const f = fixtures.EvtSwap[0];
  const raw = dbc.decodeDbcEventEx(bytes(f.data));
  // Re-encode the fixture to base58, the form getTransaction returns.
  const b58 = base58Encode(Buffer.from(f.data, 'base64'));
  const viaB58 = dbc.decodeDbcEventB58(b58);
  assert.equal(viaB58.event?.pool, raw.event.pool);
  assert.equal(viaB58.event?.amountIn, raw.event.amountIn);
});

test('malformed base58 is refused without throwing', () => {
  const r = dbc.decodeDbcEventB58('not!valid!base58!');
  assert.equal(r.event, null);
  assert.equal(r.layoutError, false);
});

// Minimal local base58 encoder, so the test does not depend on the module
// under test to build its own input.
function base58Encode(buf) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

test('a real EvtSwap is tagged as the v1 variant', () => {
  for (const f of fixtures.EvtSwap) {
    const { event } = dbc.decodeDbcEventEx(bytes(f.data));
    assert.equal(event.kind, 'dbc_swap');
    assert.equal(event.variant, 1, 'EvtSwap is variant 1');
  }
});

test('one swap produces one tick, even though DBC emits two events for it', () => {
  // DBC emits BOTH EvtSwap and EvtSwap2 per swap. Before this, every DBC
  // token had exactly 2x the real volume, trade count and candle body.
  const v1 = { kind: 'dbc_swap', variant: 1, pool: 'P' };
  const v2 = { kind: 'dbc_swap', variant: 2, pool: 'P' };

  assert.deepEqual(dbc.dedupeSwaps([v1, v2]), [v2], 'v2 wins when both are present');
  assert.deepEqual(dbc.dedupeSwaps([v2, v1]), [v2], 'and order does not matter');

  // Two genuine swaps in one transaction are two ticks, not one.
  const b1 = { kind: 'dbc_swap', variant: 2, pool: 'P', n: 1 };
  const b2 = { kind: 'dbc_swap', variant: 2, pool: 'P', n: 2 };
  assert.deepEqual(dbc.dedupeSwaps([b1, b2]), [b1, b2], 'two real swaps stay two');

  // And if a future deploy stops emitting v2, v1 must still tape.
  assert.deepEqual(dbc.dedupeSwaps([v1]), [v1], 'v1 alone still counts');
  assert.deepEqual(dbc.dedupeSwaps([]), [], 'nothing in, nothing out');
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
  console.log(`dbcdecoder: ${passed}/${cases.length} tests passed`);
}

await run();
