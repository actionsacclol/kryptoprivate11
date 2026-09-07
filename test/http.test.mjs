// The provider HTTP layer under a 429 — the rules the rate-limit swarm of
// 2026-09-06 pinned after users reported being rate limited:
//   1. a park is honoured at the FRONT of the queue, so calls already chained
//      behind the one that 429'd never fire into it;
//   2. Retry-After sets the park length; repeats escalate; a park is never
//      shortened by a later, smaller answer;
//   3. priority calls bypass the park but are spaced among themselves.
// No network: fetch is stubbed.
import assert from 'node:assert';
import { getJson, cooldownRemainingMs, parseRetryAfterMs } from './.http.mjs';

let hits = [];
function stubFetch(handler) {
  hits = [];
  globalThis.fetch = async (url, init) => {
    hits.push({ url: String(url), at: Date.now() });
    return handler(String(url), init, hits.length);
  };
}
const res = (status, body = '{}', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  body: null,
  text: async () => body,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. the park is checked when a queued call reaches the front ──────────
{
  stubFetch((_url, _init, n) => (n === 1 ? res(429) : res(200, '{"a":1}')));
  const results = await Promise.all([
    getJson('pumpswap', '/one'),
    getJson('pumpswap', '/two'),
    getJson('pumpswap', '/three'),
    getJson('pumpswap', '/four'),
  ]);
  assert.equal(hits.length, 1, 'only the first call reached the host — the three behind it failed fast');
  assert.equal(results[0].status, 429);
  assert.match(results[0].message, /rate limited \(429\) — pausing 20s/);
  for (const r of results.slice(1)) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 429);
    assert.match(r.message, /rate limited, retrying in \d+s/);
  }
  const cooling = cooldownRemainingMs('pumpswap');
  assert.ok(cooling > 18_000 && cooling <= 20_000, `20 s park without Retry-After: ${cooling}`);
  console.log('ok  queued calls do not fire into a park');
}

// ── 2. Retry-After sets the park ─────────────────────────────────────────
{
  stubFetch(() => res(429, '', { 'retry-after': '3' }));
  const r = await getJson('dexscreener', '/x');
  assert.equal(r.status, 429);
  assert.match(r.message, /pausing 3s/);
  const cooling = cooldownRemainingMs('dexscreener');
  assert.ok(cooling > 2_500 && cooling <= 3_000, `Retry-After: 3 → ~3 s park: ${cooling}`);
  console.log('ok  Retry-After is honoured');
}

// ── 3. repeats escalate; a success clears; a smaller answer never shortens ──
{
  stubFetch(() => res(429));
  let r = await getJson('jupiter', '/a');
  assert.equal(r.status, 429);
  assert.ok(cooldownRemainingMs('jupiter') > 18_000, 'first strike: 20 s');

  // A priority call bypasses the park; its success clears it.
  stubFetch(() => res(200, '[]'));
  r = await getJson('jupiter', '/b', { priority: true });
  assert.equal(r.ok, true);
  assert.equal(cooldownRemainingMs('jupiter'), 0, 'a success clears the park');

  stubFetch(() => res(429));
  r = await getJson('jupiter', '/c', { priority: true });
  assert.match(r.message, /pausing 40s/, 'second strike inside the decay window doubles');
  const forty = cooldownRemainingMs('jupiter');
  assert.ok(forty > 38_000 && forty <= 40_000, `40 s: ${forty}`);

  stubFetch(() => res(429, '', { 'retry-after': '2' }));
  r = await getJson('jupiter', '/d', { priority: true });
  assert.ok(cooldownRemainingMs('jupiter') > 37_000, 'a later, shorter Retry-After does not shorten the park');
  console.log('ok  parks escalate, clear on success, never shrink');
}

// ── 4. priority calls jump the park but space themselves ─────────────────
{
  stubFetch(() => res(200, '[]'));
  const results = await Promise.all([
    getJson('jupiter', '/p1', { priority: true }),
    getJson('jupiter', '/p2', { priority: true }),
    getJson('jupiter', '/p3', { priority: true }),
  ]);
  assert.ok(results.every((r) => r.ok), 'priority calls go out while the provider is parked');
  assert.equal(hits.length, 3);
  const gaps = [hits[1].at - hits[0].at, hits[2].at - hits[1].at];
  assert.ok(gaps.every((g) => g >= 100), `three concurrent priority calls are spaced by the host gap: ${gaps.join(',')}`);
  console.log('ok  priority calls are spaced among themselves');
}

// ── 5. a normal call still waits for the park to end ─────────────────────
{
  // Test 4's successes cleared the park; park it again through a priority
  // call. Fourth strike inside the decay window: 160 s, capped at 120 s.
  stubFetch(() => res(429));
  const p = await getJson('jupiter', '/park', { priority: true });
  assert.match(p.message, /pausing 120s/, 'escalation is capped at two minutes');
  stubFetch(() => res(200, '[]'));
  const r = await getJson('jupiter', '/normal');
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(hits.length, 0, 'no request while parked');
  console.log('ok  non-priority calls fail fast without a request');
}

// ── 6. Retry-After parsing ───────────────────────────────────────────────
{
  assert.equal(parseRetryAfterMs('3'), 3_000);
  assert.equal(parseRetryAfterMs('0'), 2_000, 'floor: a zero cannot un-park');
  assert.equal(parseRetryAfterMs('99999'), 120_000, 'ceiling: a hostile header cannot park for an hour');
  assert.equal(parseRetryAfterMs('garbage'), null);
  assert.equal(parseRetryAfterMs(null), null);
  const date = new Date(Date.now() + 5_000).toUTCString();
  const fromDate = parseRetryAfterMs(date);
  assert.ok(fromDate > 3_500 && fromDate <= 5_000, `HTTP-date form: ${fromDate}`);
  console.log('ok  Retry-After parsing');
}

// ── 7. a slow queue does not defeat the gap ──────────────────────────────
{
  // Two normal calls on a provider with no park: the second waits the gap.
  stubFetch(async () => {
    await sleep(20);
    return res(200, '{}');
  });
  await Promise.all([getJson('pumpswap', '/a'), getJson('pumpswap', '/b')]).catch(() => undefined);
  // pumpswap is still parked from test 1 — both fail fast, no hits.
  assert.equal(hits.length, 0);
  console.log('ok  a parked provider stays parked across the queue');
}

console.log('\nhttp layer: all rate-limit rules hold');
