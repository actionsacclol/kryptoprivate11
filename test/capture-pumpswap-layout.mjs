// Capture the golden fixture for the PumpSwap (pump-amm) trade layout
// (test/fixtures/pumpswap-layout.json): a recent LANDED buy and sell on a
// CANONICAL pool (created by pump's migration, quoted in WSOL), with each
// account's writability off the message header, the raw pool and
// GlobalConfig bytes at capture time, and the swap event's numbers, so
// pumpswap.test.mjs re-derives every slot and re-checks the quote math
// offline. Networked: `npm run fixture:pumpswap-layout`. Run it when pump
// changes a layout and the golden test fails; review the diff before
// committing.
//
// Sampling: the pools pump's migration authority created most recently, then
// their own trades. The program-wide firehose is mostly router-wrapped trades
// on pools anyone created; a direct buy on a migrated pool was 0 in 160
// signatures of it on 2026-09-19. A CPI's account list is still the
// program's own instruction account list, so inner instructions count.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let RPC = 'https://api.mainnet-beta.solana.com';
try {
  const key = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.rpc?.heliusApiKey;
  if (key) RPC = `https://mainnet.helius-rpc.com/?api-key=${key}`;
} catch {
  /* public RPC it is */
}
const PAMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL = 'So11111111111111111111111111111111111111112';
const MIGRATION_AUTH = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const disc = (n) => createHash('sha256').update(n).digest().subarray(0, 8).toString('hex');
const BUY = disc('global:buy');
const SELL = disc('global:sell');
const BUY_EVENT = disc('event:BuyEvent');
const SELL_EVENT = disc('event:SellEvent');
const POOL_ACCOUNT = disc('account:Pool');
const GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from('global_config')], new PublicKey(PAMM))[0].toBase58();
const poolAuthority = (mint) => PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), new PublicKey(mint).toBytes()], new PublicKey(PUMP))[0].toBase58();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  await sleep(150);
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
/** A transaction, or null when the node cannot serve it (a version this
 *  client does not read, a pruned slot). Never fatal. */
const getTx = async (sig) => {
  try {
    return await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
  } catch {
    return null;
  }
};
const acct = async (pk) => {
  const r = await rpc('getAccountInfo', [pk, { encoding: 'base64' }]);
  return r?.value ? { owner: r.value.owner, data: r.value.data[0] } : null;
};
const b58 = (buf) => new PublicKey(buf).toBase58();
function b58decode(s) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c === '1') out.unshift(0);
    else break;
  }
  return Buffer.from(out);
}
function keysOf(tx) {
  const k = [...tx.transaction.message.accountKeys];
  const la = tx.meta?.loadedAddresses;
  if (la) k.push(...(la.writable ?? []), ...(la.readonly ?? []));
  return k;
}
/** Writability by index: the message header for static keys, the
 *  loaded-addresses split for lookup-table keys. */
function writableOf(tx) {
  const msg = tx.transaction.message;
  const h = msg.header;
  const n = msg.accountKeys.length;
  const la = tx.meta?.loadedAddresses ?? { writable: [], readonly: [] };
  return (i) => (i < n ? (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < n - h.numReadonlyUnsignedAccounts) : i - n < (la.writable ?? []).length);
}
/** The swap event of THIS pool in the logs — the prefix every layout
 *  version shares (see ammDecoder.ts). */
function swapEvent(tx, pool) {
  for (const l of tx.meta.logMessages ?? []) {
    if (!l.startsWith('Program data: ')) continue;
    const buf = Buffer.from(l.slice(14), 'base64');
    const d = buf.subarray(0, 8).toString('hex');
    if (d !== BUY_EVENT && d !== SELL_EVENT) continue;
    const b = buf.subarray(8);
    if (b.length < 176 || b58(b.subarray(112, 144)) !== pool) continue;
    const u = (o) => b.readBigUInt64LE(o).toString();
    return {
      isBuy: d === BUY_EVENT,
      baseAmount: u(8),
      quoteAmount: u(56),
      lpFeeBps: u(64),
      lpFee: u(72),
      protocolFeeBps: u(80),
      protocolFee: u(88),
      userQuoteAmount: u(104),
      poolBaseReserves: u(40),
      poolQuoteReserves: u(48),
      bodyLen: b.length,
    };
  }
  return null;
}
const poolCache = new Map();
async function poolOf(addr) {
  if (poolCache.has(addr)) return poolCache.get(addr);
  const a = await acct(addr);
  let parsed = null;
  if (a && a.owner === PAMM) {
    const d = Buffer.from(a.data, 'base64');
    if (d.length >= 243 && d.subarray(0, 8).toString('hex') === POOL_ACCOUNT) {
      parsed = { data: a.data, creator: b58(d.subarray(11, 43)), baseMint: b58(d.subarray(43, 75)), quoteMint: b58(d.subarray(75, 107)), coinCreator: b58(d.subarray(211, 243)) };
    }
  }
  poolCache.set(addr, parsed);
  return parsed;
}

// ── Canonical pools from recent migrations ────────────────────────────
const migrations = await rpc('getSignaturesForAddress', [MIGRATION_AUTH, { limit: 15 }]);
const pools = [];
for (const s of migrations) {
  if (s.err || pools.length >= 6) continue;
  const tx = await getTx(s.signature);
  if (!tx || tx.meta?.err) continue;
  for (const k of keysOf(tx)) {
    if (pools.includes(k)) continue;
    const p = await poolOf(k);
    if (p && p.quoteMint === WSOL && p.creator === poolAuthority(p.baseMint)) {
      pools.push(k);
      break;
    }
  }
}
console.log(`canonical pools from recent migrations: ${pools.length}`);

// ── Their trades ──────────────────────────────────────────────────────
const want = { buy: null, sell: null };
const seenShapes = new Map();
outer: for (const pool of pools) {
  const sigs = await rpc('getSignaturesForAddress', [pool, { limit: 40 }]);
  for (const s of sigs) {
    if (want.buy && want.sell) break outer;
    if (s.err) continue;
    const tx = await getTx(s.signature);
    if (!tx || tx.meta?.err) continue;
    const keys = keysOf(tx);
    const wr = writableOf(tx);
    const nSig = tx.transaction.message.header.numRequiredSignatures;
    const ixs = [...tx.transaction.message.instructions];
    for (const g of tx.meta.innerInstructions ?? []) ixs.push(...g.instructions);
    for (const ix of ixs) {
      if (keys[ix.programIdIndex] !== PAMM) continue;
      const data = b58decode(ix.data);
      const d = data.subarray(0, 8).toString('hex');
      const kind = d === BUY ? 'buy' : d === SELL ? 'sell' : null;
      if (!kind) continue;
      const shape = `${kind}:${ix.accounts.length}`;
      seenShapes.set(shape, (seenShapes.get(shape) ?? 0) + 1);
      if (want[kind] || data.length < 24) continue;
      const accounts = ix.accounts.map((i) => ({ key: keys[i], writable: wr(i), signer: i < nSig }));
      // 25 / 23 accounts, or one more: trades on pump-migrated pools pass an
      // optional read-only account just before the buyback vault that does
      // not exist on chain (see pumpSwapBuilder.PumpSwapFill.optionalAccount).
      const base = kind === 'buy' ? 25 : 23;
      if (accounts.length !== base && accounts.length !== base + 1) continue;
      // The pool must be this one and the trader must sign — a router that
      // trades on the user's behalf still has the user sign.
      if (accounts[0].key !== pool || !accounts[1].signer) continue;
      const p = await poolOf(pool);
      const mintAcc = await acct(p.baseMint);
      want[kind] = {
        signature: s.signature,
        blockTime: tx.blockTime,
        signer: accounts[1].key,
        pool,
        baseMint: p.baseMint,
        baseTokenProgram: mintAcc?.owner ?? null,
        coinCreator: p.coinCreator,
        protocolFeeRecipient: accounts[9].key,
        buybackVault: accounts[accounts.length - 2].key,
        optionalAccount: accounts.length === base + 1 ? accounts[accounts.length - 3].key : null,
        accounts,
        data: data.toString('hex'),
        args: { base: data.readBigUInt64LE(8).toString(), quote: data.readBigUInt64LE(16).toString(), trailing: [...data.subarray(24)] },
        poolAccount: p.data,
        event: swapEvent(tx, pool),
      };
      console.log(`${kind}: ${s.signature.slice(0, 12)} pool ${pool.slice(0, 8)} mint ${p.baseMint.slice(0, 8)} accounts ${accounts.length} event ${want[kind].event ? 'yes' : 'no'}`);
    }
  }
}
console.log('instruction shapes seen:', [...seenShapes].map(([k, n]) => `${k}×${n}`).join(' ') || 'none');
if (!want.buy || !want.sell) throw new Error(`no canonical ${!want.buy ? 'buy' : 'sell'} found on ${pools.length} recently migrated pools — widen the sample`);

const globalConfig = await acct(GLOBAL_CONFIG);
const gd = Buffer.from(globalConfig.data, 'base64');
const fixture = {
  capturedAt: new Date().toISOString(),
  rpc: RPC.includes('helius') ? 'helius' : 'public',
  globalConfig: globalConfig.data,
  buybackVault: b58(gd.subarray(835, 867)),
  buy: want.buy,
  sell: want.sell,
};
fs.mkdirSync('test/fixtures', { recursive: true });
fs.writeFileSync('test/fixtures/pumpswap-layout.json', JSON.stringify(fixture, null, 1));
console.log('wrote test/fixtures/pumpswap-layout.json');
