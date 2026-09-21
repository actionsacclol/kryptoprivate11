// The on-chain pump coin reader (electron/data/pumpChain.ts).
//
// What it replaces: one pump.fun `/coins/{mint}` per summary build — every
// five seconds per open token, every twelve per armed order, every holding
// on a portfolio pass — against a host that allows ~60 a minute and parked
// the provider around the clock (2026-09-20). What it pins:
//
//   - ONE getMultipleAccounts prices a whole batch (three derived accounts
//     per mint, thirty-three mints per call), and graduated coins cost one
//     more call of the same shape — never one request per mint.
//   - The mint bytes in that batch seed `mintFacts()`, so the summary's own
//     mint read that follows is a cache hit, not a fourth request.
//   - Honest null: "no curve account" is not a pump coin and is remembered
//     briefly; "the RPC did not answer" is unknown and is asked again.
//   - The prices: virtual reserves on the curve; quote vault PLUS virtual
//     quote over the base vault on the pool (pumpSwapBuilder's fitted rule).
//   - The summary the chain states carries `onchain` sources and nothing the
//     chain cannot know.

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import {
  CHAIN_TTL_MS,
  MINTS_PER_CALL,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  ataFor,
  base58Decode,
  bondingCurveFor,
  cached,
  canonicalPoolFor,
  clearCache,
  curvePriceSol,
  curveProgressTokenPct,
  looksLikePumpMint,
  metadataFor,
  mintFacts,
  parseMetaplex,
  poolPriceSol,
  read,
  readIfCached,
  readMany,
  toSummary,
} from './.pumpchain.mjs';

const RPC = 'https://rpc.harness.test';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha8 = (s) => createHash('sha256').update(s).digest().subarray(0, 8);
const CURVE_DISC = sha8('account:BondingCurve');
const POOL_DISC = sha8('account:Pool');

/** A real-shape pump mint: 44 base58 chars, the `pump` suffix, and a value
 *  that decodes to exactly 32 bytes (a leading `12` keeps it small). */
function mintFor(i) {
  let v = i + 1;
  let s = '';
  while (v > 0) {
    s = B58[v % 58] + s;
    v = Math.floor(v / 58);
  }
  const mint = `12${s.padStart(38, '1')}pump`;
  assert.equal(base58Decode(mint).length, 32, `${mint} is not a 32-byte key`);
  return mint;
}
/** Any other 32-byte key, deterministic. */
function keyFor(tag) {
  const bytes = createHash('sha256').update(tag).digest();
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}

// ── Account builders (the layouts the reader parses) ──────────────────

function curveAccount({ vTok, vSol, realTok = 0n, realSol = 0n, supply = 1_000_000_000_000_000n, complete = false, creator = null, mayhem = false }) {
  const d = Buffer.alloc(151);
  CURVE_DISC.copy(d, 0);
  d.writeBigUInt64LE(vTok, 8);
  d.writeBigUInt64LE(vSol, 16);
  d.writeBigUInt64LE(realTok, 24);
  d.writeBigUInt64LE(realSol, 32);
  d.writeBigUInt64LE(supply, 40);
  d[48] = complete ? 1 : 0;
  if (creator) Buffer.from(base58Decode(creator)).copy(d, 49);
  d[81] = mayhem ? 1 : 0;
  return d;
}
function mintAccount({ decimals = 6, supply = 1_000_000_000_000_000n } = {}) {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(0, 0);
  d.writeBigUInt64LE(supply, 36);
  d.writeUInt8(decimals, 44);
  d.writeUInt8(1, 45);
  d.writeUInt32LE(0, 46);
  return d;
}
const borsh = (s, width) => {
  const body = Buffer.alloc(width);
  body.write(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(width, 0);
  return Buffer.concat([len, body]);
};
function metaAccount(mint, { name, symbol, uri }) {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32),
    Buffer.from(base58Decode(mint)),
    borsh(name, 32),
    borsh(symbol, 10),
    borsh(uri, 200),
    Buffer.from([0, 0, 0]), // seller fee + start of the creators option
  ]);
}
/** A Token-2022 mint carrying its metadata in the TokenMetadata extension. */
function mint2022Account(mint, { name, symbol, uri }) {
  const base = Buffer.alloc(165);
  mintAccount().copy(base, 0);
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const body = Buffer.concat([Buffer.alloc(32), Buffer.from(base58Decode(mint)), str(name), str(symbol), str(uri), Buffer.alloc(4)]);
  const tlv = Buffer.alloc(4);
  tlv.writeUInt16LE(19, 0);
  tlv.writeUInt16LE(body.length, 2);
  return Buffer.concat([base, Buffer.from([1]), tlv, body]);
}
function tokenAccount({ mint, owner, amount }) {
  const d = Buffer.alloc(165);
  Buffer.from(base58Decode(mint)).copy(d, 0);
  Buffer.from(base58Decode(owner)).copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  return d;
}
function poolAccount({ baseMint, quoteMint = WSOL_MINT, poolBaseAta, poolQuoteAta, virtualQuote, creator }) {
  const d = Buffer.alloc(301);
  POOL_DISC.copy(d, 0);
  d[8] = 254;
  d.writeUInt16LE(0, 9);
  Buffer.from(base58Decode(creator)).copy(d, 11);
  Buffer.from(base58Decode(baseMint)).copy(d, 43);
  Buffer.from(base58Decode(quoteMint)).copy(d, 75);
  Buffer.from(base58Decode(keyFor('lp'))).copy(d, 107);
  Buffer.from(base58Decode(poolBaseAta)).copy(d, 139);
  Buffer.from(base58Decode(poolQuoteAta)).copy(d, 171);
  d.writeBigUInt64LE(1n, 203);
  Buffer.from(base58Decode(creator)).copy(d, 211);
  d.writeBigUInt64LE(virtualQuote, 245);
  return d;
}

// ── The RPC stub ──────────────────────────────────────────────────────

const accounts = new Map(); // address → { owner, data }
const rpcCalls = []; // { method, addrs }
let failNext = false;
const put = (address, owner, data) => accounts.set(address, { owner, data });
const view = (a) => {
  const acc = accounts.get(a);
  return acc ? { owner: acc.owner, data: [acc.data.toString('base64'), 'base64'], lamports: 1, executable: false } : null;
};
globalThis.fetch = async (input, init = {}) => {
  const body = JSON.parse(init.body ?? '{}');
  const calls = Array.isArray(body) ? body : [body];
  const replies = calls.map((c) => {
    if (c.method === 'getMultipleAccounts') {
      const addrs = c.params[0];
      rpcCalls.push({ method: c.method, addrs });
      if (failNext) {
        failNext = false;
        return { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'node is behind' } };
      }
      return { jsonrpc: '2.0', id: c.id, result: { context: { slot: 1 }, value: addrs.map(view) } };
    }
    if (c.method === 'getAccountInfo') {
      rpcCalls.push({ method: c.method, addrs: [c.params[0]] });
      return { jsonrpc: '2.0', id: c.id, result: { context: { slot: 1 }, value: view(c.params[0]) } };
    }
    return { jsonrpc: '2.0', id: c.id, result: null };
  });
  return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200, headers: { 'content-type': 'application/json' } });
};
const calls = (method) => rpcCalls.filter((c) => c.method === method);
const reset = () => {
  clearCache();
  accounts.clear();
  rpcCalls.length = 0;
  failNext = false;
};

// ── Fixtures ──────────────────────────────────────────────────────────

const CREATOR = keyFor('creator');
const A = mintFor(1); // on the curve
const B = mintFor(2); // graduated
const C = mintFor(3); // has the suffix, has no curve
const D = keyFor('not-a-pump-coin'); // no suffix at all
const A_VTOK = 800_000_000_000_000n; // 800 M tokens left of 1.073 B
const A_VSOL = 40_000_000_000n; // 40 SOL virtual
const A_REAL = 12_500_000_000n; // 12.5 SOL real
const B_QUOTE = 5_000_000_000n; // 5 SOL in the vault
const B_VIRTUAL = 17_584_500_000n; // the fitted virtual quote reserve
const B_BASE = 400_000_000_000_000n; // 400 M tokens in the vault

function seedA() {
  put(bondingCurveFor(A), 'pump', curveAccount({ vTok: A_VTOK, vSol: A_VSOL, realSol: A_REAL, creator: CREATOR }));
  put(A, TOKEN_PROGRAM, mintAccount());
  put(metadataFor(A), 'meta', metaAccount(A, { name: 'Alpha Coin', symbol: 'ALPHA', uri: 'https://ipfs.io/ipfs/QmAlpha' }));
}
function seedB({ vaultsAreAtas = true } = {}) {
  const pool = canonicalPoolFor(B);
  const quoteAta = ataFor(pool, WSOL_MINT, TOKEN_PROGRAM);
  const baseAta = ataFor(pool, B, TOKEN_PROGRAM);
  const quoteVault = vaultsAreAtas ? quoteAta : keyFor('odd-quote-vault');
  const baseVault = vaultsAreAtas ? baseAta : keyFor('odd-base-vault');
  put(bondingCurveFor(B), 'pump', curveAccount({ vTok: 279_900_000_000_000n, vSol: 115_005_359_057n, realSol: 0n, complete: true, creator: CREATOR }));
  put(B, TOKEN_PROGRAM, mintAccount());
  put(metadataFor(B), 'meta', metaAccount(B, { name: 'Beta Coin', symbol: 'BETA', uri: 'https://ipfs.io/ipfs/QmBeta' }));
  put(pool, 'pAMM', poolAccount({ baseMint: B, poolBaseAta: baseVault, poolQuoteAta: quoteVault, virtualQuote: B_VIRTUAL, creator: CREATOR }));
  put(quoteVault, TOKEN_PROGRAM, tokenAccount({ mint: WSOL_MINT, owner: pool, amount: B_QUOTE }));
  put(baseVault, TOKEN_PROGRAM, tokenAccount({ mint: B, owner: pool, amount: B_BASE }));
  return { pool, quoteAta, baseAta, quoteVault, baseVault };
}

// ── Runner ────────────────────────────────────────────────────────────

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('only a real-shape mint with the pump suffix is tried', () => {
  assert.equal(looksLikePumpMint(A), true);
  assert.equal(looksLikePumpMint(D), false, 'no suffix');
  assert.equal(looksLikePumpMint('abcpump'), false, 'too short to be a key');
  assert.equal(looksLikePumpMint(`${'0'.repeat(40)}pump`), false, 'not base58');
});

test('Metaplex metadata parses to trimmed strings, and a short account is null', () => {
  const m = parseMetaplex(metaAccount(A, { name: 'Alpha Coin', symbol: 'ALPHA', uri: 'https://x/y' }));
  assert.deepEqual(m, { name: 'Alpha Coin', symbol: 'ALPHA', uri: 'https://x/y' });
  assert.equal(parseMetaplex(Buffer.alloc(70)), null);
  assert.equal(parseMetaplex(Buffer.alloc(0)), null);
});

test('the two price rules', () => {
  // Curve: 40 SOL virtual over 800 M tokens.
  assert.ok(Math.abs(curvePriceSol(A_VSOL, A_VTOK, 6) - 40 / 800_000_000) < 1e-18);
  assert.equal(curvePriceSol(A_VSOL, 0n, 6), null, 'no tokens is no price, not infinity');
  // Pool: (5 + 17.5845) SOL over 400 M tokens — the virtual reserve counts.
  assert.ok(Math.abs(poolPriceSol(B_QUOTE, B_VIRTUAL, B_BASE, 6) - 22.5845 / 400_000_000) < 1e-18);
  assert.equal(poolPriceSol(B_QUOTE, B_VIRTUAL, 0n, 6), null);
});

test('one batch reads a curve coin, a graduated coin and a non-coin; graduated costs one more call', async () => {
  reset();
  seedA();
  const b = seedB();
  const out = await readMany(RPC, [A, B, C, D]);
  const multi = calls('getMultipleAccounts');
  assert.equal(multi.length, 2, `two RPC calls for four mints, got ${multi.length}`);
  assert.deepEqual(multi[0].addrs, [A, B, C].flatMap((m) => [bondingCurveFor(m), m, metadataFor(m)]), 'pass one: curve, mint, metadata per mint; the suffix-less mint never asked');
  assert.deepEqual(multi[1].addrs, [b.pool, b.quoteAta, b.baseAta], 'pass two: the graduated coin\'s pool and its two vaults');

  const a = out.get(A);
  assert.ok(a, 'the curve coin was read');
  assert.equal(a.name, 'Alpha Coin');
  assert.equal(a.symbol, 'ALPHA');
  assert.equal(a.uri, 'https://ipfs.io/ipfs/QmAlpha');
  assert.equal(a.decimals, 6);
  assert.equal(a.supplyRaw, 1_000_000_000_000_000n);
  assert.equal(a.curve.complete, false);
  assert.equal(a.curve.creator, CREATOR);
  assert.equal(a.curve.realSol, A_REAL);
  assert.equal(a.priceSol, curvePriceSol(A_VSOL, A_VTOK, 6));
  assert.equal(a.liquiditySol, 12.5);
  assert.equal(a.pool, null);

  const g = out.get(B);
  assert.ok(g, 'the graduated coin was read');
  assert.equal(g.curve.complete, true);
  assert.equal(g.pool.address, b.pool);
  assert.equal(g.pool.quoteLamports, B_QUOTE);
  assert.equal(g.pool.virtualQuote, B_VIRTUAL);
  assert.equal(g.pool.baseRaw, B_BASE);
  assert.equal(g.priceSol, poolPriceSol(B_QUOTE, B_VIRTUAL, B_BASE, 6));
  assert.equal(g.liquiditySol, 5, 'real quote only — the virtual reserve is not money');

  assert.equal(out.get(C), null, 'a mint with no curve is not a pump coin');
  assert.equal(out.get(D), null, 'a mint without the suffix is never tried');
});

test('the mint bytes in the batch seed mintFacts — no second read of the same account', async () => {
  reset();
  seedA();
  await readMany(RPC, [A]);
  const before = rpcCalls.length;
  const facts = await mintFacts(RPC, A);
  assert.equal(rpcCalls.length, before, 'mintFacts made no request');
  assert.equal(facts.checked, true);
  assert.equal(facts.decimals, 6);
  assert.equal(facts.isToken2022, false);
  assert.equal(facts.mintAuthority, null);
  assert.equal(facts.supplyRaw, '1000000000000000');
});

test('a coin is cached for the TTL; a non-coin is remembered; a failed read is not', async () => {
  reset();
  seedA();
  await readMany(RPC, [A, C]);
  const n = rpcCalls.length;
  assert.ok(readIfCached(A), 'the curve coin is in the cache');
  assert.equal(await read(RPC, A), readIfCached(A), 'read() is the cache hit');
  await readMany(RPC, [C]);
  assert.equal(rpcCalls.length, n, 'neither the cached coin nor the known non-coin cost a request');
  assert.ok(CHAIN_TTL_MS <= 5_000, 'a stop-loss never evaluates a price older than one poll');

  const E = mintFor(5);
  put(bondingCurveFor(E), 'pump', curveAccount({ vTok: A_VTOK, vSol: A_VSOL }));
  put(E, TOKEN_PROGRAM, mintAccount());
  failNext = true;
  const first = await readMany(RPC, [E]);
  assert.equal(first.get(E), null, 'an RPC error is no answer');
  assert.equal(cached(`pumpchain:no:${E}`), null, '…and is NOT remembered as "not a pump coin"');
  const second = await readMany(RPC, [E]);
  assert.ok(second.get(E), 'asked again, answered');
});

test('a Token-2022 coin with no Metaplex account is named from the mint\'s own metadata', async () => {
  reset();
  const T = mintFor(7);
  put(bondingCurveFor(T), 'pump', curveAccount({ vTok: A_VTOK, vSol: A_VSOL, creator: CREATOR }));
  put(T, TOKEN_2022_PROGRAM, mint2022Account(T, { name: 'Krypto Bot', symbol: 'KRYPTO', uri: 'https://ipfs.io/ipfs/QmK' }));
  const out = await readMany(RPC, [T]);
  const t = out.get(T);
  assert.ok(t);
  assert.equal(t.isToken2022, true);
  assert.equal(t.name, 'Krypto Bot');
  assert.equal(t.symbol, 'KRYPTO');
  assert.equal(t.uri, null, 'the extension walk stops at the symbol — no uri claimed');
  const facts = await mintFacts(RPC, T);
  assert.equal(facts.isToken2022, true);
});

test('a pool whose vaults are not its ATAs is read from the accounts it names', async () => {
  reset();
  const b = seedB({ vaultsAreAtas: false });
  const out = await readMany(RPC, [B]);
  const multi = calls('getMultipleAccounts');
  assert.equal(multi.length, 3, 'pass one, pass two, and the named vaults');
  assert.deepEqual(multi[2].addrs, [b.quoteVault, b.baseVault]);
  assert.equal(out.get(B).priceSol, poolPriceSol(B_QUOTE, B_VIRTUAL, B_BASE, 6));
});

test('forty mints are two calls, never forty', async () => {
  reset();
  const mints = Array.from({ length: 40 }, (_, i) => mintFor(100 + i));
  for (const m of mints) {
    put(bondingCurveFor(m), 'pump', curveAccount({ vTok: A_VTOK, vSol: A_VSOL }));
    put(m, TOKEN_PROGRAM, mintAccount());
  }
  const out = await readMany(RPC, mints);
  const multi = calls('getMultipleAccounts');
  assert.equal(multi.length, 2);
  assert.equal(multi[0].addrs.length, MINTS_PER_CALL * 3);
  assert.equal(multi[1].addrs.length, (40 - MINTS_PER_CALL) * 3);
  assert.ok(multi[0].addrs.length <= 100, 'under the RPC\'s hard cap');
  assert.equal([...out.values()].filter(Boolean).length, 40);
  assert.equal(out.get(mints[0]).name, null, 'no metadata account is an honest null name, not an empty coin');
});

test('the summary the chain states: curve coin', async () => {
  reset();
  seedA();
  const a = (await readMany(RPC, [A])).get(A);
  const s = toSummary(a, 200);
  assert.equal(s.name, 'Alpha Coin');
  assert.equal(s.symbol, 'ALPHA');
  assert.equal(s.launchpad, 'pumpfun');
  assert.equal(s.creator, CREATOR);
  assert.equal(s.decimals, 6);
  assert.equal(s.totalSupply, 1_000_000_000);
  assert.equal(s.circSupply, 1_000_000_000);
  assert.equal(s.priceSol, a.priceSol);
  assert.ok(Math.abs(s.priceUsd - a.priceSol * 200) < 1e-15);
  assert.ok(Math.abs(s.marketCapUsd - s.priceUsd * 1_000_000_000) < 1e-6);
  assert.equal(s.fdvUsd, s.marketCapUsd);
  assert.equal(s.liquidityUsd, 12.5 * 200);
  assert.equal(s.bondingCurvePct, curveProgressTokenPct(A_VTOK), 'token-side progress');
  assert.ok(s.bondingCurvePct > 34 && s.bondingCurvePct < 35, `(1.073 B − 800 M) / 793.1 M ≈ 34.4 %, got ${s.bondingCurvePct}`);
  assert.equal(s.dexId, 'pumpfun-curve');
  assert.equal(s.poolAddress, bondingCurveFor(A));
  assert.equal(s.poolQuoteMint, null);
  assert.deepEqual(s.sources, { price: 'onchain', marketCap: 'derived', liquidity: 'onchain' });
  assert.equal(s.imageUrl, null, 'nothing the chain cannot know is claimed');
  assert.equal(s.createdAt, null);
  assert.equal(s.holders, null);
  assert.equal(s.fetchedAt, a.readAt);

  const noRate = toSummary(a, null);
  assert.equal(noRate.priceSol, a.priceSol);
  assert.equal(noRate.priceUsd, null);
  assert.equal(noRate.marketCapUsd, null);
  assert.equal(noRate.liquidityUsd, null);
  assert.deepEqual(noRate.sources, { price: 'onchain' }, 'no SOL/USD rate: no USD figure, and no source claimed for one');
});

test('the summary the chain states: graduated coin', async () => {
  reset();
  const b = seedB();
  const g = (await readMany(RPC, [B])).get(B);
  const s = toSummary(g, 200);
  assert.equal(s.dexId, 'pumpswap');
  assert.equal(s.poolAddress, b.pool);
  assert.equal(s.poolQuoteMint, WSOL_MINT);
  assert.equal(s.bondingCurvePct, 100);
  assert.equal(s.priceSol, poolPriceSol(B_QUOTE, B_VIRTUAL, B_BASE, 6));
  assert.equal(s.liquidityUsd, 5 * 200);
  assert.equal(s.sources.price, 'onchain');
});

test('a graduated coin whose pool is unreadable keeps its identity and states no price', async () => {
  reset();
  seedB();
  accounts.delete(canonicalPoolFor(B));
  const g = (await readMany(RPC, [B])).get(B);
  assert.ok(g, 'still a coin');
  assert.equal(g.curve.complete, true);
  assert.equal(g.pool, null);
  assert.equal(g.priceSol, null, 'never the curve\'s last price for a coin that left the curve');
  const s = toSummary(g, 200);
  assert.equal(s.priceSol, null);
  assert.equal(s.marketCapUsd, null);
  assert.equal(s.sources.price, undefined);
  assert.equal(s.poolAddress, canonicalPoolFor(B), 'the pool address is derived even when unread');
});

let passed = 0;
let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    passed++;
    console.log(`  ok   ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${c.name}\n       ${err.message}`);
  }
}
console.log(`\npumpchain: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
