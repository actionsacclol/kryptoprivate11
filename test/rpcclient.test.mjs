// The RPC client against the endpoint's own accounting — rules from the API
// swarm of 2026-09-09. Three things are pinned here:
//
//   1. A refusal the server scopes to ONE method parks that method only, and
//      a method the server publishes a limit of 0 for is never asked at all.
//      A `getTokenLargestAccounts` 429 (limit 0 on the free tier, so it is
//      guaranteed on a default install) used to park the whole HOST for the
//      maximum 10 s and take balances, blockhash, account reads and fill
//      detection down with it.
//   2. The limiter is driven by `x-ratelimit-method-limit` / `-rps-limit`,
//      seeded from the measured floors, per host — a keyed endpoint that
//      publishes no headers never inherits the public endpoint's budgets.
//   3. A refusal that does not look like one — a rate limit delivered as a
//      JSON-RPC error inside HTTP 200, or a Cloudflare bot challenge wearing
//      a 403 — reaches the same park and failover as an honest 429, and the
//      challenge never gets a working key banned.
//
// Nothing here touches the network: every response is a stub, and the
// budgets asserted are the ones measured once, on 2026-09-09, from the
// endpoint's own headers.
import assert from 'node:assert';
import { mentionsRateLimit } from './.rpcerrors.mjs';
import {
  clearRpcRejections,
  getBalance,
  getSignaturesForAddress,
  getSignatureStatuses,
  getSlot,
  getTokenLargestAccounts,
  isEndpointRejected,
  rpcCredentialsRejected,
  rpcMethodBudget,
  rpcParkRemainingMs,
  setRpcFallback,
} from './.rpcclient.mjs';

const KEY = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const KEYED = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const ALCHEMY = `https://solana-mainnet.g.alchemy.com/v2/${KEY}`;
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const MINT = 'So11111111111111111111111111111111111111112';
const OWNER = 'So11111111111111111111111111111111111111112';

let hits = [];
function stubFetch(handler) {
  hits = [];
  globalThis.fetch = async (url, init) => {
    hits.push(url);
    return handler(url, hits.length, init);
  };
}
const headers = (h) => ({ get: (n) => h[String(n).toLowerCase()] ?? null });

/** What the public endpoint answers a method it does not serve. */
const methodClosed429 = () => ({
  ok: false,
  status: 429,
  headers: headers({
    'retry-after': '10',
    'x-ratelimit-tier': 'free',
    'x-ratelimit-method-limit': '0',
    'x-ratelimit-method-remaining': '0',
    'x-ratelimit-rps-limit': '250',
  }),
  text: async () => 'Too many requests for a specific RPC call, contact your app developer or support@rpcpool.com.',
  json: async () => ({}),
});
/** A host-level refusal: no method accounting, just "stop". */
const host429 = () => ({
  ok: false,
  status: 429,
  headers: headers({ 'retry-after': '5' }),
  text: async () => 'Too many requests from this IP address.',
  json: async () => ({}),
});
const balance = (n, extra = {}) => ({
  ok: true,
  status: 200,
  headers: headers(extra),
  json: async () => ({ jsonrpc: '2.0', result: { value: n } }),
});
const slot = (n, extra = {}) => ({
  ok: true,
  status: 200,
  headers: headers(extra),
  json: async () => ({ jsonrpc: '2.0', result: n }),
});
const statuses = () => ({ ok: true, status: 200, headers: headers({}), json: async () => ({ jsonrpc: '2.0', result: { value: [null] } }) });
const signatures = () => ({ ok: true, status: 200, headers: headers({}), json: async () => ({ jsonrpc: '2.0', result: [] }) });
/** HTTP 200, and inside it "you are asking too often". */
const politeRefusal = () => ({
  ok: true,
  status: 200,
  headers: headers({}),
  json: async () => ({ jsonrpc: '2.0', error: { code: -32603, message: 'Too many requests, please slow down' } }),
});
/** Cloudflare's "prove you are a browser" page, wearing a 403. */
const challenge403 = () => ({
  ok: false,
  status: 403,
  headers: headers({ 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' }),
  text: async () => '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>',
  json: async () => ({}),
});

const logs = [];
const notices = [];
const noFallback = () => setRpcFallback(() => '', (l) => logs.push(l), (l) => notices.push(l));
const publicFallback = () => setRpcFallback(() => PUBLIC, (l) => logs.push(l), (l) => notices.push(l));

// ── 1. the measured floors are the cold-start seeds ──────────────────────
{
  assert.equal(rpcMethodBudget(PUBLIC, 'getBalance'), 150, 'getBalance: 150 per 10 s window');
  assert.equal(rpcMethodBudget(PUBLIC, 'getLatestBlockhash'), 100);
  assert.equal(rpcMethodBudget(PUBLIC, 'getAccountInfo'), 50);
  assert.equal(rpcMethodBudget(PUBLIC, 'getSignatureStatuses'), 10, 'indexed reads get 10, not the old flat 40');
  assert.equal(rpcMethodBudget(PUBLIC, 'getSignaturesForAddress'), 10);
  assert.equal(rpcMethodBudget(PUBLIC, 'getTokenAccountsByOwner'), 10);
  assert.equal(rpcMethodBudget(PUBLIC, 'getTokenLargestAccounts'), 0, 'closed on the free tier, not throttled');
  assert.equal(rpcMethodBudget(KEYED, 'getTokenLargestAccounts'), null, 'a keyed host inherits none of that');
  assert.equal(rpcMethodBudget(KEYED, 'getSignatureStatuses'), null);
  console.log("ok  the limiter starts from the endpoint's measured per-method budgets");
}

// ── 2. the doomed lookup costs nothing and blinds nothing ────────────────
{
  clearRpcRejections();
  noFallback();
  stubFetch(() => methodClosed429());
  const r = await getTokenLargestAccounts(PUBLIC, MINT);
  assert.equal(r.ok, false);
  assert.equal(hits.length, 0, 'a method the endpoint publishes a limit of 0 for is not asked');
  assert.match(r.message, /429|too many/i, 'in the shape onchain.topHolders already reads');
  assert.equal(mentionsRateLimit(r.message), true, 'and the shape the sell retry reads');
  assert.equal(rpcParkRemainingMs(PUBLIC), 0, 'and NOTHING on the host is parked');

  // The token page does this three times per visit; the balance read that
  // follows must be untouched by it.
  stubFetch(() => balance(1234));
  const t0 = Date.now();
  const b = await getBalance(PUBLIC, OWNER);
  assert.equal(b.data, 1234);
  assert.deepEqual(hits, [PUBLIC], 'one call, no failover');
  assert.ok(Date.now() - t0 < 400, 'and no park wait was served');
  console.log('ok  a doomed holder lookup neither spends a request nor blinds the host');
}

// ── 3. a method-scoped 429 parks that method only ────────────────────────
{
  const M = 'https://metered.example.test/';
  noFallback();
  stubFetch(() => methodClosed429());
  const r = await getSignaturesForAddress(M, OWNER, 5);
  assert.equal(r.ok, false);
  assert.equal(hits.length, 1, 'one refusal, no same-host retry storm');

  const methodPark = rpcParkRemainingMs(M, 'getSignaturesForAddress');
  assert.ok(methodPark > 9_000, `the method carries its own Retry-After: ${methodPark} ms`);
  assert.equal(rpcParkRemainingMs(M), 0, 'the HOST is not parked');
  assert.equal(rpcParkRemainingMs(M, 'getBalance'), 0, 'so balances are not collateral damage');
  assert.equal(rpcParkRemainingMs(M, 'getLatestBlockhash'), 0, 'nor the blockhash the trade path needs');
  assert.equal(rpcMethodBudget(M, 'getSignaturesForAddress'), 0, 'and the endpoint is now known to close it');

  stubFetch(() => balance(9));
  const t0 = Date.now();
  const b = await getBalance(M, OWNER);
  assert.equal(b.data, 9);
  assert.deepEqual(hits, [M], 'every other method still goes straight out');
  assert.ok(Date.now() - t0 < 400, `no park wait: ${Date.now() - t0} ms`);

  stubFetch(() => methodClosed429());
  const again = await getSignaturesForAddress(M, OWNER, 5);
  assert.equal(again.ok, false);
  assert.equal(hits.length, 0, 'and the closed method is refused locally from now on');
  console.log('ok  a method-scoped 429 parks the method, never the endpoint');
}

// ── 4. a host-level 429 still parks the whole host ───────────────────────
{
  const LONE = 'https://lone.example.test/';
  noFallback();
  stubFetch((_url, n) => (n === 1 ? host429() : slot(7)));
  const r = await getSlot(LONE);
  assert.equal(r.ok, true, 'it still recovers');
  assert.ok(rpcParkRemainingMs(LONE) > 0, 'a refusal that names no method parks the host, as before');
  assert.ok(rpcParkRemainingMs(LONE, 'getBalance') > 0, 'which every method must observe');
  console.log('ok  a genuine host-level 429 still parks the host');
}

// ── 5. the server's own headers drive the buckets ────────────────────────
{
  const OTHER = 'https://headers.example.test/';
  assert.equal(rpcMethodBudget(OTHER, 'getSlot'), null, 'unknown host, no budget assumed');
  stubFetch(() => slot(3, { 'x-ratelimit-method-limit': '25', 'x-ratelimit-method-remaining': '24', 'x-ratelimit-rps-limit': '250' }));
  const r = await getSlot(OTHER);
  assert.equal(r.data, 3);
  assert.equal(rpcMethodBudget(OTHER, 'getSlot'), 25, 'the budget is now what the server said it is');
  assert.equal(rpcMethodBudget(OTHER, 'getBalance'), null, 'stated per method, not spread across the host');
  stubFetch(() => slot(4, { 'x-ratelimit-method-limit': '5' }));
  await getSlot(OTHER);
  assert.equal(rpcMethodBudget(OTHER, 'getSlot'), 5, 'a revision downwards is honoured');
  assert.equal(rpcMethodBudget(KEYED, 'getSlot'), null, 'and never leaks to a host that published nothing');
  console.log('ok  x-ratelimit-method-limit drives the limiter, per host and per method');
}

// ── 6. those budgets are actually spent at the stated rate ───────────────
{
  noFallback();
  stubFetch(() => balance(1));
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => getBalance(PUBLIC, OWNER)));
  const generous = Date.now() - t0;
  stubFetch(() => statuses());
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => getSignatureStatuses(PUBLIC, ['sig'])));
  const indexed = Date.now() - t1;
  assert.ok(generous < 300, `a 150-budget method is not paced at all: ${generous} ms`);
  assert.ok(indexed >= 1_500, `four getSignatureStatuses are paced to 10 per 10 s: ${indexed} ms`);
  console.log('ok  the tight budgets are paced and the generous ones are let through');
}

// ── 7. a rate limit inside HTTP 200 parks and fails over ─────────────────
{
  clearRpcRejections();
  publicFallback();
  stubFetch((url) => (url === KEYED ? politeRefusal() : balance(88)));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.ok, true, 'the read is answered by the healthy fallback');
  assert.equal(r.data, 88);
  assert.deepEqual(hits, [KEYED, PUBLIC], 'one polite refusal, one failover');
  assert.ok(rpcParkRemainingMs(KEYED, 'getBalance') > 0, 'the refusing host is parked');
  assert.equal(isEndpointRejected(KEYED), false, 'a rate limit is not a bad key');

  // With nowhere to fail over to, the message must still read as a rate
  // limit — that is what the sell retry and the order re-arm branch on.
  noFallback();
  const SOLO = 'https://polite.example.test/';
  stubFetch(() => politeRefusal());
  const r2 = await getBalance(SOLO, OWNER);
  assert.equal(r2.ok, false);
  assert.equal(mentionsRateLimit(r2.message), true, 'so the sell retry and order re-arm fire');
  assert.match(r2.message, /slow down/, "and the server's own words survive");
  assert.ok(rpcParkRemainingMs(SOLO, 'getBalance') > 0, 'and it is parked');
  console.log('ok  a JSON-RPC rate limit inside HTTP 200 parks and fails over');
}

// ── 8. a Cloudflare challenge is not a rejected key ──────────────────────
{
  clearRpcRejections();
  publicFallback();
  const before = notices.length;
  stubFetch((url) => (url === ALCHEMY ? challenge403() : balance(31)));
  const r = await getBalance(ALCHEMY, OWNER);
  assert.equal(r.ok, true, 'the read is served by the other endpoint');
  assert.equal(r.data, 31);
  assert.equal(isEndpointRejected(ALCHEMY), false, 'the working key is NOT banned for 15 minutes');
  assert.equal(rpcCredentialsRejected(), null, 'and the user is not told to replace it');
  assert.equal(notices.length, before, 'no credentials notice at all');
  assert.ok(hits.includes(PUBLIC), 'the challenge failed over like the outage it is');

  // With no fallback the message has to name the real problem.
  noFallback();
  const CHAL = 'https://challenged.example.test/';
  stubFetch(() => challenge403());
  const r2 = await getBalance(CHAL, OWNER);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /bot challenge/i);
  assert.ok(!/Settings/.test(r2.message), 'never "go and fix your key"');
  assert.equal(isEndpointRejected(CHAL), false);
  console.log('ok  a Cloudflare challenge is an outage, not a rejected key');
}

console.log("\nrpc client: the endpoint's own accounting is respected");
