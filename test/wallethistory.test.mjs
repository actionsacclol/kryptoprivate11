// Wallet history (walletHistory.ts): a wallet's recent swaps read from the
// chain into the Scout's record. Pinned here: the RPC is asked once for the
// listing and then in batches for the transactions; failed and out-of-window
// signatures are never read; trades are fed OLDEST-FIRST so a round trip
// closes; every trade carries its signature so a second read is all
// duplicates; non-swaps and unreadable transactions are counted, never fed;
// and the refusals (bad address, already running, no endpoint).

import assert from 'node:assert';
import * as history from './.wallethistory.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// A real base58 shape: the module refuses anything else (no lowercase L).
const W = 'Whae1111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MINT_A = 'MintA111111111111111111111111111111111111111';
const MINT_B = 'MintB111111111111111111111111111111111111111';
const MINT_C = 'MintC111111111111111111111111111111111111111';
const SOL = 1_000_000_000;
const NOW_S = Math.floor(Date.now() / 1000);

/** A router buy by W: `sol` out, 1000 tokens of `mint` in. */
const buyTx = (mint, sol, blockTime) => ({
  blockTime,
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10 * SOL, 0, 0],
    postBalances: [10 * SOL - sol * SOL - 5000, 0, 0],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 5, mint, owner: W, uiTokenAmount: { amount: '1000000000', decimals: 6, uiAmount: null } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [W, JUP, mint],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
});
/** The reverse: all 1000 tokens of `mint` out, `sol` in. */
const sellTx = (mint, sol, blockTime) => ({
  blockTime,
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10 * SOL, 0, 0],
    postBalances: [10 * SOL + sol * SOL - 5000, 0, 0],
    preTokenBalances: [{ accountIndex: 5, mint, owner: W, uiTokenAmount: { amount: '1000000000', decimals: 6, uiAmount: null } }],
    postTokenBalances: [{ accountIndex: 5, mint, owner: W, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: null } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [W, JUP, mint],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
});
/** A plain SOL transfer: no token leg, so not a swap. */
const transferTx = (blockTime) => ({
  blockTime,
  meta: { err: null, fee: 5000, preBalances: [10 * SOL, 0], postBalances: [9 * SOL - 5000, SOL], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
  transaction: {
    message: {
      accountKeys: [W, 'Someone111111111111111111111111111111111111'],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    },
  },
});

// The chain, newest first as the RPC lists it. `old` is outside the week and
// must never be read; `bad` failed and must never be read either.
const TXS = {
  sigSellC: sellTx(MINT_C, 0.9, NOW_S - 100),
  sigBuyC: buyTx(MINT_C, 0.6, NOW_S - 200),
  sigXfer: transferTx(NOW_S - 250),
  sigBuyB: buyTx(MINT_B, 0.6, NOW_S - 300),
  sigBuyA: buyTx(MINT_A, 0.6, NOW_S - 400),
};
let listing = [
  { signature: 'sigSellC', err: null, blockTime: NOW_S - 100 },
  { signature: 'sigBuyC', err: null, blockTime: NOW_S - 200 },
  { signature: 'sigXfer', err: null, blockTime: NOW_S - 250 },
  { signature: 'sigBad', err: { InstructionError: [0, 'Custom'] }, blockTime: NOW_S - 280 },
  { signature: 'sigBuyB', err: null, blockTime: NOW_S - 300 },
  { signature: 'sigBuyA', err: null, blockTime: NOW_S - 400 },
  { signature: 'sigOld', err: null, blockTime: NOW_S - 30 * 24 * 3600 },
];
const calls = { list: 0, batches: [], sigs: [] };
let listFails = false;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const reply = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload });
  if (!Array.isArray(body)) {
    assert.equal(body.method, 'getSignaturesForAddress', `only the listing is a single call, got ${body.method}`);
    calls.list += 1;
    if (listFails) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'boom' };
    return reply({ jsonrpc: '2.0', id: body.id, result: listing });
  }
  calls.batches.push(body.length);
  return reply(
    body.map((req) => {
      assert.equal(req.method, 'getTransaction');
      const sig = req.params[0];
      calls.sigs.push(sig);
      assert.notEqual(sig, 'sigOld', 'a transaction older than the window is never read');
      assert.notEqual(sig, 'sigBad', 'a failed transaction is never read');
      return { jsonrpc: '2.0', id: req.id, result: TXS[sig] ?? null };
    }),
  );
};

const book = () => history._store.wallets('solana').find((w) => w.address === W.toLowerCase());
const fresh = () => {
  history._reset();
  history._store._reset();
  calls.list = 0;
  calls.batches = [];
  calls.sigs = [];
};

// ── the read: listing once, batches, oldest first, a trip closes ──────────
{
  fresh();
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  assert.equal(history.start(W, 'http://rpc.test').ok, false, 'a second read of the same wallet is refused while one runs');
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.running, false);
  assert.equal(calls.list, 1, 'one listing');
  assert.equal(st.signatures, 5, 'the failed one and the month-old one are dropped before any read');
  assert.deepEqual(calls.sigs, ['sigBuyA', 'sigBuyB', 'sigXfer', 'sigBuyC', 'sigSellC'], 'read oldest first, so a sell finds its buy on the book');
  assert.equal(st.read, 5);
  assert.equal(st.swaps, 4);
  assert.equal(st.notSwap, 1, 'a transfer is not a trade');
  assert.equal(st.unreadable, 0);
  assert.equal(st.fed, 4);
  assert.equal(st.duplicates, 0);
  assert.equal(st.calls, 2, 'one listing + one batch of five');
  assert.equal(st.oldestAt, (NOW_S - 400) * 1000, 'dated from the block, not the read');
  assert.equal(st.newestAt, (NOW_S - 100) * 1000);
  assert.equal(st.message, '');
  const w = book();
  assert.ok(w, 'the wallet has a record — three buys promoted it');
  const trips = w.days.reduce((n, d) => n + d.roundTrips, 0);
  assert.equal(trips, 1, 'the C buy (the promoting trade) and its sell make one round trip');
  ok('a read lists once, drops failed and old signatures, feeds oldest-first, and closes a trip');
}

// ── a second read is all duplicates ──────────────────────────────────────
{
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.swaps, 4);
  assert.equal(st.fed, 0, 'nothing new');
  assert.equal(st.duplicates, 4, 'every trade carries its signature, so the book refuses it the second time');
  const w = book();
  assert.equal(
    w.days.reduce((n, d) => n + d.roundTrips, 0),
    1,
    'a re-read does not double the record',
  );
  ok('a second read of the same wallet is refused trade by trade as duplicates');
}

// ── refusals and the quiet-wallet message ────────────────────────────────
{
  fresh();
  assert.equal(history.start('not-an-address', 'http://rpc.test').ok, false);
  assert.equal(history.start(W, '').ok, false, 'no endpoint, no read');
  listFails = true;
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  await history.wait(W);
  assert.match(history.status(W).message, /Could not list/);
  assert.equal(history.status(W).read, 0);
  listFails = false;
  // Two swaps only: read, counted, and the status says why nothing shows.
  fresh();
  listing = listing.filter((x) => x.signature === 'sigBuyA' || x.signature === 'sigBuyB');
  assert.equal(history.start(W, 'http://rpc.test').ok, true);
  await history.wait(W);
  const st = history.status(W);
  assert.equal(st.swaps, 2);
  assert.match(st.message, /needs 3 before it gets a record/);
  ok('bad addresses, a missing endpoint and a failed listing are refused in words; a quiet wallet is explained');
}

console.log(`\nwallethistory: ${passed}/3 passed`);
