// LIVE check for the Birdeye provider — needs a key, so NOT part of `npm test`.
//
//   npm run test:birdeye
//
// The key is read from BIRDEYE_KEY, or from the app's own settings.json if
// that is not set. It is never printed.
//
// This file exists because birdeye.ts shipped UNVERIFIED — written from
// published docs, never exercised. The first run against a real key found two
// faults that had silently disabled its entire purpose:
//
//   1. OHLCV used `/defi/ohlcv`, which rejects 1s/15s with "type invalid
//      format". Sub-minute candles for non-tracked mints are the whole reason
//      this provider exists, and none of them worked.
//   2. `/defi/v3/ohlcv` spells the timestamp `unix_time`, not `unixTime`, so
//      after switching routes every item was skipped and the chart reported
//      "no data" against a 200 response with a full page.
//
// Both are the same class of bug: a provider answering correctly while we
// throw the answer away. Only a live run catches it.

import fs from 'node:fs';
import * as be from './.birdeye.mjs';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let KEY = process.env.BIRDEYE_KEY ?? '';
if (!KEY) {
  try {
    KEY = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.data?.birdeyeApiKey ?? '';
  } catch {
    /* no settings file — env var only */
  }
}
if (!KEY) {
  console.log('SKIP — no Birdeye key (set BIRDEYE_KEY or add one in Settings → Market data)');
  process.exit(0);
}

/** A deep-liquidity mint, so every route has something to return. */
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const pause = () => new Promise((r) => setTimeout(r, 1_200));

// ── Candles, including the sub-minute ones only Birdeye can serve ─────

for (const iv of ['1s', '15s', '1m']) {
  const candles = await be.ohlcv(KEY, MINT, iv, 50);
  check(`ohlcv ${iv}`, Array.isArray(candles) && candles.length > 5, candles ? `${candles.length} candles` : 'null');
  if (Array.isArray(candles) && candles.length > 1) {
    check(`ohlcv ${iv} strictly ascending`, candles.every((c, i) => i === 0 || c.time > candles[i - 1].time));
    check(
      `ohlcv ${iv} OHLC consistent`,
      candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close),
    );
    check(
      `ohlcv ${iv} timestamps are seconds, not ms`,
      candles.every((c) => c.time > 1_000_000_000 && c.time < 10_000_000_000),
      `${candles[0].time}`,
    );
  }
  await pause();
}

// ── Holders: the reason a key is worth having ────────────────────────
//
// Both free RPCs refuse getTokenLargestAccounts (429/403), so without this
// the holder list, concentration and bubble map are all empty.

const holders = await be.holders(KEY, MINT, 50);
check('holders', Array.isArray(holders) && holders.length > 0, holders ? `${holders.length} rows` : 'null');
if (Array.isArray(holders) && holders.length) {
  check(
    'holders resolve owners',
    holders.filter((h) => h.owner).length > holders.length * 0.8,
    `${holders.filter((h) => h.owner).length}/${holders.length}`,
  );
  check('holders are ordered largest first', holders.every((h, i) => i === 0 || h.amount <= holders[i - 1].amount));
  check('holder amounts are positive', holders.every((h) => h.amount > 0));
  // pct is deliberately 0 here — the caller fills it, being the only side
  // that knows total supply. Asserting otherwise would be asserting a bug.
  check('holder pct is left for the caller to fill', holders.every((h) => h.pct === 0));
}
await pause();

// ── Trades ───────────────────────────────────────────────────────────

const trades = await be.trades(KEY, MINT, 30);
check('trades', Array.isArray(trades) && trades.length > 0, trades ? `${trades.length} rows` : 'null');
if (Array.isArray(trades) && trades.length) {
  check('trades carry a wallet and an amount', trades.every((t) => t.wallet && Number.isFinite(t.solAmount)));
  check('trades are time-ordered', trades.every((t, i) => i === 0 || t.at <= trades[i - 1].at));
}

console.log(`\n${failures === 0 ? 'ALL BIRDEYE CHECKS PASSED' : `${failures} BIRDEYE CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
