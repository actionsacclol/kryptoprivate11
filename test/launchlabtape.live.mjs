// LIVE check: does the LaunchLab tape actually receive trades over WSS?
//
//   npm run test:launchlab:tape
//
// The decoder tests prove bytes parse. This proves the whole path: a real
// websocket subscription to the LaunchLab program, real log lines arriving,
// decoded, matched to a watched pool derived from the mint, and turned into
// ticks. It is the only check that would catch a wrong subscription, a dead
// endpoint, or a pool PDA that stopped matching.
//
// It waits for real trades, so it needs an ACTIVE token and some patience.

import fs from 'node:fs';
import * as watcher from './.launchlabwatcher.mjs';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let wss = ['wss://api.mainnet-beta.solana.com'];
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const key = s?.rpc?.heliusApiKey;
  if (key) wss = [`wss://mainnet.helius-rpc.com/?api-key=${key}`];
  else if (s?.rpc?.wssUrl) wss = [s.rpc.wssUrl, ...(s.rpc.extraWssUrls ?? [])].filter(Boolean);
} catch {
  /* public endpoint */
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Find pools that are trading RIGHT NOW by listening to the program stream
// first. Picking "busiest by 24h volume" is not the same thing — LaunchLab is
// quiet enough (about 4 notifications per 30s program-wide) that a token which
// did volume yesterday can easily trade nothing during a 45s window, which
// would fail this check for the wrong reason.
import WebSocket from 'ws';
import { decodeLogs } from './.launchlab.mjs';

const LL = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const activePools = new Map(); // pool -> trades seen
await new Promise((resolve) => {
  const ws = new WebSocket(wss[0]);
  const done = () => {
    try { ws.close(); } catch { /* already closed */ }
    resolve();
  };
  ws.on('open', () =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [LL] }, { commitment: 'confirmed' }] })),
  );
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.method !== 'logsNotification') return;
    for (const ev of decodeLogs(m.params?.result?.value?.logs ?? [])) {
      activePools.set(ev.pool, (activePools.get(ev.pool) ?? 0) + 1);
    }
  });
  ws.on('error', done);
  setTimeout(done, 40_000);
});
console.log(`     scouted ${activePools.size} pools trading in the last 40s`);
check('the program stream carries decodable trades', activePools.size > 0, `${activePools.size} pools`);
if (!activePools.size) process.exit(1);

// Resolve those pools to mints, straight from the pool account (offset 205).
let RPC = 'https://api.mainnet-beta.solana.com';
try {
  const k = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.rpc?.heliusApiKey;
  if (k) RPC = `https://mainnet.helius-rpc.com/?api-key=${k}`;
} catch { /* public */ }
const { parsePoolAccount } = await import('./.launchlabaccounts.mjs');
const pools = [...activePools.keys()].slice(0, 20);
const res = await fetch(RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [pools, { encoding: 'base64', commitment: 'confirmed' }] }),
});
const values = (JSON.parse(await res.text())?.result?.value) ?? [];
const candidates = [];
for (let i = 0; i < pools.length; i++) {
  if (!values[i]?.data?.[0]) continue;
  const st = parsePoolAccount(pools[i], Buffer.from(values[i].data[0], 'base64'));
  if (st) candidates.push({ pool: pools[i], mint: st.baseMint, decimals: st.baseDecimals, isSolQuoted: st.isSolQuoted });
}
check('active pools resolve to mints', candidates.length > 0, `${candidates.length}/${pools.length}`);
if (!candidates.length) process.exit(1);

// The derivation must hold for SOL-quoted pools — that is what makes watching
// free. Non-SOL pools are expected NOT to match, and are watched by address.
const solQuoted = candidates.filter((c) => c.isSolQuoted);
const derived = solQuoted.filter((c) => watcher.poolFor(c.mint) === c.pool).length;
check(
  'the pool PDA derives from the mint for SOL-quoted pools',
  solQuoted.length === 0 || derived === solQuoted.length,
  `${derived}/${solQuoted.length}`,
);

const ticks = [];
watcher.attach({
  wssUrls: () => wss,
  commitment: () => 'confirmed',
  onTick: (t) => ticks.push(t),
  log: (lvl, line) => console.log(`     [${lvl}] ${line}`),
});

for (const c of candidates) watcher.watch(c.mint, c.decimals, c.pool);
check('watching the busiest pools', watcher.watchedMints().length > 0, `${watcher.watchedMints().length} mints`);

const WAIT_MS = 60_000;
console.log(`\n     waiting ${WAIT_MS / 1000}s for live trades on ${watcher.watchedMints().length} pools…`);
await new Promise((r) => setTimeout(r, WAIT_MS));
watcher.stopAll();

check('live trades arrived over the websocket', ticks.length > 0, `${ticks.length} ticks`);
if (ticks.length) {
  check('every tick has a positive price', ticks.every((t) => t.priceSol > 0));
  check('every tick has amounts', ticks.every((t) => t.sol > 0 && t.tokens > 0));
  check('ticks carry a curve percentage or an honest null', ticks.every((t) => t.curvePct === null || (t.curvePct >= 0 && t.curvePct <= 100)));
  // Logs carry no account list, so the wallet is empty BY DESIGN. If this
  // ever starts returning an address, something is inventing one.
  check('the wallet is empty, not invented', ticks.every((t) => t.wallet === ''));
  const t = ticks[0];
  console.log(`     first tick: ${t.isBuy ? 'BUY ' : 'SELL'} ${t.sol.toFixed(6)} SOL for ${t.tokens.toFixed(0)} tokens @ ${t.priceSol.toExponential(3)} SOL (curve ${t.curvePct?.toFixed(2) ?? '—'}%)`);
}

console.log(`\n${failures === 0 ? 'ALL LAUNCHLAB TAPE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
