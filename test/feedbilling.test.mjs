// The credit counter bills socket BYTES (2 credits / 0.1 MB), not pushes.
//
// Pinned because the budget is what turns the Helius socket off: a counter
// that over-bills cuts a working feed at the wrong hour, one that under-bills
// lets an overage through. Fractions must carry across ticks — a socket
// delivering 1.4 KB frames once a second would otherwise never be billed.
// feedmeter.test.mjs drives the same counter from real sockets.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as budget from './.heliusbudget.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-credits-'));
budget.init(dir, 1_000);
budget.reset();

const bill = (stream, bytes) => {
  budget.addSocketBytes(stream, bytes);
  budget.settleSockets();
};

// Nothing arrives, nothing is billed.
budget.settleSockets();
assert.equal(budget.current().used, 0);

// 0.1 MB on Helius = 2 credits.
bill('Launch feed', 102_400);
assert.equal(budget.current().used, 2);
assert.equal(budget.current().wsEvents, 2, 'the ws counter carries credits, not pushes');

// Bytes are billed once.
budget.settleSockets();
assert.equal(budget.current().used, 2);

// Fractions accumulate: 20 ticks × 2,560 B = 51,200 B = exactly one credit.
for (let i = 1; i <= 20; i++) bill('Launch feed', 2_560);
assert.equal(budget.current().used, 3, 'twenty sub-credit ticks add up to one credit, not zero');

// Each stream is billed under its own name.
bill('Token tape', 512_000);
assert.equal(budget.current().used, 13);
assert.equal(budget.current().breakdown.sockets['Token tape'], 10);
assert.equal(budget.current().breakdown.sockets['Launch feed'], 3);

// HTTP bills one credit per call element.
budget.billHttp(10, 'getTransaction');
assert.equal(budget.current().used, 23);
assert.equal(budget.current().httpCalls, 10);
assert.equal(budget.current().breakdown.methods.getTransaction, 10);

// Saving includes what the last second's frames have not settled yet.
budget.addSocketBytes('AMM tape', 51_200);
budget.persist();
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'helius-credits.json'), 'utf8')).used, 24);

// Cut-off trips once at the limit.
bill('AMM tape', 51_200 * 1_000);
assert.equal(budget.shouldCutOff(), true);
assert.equal(budget.shouldCutOff(), false, 'announced once');

budget.reset();
assert.equal(budget.current().used, 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log('feedbilling: all tests passed');
process.exit(0);
