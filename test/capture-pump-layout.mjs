// Capture the golden fixture for the derived pump trade layout
// (test/fixtures/pump-derived-layout.json): the most recent LANDED buy and
// sell whose pump instruction is a plain 18/16-account call (top-level or
// inner), with the raw bonding-curve, mint and Global account bytes at
// capture time so txbuilder.test.mjs re-derives every slot offline.
// Networked: `npm run fixture:pump-layout`. Run it when pump changes a
// layout and the golden test fails; review the diff before committing.
import fs from 'node:fs';
import { base58Decode } from './.base58.mjs';
import { PublicKey } from '@solana/web3.js';

const RPC = 'https://api.mainnet-beta.solana.com';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const BUY_DISC = '66063d1201daebea';
const SELL_DISC = '33e685a4017f83ad';
const GLOBAL = PublicKey.findProgramAddressSync([Buffer.from('global')], new PublicKey(PUMP))[0].toBase58();

const rpc = async (method, params) => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const isAta = (account, owner, mint) =>
  TOKEN_PROGRAMS.some(
    (tp) =>
      PublicKey.findProgramAddressSync(
        [new PublicKey(owner).toBytes(), new PublicKey(tp).toBytes(), new PublicKey(mint).toBytes()],
        ATA_PROGRAM,
      )[0].toBase58() === account,
  );
const acct = async (pk) => {
  await sleep(150);
  const r = await rpc('getAccountInfo', [pk, { encoding: 'base64', commitment: 'confirmed' }]);
  return r?.value ? { owner: r.value.owner, dataB64: r.value.data[0] } : null;
};

// Global first: the fixture must use pump's PRIMARY fee recipient (offset 41)
// — the pair our own builder uses. Other clients rotate among the eight
// recipients Global lists, each with its own fee vault, and the buy's
// bonding-curve-v2 slot is unchecked by the program when that account does
// not exist, so a rotated trade cannot pin our derivation exactly.
const globalAcct = await acct(GLOBAL);
const PRIMARY = new PublicKey(Buffer.from(globalAcct.dataB64, 'base64').subarray(41, 73)).toBase58();
console.error('primary fee recipient', PRIMARY);

const want = { buy: null, sell: null };
const seen = new Map();
let before;
let scanned = 0;
outer: for (let page = 0; page < 12; page++) {
const sigs = await rpc('getSignaturesForAddress', [PUMP, { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) }]);
if (!sigs.length) break;
before = sigs[sigs.length - 1].signature;
for (const s of sigs) {
  if (want.buy && want.sell) break outer;
  if (s.err) continue;
  if (++scanned > 900) break outer;
  await sleep(150);
  let tx;
  try {
    tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  } catch (e) {
    console.error('skip', s.signature.slice(0, 12), e.message);
    continue;
  }
  if (!tx?.meta || tx.meta.err) continue;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const all = [];
  for (const ix of tx.transaction.message.instructions) all.push(ix);
  for (const inner of tx.meta.innerInstructions ?? []) for (const ix of inner.instructions) all.push(ix);
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== PUMP) continue;
    const data = Buffer.from(base58Decode(ix.data));
    if (data.length < 24 || data.length > 25) continue;
    const disc = data.subarray(0, 8).toString('hex');
    const action = disc === BUY_DISC ? 'buy' : disc === SELL_DISC ? 'sell' : null;
    if (!action) continue;
    const shape = `${action}:${ix.accounts.length}acc:${data.length}B`;
    seen.set(shape, (seen.get(shape) ?? 0) + 1);
    if (want[action]) continue;
    const n = action === 'buy' ? 18 : 16;
    if (ix.accounts.length !== n) continue;
    const accounts = ix.accounts.map((i) => keys[i]);
    if (accounts[1] !== PRIMARY) {
      seen.set('rotated-recipient', (seen.get('rotated-recipient') ?? 0) + 1);
      continue;
    }
    // The user token account must be the ASSOCIATED one: pump accepts any
    // token account the user owns, and bots sell from hand-made ones, but our
    // wallet only ever holds a mint in its ATA (buys create it idempotently).
    if (!isAta(accounts[5], accounts[6], accounts[2])) {
      seen.set('non-ata-user-account', (seen.get('non-ata-user-account') ?? 0) + 1);
      continue;
    }
    want[action] = { signature: s.signature, slot: tx.slot, dataLen: data.length, accounts, mint: accounts[2], user: accounts[6], bondingCurve: accounts[3] };
    console.error(`${action}: ${s.signature.slice(0, 16)}… mint ${accounts[2].slice(0, 8)}…`);
  }
}
}
console.error('shapes seen:', Object.fromEntries(seen), 'scanned', scanned);
if (!want.buy || !want.sell) throw new Error(`incomplete: buy=${!!want.buy} sell=${!!want.sell}`);

for (const k of ['buy', 'sell']) {
  want[k].curve = await acct(want[k].bondingCurve);
  want[k].mintAccount = await acct(want[k].mint);
}
const global = globalAcct;

fs.writeFileSync(
  'test/fixtures/pump-derived-layout.json',
  JSON.stringify({ capturedAt: new Date().toISOString(), global: { address: GLOBAL, ...global }, buy: want.buy, sell: want.sell }, null, 2) + '\n',
);
console.error('written test/fixtures/pump-derived-layout.json');
