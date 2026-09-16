// The provider HTTP layer under a 429 — the rules the rate-limit swarm of
// 2026-09-06 pinned after users reported being rate limited:
//   1. a park is honoured at the FRONT of the queue, so calls already chained
//      behind the one that 429'd never fire into it;
//   2. Retry-After sets the park length; repeats escalate; a park is never
//      shortened by a later, smaller answer;
//   3. priority calls bypass the park but are spaced among themselves.
// No network: fetch is stubbed.
//
// Tests 8-13 are the API swarm of 2026-09-09 §1 and §7:
//   8-11. a refusal that arrives with a SUCCESS status is still a refusal —
//         it parks, it never un-parks, and legitimate data is untouched;
//   12-13. Jupiter's host, gap and window all follow the user's key.
import assert from 'node:assert';
import { humanWait } from './.marketshared.mjs';
import {
  getJson,
  cooldownRemainingMs,
  parseRetryAfterMs,
  classifyBody,
  providerLimits,
  setJupiterApiKey,
  jupiterKeyed,
} from './.http.mjs';

let hits = [];
let lastInit = null;
function stubFetch(handler) {
  hits = [];
  lastInit = null;
  globalThis.fetch = async (url, init) => {
    hits.push({ url: String(url), at: Date.now() });
    lastInit = init;
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

// ── 2. Retry-After may EXTEND the park, never shorten it ─────────────────
//
// Changed 2026-09-09. It used to replace the escalation outright, and two
// shapes exploited that: GeckoTerminal answers `Retry-After: 0`, which floors
// to 2 s and replaced 20 s — so the provider we have the least budget with
// was re-entered fastest — and any provider repeating a short wait defeated
// the 20 → 40 → 80 s ladder. Over-waiting only costs freshness; under-waiting
// is what produced the 429 storms this machinery exists for.
{
  stubFetch(() => res(429, '', { 'retry-after': '3' }));
  const r = await getJson('dexscreener', '/x');
  assert.equal(r.status, 429);
  const cooling = cooldownRemainingMs('dexscreener');
  assert.ok(cooling > 18_000 && cooling <= 20_000, `a shorter Retry-After does not shorten the 20 s floor: ${cooling}`);
  console.log('ok  a Retry-After shorter than our escalation does not shorten the park');
}

// A Retry-After LONGER than our escalation is still obeyed in full.
{
  stubFetch(() => res(429, '', { 'retry-after': '90' }));
  const r = await getJson('birdeye', '/x');
  assert.equal(r.status, 429);
  const cooling = cooldownRemainingMs('birdeye');
  assert.ok(cooling > 88_000 && cooling <= 90_000, `Retry-After: 90 → ~90 s park: ${cooling}`);
  console.log('ok  a longer Retry-After is obeyed in full');
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
  // The parser still floors a zero at 2 s. What changed 2026-09-09 is that
  // `park()` no longer lets that 2 s REPLACE its own 20/40/80 s escalation —
  // GeckoTerminal answers `Retry-After: 0`, and the provider we have the
  // least budget with was the one we re-entered fastest.
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

// ── 8. a 200 carrying a GeckoTerminal refusal parks, and never un-parks ──
{
  // GeckoTerminal answers a throttle with HTTP 200 and a JSON error body.
  // Before 2026-09-09 that took the success path, which ran
  // `blockedUntil.delete(id)` — so a polite refusal UN-PARKED a provider an
  // honest 429 had just parked.
  //
  // Park it honestly first, for longer than the escalation would choose, so
  // the assertion proves BOTH halves: the park survives, and it is not
  // shortened by the polite refusal's own (shorter) length.
  stubFetch(() => res(429, '', { 'retry-after': '60' }));
  await getJson('geckoterminal', '/honest');
  const parked = cooldownRemainingMs('geckoterminal');
  assert.ok(parked > 55_000, `an honest 429 parked GeckoTerminal for 60 s: ${parked}`);

  const refusal = JSON.stringify({
    status: { error_code: 429, error_message: "You've exceeded the Rate Limit. Please visit our pricing page." },
  });
  stubFetch(() => res(200, refusal, { 'content-type': 'application/json' }));
  const r = await getJson('geckoterminal', '/pretend', { priority: true });
  assert.equal(hits.length, 1, 'the call went out — this is a 200, not a fail-fast');
  assert.equal(r.ok, false, 'a 200 with a rate-limit body is NOT a success');
  assert.equal(r.data, undefined, 'no data is handed to the caller');
  assert.match(r.message, /rate limited/, `the message names the refusal: ${r.message}`);
  assert.match(r.message, /exceeded the Rate Limit/, "the provider's own words are kept");
  const after = cooldownRemainingMs('geckoterminal');
  assert.ok(after > 55_000, `the existing park survived the polite refusal: ${after}`);
  console.log('ok  a 200 carrying a refusal parks and does not clear an existing park');
}

// ── 9. a 200 carrying legitimate data is untouched ───────────────────────
{
  // The conservatism test. A false positive parks a working provider, which
  // is worse than the bug — so a row whose own TEXT talks about rate limits
  // must still be ordinary data.
  const legit = JSON.stringify({
    data: [{ symbol: 'RATELIMIT', name: 'Rate Limit', description: 'too many requests, ser' }],
  });
  stubFetch(() => res(200, legit, { 'content-type': 'application/json' }));
  const r = await getJson('pumpfun', '/coins');
  assert.equal(r.ok, true, 'legitimate data is still a success');
  assert.equal(r.message, 'ok');
  assert.equal(r.data.data[0].symbol, 'RATELIMIT', 'the payload is parsed and handed over unchanged');
  assert.equal(cooldownRemainingMs('pumpfun'), 0, 'nothing was parked');
  console.log('ok  legitimate data that talks about rate limits is left alone');
}

// ── 10. a JSON-RPC error inside a 200 ────────────────────────────────────
{
  // -32005 is "limit exceeded": a refusal, so it parks.
  const limited = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Too many requests' } });
  stubFetch(() => res(200, limited));
  const r = await getJson('helius', '/rpc', { json: {} });
  assert.equal(r.ok, false, 'a JSON-RPC error is not a success, whatever the HTTP status');
  assert.match(r.message, /rate limited/);
  const parked = cooldownRemainingMs('helius');
  assert.ok(parked > 18_000, `a JSON-RPC rate limit takes the park path: ${parked}`);

  // -32603 is an ordinary internal error: the call fails, but no park is
  // invented — and, the point of the branch, none is cleared either.
  const internal = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } });
  stubFetch(() => res(200, internal));
  const r2 = await getJson('helius', '/rpc', { json: {}, priority: true });
  assert.equal(r2.ok, false, 'an RPC error body never reads as success');
  assert.match(r2.message, /Internal error/);
  const still = cooldownRemainingMs('helius');
  assert.ok(still > 18_000, `an error body does not clear the park either: ${still}`);
  console.log('ok  JSON-RPC error bodies are classified, not accepted');
}

// ── 11. the classifier table itself ──────────────────────────────────────
{
  const json = { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) };
  const none = { get: () => null };

  // GeckoTerminal's other refusal form, the JSON:API error document.
  assert.equal(
    classifyBody('geckoterminal', 200, json, '{"errors":[{"status":"429","title":"Rate limit exceeded"}]}'),
    'refused',
  );
  // Same shape, a different problem: not data, but not a throttle.
  assert.equal(classifyBody('geckoterminal', 200, json, '{"errors":[{"status":"404","title":"Not found"}]}'), 'error');
  // A JSON:API document that carries `data` is never second-guessed.
  assert.equal(classifyBody('geckoterminal', 200, json, '{"data":[],"errors":[]}'), 'ok');
  // A bare `error` string only counts when it names throttling...
  assert.equal(classifyBody('dexscreener', 200, json, '{"error":"Too Many Requests"}'), 'refused');
  // ...and never demotes a working response otherwise.
  assert.equal(classifyBody('dexscreener', 200, json, '{"error":"no pools for this mint"}'), 'ok');
  // An `error` field is not a JSON-RPC envelope without `jsonrpc`.
  assert.equal(classifyBody('helius', 200, json, '{"id":1,"error":{"code":-32603,"message":"boom"}}'), 'ok');
  assert.equal(classifyBody('helius', 200, none, '{"jsonrpc":"2.0","id":1,"error":{"code":-32603}}'), 'error');
  // A batched RPC reply where one member was refused.
  assert.equal(
    classifyBody('helius', 200, none, '[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"error":{"code":-32005,"message":"limit"}}]'),
    'refused',
  );
  // Not JSON, not inspected. Too big, not inspected.
  assert.equal(classifyBody('geckoterminal', 200, none, 'rate limit exceeded'), 'ok');
  const huge = `{"error":"rate limit exceeded","pad":"${'x'.repeat(20_000)}"}`;
  assert.equal(classifyBody('dexscreener', 200, none, huge), 'ok', 'a big body is data, and is waved through unread');
  // An empty body is the "empty" success the layer already returns.
  assert.equal(classifyBody('jupiter', 200, none, ''), 'ok');
  console.log('ok  the refusal table matches only quoted shapes');
}

// ── 12. Jupiter's host, gap and window follow the key ────────────────────
{
  setJupiterApiKey('');
  assert.equal(jupiterKeyed(), false);
  const keyless = providerLimits('jupiter');
  assert.equal(keyless.host, 'lite-api.jup.ag', 'no key keeps the host the app uses today');
  assert.equal(keyless.gapMs, 120);
  assert.deepEqual(keyless.window, { n: 500, ms: 60_000 }, 'the window is the gap ceiling — Jupiter had none at all');

  setJupiterApiKey('  jup_test_key  ');
  assert.equal(jupiterKeyed(), true, 'the key is trimmed, not rejected for the spaces around it');
  const keyed = providerLimits('jupiter');
  assert.equal(keyed.host, 'api.jup.ag', 'a key moves off the retiring endpoint');
  assert.equal(keyed.gapMs, 1_000, 'and onto its documented 1 request/second');
  assert.deepEqual(keyed.window, { n: 60, ms: 60_000 }, 'the window followed the host — 8 rps there is an instant park');

  // No other provider moved.
  assert.equal(providerLimits('geckoterminal').host, 'api.geckoterminal.com');
  assert.deepEqual(providerLimits('geckoterminal').window, { n: 28, ms: 60_000 });
  console.log('ok  the Jupiter gap and window follow the host');
}

// ── 13. the key rides in a header, on the keyed host ─────────────────────
{
  stubFetch(() => res(200, '[]'));
  await getJson('jupiter', '/swap/v1/quote?x=1', { priority: true });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].url.startsWith('https://api.jup.ag/'), `the request went to the keyed host: ${hits[0].url}`);
  assert.ok(!hits[0].url.includes('jup_test_key'), 'the key is never in the URL — no URL crosses IPC, and URLs get logged');
  assert.equal(lastInit.headers['x-api-key'], 'jup_test_key', 'it rides in the header instead');

  setJupiterApiKey('');
  stubFetch(() => res(200, '[]'));
  await getJson('jupiter', '/tokens/v2/x', { priority: true });
  assert.ok(hits[0].url.startsWith('https://lite-api.jup.ag/'), 'clearing the key returns to the keyless host');
  assert.equal(lastInit.headers['x-api-key'], undefined, 'and sends no key header');
  console.log('ok  the Jupiter key travels as a header, never in the URL');
}


// ── A spent ALLOWANCE is not a rate limit (2026-09-16) ──────────────────
//
// MEASURED on a user's session: Birdeye answered
// `HTTP 400 — Compute units usage limit exceeded` and the app made 1,743
// calls collecting 1,743 errors. Only a 429 parked, and this is a 400, so
// every doomed call fired. A monthly allowance does not come back in twenty
// seconds and must not be retried as though it might.
{
  stubFetch(() => res(400, JSON.stringify({ message: 'Compute units usage limit exceeded' })));
  // `merkl` rather than `birdeye`: the tests above already parked birdeye,
  // and a call that never leaves the queue would measure nothing here.
  const r = await getJson('merkl', '/quota-one');
  assert.equal(r.ok, false);
  assert.match(r.message, /allowance spent/, r.message);
  assert.match(r.message, /Compute units/, 'and it quotes the provider');
  const cooling = cooldownRemainingMs('merkl');
  assert.ok(cooling > 60 * 60_000, `parked for HOURS, not seconds — got ${Math.round(cooling / 1000)}s`);

  // And the next call does not reach the host at all. That is the whole
  // point: 1,743 became 1.
  const before = hits.length;
  const again = await getJson('merkl', '/quota-two');
  assert.equal(hits.length, before, 'no second request was made');
  assert.equal(again.ok, false);
  console.log('ok  a spent allowance parks for hours and stops the retries');
}

// A plain 4xx that is NOT about allowance keeps its old behaviour — a park
// of hours on an ordinary "not tradable" would silence a working provider.
{
  stubFetch(() => res(400, JSON.stringify({ message: 'Could not find any route' })));
  const r = await getJson('lifi', '/ordinary-400');
  assert.equal(r.ok, false);
  assert.ok(!/allowance spent/.test(r.message), r.message);
  assert.equal(cooldownRemainingMs('lifi'), 0, 'an ordinary refusal parks nothing, as before');
  console.log('ok  an ordinary 4xx is not mistaken for a spent plan');
}

// ── The net under everything: a provider that just keeps failing ────────
//
// The classifier above has to RECOGNISE a phrase. This does not have to
// understand anything — it counts. It is the general form of the Birdeye
// case and would have stopped it at ten instead of seventeen hundred.
{
  stubFetch(() => {
    throw new Error('fetch failed');
  });
  let made = 0;
  for (let i = 0; i < 14; i += 1) {
    const before = hits.length;
    await getJson('lifi-status', `/dead-${i}`);
    if (hits.length > before) made += 1;
  }
  assert.ok(made <= 10, `stopped calling after a streak — ${made} of 14 reached the host`);
  assert.ok(cooldownRemainingMs('lifi-status') > 0, 'and the provider is parked');
  console.log('ok  a provider failing in an unbroken streak is stood down, whatever the reason');
}

// One good answer ends it. The streak is about a provider that is not
// working now, never about its lifetime record.
{
  let fail = true;
  stubFetch(() => (fail ? res(500) : res(200, '{"a":1}')));
  for (let i = 0; i < 9; i += 1) await getJson('rugcheck', `/flap-${i}`);
  fail = false;
  const good = await getJson('rugcheck', '/recovered');
  assert.equal(good.ok, true, 'the ninth failure did not park it');
  fail = true;
  const before = hits.length;
  await getJson('rugcheck', '/after');
  assert.equal(hits.length, before + 1, 'and the counter restarted from the success');
  console.log('ok  one success clears the streak');
}


// A 429 is a RATE limit and must never be read as a spent plan, however it
// is worded. Free providers 429 constantly, and a six-hour park on one that
// was merely throttled is far worse than a slow stand-down on one that is
// genuinely spent — the failure-streak breaker covers that case anyway.
{
  stubFetch(() => res(429, JSON.stringify({ message: 'monthly limit exceeded' }), { 'retry-after': '5' }));
  const r = await getJson('rugcheck', '/throttle-worded-like-quota');
  assert.equal(r.ok, false);
  assert.ok(!/allowance spent/.test(r.message), r.message);
  const cooling = cooldownRemainingMs('rugcheck');
  assert.ok(cooling > 0 && cooling <= 120_000, `a normal 429 park, not hours — got ${Math.round(cooling / 1000)}s`);
  console.log('ok  a 429 is a rate limit whatever words it carries');
}

// Durations people can read. "retrying in 21596s" is what a six-hour park
// looked like in a message written when every park was seconds.
{
  assert.equal(humanWait(4_000), '4s');
  assert.equal(humanWait(89_000), '89s');
  assert.equal(humanWait(90_000), '2 min');
  assert.equal(humanWait(21_596_000), '6 h');
  console.log('ok  a wait is rendered in units a person reads');
}

console.log('\nhttp layer: all rate-limit rules hold');
