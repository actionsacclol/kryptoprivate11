// Crash guard policy.
//
// The point of this module is a judgement call — keep running, except twice —
// so these tests pin the exceptions rather than the happy path. A guard that
// quietly swallowed everything would pass a naive "did it survive" test while
// being exactly the wrong behaviour for an app holding a position.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describe as describeErr,
  formatCrash,
  isStorm,
  prunable,
  fileNameFor,
  pruneOld,
  crashCount,
  STORM_MAX,
  KEEP_DAYS,
  __handleForTest,
  __resetForTest,
} from './.crashguard.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-crash-'));

/** A host that records what the guard decided to do. */
function spy(overrides = {}) {
  const calls = { logs: [], quits: [], notes: [] };
  const host = {
    dir: tmp,
    log: (level, line) => calls.logs.push({ level, line }),
    windowUp: () => true,
    quit: (reason) => calls.quits.push(reason),
    notify: (s) => calls.notes.push(s),
    context: () => ({ app: '1.0.0' }),
    ...overrides,
  };
  __resetForTest(host);
  return calls;
}

// ─── coercion ─────────────────────────────────────────────────────────

ok('an Error keeps its name, message and stack', () => {
  const d = describeErr(new TypeError('bad thing'));
  assert.match(d.message, /TypeError: bad thing/);
  assert.match(d.stack, /crashguard\.test/);
});

ok('a rejected non-Error is still described, not dropped', () => {
  // `Promise.reject('nope')` and `reject({code: 500})` are both common in
  // fetch-heavy code and neither has a stack.
  assert.match(describeErr('nope').message, /nope/);
  assert.match(describeErr({ code: 500 }).message, /500/);
  assert.match(describeErr(undefined).message, /undefined/);
});

ok('an unserialisable rejection does not throw inside the handler', () => {
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => describeErr(circular));
});

// ─── formatting ───────────────────────────────────────────────────────

ok('a crash record carries kind, time, context and stack', () => {
  const text = formatCrash('unhandledRejection', new Error('boom'), { app: '1.0.0' }, 1756000000000);
  assert.match(text, /unhandledRejection/);
  assert.match(text, /Error: boom/);
  assert.match(text, /app: 1\.0\.0/);
  assert.match(text, /2025-08-24T/);
});

// ─── the two cases that still quit ────────────────────────────────────

ok('a crash BEFORE the window exists is fatal, not survived', () => {
  const calls = spy({ windowUp: () => false });
  __handleForTest('uncaughtException', new Error('early boom'));
  assert.equal(calls.quits.length, 1, 'should have quit');
  assert.match(calls.quits[0], /before the window opened/);
});

ok('a windowUp that THROWS is read as no window, not as a crash in the handler', () => {
  // main.ts reads a `let` declared further down the file; during module init
  // that is a temporal-dead-zone ReferenceError.
  const calls = spy({
    windowUp: () => {
      throw new ReferenceError("Cannot access 'mainWindow' before initialization");
    },
  });
  assert.doesNotThrow(() => __handleForTest('uncaughtException', new Error('boom')));
  assert.equal(calls.quits.length, 1);
});

ok('a crash STORM trips the breaker instead of spinning', () => {
  const calls = spy();
  for (let i = 0; i <= STORM_MAX + 1; i++) __handleForTest('uncaughtException', new Error('loop'));
  assert.ok(calls.quits.length >= 1, 'breaker should have tripped');
  assert.match(calls.quits.join(' '), /storm/);
});

ok('an ordinary crash with a window up does NOT quit', () => {
  const calls = spy();
  __handleForTest('unhandledRejection', new Error('provider timeout'));
  assert.equal(calls.quits.length, 0, 'must keep running');
  assert.equal(calls.logs.length, 1);
});

// ─── it must be loud, not silent ──────────────────────────────────────

ok('a survived crash is logged at error level and warns about open trades', () => {
  const calls = spy();
  __handleForTest('unhandledRejection', new Error('provider timeout'));
  assert.equal(calls.logs[0].level, 'error');
  assert.match(calls.logs[0].line, /CHECK YOUR POSITION/);
});

ok('the user is notified once per run, not once per crash', () => {
  const calls = spy();
  for (let i = 0; i < 5; i++) __handleForTest('uncaughtException', new Error('again'));
  assert.equal(calls.notes.length, 1, 'exactly one notification');
  assert.equal(crashCount(), 5, 'but all of them counted');
});

ok('a notify that throws does not escalate', () => {
  const calls = spy({
    notify: () => {
      throw new Error('no notification service');
    },
  });
  assert.doesNotThrow(() => __handleForTest('uncaughtException', new Error('boom')));
  assert.equal(calls.quits.length, 0);
});

// ─── durability ───────────────────────────────────────────────────────

ok('the crash survives the process — it is on disk', () => {
  spy();
  __handleForTest('uncaughtException', new Error('written down'));
  const file = path.join(tmp, fileNameFor(Date.now()));
  assert.ok(fs.existsSync(file), 'crash file should exist');
  assert.match(fs.readFileSync(file, 'utf8'), /written down/);
});

ok('a read-only crash directory does not turn a survivable crash into a fatal one', () => {
  const calls = spy({ dir: path.join(tmp, 'nested', '\0invalid') });
  assert.doesNotThrow(() => __handleForTest('uncaughtException', new Error('boom')));
  assert.equal(calls.quits.length, 0, 'still running despite an unwritable log');
});

// ─── pruning: the disk is not a landfill ──────────────────────────────

ok('crash logs older than the keep window are prunable', () => {
  const now = Date.parse('2026-08-25T00:00:00Z');
  const old = 'crash-2026-08-01.log';
  const fresh = 'crash-2026-08-24.log';
  const list = prunable([old, fresh, 'notes.txt', 'crash-garbage.log'], now);
  assert.deepEqual(list, [old]);
});

ok('pruning only ever deletes files it recognises', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-prune-'));
  fs.writeFileSync(path.join(dir, 'crash-2020-01-01.log'), 'old');
  fs.writeFileSync(path.join(dir, 'wallets.json'), 'PRECIOUS');
  spy({ dir });
  const removed = pruneOld(Date.parse('2026-08-25T00:00:00Z'));
  assert.equal(removed, 1);
  assert.ok(fs.existsSync(path.join(dir, 'wallets.json')), 'must not touch anything else');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('a missing crash directory is a normal first run, not an error', () => {
  spy({ dir: path.join(tmp, 'never-created') });
  assert.doesNotThrow(() => pruneOld());
  assert.equal(pruneOld(), 0);
});

ok('the keep window is a real bound', () => {
  assert.ok(KEEP_DAYS > 0 && KEEP_DAYS <= 30);
});

// ─── storm arithmetic ─────────────────────────────────────────────────

ok('crashes spread over time are not a storm', () => {
  const now = 1_000_000;
  const spread = Array.from({ length: STORM_MAX + 5 }, (_, i) => now - i * 60_000);
  assert.equal(isStorm(spread, now), false);
});

ok('crashes bunched inside the window are a storm', () => {
  const now = 1_000_000;
  const bunched = Array.from({ length: STORM_MAX + 1 }, () => now - 10);
  assert.equal(isStorm(bunched, now), true);
});

// ─── file logger (logs/app.log) ───────────────────────────────────────
// logger.ts has no electron import; bundle it here so the test script in
// package.json needs no new entry.

import { buildSync } from 'esbuild';
buildSync({
  entryPoints: ['electron/system/logger.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'test/.logger.mjs',
  logLevel: 'silent',
});
const { logger, redactSecrets, shouldRotate, LOG_MAX_BYTES, __resetSinkForTest } = await import('./.logger.mjs');

ok('helius api-key, telegram bot tokens and sk- keys never reach disk', () => {
  const line = redactSecrets(
    'wss://mainnet.helius-rpc.com/?api-key=abcd1234-ef56 https://api.telegram.org/bot123456789:AAHfJk3-lmNOPqrstuvWXYZ0123456789ab/getMe token=987654321:AAHfJk3-lmNOPqrstuvWXYZ0123456789ab key sk-ant-api03-verysecretstuff',
  );
  assert.ok(!line.includes('abcd1234'), line);
  assert.ok(!line.includes('AAHfJk3'), line);
  assert.ok(!line.includes('verysecretstuff'), line);
  assert.ok(line.includes('api-key=***'));
  assert.ok(line.includes('bot123456789:***'));
  assert.ok(line.includes('sk-***'));
});

ok('header-borne and query-borne keys are redacted too', () => {
  // The api-key= rule missed both shapes (API swarm, 2026-09-09): Birdeye and
  // Jupiter send the key as a HEADER, and several providers take api_key= or
  // a bare key= in the query string.
  const line = redactSecrets(
    'GET /defi/token_overview X-API-KEY: bd9f8e7a6c5d4e3f2a1b0c9d8e7f6a5b | x-api-key=jup_live_9f8e7a6c5d4e | ?api_key=abcdef0123456789&key=zyxwvu9876543210',
  );
  assert.ok(!line.includes('bd9f8e7a6c5d'), line);
  assert.ok(!line.includes('jup_live_9f8e'), line);
  assert.ok(!line.includes('abcdef0123456789'), line);
  assert.ok(!line.includes('zyxwvu9876543210'), line);
});

ok('ordinary lines survive redaction untouched', () => {
  const s = 'buy 0.05 SOL of 2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce at 12:34:56 sig 5abc';
  assert.equal(redactSecrets(s), s);
});

ok('rotation triggers only when the cap would be crossed', () => {
  assert.equal(shouldRotate(0, LOG_MAX_BYTES * 2), false); // empty file: write anyway
  assert.equal(shouldRotate(100, 50), false);
  assert.equal(shouldRotate(LOG_MAX_BYTES - 10, 20), true);
});

ok('the sink writes a redacted header, buffers lines and flushes sync', () => {
  const dir = path.join(tmp, 'logs');
  __resetSinkForTest();
  const file = logger.attachFileSink(dir, 'Krypto Terminal 1.0.0 api-key=secret');
  assert.equal(file, path.join(dir, 'app.log'));
  const head = fs.readFileSync(file, 'utf8');
  assert.ok(head.includes('Krypto Terminal 1.0.0 api-key=***'));
  logger.info('hello sk-abcdefghijklmnop');
  logger.flushSync();
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(/INFO  hello sk-\*\*\*/.test(body), body);
  assert.ok(!body.includes('abcdefghijklmnop'));
  __resetSinkForTest();
});

ok('a full app.log rotates to app.log.1 instead of growing', () => {
  const dir = path.join(tmp, 'logs2');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.log');
  fs.writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES - 5));
  __resetSinkForTest();
  logger.attachFileSink(dir, 'boot');
  logger.flushSync();
  assert.ok(fs.existsSync(`${file}.1`), 'rotated file exists');
  assert.equal(fs.statSync(`${file}.1`).size, LOG_MAX_BYTES - 5);
  assert.ok(fs.statSync(file).size < 100);
  __resetSinkForTest();
});

ok('an unwritable log directory is not fatal', () => {
  __resetSinkForTest();
  const blocked = path.join(tmp, 'blocked-file');
  fs.writeFileSync(blocked, 'not a dir');
  assert.doesNotThrow(() => logger.attachFileSink(path.join(blocked, 'logs'), 'boot'));
  assert.doesNotThrow(() => logger.error('still fine'));
  assert.doesNotThrow(() => logger.flushSync());
  __resetSinkForTest();
});

__resetForTest(null);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`crashguard: ${passed}/${passed} tests passed`);
