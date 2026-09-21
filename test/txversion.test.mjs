// Transaction v1 (SIMD-0385, mainnet since 2026-09-15) and the app's
// transaction reads.
//
// What broke: every getTransaction / getTransactions / blockSubscribe in the
// app said `maxSupportedTransactionVersion: 0`, so a node refused (-32015)
// every v1 transaction a followed wallet made and the copy watcher logged
// "That trade was not copied" for each (user report 2026-09-20, ~30 copy
// positions left open after the leader had sold). Pinned here:
//
//   1. every transaction read in electron/ goes through ONE constant, and it
//      is 1 — a second hardcoded version is the bug coming back;
//   2. the base64 wire parser (blockSubscribe standby) reads a real mainnet
//      v1 transaction to the same signature and keys the JSON carries, and
//      still reads the legacy/v0 layout;
//   3. a real v1 SELL by one of the reported leaders decodes through the
//      balance-delta swap decoder unchanged — the JSON shape is v0's plus
//      `transactionConfig`, and v1 has no lookup tables to resolve.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_SUPPORTED_TX_VERSION, decodeWalletSwap, parseWireTransaction, resolveAccountKeys } from './.txversion.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// ── 1. one constant, value 1, used everywhere ─────────────────────────
{
  assert.equal(MAX_SUPPORTED_TX_VERSION, 1, 'the newest format the client reads is v1');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const offenders = [];
  for (const f of walk('electron')) {
    const src = fs.readFileSync(f, 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('maxSupportedTransactionVersion')) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue; // prose
      if (/maxSupportedTransactionVersion:\s*MAX_SUPPORTED_TX_VERSION/.test(line)) continue;
      offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `every transaction read names the constant, never a literal version:\n${offenders.join('\n')}`);
  ok('every transaction read in electron/ asks for v1 through the one constant');
}

// ── 2. the wire parser: v1 and legacy ─────────────────────────────────
const wire = JSON.parse(fs.readFileSync(new URL('./fixtures/v1-wire.json', import.meta.url), 'utf8'));
{
  const buf = Buffer.from(wire.base64, 'base64');
  assert.equal(buf[0], 0x81, 'a v1 transaction starts with the version byte');
  const parsed = parseWireTransaction(wire.base64);
  assert.ok(parsed, 'parses');
  assert.equal(parsed.signature, wire.json.transaction.signatures[0], 'the first signature, read from the TAIL');
  assert.deepEqual(parsed.accountKeys, wire.json.transaction.message.accountKeys, 'all static keys, in order — 63 of them, inline, no lookup table');
  assert.equal(parsed.accountKeys.length, buf[41], 'the key count is the u8 at offset 41');
  ok('a real mainnet v1 transaction parses off the wire to the signature and keys its JSON carries');
}
{
  // Legacy layout, hand-built: one signature, header, one static key. The
  // v1 branch must not have changed this path.
  const key = Buffer.alloc(32, 7);
  const sig = Buffer.alloc(64, 9);
  const legacy = Buffer.concat([Buffer.from([1]), sig, Buffer.from([1, 0, 0]), Buffer.from([1]), key, Buffer.alloc(32, 1), Buffer.from([0])]);
  const parsed = parseWireTransaction(legacy.toString('base64'));
  assert.ok(parsed);
  assert.equal(parsed.accountKeys.length, 1);
  // v0 layout: the same with the 0x80 prefix before the header.
  const v0 = Buffer.concat([Buffer.from([1]), sig, Buffer.from([0x80]), Buffer.from([1, 0, 0]), Buffer.from([1]), key, Buffer.alloc(32, 1), Buffer.from([0]), Buffer.from([0])]);
  const parsed0 = parseWireTransaction(v0.toString('base64'));
  assert.ok(parsed0);
  assert.deepEqual(parsed0.accountKeys, parsed.accountKeys);
  assert.equal(parsed0.signature, parsed.signature);
  assert.equal(parseWireTransaction(Buffer.from([0x81, 1, 0, 0]).toString('base64')), null, 'a truncated v1 is null, never a throw');
  assert.equal(parseWireTransaction('not base64!!'), null);
  ok('legacy and v0 wires still parse; garbage is null');
}

// ── 3. a leader's real v1 SELL decodes as a swap ──────────────────────
{
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/v1-swap.json', import.meta.url), 'utf8'));
  const tx = fx.transaction;
  assert.equal(tx.version, 1, 'the fixture is a v1 transaction');
  assert.ok(tx.transaction.message.transactionConfig, 'with the v1 budget block on the message');
  const keys = resolveAccountKeys(tx);
  assert.equal(keys.length, tx.transaction.message.accountKeys.length, 'v1 has no lookup tables: the resolved list is the static list');
  const swap = decodeWalletSwap(tx, fx.expected.wallet);
  assert.ok(swap, 'the leader\'s v1 trade decodes');
  assert.equal(swap.mint, fx.expected.mint);
  assert.equal(swap.isBuy, fx.expected.isBuy, fx.expected.isBuy ? 'a buy' : 'a SELL — the kind that left thirty copies open');
  assert.ok(Math.abs(swap.sol - fx.expected.solAbs) < 1e-6, `SOL leg ${swap.sol} vs ${fx.expected.solAbs}`);
  assert.ok(swap.tokens > 0);
  assert.equal(decodeWalletSwap(tx, 'Wallet1111111111111111111111111111111111111'), null, 'a wallet that did not sign it has no trade here');
  ok(`the reported leader's real v1 ${fx.expected.isBuy ? 'buy' : 'sell'} decodes through the unchanged balance-delta decoder`);
}

console.log(`\ntxversion: ${passed}/${passed} passed`);
