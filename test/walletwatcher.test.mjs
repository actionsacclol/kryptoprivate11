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
globalThis.fetch = async () => {
  fetches += 1;
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', result: BUY_TX }) };
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
  console.log('ok  a notification becomes a decoded swap via one getTransaction');

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

console.log('\nwalletwatcher: all tests passed');
