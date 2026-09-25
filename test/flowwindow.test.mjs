// Launch flow figures a script reads (Don, 2026-09-24). buyerAcceleration is
// an evaluation-window ratio that settles when the window closes; the counts
// are since detection and never summed from the trimmed rolling list.

import assert from 'node:assert';
import fs from 'node:fs';
import { buyerAcceleration } from './.flowwindow.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const T0 = 1_000_000;
const DEADLINE = T0 + 15_000;
const buy = (s, user) => ({ at: T0 + s * 1000, user });

{
  // 0–7.5 s: a, b (a twice). 7.5–15 s: a, c, d.
  const buys = [buy(1, 'a'), buy(2, 'a'), buy(3, 'b'), buy(8, 'a'), buy(9, 'c'), buy(14, 'd')];
  assert.strictEqual(buyerAcceleration(buys, T0, DEADLINE, DEADLINE), 3 / 2);
  ok('distinct wallets per half; a wallet in both halves counts in each');
}

{
  const buys = [buy(1, 'a'), buy(3, 'b'), buy(8, 'c'), buy(9, 'd')];
  const atClose = buyerAcceleration(buys, T0, DEADLINE, DEADLINE);
  // A kept coin: an hour later, with post-window buyers the engine never
  // queues — and even if one slipped in, it must not count.
  const late = [...buys, buy(40, 'e'), buy(900, 'f')];
  assert.strictEqual(buyerAcceleration(late, T0, DEADLINE, DEADLINE + 3_600_000), atClose);
  ok('the ratio is fixed once the window closes, however long the coin is tracked');
}

{
  // Before the window closes the split is the middle of what has elapsed.
  const buys = [buy(1, 'a'), buy(3, 'b')];
  assert.strictEqual(buyerAcceleration(buys, T0, DEADLINE, T0 + 4_000), 1);
  assert.strictEqual(buyerAcceleration([buy(9, 'a')], T0, DEADLINE, DEADLINE), 2);
  assert.strictEqual(buyerAcceleration([], T0, DEADLINE, DEADLINE), 0);
  ok('the moving split before the close, 2 for an empty first half, 0 for none');
}

{
  const src = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  const start = src.indexOf('  private refreshFlow(t: TrackedToken): void {');
  assert.ok(start > 0, 'refreshFlow is where it was');
  const body = src.slice(start, src.indexOf('  private maybeDecide(', start));
  assert.ok(!/t\.trades|for \(const tr of trades\)/.test(body), 'the flow never reads the trimmed rolling list');
  assert.ok(/flow\.buys = t\.totals\.buys;/.test(body) && /flow\.distinctSellers = t\.sellers\.size;/.test(body), 'counts come from the since-detection totals');
  assert.ok(/buyerAcceleration\(t\.evalBuys, windowStart, t\.evalDeadline, now\)/.test(body), 'acceleration comes from the window-only buys');
  assert.ok(/if \(n\.receivedAt <= t\.evalDeadline\) t\.evalBuys\.push/.test(src), 'only buys inside the window are queued');
  ok('the engine feeds the flow from counters, not the trimmed trade list');
}

{
  const ref = fs.readFileSync(new URL('../shared/automation.ts', import.meta.url), 'utf8');
  const hint = (id) => new RegExp(`id: '${id}'[^\\n]*?hint: '([^']*)'`).exec(ref)?.[1] ?? '';
  assert.ok(/since the launch was detected/.test(hint('uniqueBuyers')) && /not merged/.test(hint('uniqueBuyers')), 'uniqueBuyers says it is raw addresses since detection');
  assert.ok(/evaluation window/.test(hint('buyerAcceleration')) && /Fixed once the window closes/.test(hint('buyerAcceleration')), 'buyerAcceleration names its window');
  ok('the script reference says what the numbers count');
}

console.log(`\nflowwindow: ${passed}/${passed} passed`);
