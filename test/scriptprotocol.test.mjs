// The wire between main and a script sandbox — the untrusted side.
//
// Everything the sandbox sends is parsed here before anything reads it. A
// script must not be able to make main throw, name a method it does not
// have, or pass an unbounded payload.

import assert from 'node:assert';
import { parseFromSandbox, probeResponsive, sandboxPageHtml, SCRIPT_METHODS, EVENT_TIMEOUT_MS, MIN_INTERVAL_S, PROBE_SILENT_SLICES, PROBE_SLICE_MS } from './.scriptprotocol.mjs';

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
  assert.match(html, /new AsyncFunction\('bot', 'console', m\.code\)/, 'user code receives bot and a console — nothing else, and may use top-level await');
  assert.match(html, /webrtc 'block'/, 'the CSP names webrtc, even though Chromium ignores it today — the real block is the IP handling policy');
  assert.match(html, /Object\.freeze\(\{/, 'bot is frozen');
  assert.ok(EVENT_TIMEOUT_MS <= 5_000 && MIN_INTERVAL_S >= 5, 'a runaway handler is short-lived; a timer cannot spin');
});

// 2026-09-25: links/security/creator/analyze were allowed and handled in main
// since 3.1.0 but never put on `bot`, so `bot.creator` was undefined in every
// script and a serial-dev filter silently waved rugs through. Every allowed
// method must be reachable from the harness.
test('every allowed method is on the sandbox bot', () => {
  const html = sandboxPageHtml();
  const body = html.slice(html.indexOf('const bot = Object.freeze({'));
  // A namespaced method (2026-10-03: bot.aio.*) is sent as `aioMove` and sits
  // at bot.aio.move — inside that namespace's own frozen object.
  const NAMESPACES = ['aio'];
  const inNamespace = (m) => {
    const ns = NAMESPACES.find((n) => m.startsWith(n) && m.length > n.length && /[A-Z]/.test(m[n.length]));
    if (!ns) return false;
    const start = body.indexOf(`${ns}: Object.freeze({`);
    if (start < 0) return false;
    const inner = body.slice(start, body.indexOf('})', start));
    const leaf = m[ns.length].toLowerCase() + m.slice(ns.length + 1);
    return new RegExp(`\\n\\s+${leaf}\\s*[:(]`).test(inner);
  };
  const missing = SCRIPT_METHODS.filter((m) => !new RegExp(`\\n\\s+(get )?${m}\\s*[:(]`).test(body) && !inNamespace(m));
  assert.deepEqual(missing, [], `bot is missing: ${missing.join(', ')}`);
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
{
  // bot.stat messages (09-22): untrusted, so every entry is checked and a bad
  // one is dropped without losing the rest.
  const r = parseFromSandbox({ t: 'stats', values: { ok: 1, text: 'x'.repeat(200), flag: true, none: null, bad: NaN, obj: { a: 1 }, '   ': 5, ['n'.repeat(60)]: 2 } });
  assert.equal(r.t, 'stats');
  assert.equal(r.values.ok, 1);
  assert.equal(r.values.text.length, 80, 'text cut to 80');
  assert.equal(r.values.flag, true);
  assert.equal(r.values.none, null, 'null is kept — it means unknown');
  assert.ok(!('bad' in r.values) && !('obj' in r.values), 'NaN and objects are dropped');
  assert.ok(!Object.keys(r.values).some((k) => !k.trim()), 'a blank name is dropped');
  assert.ok(Object.keys(r.values).every((k) => k.length <= 32), 'names cut to 32');
  assert.equal(parseFromSandbox({ t: 'stats', values: [1, 2] }), null, 'an array is not a stats object');
  assert.equal(parseFromSandbox({ t: 'stats', values: {}, clear: true }).clear, true);
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(parseFromSandbox({ t: 'stats', values: many }).values).length, 24, 'at most 24 per message');
  const page = sandboxPageHtml();
  for (const f of ['stat:', 'stats:', 'clearStats:', 'error:']) assert.ok(page.includes(`    ${f}`), `bot.${f.slice(0, -1)} exists in the harness`);
  console.log('ok  bot.stat messages are checked, cut and capped');
}
{
  // probeResponsive — "interval handler ran past 5 s — killed" (2026-09-26).
  // The old probe was ONE ask with a 1 s timeout; a main process busy for a
  // second killed a healthy script. Now: several slices, a fresh ask each,
  // any answer wins, and a slice whose timer fired late (main's stall) is not
  // counted against the script. Small slices here; the logic is the same.
  const fast = { sliceMs: 30, silentSlices: 3, lateMs: 20, maxSlices: 10 };
  const never = () => new Promise(() => {});
  assert.equal(await probeResponsive({ ...fast, ask: () => Promise.resolve(0), gone: () => false }), true, 'an answer is alive');
  assert.equal(await probeResponsive({ ...fast, ask: () => Promise.resolve(0), gone: () => true }), false, 'a destroyed renderer is not');
  assert.equal(await probeResponsive({ ...fast, ask: () => Promise.reject(new Error('gone')), gone: () => false }), false, 'a rejected ask means the frame is gone');
  let asks = 0;
  const t0 = Date.now();
  assert.equal(await probeResponsive({ ...fast, ask: () => { asks += 1; return never(); }, gone: () => false }), false, 'a wedged renderer is still caught');
  assert.equal(asks, 3, 'after exactly silentSlices on-time silent slices (one ask per slice)');
  assert.ok(Date.now() - t0 >= 80, 'and not before they have passed');
  asks = 0;
  assert.equal(await probeResponsive({ ...fast, ask: () => (++asks >= 3 ? Promise.resolve(0) : never()), gone: () => false }), true, 'a slow answer inside the tolerance is alive — the one-shot probe killed this');
  // Main stalled: every slice fires late. None of them counts, so a page that
  // answers on the 6th ask (past silentSlices) is still alive…
  let skew = 0;
  const lateNow = () => Date.now() + (skew += 25);
  asks = 0;
  assert.equal(await probeResponsive({ ...fast, now: lateNow, ask: () => (++asks >= 6 ? Promise.resolve(0) : never()), gone: () => false }), true, 'main’s lateness is not the script’s');
  // …and a wedged page under a stalled main is still killed at maxSlices.
  asks = 0;
  assert.equal(await probeResponsive({ ...fast, now: lateNow, ask: () => { asks += 1; return never(); }, gone: () => false }), false, 'the cap still bites');
  assert.equal(asks, fast.maxSlices, 'at maxSlices');
  assert.ok(PROBE_SILENT_SLICES * PROBE_SLICE_MS >= 5_000, 'the real tolerance is seconds, not the old 1 s');
  assert.ok(PROBE_SILENT_SLICES * PROBE_SLICE_MS + EVENT_TIMEOUT_MS < 30_000, 'and a wedged handler is still killed well inside EVENT_HARD_MS');
  console.log('ok  probeResponsive tolerates slow answers and main-process stalls, still kills a wedged renderer');
}
console.log(`scriptprotocol: ${passed}/${cases.length} passed`);
