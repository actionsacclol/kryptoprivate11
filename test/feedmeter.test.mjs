// The credit counter counts every Helius socket, 2026-11-04. It used to bill only the
// launch feed and the token tape, so it read 955k when Helius had already cut the
// socket off, and the ceiling never fired. Real sockets against a local server.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as m from './.feedmeter.mjs';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const ok = async (name, fn) => {
  await fn();
  n += 1;
  console.log(`  ok  ${name}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedmeter-'));
m.init(dir, 1_000_000);

// Answers the subscribe, then sends one frame of the given size.
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const FRAME = 512_000; // 10 credits
server.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const req = JSON.parse(String(raw));
    if (req.id === undefined || !req.method) return;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 1 }));
    ws.send('x'.repeat(FRAME));
  });
});

async function stream(url, program) {
  const feed = new m.FeedManager([url], 'processed', { onLogs: () => {}, onState: () => {} }, program);
  feed.start();
  await sleep(300);
  feed.stop();
  m.settleSockets();
}

const breakdown = () => m.current().breakdown;

await ok('the AMM tape counts, under its own name', async () => {
  const before = m.current().used;
  await stream(`ws://127.0.0.1:${port}/helius-rpc.com`, m.PUMP_AMM_PROGRAM_ID);
  assert.ok(breakdown().sockets['AMM tape'] >= 10, JSON.stringify(breakdown()));
  assert.ok(m.current().used >= before + 10);
});

await ok('the launch feed counts, under its own name', async () => {
  await stream(`ws://127.0.0.1:${port}/helius-rpc.com`, m.PUMP_PROGRAM_ID);
  assert.ok(breakdown().sockets['Launch feed'] >= 10);
});

await ok('any other Helius socket counts too', async () => {
  await stream(`ws://127.0.0.1:${port}/helius-rpc.com`, 'SomeOtherProgram1111111111111111111111111111');
  assert.ok(breakdown().sockets['Token watchers'] >= 10);
});

await ok('a free endpoint costs nothing', async () => {
  const before = m.current().used;
  await stream(`ws://127.0.0.1:${port}/public`, m.PUMP_AMM_PROGRAM_ID);
  assert.equal(m.current().used, before);
});

await ok('the ceiling is judged on everything counted', async () => {
  m.reset();
  m.setLimit(10);
  await stream(`ws://127.0.0.1:${port}/helius-rpc.com`, m.PUMP_AMM_PROGRAM_ID);
  assert.equal(m.shouldCutOff(), true, 'the AMM tape alone reaches a 10-credit ceiling');
  m.setLimit(1_000_000);
});

await ok('small frames add up instead of rounding away', async () => {
  m.reset();
  for (let i = 0; i < 20; i += 1) {
    m.addSocketBytes('Launch feed', 2_560);
    m.settleSockets();
  }
  assert.equal(m.current().used, 1, 'twenty twentieths of a credit is one credit');
});

await ok('every HTTP call is counted by method, and Sender is free', async () => {
  m.reset();
  const key = 'https://mainnet.helius-rpc.com/?api-key=x';
  m.meterHttp(key, 'getHealth');
  m.meterHttp(key, 'getHealth');
  m.meterHttp(key, 'getTransaction', 5);
  m.meterHttp('https://sender.helius-rpc.com/fast', 'sendTransaction');
  m.meterHttp('https://api.mainnet-beta.solana.com', 'getSlot');
  assert.deepEqual(breakdown().methods, { getHealth: 2, getTransaction: 5 });
  assert.equal(m.current().httpCalls, 7);
});

await ok('the split survives a restart, and a bad file is not trusted', async () => {
  m.persist();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'helius-credits.json'), 'utf8'));
  assert.equal(saved.breakdown.methods.getHealth, 2);
  m.init(dir, 1_000_000);
  assert.equal(breakdown().methods.getHealth, 2);
  fs.writeFileSync(path.join(dir, 'helius-credits.json'), JSON.stringify({ used: 5, breakdown: { sockets: { a: 'x', b: 3 }, methods: 'no' } }));
  m.init(dir, 1_000_000);
  assert.deepEqual(breakdown().sockets, { b: 3 });
  assert.deepEqual(breakdown().methods, {});
  assert.ok(breakdown().since > 0);
});

await ok('a count saved before this version still loads', async () => {
  fs.writeFileSync(path.join(dir, 'helius-credits.json'), JSON.stringify({ used: 955010, windowStartedAt: Date.now(), wsEvents: 1, httpCalls: 2 }));
  m.init(dir, 1_000_000);
  assert.equal(m.current().used, 955010);
  assert.deepEqual(breakdown().methods, {});
});

await ok('reset clears the split with the total', async () => {
  m.meterHttp('https://mainnet.helius-rpc.com/?api-key=x', 'getSlot');
  m.reset();
  assert.equal(m.current().used, 0);
  assert.deepEqual(breakdown().methods, {});
});

// ── Helius only leaves the AMM tape on a public socket ───────────────────

const rpc = { wssUrl: 'wss://public.example', extraWssUrls: ['wss://two.example'], httpUrl: 'https://h', commitment: 'processed' };

await ok('Helius only: launch feed on the key, AMM tape on the public socket', async () => {
  const r = m.resolveRpc({ ...rpc, heliusApiKey: 'KEY', heliusOnlyFeed: true });
  assert.ok(r.wssUrl.includes('helius-rpc.com'));
  assert.equal(r.ammWssUrl, 'wss://public.example');
  assert.deepEqual(r.extraWssUrls, []);
});

await ok('Helius only off: nothing is derived for the AMM tape', async () => {
  const r = m.resolveRpc({ ...rpc, heliusApiKey: 'KEY' });
  assert.equal(r.ammWssUrl, undefined);
  assert.equal(r.wssUrl, 'wss://public.example');
});

await ok('the engine and the settings file honour that', async () => {
  const engine = read('electron/engine/engine.ts');
  assert.match(engine, /new FeedManager\(\s*\n\s*\[s\.rpc\.ammWssUrl \?\? feedUrls\[0\]\]/);
  assert.match(engine, /JSON\.stringify\(\[r\.wssUrl, r\.ammWssUrl,/, 'a change reconnects a running feed');
  assert.match(read('electron/system/settings-store.ts'), /delete rpc\.ammWssUrl;/, 'derived, never saved');
});

// ── Everything that reaches Helius goes through the meter ────────────────

await ok('no path to Helius skips the count', async () => {
  const rpcClient = read('electron/chain/rpcClient.ts');
  assert.match(rpcClient, /heliusBudget\.meterHttp\(httpUrl, method\);/);
  assert.match(rpcClient, /heliusBudget\.meterHttp\(httpUrl, 'getTransaction', signatures\.length\);/);
  assert.match(read('electron/system/netAgent.ts'), /meterHttp\(url,/);
  assert.match(read('electron/engine/rpcProbe.ts'), /meterHttp\(url, method\);/);
  assert.match(read('electron/system/heliusHealth.ts'), /meterHttp\(url, 'getSlot'\);/);
  assert.match(read('electron/engine/priorityFeed.ts'), /addSocketBytes\('Token tape'/);
  assert.match(read('electron/engine/confirmSocket.ts'), /addSocketBytes\('Trade confirmations'/);
  assert.match(read('electron/engine/feed.ts'), /heliusBudget\.addSocketBytes\(this\.meterStream, frameBytes\)/);
  // A new socket must be metered: these are the only ones that can reach a Helius URL.
  const sites = ['electron/engine/feed.ts', 'electron/engine/priorityFeed.ts', 'electron/engine/confirmSocket.ts', 'electron/system/heliusHealth.ts'];
  for (const f of sites) assert.match(read(f), /new WebSocket\(/, f);
  const allSockets = fs.readdirSync(new URL('../electron/engine/', import.meta.url)).filter((f) => f.endsWith('.ts') && /new WebSocket\(/.test(read(`electron/engine/${f}`)));
  assert.deepEqual(allSockets.sort(), ['confirmSocket.ts', 'feed.ts', 'priorityFeed.ts']);
});

// ── What the user is told ────────────────────────────────────────────────

await ok('both switches and both cards state the real cost', async () => {
  assert.match(read('src/components/HeliusOnlyFeedSwitch.tsx'), /feedCostText\(limit\)/);
  assert.match(read('src/pages/Settings.tsx'), /feedCostText\(settings\.rpc\.heliusMonthlyCredits \?\? 0\)/);
  assert.match(read('electron/system/heliusHealth.ts'), /Leave it off unless your plan can carry it/);
  assert.match(read('electron/engine/engine.ts'), /Leave it off unless your plan can carry it/);
  assert.doesNotMatch(read('electron/system/heliusHealth.ts'), /Turn it back on/);
  assert.doesNotMatch(read('src/components/HeliusOnlyFeedSwitch.tsx'), /next time the scanner starts/);
});

await ok('the counter shows where the credits went', async () => {
  const meter = read('src/components/terminal/CreditMeter.tsx');
  assert.match(meter, /breakdownRows\(usage\?\.breakdown\)/);
  assert.match(meter, /Nothing counted yet\./);
  assert.match(meter, /The total above includes earlier use\./);
});

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`feedmeter: ${n} passed`);
process.exit(0);
