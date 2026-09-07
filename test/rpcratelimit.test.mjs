// The RPC client under a 429 — rules from the rate-limit swarm of
// 2026-09-06. A 429 on the keyed endpoint used to be retried on the same
// host 400 ms later by every concurrent caller; now the host is parked and
// remembered, reads go to the other endpoint while it lasts, a caller with
// nowhere else to go waits the park out (bounded), and bursts are paced by a
// per-host bucket before they can 429 at all.
import assert from 'node:assert';
import {
  clearRpcRejections,
  getBalance,
  getSlot,
  noteSocketRateLimit,
  rpcParkRemainingMs,
  setRpcFallback,
  socketParkRemainingMs,
} from './.rpcclient.mjs';

const KEY = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const KEYED = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const LONE = 'https://rpc.example.test/';
const OWNER = 'So11111111111111111111111111111111111111112';

let hits = [];
function stubFetch(handler) {
  hits = [];
  globalThis.fetch = async (url) => {
    hits.push(url);
    return handler(url, hits.length);
  };
}
const limited = (retryAfter = null) => ({
  ok: false,
  status: 429,
  headers: { get: (n) => (n === 'retry-after' ? retryAfter : null) },
  json: async () => ({}),
});
const balance = (n) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', result: { value: n } }) });
const slot = (n) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', result: n }) });

const logs = [];
setRpcFallback(
  () => PUBLIC,
  (l) => logs.push(l),
  () => undefined,
);

// ── keyed 429 → answered by the public endpoint, keyed parked ────────────
{
  clearRpcRejections();
  stubFetch((url) => (url === KEYED ? limited() : balance(4200)));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.ok, true, 'the read succeeds');
  assert.equal(r.data, 4200, 'answered by the public endpoint');
  assert.deepEqual(hits, [KEYED, PUBLIC], 'one refused call, one failover — no same-host retry');
  const park = rpcParkRemainingMs(KEYED);
  assert.ok(park > 500 && park <= 1_000, `first 429 parks the host ~1 s: ${park}`);
  assert.equal(logs.length, 1, 'the user is told once');
  assert.ok(!logs[0].includes(KEY), 'and never shown their key');
  assert.match(logs[0], /rate limited/);
  console.log('ok  a 429 fails over instead of retrying the same host');
}

// ── while parked, the keyed host is not even asked ───────────────────────
{
  stubFetch(() => balance(77));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.data, 77);
  assert.deepEqual(hits, [PUBLIC], 'the parked endpoint is skipped entirely');
  console.log('ok  a parked host is skipped while the park lasts');
}

// ── no fallback: wait the park out, then retry once ──────────────────────
{
  setRpcFallback(() => '', (l) => logs.push(l));
  stubFetch((_url, n) => (n === 1 ? limited() : slot(9)));
  const t0 = Date.now();
  const r = await getSlot(LONE);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.data, 9);
  assert.deepEqual(hits, [LONE, LONE], 'one refusal, one retry after the park');
  assert.ok(elapsed >= 900, `waited the ~1 s park before retrying: ${elapsed} ms`);
  console.log('ok  with nowhere to fail over, the park is waited out, bounded');
}

// ── Retry-After is honoured, the wait is capped ──────────────────────────
{
  const HOST = 'https://another.example.test/';
  stubFetch((_url, n) => (n === 1 ? limited('3') : slot(1)));
  const t0 = Date.now();
  const r = await getSlot(HOST);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed >= 2_300 && elapsed < 4_000, `Retry-After: 3 → park 3 s, wait capped at 2.5 s (+jitter): ${elapsed} ms`);
  console.log('ok  Retry-After sets the park; the trade-path wait is capped');
}

// ── a burst on the public host is paced, not fired at once ───────────────
{
  setRpcFallback(() => '', (l) => logs.push(l));
  stubFetch(() => slot(5));
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 12 }, () => getSlot(PUBLIC)));
  const elapsed = Date.now() - t0;
  assert.ok(results.every((r) => r.ok && r.data === 5));
  assert.equal(hits.length, 12, 'every call went out — nothing was dropped');
  // Per-method window: 8 burst then 4/s, so twelve calls need ≥ ~1 s.
  assert.ok(elapsed >= 700, `twelve same-method calls are spread by the 4/s method bucket: ${elapsed} ms`);
  console.log('ok  bursts are paced by the per-host bucket');
}

// ── websocket handshake 429 parks the host for every socket class ────────
{
  assert.equal(noteSocketRateLimit(KEYED.replace('https', 'wss'), 'Unexpected server response: 429'), true);
  const park = socketParkRemainingMs(KEYED.replace('https', 'wss'));
  assert.ok(park > 29_000 && park <= 30_000, `30 s socket park: ${park}`);
  assert.equal(noteSocketRateLimit('wss://api.mainnet-beta.solana.com', 'Unexpected server response: 401'), false);
  assert.equal(socketParkRemainingMs('wss://api.mainnet-beta.solana.com'), 0);
  console.log('ok  a handshake 429 parks the host for sockets');
}

console.log('\nrpc client: all rate-limit rules hold');
