// Leader feed frames (leaderFeedFrames.ts): the two subscriptions a followed
// wallet can ride on. Pinned: the exact `logsSubscribe` frame the watcher has
// always sent; the Helius `transactionSubscribe` frame as its docs show it
// (fetched 2026-09-21) with the app's transaction-version constant; the
// unsubscribe names; which refusals mean "not on this plan"; and that a
// pushed transaction parses into the getTransaction shape the decoder reads —
// or into null, never into a guess.

import assert from 'node:assert';
import { FEED_COMMITMENT, isPlanRefusal, parseTransactionNotification, subscribeFrame, unsubscribeFrame } from './.leaderfeedframes.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const W = 'Whae1111111111111111111111111111111111111';

{
  const logs = JSON.parse(subscribeFrame('logs', 7, W));
  assert.deepEqual(logs, { jsonrpc: '2.0', id: 7, method: 'logsSubscribe', params: [{ mentions: [W] }, { commitment: 'confirmed' }] });
  const tx = JSON.parse(subscribeFrame('tx', 8, W));
  assert.equal(tx.method, 'transactionSubscribe');
  assert.deepEqual(tx.params[0], { vote: false, failed: false, accountInclude: [W] }, 'filtered to the wallet, no votes, no failures');
  assert.equal(tx.params[1].commitment, 'confirmed', 'a processed push could describe a transaction that never lands');
  assert.equal(tx.params[1].encoding, 'json', 'the shape the decoder reads');
  assert.equal(tx.params[1].transactionDetails, 'full');
  assert.equal(tx.params[1].maxSupportedTransactionVersion, 1, 'transaction v1 is live; without this the push carries no accounts');
  assert.equal(FEED_COMMITMENT, 'confirmed');
  assert.deepEqual(JSON.parse(unsubscribeFrame('logs', 9, 5)), { jsonrpc: '2.0', id: 9, method: 'logsUnsubscribe', params: [5] });
  assert.deepEqual(JSON.parse(unsubscribeFrame('tx', 10, 6)), { jsonrpc: '2.0', id: 10, method: 'transactionUnsubscribe', params: [6] });
  ok('both subscribe frames and both unsubscribe frames are exactly as the hosts expect');
}

{
  assert.equal(isPlanRefusal('Method not found', -32601), true);
  assert.equal(isPlanRefusal('Method not found'), true);
  assert.equal(isPlanRefusal('transactionSubscribe requires a Developer plan or higher'), true);
  assert.equal(isPlanRefusal('Unauthorized'), true);
  assert.equal(isPlanRefusal('Too many subscriptions'), false, 'a volume refusal is not a plan refusal');
  assert.equal(isPlanRefusal('Internal error'), false);
  ok('a plan or method refusal is told apart from a transient one');
}

{
  const meta = { err: null, fee: 5000, preBalances: [1], postBalances: [1], preTokenBalances: [], postTokenBalances: [] };
  const message = { accountKeys: [W], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] };
  // Helius: result.transaction is the getTransaction shape.
  const wrapped = parseTransactionNotification({
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: { subscription: 4743, result: { signature: 'sig1', slot: 224341380, transaction: { transaction: { message, signatures: ['sig1'] }, meta } } },
  });
  assert.ok(wrapped);
  assert.equal(wrapped.subscription, 4743);
  assert.equal(wrapped.signature, 'sig1');
  assert.equal(wrapped.slot, 224341380);
  assert.ok(wrapped.tx, 'the transaction came with the push');
  assert.deepEqual(wrapped.tx.transaction.message, message);
  assert.deepEqual(wrapped.tx.meta, meta);
  // The message on its own with the meta beside it.
  const flat = parseTransactionNotification({ method: 'transactionNotification', params: { subscription: 1, result: { signature: 'sig2', transaction: { message }, meta } } });
  assert.ok(flat?.tx);
  assert.deepEqual(flat.tx.transaction.message, message);
  assert.deepEqual(flat.tx.meta, meta);
  assert.equal(flat.tx.blockTime, null, 'a push carries no block time — undated, never invented');
  // A shape the decoder does not know is a signature to read back, not a guess.
  const unknown = parseTransactionNotification({ method: 'transactionNotification', params: { subscription: 1, result: { signature: 'sig3', transaction: {} } } });
  assert.ok(unknown);
  assert.equal(unknown.tx, null);
  assert.equal(unknown.signature, 'sig3');
  // Not a transaction notification at all.
  assert.equal(parseTransactionNotification({ method: 'logsNotification', params: { subscription: 1, result: { value: { signature: 'x' } } } }), null);
  assert.equal(parseTransactionNotification({ method: 'transactionNotification', params: { subscription: 'no', result: { signature: 'x' } } }), null);
  assert.equal(parseTransactionNotification(null), null);
  ok('a pushed transaction parses into the decoder’s shape, an unknown shape into a read-back, junk into null');
}

console.log(`\nleaderfeedframes: ${passed}/3 passed`);
