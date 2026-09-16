// The priority feed (priorityFeed.ts) against a local websocket server.
//
// What this suite exists to pin, 2026-09-09: there is NO ten-subscription
// ceiling on the public socket. `x-ratelimit-pubsub-limit: 10` counts pubsub
// CONNECTIONS per IP — 16 `logsSubscribe` on one socket were all acked, the
// header decrements once per socket, and connections 11-13 were refused at
// the handshake. The module used to hold at ten and tell the user a Helius
// key would lift a limit that does not exist; held mints past the tenth sat
// on the slow firehose for nothing.
//
// So: many mints, ONE connection, no advertised cap, no key upsell — and if
// the host ever does refuse a subscribe, the count it refused at is learned
// rather than guessed. Plus the reconnect jitter this lane was missing.
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import * as feed from './.priorityfeed.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return false;
}

function server(onMessage) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    let conns = 0;
    wss.on('connection', (ws) => {
      conns += 1;
      ws.on('message', (raw) => onMessage(ws, JSON.parse(String(raw))));
    });
    wss.on('listening', () => {
      resolve({
        // Deliberately UNKEYED: this is the public-socket path the old cap
        // applied to (a keyed url was exempt from it).
        url: `ws://127.0.0.1:${wss.address().port}`,
        connections: () => conns,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
  });
}

const mint = (i) => `M${String(i).padStart(43, '0')}`;
/** Anything that reads as "you have hit a limit, go pay for more". */
const UPSELL = /helius|api key|lifts this|allows \d+ subscription/i;

// ── fourteen held mints, one socket, nothing withheld ────────────────────
{
  const asked = [];
  let subId = 500;
  const s = await server((ws, req) => {
    if (req.method !== 'logsSubscribe') return;
    asked.push(req.params[0].mentions[0]);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
  });
  const logs = [];
  feed._reset();
  feed.attach({
    wssUrl: () => s.url,
    execHttpUrl: () => '',
    commitment: () => 'confirmed',
    onLogs: () => {},
    billHttp: () => {},
    log: (level, line) => logs.push(line),
  });
  // 14 is the number from the swarm's copy-leader case, and four past the
  // cap this module used to enforce.
  const mints = Array.from({ length: 14 }, (_, i) => mint(i));
  for (const m of mints) feed.watch(m);
  assert.ok(await waitFor(() => feed.subscribedMints().length === 14), 'all fourteen mints are subscribed on the fast socket');
  assert.equal(asked.length, 14, 'fourteen subscribe frames went out — none was withheld');
  assert.equal(s.connections(), 1, 'over ONE connection: the connection is the scarce thing, not the subscription');
  assert.equal(logs.filter((l) => UPSELL.test(l)).length, 0, 'and nothing advertises a cap or a key to buy');
  feed._reset();
  await s.close();
  console.log('ok  fourteen mints subscribe on one public socket, with no cap advertised');
}

// ── a refusal from the host is LEARNED, not assumed ──────────────────────
{
  let subId = 900;
  let acked = 0;
  const s = await server((ws, req) => {
    if (req.method !== 'logsSubscribe') return;
    // This host really does stop at three. Nothing in the app knows that
    // until it happens.
    if (acked >= 3) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Too many subscriptions' } }));
      return;
    }
    acked += 1;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
  });
  const logs = [];
  feed._reset();
  feed.attach({
    wssUrl: () => s.url,
    execHttpUrl: () => '',
    commitment: () => 'confirmed',
    onLogs: () => {},
    billHttp: () => {},
    log: (level, line) => logs.push(line),
  });
  for (let i = 0; i < 3; i++) {
    feed.watch(mint(i));
    assert.ok(await waitFor(() => feed.subscribedMints().length === i + 1), `mint ${i} acked`);
  }
  feed.watch(mint(3));
  assert.ok(await waitFor(() => logs.some((l) => /subscribe rejected/.test(l))), 'the refusal is reported, not swallowed');
  assert.equal(feed.subscribedMints().length, 3, 'the refused mint has no subscription');

  // The ceiling is now a measured 3, so the next mint is not even asked for.
  const before = acked;
  feed.watch(mint(4));
  await sleep(120);
  assert.equal(acked, before, 'no further frame is sent into a refusal');
  const held = logs.filter((l) => /refused a subscribe past 3/.test(l));
  assert.equal(held.length, 1, 'and the log names the number the HOST refused at');
  assert.ok(/16 were verified to work/.test(held[0]), 'quoting what was actually measured');
  assert.ok(/stays on the program firehose/.test(held[0]), 'and says the mint is still covered');
  assert.equal(logs.filter((l) => UPSELL.test(l)).length, 0, 'still no key upsell');
  feed._reset();
  await s.close();
  console.log('ok  a real refusal is learned from the host and reported honestly');
}

// ── reconnect backoff carries jitter ─────────────────────────────────────
{
  // The swarm's finding: this was the only socket class redialling on a round
  // number. Worst case the app sits at 10 of 10 pubsub connections on
  // api.mainnet-beta, so a synchronised redial after a resume is a handshake
  // 429 that parks the whole host for every socket class.
  for (const attempt of [1, 3, 5, 9]) {
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    const samples = Array.from({ length: 300 }, () => feed.reconnectDelayMs(attempt));
    assert.ok(samples.every((v) => v >= base * 0.75 && v <= base * 1.25), `attempt ${attempt}: within ±25% of ${base}`);
    assert.ok(new Set(samples).size > 20, `attempt ${attempt}: the delay actually varies (jitter, not a round number)`);
    assert.ok(samples.filter((v) => v === base).length < samples.length, `attempt ${attempt}: not every redial lands on ${base} ms`);
  }
  console.log('ok  reconnect backoff is jittered ±25%, so sockets do not redial in lockstep');
}

console.log('\npriorityfeed: all tests passed');
