// EVM token discovery (2026-10-03): a token SENT to a wallet on BNB or
// Robinhood showed on no page, because only tokens traded here were read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as D from './.tokendiscovery.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const OWNER = '0x011F1bbac10Dcf1eFCe795C9e92391C40cbbDd0a';
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicOf = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-discovery-'));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await tick(10);
  }
}

test('majors are candidates on every read, before any scan', () => {
  D._reset();
  const c = D.candidates('bnb', OWNER);
  assert.ok(c.includes(CAKE), 'CAKE is a BNB major');
  assert.ok(c.includes('0x55d398326f99059ff775485246999027b3197955'), 'USDT');
  assert.ok(D.candidates('robinhood', OWNER).includes('0x5fc5360d0400a0fd4f2af552add042d716f1d168'), 'USDG on Robinhood');
  assert.ok(D.MAJOR_TOKENS.bnb.every((a) => a === a.toLowerCase() && /^0x[0-9a-f]{40}$/.test(a)), 'stored lower-case');
});

test('BNB without the user’s own endpoint never scans (free endpoints cannot answer)', async () => {
  D._reset();
  D.init(dir());
  let calls = 0;
  D._setIo({ scans: (c) => c === 'robinhood', head: async () => (calls++, 1_000_000n), logs: async () => (calls++, []), gapMs: 0 });
  D.kick('bnb', OWNER);
  await tick(30);
  assert.equal(calls, 0, 'not one request on BNB');
  assert.equal(D.scans('bnb'), false);
});

test('a scan finds ERC-20s sent to the wallet, skips NFTs and other wallets, and tells the page', async () => {
  D._reset();
  const d = dir();
  const found = [];
  D.init(d, { onFound: (chain, owner) => found.push([chain, owner]) });
  const asked = [];
  const NFT = '0x' + 'ab'.repeat(20);
  const MEME = '0x' + 'cd'.repeat(20);
  D._setIo({
    scans: () => true,
    gapMs: 0,
    backBlocks: 100_000n,
    head: async () => 1_000_000n,
    logs: async (chain, from, to, ownerTopic) => {
      asked.push([from, to]);
      assert.equal(ownerTopic, topicOf(OWNER), 'filtered on the owner as recipient');
      const out = [];
      // The meme coin arrived 50,000 blocks ago; an NFT in the same window.
      if (from <= 950_000n && 950_000n <= to) {
        out.push({ address: MEME.toUpperCase().replace('0X', '0x'), topics: [T, topicOf('0x' + '11'.repeat(20)), topicOf(OWNER)] });
        out.push({ address: NFT, topics: [T, topicOf('0x' + '11'.repeat(20)), topicOf(OWNER), '0x' + '0'.repeat(63) + '1'] });
      }
      return out;
    },
  });
  D.kick('robinhood', OWNER);
  await until(() => !D._busy('robinhood', OWNER) && D.progress('robinhood', OWNER) === 1, 5000);
  assert.deepEqual(D.found('robinhood', OWNER), [MEME], 'the ERC-20, lower-cased; never the NFT');
  assert.ok(D.candidates('robinhood', OWNER).includes(MEME));
  assert.deepEqual(found[0], ['robinhood', OWNER.toLowerCase()], 'the page is told to reload');
  // New blocks first, then back: the first window ends at the head.
  assert.equal(asked[0][1], 1_000_000n);
  // Windows never overlap and never exceed the measured 30,000-block cap.
  for (const [f, t] of asked) assert.ok(t - f + 1n <= 30_000n, 'within Robinhood’s address-less limit');
  const lo = asked.reduce((m, [f]) => (f < m ? f : m), asked[0][0]);
  assert.equal(lo, 900_000n, 'down to the backfill floor and no further');
  // Another wallet's history is its own.
  assert.deepEqual(D.found('robinhood', '0x' + '22'.repeat(20)), []);
  // Survives a restart: the file holds the result.
  D.flushSync();
  D._reset();
  D.init(d);
  assert.deepEqual(D.found('robinhood', OWNER), [MEME], 'read back from disk');
});

test('a refusal (429) stops the run, keeps progress, and backs off', async () => {
  D._reset();
  D.init(dir());
  let n = 0;
  D._setIo({
    scans: () => true,
    gapMs: 0,
    backBlocks: 300_000n,
    head: async () => 1_000_000n,
    logs: async () => {
      n += 1;
      if (n === 3) throw new Error('HTTP 429 Too Many Requests');
      return [];
    },
  });
  D.kick('robinhood', OWNER);
  await until(() => !D._busy('robinhood', OWNER));
  assert.equal(n, 3, 'stopped at the refusal');
  const p = D.progress('robinhood', OWNER);
  assert.ok(p !== null && p > 0 && p < 1, 'the two good windows are kept');
  D.kick('robinhood', OWNER);
  await tick(30);
  assert.equal(n, 3, 'backing off: no request straight after a refusal');
});

test('closed for longer than the backfill: catches up only the recent window', async () => {
  D._reset();
  const d = dir();
  fs.writeFileSync(path.join(d, 'evm-token-discovery.json'), JSON.stringify({ version: 1, wallets: { [`robinhood:${OWNER.toLowerCase()}`]: { hi: '100000', lo: '50000', floor: '50000', tokens: [], at: 1 } } }));
  D.init(d);
  const asked = [];
  D._setIo({ scans: () => true, gapMs: 0, backBlocks: 60_000n, head: async () => 10_000_000n, logs: async (c, f, t) => (asked.push([f, t]), []) });
  D.kick('robinhood', OWNER);
  await until(() => !D._busy('robinhood', OWNER));
  assert.ok(asked[0][0] >= 10_000_000n - 60_000n, `not the ${(10_000_000 - 100_000).toLocaleString()} blocks since it closed`);
});

test('an unreadable file is set aside, never overwritten', () => {
  D._reset();
  const d = dir();
  const f = path.join(d, 'evm-token-discovery.json');
  fs.writeFileSync(f, '{"version":1,"wallets":{ broken');
  D.init(d);
  const aside = fs.readdirSync(d).filter((x) => x.startsWith('evm-token-discovery.json.corrupt-'));
  assert.equal(aside.length, 1, 'the bad file kept beside');
  assert.equal(fs.readFileSync(path.join(d, aside[0]), 'utf8'), '{"version":1,"wallets":{ broken');
  assert.deepEqual(D.found('robinhood', OWNER), []);
});

let passed = 0;
for (const c of cases) {
  try {
    await c.fn();
    passed++;
    console.log(`ok   ${c.name}`);
  } catch (err) {
    console.error(`FAIL ${c.name}\n  ${err.stack ?? err.message}`);
    process.exitCode = 1;
  }
}
D._reset();
console.log(`tokendiscovery: ${passed}/${cases.length} passed`);
