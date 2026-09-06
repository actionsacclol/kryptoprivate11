// LIVE check for the Raydium LaunchLab decoder.
//
//   npm run test:launchlab
//
// NOT part of `npm test`: it reads mainnet. Uses the Helius key from settings
// when there is one (the program firehose is heavy for a free endpoint) and
// falls back to the public RPC. The key is never printed.
//
// What this proves that the fixture tests cannot: that LaunchLab still emits
// its TradeEvent as a `Program data:` LOG line. That single fact is what lets
// this rail be taped from one logsSubscribe instead of a getTransaction per
// trade, the way Meteora DBC has to be. If it ever moves to emit_cpi only,
// this check fails and the cheap path is gone.

import fs from 'node:fs';
import { decodeLogs, decodeTradeEvent, LAUNCHLAB_PROGRAM } from './.launchlab.mjs';
import { parsePoolAccount, progressFor } from './.launchlabaccounts.mjs';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let RPC = 'https://api.mainnet-beta.solana.com';
try {
  const key = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.rpc?.heliusApiKey;
  if (key) RPC = `https://mainnet.helius-rpc.com/?api-key=${key}`;
} catch {
  /* public RPC it is */
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
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
};

// ── The firehose ──────────────────────────────────────────────────────

const sigs = (await rpc('getSignaturesForAddress', [LAUNCHLAB_PROGRAM, { limit: 60 }])).result ?? [];
check('the LaunchLab program has recent activity', sigs.length > 0, `${sigs.length} signatures`);
const good = sigs.filter((s) => !s.err);
// Measured 2026-08-24: 95% succeeded, against pump's 4%. A collapse here means
// something changed in the program, not in this decoder.
check('most LaunchLab transactions succeed', good.length > sigs.length * 0.5, `${good.length}/${sigs.length} ok`);

let decoded = 0;
let scanned = 0;
let fromLogs = 0;
let buys = 0;
let sells = 0;
const poolsSeen = new Set();

for (const s of good.slice(0, 12)) {
  const tx = (await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }])).result;
  if (!tx || tx.meta?.err) continue;
  scanned++;
  const logs = tx.meta.logMessages ?? [];
  const evs = decodeLogs(logs);
  if (logs.some((l) => l.startsWith('Program data: '))) fromLogs++;
  for (const ev of evs) {
    decoded++;
    poolsSeen.add(ev.pool);
    if (ev.isBuy) buys++;
    else sells++;
    if (ev.amountIn <= 0n || ev.amountOut <= 0n) {
      check(`event amounts are positive (${s.signature.slice(0, 8)})`, false, `${ev.amountIn}/${ev.amountOut}`);
    }
  }
}

check('transactions still carry Program data: log lines', fromLogs > 0, `${fromLogs}/${scanned}`);
check('trades decode straight from the log stream', decoded > 0, `${decoded} events from ${scanned} txs`);
check('both directions are represented or at least one decodes', buys + sells > 0, `${buys} buys, ${sells} sells`);

// ── Pool accounts ─────────────────────────────────────────────────────

const gt = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/dexes/raydium-launchlab/pools?page=1', {
  headers: { accept: 'application/json' },
});
let pools = [];
try {
  const body = JSON.parse(await gt.text());
  pools = (body?.data ?? []).map((p) => p.attributes?.address).filter(Boolean).slice(0, 10);
} catch {
  /* GeckoTerminal rate limit — the account check is skipped below */
}
check('GeckoTerminal lists raydium-launchlab pools', pools.length > 0, `${pools.length}`);

if (pools.length) {
  const states = await progressFor(RPC, pools);
  check('pool accounts parse at the expected layout', states.size > 0, `${states.size}/${pools.length}`);
  const all = [...states.values()];
  check(
    'every progress reading is a real percentage or an honest null',
    all.every((s) => s.progressPct === null || (s.progressPct >= 0 && s.progressPct <= 100)),
  );
  check(
    'a migrated pool is at its target',
    all.filter((s) => s.isMigrated).every((s) => (s.progressPct ?? 0) > 99),
    `${all.filter((s) => s.isMigrated).length} migrated`,
  );
  check(
    'active pools are below their target',
    all.filter((s) => !s.isMigrated).every((s) => (s.progressPct ?? 0) < 100),
    `${all.filter((s) => !s.isMigrated).length} active`,
  );
  check('base decimals look like a token', all.every((s) => s.baseDecimals >= 0 && s.baseDecimals <= 18));
  // Not every LaunchLab pool is SOL-quoted — 3 of 10 were stablecoin-quoted
  // when this was written. The flag must reflect the quote mint, not assume.
  const solQuoted = all.filter((s) => s.isSolQuoted).length;
  check('SOL-quoted pools are identified', solQuoted > 0, `${solQuoted}/${all.length} quote in SOL`);
  check(
    'quote decimals agree with the quote mint',
    all.every((s) => (s.isSolQuoted ? s.quoteDecimals === 9 : s.quoteDecimals !== 9)),
  );

  const first = [...states.values()][0];
  if (first) {
    const raw = (await rpc('getAccountInfo', [first.pool, { encoding: 'base64' }])).result?.value;
    if (raw) {
      const again = parsePoolAccount(first.pool, Buffer.from(raw.data[0], 'base64'));
      check('a re-read of the same pool parses identically', again?.baseMint === first.baseMint);
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL LAUNCHLAB CHECKS PASSED' : `${failures} LAUNCHLAB CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
