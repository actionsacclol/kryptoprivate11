// Helius credit budget tests.
//
// This guard exists because an estimate in a comment was wrong by twenty
// times: it put the pump firehose at 33k pushes/hour when the measured rate
// on 2026-08-24 was 780,000. That made an expensive switch look affordable.
//
// So the numbers here are counted, and the failure mode being prevented is
// specific: the app quietly spending a month's allowance in an afternoon.

import assert from 'node:assert';
import {
  FEED_BYTES_PER_CREDIT,
  MEASURED_FIREHOSE_PER_HOUR,
  WINDOW_MS,
  feedCreditsForBytes,
  emptyUsage,
  firehoseHoursFor,
  hoursRemaining,
  overBudget,
  record,
  rollWindow,
  usedPct,
  windowExpired,
} from './.credits.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const NOW = 1_700_000_000_000;
const u = (over = {}) => ({ ...emptyUsage(NOW), limit: 1_000_000, ...over });

test('a fresh budget is empty and under', () => {
  const x = u();
  assert.equal(x.used, 0);
  assert.equal(overBudget(x), false);
});

test('websocket pushes and http calls are counted separately but billed together', () => {
  let x = u();
  x = record(x, 'ws', 100);
  x = record(x, 'http', 5);
  assert.equal(x.wsEvents, 100);
  assert.equal(x.httpCalls, 5);
  assert.equal(x.used, 105, 'the ceiling applies to the total');
});

test('a zero or negative count changes nothing', () => {
  let x = u();
  x = record(x, 'ws', 0);
  x = record(x, 'ws', -50);
  assert.equal(x.used, 0);
});

test('the budget trips exactly at the limit', () => {
  assert.equal(overBudget(u({ used: 999_999 })), false);
  assert.equal(overBudget(u({ used: 1_000_000 })), true);
  assert.equal(overBudget(u({ used: 2_000_000 })), true);
});

test('a limit of 0 means NO guard, not an instant cut-off', () => {
  // Someone on a plan that can take the firehose must not be throttled by a
  // default. Zero has to mean unlimited, and it must not read as "0 allowed".
  assert.equal(overBudget(u({ limit: 0, used: 50_000_000 })), false);
  assert.equal(usedPct(u({ limit: 0, used: 5 })), null);
});

test('the window rolls over after 30 days, keeping the limit', () => {
  const x = u({ used: 900_000 });
  assert.equal(windowExpired(x, NOW + WINDOW_MS - 1), false);
  const rolled = rollWindow(x, NOW + WINDOW_MS + 1);
  assert.equal(rolled.used, 0, 'a new window starts empty');
  assert.equal(rolled.limit, 1_000_000, 'but the ceiling carries over');
  assert.equal(rolled.wsEvents, 0);
});

test('an unexpired window is returned unchanged', () => {
  const x = u({ used: 10 });
  assert.equal(rollWindow(x, NOW + 1000), x);
});

test('remaining hours are extrapolated from the real rate', () => {
  // Half the budget spent in one hour leaves about one hour.
  const x = u({ used: 500_000 });
  const hrs = hoursRemaining(x, NOW + 3_600_000);
  assert.ok(hrs !== null && Math.abs(hrs - 1) < 0.05, `got ${hrs}`);
});

test('no estimate is offered from too small a sample', () => {
  // A projection off two seconds of data is confident nonsense.
  assert.equal(hoursRemaining(u({ used: 5 }), NOW + 2_000), null);
  assert.equal(hoursRemaining(u({ used: 0 }), NOW + 3_600_000), null);
  assert.equal(hoursRemaining(u({ limit: 0, used: 100 }), NOW + 3_600_000), null);
});

test('websocket traffic is billed by the byte: 2 credits per 0.1 MB', () => {
  // Helius meters websocket pushes by uncompressed bytes, not per push. The
  // earlier accounting charged a credit per push and overstated the
  // firehose 37x — and would have cut the socket off after ~1.3 hours of a
  // budget that actually lasts two days.
  assert.equal(FEED_BYTES_PER_CREDIT, 51_200, '0.1 MB = 102,400 bytes buys 2 credits');
  assert.equal(feedCreditsForBytes(102_400), 2);
  assert.equal(feedCreditsForBytes(51_200), 1);
  assert.ok(Math.abs(feedCreditsForBytes(1_400) - 0.0273) < 0.001, 'a ~1.4 KB pump push is ~0.03 credits');
  assert.equal(feedCreditsForBytes(0), 0);
  assert.equal(feedCreditsForBytes(-5), 0);
});

test('the measured firehose rate is what a budget is judged against', () => {
  // 780k pushes/h × ~1.4 KB ÷ 51,200 B/credit ≈ 21k credits/h: 1M credits
  // is about 48 hours of firehose — still a non-starter for a month, but
  // not the 1.3 hours the per-push arithmetic claimed.
  assert.equal(MEASURED_FIREHOSE_PER_HOUR, 21_000);
  const hours = firehoseHoursFor(1_000_000);
  assert.ok(Math.abs(hours - 47.6) < 0.1, `got ${hours}`);
  assert.equal(firehoseHoursFor(0), 0);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`credits: ${passed}/${cases.length} tests passed`);
}

await run();
