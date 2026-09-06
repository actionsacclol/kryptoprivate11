// Live smoke check for the trade-path prewarm + confirmation socket
// (2026-09-01 speed pass). Networked — `npm run test:prewarm`, never in
// `npm test`. Expect: socket open, warm getHealth well under 100 ms, a
// recent pump signature notified within a few hundred ms, unknown → null.
import { installNetAgent } from './.netagent.mjs';
import * as prewarm from './.prewarm.mjs';
import * as confirmSocket from './.confirmsocket.mjs';

const RPC = 'https://api.mainnet-beta.solana.com';
const WSS = 'wss://api.mainnet-beta.solana.com';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

installNetAgent();

const rpc = async (method, params) => {
  const t0 = Date.now();
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  return { result: body.result, ms: Date.now() - t0 };
};

// 1. Prewarm heartbeat against the public endpoints. (The prewarm bundle
//    carries its own copy of confirmSocket; the socket module is exercised
//    directly below on this file's instance.)
const t0 = Date.now();
prewarm.start(() => ({ httpUrl: RPC, wssUrl: WSS, useJito: true, useHeliusSender: true, useRelayer: true }));
const tSock = Date.now();
confirmSocket.ensure(WSS);
await new Promise((r) => setTimeout(r, 4_000));
console.log(`prewarm ran ${Date.now() - t0} ms · confirm socket open: ${confirmSocket.isOpen()} (ensure → open ≤ ${Date.now() - tSock} ms)`);

// 2. RPC keep-alive: a call right after the warm-up must be cheap.
const a = await rpc('getHealth', []);
const b = await rpc('getHealth', []);
console.log(`getHealth after prewarm: ${a.ms} ms, again: ${b.ms} ms`);

// 3. signatureSubscribe plumbing: a recent, already-confirmed pump signature.
const sigs = await rpc('getSignaturesForAddress', [PUMP, { limit: 1, commitment: 'confirmed' }]);
const sig = sigs.result?.[0]?.signature;
console.log(`recent pump signature: ${sig ? sig.slice(0, 16) + '…' : 'none'}`);
if (sig) {
  const t1 = Date.now();
  const out = await confirmSocket.waitFor(sig, 'confirmed', 8_000);
  console.log(`waitFor(confirmed) → ${out ? `notified in ${Date.now() - t1} ms, err=${JSON.stringify(out.err)}` : 'null (no notification within 8 s — poll would decide)'}`);
}
// A signature that will never exist must resolve null, never hang.
const t2 = Date.now();
const none = await confirmSocket.waitFor('1'.repeat(87), 'confirmed', 2_000);
console.log(`waitFor(unknown) → ${none === null ? 'null' : 'unexpected'} after ${Date.now() - t2} ms`);

prewarm.stop();
confirmSocket.close();
console.log(`after stop: confirm socket open: ${confirmSocket.isOpen()}`);
process.exit(0);
