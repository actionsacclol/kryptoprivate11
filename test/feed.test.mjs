// Feed socket lifecycle tests, pinning the audited P1:
// - `live` is NOT reported on socket open — only on the subscribe ack
//   (result = subscription id) or the first notification
// - a JSON-RPC error reply to logsSubscribe ("Too many subscriptions", rate
//   limit, invalid params) is surfaced with the server's message and the
//   socket reconnects with backoff instead of sitting "live" with 0 events
// - no ack and no data within the ack window → reconnect
// - backoff does NOT reset on open (accept-and-close endpoints would
//   tight-loop); it resets after a notification or a long-enough open
// - reconnect delay carries ±25% jitter
//
// Uses a real in-process `ws` WebSocketServer: feed.ts talks to it exactly
// as it would to an RPC provider.

import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { FeedManager, jitteredDelay } from './.feed.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spin up a server; `onConn(ws, n)` is called per connection (1-based). */
async function server(onConn) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  let n = 0;
  wss.on('connection', (ws) => onConn(ws, ++n));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  return { url, wss, close: () => new Promise((r) => wss.close(() => r())) };
}

/** Recorder for FeedCallbacks. */
function recorder() {
  const states = [];
  const logs = [];
  const subErrors = [];
  return {
    states,
    logs,
    subErrors,
    cb: {
      onLogs: (n) => logs.push(n),
      onState: (state, detail) => states.push({ state, detail }),
      onSubscribeError: (host, message) => subErrors.push({ host, message }),
    },
  };
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return false;
}

const notification = (sig, slot = 1) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: { subscription: 42, result: { context: { slot }, value: { signature: sig, err: null, logs: ['Program log: x'] } } },
  });

// Fast timings so the suite stays quick.
const FAST = { initialBackoffMs: 100, maxBackoffMs: 2000, backoffResetAfterMs: 150, subscribeAckTimeoutMs: 150 };

// ── jitter is pure and bounded ───────────────────────────────────────────
{
  assert.equal(jitteredDelay(1000, 0), 750);
  assert.equal(jitteredDelay(1000, 0.5), 1000);
  assert.equal(jitteredDelay(1000, 0.999999), 1250);
  for (let i = 0; i < 200; i++) {
    const d = jitteredDelay(1000);
    assert.ok(d >= 750 && d <= 1250, `jitter within ±25%: ${d}`);
  }
  console.log('ok  reconnect jitter is ±25%');
}

// ── open alone is not live; ack = live ────────────────────────────────────
{
  const received = [];
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      received.push(req);
      // Ack on a delay so we can observe the pre-ack state.
      setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 7 })), 60);
    });
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, 'Prog111', { ...FAST, subscribeAckTimeoutMs: 5000 });
  feed.start();
  assert.ok(await waitFor(() => received.length === 1));
  assert.equal(received[0].method, 'logsSubscribe');
  assert.equal(feed.getState(), 'connecting', 'open + subscribe sent is still connecting, not live');
  assert.ok(!r.states.some((x) => x.state === 'live'), 'no live before the ack');
  assert.ok(await waitFor(() => feed.getState() === 'live'));
  const live = r.states.find((x) => x.state === 'live');
  assert.match(live.detail, /subscribed \(id 7\)/);
  assert.equal(feed.getStats()[0].state, 'live');
  feed.stop();
  await s.close();
  console.log('ok  live only on subscribe ack');
}

// ── a notification before any ack also proves the subscription ──────────
{
  const s = await server((ws) => {
    ws.on('message', () => ws.send(notification('sigA', 5)));
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, 'Prog111', FAST);
  feed.start();
  assert.ok(await waitFor(() => r.logs.length === 1));
  assert.equal(feed.getState(), 'live');
  assert.match(r.states.find((x) => x.state === 'live').detail, /first notification/);
  assert.equal(r.logs[0].signature, 'sigA');
  assert.equal(feed.lastSlot, 5);
  feed.stop();
  await s.close();
  console.log('ok  first notification flips to live');
}

// ── error reply: surfaced with the server message, then reconnect ────────
{
  let conns = 0;
  const s = await server((ws, n) => {
    conns = n;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (n === 1) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Too many subscriptions' } }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 9 }));
      }
    });
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, 'Prog111', FAST);
  feed.start();
  assert.ok(await waitFor(() => r.subErrors.length === 1));
  assert.match(r.subErrors[0].message, /Too many subscriptions/);
  assert.match(r.subErrors[0].message, /code -32602/);
  const rec = r.states.find((x) => x.state === 'reconnecting');
  assert.ok(rec, 'rejection moves the socket to reconnecting');
  assert.match(rec.detail, /subscribe rejected .*Too many subscriptions/);
  assert.ok(!r.states.slice(0, r.states.indexOf(rec)).some((x) => x.state === 'live'), 'never live before the rejection');
  // ...and it comes back on its own, going live once the server accepts.
  assert.ok(await waitFor(() => conns >= 2 && feed.getState() === 'live'));
  feed.stop();
  await s.close();
  console.log('ok  rejected subscribe is loud and reconnects');
}

// ── silent server: no ack, no data → reconnect, never live ───────────────
{
  let conns = 0;
  const s = await server((_ws, n) => {
    conns = n; // accept, say nothing
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, 'Prog111', FAST);
  feed.start();
  assert.ok(await waitFor(() => conns >= 2));
  assert.ok(!r.states.some((x) => x.state === 'live'));
  assert.ok(r.states.some((x) => /unacknowledged/.test(x.detail)));
  feed.stop();
  await s.close();
  console.log('ok  unacknowledged subscribe reconnects instead of sitting live');
}

// ── backoff: not reset by a bare open; reset after a healthy open ────────
{
  const at = [];
  const s = await server((ws, n) => {
    at.push(Date.now());
    if (n <= 3) {
      ws.close(); // accept-and-close: the tight-loop trap
    } else if (n === 4) {
      setTimeout(() => ws.close(), 400); // stays open past backoffResetAfterMs (150)
    } // n >= 5: stays open
  });
  const r = recorder();
  // JITTER PINNED TO THE MIDDLE, so the delays are exactly 100/200/400/100.
  //
  // This block is about the BACKOFF, and it cannot also be sampling the
  // jitter: with ±25% on each delay, 100 ms reaches 125 and 200 ms starts at
  // 150, so "did it grow?" came down to a 20 % margin measured off a real
  // clock — and a busy machine failed it (139,154,435,493 on 2026-09-22)
  // while the code was perfectly correct. The jitter has its own test above.
  const feed = new FeedManager([s.url], 'processed', r.cb, 'Prog111', {
    ...FAST,
    subscribeAckTimeoutMs: 5000,
    rnd: () => 0.5,
  });
  feed.start();
  assert.ok(await waitFor(() => at.length >= 5, 6000));
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  // DIFFERENCES, not ratios. Every gap carries the same connect overhead on
  // top of its delay, and overhead is additive — so it cancels in a
  // subtraction and inflates a ratio. Each step should add ~100 then ~200;
  // half of that is the margin, which no amount of load turns negative.
  assert.ok(gaps[1] - gaps[0] > 50, `backoff grows despite the open: ${gaps.join(',')}`);
  assert.ok(gaps[2] - gaps[1] > 100, `backoff keeps growing: ${gaps.join(',')}`);
  assert.ok(gaps[2] >= 300, `third delay is ~400ms, not 100: ${gaps.join(',')}`);
  // gaps[3] = 400ms open + a reset (~100ms) delay. Had the backoff kept
  // doubling it would be 400 + 800; anything under ~750 can only be a reset,
  // and that gives 250ms of slack for a slow machine.
  assert.ok(gaps[3] < 750, `healthy open resets backoff: ${gaps.join(',')}`);
  feed.stop();
  await s.close();
  console.log('ok  backoff survives accept-and-close, resets after a healthy open');
}

// ── stop() during backoff never reconnects ───────────────────────────────
{
  let conns = 0;
  const s = await server((ws, n) => {
    conns = n;
    ws.close();
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, 'Prog111', FAST);
  feed.start();
  assert.ok(await waitFor(() => conns === 1));
  feed.stop();
  await sleep(300);
  assert.equal(conns, 1);
  assert.equal(feed.getState(), 'stopped');
  await s.close();
  console.log('ok  stop cancels pending reconnect');
}

console.log('feed: all tests passed');

// ═══════════════════════════════════════════════════════════════════════
// Block-feed standby (2026-08-30 feed insurance)
// ═══════════════════════════════════════════════════════════════════════
//
// The fixture is a real confirmed block transaction captured from publicnode
// blockSubscribe (test/fixtures/block-cpi.json): one pump buy carrying its
// TradeEvent as an emit_cpi inner instruction. The block socket must decode
// it from the inner instruction alone, and the pool dedupe must let that
// copy through when the log copy that arrived first decoded nothing.

import { readFileSync } from 'node:fs';
import { BlockFeedSocket } from './.feed.mjs';
import { decodeCpiEventData, decodeLogs } from './.decoder.mjs';
import { base58Encode } from './.b58.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const BLOCK_FX = JSON.parse(readFileSync(new URL('./fixtures/block-cpi.json', import.meta.url), 'utf8'));
const pumpTx = BLOCK_FX.pump.tx;
const pumpSlot = BLOCK_FX.pump.slot;
/** Signature straight off the wire bytes: compact-u16 count, then 64 bytes. */
const wireSig = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return base58Encode(buf.subarray(1, 65));
};
const PUMP_SIG = wireSig(pumpTx.transaction[0]);
assert.ok(PUMP_SIG.length >= 86, 'fixture signature parses');

const blockNotification = (txs, slot = pumpSlot) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'blockNotification',
    params: { subscription: 7, result: { context: { slot }, value: { slot, err: null, block: { transactions: txs } } } },
  });

const stubPool = () => ({ onNotification: () => {}, onSocketState: () => {}, onSubscribeError: () => {} });

// ── a real block tx decodes to exactly one inner TradeEvent ─────────────
{
  const sock = new BlockFeedSocket('ws://127.0.0.1:1', PUMP, decodeCpiEventData, stubPool(), FAST);
  const n = sock.decodeTx(pumpTx, pumpSlot, 123);
  assert.ok(n, 'a pump tx with an emit_cpi TradeEvent yields a notification');
  assert.equal(n.signature, PUMP_SIG);
  assert.equal(n.slot, pumpSlot);
  assert.equal(n.receivedAt, 123);
  assert.ok(Array.isArray(n.logs) && n.logs.length > 0, 'the log lines ride along');
  const trades = n.innerEvents.filter((e) => e.kind === 'trade');
  assert.equal(trades.length, 1, `exactly one trade from the inner ix, got ${n.innerEvents.map((e) => e.kind)}`);
  assert.equal(typeof trades[0].solAmount, 'bigint');
  assert.ok(trades[0].virtualSolReserves > 0n && trades[0].virtualTokenReserves > 0n);
  assert.ok(trades[0].mint.length >= 32);
  // The same trade is ALSO in the logs today (double-emit): the block path
  // must decode the CPI copy and the consumer must not add the two.
  const fromLogs = decodeLogs(n.logs).filter((e) => e.kind === 'trade');
  assert.equal(fromLogs.length, 1);
  assert.equal(fromLogs[0].mint, trades[0].mint);
  assert.equal(fromLogs[0].solAmount, trades[0].solAmount);
  // Whether pump sits in the static table or came via a lookup table is up
  // to the captured tx; either way the index resolved to the program.
  const viaAlt = (pumpTx.meta.loadedAddresses?.readonly ?? []).includes(PUMP) || (pumpTx.meta.loadedAddresses?.writable ?? []).includes(PUMP);
  console.log(`ok  block tx → one innerEvents trade (real fixture, program ${viaAlt ? 'ALT-loaded' : 'static'})`);
}

// ── txs without a pump inner ix, or failed, are skipped cheaply ─────────
{
  const sock = new BlockFeedSocket('ws://127.0.0.1:1', PUMP, decodeCpiEventData, stubPool(), FAST);
  const noPump = { ...pumpTx, meta: { ...pumpTx.meta, logMessages: ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'] } };
  assert.equal(sock.decodeTx(noPump, pumpSlot, 1), null, 'no pump invoke line → skipped before any parse');
  const failed = { ...pumpTx, meta: { ...pumpTx.meta, err: { InstructionError: [2, 'Custom'] } } };
  assert.equal(sock.decodeTx(failed, pumpSlot, 1), null, 'meta.err → skipped');
  const noInner = { ...pumpTx, meta: { ...pumpTx.meta, innerInstructions: [] } };
  assert.equal(sock.decodeTx(noInner, pumpSlot, 1), null, 'no inner instructions → nothing to decode');
  const garbage = { ...pumpTx, transaction: ['!!!not-base64-wire', 'base64'] };
  assert.equal(sock.decodeTx(garbage, pumpSlot, 1), null, 'malformed wire bytes → skipped, never thrown');
  console.log('ok  block txs without a pump inner ix are skipped');
}

// ── block socket lifecycle: blockSubscribe sent, ack = live, error → backoff
{
  const received = [];
  let conns = 0;
  const s = await server((ws, n) => {
    conns = n;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      received.push(req);
      if (n === 1) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }));
      } else {
        setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 55 })), 40);
      }
    });
  });
  const r = recorder();
  // No log sockets at all: the block socket is the whole pool here.
  const feed = new FeedManager([], 'processed', r.cb, PUMP, { ...FAST, subscribeAckTimeoutMs: 5000 }, { urls: [s.url], decodeInner: decodeCpiEventData });
  feed.start();
  assert.ok(await waitFor(() => received.length === 1));
  assert.equal(received[0].method, 'blockSubscribe');
  assert.deepEqual(received[0].params[0], { mentionsAccountOrProgram: PUMP });
  assert.deepEqual(received[0].params[1], {
    commitment: 'confirmed',
    encoding: 'base64',
    transactionDetails: 'full',
    showRewards: false,
    // v1 (SIMD-0385) since 2026-09-15: a block holding one v1 transaction is
    // refused whole to a subscriber that only takes v0.
    maxSupportedTransactionVersion: 1,
  });
  // -32601 is exactly what Helius free answers: loud, then backoff.
  assert.ok(await waitFor(() => r.subErrors.length === 1));
  assert.match(r.subErrors[0].message, /Method not found/);
  assert.match(r.subErrors[0].message, /code -32601/);
  assert.ok(r.states.some((x) => x.state === 'reconnecting' && /subscribe rejected/.test(x.detail)));
  assert.ok(!r.states.slice(0, r.states.findIndex((x) => x.state === 'reconnecting')).some((x) => x.state === 'live'), 'never live before the rejection');
  assert.ok(await waitFor(() => conns >= 2 && feed.getState() === 'live'));
  const st = feed.getStats();
  assert.equal(st.length, 1);
  assert.equal(st[0].host, `127.0.0.1:${new URL(s.url).port}:block`, 'block sockets are tagged :block in status');
  assert.equal(st[0].state, 'live');
  const det = feed.getDetails();
  assert.equal(det[0].kind, 'block');
  assert.ok(det[0].bytes > 0, 'bytes are metered for billing');
  feed.stop();
  await s.close();
  console.log('ok  block socket: blockSubscribe params, -32601 is loud, backoff + reconnect, live on ack');
}

// ── a block notification flows through the pool with innerEvents ────────
{
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 3 }));
      // One pump tx, one failed tx, one unrelated tx.
      const failed = { ...pumpTx, meta: { ...pumpTx.meta, err: { InstructionError: [0, 'Custom'] } } };
      const unrelated = { ...pumpTx, meta: { ...pumpTx.meta, logMessages: ['Program log: hello'] } };
      ws.send(blockNotification([failed, pumpTx, unrelated]));
    });
  });
  const r = recorder();
  const feed = new FeedManager([], 'processed', r.cb, PUMP, FAST, { urls: [s.url], decodeInner: decodeCpiEventData });
  feed.start();
  assert.ok(await waitFor(() => r.logs.length >= 1));
  await sleep(50);
  assert.equal(r.logs.length, 1, 'only the pump tx produces a notification');
  assert.equal(r.logs[0].signature, PUMP_SIG);
  assert.equal(r.logs[0].slot, pumpSlot);
  assert.equal(feed.lastSlot, pumpSlot);
  assert.match(r.logs[0].provider, /:block$/);
  assert.equal(r.logs[0].innerEvents.filter((e) => e.kind === 'trade').length, 1);
  const det = feed.getDetails()[0];
  assert.equal(det.blocks, 1);
  assert.equal(det.events, 1);
  assert.equal(det.wins, 1);
  feed.stop();
  await s.close();
  console.log('ok  block notification → one pool notification with innerEvents');
}

// ── dedupe: a CPI copy passes after an undecodable log copy, once ───────
{
  // One server plays both roles: connection 1 is the logs socket, 2 the
  // block socket (the pool opens them in that order).
  const socks = {};
  const s = await server((ws, n) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      socks[req.method] = ws;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: n }));
    });
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, PUMP, FAST, { urls: [s.url], decodeInner: decodeCpiEventData });
  feed.start();
  assert.ok(await waitFor(() => socks.logsSubscribe && socks.blockSubscribe));
  // The log copy arrives first — with logs that decode to NOTHING (the day
  // pump drops emit!): only the instruction line, no `Program data:`.
  const bareLogs = ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', 'Program log: Instruction: Buy', 'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success'];
  socks.logsSubscribe.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: { subscription: 1, result: { context: { slot: pumpSlot }, value: { signature: PUMP_SIG, err: null, logs: bareLogs } } },
    }),
  );
  assert.ok(await waitFor(() => r.logs.length === 1));
  assert.equal(r.logs[0].innerEvents, undefined);
  // A second log copy (another socket, a reconnect replay) is a duplicate.
  socks.logsSubscribe.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: { subscription: 1, result: { context: { slot: pumpSlot }, value: { signature: PUMP_SIG, err: null, logs: bareLogs } } },
    }),
  );
  await sleep(60);
  assert.equal(r.logs.length, 1, 'a second log copy is dropped');
  // The block copy ~200ms later carries the decoded inner trade: it passes.
  socks.blockSubscribe.send(blockNotification([pumpTx]));
  assert.ok(await waitFor(() => r.logs.length === 2));
  assert.equal(r.logs[1].signature, PUMP_SIG);
  assert.equal(r.logs[1].innerEvents.length >= 1, true);
  assert.match(r.logs[1].provider, /:block$/);
  // ...but only once: a replayed block is a duplicate again.
  socks.blockSubscribe.send(blockNotification([pumpTx]));
  await sleep(60);
  assert.equal(r.logs.length, 2, 'a second CPI copy is dropped');
  const det = feed.getDetails();
  const logsSock = det.find((d) => d.kind === 'logs');
  const blockSock = det.find((d) => d.kind === 'block');
  assert.equal(logsSock.wins, 1);
  assert.equal(blockSock.wins, 0, 'the block copy did not win the race');
  assert.equal(blockSock.fills, 1, 'it filled after the empty log copy');
  feed.stop();
  await s.close();
  console.log('ok  dedupe lets one CPI copy through after an undecodable log copy');
}

// ── dedupe: when the CPI copy comes FIRST, the log copy is a plain dup ──
{
  const socks = {};
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      socks[req.method] = ws;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 1 }));
    });
  });
  const r = recorder();
  const feed = new FeedManager([s.url], 'processed', r.cb, PUMP, FAST, { urls: [s.url], decodeInner: decodeCpiEventData });
  feed.start();
  assert.ok(await waitFor(() => socks.logsSubscribe && socks.blockSubscribe));
  socks.blockSubscribe.send(blockNotification([pumpTx]));
  assert.ok(await waitFor(() => r.logs.length === 1));
  socks.logsSubscribe.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: { subscription: 1, result: { context: { slot: pumpSlot }, value: { signature: PUMP_SIG, err: null, logs: pumpTx.meta.logMessages } } },
    }),
  );
  await sleep(60);
  assert.equal(r.logs.length, 1, 'a log copy after a CPI copy is dropped');
  feed.stop();
  await s.close();
  console.log('ok  a log copy after the CPI copy is a duplicate');
}

console.log('feed: block-feed tests passed');
