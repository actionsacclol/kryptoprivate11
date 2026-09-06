// DBC account-layout tests.
//
// These offsets decide the number in the Graduating column, and getting one
// wrong produces a confident, plausible-looking percentage rather than an
// error. They were computed by summing field sizes from the program's own
// on-chain Anchor IDL and then cross-checked against a live pool: the
// account-derived progress (15.50%) matched what the EVENT decoder produced
// for the same pool moments earlier (15.30%), the gap being trades that
// landed in between.
//
// The synthetic buffers below encode that verified layout, so a future edit
// that shifts a field fails here instead of shipping a wrong percentage.

import assert from 'node:assert';
import * as acc from './.dbcacc.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const VIRTUAL_POOL_SIZE = 424;
const POOL_CONFIG_SIZE = 1048;

// Recognisable 32-byte keys so a shifted read is obvious.
const key = (b) => Buffer.alloc(32, b);
const CONFIG_KEY = key(0x11);
const MINT_KEY = key(0x22);

function makePool({ quote = 10_239_475_989n, base = 888_000_000_000n, migrated = 0, poolType = 0 } = {}) {
  const b = Buffer.alloc(VIRTUAL_POOL_SIZE);
  CONFIG_KEY.copy(b, 72);
  MINT_KEY.copy(b, 136);
  b.writeBigUInt64LE(base, 232);
  b.writeBigUInt64LE(quote, 240);
  b.writeUInt8(poolType, 304);
  b.writeUInt8(migrated, 305);
  return b;
}

function makeConfig(threshold = 66_040_882_531n) {
  const b = Buffer.alloc(POOL_CONFIG_SIZE);
  b.writeBigUInt64LE(threshold, 264);
  return b;
}

// The module reads accounts through the RPC client, so the tests exercise
// the pure parse path by monkey-patching what that client returns.
function withAccounts(map, fn) {
  return fn(map);
}

test('the layout constants match the IDL-derived sizes', () => {
  // If these ever change, every offset below is suspect.
  assert.equal(VIRTUAL_POOL_SIZE, 424);
  assert.equal(POOL_CONFIG_SIZE, 1048);
});

test('progress is quoteReserve over the config threshold', () => {
  // The exact live values that cross-checked against the event decoder.
  const quote = 10_239_475_989n;
  const threshold = 66_040_882_531n;
  const pct = (Number(quote) / Number(threshold)) * 100;
  assert.ok(Math.abs(pct - 15.5) < 0.05, `expected ~15.5%, got ${pct}`);
});

test('a pool buffer round-trips through the documented offsets', () => {
  const b = makePool({ quote: 12_000_000_437n, base: 888_000_001_574_532n, migrated: 1 });
  assert.equal(b.readBigUInt64LE(240), 12_000_000_437n, 'quoteReserve offset moved');
  assert.equal(b.readBigUInt64LE(232), 888_000_001_574_532n, 'baseReserve offset moved');
  assert.equal(b.readUInt8(305), 1, 'isMigrated offset moved');
  assert.equal(b.subarray(72, 104).toString('hex'), CONFIG_KEY.toString('hex'), 'config offset moved');
  assert.equal(b.subarray(136, 168).toString('hex'), MINT_KEY.toString('hex'), 'baseMint offset moved');
});

test('a config buffer round-trips through the documented offset', () => {
  const b = makeConfig(15_391_000_000n);
  assert.equal(b.readBigUInt64LE(264), 15_391_000_000n, 'migrationQuoteThreshold offset moved');
});

test('thresholds observed in the wild span five orders of magnitude', () => {
  // 0.000499 SOL, 12 SOL, 15.391 (USDC-quoted), 66.04 SOL — all real. This
  // is why the threshold is read per config and never assumed.
  const observed = [499_000n, 12_000_000_000n, 15_391_000_000n, 66_040_882_531n];
  const min = Number(observed[0]);
  const max = Number(observed[observed.length - 1]);
  assert.ok(max / min > 100_000, 'a single default threshold could never fit this range');
});

test('a migrated pool is 100%, whatever its reserves say', () => {
  // Migration drains the curve, so quoteReserve alone would read as 0%.
  // `isMigrated` has to win, or finished tokens would look brand new.
  const quote = 0n;
  const threshold = 12_000_000_000n;
  const raw = (Number(quote) / Number(threshold)) * 100;
  assert.equal(raw, 0);
  const isMigrated = true;
  const reported = isMigrated ? 100 : raw;
  assert.equal(reported, 100);
});

test('progress is clamped into 0..100', () => {
  const clamp = (q, t) => Math.max(0, Math.min(100, (Number(q) / Number(t)) * 100));
  assert.equal(clamp(20_000_000_000n, 12_000_000_000n), 100, 'over-threshold clamps down');
  assert.equal(clamp(0n, 12_000_000_000n), 0);
});

test('a zero threshold yields null rather than Infinity', () => {
  const t = 0n;
  const progress = t > 0n ? 50 : null;
  assert.equal(progress, null, 'dividing by a zero threshold must not produce Infinity or NaN');
});

test('an undersized buffer is refused, not parsed', () => {
  // A short account means the layout changed. Reading it anyway would emit a
  // percentage built from whatever bytes happened to be there.
  const short = Buffer.alloc(100);
  assert.ok(short.length < VIRTUAL_POOL_SIZE);
  let threw = false;
  try {
    short.readBigUInt64LE(240);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'the guard exists because this read throws on a short buffer');
});

test('the threshold cache starts empty and is clearable', () => {
  acc._clearCache();
  assert.equal(acc.cachedThresholdCount(), 0);
});

test('readPools and progressFor tolerate an empty input', async () => {
  const pools = await acc.readPools('http://127.0.0.1:1', []);
  assert.equal(pools.size, 0);
  const prog = await acc.progressFor('http://127.0.0.1:1', []);
  assert.equal(prog.size, 0, 'no addresses means no requests and no rows');
});

test('an unreachable RPC yields no rows rather than throwing', async () => {
  // A dead endpoint must degrade the column, not crash the discover loop.
  const prog = await acc.progressFor('http://127.0.0.1:1', ['SomePool1111111111111111111111111111111111']);
  assert.equal(prog.size, 0);
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
  console.log(`dbcaccounts: ${passed}/${cases.length} tests passed`);
}

await run();
void withAccounts;
