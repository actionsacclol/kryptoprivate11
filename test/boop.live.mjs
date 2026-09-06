// LIVE check for Boop — decoder, curve accounts, and the websocket tape.
//
//   npm run test:boop
//
// Proves the three claims this rail rests on: its events are LOG lines (so one
// subscription tapes everything), its pool is derivable from the mint (so
// nothing needs looking up), and its events name the TRADER (so trader scan
// and copy trading work here, unlike LaunchLab).
//
// ─── Boop is usually asleep ───────────────────────────────────────────
//
// Measured 2026-08-24: its last 100 signatures spanned TWENTY DAYS and the
// newest was 10 hours old — roughly five transactions a day, against
// LaunchLab's ten a minute. A websocket window will normally see nothing, and
// failing on that would report a dormant launchpad as a broken decoder. So
// when the rail is asleep this verifies against its HISTORY instead, and says
// which mode it ran in.

import fs from 'node:fs';
import WebSocket from 'ws';
import { decodeLogs, BOOP_PROGRAM } from './.boop.mjs';
import { parsePoolAccount, poolFor, progressForMints, BOOP_DECIMALS } from './.boopaccounts.mjs';
import * as watcher from './.boopwatcher.mjs';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let RPC = 'https://api.mainnet-beta.solana.com';
let WSS = 'wss://api.mainnet-beta.solana.com';
try {
  const k = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.rpc?.heliusApiKey;
  if (k) {
    RPC = `https://mainnet.helius-rpc.com/?api-key=${k}`;
    WSS = `wss://mainnet.helius-rpc.com/?api-key=${k}`;
  }
} catch {
  /* public endpoints */
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  try {
    return JSON.parse(await r.text());
  } catch {
    return {};
  }
};

// ── Is this rail even awake? ──────────────────────────────────────────

const recent = (await rpc('getSignaturesForAddress', [BOOP_PROGRAM, { limit: 100 }])).result ?? [];
const times = recent.map((s) => s.blockTime).filter(Boolean);
const newestAgeMin = times.length ? (Date.now() / 1000 - Math.max(...times)) / 60 : Infinity;
check('the Boop program has history', recent.length > 0, `${recent.length} signatures`);
const awake = newestAgeMin < 20;
console.log(
  `     newest Boop transaction ${Number.isFinite(newestAgeMin) ? newestAgeMin.toFixed(0) : '?'} min ago — rail is ${awake ? 'ACTIVE' : 'DORMANT'}`,
);

const seen = new Map();
const traders = new Set();

if (awake) {
  await new Promise((resolve) => {
    const ws = new WebSocket(WSS);
    const done = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [BOOP_PROGRAM] }, { commitment: 'confirmed' }],
        }),
      ),
    );
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.method !== 'logsNotification') return;
      for (const ev of decodeLogs(m.params?.result?.value?.logs ?? [])) {
        seen.set(ev.mint, (seen.get(ev.mint) ?? 0) + 1);
        if (ev.trader) traders.add(ev.trader);
      }
    });
    ws.on('error', done);
    setTimeout(done, 40_000);
  });
} else {
  for (const sig of recent.filter((s) => !s.err).slice(0, 12)) {
    const tx = (
      await rpc('getTransaction', [sig.signature, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }])
    ).result;
    if (!tx || tx.meta?.err) continue;
    for (const ev of decodeLogs(tx.meta.logMessages ?? [])) {
      seen.set(ev.mint, (seen.get(ev.mint) ?? 0) + 1);
      if (ev.trader) traders.add(ev.trader);
    }
  }
}

check(`trades decode from ${awake ? 'the LIVE log stream' : 'recent history'}`, seen.size > 0, `${seen.size} mints`);
check('events name the trader', traders.size > 0, `${traders.size} distinct wallets`);
if (!seen.size) {
  console.log('\nno decodable Boop trades found — cannot verify further');
  process.exit(1);
}

// ── Curve accounts, reached from the mint alone ───────────────────────

const mints = [...seen.keys()].slice(0, 20);
const states = await progressForMints(RPC, mints);
check('curve accounts resolve from the MINT alone', states.size > 0, `${states.size}/${mints.length}`);
const all = [...states.values()];
check(
  'progress is a real percentage or an honest null',
  all.every((s) => s.progressPct === null || (s.progressPct >= 0 && s.progressPct <= 100)),
);
check('every pool carries its own graduation target', all.every((s) => s.solTarget > 0n));
check('prices are positive where known', all.every((s) => s.priceLamports === null || s.priceLamports > 0));
if (all.length) {
  const s = all[0];
  console.log(
    `     e.g. ${s.mint.slice(0, 10)} progress ${s.progressPct?.toFixed(2)}% of ${(Number(s.solTarget) / 1e9).toFixed(0)} SOL`,
  );
}

const first = all[0];
if (first) {
  const raw = (await rpc('getAccountInfo', [poolFor(first.mint), { encoding: 'base64' }])).result?.value;
  check('the derived pool address IS the real account', !!raw, poolFor(first.mint).slice(0, 10));
  if (raw) {
    const again = parsePoolAccount(poolFor(first.mint), Buffer.from(raw.data[0], 'base64'));
    check('a re-read parses to the same mint', again?.mint === first.mint);
  }
}

// ── The watcher end to end ────────────────────────────────────────────

if (!awake) {
  console.log('\n     SKIPPED the websocket tape — the rail is dormant, so there is nothing to receive.');
  console.log('     Everything above is verified against real Boop transactions.');
} else {
  const ticks = [];
  watcher.attach({
    wssUrls: () => [WSS],
    commitment: () => 'confirmed',
    onTick: (t) => ticks.push(t),
    log: (lvl, line) => console.log(`     [${lvl}] ${line}`),
  });
  for (const mint of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([m]) => m)) {
    watcher.watch(mint, BOOP_DECIMALS);
  }
  check('watching the active mints', watcher.watchedMints().length > 0, `${watcher.watchedMints().length}`);
  console.log('\n     waiting 60s for live ticks…');
  await new Promise((r) => setTimeout(r, 60_000));
  watcher.stopAll();

  check('the tape received live trades', ticks.length > 0, `${ticks.length} ticks`);
  if (ticks.length) {
    check('every tick has a positive price and amounts', ticks.every((t) => t.priceSol > 0 && t.sol > 0 && t.tokens > 0));
    // The headline difference from LaunchLab.
    check('every tick names a real wallet', ticks.every((t) => t.wallet && t.wallet.length >= 32));
    const t = ticks[0];
    console.log(`     first tick: ${t.isBuy ? 'BUY ' : 'SELL'} ${t.sol.toFixed(6)} SOL · ${t.tokens.toFixed(0)} tokens · ${t.wallet.slice(0, 8)}…`);
  }
}

console.log(`\n${failures === 0 ? 'ALL BOOP CHECKS PASSED' : `${failures} BOOP CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
