// Unit tests for the terminal's pure logic — filters, tape aggregation and
// the honest-score rule. No network, so these run in `npm test`.
//
// The rules under test are the ones that are easy to break by accident and
// expensive to get wrong in a trading UI:
//   1. an unknown metric must not fail a filter;
//   2. an unknown security check must not count as a pass;
//   3. the tape must never invent a candle for a period with no trades.

import assert from 'node:assert';
import { emptyFilters, emptySummary, passesFilters, builtinPresets, windowExceedsAge, WINDOW_SECONDS, sameRow, reuseRows } from './.marketshared.mjs';
import * as tape from './.tape.mjs';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
};

// ── Filters ───────────────────────────────────────────────────────────

test('an untouched filter set matches everything', () => {
  const t = emptySummary('mint1');
  assert.equal(passesFilters(t, emptyFilters()), true);
});

test('an unknown metric is SKIPPED by an active filter, not rejected', () => {
  // This is the rule that keeps fresh mints visible: holder counts arrive
  // seconds after the row does, and rejecting on null would blank the NEW
  // column the moment anyone set a holder floor.
  const t = emptySummary('mint1');
  t.holders = null;
  const f = { ...emptyFilters(), holders: { min: 500, max: null } };
  assert.equal(passesFilters(t, f), true);
});

test('a known metric outside the range IS rejected', () => {
  const t = emptySummary('mint1');
  t.holders = 12;
  const f = { ...emptyFilters(), holders: { min: 500, max: null } };
  assert.equal(passesFilters(t, f), false);
});

test('max bound rejects above, accepts at the boundary', () => {
  const t = emptySummary('mint1');
  const f = { ...emptyFilters(), top10Pct: { min: null, max: 30 } };
  t.top10Pct = 30;
  assert.equal(passesFilters(t, f), true);
  t.top10Pct = 30.1;
  assert.equal(passesFilters(t, f), false);
});

test('age filter uses the injected clock', () => {
  const now = 1_000_000_000_000;
  const t = emptySummary('mint1');
  t.createdAt = now - 120_000; // 2 minutes old
  assert.equal(passesFilters(t, { ...emptyFilters(), ageSec: { min: null, max: 60 } }, now), false);
  assert.equal(passesFilters(t, { ...emptyFilters(), ageSec: { min: null, max: 300 } }, now), true);
});

test('buy/sell ratio is computed from the selected window only', () => {
  const t = emptySummary('mint1');
  t.stats = {
    '5m': { priceChangePct: null, volumeUsd: null, buys: 10, sells: 2, traders: null, organicVolumeUsd: null },
    '1h': { priceChangePct: null, volumeUsd: null, buys: 2, sells: 10, traders: null, organicVolumeUsd: null },
  };
  const f = { ...emptyFilters(), buySellRatio: { min: 2, max: null } };
  assert.equal(passesFilters(t, { ...f, window: '5m' }), true);
  assert.equal(passesFilters(t, { ...f, window: '1h' }), false);
});

test('a zero-sell window does not divide by zero', () => {
  const t = emptySummary('mint1');
  t.stats = {
    '5m': { priceChangePct: null, volumeUsd: null, buys: 10, sells: 0, traders: null, organicVolumeUsd: null },
  };
  // sells === 0 makes the ratio unknowable, so the filter is skipped.
  assert.equal(passesFilters(t, { ...emptyFilters(), buySellRatio: { min: 2, max: null } }), true);
});

test('social requirements gate on presence', () => {
  const t = emptySummary('mint1');
  assert.equal(passesFilters(t, { ...emptyFilters(), requireTwitter: true }), false);
  t.socials.twitter = 'https://x.com/x';
  assert.equal(passesFilters(t, { ...emptyFilters(), requireTwitter: true }), true);
});

test('search matches name, symbol and mint', () => {
  const t = emptySummary('So11111111111111111111111111111111111111112');
  t.name = 'Wrapped SOL';
  t.symbol = 'SOL';
  for (const q of ['wrapped', 'SOL', 'So1111']) {
    assert.equal(passesFilters(t, { ...emptyFilters(), search: q }), true, `query ${q}`);
  }
  assert.equal(passesFilters(t, { ...emptyFilters(), search: 'bonk' }), false);
});

test('every builtin preset is a complete filter object', () => {
  const presets = builtinPresets();
  assert.equal(presets.length, 6);
  const keys = Object.keys(emptyFilters()).sort();
  for (const p of presets) {
    assert.deepEqual(Object.keys(p.filters).sort(), keys, `${p.id} is missing fields`);
  }
});

test('preset NUMERIC bounds never reject a token for missing data', () => {
  // Categorical constraints (launchpad, required socials) legitimately
  // exclude an unknown token — that is what picking a set means. The numeric
  // half must not, or a preset would empty the column it is applied to as
  // soon as one provider was slow.
  for (const p of builtinPresets()) {
    const numericOnly = {
      ...p.filters,
      launchpads: [],
      dexIds: [],
      requireTwitter: false,
      requireTelegram: false,
      requireWebsite: false,
      requireDexPaid: false,
    };
    assert.equal(
      passesFilters(emptySummary('m'), numericOnly),
      true,
      `${p.id} rejects a token with no metrics on its numeric bounds alone`,
    );
  }
});

// ── Stats window ──────────────────────────────────────────────────────
//
// Reported as "the 5m / 1h / 24h buttons do nothing": on the New column they
// genuinely cannot, because a token 40 seconds old has one set of trades, so
// every window shows the same number. The UI marks that case rather than
// leaving the buttons looking broken — this pins the rule it marks on.

test('a token younger than the window is flagged', () => {
  const now = 1_700_000_000_000;
  const born = (secondsAgo) => now - secondsAgo * 1000;
  assert.equal(windowExceedsAge(born(40), '5m', now), true, '40s old, 5m window');
  assert.equal(windowExceedsAge(born(40), '24h', now), true);
  assert.equal(windowExceedsAge(born(600), '5m', now), false, '10m old fills a 5m window');
  assert.equal(windowExceedsAge(born(600), '1h', now), true);
});

test('the window boundary is not flagged', () => {
  const now = 1_700_000_000_000;
  assert.equal(windowExceedsAge(now - WINDOW_SECONDS['5m'] * 1000, '5m', now), false, 'exactly 5m old');
  assert.equal(windowExceedsAge(now - WINDOW_SECONDS['5m'] * 1000 + 1, '5m', now), true);
});

test('an unknown creation time is never flagged', () => {
  // Honest-null rule: we do not know the age, so we make no claim about it.
  assert.equal(windowExceedsAge(null, '24h'), false);
  assert.equal(windowExceedsAge(0, '24h'), false);
  assert.equal(windowExceedsAge(NaN, '24h'), false);
});

test('a categorical filter DOES exclude an unknown launchpad', () => {
  const t = emptySummary('m'); // launchpad: 'unknown'
  assert.equal(passesFilters(t, { ...emptyFilters(), launchpads: ['pumpfun'] }), false);
  t.launchpad = 'pumpfun';
  assert.equal(passesFilters(t, { ...emptyFilters(), launchpads: ['pumpfun'] }), true);
});

// ── Tape ──────────────────────────────────────────────────────────────

const MINT = 'TapeMint1111111111111111111111111111111111';
const T0 = 1_700_000_000_000; // aligned to a whole second

test('tape records nothing until subscribed', () => {
  tape.clear();
  tape.record(MINT, { at: T0, wallet: 'w1', isBuy: true, sol: 1, tokens: 100, priceSol: 0.01 });
  assert.equal(tape.candles(MINT, '1s', 10).length, 0);
});

test('tape aggregates ticks into 1s candles', () => {
  tape.clear();
  tape.subscribe(MINT);
  // Three ticks in the same second, then one in the next.
  tape.record(MINT, { at: T0 + 100, wallet: 'w1', isBuy: true, sol: 1, tokens: 100, priceSol: 0.010 });
  tape.record(MINT, { at: T0 + 400, wallet: 'w2', isBuy: true, sol: 2, tokens: 180, priceSol: 0.012 });
  tape.record(MINT, { at: T0 + 900, wallet: 'w3', isBuy: false, sol: 1, tokens: 90, priceSol: 0.011 });
  tape.record(MINT, { at: T0 + 1500, wallet: 'w4', isBuy: true, sol: 3, tokens: 250, priceSol: 0.013 });

  const candles = tape.candles(MINT, '1s', 10);
  assert.equal(candles.length, 2);
  const [first, second] = candles;
  assert.equal(first.open, 0.010);
  assert.equal(first.high, 0.012);
  assert.equal(first.low, 0.010);
  assert.equal(first.close, 0.011);
  assert.equal(first.volume, 4); // 1 + 2 + 1
  assert.equal(second.open, 0.013);
  assert.equal(second.volume, 3);
  assert.equal(second.time - first.time, 1);
});

test('tape does NOT fill gaps with synthetic candles', () => {
  // A flat invented candle in an illiquid token is the artefact that gets
  // someone to buy a corpse. A period with no trades gets no candle.
  tape.clear();
  tape.subscribe(MINT);
  tape.record(MINT, { at: T0, wallet: 'w1', isBuy: true, sol: 1, tokens: 100, priceSol: 0.01 });
  tape.record(MINT, { at: T0 + 60_000, wallet: 'w2', isBuy: true, sol: 1, tokens: 100, priceSol: 0.02 });
  const candles = tape.candles(MINT, '1s', 200);
  assert.equal(candles.length, 2, 'expected exactly two candles, not 61');
});

test('tape buckets align to the interval', () => {
  tape.clear();
  tape.subscribe(MINT);
  for (let i = 0; i < 10; i++) {
    tape.record(MINT, { at: T0 + i * 1000, wallet: 'w', isBuy: true, sol: 1, tokens: 1, priceSol: 0.01 });
  }
  const c5 = tape.candles(MINT, '5s', 10);
  assert.equal(c5.length, 2);
  assert.equal(c5[0].time % 5, 0);
  assert.equal(c5[0].volume, 5);
});

test('tape rejects non-positive prices rather than charting them', () => {
  tape.clear();
  tape.subscribe(MINT);
  tape.record(MINT, { at: T0, wallet: 'w1', isBuy: true, sol: 1, tokens: 100, priceSol: 0 });
  tape.record(MINT, { at: T0 + 100, wallet: 'w2', isBuy: true, sol: 1, tokens: 100, priceSol: NaN });
  tape.record(MINT, { at: T0 + 200, wallet: 'w3', isBuy: true, sol: 1, tokens: 100, priceSol: 0.01 });
  const candles = tape.candles(MINT, '1s', 10);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].open, 0.01);
});

test('subscriptions are bounded and evict the least recently touched', () => {
  tape.clear();
  const mints = [];
  for (let i = 0; i < 10; i++) {
    const m = `Mint${String(i).padStart(40, '0')}`;
    mints.push(m);
    tape.subscribe(m);
  }
  assert.equal(tape.subscriptions().length, 8, 'subscription budget is 8');
  assert.equal(tape.isSubscribed(mints[9]), true, 'newest kept');
  assert.equal(tape.isSubscribed(mints[0]), false, 'oldest evicted');
});

test('traderScan aggregates per wallet and nets tokens', () => {
  tape.clear();
  tape.subscribe(MINT);
  tape.record(MINT, { at: T0, wallet: 'whale', isBuy: true, sol: 5, tokens: 500, priceSol: 0.01 });
  tape.record(MINT, { at: T0 + 1000, wallet: 'whale', isBuy: false, sol: 2, tokens: 150, priceSol: 0.013 });
  tape.record(MINT, { at: T0 + 2000, wallet: 'shrimp', isBuy: true, sol: 0.1, tokens: 8, priceSol: 0.0125 });

  const rows = tape.traderScan(MINT, (w) => (w === 'whale' ? 'Sharky' : null));
  assert.equal(rows.length, 2);
  const whale = rows.find((r) => r.wallet === 'whale');
  assert.equal(whale.label, 'Sharky');
  assert.equal(whale.boughtSol, 5);
  assert.equal(whale.soldSol, 2);
  assert.equal(whale.tokensNet, 350);
  assert.equal(whale.entryPriceSol, 0.01, 'entry is the FIRST buy price, not the last');
  // Sorted by total flow, so the whale leads.
  assert.equal(rows[0].wallet, 'whale');
});

test('trades are returned newest-first with labels and market cap', () => {
  tape.clear();
  tape.subscribe(MINT);
  tape.record(MINT, { at: T0, wallet: 'w1', isBuy: true, sol: 1, tokens: 100, priceSol: 0.01 });
  tape.record(MINT, { at: T0 + 1000, wallet: 'w2', isBuy: false, sol: 2, tokens: 150, priceSol: 0.02 });

  const rows = tape.trades(MINT, 10, (w) => (w === 'w2' ? 'Tracked' : null), 200, 1_000_000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].at, T0 + 1000, 'newest first');
  assert.equal(rows[0].side, 'sell');
  assert.equal(rows[0].label, 'Tracked');
  assert.equal(rows[0].priceUsd, 0.02 * 200);
  assert.equal(rows[0].marketCapUsd, 0.02 * 200 * 1_000_000);
});

test('trades leave USD null when the SOL price is unknown', () => {
  tape.clear();
  tape.subscribe(MINT);
  tape.record(MINT, { at: T0, wallet: 'w1', isBuy: true, sol: 1, tokens: 100, priceSol: 0.01 });
  const rows = tape.trades(MINT, 10, () => null, null, 1_000_000);
  assert.equal(rows[0].priceUsd, null);
  assert.equal(rows[0].marketCapUsd, null, 'no SOL price means no market cap, not a wrong one');
});

// ── Merged chart: provider history + live tape (one chart, never either/or) ──
//
// The either/or rule was the "chart doesn't show the full chart" bug: the
// tape replaced a full provider history the moment it held 30 candles, and a
// provider answer threw away the tape's fresher tail. mergeCandles is the
// pure core of the fix; convertSolCandles is the unit guard at the seam;
// candlesSince is the incremental-poll cutoff; staleChartNote is the
// serve-stale-over-blank wording.

const K = (time, price, volume = 1) => ({ time, open: price, high: price, low: price, close: price, volume });

test('merge keeps provider history from before the tape started', () => {
  const provider = [K(100, 1), K(160, 2), K(220, 3)];
  const tapeSide = [K(220, 30), K(280, 40)];
  const out = tape.mergeCandles(provider, tapeSide, 500);
  assert.deepEqual(out.map((c) => c.time), [100, 160, 220, 280], 'history before the tape must survive');
  assert.equal(out[0].close, 1);
  assert.equal(out[1].close, 2);
});

test('merge: the tape wins every bucket both sides hold (overlap and tail)', () => {
  const provider = [K(100, 1), K(160, 2), K(220, 3)];
  const tapeSide = [K(160, 20), K(220, 30), K(280, 40)];
  const out = tape.mergeCandles(provider, tapeSide, 500);
  assert.equal(out.find((c) => c.time === 160).close, 20, 'overlap: tape wins');
  assert.equal(out.find((c) => c.time === 220).close, 30, 'overlap: tape wins');
  assert.equal(out[out.length - 1].close, 40, 'the tail is the tape');
});

test('merge dedupes by bucket time and sorts ascending', () => {
  const provider = [K(220, 3), K(100, 1), K(100, 1.5)]; // GT has emitted repeats
  const tapeSide = [K(160, 20)];
  const out = tape.mergeCandles(provider, tapeSide, 500);
  assert.deepEqual(out.map((c) => c.time), [100, 160, 220]);
  const seen = new Set(out.map((c) => c.time));
  assert.equal(seen.size, out.length, 'no duplicate buckets');
});

test('merge caps at the limit, keeping the MOST RECENT buckets', () => {
  const provider = [K(10, 1), K(20, 2), K(30, 3), K(40, 4)];
  const tapeSide = [K(50, 5)];
  const out = tape.mergeCandles(provider, tapeSide, 3);
  assert.deepEqual(out.map((c) => c.time), [30, 40, 50], 'the cap trims the oldest end');
});

test('merge lets a provider fill a gap inside the tape window', () => {
  // The tape never invents candles for quiet buckets; a provider that
  // actually observed trades there (before we subscribed, another pool) may
  // fill them — that is real data, not a synthetic candle.
  const provider = [K(100, 1), K(160, 2)];
  const tapeSide = [K(40, 9), K(220, 30)]; // taped before and after, gap between
  const out = tape.mergeCandles(provider, tapeSide, 500);
  assert.deepEqual(out.map((c) => c.time), [40, 100, 160, 220]);
});

test('merge drops non-finite bucket times', () => {
  const out = tape.mergeCandles([K(NaN, 1), K(10, 1)], [K(Infinity, 2), K(20, 2)], 500);
  assert.deepEqual(out.map((c) => c.time), [10, 20]);
});

test('unit guard: convertSolCandles is null without a SOL/USD rate — never a mixed-unit chart', () => {
  const sol = [K(10, 0.01, 2)];
  assert.equal(tape.convertSolCandles(sol, null), null);
  assert.equal(tape.convertSolCandles(sol, 0), null);
  assert.equal(tape.convertSolCandles(sol, NaN), null);
});

test('convertSolCandles converts prices AND volume, leaves time alone', () => {
  const sol = [{ time: 10, open: 0.01, high: 0.02, low: 0.005, close: 0.015, volume: 3 }];
  const usd = tape.convertSolCandles(sol, 200);
  assert.equal(usd[0].time, 10);
  assert.equal(usd[0].open, 2);
  assert.equal(usd[0].high, 4);
  assert.equal(usd[0].low, 1);
  assert.equal(usd[0].close, 3);
  assert.equal(usd[0].volume, 600, 'SOL volume becomes USD volume alongside USD prices');
  assert.equal(sol[0].open, 0.01, 'the input is not mutated');
});

test('candlesSince keeps buckets at or after the cutoff (inclusive)', () => {
  const all = [K(10, 1), K(20, 2), K(30, 3)];
  assert.deepEqual(tape.candlesSince(all, 20).map((c) => c.time), [20, 30], 'the cutoff bucket itself is included');
  assert.deepEqual(tape.candlesSince(all, 31), []);
});

test('candlesSince with no usable cutoff returns everything', () => {
  const all = [K(10, 1), K(20, 2)];
  assert.equal(tape.candlesSince(all, 0).length, 2);
  assert.equal(tape.candlesSince(all, NaN).length, 2);
});

test('staleChartNote states the age and names the rate limit when parked', () => {
  assert.match(tape.staleChartNote(30_000, true), /rate-limited — showing the last loaded chart \(30s old\)/);
  assert.match(tape.staleChartNote(30_000, false), /showing the last loaded chart \(30s old\)/);
  assert.doesNotMatch(tape.staleChartNote(30_000, false), /rate-limited/, 'no invented rate-limit claim');
  assert.match(tape.staleChartNote(120, true), /\(1s old\)/, 'age never reads as 0s');
});

console.log(`market: ${passed} tests passed`);

// ── Image protocol: the SSRF boundary ─────────────────────────────────
//
// krypt-img:// is the one place a creator-controlled string becomes a fetch
// target, which is exactly the shape of the bug the metadata fetcher shipped
// (product swarm 2026-08-16 §8.3). These pin the refusals.

const img = await import('./.imageurl.mjs');

test('decodeTarget accepts a well-formed https target', () => {
  const url = 'https://ipfs.io/ipfs/QmSomething';
  const b64 = Buffer.from(url, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(img.decodeTarget(`krypt-img://i/${b64}`), url);
});

test('decodeTarget refuses non-https schemes', () => {
  for (const bad of ['http://evil.test/x', 'file:///C:/Windows/win.ini', 'data:text/html,<script>']) {
    const b64 = Buffer.from(bad, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(img.decodeTarget(`krypt-img://i/${b64}`), null, bad);
  }
});

test('decodeTarget refuses junk instead of throwing', () => {
  assert.equal(img.decodeTarget('krypt-img://i/'), null);
  assert.equal(img.decodeTarget('krypt-img://i/!!!not-base64!!!'), null);
  assert.equal(img.decodeTarget('not a url at all'), null);
});

test('private and loopback addresses are refused', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3',        // loopback
    '0.0.0.0',                       // this-host
    '10.0.0.5', '10.255.255.255',    // RFC1918
    '172.16.0.1', '172.31.255.254',  // RFC1918
    '192.168.1.1',                   // RFC1918
    '169.254.169.254',               // cloud metadata — the classic target
    '100.64.0.1',                    // CGNAT
    '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1',              // IPv4-mapped loopback
  ];
  for (const a of blocked) assert.equal(img.isPrivateAddress(a), true, `${a} should be refused`);
});

test('SVG and non-image content types are refused', () => {
  for (const bad of ['image/svg+xml', 'image/svg+xml; charset=utf-8', 'text/html', 'application/json', null, '']) {
    assert.equal(img.isRenderableImageType(bad), false, String(bad));
  }
  for (const good of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG; charset=binary']) {
    assert.equal(img.isRenderableImageType(good), true, good);
  }
});

test('genuinely public addresses are allowed', () => {
  const allowed = ['1.1.1.1', '8.8.8.8', '104.18.32.7', '172.15.0.1', '172.32.0.1', '192.167.1.1', '2606:4700::1111'];
  for (const a of allowed) assert.equal(img.isPrivateAddress(a), false, `${a} should be allowed`);
});


// ── Candle normalisation ──────────────────────────────────────────────
//
// Providers really do emit duplicate buckets — GeckoTerminal was seen
// repeating an hourly candle inside one response, which made the series
// non-strictly-ascending and would throw inside lightweight-charts.

const { normaliseCandles } = await import('./.marketshared.mjs');

test('normaliseCandles sorts ascending', () => {
  const out = normaliseCandles([
    { time: 30, open: 3, high: 3, low: 3, close: 3, volume: 1 },
    { time: 10, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: 20, open: 2, high: 2, low: 2, close: 2, volume: 1 },
  ]);
  assert.deepEqual(out.map((c) => c.time), [10, 20, 30]);
});

test('normaliseCandles collapses duplicate timestamps, keeping the last', () => {
  const out = normaliseCandles([
    { time: 10, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: 10, open: 9, high: 9, low: 9, close: 9, volume: 2 },
    { time: 20, open: 2, high: 2, low: 2, close: 2, volume: 1 },
  ]);
  assert.equal(out.length, 2, 'a repeated bucket must not appear twice');
  assert.equal(out[0].close, 9, 'the later value for a bucket wins');
});

test('normaliseCandles output is STRICTLY ascending', () => {
  const messy = [40, 10, 10, 30, 20, 30, 10].map((t) => ({
    time: t, open: 1, high: 1, low: 1, close: 1, volume: 0,
  }));
  const out = normaliseCandles(messy);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].time > out[i - 1].time, 'lightweight-charts throws on a tie');
  }
});

test('normaliseCandles drops non-finite timestamps', () => {
  const out = normaliseCandles([
    { time: NaN, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    { time: 10, open: 1, high: 1, low: 1, close: 1, volume: 0 },
  ]);
  assert.equal(out.length, 1);
});

test('normaliseCandles passes short inputs through untouched', () => {
  assert.equal(normaliseCandles([]).length, 0);
  const one = [{ time: 5, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
  assert.equal(normaliseCandles(one), one);
});

// ── Render churn ──────────────────────────────────────────────────────
//
// Discover refetches every few seconds and gets back BRAND-NEW objects even
// when nothing moved. Handed straight to React that defeats memoisation by
// reference and reconciles every card — measured at 63 DOM elements each,
// about 10,000 across four columns. These two functions are what turn the
// common case back into a pointer comparison, so their job is to be RIGHT
// about "nothing changed": a false positive silently freezes the UI.

const row = (over = {}) => {
  const s = emptySummary('Mint111');
  s.symbol = 'AAA';
  s.priceUsd = 1;
  s.marketCapUsd = 1000;
  s.stats = { '5m': { volumeUsd: 10, buys: 2, sells: 1, priceChangePct: 5 } };
  return { ...s, ...over };
};

test('an identical refresh compares equal', () => {
  assert.equal(sameRow(row(), row()), true);
});

test('fetchedAt alone does NOT count as a change', () => {
  // It changes on every poll by definition and nothing renders it. Counting
  // it would make the comparison useless.
  assert.equal(sameRow(row({ fetchedAt: 1 }), row({ fetchedAt: 999_999 })), true);
});

test('every DISPLAYED field being different is detected', () => {
  // A missed field here means a stale number frozen on screen.
  const checks = [
    ['symbol', 'ZZZ'],
    ['name', 'other'],
    ['imageUrl', 'http://x/y.png'],
    ['priceUsd', 2],
    ['marketCapUsd', 2000],
    ['liquidityUsd', 5],
    ['holders', 7],
    ['kryptScore', 55],
    ['bondingCurvePct', 12],
    ['top10Pct', 9],
    ['devHoldingPct', 4],
    ['createdAt', 12345],
    ['launchpad', 'bonk'],
  ];
  for (const [field, value] of checks) {
    assert.equal(sameRow(row(), row({ [field]: value })), false, `${field} must be detected`);
  }
});

test('a change inside the stats block is detected', () => {
  const a = row();
  const b = row({ stats: { '5m': { volumeUsd: 11, buys: 2, sells: 1, priceChangePct: 5 } } });
  assert.equal(sameRow(a, b), false);
});

test('an unchanged page returns the PREVIOUS array, so React skips it', () => {
  const prev = [row(), row({ mint: 'Mint222' })];
  const next = [row(), row({ mint: 'Mint222' })];
  assert.equal(reuseRows(prev, next), prev, 'identical pages must not produce a new array');
});

test('a changed page reuses the rows that did not move', () => {
  const prev = [row(), row({ mint: 'Mint222' })];
  const next = [row({ priceUsd: 99 }), row({ mint: 'Mint222' })];
  const merged = reuseRows(prev, next);
  assert.notEqual(merged, prev, 'something changed, so the array must be new');
  assert.notEqual(merged[0], prev[0], 'the moved row is the fresh object');
  assert.equal(merged[1], prev[1], 'the unchanged row keeps its identity');
});

test('a row that disappears does not resurrect', () => {
  const prev = [row(), row({ mint: 'Gone111' })];
  const next = [row()];
  const merged = reuseRows(prev, next);
  assert.equal(merged.length, 1);
  assert.equal(merged[0], prev[0]);
});

test('the first load passes through untouched', () => {
  const next = [row()];
  assert.equal(reuseRows([], next), next);
});

console.log(`market+images: ${passed} tests passed`);

// ── Security checks: gates vs facts (docs/rug-filter-2026-08-30.md) ───
//
// Measured on the held-out day 2026-07-27: every supply-share threshold —
// dev %, top-10, top-20, bundled %, sniper % — has lift < 1 for "dead or
// dumped", and used together as a hide they conceal 57 % of graduations
// (§4). So those rows are FACTS: weight 0, never red. The gates are the
// things that stop a sale or name a repeat offender, and each one has a
// null path with an honest reason when its source was silent.

const sec = await import('./.marketshared.mjs');
const { securityChecks, scoreChecks, quickScore, describeSocials, holderPct } = sec;

const silentFacts = (over = {}) => ({
  launchpad: 'unknown',
  bondingCurvePct: null,
  mint: { checked: false, message: 'mint not read (timeout)', mintAuthority: null, freezeAuthority: null, isToken2022: null },
  liquidityUsd: null,
  liquiditySource: 'none',
  shares: {
    devPct: null, top10Pct: null, top20Pct: null,
    bundledPct: null, bundledHeldPct: null, bundleWallets: null, bundleStillHolding: null,
    sniperPct: null, sniperHeldPct: null, sniperWindowSlots: null,
    launchNote: null, concSource: 'none', launchSource: 'none',
  },
  rugcheck: { answered: false, creatorRugs: null, riskCount: 0 },
  insiders: { answered: false, networks: 0, largestSharePct: null },
  shield: { answered: false, notSellable: false, warnings: [] },
  creatorRecord: { launches: null, graduated: null, devMints: null, devMigrations: null, rugcheckCreatorRugs: null, source: 'none' },
  banned: null,
  localCreator: null,
  history: null,
  ...over,
});

const byId = (checks, id) => {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} missing`);
  return c;
};

test('supply-share rows are facts: weight 0, never fail, even at extreme shares', () => {
  // These shares would all have been red under the pre-2026-08-30 thresholds.
  const f = silentFacts({
    shares: {
      devPct: 45, top10Pct: 92, top20Pct: 97,
      bundledPct: 80, bundledHeldPct: 70, bundleWallets: 12, bundleStillHolding: 9,
      sniperPct: 60, sniperHeldPct: 55, sniperWindowSlots: 20,
      launchNote: null, concSource: 'onchain', launchSource: 'pumpswap',
    },
  });
  const { checks } = scoreChecks(securityChecks(f));
  for (const id of ['dev-holding', 'top10', 'top20', 'bundled', 'sniper']) {
    const c = byId(checks, id);
    assert.equal(c.kind, 'fact', `${id} is a fact`);
    assert.equal(c.weight, 0, `${id} carries no weight`);
    assert.equal(c.verdict, 'pass', `${id} is never red`);
  }
  assert.match(byId(checks, 'dev-holding').detail, /45\.00%/);
  assert.match(byId(checks, 'bundled').detail, /80\.0%.*12 wallets.*70\.0%.*9 of them/);
});

test('an unmeasured supply share is unknown, not 0 and not pass', () => {
  const { checks } = scoreChecks(securityChecks(silentFacts()));
  for (const id of ['dev-holding', 'top10', 'top20', 'bundled', 'sniper']) {
    const c = byId(checks, id);
    assert.equal(c.verdict, 'unknown', id);
    assert.doesNotMatch(c.detail, /\b0(\.0+)?%/, `${id} must not print a zero share`);
  }
});

test('facts count toward neither checksResolved nor checksTotal', () => {
  const f = silentFacts({ shares: { ...silentFacts().shares, devPct: 1, top10Pct: 10, top20Pct: 12 } });
  const { resolved, total, score } = scoreChecks(securityChecks(f));
  assert.equal(resolved, 0, 'three resolved facts are still zero resolved gates');
  assert.equal(score, null);
  assert.equal(total, securityChecks(f).filter((c) => (c.kind ?? 'gate') === 'gate').length);
});

test('socials are no longer a check', () => {
  const ids = securityChecks(silentFacts()).map((c) => c.id);
  assert.ok(!ids.includes('socials'), 'socials must not be scored (no measured edge)');
});

test('socials: hasAny is null when NO provider answered, false when one did and found none', () => {
  const t = emptySummary('m');
  assert.deepEqual(describeSocials(t), { hasAny: null, twitter: null, telegram: null, website: null });
  t.sources.socials = 'jupiter';
  assert.deepEqual(describeSocials(t), { hasAny: false, twitter: false, telegram: false, website: false });
  t.socials.twitter = 'https://x.com/a';
  assert.equal(describeSocials(t).hasAny, true);
  assert.equal(describeSocials(t).twitter, true);
});

test('every new gate has a null path with an honest reason when its source is silent', () => {
  const { checks } = scoreChecks(securityChecks(silentFacts({ launchpad: 'pumpfun' })));
  const expect = {
    'creator-rugs': /RugCheck did not answer/,
    'insider-network': /RugCheck did not answer/,
    sellable: /Jupiter Shield did not answer/,
    'factory-creator': /no creator record/,
    'is-banned': /pump\.fun did not answer/,
    liquidity: /no provider priced/,
  };
  for (const [id, re] of Object.entries(expect)) {
    const c = byId(checks, id);
    assert.equal(c.verdict, 'unknown', `${id} silent ⇒ unknown`);
    assert.match(c.detail, re, `${id} says why`);
    assert.ok(c.weight > 0, `${id} is a weighted gate`);
  }
});

test('creator-rugs: RugCheck risk named "creator history of rugged" fails; risks without it pass', () => {
  let c = byId(securityChecks(silentFacts({ rugcheck: { answered: true, creatorRugs: true, riskCount: 3 } })), 'creator-rugs');
  assert.equal(c.verdict, 'fail');
  c = byId(securityChecks(silentFacts({ rugcheck: { answered: true, creatorRugs: false, riskCount: 2 } })), 'creator-rugs');
  assert.equal(c.verdict, 'pass');
  assert.equal(c.source, 'rugcheck');
});

test('insider-network: empty on 200 passes, ≥ 10 % warns, ≥ 25 % fails, no share is unknown', () => {
  const at = (insiders) => byId(securityChecks(silentFacts({ insiders })), 'insider-network');
  const none = at({ answered: true, networks: 0, largestSharePct: null });
  assert.equal(none.verdict, 'pass');
  assert.match(none.detail, /no transfer clusters detected/i);
  assert.equal(at({ answered: true, networks: 2, largestSharePct: 9.9 }).verdict, 'pass');
  assert.equal(at({ answered: true, networks: 2, largestSharePct: 10 }).verdict, 'warn');
  assert.equal(at({ answered: true, networks: 2, largestSharePct: 25 }).verdict, 'fail');
  assert.equal(at({ answered: true, networks: 3, largestSharePct: null }).verdict, null, 'no share ⇒ unknown');
});

test('sellable: NOT_SELLABLE fails, a 200 without it passes', () => {
  const at = (shield) => byId(securityChecks(silentFacts({ shield })), 'sellable');
  assert.equal(at({ answered: true, notSellable: true, warnings: ['NOT_SELLABLE'] }).verdict, 'fail');
  const ok = at({ answered: true, notSellable: false, warnings: ['NEW_LISTING'] });
  assert.equal(ok.verdict, 'pass');
  assert.match(ok.detail, /NEW_LISTING/);
});

test('factory-creator: ≥ 30 prior & 0 graduated fails, ≥ 10 warns, Jupiter devMints is a fallback record', () => {
  const rec = (over) => ({ launches: null, graduated: null, devMints: null, devMigrations: null, rugcheckCreatorRugs: null, source: 'none', ...over });
  const at = (creatorRecord) => byId(securityChecks(silentFacts({ creatorRecord })), 'factory-creator');
  // pump.fun count includes the launch under review, so 31 launches = 30 prior.
  assert.equal(at(rec({ launches: 31, graduated: 0 })).verdict, 'fail');
  assert.equal(at(rec({ launches: 11, graduated: 0 })).verdict, 'warn');
  assert.equal(at(rec({ launches: 31, graduated: 1 })).verdict, 'pass');
  const j = at(rec({ devMints: 40, devMigrations: 0 }));
  assert.equal(j.verdict, 'fail');
  assert.equal(j.source, 'jupiter');
  assert.match(j.detail, /93 %/, 'carries the measured rate');
});

test('is_banned fails; the gate exists only on the pump rail', () => {
  const banned = byId(securityChecks(silentFacts({ launchpad: 'pumpfun', banned: true })), 'is-banned');
  assert.equal(banned.verdict, 'fail');
  assert.equal(byId(securityChecks(silentFacts({ launchpad: 'pumpfun', banned: false })), 'is-banned').verdict, 'pass');
  assert.ok(!securityChecks(silentFacts({ launchpad: 'bonk', banned: null })).some((c) => c.id === 'is-banned'));
});

test('pump rail: mint/freeze are facts guaranteed by the program, unless the chain disagrees', () => {
  const guaranteed = securityChecks(silentFacts({
    launchpad: 'pumpfun',
    mint: { checked: true, message: 'ok', mintAuthority: false, freezeAuthority: false, isToken2022: true },
  }));
  for (const id of ['mint-authority', 'freeze-authority']) {
    const c = byId(guaranteed, id);
    assert.equal(c.kind, 'fact');
    assert.match(c.detail, /guaranteed by the pump\.fun program/);
  }
  const spoofed = securityChecks(silentFacts({
    launchpad: 'pumpfun',
    mint: { checked: true, message: 'ok', mintAuthority: true, freezeAuthority: true, isToken2022: true },
  }));
  assert.equal(byId(spoofed, 'mint-authority').verdict, 'fail', 'an authority on a "pump" mint is a gate failure');
  assert.equal(byId(spoofed, 'freeze-authority').verdict, 'fail');
  assert.notEqual(byId(spoofed, 'mint-authority').kind, 'fact');
});

test('a first launch is "no record", not a pass', () => {
  const c = byId(
    securityChecks(silentFacts({ history: { launches: 1, verdict: 'pass', detail: 'First launch from this wallet on pump.fun.' } })),
    'creator-history',
  );
  assert.equal(c.verdict, null);
  assert.match(c.detail, /First launch — no record/);
});

test('score needs four resolved gates; unknown gates never count', () => {
  const f = silentFacts({
    liquidityUsd: 30_000, liquiditySource: 'jupiter',
    shield: { answered: true, notSellable: false, warnings: [] },
    rugcheck: { answered: true, creatorRugs: false, riskCount: 1 },
  });
  assert.equal(scoreChecks(securityChecks(f)).score, null, 'three gates is not enough');
  f.insiders = { answered: true, networks: 0, largestSharePct: null };
  const r = scoreChecks(securityChecks(f));
  assert.equal(r.resolved, 4);
  assert.equal(r.score, 100);
});

// ── quickScore ────────────────────────────────────────────────────────

test('quickScore is null under three resolved gates and ignores holders and socials', () => {
  const s = emptySummary('m');
  s.holders = 5_000;
  s.socials = { twitter: 'https://x.com/a', telegram: 'https://t.me/a', website: 'https://a.io', dexPaid: true };
  assert.equal(quickScore(s), null, 'holders + socials alone score nothing');
  s.liquidityUsd = 30_000;
  s.sources.liquidity = 'jupiter';
  s.audit.notSellable = false;
  assert.equal(quickScore(s), null, 'two gates');
  s.audit.devMints = 3;
  s.audit.devMigrations = 1;
  assert.equal(quickScore(s), 100, 'three gates resolve');
});

test('quickScore: NOT_SELLABLE and a pump ban pull the row down', () => {
  const s = emptySummary('m');
  s.launchpad = 'pumpfun';
  s.liquidityUsd = 30_000;
  s.sources.liquidity = 'pumpfun';
  s.audit.notSellable = true;
  s.audit.devMints = 2;
  s.audit.devMigrations = 0;
  s.audit.isBanned = true;
  const v = quickScore(s);
  assert.ok(v !== null && v < 50, `expected a low score, got ${v}`);
});

// ── Honest null: holder share ─────────────────────────────────────────

test('holder pct is null without a supply, never 0', () => {
  assert.equal(holderPct(1_000, null), null);
  assert.equal(holderPct(1_000, 0), null);
  assert.equal(holderPct(NaN, 1_000), null);
  assert.equal(holderPct(250, 1_000), 25);
});

test('new row fields default honest: rug null, no volatility, audit all null', () => {
  const s = emptySummary('m');
  assert.equal(s.rug, null);
  assert.deepEqual(s.volatility, []);
  for (const [k, v] of Object.entries(s.audit)) {
    if (k === 'shieldWarnings') assert.deepEqual(v, []);
    else assert.equal(v, null, `audit.${k}`);
  }
});

test('a rug flag arriving on a row counts as a display change', () => {
  const a = row();
  const b = row({ rug: { windowS: 60, measuredOn: 'x', population: 'p', flags: [{ id: 'sells_over_buys' }], states: {}, hide: true, tradesSeen: 4 } });
  assert.equal(sameRow(a, b), false);
});

test('odds defaults to null on a fresh row (never a base rate)', () => {
  assert.equal(emptySummary('m').odds, null);
  assert.equal(row().odds, null);
});

test('an odds bucket change counts as a display change; the same bucket does not', () => {
  const odds = (bucket, windowS = 60) => ({
    model: 'runner-odds-2026-08-30',
    windowS,
    regime: 'classic',
    graduate: { bucket, observedPct: 17, n: 1117, basePct: 2, line: 'x' },
    mult3: null,
    mult5: null,
    footer: 'f',
    tradesSeen: 12,
  });
  assert.equal(sameRow(row(), row({ odds: odds('top1_5') })), false, 'null -> bucket');
  assert.equal(sameRow(row({ odds: odds('top1_5') }), row({ odds: odds('top5_10') })), false, 'bucket change');
  assert.equal(sameRow(row({ odds: odds('top1_5') }), row({ odds: odds('top1_5') })), true, 'same bucket');
  assert.equal(sameRow(row({ odds: odds('top1_5', 60) }), row({ odds: odds('top1_5', 120) })), false, 'window change');
});

console.log(`market+security: ${passed} tests passed`);
