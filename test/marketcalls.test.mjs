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
import { createHash } from 'node:crypto';
import { market, http, ds, gt } from './.marketmod.mjs';
import { ataFor, bondingCurveFor, metadataFor, pumpSwapCanonicalPoolFor, TOKEN_PROGRAM, WSOL_MINT } from './.addr2.mjs';

// ── Counting fetch stub ───────────────────────────────────────────────

const counts = new Map();
/** Request timeline (key, ms since the harness started) — for diagnosing
 *  why two asks did or did not merge. */
const stamps = [];
const T0 = Date.now();
const bump = (k) => {
  counts.set(k, (counts.get(k) ?? 0) + 1);
  stamps.push(`${k}@${Date.now() - T0}`);
};
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
/** Accounts the stubbed RPC serves for `getMultipleAccounts` (the chain
 *  reads behind the feed-sourced Discover rows). address → { owner, data }. */
const liveAccounts = new Map();
/** Per-mint overrides for pump.fun's `/coins/{mint}` record (a record
 *  minutes young has no socials yet — the shape a runner flag meets). */
const coinExtra = new Map();
/** cid → the metadata JSON the IPFS gateways serve; unknown cids are 404. */
const ipfsDocs = new Map();
/** pump.fun answering 429 to its list routes — the outage the banner names. */
let pumpDown = false;
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
        if (m === 'getMultipleAccounts') {
          return {
            context: { slot: 1 },
            value: (params?.[0] ?? []).map((a) => {
              const acc = liveAccounts.get(a);
              return acc ? { owner: acc.owner, data: [acc.data.toString('base64'), 'base64'], lamports: 1, executable: false } : null;
            }),
          };
        }
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
        if (pumpDown) {
          bump('pump:list');
          return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } });
        }
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
        return json({ ...pumpCoin(mintIndex.get(mint) ?? 0), mint, ...(coinExtra.get(mint) ?? {}) });
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
      // `/tokens/v1/{chain}/{a,b,c}` — Solana's batch and, since 2026-09-15,
      // every other chain's. Counted per chain so the EVM watchlist batch is
      // measurable without disturbing the Solana numbers above.
      if (/^\/tokens\/v1\/[^/]+\//.test(p) && !p.startsWith('/tokens/v1/solana/')) {
        const chain = p.split('/')[3];
        const addrs = decodeURIComponent(p.slice(`/tokens/v1/${chain}/`.length)).split(',').filter(Boolean);
        bump('ds:chainbatch');
        return json(addrs.slice(0, 30).map((a, i) => ({ ...dsPair(a, i), chainId: chain })));
      }
      if (p.startsWith('/token-pairs/v1/')) {
        bump('ds:chainsingle');
        const parts = p.split('/');
        const chain = parts[3];
        const addr = decodeURIComponent(parts[4] ?? '');
        return json([{ ...dsPair(addr, 0), chainId: chain }]);
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

    // The token-metadata gateways (engine/metadata.ts): the file behind a
    // cid, or 404. Counted as one key whichever gateway was asked.
    if (host === 'ipfs.io' || host === 'ipfs.4everland.io' || host === 'ipfs.filebase.io') {
      bump('ipfs');
      const doc = ipfsDocs.get(p.split('/ipfs/')[1] ?? '');
      return doc ? json(doc) : new Response('not found', { status: 404 });
    }

    bump(`other:${host}`);
    return json({});
  };
}

install();

const baseCtx = {
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
  // No scanner in a call-count harness: the New column is provider-fed here
  // exactly as it was before the tape became a second source.
  liveLaunches: () => [],
  registerPool: () => {},
  watchPumpMint: () => {},
  unwatchPumpMint: () => {},
  watchDbcPool: () => {},
  unwatchDbcPool: () => {},
  watchLaunchLabPool: () => {},
  unwatchLaunchLabPool: () => {},
  watchBoop: () => {},
  unwatchBoop: () => {},
};
market.attach(baseCtx);

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

// ── The token's own metadata file (2026-09-20) ────────────────────────
// User report: a coin flagged as a runner had an X and a website on pump.fun
// and neither in the app — pump.fun's record copies them from the metadata
// JSON minutes later, DexScreener and Jupiter had not indexed the coin, and
// the app never read the file itself. Now the summary does, last, through
// the URI the chain carries.

test('a fresh pump coin nobody has indexed shows its X and website from its own metadata file', async () => {
  http.clearCache();
  resetCounts();
  market.attach(baseCtx);
  const mint = mintFor(61_000);
  const CID = 'bafkreifperm6h64s2pan3jgsq2p6xbxlqf2tnwbd65bs44vzabsoqmp254';
  const uri = `https://ipfs.io/ipfs/${CID}`;
  // The chain: a curve, the mint, and a metadata account naming the file.
  liveAccounts.set(bondingCurveFor(mint), { owner: 'pump', data: curveAccount({ vTok: vTokAt(5), vSol: 31_000_000_000n, realSol: 1_000_000_000n, creator: CREATOR }) });
  liveAccounts.set(mint, { owner: TOKEN_PROGRAM, data: mintAccount() });
  // Laid out by hand: `metaAccount` above writes `b58decode(mint)` for the
  // 32-byte mint field, but the harness mints decode to 33 bytes, which
  // shifts the strings and the parser reads nothing (the chain names in
  // those tests come from the provider stubs, unnoticed). The parser does
  // not read the mint field, so 32 zero bytes are the honest fixture.
  liveAccounts.set(metadataFor(mint), {
    owner: 'meta',
    data: Buffer.concat([Buffer.from([4]), Buffer.alloc(32), Buffer.alloc(32), borsh('Source', 32), borsh('SOURCE', 10), borsh(uri, 200), Buffer.alloc(3)]),
  });
  // pump.fun's record at +60 s: no socials, no image, yet.
  coinExtra.set(mint, { twitter: null, telegram: null, website: null, image_uri: null });
  ipfsDocs.set(CID, { name: 'Source', symbol: 'SOURCE', twitter: 'https://x.com/jackzampolin', website: 'https://source.network/' });

  const s = await market.summary(mint);
  assert.equal(s.name, 'Source', 'the chain named it — the metadata account parsed');
  assert.equal(s.socials.twitter, 'https://x.com/jackzampolin');
  assert.equal(s.socials.website, 'https://source.network/');
  assert.equal(s.socials.telegram, null);
  assert.equal(s.sources.socials, 'metadata', 'the source says where the links came from');
  assert.equal(n('ipfs'), 1, `one fetch of the file, got ${n('ipfs')}`);

  // The next build (a token page rebuilds every five seconds) reads the
  // module's own memory of the file — no second request.
  http.clearCache();
  const again = await market.summary(mint);
  assert.equal(again.socials.twitter, 'https://x.com/jackzampolin');
  assert.equal(n('ipfs'), 1, 'the file is remembered across builds');
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


// ── The EVM watchlist batch (2026-09-15) ──────────────────────────────
//
// The Solana half of the watchlist has been batched since 2026-09-08; each
// pinned EVM token still cost its own DexScreener round trip, every twenty
// seconds. `tokenPairsOnMany` warms the very key `tokenPairsOn` reads, which
// is the whole mechanism — if the keys ever stop matching, the batch becomes
// a request that saves nothing and nobody would see it.

test('tokenPairsOnMany warms the very cache tokenPairsOn reads', async () => {
  http.clearCache();
  resetCounts();
  const addrs = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`);
  await ds.tokenPairsOnMany('bsc', addrs);
  assert.equal(n('ds:chainbatch'), 1, 'one request for the whole list');
  for (const a of addrs) {
    const pairs = await ds.tokenPairsOn('bsc', a);
    assert.ok(pairs.length > 0, `${a} still answers per token`);
  }
  assert.equal(n('ds:chainsingle'), 0, 'from the warmed cache, with no extra request');
});

test('a single token is not batched — the one-token route is already one request', async () => {
  http.clearCache();
  resetCounts();
  await ds.tokenPairsOnMany('bsc', ['0x' + 'a'.repeat(40)]);
  assert.equal(n('ds:chainbatch'), 0, 'a batch of one would be a second round trip, not a saving');
});

test('the chain batch is capped like the Solana one, and casing does not split it', async () => {
  http.clearCache();
  resetCounts();
  const addrs = Array.from({ length: 31 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, 'b')}`);
  // The same address in two casings is ONE token: an 0x address is
  // case-insensitive and a split would buy the same row twice.
  await ds.tokenPairsOnMany('bsc', [...addrs, addrs[0].toUpperCase().replace('0X', '0x')]);
  assert.equal(n('ds:chainbatch'), 2, '31 tokens is two chunks of at most 30');
});

// ── 5: with the scanner running, the feed is the pump source ──────────
//
// 2026-09-20. pump.fun 429'd this app's list routes almost every time, so
// the New, Graduating and Migrated columns said "Rate limited by pump.fun"
// all day over rows that were entirely fresh — the scanner already hears
// every create, every trade on every curve and every migration. Now those
// columns take their pump rows from the feed's own books (engine/liveCurves
// .ts) and ask pump.fun only to bootstrap a column the feed has not filled
// yet; and a park is stamped on a column only for a provider it ASKED.

const B58_ALPHABET = B58;
/** Real 32-byte keys for the live books: the chain reads derive PDAs from
 *  them and the token accounts carry them, so the harness mints above (which
 *  decode to 33 bytes) will not do here. */
function liveMintFor(i) {
  let v = i + 1;
  let s = '';
  while (v > 0) {
    s = B58_ALPHABET[v % 58] + s;
    v = Math.floor(v / 58);
  }
  const mint = `12${s.padStart(38, '1')}pump`;
  assert.equal(b58decode(mint).length, 32, `${mint} must be a 32-byte key`);
  return mint;
}
function b58decode(str) {
  let n = 0n;
  for (const ch of str) n = n * 58n + BigInt(B58_ALPHABET.indexOf(ch));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (str[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes]);
}
function keyFor(tag) {
  const bytes = createHash('sha256').update(tag).digest();
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58_ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}
const sha8 = (t) => createHash('sha256').update(t).digest().subarray(0, 8);
const CURVE_DISC = sha8('account:BondingCurve');
const POOL_DISC = sha8('account:Pool');
const INITIAL_VTOK = 1_073_000_000_000_000n;
const SELLABLE_TOK = 793_100_000_000_000n;
const vTokAt = (pct) => INITIAL_VTOK - (SELLABLE_TOK * BigInt(Math.round(pct * 100))) / 10_000n;

function curveAccount({ vTok, vSol, realSol = 0n, complete = false, creator }) {
  const d = Buffer.alloc(151);
  CURVE_DISC.copy(d, 0);
  d.writeBigUInt64LE(vTok, 8);
  d.writeBigUInt64LE(vSol, 16);
  d.writeBigUInt64LE(realSol, 32);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  d[48] = complete ? 1 : 0;
  if (creator) b58decode(creator).copy(d, 49);
  return d;
}
function mintAccount() {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  d.writeUInt8(6, 44);
  d.writeUInt8(1, 45);
  return d;
}
const borsh = (str, width) => {
  const body = Buffer.alloc(width);
  body.write(str, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(width, 0);
  return Buffer.concat([len, body]);
};
const metaAccount = (mint, name, symbol) =>
  Buffer.concat([Buffer.from([4]), Buffer.alloc(32), b58decode(mint), borsh(name, 32), borsh(symbol, 10), borsh('https://ipfs.io/ipfs/Qm', 200), Buffer.alloc(3)]);
function tokenAccount(mint, owner, amount) {
  const d = Buffer.alloc(165);
  b58decode(mint).copy(d, 0);
  b58decode(owner).copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  return d;
}
function poolAccount({ baseMint, poolBaseAta, poolQuoteAta, creator }) {
  const d = Buffer.alloc(301);
  POOL_DISC.copy(d, 0);
  d[8] = 254;
  b58decode(creator).copy(d, 11);
  b58decode(baseMint).copy(d, 43);
  b58decode(WSOL_MINT).copy(d, 75);
  b58decode(keyFor('lp')).copy(d, 107);
  b58decode(poolBaseAta).copy(d, 139);
  b58decode(poolQuoteAta).copy(d, 171);
  d.writeBigUInt64LE(1n, 203);
  b58decode(creator).copy(d, 211);
  d.writeBigUInt64LE(17_584_500_000n, 245);
  return d;
}

const CREATOR = keyFor('live-creator');
/** The feed's books, `count` deep each, with the chain accounts behind them. */
function seedLiveBooks(count) {
  liveAccounts.clear();
  const now = Date.now();
  const curves = [];
  for (let i = 0; i < count; i++) {
    const mint = liveMintFor(i);
    const pct = 95 - i; // most progressed first, distinct
    const vTok = vTokAt(pct);
    const vSol = 40_000_000_000n + BigInt(i) * 1_000_000_000n;
    liveAccounts.set(bondingCurveFor(mint), { owner: 'pump', data: curveAccount({ vTok, vSol, realSol: 12_000_000_000n, creator: CREATOR }) });
    liveAccounts.set(mint, { owner: TOKEN_PROGRAM, data: mintAccount() });
    liveAccounts.set(metadataFor(mint), { owner: 'meta', data: metaAccount(mint, `Live ${i}`, `LV${i}`) });
    curves.push({ mint, vSol, vTok, creator: CREATOR, trades: 10, firstSeenAt: now - 60_000, lastTradeAt: now - i * 100, progressPct: pct, complete: false });
  }
  const migrations = [];
  for (let i = 0; i < count; i++) {
    const mint = liveMintFor(1_000 + i);
    const pool = pumpSwapCanonicalPoolFor(mint);
    const quoteAta = ataFor(pool, WSOL_MINT, TOKEN_PROGRAM);
    const baseAta = ataFor(pool, mint, TOKEN_PROGRAM);
    liveAccounts.set(bondingCurveFor(mint), { owner: 'pump', data: curveAccount({ vTok: vTokAt(100), vSol: 115_000_000_000n, complete: true, creator: CREATOR }) });
    liveAccounts.set(mint, { owner: TOKEN_PROGRAM, data: mintAccount() });
    liveAccounts.set(metadataFor(mint), { owner: 'meta', data: metaAccount(mint, `Grad ${i}`, `GR${i}`) });
    liveAccounts.set(pool, { owner: 'pAMM', data: poolAccount({ baseMint: mint, poolBaseAta: baseAta, poolQuoteAta: quoteAta, creator: CREATOR }) });
    liveAccounts.set(quoteAta, { owner: TOKEN_PROGRAM, data: tokenAccount(WSOL_MINT, pool, 50_000_000_000n) });
    liveAccounts.set(baseAta, { owner: TOKEN_PROGRAM, data: tokenAccount(mint, pool, 270_000_000_000_000n) });
    migrations.push({ mint, pool, solSeeded: 85_000_000_000n, detectedAt: now - i * 5_000 });
  }
  const launches = [];
  for (let i = 0; i < count; i++) {
    const mint = liveMintFor(2_000 + i);
    launches.push({
      mint, name: `Fresh ${i}`, symbol: `FR${i}`, uri: '', creator: CREATOR, bondingCurve: bondingCurveFor(mint), signature: `sig${i}`, slot: 1,
      detectedAt: now - i * 1_000, phase: 'watching', riskFlags: [], flow: { curveProgressPct: 3 }, score: null, priceSol: 3e-8, priceHistory: [],
      reason: null, creatorPriorLaunches: 0, creatorPriorRugs: 0, smartBuyerCount: 0, smartEarly: false,
    });
  }
  return { curves, migrations, launches };
}
const liveCtx = (books) => ({
  ...baseCtx,
  // The harness above predates the Raydium rail; the Migrated column asks
  // for its live pools too.
  livePools: () => [],
  scannerRunning: () => true,
  liveLaunches: (limit) => books.launches.slice(0, limit),
  liveLaunch: (mint) => books.launches.find((l) => l.mint === mint) ?? null,
  liveCurves: (limit) => books.curves.slice(0, limit),
  liveMigrations: (limit) => books.migrations.slice(0, limit),
});
const jupTotal = () => [...counts.entries()].filter(([k]) => k.startsWith('jup:')).reduce((a, [, v]) => a + v, 0);

test('scanner running: a full Discover pass asks pump.fun for nothing and reads the chain instead', async () => {
  http.clearCache();
  resetCounts();
  const books = seedLiveBooks(40);
  market.attach(liveCtx(books));
  // Warm GeckoTerminal's four listings first (memoised 45–90 s). With them
  // cold, the three columns assemble their rows seconds apart — GeckoTerminal
  // is paced at one request per 2.1 s — and their Jupiter asks fall into
  // different merge windows; warm, they finish together, which is the shape
  // of every pass but the first after a start.
  await Promise.all([gt.poolsForDex('raydium-launchlab', 1), gt.poolsForDex('boop-fun', 1), gt.poolsForDex('meteora-dbc', 1), gt.newPools(1)]);
  resetCounts();
  const [fresh, grad, mig] = await Promise.all([
    market.discover('new', 40, '5m'),
    market.discover('graduating', 40, '5m'),
    market.discover('migrated', 40, '5m'),
  ]);
  // Three columns asked together: their Shield and enrichment asks merge
  // into one request per hundred mints (jupiter.ts coalescer + the route's
  // 100-mint chunk), not one request per column. 130 distinct mints here
  // (40 + 40 + 40 + the ten `recent` rows) is two chunks.
  const chunks = Math.ceil(new Set([...fresh, ...grad, ...mig].map((r) => r.mint)).size / 100);
  assert.ok(n('jup:shield') <= chunks, `three columns' Shield asks merged — ${n('jup:shield')} requests for ${chunks} chunk(s) (timeline ${stamps.slice(-16).join(' ')})`);
  assert.ok(n('jup:batch') <= chunks, `three columns' enrichment asks merged — ${n('jup:batch')} requests for ${chunks} chunk(s)`);
  await market.discover('trending', 40, '5m');
  assert.equal(n('pump:list') + n('pump:coin') + n('pump:creator'), 0, `no pump.fun request at all — got ${n('pump:list')} list, ${n('pump:coin')} coin`);
  assert.ok(n('rpc:getMultipleAccounts') >= 2 && n('rpc:getMultipleAccounts') <= 8, `batched chain reads priced the rows — ${n('rpc:getMultipleAccounts')} calls`);

  assert.equal(grad.length, 40, 'the Graduating column is full from the feed');
  assert.equal(grad[0].name, 'Live 0', 'named from the chain\'s metadata');
  assert.equal(grad[0].symbol, 'LV0');
  assert.ok(grad.every((r, i) => i === 0 || (r.bondingCurvePct ?? 0) <= (grad[i - 1].bondingCurvePct ?? 0)), 'most progressed first');
  assert.ok(Math.abs(grad[0].bondingCurvePct - 95) < 0.01, `token-side progress from the curve: ${grad[0].bondingCurvePct}`);
  assert.equal(grad[0].sources.price, 'onchain');
  assert.equal(grad[0].creator, CREATOR);
  assert.ok(grad[0].liquidityUsd > 0, 'real SOL priced as liquidity');

  assert.equal(mig.length, 40, 'the Migrated column is full from the feed');
  assert.equal(mig[0].name, 'Grad 0');
  assert.equal(mig[0].dexId, 'pumpswap');
  assert.ok(mig[0].priceSol > 0 && mig[0].sources.price === 'onchain', 'priced on the canonical pool');
  assert.equal(mig[0].poolAddress, books.migrations[0].pool);
  assert.equal(mig[0].createdAt, books.migrations[0].detectedAt, 'sorted by the migration moment');
  assert.ok(mig.every((r, i) => i === 0 || (r.createdAt ?? 0) <= (mig[i - 1].createdAt ?? 0)), 'newest migration first');

  assert.ok(fresh.some((r) => r.mint === books.launches[0].mint && r.name === 'Fresh 0'), 'the New column carries the scanner\'s launches');
  assert.equal(market.discoverParkNote('graduating'), '', 'nothing parked, nothing said');
});

test('scanner running but the feed still thin: pump.fun bootstraps the column once, then is left alone', async () => {
  http.clearCache();
  resetCounts();
  market.attach(liveCtx(seedLiveBooks(5)));
  await market.discover('graduating', 40, '5m');
  assert.equal(n('pump:list'), 1, 'five live curves cannot fill a column of forty: the list is asked');
  http.clearCache();
  market.attach(liveCtx(seedLiveBooks(40)));
  await market.discover('graduating', 40, '5m');
  assert.equal(n('pump:list'), 1, 'once the feed carries the column, it is not');
});

test('a parked pump.fun is stamped only on a column that actually asked it', async () => {
  http.clearCache();
  resetCounts();
  pumpDown = true;
  try {
    market.attach(baseCtx); // scanner stopped: the list IS the source
    await market.discover('graduating', 40, '5m');
    assert.ok(n('pump:list') >= 1, 'the stopped-scanner path asked pump.fun');
    assert.match(market.discoverParkNote('graduating'), /pump\.fun/, 'and its 429 is reported on the column that depends on it');
    market.attach(liveCtx(seedLiveBooks(40)));
    http.clearCache();
    await market.discover('graduating', 40, '5m');
    assert.equal(market.discoverParkNote('graduating'), '', 'the feed-filled column says nothing about a provider it never asked');
    assert.ok(http.cooldownRemainingMs('pumpfun') > 0, '(the park itself is still on — the banner moved, the state did not)');
  } finally {
    pumpDown = false;
  }
});

test('one full pass costs Jupiter a handful of calls, and the next pass within the memos costs none', async () => {
  http.clearCache();
  resetCounts();
  market.attach(liveCtx(seedLiveBooks(40)));
  for (const col of ['new', 'graduating', 'migrated', 'trending']) await market.discover(col, 40, '5m');
  const first = jupTotal();
  // recent + two trending lists, one enrichment batch per column that has
  // rows Jupiter has not described, Shield per column, SOL/USD once.
  assert.ok(first <= 12, `a cold pass is at most a dozen Jupiter calls — got ${first} (${[...counts.entries()].filter(([k]) => k.startsWith('jup:')).map(([k, v]) => `${k}=${v}`).join(' ')})`);
  assert.equal(n('jup:single'), 0, 'never one search per row');
  const batchesBefore = n('jup:batch');
  const shieldBefore = n('jup:shield');
  // A pass takes real seconds here (the rug attach has a 2 s budget per
  // column and the queues space themselves), so the 12 s `recent` list and
  // the 20 s SOL/USD rate may legitimately expire between the two passes.
  // What must NOT recur is the per-row work: the enrichment batches and the
  // Shield verdicts are remembered per mint for 45 s and 60 s.
  for (const col of ['new', 'graduating', 'migrated', 'trending']) await market.discover(col, 40, '5m');
  assert.equal(n('jup:batch'), batchesBefore, `no enrichment batch is bought back for rows already described — got ${n('jup:batch') - batchesBefore} more`);
  assert.equal(n('jup:shield'), shieldBefore, `no Shield verdict is bought back within its memo — got ${n('jup:shield') - shieldBefore} more`);
  assert.ok(jupTotal() - first <= 2, `at most the two short-lived lists on a second pass — got ${jupTotal() - first} more (${[...counts.entries()].filter(([k]) => k.startsWith('jup:')).map(([k, v]) => `${k}=${v}`).join(' ')})`);
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
