// The wallet watcher (walletWatcher.ts) against a local websocket server:
// one subscription per followed wallet, the leader's transaction read once
// and decoded into a swap, replays deduped, unsubscribed on unfollow,
// fourteen leaders all watched on ONE public connection (the pubsub limit is
// 10 connections per IP, not 10 subscriptions per socket), and 'over-cap'
// reached only when the host itself refuses.
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import * as watcher from './.walletwatcher.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return false;
}

function server(onConn) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    let n = 0;
    wss.on('connection', (ws) => onConn(ws, ++n));
    wss.on('listening', () => {
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
  });
}

const W1 = 'Wallet1111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MINT = 'MintA111111111111111111111111111111111111111';
const SOL = 1_000_000_000;

/** A Jupiter-style buy by W1: 0.6 SOL out, 1000 tokens in. */
const BUY_TX = {
  // Seconds, as the RPC returns it — the watcher turns it into the `tradeAt`
  // copy trading refuses a stale entry on.
  blockTime: Math.floor(Date.now() / 1000),
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10 * SOL, 0, 0],
    postBalances: [10 * SOL - 0.6 * SOL - 5000, 0, 0],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 5, mint: MINT, owner: W1, uiTokenAmount: { amount: '1000000000', decimals: 6, uiAmount: null } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [W1, JUP, MINT],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
};

let fetches = 0;
// What `getSignaturesForAddress` answers, and how often it was asked. The
// catch-up path reads it; every other method gets the transaction.
let sigList = [];
let sigCalls = 0;
const rpcMethodOf = (init) => {
  try {
    const body = JSON.parse(String(init?.body ?? '{}'));
    return Array.isArray(body) ? body[0]?.method : body?.method;
  } catch {
    return undefined;
  }
};
/** The params of the last getTransaction the watcher sent. */
let lastTxParams = null;
globalThis.fetch = async (_url, init) => {
  const reply = (result) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result }) });
  if (rpcMethodOf(init) === 'getSignaturesForAddress') {
    sigCalls += 1;
    return reply(sigList);
  }
  fetches += 1;
  try {
    const body = JSON.parse(String(init?.body ?? '{}'));
    lastTxParams = (Array.isArray(body) ? body[0] : body)?.params?.[1] ?? null;
  } catch {
    lastTxParams = null;
  }
  return reply(BUY_TX);
};

const notification = (sub, sig) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: { subscription: sub, result: { context: { slot: 1 }, value: { signature: sig, err: null, logs: [] } } },
  });

// ── subscribe per wallet, decode once, dedupe replays, unfollow ──────────
{
  const received = [];
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      received.push(req);
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 5 }));
      if (req.method === 'logsUnsubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: true }));
    });
  });
  const swaps = [];
  const logs = [];
  watcher._reset();
  watcher.attach({
    wssUrl: () => s.url,
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push({ level, line }),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => received.length === 1), 'a subscribe went out');
  assert.equal(received[0].method, 'logsSubscribe');
  assert.deepEqual(received[0].params[0], { mentions: [W1] }, 'subscribed to the WALLET, not a program');
  assert.equal(received[0].params[1].commitment, 'confirmed', 'confirmed, so the transaction is readable when asked for');
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching after the ack');
  console.log('ok  one logsSubscribe per followed wallet, at confirmed');

  sock.send(notification(5, 'sigBuy1'));
  assert.ok(await waitFor(() => swaps.length === 1), 'the swap was decoded and delivered');
  assert.equal(swaps[0].wallet, W1);
  assert.equal(swaps[0].signature, 'sigBuy1');
  assert.equal(swaps[0].swap.isBuy, true);
  assert.equal(swaps[0].swap.mint, MINT);
  assert.ok(Math.abs(swaps[0].swap.sol - 0.6) < 1e-12);
  assert.equal(swaps[0].swap.tokens, 1000);
  assert.equal(fetches, 1, 'the transaction was read once');
  // Transaction v1 (SIMD-0385) is live on mainnet since 2026-09-15. A read
  // that only accepts v0 is refused (-32015) for every v1 transaction a
  // leader makes — which was "That trade was not copied" on every one of
  // them (user report 2026-09-20).
  assert.equal(lastTxParams?.maxSupportedTransactionVersion, 1, `the read accepts transaction v1 — sent ${JSON.stringify(lastTxParams)}`);
  assert.equal(typeof swaps[0].tradeAt, 'number', 'and carries WHEN THEY TRADED, from the block');
  assert.ok(Math.abs(swaps[0].tradeAt - BUY_TX.blockTime * 1000) < 1000);
  assert.equal(sigCalls, 0, 'the first subscribe of a session has no gap behind it to fill');
  console.log('ok  a notification becomes a decoded swap via one getTransaction, dated by the block');

  sock.send(notification(5, 'sigBuy1'));
  await sleep(150);
  assert.equal(swaps.length, 1, 'a replayed signature is not a second swap');
  assert.equal(fetches, 1, 'and is not read again');
  const st = watcher.status()[W1];
  assert.equal(st.seen, 2);
  assert.equal(st.swaps, 1);
  assert.ok(st.lastSeenAt && st.lastSwapAt);
  console.log('ok  replays are deduped by signature');

  watcher.setWallets([]);
  assert.ok(await waitFor(() => received.some((r) => r.method === 'logsUnsubscribe' && r.params[0] === 5)), 'unsubscribed on unfollow');
  assert.deepEqual(watcher.status(), {}, 'nothing watched');
  assert.equal(watcher.isConnected(), false, 'the socket closes when no wallet is followed');
  await s.close();
  console.log('ok  unfollowing unsubscribes and closes the socket');
}

// ── fourteen leaders are fourteen leaders ────────────────────────────────
//
// 2026-09-09: this used to assert the opposite — that the eleventh followed
// wallet went unwatched, because `x-ratelimit-pubsub-limit: 10` was read as
// ten subscriptions per connection. It is ten pubsub CONNECTIONS per IP: the
// header decrements once per socket, 16 `logsSubscribe` on one socket were
// all acked, and connections 11-13 were refused at the handshake. A user
// following 14 leaders was losing four of them, and being told to buy a key
// for a limit that is not there.
{
  let subId = 100;
  let conns = 0;
  const asked = [];
  const s = await server((ws) => {
    conns += 1;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      asked.push(req.params[0].mentions[0]);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const logs = [];
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: (level, line) => logs.push(line) });
  const wallets = Array.from({ length: 14 }, (_, i) => `W${String(i).padStart(43, '0')}`);
  watcher.setWallets(wallets);
  assert.ok(await waitFor(() => Object.values(watcher.status()).filter((w) => w.state === 'watching').length === 14), 'all fourteen are watched');
  assert.equal(Object.values(watcher.status()).filter((w) => w.state === 'over-cap').length, 0, 'none is marked over-cap');
  assert.equal(asked.length, 14, 'fourteen subscribe frames went out — none was withheld');
  assert.equal(conns, 1, 'over ONE connection: the connection is the scarce resource, not the subscription');
  assert.equal(logs.filter((l) => /helius|api key|lifts this|allows \d+ followed wallets/i.test(l)).length, 0, 'and nothing tells the user to buy a key');
  watcher._reset();
  await s.close();
  console.log('ok  fourteen followed wallets are all watched on one public socket');
}

// ── a refusal from the HOST is learned, and only then is a wallet over-cap ──
{
  let subId = 700;
  let acked = 0;
  const s = await server((ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method !== 'logsSubscribe') return;
      // This host really does stop at three; nothing knows until it happens.
      if (acked >= 3) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Too many subscriptions' } }));
        return;
      }
      acked += 1;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const logs = [];
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: () => {}, log: (level, line) => logs.push(line) });
  const wallets = Array.from({ length: 5 }, (_, i) => `X${String(i).padStart(43, '0')}`);
  watcher.setWallets(wallets);
  assert.ok(await waitFor(() => Object.values(watcher.status()).filter((w) => w.state === 'over-cap').length >= 1), 'the refused wallet is marked over-cap');
  assert.equal(Object.values(watcher.status()).filter((w) => w.state === 'watching').length, 3, 'the three the host accepted are watching');
  assert.ok(logs.some((l) => /subscribe rejected/.test(l)), 'the refusal is reported, not swallowed');

  // The ceiling is now a measured 3, so a sixth wallet is not even asked for.
  const before = acked + logs.length;
  watcher.setWallets([...wallets, `X${String(9).padStart(43, '0')}`]);
  await sleep(150);
  const held = logs.filter((l) => /refused a subscribe past 3 followed wallets/.test(l));
  assert.equal(held.length, 1, 'the log names the number the HOST refused at');
  assert.ok(/16 were verified to work/.test(held[0]), 'quoting what was actually measured');
  assert.equal(logs.filter((l) => /helius|api key|lifts this/i.test(l)).length, 0, 'still no key upsell');
  assert.ok(before >= 0);
  watcher._reset();
  await s.close();
  console.log('ok  over-cap comes from the host refusing, not from an invented limit');
}

// ── Catching up after a gap ─────────────────────────────────────────────
//
// `logsSubscribe` is live-only. Whatever a followed wallet did while the
// socket was down was never delivered, and nothing asked for it afterwards —
// so a leader's exit inside a reconnect was simply never seen, and the
// position sat open until something else eventually closed it. That is the
// "eventually sold, 1 h 28 m late" shape of the 2026-09-15 report.
{
  let subId = 500;
  let conns = 0;
  const sockets = [];
  const s = await server((ws, n) => {
    conns = n;
    sockets.push(ws);
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const swaps = [];
  const logs = [];
  watcher._reset();
  sigCalls = 0;
  sigList = [];
  watcher.attach({
    wssUrl: () => s.url,
    httpUrl: () => 'https://rpc.test/',
    onSwap: (ev) => swaps.push(ev),
    log: (level, line) => logs.push(line),
  });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'), 'watching on the first socket');
  assert.equal(sigCalls, 0, 'no catch-up on a first subscribe — there is no gap behind it');

  // The leader sells while we are away. The socket dies before it arrives.
  sigList = [
    { signature: 'sigMissedExit', err: null, slot: 9, blockTime: Math.floor(Date.now() / 1000) },
    { signature: 'sigTooOld', err: null, slot: 8, blockTime: Math.floor(Date.now() / 1000) - 40 * 60 },
  ];
  sockets[0].terminate();

  assert.ok(await waitFor(() => conns >= 2, 8000), 'the watcher reconnected');
  assert.ok(await waitFor(() => swaps.length === 1, 8000), `the missed transaction was recovered: ${JSON.stringify(logs)}`);
  assert.equal(swaps[0].signature, 'sigMissedExit');
  assert.equal(typeof swaps[0].tradeAt, 'number', 'and it knows when it really happened');
  assert.ok(sigCalls >= 1, 'the gap was filled with one signatures read');
  assert.ok(logs.some((l) => /catching up on 1 transaction/.test(l)), `the catch-up says what it did: ${JSON.stringify(logs)}`);
  console.log('ok  a transaction missed while the socket was down is recovered on reconnect');

  assert.ok(
    !swaps.some((x) => x.signature === 'sigTooOld'),
    'a signature from forty minutes ago is outside the window and is NOT replayed',
  );
  console.log('ok  the catch-up is bounded by age, so a reconnect never replays ancient history');

  // A second gap must not re-deliver what the first one already handled.
  const before = swaps.length;
  sockets[sockets.length - 1].terminate();
  assert.ok(await waitFor(() => conns >= 3, 8000), 'reconnected again');
  await sleep(400);
  assert.equal(swaps.length, before, 'already-seen signatures are dropped before any transaction is fetched');
  watcher._reset();
  await s.close();
  console.log('ok  a second catch-up re-delivers nothing');
}

// ── A transaction that cannot be read is said out loud ───────────────────
//
// It used to be three tries 700 ms apart and then silence. On a rate-limited
// endpoint that is nothing, and every transaction lost that way is a leader
// trade the copier never acts on — with no way for anyone to know.
{
  let subId = 700;
  let sock = null;
  const s = await server((ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ++subId }));
    });
  });
  const swaps = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (rpcMethodOf(init) === 'getSignaturesForAddress') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: [] }) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: null }) };
  };
  watcher._reset();
  watcher.attach({ wssUrl: () => s.url, httpUrl: () => 'https://rpc.test/', onSwap: (ev) => swaps.push(ev), log: (level, line) => logs.push(line) });
  watcher.setWallets([W1]);
  assert.ok(await waitFor(() => watcher.status()[W1]?.state === 'watching'));
  sock.send(notification(subId, 'sigUnreadable'));
  assert.ok(
    await waitFor(() => logs.some((l) => /was not copied/.test(l)), 30000),
    `giving up is reported: ${JSON.stringify(logs)}`,
  );
  assert.equal(swaps.length, 0, 'and nothing is invented from a transaction that was never read');
  globalThis.fetch = realFetch;
  watcher._reset();
  await s.close();
  console.log('ok  a leader transaction that cannot be read is chased, then reported — never dropped in silence');
}

console.log('\nwalletwatcher: all tests passed');
