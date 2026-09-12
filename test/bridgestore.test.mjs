// The in-flight record — the only trace of money that has left a wallet.
//
// Losing it is the worst failure this feature has: the user sees funds gone
// from one side, nothing on the other, and nothing to chase. So it is written
// when the transaction is BROADCAST, not when it confirms — the lesson from
// evm/scanner.ts, fixed the same day, where pendings were written only on
// settle and every restart inside the window lost them.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _reset, all, failure, init, pending, record, update } from './.bridgestore.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridgestore-'));
const row = (over = {}) => ({
  id: 'b1',
  from: 'solana',
  to: 'bnb',
  txHash: '5xy',
  fromAmountRaw: '300000000',
  toAmountMinRaw: '4000000000000000',
  toDecimals: 18,
  tool: 'mayan',
  startedAt: Date.now(),
  status: 'pending',
  deliveredRaw: null,
  note: null,
  ...over,
});

{
  const d = dir();
  _reset();
  init(d);
  record(row());
  assert.equal(pending().length, 1);

  // The restart. Everything in memory is gone; the file is all there is.
  _reset();
  init(d);
  const back = all();
  assert.equal(back.length, 1, 'a transfer in flight survives a restart');
  assert.equal(back[0].txHash, '5xy', 'and the hash — the only safe key to ask status by — comes back');
  assert.equal(back[0].fromAmountRaw, '300000000');
  ok('a transfer in flight survives a restart, with the hash to chase it by');
}

{
  // A restored record does NOT claim to still be pending. Last session's
  // belief is not evidence about now, and "on its way" asserts knowledge this
  // process does not have until it asks the chain.
  assert.equal(all()[0].status, 'unknown');
  assert.equal(pending().length, 1, 'but unknown still counts as in flight, because it is');
  ok('a restored transfer reads as unknown, not as still moving');
}

{
  // A terminal outcome is kept as it was: it was answered, and re-asking
  // would be asking about money that already arrived.
  const d = dir();
  _reset();
  init(d);
  record(row({ id: 'done1', status: 'done', deliveredRaw: '123' }));
  record(row({ id: 'ref1', status: 'refunded' }));
  _reset();
  init(d);
  const byId = Object.fromEntries(all().map((t) => [t.id, t]));
  assert.equal(byId.done1.status, 'done');
  assert.equal(byId.done1.deliveredRaw, '123');
  assert.equal(byId.ref1.status, 'refunded');
  assert.equal(pending().length, 0, 'and neither is still in flight');
  ok('a settled transfer keeps its outcome across a restart');
}

{
  const d = dir();
  _reset();
  init(d);
  record(row({ id: 'u1' }));
  update('u1', { status: 'partial', note: 'delivered a different token' });
  _reset();
  init(d);
  assert.equal(all()[0].status, 'partial');
  assert.match(all()[0].note, /different token/);
  ok('what we learn about a transfer is written down and survives');
}

{
  // Fail closed. An unreadable file is not an empty one — it is the only
  // record of money that has left, so the store refuses every write and keeps
  // the file byte-for-byte.
  const d = dir();
  const f = path.join(d, 'bridge-inflight.json');
  fs.writeFileSync(f, '{ truncated', 'utf8');
  _reset();
  init(d);
  assert.ok(failure(), 'the failure is reported, not swallowed');
  assert.match(failure(), /not valid JSON/i);
  assert.equal(all().length, 0);

  // And a write is REFUSED rather than silently dropped: the caller must know
  // before it broadcasts, because money it cannot write down must not move.
  assert.throws(() => record(row({ id: 'x' })), /read-only/i);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ truncated', 'the damaged file is left alone');
  ok('an unreadable record refuses writes and is never overwritten');
}

{
  // A file that parses but is not ours is the same class of thing.
  const d = dir();
  fs.writeFileSync(path.join(d, 'bridge-inflight.json'), JSON.stringify({ version: 1, somethingElse: [] }), 'utf8');
  _reset();
  init(d);
  assert.ok(failure());
  assert.match(failure(), /this version understands/i);
  ok('a file that parses but is not a bridge record also fails closed');
}

{
  // A malformed row is skipped without taking the others down with it.
  const d = dir();
  fs.writeFileSync(
    path.join(d, 'bridge-inflight.json'),
    JSON.stringify({
      version: 1,
      transfers: [row({ id: 'good' }), { id: 'bad' }, row({ id: 'good2', from: 'mars' }), row({ id: 'good3' })],
    }),
    'utf8',
  );
  _reset();
  init(d);
  const ids = all().map((t) => t.id).sort();
  assert.deepEqual(ids, ['good', 'good3'], 'the readable rows survive; the nonsense ones do not');
  assert.equal(failure(), null, 'and one bad row is not a corrupt file');
  ok('one malformed row is skipped without failing the whole record');
}

{
  // A write that fails leaves NO phantom: the row is not in memory either,
  // so the page cannot show "On its way" for money that never left, and the
  // next successful write cannot put it on disk. Found by audit 2026-09-11.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgestore-'));
  _reset();
  init(d);
  record({ id: 'first', from: 'solana', to: 'robinhood', txHash: 'first', fromAmountRaw: '1', toAmountMinRaw: '1', toDecimals: 18, tool: 't', startedAt: Date.now(), status: 'pending', deliveredRaw: null, note: null });
  assert.equal(pending().length, 1);
  // Make the record file un-writable: a directory where the file goes.
  const file = path.join(d, 'bridge-inflight.json');
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  assert.throws(
    () => record({ id: 'phantom', from: 'solana', to: 'robinhood', txHash: 'phantom', fromAmountRaw: '1', toAmountMinRaw: '1', toDecimals: 18, tool: 't', startedAt: Date.now(), status: 'pending', deliveredRaw: null, note: null }),
    /could not be written/,
  );
  assert.deepEqual(pending().map((t) => t.id), ['first'], 'the phantom is not in memory');
  assert.equal(failure(), null, 'and a failed write is not a corrupt file');
  ok('a record that cannot be written is not kept in memory either');
}

console.log(`\nbridgestore: ${passed}/${passed} passed`);
