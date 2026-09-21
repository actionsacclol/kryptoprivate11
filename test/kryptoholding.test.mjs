// The $KRYPTO holding read behind the holder rate (electron/engine/kryptoHolding.ts).
//
// shared/krypto.ts pins what a NUMBER does to the fee; this pins how the
// number is made — what one RPC answer becomes, and what a failed one does
// to the answer already in hand. It runs against a JSON-RPC server on
// localhost because `getMultipleAccounts` IS the whole transport, and a stub
// of it would be testing the stub.

import assert from 'node:assert';
import http from 'node:http';
import * as holding from './.kryptoholding.mjs';
import { ataFor, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './.addr2.mjs';
import { KRYPTO_TOKEN } from './.krypto.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// Two real base58 owners (the treasury and the token's creator). Any 32-byte
// key would do; these are pinned elsewhere and will not drift.
const A = 'J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n';
const B = 'Ff4Mw51MqPt6wgcY1TsLFdHp94Cqx9Bris9EapMyvNkm';
const mint = KRYPTO_TOKEN.mint;
assert.ok(mint, 'this suite needs the pinned mint');
const raw = (tokens) => BigInt(tokens) * 10n ** 6n;

/** What the chain holds, keyed by token ACCOUNT (not by owner). */
const balances = new Map();
let mode = 'ok'; // 'ok' | 'rpc-error' | 'http-500'
const requests = [];

function tokenAccount(amount) {
  // SPL token account layout: the u64 amount sits at offset 64.
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { owner: TOKEN_2022_PROGRAM, data: [data.toString('base64'), 'base64'], lamports: 2039280, executable: false, rentEpoch: 0 };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const rpc = JSON.parse(body);
    requests.push(rpc);
    if (mode === 'http-500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (mode === 'rpc-error') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'boom' } }));
      return;
    }
    assert.equal(rpc.method, 'getMultipleAccounts');
    const value = rpc.params[0].map((acc) => (balances.has(acc) ? tokenAccount(balances.get(acc)) : null));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 1 }, value } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

let wallets = [A, B, A]; // A twice: a wallet listed twice must count once
let price = 0.001;
const attach = () => holding.attach({ wallets: () => wallets, httpUrl: () => url, priceUsd: () => price });

try {
  {
    holding._reset();
    const c = holding.current();
    assert.equal(c.at, 0);
    assert.equal(c.problem, null, 'before any read there is no PROBLEM — nothing has failed yet');
    assert.equal(holding.holderRateApplies(), false, 'and nothing is waived');
    assert.equal(holding.usableTokens(), null);
    ok('before the first read: unread, not broken, not waived');
  }

  const ataA = ataFor(A, mint, TOKEN_2022_PROGRAM);
  const ataB = ataFor(B, mint, TOKEN_2022_PROGRAM);

  {
    attach();
    balances.set(ataA, raw(600_000));
    balances.set(ataB, raw(400_000));
    const h = await holding.refresh();
    assert.equal(h.tokens, 1_000_000, '600k in one wallet and 400k in another is a million');
    assert.equal(h.wallets, 2, 'the duplicated wallet counts once');
    assert.equal(h.problem, null);
    assert.ok(h.at > 0);
    assert.ok(Math.abs(h.usd - 1000) < 1e-6, `priced for display (got ${h.usd})`);
    assert.equal(holding.holderRateApplies(), true, 'exactly the threshold, across two wallets, waives');
    // What was asked for: the Token-2022 ATA of each distinct owner, in one
    // request. $KRYPTO is a Token-2022 mint; the classic-program ATA is a
    // real-looking address that never holds it, and would read as "none".
    const asked = requests.at(-1).params[0];
    assert.deepEqual(asked, [ataA, ataB], 'one request, one Token-2022 ATA per distinct wallet');
    assert.notEqual(ataA, ataFor(A, mint, TOKEN_PROGRAM), 'and it is NOT the classic-program ATA');
    ok('one getMultipleAccounts over Token-2022 ATAs sums the holding across wallets');
  }

  {
    const before = requests.length;
    await Promise.all([holding.refresh(), holding.refresh(), holding.refresh()]);
    assert.equal(requests.length - before, 1, 'three overlapping refreshes share one request');
    ok('overlapping refreshes share one request');
  }

  {
    // The rule that matters: a failed read keeps the last number but stops
    // it counting. Both halves — the card still shows what was held, and
    // the signer charges — or breaking one read would be free trading.
    mode = 'rpc-error';
    const h = await holding.refresh();
    assert.equal(h.tokens, 1_000_000, 'the previous reading stays in place');
    assert.match(h.problem ?? '', /balance unreadable/, 'with the failure named');
    assert.match(h.problem ?? '', /boom/);
    assert.equal(holding.holderRateApplies(), false, 'and it no longer waives');
    assert.equal(holding.usableTokens(), null);
    mode = 'http-500';
    const h2 = await holding.refresh();
    assert.match(h2.problem ?? '', /balance unreadable/);
    assert.equal(holding.holderRateApplies(), false);
    mode = 'ok';
    const h3 = await holding.refresh();
    assert.equal(h3.problem, null, 'the next good read clears the problem');
    assert.equal(holding.holderRateApplies(), true);
    ok('a failed read keeps the last number, names the failure, and stops waiving until a read works');
  }

  {
    // Stale: ten minutes without a successful read and the app no longer
    // knows enough to give anything away.
    const now = Date.now();
    const good = holding.current();
    holding._set({ ...good, at: now - 9 * 60_000 });
    assert.equal(holding.usableTokens(now), 1_000_000, 'nine minutes old still counts');
    holding._set({ ...good, at: now - 10 * 60_000 - 1 });
    assert.equal(holding.usableTokens(now), null, 'past ten minutes it does not');
    assert.equal(holding.holderRateApplies(), false);
    holding._set(good);
    ok('a reading older than ten minutes stops waiving');
  }

  {
    // A wallet with no token account is a real zero, not a failure.
    balances.delete(ataB);
    const h = await holding.refresh();
    assert.equal(h.tokens, 600_000);
    assert.equal(h.problem, null, 'a missing account is "holds none", not "could not read"');
    assert.equal(holding.holderRateApplies(), false, '600k is under');
    balances.set(ataB, raw(400_000));
    ok('an absent token account is a zero, not an error');
  }

  {
    // The read is exact to the raw unit, and one unit under is under.
    balances.set(ataB, raw(400_000) - 1n);
    const h = await holding.refresh();
    assert.ok(h.tokens < 1_000_000 && h.tokens > 999_999.99, `999,999.999999 read as ${h.tokens}`);
    assert.equal(holding.holderRateApplies(), false, 'one raw unit under the threshold does not waive');
    balances.set(ataB, raw(400_000));
    ok('one raw unit under the threshold is under');
  }

  {
    // The price is display only: a token nobody can price still waives.
    price = null;
    const h = await holding.refresh();
    assert.equal(h.usd, null);
    assert.equal(holding.holderRateApplies(), true, 'no price, still waived — the threshold is a token count');
    price = 0.001;
    ok('an unpriceable token still waives; usd is display only');
  }

  {
    // No wallets: a real, readable zero, and no request is made for it.
    wallets = [];
    const before = requests.length;
    const h = await holding.refresh();
    assert.equal(requests.length, before, 'nothing to ask about');
    assert.equal(h.wallets, 0);
    assert.equal(h.tokens, 0);
    assert.equal(h.problem, null);
    assert.ok(h.at > 0);
    assert.equal(holding.holderRateApplies(), false);
    wallets = [A, B];
    ok('no wallets is a readable zero, not an unknown');
  }

  {
    // A FIRST read that fails must say so. It used to leave the initial
    // "not read yet" in place, so the card said "not checked yet" for a
    // check that had run and broken — and went on saying it until one
    // worked, with no hint to the user that anything was wrong.
    holding._reset();
    attach();
    mode = 'rpc-error';
    const h = await holding.refresh();
    assert.equal(h.at, 0, 'no successful read has landed');
    assert.match(h.problem ?? '', /balance unreadable/, 'but the failure is reported, not "not read yet"');
    assert.equal(holding.holderRateApplies(), false);
    mode = 'ok';
    ok('a failed first read reports its failure rather than "not read yet"');
  }

  {
    // Nothing attached: a stated problem, never a waiver.
    holding._reset();
    const h = await holding.refresh();
    assert.equal(h.problem, 'no token to check');
    assert.equal(holding.holderRateApplies(), false);
    ok('with nothing attached the holding is a stated problem, not a waiver');
  }
} finally {
  holding._reset();
  server.closeAllConnections();
  server.close();
}

console.log(`\nkryptoholding: ${passed}/${passed} passed`);
