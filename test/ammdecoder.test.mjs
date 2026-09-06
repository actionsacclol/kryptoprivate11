// Fixture tests for the pump-amm (PumpSwap) event decoder.
//
// Two layers, same approach as decoder.test.mjs:
//   1. Synthetic byte-exact events pin the layout field-by-field.
//   2. Real payloads captured from the 2026-07-25 tape pin it against the
//      chain, including the cross-event invariant that ties a migration to
//      the pool's first trade.

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeAmmEvent, decodeAmmLogs, decodeAmmEventEx, poolPriceSol, executedPriceSol } from './.ammdecoder.mjs';

function disc(name) {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}
function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
function i64(v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
}
const PK = (n) => Buffer.alloc(32, n);

// ── synthetic BuyEvent: 14 numeric fields, then 7 pubkeys ──
{
  const payload = Buffer.concat([
    disc('BuyEvent'),
    i64(1784955620),          // timestamp
    u64(2374370725319),       // baseAmount (tokens out)
    u64(999000000),           // quoteLimit (max quote in)
    u64(0),                   // userBaseReserves
    u64(32922717790),         // userQuoteReserves
    u64(206900000000000),     // poolBaseReserves
    u64(67405853790),         // poolQuoteReserves
    u64(999000000),           // quoteAmount
    u64(20), u64(1998000),    // lpFeeBps, lpFee
    u64(5), u64(499500),      // protocolFeeBps, protocolFee
    u64(997002000),           // quote excluding lp fee (skipped by decoder)
    u64(986666666),           // userQuoteAmount
    PK(1), PK(2), PK(3), PK(4), PK(5), PK(6), PK(7),
  ]);
  const ev = decodeAmmEvent(payload.toString('base64'));
  assert.equal(ev.kind, 'amm_swap');
  assert.equal(ev.isBuy, true);
  assert.equal(ev.timestamp, 1784955620);
  assert.equal(ev.baseAmount, 2374370725319n);
  assert.equal(ev.quoteAmount, 999000000n);
  assert.equal(ev.poolBaseReserves, 206900000000000n);
  assert.equal(ev.poolQuoteReserves, 67405853790n);
  assert.equal(ev.lpFeeBps, 20n);
  assert.equal(ev.protocolFee, 499500n);
  assert.equal(ev.userQuoteAmount, 986666666n);
  // pubkey block: pool first, user second, coinCreator last of the seven
  assert.equal(ev.pool, decodeAmmEvent(payload.toString('base64')).pool);
  assert.notEqual(ev.pool, ev.user);
  assert.notEqual(ev.user, ev.coinCreator);
  console.log('ok  BuyEvent (synthetic, byte-exact)');
}

// ── synthetic SellEvent: same shape, flipped semantics ──
{
  const payload = Buffer.concat([
    disc('SellEvent'),
    i64(1784955622), u64(3404391149115), u64(0), u64(11347970497051), u64(16644527826),
    u64(193027806794410), u64(73524501524), u64(1579021665),
    u64(20), u64(3158044), u64(5), u64(789511), u64(1575074110), u64(1560073404),
    PK(1), PK(2), PK(3), PK(4), PK(5), PK(6), PK(7),
  ]);
  const ev = decodeAmmEvent(payload.toString('base64'));
  assert.equal(ev.isBuy, false);
  assert.equal(ev.baseAmount, 3404391149115n);
  assert.equal(ev.quoteLimit, 0n, 'sell: quoteLimit is min quote out');
  assert.equal(ev.userQuoteAmount, 1560073404n);
  console.log('ok  SellEvent (synthetic, byte-exact)');
}

// ── synthetic CompletePumpAmmMigrationEvent ──
{
  const payload = Buffer.concat([
    disc('CompletePumpAmmMigrationEvent'),
    PK(1),                    // user
    PK(2),                    // mint
    u64(206900000000000),     // mintAmount
    u64(84990359084),         // solAmount
    u64(15000001),            // poolMigrationFee
    PK(3),                    // bondingCurve
    i64(1784955620),          // timestamp
    PK(4),                    // pool
  ]);
  const ev = decodeAmmEvent(payload.toString('base64'));
  assert.equal(ev.kind, 'amm_migration');
  assert.equal(ev.mintAmount, 206900000000000n);
  assert.equal(ev.solAmount, 84990359084n);
  assert.equal(ev.poolMigrationFee, 15000001n);
  assert.equal(ev.timestamp, 1784955620);
  assert.notEqual(ev.mint, ev.pool);
  assert.notEqual(ev.bondingCurve, ev.pool);
  console.log('ok  CompletePumpAmmMigrationEvent (synthetic, byte-exact)');
}

// ── real captured payloads (2026-07-25 tape, pool GnpU6c…C27e) ──
const REAL_MIGRATION =
  'velduVyU6pSgT01zesdggWK47ySyi231AKlJ9xkEyZXyWm6zOBK4FANqXsmXmJBDZIkkDwbJMDd5zUdTgSMDkxIb6hV20AGvAAgBqSy8AAAs9tHJEwAAAMHh5AAAAAAAUolEGgDPOoQ4tboJq9AOMeFZhZ2A4A23RS19ih1ro8TkQmRqAAAAAOqcHJMSwPymC9SeIYGW9HEbKC+6SFCvCUjHwBaWvIPNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const REAL_BUY =
  'Z/RSHyz1d3fkQmRqAAAAAMcNhtMoAgAAwIeLOwAAAAAAAAAAAAAAAF7OWKoHAAAAAAgBqSy8AABetLOxDwAAAMCHizsAAAAAAgAAAAAAAADWAgMAAAAAAF0AAAAAAAAAwAOMAAAAAACAWdI6AAAAAKpWzzoAAAAA6pwckxLA/KYL1J4hgZb0cRsoL7pIUK8JSMfAFpa8g82gT01zesdggWK47ySyi231AKlJ9xkEyZXyWm6zOBK4FCPA7LZeOT6/eDor1UTD9BOpxLgkecSbjTpbW3J+yhhFJMBV0Uq1ei2khbuMqkWFFxFmKN/zSZL32iwpQ+44+ZlKwvjQ3Vy8l+MonBl8tQYqVPPZVrnOblEV+WVnqlyz5nfZFZVfiIBzHOtKdaDMlsF0+kCVxOHZlnrPxChFrmeulTyimfu5xg7z13URFZgIQB4lJ5pLBTVQxPnoFu2UXkEeAAAAAAAAAIAqLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAASAAAAYnV5X2V4YWN0X3F1b3RlX2luAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAA4AFGAAAAAADOQR4YBAAAAAAAAAAAAAAAAQCAxqR+jQMA';
const REAL_SELL =
  'Pi83CqUD3CrmQmRqAAAAADtuhqUYAwAAAAAAAAAAAAAbGsAnUgoAANJWF+ADAAAAqhLbyY6vAAAU3GYeEQAAAGH1HV4AAAAAFAAAAAAAAAAcMDAAAAAAAAUAAAAAAAAABwwMAAAAAABFxe1dAAAAALzU/FwAAAAA6pwckxLA/KYL1J4hgZb0cRsoL7pIUK8JSMfAFpa8g81Ihrlny62JCwao1h0+OB+aTwTdHdq16yfwTu53cP005RWjZRpHJI8kV9WUKCPkH+1mk9zmoh1sC0zv8I/kalDbK4IDVG1+w3hTpd1zBzEQ5HofTtf6kklRvm4N6MDY2mfgBMh865j6XOR/gDgG/Sx5RdKVJJWa7ADe2XgU8494RpwlJHx6/mh3nE583EE55WuEze54pO2bR06h+o7pPOIllTyimfu5xg7z13URFZgIQB4lJ5pLBTVQxPnoFu2UXkFfAAAAAAAAAILk5AAAAAAAAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAAwYGAAAAAADOQR4YBAAAAAAAAAAAAAAAAQCAxqR+jQMA';

const mig = decodeAmmEvent(REAL_MIGRATION);
const buy = decodeAmmEvent(REAL_BUY);
const sell = decodeAmmEvent(REAL_SELL);

{
  assert.equal(mig.kind, 'amm_migration');
  assert.equal(mig.mint, 'ELJFma9JzJfLWbc2fBSXPMAExayXoTr2LUNJLbPpump');
  assert.equal(mig.pool, 'GnpU6c7H9CbPrbb9cUkQMxgz6DZV41h8XbU4pLh4C27e');
  assert.equal(mig.mintAmount, 206900000000000n, 'standard 206.9M token migration');
  assert.equal(mig.poolMigrationFee, 15000001n);
  console.log('ok  migration (real payload)');
}
{
  assert.equal(buy.kind, 'amm_swap');
  assert.equal(buy.isBuy, true);
  assert.equal(buy.pool, mig.pool, 'buy lands on the migrated pool');
  assert.equal(buy.quoteAmount, 999000000n);
  console.log('ok  buy (real payload, 480B variant with trailing string)');
}
{
  assert.equal(sell.isBuy, false);
  assert.equal(sell.pool, mig.pool);
  assert.equal(sell.baseAmount, 3404391149115n);
  console.log('ok  sell (real payload, 417B variant)');
}

// ── cross-event invariant: the pool's first trade sees exactly the tokens
//    the migration seeded. This is what proves the mint↔pool join is real. ──
{
  assert.equal(
    buy.poolBaseReserves,
    mig.mintAmount,
    'first post-migration trade must see the seeded base reserves (reserves are PRE-trade)',
  );
  console.log('ok  migration.mintAmount === first trade poolBaseReserves');
}

// ── fee arithmetic is self-consistent on the sell ──
{
  // The program rounds fees up; BigInt division truncates — allow the 1-unit gap.
  const within1 = (a, b) => (a > b ? a - b : b - a) <= 1n;
  assert.ok(
    within1((sell.quoteAmount * sell.lpFeeBps) / 10000n, sell.lpFee),
    `lp fee = quoteAmount × bps/1e4, got ${sell.lpFee}`,
  );
  assert.ok(
    within1((sell.quoteAmount * sell.protocolFeeBps) / 10000n, sell.protocolFee),
    `protocol fee = quoteAmount × bps/1e4, got ${sell.protocolFee}`,
  );
  assert.ok(sell.userQuoteAmount < sell.quoteAmount, 'seller nets less than gross out');
  console.log('ok  fee arithmetic self-consistent');
}

// ── price helpers ──
{
  const px = poolPriceSol(sell.poolQuoteReserves, sell.poolBaseReserves);
  assert.ok(px > 1e-8 && px < 1e-5, `graduated pump price in range, got ${px}`);
  const ex = executedPriceSol(sell);
  assert.ok(ex > 1e-8 && ex < 1e-5, `executed price in range, got ${ex}`);

  // The migration mid anchors to the known ~$69k pump graduation cap:
  // 206.9M tokens seeded against the first trade's quote reserve.
  const migMid = poolPriceSol(buy.poolQuoteReserves, buy.poolBaseReserves);
  assert.ok(migMid > 3.0e-7 && migMid < 3.5e-7, `graduation mid ~3.26e-7, got ${migMid}`);

  // Documented bias: execution runs ~1.22x the reported mid in BOTH
  // directions. Pinned here so a future layout fix that closes the gap
  // fails loudly rather than silently changing what positions mark at.
  assert.ok(ex / px > 1.1 && ex / px < 1.4, `known mid bias ~1.22x, got ${ex / px}`);
  console.log('ok  poolPriceSol / executedPriceSol (mid bias pinned at ~1.22x)');
}

// ── drift handling: a KNOWN event that is too short is a layout error,
//    an UNKNOWN discriminator is not. ──
{
  const truncated = Buffer.concat([disc('BuyEvent'), Buffer.alloc(64)]);
  const r = decodeAmmEventEx(truncated.toString('base64'));
  assert.equal(r.event, null);
  assert.equal(r.layoutError, true, 'short known event signals drift');

  const unknown = Buffer.concat([disc('SomeFutureEvent'), Buffer.alloc(64)]);
  const r2 = decodeAmmEventEx(unknown.toString('base64'));
  assert.equal(r2.event, null);
  assert.equal(r2.layoutError, false, 'unknown discriminator is not drift');

  const createPool = Buffer.concat([disc('CreatePoolEvent'), Buffer.alloc(326)]);
  const r3 = decodeAmmEventEx(createPool.toString('base64'));
  assert.equal(r3.event, null);
  assert.equal(r3.layoutError, false, 'known-but-undecoded event is not drift');
  console.log('ok  layout drift signalling');
}

// ── log-line extraction ──
{
  const logs = [
    'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
    `Program data: ${REAL_BUY}`,
    `Program data: ${REAL_SELL}`,
    'Program log: unrelated',
  ];
  const evs = decodeAmmLogs(logs);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].isBuy, true);
  assert.equal(evs[1].isBuy, false);
  console.log('ok  decodeAmmLogs');
}

// ── emit_cpi twin on a real pump-amm block tx (2026-08-30) ──
{
  const { decodeCpiAmmEventData, decodeCpiAmmEventDataEx, PUMP_AMM_PROGRAM_ID, PUMP_AMM_GLOBAL_CONFIG } = await import('./.ammdecoder.mjs');
  const { base58Decode, base58Encode } = await import('./.b58.mjs');
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/block-cpi.json', import.meta.url), 'utf8')).pamm.tx;
  // Resolve the account table the same way the block socket does, so the
  // programIdIndex → pAMM check is real rather than assumed.
  const wire = Buffer.from(fx.transaction[0], 'base64');
  let off = 0;
  const cu16 = () => { let v = 0, sh = 0; for (;;) { const b = wire[off++]; v |= (b & 0x7f) << sh; if (!(b & 0x80)) return v; sh += 7; } };
  const nSig = cu16(); off += nSig * 64;
  if (wire[off] & 0x80) off += 1;
  off += 3;
  const nKeys = cu16();
  const keys = [];
  for (let i = 0; i < nKeys; i++) { keys.push(base58Encode(wire.subarray(off, off + 32))); off += 32; }
  keys.push(...(fx.meta.loadedAddresses?.writable ?? []), ...(fx.meta.loadedAddresses?.readonly ?? []));
  assert.ok(keys.includes(PUMP_AMM_GLOBAL_CONFIG), 'every swap references the global config (the block filter key)');
  const swaps = [];
  let nonWrapper = 0;
  for (const ix of fx.meta.innerInstructions.flatMap((g) => g.instructions)) {
    if (keys[ix.programIdIndex] !== PUMP_AMM_PROGRAM_ID) continue;
    const r = decodeCpiAmmEventDataEx(Buffer.from(base58Decode(ix.data)));
    assert.equal(r.layoutError, false);
    if (r.event) swaps.push(r.event); else nonWrapper++;
  }
  assert.ok(swaps.length >= 1, 'at least one swap decoded from inner instructions');
  assert.ok(swaps.every((e) => e.kind === 'amm_swap'));
  // Field-for-field agreement with the log copy of the same tx.
  const fromLogs = decodeAmmLogs(fx.meta.logMessages).filter((e) => e.kind === 'amm_swap');
  assert.equal(fromLogs.length, swaps.length, 'log and CPI copies count the same swaps (double emit)');
  swaps.forEach((cpi, i) => {
    for (const k of ['isBuy', 'timestamp', 'baseAmount', 'quoteAmount', 'poolBaseReserves', 'poolQuoteReserves', 'userQuoteAmount', 'pool', 'user', 'coinCreator']) {
      assert.deepEqual(cpi[k], fromLogs[i][k], `swap ${i} cpi.${k} equals log.${k}`);
    }
    assert.ok(executedPriceSol(cpi) > 0);
  });
  assert.equal(decodeCpiAmmEventData(Buffer.alloc(20)), null, 'not a wrapper → null');
  console.log(`ok  emit_cpi twin decodes ${swaps.length} pAMM swap(s) equal to the log copy (real fixture; ${nonWrapper} non-event inner ix ignored)`);
}

console.log('\nall amm decoder tests passed');
