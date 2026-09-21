// LIVE check for the Raydium AMM v4 + CPMM rail.
//
//   npm run test:raydium
//
// NOT part of `npm test`: it reads mainnet and opens sockets. Uses the
// Helius key from settings when there is one and falls back to the public
// endpoints. The key is never printed.
//
// What this proves that the fixture tests cannot:
//   • CPMM still emits its SwapEvent as a `Program data:` LOG line — the fact
//     that lets this rail be taped from logsSubscribe with no transaction
//     fetch. If it ever moves to emit_cpi only, this fails and the cheap
//     path is gone.
//   • The pool-creation fee accounts still see creations (v4 InitLogs, CPMM
//     Initialize* instructions), and a creation still resolves to a pool
//     with vaults by the same two calls the watcher makes.
//   • The per-pool tape delivers ticks on a live pool of each kind.

import fs from 'node:fs';
import {
  ammV4CreationInLogs,
  cpmmCreationInLogs,
  cpmmEventsOf,
  attributeLogs,
  rayLogsOf,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT,
  RAYDIUM_CPMM_CREATE_FEE_ACCOUNT,
  WSOL_MINT,
} from './.raydium.mjs';
import { parsePool, parseReserves, priceSolFromReserves, solInPool } from './.raydiumaccounts.mjs';
import * as watcher from './.raydiumwatcher.mjs';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let RPC = 'https://api.mainnet-beta.solana.com';
let WSS = ['wss://api.mainnet-beta.solana.com'];
try {
  const key = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.rpc?.heliusApiKey;
  if (key) {
    RPC = `https://mainnet.helius-rpc.com/?api-key=${key}`;
    WSS = [`wss://mainnet.helius-rpc.com/?api-key=${key}`];
  }
} catch {
  /* public it is */
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  await sleep(120);
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const t = await r.text();
  try {
    return JSON.parse(t).result ?? null;
  } catch {
    return null;
  }
};
const getTx = (sig) => rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }]);
const keysOf = (tx) => {
  const k = [...tx.transaction.message.accountKeys];
  const la = tx.meta?.loadedAddresses;
  if (la) k.push(...(la.writable ?? []), ...(la.readonly ?? []));
  return k;
};

// ── CPMM still logs its swaps ─────────────────────────────────────────

{
  const sigs = (await rpc('getSignaturesForAddress', [RAYDIUM_CPMM_PROGRAM, { limit: 30 }])) ?? [];
  check('the CPMM program has recent activity', sigs.length > 0, `${sigs.length} signatures`);
  let scanned = 0;
  let withSwap = 0;
  let drift = 0;
  let solSided = 0;
  for (const s of sigs.filter((x) => !x.err).slice(0, 12)) {
    const tx = await getTx(s.signature);
    if (!tx || tx.meta?.err) continue;
    scanned++;
    const { events, layoutErrors } = cpmmEventsOf(tx.meta.logMessages ?? []);
    drift += layoutErrors;
    if (events.length) withSwap++;
    if (events.some((e) => e.inputMint === WSOL_MINT || e.outputMint === WSOL_MINT)) solSided++;
  }
  check('CPMM swaps still decode straight from the log stream', withSwap > 0, `${withSwap}/${scanned} txs carried a SwapEvent log`);
  check('no CPMM layout drift', drift === 0, `${drift} event(s) of an unknown size`);
  console.log(`     ${solSided}/${scanned} had a SOL side`);
}

// ── The creation fee accounts still see creations ─────────────────────

{
  const sigs = (await rpc('getSignaturesForAddress', [RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT, { limit: 5 }])) ?? [];
  check('the v4 creation fee account has activity', sigs.length > 0, `${sigs.length} signatures, newest ${sigs[0] ? Math.round((Date.now() / 1000 - sigs[0].blockTime) / 3600) + ' h ago' : '-'}`);
  let inits = 0;
  let resolved = 0;
  for (const s of sigs.filter((x) => !x.err).slice(0, 3)) {
    const tx = await getTx(s.signature);
    if (!tx) continue;
    if (!ammV4CreationInLogs(tx.meta.logMessages ?? [])) continue;
    inits++;
    // The same two calls the watcher makes: accounts the instruction
    // touched, then one batch read; the pool is found by owner.
    const keys = keysOf(tx);
    const touched = new Set();
    const take = (ix) => {
      if (keys[ix.programIdIndex] !== RAYDIUM_AMM_V4_PROGRAM) return;
      for (const i of ix.accounts) if (keys[i]) touched.add(keys[i]);
    };
    for (const ix of tx.transaction.message.instructions) take(ix);
    for (const g of tx.meta.innerInstructions ?? []) for (const ix of g.instructions) take(ix);
    const list = [...touched];
    const infos = await rpc('getMultipleAccounts', [list, { encoding: 'base64' }]);
    const byAddr = new Map(list.map((a, i) => [a, infos?.value?.[i] ?? null]));
    let state = null;
    for (const [addr, info] of byAddr) {
      if (!info || info.owner !== RAYDIUM_AMM_V4_PROGRAM) continue;
      state = parsePool(addr, info.owner, Buffer.from(info.data[0], 'base64'));
      if (state) break;
    }
    if (!state) continue;
    const va = byAddr.get(state.vaultA);
    const vb = byAddr.get(state.vaultB);
    const reserves = parseReserves(va ? Buffer.from(va.data[0], 'base64') : null, vb ? Buffer.from(vb.data[0], 'base64') : null);
    if (reserves && priceSolFromReserves(state, reserves) !== null) resolved++;
    console.log(`     v4 creation ${s.signature.slice(0, 8)}… → pool ${state.pool.slice(0, 8)}… ${state.solSide ? `${solInPool(state, reserves ?? { reserveA: 0n, reserveB: 0n })?.toFixed(3)} SOL` : 'not SOL-quoted'}`);
  }
  check('v4 creations carry an InitLog', inits > 0, `${inits} of the newest 3`);
  check('a v4 creation resolves to a priced pool by two calls', resolved > 0, `${resolved}/${inits}`);
}

{
  const sigs = (await rpc('getSignaturesForAddress', [RAYDIUM_CPMM_CREATE_FEE_ACCOUNT, { limit: 5 }])) ?? [];
  check('the CPMM creation fee account has activity', sigs.length > 0, `${sigs.length} signatures, newest ${sigs[0] ? Math.round((Date.now() / 1000 - sigs[0].blockTime) / 60) + ' min ago' : '-'}`);
  let inits = 0;
  let scanned = 0;
  for (const s of sigs.filter((x) => !x.err).slice(0, 3)) {
    const tx = await getTx(s.signature);
    if (!tx) continue;
    scanned++;
    if (cpmmCreationInLogs(tx.meta.logMessages ?? [])) inits++;
    else {
      const own = attributeLogs(tx.meta.logMessages ?? []).filter((t) => t.program === RAYDIUM_CPMM_PROGRAM && t.line.startsWith('Program log: Instruction: '));
      console.log(`     ${s.signature.slice(0, 8)}… touched the fee account without an Initialize: ${own.map((t) => t.line.slice(26)).join(',') || 'no CPMM instruction'}`);
    }
  }
  check('CPMM fee-account transactions are creations', inits > 0 && inits === scanned, `${inits}/${scanned} logged an Initialize* instruction`);
}

// ── The tape, live ────────────────────────────────────────────────────

{
  // A busy pool of each kind: the top Raydium pools by volume, sorted by
  // owner. GeckoTerminal's `raydium` dex holds both programs.
  const gt = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/dexes/raydium/pools?page=1', { headers: { accept: 'application/json' } })
    .then((r) => r.json())
    .catch(() => ({}));
  const candidates = (gt.data ?? []).map((p) => p.attributes.address);
  const picked = { 'amm-v4': null, cpmm: null };
  for (const pool of candidates) {
    if (picked['amm-v4'] && picked.cpmm) break;
    const info = await rpc('getAccountInfo', [pool, { encoding: 'base64' }]);
    if (!info?.value) continue;
    const state = parsePool(pool, info.value.owner, Buffer.from(info.value.data[0], 'base64'));
    if (!state || state.solSide === null || picked[state.kind]) continue;
    picked[state.kind] = state;
  }
  const ticks = { 'amm-v4': 0, cpmm: 0 };
  watcher.attach({
    wssUrls: () => WSS,
    httpUrl: () => RPC,
    commitment: () => 'processed',
    onTick: (t) => {
      const kind = t.pool === picked['amm-v4']?.pool ? 'amm-v4' : 'cpmm';
      ticks[kind]++;
      if (ticks[kind] <= 2) console.log(`     tick ${kind} ${t.isBuy ? 'BUY ' : 'SELL'} ${t.sol.toFixed(4)} SOL @ ${t.priceSol.toExponential(3)} SOL/token`);
    },
    onPool: () => undefined,
    log: (level, line) => console.log(`     [${level}] ${line}`),
  });
  for (const kind of ['amm-v4', 'cpmm']) {
    const st = picked[kind];
    if (!st) {
      check(`found a busy SOL-quoted ${kind} pool to tape`, false, 'none in the top 20');
      continue;
    }
    const got = await watcher.watchPool(st.baseMint, st.pool, () => true);
    check(`watchPool accepts the ${kind} pool ${st.pool.slice(0, 8)}…`, !!got && got.pool === st.pool);
  }
  const LISTEN_MS = 60_000;
  console.log(`     listening ${LISTEN_MS / 1000}s…`);
  await sleep(LISTEN_MS);
  watcher.stopAll();
  for (const kind of ['amm-v4', 'cpmm']) {
    if (!picked[kind]) continue;
    if (kind === 'cpmm' && ticks.cpmm === 0) {
      // SOL-quoted CPMM traffic is sparse — measured 2026-09-19 at ~6 swaps
      // per 25 s across the WHOLE program, spread over several pools — so a
      // quiet minute on one pool is the usual case, not a failure. The
      // per-pool path was cross-checked against the program stream that day:
      // every program-side swap on 8 watched pools arrived on its own pool's
      // subscription, same signature, ~1 ms apart.
      console.log(`note the CPMM pool was quiet for ${LISTEN_MS / 1000}s — nothing to judge; the path is cross-checked in docs/raydium-rail-2026-09-19.md`);
      continue;
    }
    check(`live ticks on the ${kind} pool`, ticks[kind] > 0, `${ticks[kind]} in ${LISTEN_MS / 1000}s`);
  }
  check('no CPMM drift on the live tape', watcher.layoutErrorCount() === 0, `${watcher.layoutErrorCount()} unknown-size events`);
  void rayLogsOf;
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
