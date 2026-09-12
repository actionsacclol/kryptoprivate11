// electron/evm/ledger.ts — the EVM fill ledger.
//
// It holds the only copy of every cost basis on Robinhood Chain and BNB, so
// the rules pinned here are the ones the 2026-09-09 audit found broken:
//   1. a file that cannot be READ is never overwritten (fail closed);
//   2. one row per transaction hash, so recording a fill at broadcast and
//      again at the receipt cannot double-count it;
//   3. a debounced save can be flushed synchronously (before-quit);
//   4. a SELL's follow-up fee transfer reduces the proceeds — it is not a
//      cost of entry and must not move the average entry price.
//
// Offline: fetch is stubbed, so the reconcile that recordFill kicks off
// never leaves the machine.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.fetch = () => Promise.reject(new Error('offline test — no RPC'));

const ledger = await import('./.evmledger.mjs');
ledger._setReconcileDelayMs(1);

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = 'evm-fills.json';
const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xc7410e5136ac803e167782316c4a939a4f5097d5';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-evmledger-'));
}

// ── 1. an unreadable file is never replaced by an empty one ───────────

const dir1 = freshDir();
const p1 = path.join(dir1, FILE);
const REAL_FILL = {
  id: 'ef_real',
  chain: 'robinhood',
  token: TOKEN,
  symbol: 'REAL',
  side: 'buy',
  at: 1_757_000_000_000,
  hash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
  requested: 0.05,
  nativeDeltaWei: '-50000000000000000',
  tokenDeltaRaw: '1000000000000000000000000',
  decimals: 18,
  gasWei: '210000000000000',
  feeWei: '250000000000000',
  state: 'reconciled',
  note: null,
  wallet: WALLET,
  venue: 'pons-curve',
};
// A half-written file: valid JSON up to the point the disk gave out.
const truncated = JSON.stringify({ version: 2, fills: [REAL_FILL], tracked: {} }).slice(0, 400);
fs.writeFileSync(p1, truncated, 'utf8');

ledger._reset();
ledger.init(dir1);

ok('a corrupt ledger file loads as EMPTY but is flagged, not treated as a first run', () => {
  assert.equal(ledger.all().length, 0, 'nothing is served from a file we could not parse');
  assert.match(ledger.loadFailure() ?? '', /corrupt/i);
});

await (async () => {
  ledger.track('robinhood', WALLET, TOKEN, true);
  await sleep(400); // longer than the 250 ms save debounce
})();

ok('and a write is REFUSED while the file is unreadable — the fills survive on disk', () => {
  assert.equal(fs.readFileSync(p1, 'utf8'), truncated, 'the file must be byte-for-byte what it was');
});

ok('flushSync also refuses while the file is unreadable', () => {
  ledger.track('robinhood', WALLET, TOKEN, false);
  ledger.flushSync();
  assert.equal(fs.readFileSync(p1, 'utf8'), truncated);
});

// A missing file, by contrast, is an ordinary first run.
const dir2 = freshDir();
ledger._reset();
ledger.init(dir2);

ok('a MISSING ledger file is a first run: empty, no failure, writable', () => {
  assert.equal(ledger.loadFailure(), null);
  assert.equal(ledger.all().length, 0);
});

// ── 2. flushSync writes the debounced save immediately ────────────────

ok('flushSync writes a pending save now instead of in 250 ms', () => {
  const p2 = path.join(dir2, FILE);
  ledger.track('robinhood', WALLET, TOKEN, true);
  assert.equal(fs.existsSync(p2), false, 'the save is still debounced');
  ledger.flushSync();
  assert.equal(fs.existsSync(p2), true);
  const saved = JSON.parse(fs.readFileSync(p2, 'utf8'));
  assert.deepEqual(saved.tracked[`robinhood:${WALLET}`], [TOKEN]);
  assert.equal(saved.version, 2);
});

// ── 3. one row per hash ───────────────────────────────────────────────

const HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000002';
const base = { chain: 'robinhood', token: TOKEN, symbol: 'PONS', side: 'buy', hash: HASH, requested: 0.05, decimals: 18, wallet: WALLET, venue: 'pons-curve' };

ok('recordFill is idempotent on the hash: broadcast then receipt is ONE fill', () => {
  ledger._reset();
  ledger.init(freshDir());
  const first = ledger.recordFill({ ...base, feeWei: null });
  const second = ledger.recordFill({ ...base, feeWei: 250_000_000_000_000n });
  const rows = ledger.all().filter((f) => f.hash === HASH);
  assert.equal(rows.length, 1, 'no duplicate row');
  assert.equal(first.id, second.id);
  assert.equal(rows[0].feeWei, '250000000000000', 'the fee learned at the receipt is filled in');
  assert.equal(rows[0].state, 'pending');
});

ok('a different hash is still a new fill', () => {
  ledger.recordFill({ ...base, hash: '0xcccc000000000000000000000000000000000000000000000000000000000003', feeWei: null });
  assert.equal(ledger.all().length, 2);
});

// ── 4. a sell's fee transfer reduces proceeds, not the entry price ────

const ETH = 10n ** 18n;

function reconciled(input, nativeDeltaWei, tokenDeltaRaw) {
  const f = ledger.recordFill(input);
  f.nativeDeltaWei = nativeDeltaWei.toString();
  f.tokenDeltaRaw = tokenDeltaRaw.toString();
  f.gasWei = '0';
  f.state = 'reconciled';
  f.note = null;
  return f;
}

ok('a curve sell’s follow-up fee comes off the proceeds, so avg entry stays the entry price', () => {
  ledger._reset();
  ledger.init(freshDir());
  const buyFee = 5n * 10n ** 15n;   // 0.005 ETH
  const sellFee = 3n * 10n ** 15n;  // 0.003 ETH
  const bought = 1_000_000n * ETH;  // 1,000,000 tokens at 18 decimals

  // Buy 1,000,000 tokens for 1 ETH, then its fee transfer.
  reconciled({ ...base, hash: '0xd1', requested: 1, feeWei: null }, -ETH, bought);
  reconciled({ ...base, hash: '0xd2', requested: 0, feeWei: buyFee }, -buyFee, 0n);
  // Sell half for 0.6 ETH, then ITS fee transfer.
  reconciled({ ...base, hash: '0xd3', side: 'sell', requested: 50, feeWei: null }, 6n * 10n ** 17n, -(bought / 2n));
  reconciled({ ...base, hash: '0xd4', side: 'sell', requested: 0, feeWei: sellFee }, -sellFee, 0n);

  const b = ledger.basisByToken('robinhood', WALLET).get(TOKEN);
  assert.ok(b, 'the token has a basis');
  assert.equal(b.spentWei, ETH + buyFee, 'entry cost = the buy plus the BUY fee only');
  assert.equal(b.receivedWei, 6n * 10n ** 17n - sellFee, 'proceeds = the sale minus the SELL fee');
  assert.equal(b.tokensBought, bought);
  assert.equal(b.tokensSold, bought / 2n);
  assert.equal(b.feeWei, buyFee + sellFee, 'both fees are still reported as fees paid');

  // What the portfolio computes from it.
  const avgEntryWeiPerToken = (b.spentWei * ETH) / b.tokensBought;
  assert.equal(avgEntryWeiPerToken, 1_005_000_000_000n, '1.005e-6 ETH per token, not 1.008e-6');
  const realized = b.receivedWei - (avgEntryWeiPerToken * b.tokensSold) / ETH;
  assert.equal(realized, 94_500_000_000_000_000n, 'realized 0.0945 ETH, not 0.0960');
});

ok('a BUY fee transfer still counts as cost of entry', () => {
  ledger._reset();
  ledger.init(freshDir());
  reconciled({ ...base, hash: '0xe1', requested: 1, feeWei: null }, -ETH, 1_000n * ETH);
  reconciled({ ...base, hash: '0xe2', requested: 0, feeWei: 5n * 10n ** 15n }, -(5n * 10n ** 15n), 0n);
  const b = ledger.basisByToken('robinhood', WALLET).get(TOKEN);
  assert.equal(b.spentWei, ETH + 5n * 10n ** 15n);
  assert.equal(b.receivedWei, 0n);
});

ok('a real sell (tokens leaving) is never mistaken for a fee row', () => {
  ledger._reset();
  ledger.init(freshDir());
  reconciled({ ...base, hash: '0xf1', requested: 1, feeWei: null }, -ETH, 1_000n * ETH);
  reconciled({ ...base, hash: '0xf2', side: 'sell', requested: 100, feeWei: 3n * 10n ** 15n }, 6n * 10n ** 17n, -(1_000n * ETH));
  const b = ledger.basisByToken('robinhood', WALLET).get(TOKEN);
  assert.equal(b.receivedWei, 6n * 10n ** 17n, 'a sell with a fee INSIDE the router call keeps its full proceeds');
  assert.equal(b.tokensSold, 1_000n * ETH);
  assert.equal(b.sells, 1);
});

// ── 5. a fill is priced from state, and state has its own endpoint ────
//
// API swarm, 2026-09-09. On BNB the receipt endpoint is a dataseed, whose
// historical state is geth's 128-block trie — bisected to 110–119 blocks on
// three hosts, ≈50 s at 450 ms blocks — against a 60,000 ms receipt timeout.
// So a fill confirmed near the timeout was priced from state that endpoint had
// already dropped, and a reconcile after a restart had no window at all.
// Balances now go through `stateClient`, pointed at an archival endpoint.
//
// The second half of this section is the honest-null rule: when NO endpoint
// holds the block, a buy can still be priced from the transaction itself
// (value + gas, exact when nothing was refunded) but a sell cannot — its
// `value` is zero, so pricing it that way would record the sale as having
// brought in nothing and cost gas. That is a wrong number, and a wrong number
// is worse than an unknown one. PnL basis is the on-chain delta; unknown
// renders as an em dash, never 0.

const BNB_WALLET = '0x3333333333333333333333333333333333333333';
const BNB_TOKEN = '0x55d398326f99059ff775485246999027b3197955';
const BNB_HASH = '0xdddd000000000000000000000000000000000000000000000000000000000004';
const BLOCK = 120_955_700n;
const GAS_USED = 210_000n;
const GAS_PRICE = 1_000_000_000n;
const hex = (n) => '0x' + n.toString(16);
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

const rpcCalls = [];
/** method -> ({params}) => ({ result }) | ({ error }) */
let handlers = {};

function installRecordingFetch() {
  rpcCalls.length = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let body = init && typeof init.body === 'string' ? init.body : '';
    if (!body && input && typeof input.clone === 'function') body = await input.clone().text();
    const parsed = JSON.parse(body);
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    for (const q of reqs) rpcCalls.push({ host: new URL(url).host, method: q.method, params: q.params });
    const answer = (q) => {
      const h = handlers[q.method];
      const r = h ? h(q) : { error: { code: -32601, message: `no stub for ${q.method}` } };
      return { jsonrpc: '2.0', id: q.id, ...r };
    };
    const out = Array.isArray(parsed) ? reqs.map(answer) : answer(parsed);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function receiptFor({ logs = [] } = {}) {
  return {
    blockHash: '0x' + '11'.repeat(32),
    blockNumber: hex(BLOCK),
    contractAddress: null,
    cumulativeGasUsed: hex(GAS_USED),
    effectiveGasPrice: hex(GAS_PRICE),
    from: BNB_WALLET,
    gasUsed: hex(GAS_USED),
    logs,
    logsBloom: '0x' + '00'.repeat(256),
    status: '0x1',
    to: BNB_TOKEN,
    transactionHash: BNB_HASH,
    transactionIndex: '0x1',
    type: '0x2',
  };
}

const PRUNED = { error: { code: -32000, message: 'missing trie node 0xabc (path ) state 0xdef is not available, not found' } };

const bnbFill = (side, hash) => ({
  chain: 'bnb',
  token: BNB_TOKEN,
  symbol: 'FOUR',
  side,
  hash,
  requested: side === 'buy' ? 0.1 : 100,
  decimals: 18,
  wallet: BNB_WALLET,
  venue: 'fourmeme-curve',
  feeWei: null,
});

async function okAsync(name, fn) {
  try {
    await fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

await okAsync('BNB receipts and fill balances are read from DIFFERENT endpoints', async () => {
  ledger._reset();
  ledger.init(freshDir());
  installRecordingFetch();
  const transfer = {
    address: BNB_TOKEN,
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad('0x' + '00'.repeat(20)), pad(BNB_WALLET)],
    data: hex(1_000n * 10n ** 18n),
    blockNumber: hex(BLOCK),
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: BNB_HASH,
    transactionIndex: '0x1',
    logIndex: '0x0',
    removed: false,
  };
  handlers = {
    eth_getTransactionReceipt: () => ({ result: receiptFor({ logs: [transfer] }) }),
    eth_getBalance: (q) => ({ result: q.params[1] === hex(BLOCK) ? hex(10n ** 18n) : hex(11n * 10n ** 17n) }),
  };
  const f = ledger.recordFill(bnbFill('buy', BNB_HASH));
  await ledger.reconcile(f);

  // Earlier sections left Robinhood fills retrying in the background, so match
  // on this fill's own hash and wallet rather than on the method alone.
  const mine = rpcCalls.filter((c) => JSON.stringify(c.params ?? []).toLowerCase().includes(BNB_HASH.slice(2)) || JSON.stringify(c.params ?? []).toLowerCase().includes(BNB_WALLET.slice(2)));
  const receiptHosts = new Set(mine.filter((c) => c.method === 'eth_getTransactionReceipt').map((c) => c.host));
  const balanceCalls = mine.filter((c) => c.method === 'eth_getBalance');
  const balanceHosts = new Set(balanceCalls.map((c) => c.host));
  assert.deepEqual([...receiptHosts], ['bsc-dataseed.bnbchain.org'], 'receipts come from the dataseed');
  assert.equal(balanceHosts.size, 1, 'balances come from one endpoint');
  assert.ok(!/bnbchain\.org|publicnode\.com/.test([...balanceHosts][0]), `balances must not use a ~50 s state window, got ${[...balanceHosts][0]}`);
  assert.notEqual([...balanceHosts][0], [...receiptHosts][0], 'and not from the receipt endpoint');
  assert.deepEqual(new Set(balanceCalls.map((c) => c.params[1])).size, 2, 'read at bn-1 and bn');

  const row = ledger.all().find((r) => r.hash === BNB_HASH);
  assert.equal(row.state, 'reconciled');
  assert.equal(row.nativeDeltaWei, String(10n ** 18n - 11n * 10n ** 17n), 'the basis is the balance diff, not the requested amount');
  assert.equal(row.tokenDeltaRaw, String(1_000n * 10n ** 18n));
  assert.equal(ledger.statePricingFallbacks(), 0, 'no fallback was needed');
});

await okAsync('a SELL whose block is pruned everywhere is unknown, never zero', async () => {
  ledger._reset();
  ledger.init(freshDir());
  installRecordingFetch();
  const hash = '0xeeee000000000000000000000000000000000000000000000000000000000005';
  handlers = {
    eth_getTransactionReceipt: () => ({ result: { ...receiptFor(), transactionHash: hash } }),
    eth_getBalance: () => PRUNED,
    // Deliberately available: the buy-side fallback COULD price from it, and
    // for a sell it would produce -gas — proceeds of zero and an invented cost.
    eth_getTransactionByHash: () => ({
      result: { blockHash: '0x' + '11'.repeat(32), blockNumber: hex(BLOCK), from: BNB_WALLET, gas: hex(GAS_USED), gasPrice: hex(GAS_PRICE), hash, input: '0x', nonce: '0x1', to: BNB_TOKEN, transactionIndex: '0x1', value: '0x0', type: '0x0', v: '0x1b', r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) },
    }),
  };
  const f = ledger.recordFill({ ...bnbFill('sell', hash), decimals: 18 });
  await ledger.reconcile(f);
  const row = ledger.all().find((r) => r.hash === hash);
  assert.equal(row.state, 'unreconciled', 'a sale that cannot be read is unreconciled');
  assert.equal(row.nativeDeltaWei, null, 'the proceeds are UNKNOWN — not 0, and not minus the gas');
  assert.match(row.note ?? '', /no longer holds state/i, 'and the note says why');
  assert.ok(ledger.statePricingFallbacks() >= 1, 'the fallback is counted so it can be measured');

  // The portfolio must exclude it rather than average over a hole.
  const b = ledger.basisByToken('bnb', BNB_WALLET).get(BNB_TOKEN);
  assert.equal(b.unreconciled, 1);
  assert.equal(b.receivedWei, 0n, 'nothing was booked as proceeds');
  assert.equal(b.spentWei, 0n, 'and nothing was invented as cost');
  assert.equal(b.sells, 0);
});

await okAsync('a BUY whose block is pruned everywhere is still priced from the transaction, and says so', async () => {
  ledger._reset();
  ledger.init(freshDir());
  installRecordingFetch();
  const hash = '0xffff000000000000000000000000000000000000000000000000000000000006';
  const VALUE = 10n ** 17n;
  handlers = {
    eth_getTransactionReceipt: () => ({ result: { ...receiptFor(), transactionHash: hash } }),
    eth_getBalance: () => PRUNED,
    eth_getTransactionByHash: () => ({
      result: { blockHash: '0x' + '11'.repeat(32), blockNumber: hex(BLOCK), from: BNB_WALLET, gas: hex(GAS_USED), gasPrice: hex(GAS_PRICE), hash, input: '0x', nonce: '0x1', to: BNB_TOKEN, transactionIndex: '0x1', value: hex(VALUE), type: '0x0', v: '0x1b', r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) },
    }),
  };
  const f = ledger.recordFill({ ...bnbFill('buy', hash) });
  await ledger.reconcile(f);
  const row = ledger.all().find((r) => r.hash === hash);
  assert.equal(row.state, 'reconciled');
  assert.equal(row.nativeDeltaWei, String(-(VALUE + GAS_USED * GAS_PRICE)), 'value + gas — exact when nothing was refunded');
  assert.match(row.note ?? '', /no longer holds state/i, 'and the reason is named, not "some error"');
});

globalThis.fetch = () => Promise.reject(new Error('offline test — no RPC'));

console.log(`\n${passed} evm ledger cases passed`);
