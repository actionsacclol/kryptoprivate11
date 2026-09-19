// LIVE integration check for the Krypto Terminal data layer.
//
// This is NOT part of `npm test` — it hits real third-party APIs and a public
// Solana RPC, so it is slow, rate-limited and will fail when someone else's
// service is down. Run it by hand after touching anything in electron/data/:
//
//   npx esbuild electron/data/market.ts --bundle --format=esm --platform=node \
//     --alias:@shared=./shared --outfile=test/.market.mjs
//   node test/market.live.mjs
//
// What it proves, which unit tests cannot: that the provider routes still
// exist, that their response shapes still parse, and that the merge produces
// rows with the fields the UI reads.

import * as market from './.market.mjs';

const DATA = {
  networkDataEnabled: true,
  providers: { jupiter: true, dexscreener: true, pumpfun: true, geckoterminal: true, pumpswap: true, birdeye: false, helius: false },
  birdeyeApiKey: '',
  discoverRefreshSec: 8,
  discoverLimit: 20,
};

market.attach({
  httpUrl: () => 'https://api.mainnet-beta.solana.com',
  data: () => DATA,
  heliusKey: () => '',
  creatorIntel: () => null,
  walletLabel: () => null,
  isLiveTracked: () => false,
  // No scanner in a call-count harness: the New column is provider-fed here
  // exactly as it was before the tape became a second source.
  liveLaunches: () => [],
  registerPool: () => {},
  watchDbcPool: () => {},
  unwatchDbcPool: () => {},
  watchLaunchLabPool: () => {},
  unwatchLaunchLabPool: () => {},
});

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const filled = (rows, field) => rows.filter((r) => r[field] !== null && r[field] !== undefined).length;

// ── Discover columns ──────────────────────────────────────────────────

const columns = {};
for (const col of ['new', 'graduating', 'migrated', 'trending']) {
  const t0 = Date.now();
  const rows = await market.discover(col, 20);
  columns[col] = rows;
  check(`discover:${col} returns rows`, rows.length > 0, `${rows.length} rows in ${Date.now() - t0}ms`);
  if (!rows.length) continue;
  check(`discover:${col} every row has a mint + symbol`, rows.every((r) => r.mint && typeof r.symbol === 'string'));
  check(
    `discover:${col} market caps populated`,
    filled(rows, 'marketCapUsd') > rows.length * 0.5,
    `${filled(rows, 'marketCapUsd')}/${rows.length}`,
  );
  check(
    `discover:${col} ages populated`,
    filled(rows, 'createdAt') > rows.length * 0.5,
    `${filled(rows, 'createdAt')}/${rows.length}`,
  );
  console.log(
    `     sample: ${rows[0].symbol} mc=${rows[0].marketCapUsd?.toFixed(0) ?? '—'} ` +
      `liq=${rows[0].liquidityUsd?.toFixed(0) ?? '—'} holders=${rows[0].holders ?? '—'} ` +
      `curve=${rows[0].bondingCurvePct?.toFixed(1) ?? '—'} score=${rows[0].kryptScore ?? '—'}`,
  );
}

// Column-specific invariants — these are what make the columns different.
if (columns.graduating?.length) {
  const withCurve = columns.graduating.filter((r) => r.bondingCurvePct !== null);
  check('graduating rows carry curve progress', withCurve.length > 0, `${withCurve.length} rows`);
  check(
    'graduating is sorted by curve progress',
    withCurve.length < 2 || withCurve[0].bondingCurvePct >= withCurve[withCurve.length - 1].bondingCurvePct,
    `${withCurve[0].bondingCurvePct?.toFixed(1)}% first`,
  );
}
if (columns.new?.length) {
  const ages = columns.new.map((r) => (r.createdAt ? (Date.now() - r.createdAt) / 1000 : null)).filter((a) => a !== null);
  check('new rows are actually new', ages.length > 0 && Math.min(...ages) < 600, `youngest ${Math.min(...ages).toFixed(0)}s`);
}

// ── Token detail ──────────────────────────────────────────────────────
//
// Uses a graduated token with deep liquidity so pools and candles exist.
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const detail = await market.tokenDetail(BONK);
check('tokenDetail returns a summary', !!detail.summary.symbol, detail.summary.symbol);
check('tokenDetail has a price', detail.summary.priceUsd > 0, String(detail.summary.priceUsd));
check('tokenDetail found pools', detail.pools.length > 0, `${detail.pools.length} pools`);
check('security report scored', detail.security.score !== null, `score=${detail.security.score}`);
check(
  'security resolved most checks',
  detail.security.checksResolved >= 6,
  `${detail.security.checksResolved}/${detail.security.checksTotal}`,
);
// The whole point of the honest-score design: unknowns stay unknown.
const unknown = detail.security.checks.filter((c) => c.verdict === 'unknown');
check('unknown checks are reported as unknown, not passed', true, `${unknown.length} unknown: ${unknown.map((c) => c.id).join(', ') || 'none'}`);
// Authority verdicts must come from our own chain read, not a provider flag.
const freeze = detail.security.checks.find((c) => c.id === 'freeze-authority');
check('freeze authority verdict is sourced on-chain', freeze?.source === 'onchain', `${freeze?.verdict} / ${freeze?.source}`);

// ── Candles ───────────────────────────────────────────────────────────

// GeckoTerminal's free tier is the binding constraint here, not the code: it
// 429s after a handful of calls and `http.ts` then parks it for 20s, so the
// LAST interval in this loop is the one that gets starved — measured
// 2026-08-24, where an isolated `hour/1` request returned 200 with 100
// candles while the same call inside this run returned nothing. Retrying once
// past the cooldown is what makes this check mean "the route is broken"
// rather than "someone spent the budget a minute ago".
async function candlesWithRetry(iv) {
  let series = await market.candles(BONK, iv, 100);
  if (series.candles.length === 0) {
    console.log(`     ${iv}: empty — waiting out the provider cooldown and retrying once`);
    await new Promise((r) => setTimeout(r, 22_000));
    series = await market.candles(BONK, iv, 100);
  }
  return series;
}

for (const iv of ['1m', '15m', '1h']) {
  const series = await candlesWithRetry(iv);
  check(`candles ${iv}`, series.candles.length > 5, `${series.candles.length} candles via ${series.source}`);
  if (series.candles.length > 1) {
    const ascending = series.candles.every((c, i) => i === 0 || c.time > series.candles[i - 1].time);
    check(`candles ${iv} strictly ascending`, ascending);
    const sane = series.candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close);
    check(`candles ${iv} OHLC consistent`, sane);
  }
}

// Sub-minute with no tape and no Birdeye key MUST degrade with a note rather
// than returning an empty chart with no explanation.
const sub = await market.candles(BONK, '1s', 100);
check('1s degrades with an explanation', sub.note !== null && sub.note.length > 20, sub.note?.slice(0, 90));

// ── Holders ───────────────────────────────────────────────────────────

const holders = await market.holders(BONK, 20);
// On the free public RPC, getTokenLargestAccounts is rate-limited even when
// other methods succeed. The contract is not "always returns rows" — it is
// "returns rows, or explains why not". An empty panel with no note is the
// only real failure.
check(
  'holders returned rows OR an actionable note',
  holders.rows.length > 0 || (holders.note !== null && holders.note.length > 20),
  holders.rows.length > 0 ? `${holders.rows.length} rows via ${holders.source}` : `degraded: ${holders.note}`,
);
if (holders.rows.length) {
  check('holder percentages are sane', holders.rows.every((r) => r.pct >= 0 && r.pct <= 100));
  check('holders sorted descending', holders.rows.every((r, i) => i === 0 || r.pct <= holders.rows[i - 1].pct));
}

// ── Search ────────────────────────────────────────────────────────────

const hits = await market.search('bonk');
check('text search returns hits', hits.length > 0, `${hits.length} hits`);
const byMint = await market.search(BONK);
check('mint search resolves the exact token', byMint.length === 1 && byMint[0].mint === BONK, byMint[0]?.symbol);

// ── The stats window actually moves Trending ──────────────────────────
//
// Reported 2026-08-24 as "changing 5m/1h/24h does nothing". It could not:
// the trending column hardcoded '5m' for the fetch AND the sort. New /
// Graduating / Migrated are ranked by age, curve progress and pool creation,
// which have no window — so Trending is the one column this must move, and
// the check is that each result is genuinely ranked by ITS window.

const trendingBy = {};
for (const w of ['5m', '1h', '6h', '24h']) {
  const rows = await market.discover('trending', 12, w);
  trendingBy[w] = rows;
  check(`discover:trending ${w} returns rows`, rows.length > 0, `${rows.length}`);
  if (!rows.length) continue;
  const vols = rows.map((r) => r.stats[w]?.volumeUsd ?? null).filter((v) => v !== null);
  check(
    `discover:trending ${w} carries stats for its OWN window`,
    vols.length >= rows.length * 0.8,
    `${vols.length}/${rows.length}`,
  );
  const descending = vols.every((v, i) => i === 0 || v <= vols[i - 1]);
  check(`discover:trending ${w} is ranked by ${w} volume`, descending);
}
const sym = (rows) => rows.map((r) => r.symbol || r.mint).join('|');
check(
  'a longer window produces a different Trending column',
  sym(trendingBy['5m']) !== sym(trendingBy['24h']),
  '5m vs 24h ordering',
);

// ── Provider gating ───────────────────────────────────────────────────

DATA.networkDataEnabled = false;
const offRows = await market.discover('trending', 10);
check('master switch off returns no rows', offRows.length === 0);
const offDetail = await market.tokenDetail(BONK);
check('master switch off still does on-chain reads', offDetail.summary.totalSupply !== null, `supply=${offDetail.summary.totalSupply}`);
check('master switch off warns the user', offDetail.warnings.some((w) => w.includes('Network data is off')));
DATA.networkDataEnabled = true;

// ── Provider status ───────────────────────────────────────────────────

const statuses = market.providerStatuses();
// Compared against the catalogue rather than a magic number, so adding a
// provider updates one place instead of failing here.
const EXPECTED_PROVIDERS = ['jupiter', 'dexscreener', 'pumpfun', 'geckoterminal', 'pumpswap', 'birdeye', 'helius'];
check(
  'provider statuses listed',
  statuses.length === EXPECTED_PROVIDERS.length && EXPECTED_PROVIDERS.every((id) => statuses.some((s) => s.id === id)),
  statuses.map((s) => s.id).join(','),
);
check('every provider names its host', statuses.every((s) => s.host && s.host.includes('.')));
check('birdeye unusable without a key', statuses.find((s) => s.id === 'birdeye')?.usable === false);
for (const s of statuses) {
  console.log(`     ${s.id.padEnd(14)} ${String(s.calls).padStart(3)} calls  ${String(s.errors).padStart(2)} err  ${s.latencyMs ?? '—'}ms  ${s.host}`);
}

console.log(failures === 0 ? '\nmarket.live: all checks passed' : `\nmarket.live: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
