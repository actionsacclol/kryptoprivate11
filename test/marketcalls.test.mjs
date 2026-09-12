// Call-COUNT regressions for the market orchestrator and its providers.
//
// These are not "does it work" tests. Every assertion here is a number of
// HTTP requests, because the failures they guard against are invisible in
// the UI: the app keeps showing correct rows while quietly spending three
// times its published budget, and the only symptom is a 429 storm later.
// The numbers come from the API/rate-limit swarm of 2026-09-09 §4, which
// measured 230 calls a minute on an idle Discover — 89 of them to pump.fun
// against a documented 60 per 60 s.
//
// The real modules run against a stubbed `fetch`; the queues, the gaps, the
// windows and the memos are all the shipping ones.
//
// Four things are pinned:
//
//   1. A `/coins?` list read carries complete records, so nothing may buy
//      those rows back one at a time (`/coins/{mint}` — 45/min measured).
//   2. A LIST row's creator record is Jupiter's, already on the row, so no
//      per-row `/coins?creator=` may be bought (38/min measured, and it
//      starved the New column it shared a window with).
//   3. DexScreener's 30-mint batch replaces the per-mint route on the
//      portfolio path, and the chunking is enforced CLIENT-side because the
//      route silently drops everything past the thirtieth address.
//   4. A batch is warmed close enough to the assembly that consumes it that
//      nothing re-fetches a row the same function just batched (26 of 60
//      measured).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { market, http, ds, gt } from './.marketmod.mjs';

// ── Counting fetch stub ───────────────────────────────────────────────

const counts = new Map();
const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
const n = (k) => counts.get(k) ?? 0;
const resetCounts = () => counts.clear();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mintIndex = new Map();
/** A REAL base58 mint of real length: jupiter.ts only consults its per-mint
 *  cache for queries matching /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, so a short
 *  fake mint would silently disable the cache under measurement. */
function mintFor(i) {
  let v = i + 1;
  let s = '';
  while (v > 0) {
    s = B58[v % 58] + s;
    v = Math.floor(v / 58);
  }
  const mint = `Mnt${s.padStart(37, '1')}pump`;
  mintIndex.set(mint, i);
  return mint;
}

const AGE_MS = 90_000; // old enough for the rug window AND the odds window

function pumpCoin(i, extra = {}) {
  return {
    mint: mintFor(i),
    name: `Token ${i}`,
    symbol: `TK${i}`,
    creator: `Creator${i}`,
    created_timestamp: Date.now() - AGE_MS,
    complete: false,
    virtual_sol_reserves: 40e9,
    virtual_token_reserves: 9.0e14,
    real_sol_reserves: 10e9,
    total_supply: 1e15,
    last_trade_timestamp: Date.now(),
    usd_market_cap: 40_000 + i,
    base_decimals: 6,
    program: 'pump',
    twitter: 'https://x.com/x',
    is_banned: false,
    ...extra,
  };
}

function jupToken(mint, i) {
  return {
    id: mint,
    name: `Token ${i}`,
    symbol: `TK${i}`,
    decimals: 6,
    dev: `Creator${i}`,
    circSupply: 1e9,
    totalSupply: 1e9,
    holderCount: 120,
    mcap: 44_000,
    usdPrice: 0.000044,
    liquidity: 9_000,
    firstPool: { id: `Pool${i}`, createdAt: new Date(Date.now() - AGE_MS).toISOString() },
    // The creator record every row carries for free — the whole point of
    // finding #2 above: this is already paid for.
    audit: { topHoldersPercentage: 22, devBalancePercentage: 1.5, devMints: 7, devMigrations: 1 },
    launchpad: 'pump.fun',
  };
}

function dsPair(mint, i) {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: `DsPair${i}`,
    baseToken: { address: mint, symbol: `TK${i}`, name: `Token ${i}` },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceNative: '0.00000022',
    priceUsd: '0.000044',
    txns: { h24: { buys: 30, sells: 20 } },
    volume: { h1: 500 },
    liquidity: { usd: 9000 },
    pairCreatedAt: Date.now() - AGE_MS,
    info: { imageUrl: 'https://img.example/y.png', socials: [], websites: [] },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Newest-first list window. pump.fun launches dozens a minute, so a static
 *  list would make every memo hit and hide the per-row work entirely. */
let churnBase = 0;
/** The biggest chunk any request was asked for — the silent-truncation guard. */
let widestBatch = 0;

function install() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const host = url.host;
    const p = url.pathname;

    if (host === 'rpc.harness.test') {
      const body = JSON.parse(init.body ?? '{}');
      const calls = Array.isArray(body) ? body : [body];
      bump(`rpc:${calls[0]?.method ?? 'batch'}`);
      const answer = (m, params) => {
        if (m === 'getAccountInfo') {
          const buf = Buffer.alloc(82);
          buf.writeUInt32LE(0, 0);
          buf.writeUInt8(6, 44);
          buf.writeBigUInt64LE(1_000_000_000_000_000n, 36);
          buf.writeUInt32LE(0, 46);
          return {
            context: { slot: 1 },
            value: {
              owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              data: [buf.toString('base64'), 'base64'],
              lamports: 1,
              executable: false,
            },
          };
        }
        if (m === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params?.[0] ?? []).map(() => null) };
        if (m === 'getTokenSupply') {
          return { context: { slot: 1 }, value: { amount: '1000000000000000', decimals: 6, uiAmount: 1e9 } };
        }
        if (m === 'getTokenLargestAccounts') return { context: { slot: 1 }, value: [] };
        return null;
      };
      const replies = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: answer(c.method, c.params) }));
      return json(Array.isArray(body) ? replies : replies[0]);
    }

    if (host === 'frontend-api-v3.pump.fun') {
      if (p === '/coins') {
        const creator = url.searchParams.get('creator');
        if (creator) {
          bump('pump:creator');
          return json([pumpCoin(9000, { creator })]);
        }
        bump('pump:list');
        return json(Array.from({ length: 40 }, (_, i) => pumpCoin(churnBase + i)));
      }
      if (p.startsWith('/coins/')) {
        bump('pump:coin');
        const mint = decodeURIComponent(p.slice('/coins/'.length));
        return json({ ...pumpCoin(mintIndex.get(mint) ?? 0), mint });
      }
      bump('pump:other');
      return json({});
    }

    if (host === 'swap-api.pump.fun') {
      bump('pumpswap:trades');
      return json({
        trades: Array.from({ length: 8 }, (_, i) => ({
          slotIndexId: String(310_000_000_000 + i * 10).padStart(22, '0'),
          tx: `tx${i}`,
          timestamp: new Date(Date.now() - AGE_MS + i * 400).toISOString(),
          userAddress: i === 0 ? 'Creator0' : `Buyer${i}`,
          type: 'buy',
          program: 'pump',
          amountSol: '0.5',
          baseAmount: String(1e12),
        })),
        pagination: { hasMore: false, nextCursor: null },
      });
    }

    if (host === 'lite-api.jup.ag' || host === 'api.jup.ag') {
      if (p.startsWith('/tokens/v2/search')) {
        const q = url.searchParams.get('query') ?? '';
        const ids = q.split(',').filter(Boolean);
        bump(ids.length > 1 ? 'jup:batch' : 'jup:single');
        return json(ids.map((m, i) => jupToken(m, mintIndex.get(m) ?? i)));
      }
      if (p.startsWith('/tokens/v2/recent')) {
        bump('jup:recent');
        return json(Array.from({ length: 10 }, (_, i) => jupToken(mintFor(500_000 + i), i)));
      }
      if (p.startsWith('/tokens/v2/toptraded') || p.startsWith('/tokens/v2/toporganicscore')) {
        bump('jup:top');
        return json(Array.from({ length: 10 }, (_, i) => jupToken(mintFor(600_000 + i), i)));
      }
      if (p.startsWith('/ultra/v1/shield')) {
        bump('jup:shield');
        return json({ warnings: {} });
      }
      if (p.startsWith('/price/v3')) {
        bump('jup:price');
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        return json(Object.fromEntries(ids.map((m) => [m, { usdPrice: 205 }])));
      }
      bump('jup:other');
      return json([]);
    }

    if (host === 'api.dexscreener.com') {
      if (p.startsWith('/latest/dex/tokens/')) {
        bump('ds:single');
        const mint = decodeURIComponent(p.split('/').pop());
        return json({ pairs: [dsPair(mint, mintIndex.get(mint) ?? 0)] });
      }
      if (p.startsWith('/tokens/v1/solana/')) {
        const mints = decodeURIComponent(p.slice('/tokens/v1/solana/'.length)).split(',').filter(Boolean);
        bump('ds:batch');
        widestBatch = Math.max(widestBatch, mints.length);
        // The real route SILENTLY DROPS everything past 30 rather than
        // erroring. Reproduced exactly, so a client-side cap that regresses
        // shows up as missing pools rather than as a failed request.
        return json(mints.slice(0, 30).map((m, i) => dsPair(m, mintIndex.get(m) ?? i)));
      }
      if (p.startsWith('/orders/v1/solana/')) {
        bump('ds:orders');
        return json([]);
      }
      bump('ds:other');
      return json([]);
    }

    if (host === 'api.geckoterminal.com') {
      if (p.includes('/dexes/')) {
        bump('gt:dexpools');
        return json({ data: [] });
      }
      if (p.endsWith('/new_pools')) {
        bump('gt:newpools');
        return json({ data: [] });
      }
      if (p.includes('/token_price/')) {
        bump('gt:tokenprice');
        const mints = decodeURIComponent(p.split('/token_price/')[1]).split(',').filter(Boolean);
        widestBatch = Math.max(widestBatch, mints.length);
        return json({ data: { attributes: { token_prices: Object.fromEntries(mints.map((m) => [m, '0.5'])) } } });
      }
      if (p.endsWith('/info')) {
        bump('gt:info');
        return json({
          data: { attributes: { holders: { count: 412, distribution_percentage: { top_10: '23.4' } } } },
        });
      }
      bump('gt:other');
      return json({ data: [] });
    }

    bump(`other:${host}`);
    return json({});
  };
}

install();

market.attach({
  httpUrl: () => 'https://rpc.harness.test',
  data: () => ({
    networkDataEnabled: true,
    providers: {
      jupiter: true,
      dexscreener: true,
      pumpfun: true,
      geckoterminal: true,
      pumpswap: true,
      birdeye: false,
      helius: false,
      rugcheck: false,
    },
    birdeyeApiKey: '',
    jupiterApiKey: '',
    discoverLimit: 40,
    discoverRefreshSec: 8,
  }),
  heliusKey: () => '',
  creatorIntel: () => null,
  walletLabel: () => null,
  isLiveTracked: () => false,
  registerPool: () => {},
  watchPumpMint: () => {},
  unwatchPumpMint: () => {},
  watchDbcPool: () => {},
  unwatchDbcPool: () => {},
  watchLaunchLabPool: () => {},
  unwatchLaunchLabPool: () => {},
  watchBoop: () => {},
  unwatchBoop: () => {},
});

// ── Runner ────────────────────────────────────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ── 1 + 2: the Discover row path buys nothing back ────────────────────

test('a Discover pass never re-buys a pump.fun row the list already returned', async () => {
  http.clearCache();
  resetCounts();
  // Three passes with the list window MOVING, so every pass brings genuinely
  // new mints — a static list would hide the per-row work behind the memos.
  for (let pass = 0; pass < 3; pass++) {
    churnBase = pass * 20;
    await market.discover('new', 40, '5m');
  }
  assert.equal(
    n('pump:coin'),
    0,
    `every /coins/{mint} follows a list read that contained the row — got ${n('pump:coin')}`,
  );
  assert.ok(n('pump:list') >= 3, `the list route itself is still read (got ${n('pump:list')})`);
});

test('a Discover pass never buys a per-row creator history', async () => {
  http.clearCache();
  resetCounts();
  for (let pass = 0; pass < 3; pass++) {
    churnBase = 1_000 + pass * 20;
    await market.discover('new', 40, '5m');
  }
  assert.equal(
    n('pump:creator'),
    0,
    `the row already carries Jupiter's devMints/devMigrations — got ${n('pump:creator')} /coins?creator=`,
  );
});

test('the pump.fun list lane is no longer starved by per-row lookups', async () => {
  // The starvation is the point of #2: `/coins?creator=` shared the 55/min
  // list window with the New column's own feed, so the column ran at roughly
  // half its configured cadence. With the per-row reads gone, four back-to-
  // back passes each reach the list.
  http.clearCache();
  resetCounts();
  for (let pass = 0; pass < 4; pass++) {
    churnBase = 2_000 + pass * 20;
    await market.discover('new', 40, '5m');
  }
  assert.equal(n('pump:list'), 4, `one list read per pass, got ${n('pump:list')}`);
  assert.equal(n('pump:coin') + n('pump:creator'), 0, 'and nothing per row');
});

// ── 3 + 4: the portfolio path ─────────────────────────────────────────

const PORTFOLIO = 45;

test('a 45-mint build batches DexScreener and never asks per mint', async () => {
  http.clearCache();
  resetCounts();
  widestBatch = 0;
  const mints = Array.from({ length: PORTFOLIO }, (_, i) => mintFor(10_000 + i));
  const out = await market.summaryMany(mints, 4, { skipUnpriceable: true });
  assert.equal(out.size, PORTFOLIO, 'every mint still resolved');
  assert.equal(n('ds:single'), 0, `no per-mint DexScreener calls, got ${n('ds:single')}`);
  assert.ok(n('ds:batch') > 0 && n('ds:batch') <= 3, `batched instead, got ${n('ds:batch')} requests`);
  assert.ok(widestBatch <= 30, `no request may exceed the route's 30 cap — asked for ${widestBatch}`);
});

test('nothing re-fetches a Jupiter row the same build just batched', async () => {
  // Measured before the fix: 26 of 60 mints re-fetched, because the batch's
  // 8 s per-mint TTL is shorter than the ~16 s assembly it warms.
  http.clearCache();
  resetCounts();
  const mints = Array.from({ length: PORTFOLIO }, (_, i) => mintFor(20_000 + i));
  await market.summaryMany(mints, 4, { skipUnpriceable: true });
  assert.equal(n('jup:single'), 0, `every row came from a batch — got ${n('jup:single')} single-mint searches`);
  assert.ok(n('jup:batch') <= 3, `and the batches are chunked, not one per mint — got ${n('jup:batch')}`);
});

// ── The 30-cap, directly ──────────────────────────────────────────────

test('chunkMints never emits a chunk over the route cap', () => {
  assert.equal(ds.BATCH_MAX, 30);
  const mints = Array.from({ length: 61 }, (_, i) => mintFor(30_000 + i));
  const chunks = ds.chunkMints(mints);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 30, `chunk of ${c.length}`);
  assert.equal(chunks.flat().length, 61, 'and nothing is dropped');
  // A caller asking for a bigger chunk is clamped, not obeyed: obeying it
  // would produce one request whose tail is silently missing.
  for (const c of ds.chunkMints(mints, 60)) assert.ok(c.length <= 30, 'an over-cap size is clamped');
});

test('tokenInfoMany warms the very cache tokenInfo reads', async () => {
  http.clearCache();
  resetCounts();
  const mints = Array.from({ length: 5 }, (_, i) => mintFor(40_000 + i));
  const many = await ds.tokenInfoMany(mints);
  assert.equal(many.size, 5);
  assert.equal(n('ds:batch'), 1);
  for (const m of mints) assert.ok(await ds.tokenInfo(m), 'still answers per mint');
  assert.equal(n('ds:single'), 0, 'from the warmed cache, with no extra request');
});

// ── Negative caching (rate-limit swarm A5, DexScreener half) ──────────

test('a mint DexScreener indexes no pair for is remembered as such', async () => {
  http.clearCache();
  resetCounts();
  const bare = mintFor(50_000);
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.host === 'api.dexscreener.com' && url.pathname.startsWith('/latest/dex/tokens/')) {
      bump('ds:single');
      return json({ pairs: [] });
    }
    return prev(input, init);
  };
  try {
    assert.equal(await ds.tokenInfo(bare), null);
    assert.equal(await ds.tokenInfo(bare), null);
    assert.equal(await ds.tokenInfo(bare), null);
    assert.equal(n('ds:single'), 1, `asked once, remembered — got ${n('ds:single')} calls`);
  } finally {
    globalThis.fetch = prev;
  }
});

// ── P3: the doomed holder lookup runs once per page, not three times ──

test('one token page reads getTokenLargestAccounts exactly once', async () => {
  http.clearCache();
  resetCounts();
  const mint = mintFor(60_000);
  await market.tokenDetail(mint);
  await market.holders(mint, 50);
  assert.equal(
    n('rpc:getTokenLargestAccounts'),
    1,
    `the public RPC's budget for this method is 0 — got ${n('rpc:getTokenLargestAccounts')} calls`,
  );
});

// ── Task 5 + the honest-null rule on the new GeckoTerminal paths ──────

test('simpleTokenPrices caps at 30 and never invents a zero', async () => {
  http.clearCache();
  resetCounts();
  widestBatch = 0;
  const mints = Array.from({ length: 45 }, (_, i) => mintFor(70_000 + i));
  const prices = await gt.simpleTokenPrices(mints);
  assert.equal(gt.PRICE_BATCH_MAX, 30);
  assert.ok(widestBatch <= 30, `asked for ${widestBatch} in one request`);
  assert.equal(n('gt:tokenprice'), 2, 'two requests for 45 mints');
  const one = prices.get(mints[0]);
  assert.equal(one.priceUsd, 0.5);
  // The stub answers with prices only. Every other field must come back
  // null — an absent market cap is an em dash, never a zero.
  assert.equal(one.marketCapUsd, null);
  assert.equal(one.volume24hUsd, null);
  assert.equal(one.liquidityUsd, null);
});

test('a shape simpleTokenPrices does not recognise yields nothing, not zeros', async () => {
  http.clearCache();
  resetCounts();
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.host === 'api.geckoterminal.com' && url.pathname.includes('/token_price/')) {
      bump('gt:tokenprice');
      return json({ data: { attributes: { unexpected_field: { x: 1 } } } });
    }
    return prev(input, init);
  };
  try {
    const out = await gt.simpleTokenPrices([mintFor(80_000)]);
    assert.equal(out.size, 0, 'an unreadable answer is no answer, not a zero one');
  } finally {
    globalThis.fetch = prev;
  }
});

// ── Task 6: the visibility gate ───────────────────────────────────────
//
// A source-level pin rather than a behavioural one — the poll lives in a
// React effect and this suite has no DOM. It still catches the regression
// that matters: somebody deleting the guard while refactoring the effect.

test('the Discover poll is gated on document visibility', () => {
  const src = readFileSync(new URL('../src/state/TerminalProvider.tsx', import.meta.url), 'utf8');
  const poll = src.slice(src.indexOf('const CADENCE'), src.indexOf('// Provider telemetry refresh'));
  assert.ok(poll.includes('document.hidden'), 'the poll checks document.hidden');
  assert.ok(poll.includes("addEventListener('visibilitychange'"), 'and reloads when the window comes back');
  assert.ok(poll.includes("removeEventListener('visibilitychange'"), 'and removes the listener on teardown');
});

// ── Go ────────────────────────────────────────────────────────────────

let passed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok  ${c.name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${c.name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} market call-count tests passed`);
