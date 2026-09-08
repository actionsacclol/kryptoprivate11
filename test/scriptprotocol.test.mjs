// The wire between main and a script sandbox — the untrusted side.
//
// Everything the sandbox sends is parsed here before anything reads it. A
// script must not be able to make main throw, name a method it does not
// have, or pass an unbounded payload.

import assert from 'node:assert';
import { parseFromSandbox, sandboxPageHtml, SCRIPT_METHODS, EVENT_TIMEOUT_MS, MIN_INTERVAL_S } from './.scriptprotocol.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('well-formed messages parse to exactly their shape', () => {
  assert.deepEqual(parseFromSandbox({ t: 'ready' }), { t: 'ready' });
  assert.deepEqual(parseFromSandbox({ t: 'done', id: 3, ok: true }), { t: 'done', id: 3, ok: true, error: undefined });
  assert.deepEqual(parseFromSandbox({ t: 'call', id: 1, method: 'buy', args: ['m', 0.1] }), { t: 'call', id: 1, method: 'buy', args: ['m', 0.1] });
  assert.deepEqual(parseFromSandbox({ t: 'log', level: 'warn', line: 'x' }), { t: 'log', level: 'warn', line: 'x' });
  assert.deepEqual(parseFromSandbox({ t: 'log', level: 'bogus', line: 'x' }), { t: 'log', level: 'info', line: 'x' }, 'an unknown level is info');
});

test('garbage never parses — and never throws', () => {
  for (const bad of [null, 1, 'x', [], {}, { t: 'nope' }, { t: 'call' }, { t: 'call', id: -1, method: 'buy' }, { t: 'call', id: 1.5, method: 'buy' }, { t: 'done', id: 1 }, { t: 'log', level: 'info' }]) {
    assert.equal(parseFromSandbox(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

test('a method not on the list is refused at the wall', () => {
  assert.equal(parseFromSandbox({ t: 'call', id: 1, method: 'require', args: ['fs'] }), null);
  assert.equal(parseFromSandbox({ t: 'call', id: 1, method: 'signTransaction', args: [] }), null);
  assert.equal(parseFromSandbox({ t: 'call', id: 1, method: '__proto__', args: [] }), null);
  for (const m of SCRIPT_METHODS) assert.ok(parseFromSandbox({ t: 'call', id: 1, method: m, args: [] }), m);
});

test('payloads are bounded: too many args, too many bytes, unserialisable', () => {
  assert.equal(parseFromSandbox({ t: 'call', id: 1, method: 'buy', args: new Array(9).fill(1) }), null);
  assert.equal(parseFromSandbox({ t: 'call', id: 1, method: 'setState', args: ['x'.repeat(40_000)] }), null);
  const circular = {};
  circular.self = circular;
  assert.equal(parseFromSandbox({ t: 'call', id: 1, method: 'setState', args: [circular] }), null);
  const long = parseFromSandbox({ t: 'log', level: 'info', line: 'y'.repeat(10_000) });
  assert.equal(long.line.length, 400, 'a log line is cut');
});

test('the sandbox page locks itself down and exposes only bot', () => {
  const html = sandboxPageHtml();
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/, 'nothing loads from anywhere');
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|WebSocket|<script src=/, 'no network primitives, no external script');
  assert.match(html, /new Function\('bot', 'console', m\.code\)/, 'user code receives bot and a console — nothing else');
  assert.match(html, /Object\.freeze\(\{/, 'bot is frozen');
  assert.ok(EVENT_TIMEOUT_MS <= 5_000 && MIN_INTERVAL_S >= 5, 'a runaway handler is short-lived; a timer cannot spin');
});

for (const c of cases) {
  try {
    c.fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${c.name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`scriptprotocol: ${passed}/${cases.length} passed`);
