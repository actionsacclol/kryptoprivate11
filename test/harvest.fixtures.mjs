// Fixture harvester — Phase-2 Milestone A: gather REAL mainnet Pump.fun
// transaction logs and pin the decoder against them. Run occasionally
// (needs network); writes test/fixtures/live-logs.json which the decoder
// test replays offline forever after.
//
// Usage: node test/harvest.fixtures.mjs  (requires test/.decoder.mjs bundle)

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeLogs, PUMP_PROGRAM_ID } from './.decoder.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-logs.json');
const WANT = { create: 4, trade: 8, complete: 1 };
const TIMEOUT_MS = 90_000;

const got = { create: [], trade: [], complete: [] };
const ws = new WebSocket('wss://api.mainnet-beta.solana.com');

ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
    params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }], // confirmed: fixtures should be canonical
  }));
  console.log('subscribed (confirmed commitment) — harvesting…');
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.method !== 'logsNotification') return;
  const v = msg.params?.result?.value;
  const slot = msg.params?.result?.context?.slot ?? 0;
  if (!v?.signature || v.err || !Array.isArray(v.logs)) return;
  const events = decodeLogs(v.logs);
  if (events.length === 0) return;
  for (const kind of ['create', 'trade', 'complete']) {
    if (events.some((e) => e.kind === kind) && got[kind].length < WANT[kind]) {
      got[kind].push({
        signature: v.signature,
        slot,
        harvestedAt: new Date().toISOString(),
        expectKinds: events.map((e) => e.kind),
        logs: v.logs,
      });
      console.log(`captured ${kind} (${got[kind].length}/${WANT[kind]}) ${v.signature.slice(0, 16)}…`);
      break;
    }
  }
  if (Object.keys(WANT).every((k) => got[k].length >= WANT[k])) finish();
});

const timer = setTimeout(() => {
  console.log('timeout — saving what we have');
  finish();
}, TIMEOUT_MS);

function finish() {
  clearTimeout(timer);
  try { ws.terminate(); } catch { /* ignore */ }
  const fixtures = [...got.create, ...got.trade, ...got.complete];
  if (fixtures.length === 0) {
    console.error('no fixtures captured — check network');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ harvestedAt: new Date().toISOString(), fixtures }, null, 2));
  console.log(`saved ${fixtures.length} real-tx fixtures → ${OUT}`);
  process.exit(0);
}
