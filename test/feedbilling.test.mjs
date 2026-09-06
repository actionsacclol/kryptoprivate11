// heliusBudget.billFeed bills BYTES (2 credits / 0.1 MB), not pushes.
//
// Pinned because the budget is what turns the Helius socket off: a counter
// that over-bills cuts a working feed at the wrong hour, one that under-bills
// lets an overage through. Fractions must carry across ticks — a socket
// delivering 1.4 KB frames once a second would otherwise never be billed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as budget from './.heliusbudget.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-credits-'));
budget.init(dir, 1_000);
budget.reset();

const HELIUS = 'wss://mainnet.helius-rpc.com/?api-key=***';
const FREE = 'wss://solana-rpc.publicnode.com';

// Free sockets are never billed, whatever they deliver.
budget.billFeed([{ url: FREE, bytes: 50_000_000 }]);
assert.equal(budget.current().used, 0, 'free endpoints cost nothing');

// 0.1 MB on Helius = 2 credits.
budget.billFeed([{ url: HELIUS, bytes: 102_400 }]);
assert.equal(budget.current().used, 2);
assert.equal(budget.current().wsEvents, 2, 'the ws counter carries credits, not pushes');

// Deltas, not totals: the socket's counter is cumulative.
budget.billFeed([{ url: HELIUS, bytes: 102_400 + 51_200 }]);
assert.equal(budget.current().used, 3);

// Fractions accumulate: 20 ticks × 2,560 B = 51,200 B = exactly one credit.
for (let i = 1; i <= 20; i++) budget.billFeed([{ url: HELIUS, bytes: 153_600 + i * 2_560 }]);
assert.equal(budget.current().used, 4, 'twenty sub-credit ticks add up to one credit, not zero');

// A reconnect resets the socket's counter: bill the fresh total, not a negative.
budget.billFeed([{ url: HELIUS, bytes: 51_200 }]);
assert.equal(budget.current().used, 5);

// The priority feed is billed the same way under its own tag.
budget.billFeed([{ url: 'helius:priority', bytes: 512_000 }]);
assert.equal(budget.current().used, 15);

// HTTP fills bill one credit per call element.
budget.billHttp(10);
assert.equal(budget.current().used, 25);
assert.equal(budget.current().httpCalls, 10);

// Cut-off trips once at the limit.
budget.billFeed([{ url: HELIUS, bytes: 51_200 * 1_000 }]);
assert.equal(budget.shouldCutOff(), true);
assert.equal(budget.shouldCutOff(), false, 'announced once');

budget.reset();
assert.equal(budget.current().used, 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log('feedbilling: all tests passed');
