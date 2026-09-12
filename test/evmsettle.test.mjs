// What the Robinhood scanner RECORDS, driven through its real path:
// poll → ingest → closeWindows → settle, with only the RPC replaced.
//
// The runner model is a tally of outcomes, and a tally is only worth reading
// if a negative means "watched for six hours, did not graduate". Four ways
// it was recording negatives that meant something else, all found by the
// 2026-09-11 audit, are pinned here:
//
//   1. A graduation after the 130 s tracking window never reached the
//      pending entry, so every live launch that graduated later than that
//      settled as a failure. The 6 h horizon was a fiction.
//   2. A graduation INSIDE the first minute was forgotten when the 60 s
//      window entered the launch as `graduated: false`.
//   3. Restored launches past the per-round ask cap (150) were settled as
//      failures without being asked — an overnight restart would have
//      written ~2,800 of them in one poll.
//   4. A restored token the factory does not know was kept and tallied as a
//      failure, against a comment saying "nothing to record".
//
// And one about cost: settles overlapped, asking the same tokens again from
// every poll while the first was still waiting on the chain.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _poll, _pending, _reset, attach, initModels, modelOf, launches, status, stop } from './.evmscanner.stubbed.mjs';
import { script } from './stubs/evm/pons.mjs';
import { script as fourmeme } from './stubs/evm/fourmeme.mjs';
import { head } from './stubs/evm/market.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// A clock the test owns. The scanner stamps seenAt / age from Date.now().
let T = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => T;
const HOUR = 3_600_000;

const host = { enabled: () => true, emit: () => {}, log: () => {}, runnerAlerts: undefined, notify: undefined };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-evmsettle-'));

function fresh() {
  _reset();
  script.reset();
  head.n = 1000n;
  attach(host);
  // A model file is what makes persistence live; an empty one is fine.
  fs.rmSync(path.join(dir, 'evm-runners.json'), { force: true });
  initModels(dir);
}

/** One launch with `buyers` distinct first-minute buyers, at the next block. */
function launch(token, buyers) {
  head.n += 1n;
  script.launches = [{ token, curve: `${token}crv`, deployer: '0xdep', blockNumber: head.n }];
  script.trades = Array.from({ length: buyers }, (_, i) => ({
    curve: `${token}crv`,
    trader: `0xb${i}`,
    isBuy: true,
    quoteWei: 10n ** 16n,
    tokensRaw: 1n,
    feeWei: 0n,
    taxWei: 0n,
    blockNumber: head.n,
    txHash: '0x',
  }));
}

function graduate(token) {
  head.n += 1n;
  script.graduations = [{ token, blockNumber: head.n, sweptQuote: 10n ** 18n, txHash: '0xg' }];
}

async function tick(ms) {
  T += ms;
  head.n += 1n;
  await _poll('robinhood');
}

const tally = (bucket) => modelOf('robinhood').tallies.find((t) => t.bucket === bucket);

// ── 1. a graduation after the tracking window still counts ─────────────
{
  fresh();
  await _poll('robinhood'); // cursor = head
  launch('0xtok1', 25);
  await tick(1_000);
  assert.equal(status('robinhood').launchesSeen, 1);
  await tick(61_000); // the 60 s window closes: entered as pending
  assert.equal(_pending('robinhood').length, 1);
  await tick(70_000); // past 130 s: no longer tracked
  assert.equal(status('robinhood').tracking, 0, 'the launch has left the tracking set');
  graduate('0xtok1');
  await tick(8 * 60_000); // the event arrives at ~10 min
  // A graduated launch has its outcome, so it settles on the same poll.
  assert.equal(status('robinhood').graduationsSeen, 1, 'the event was counted');
  assert.notEqual(launches('robinhood')[0].graduatedAt, null, 'the row on the page knows');
  assert.equal(_pending('robinhood').length, 0, 'and the launch settled at once');
  assert.deepEqual([tally(21).settled, tally(21).graduated], [1, 1], 'as a graduation, not a failure');
  await tick(6 * HOUR);
  assert.deepEqual([tally(21).settled, tally(21).graduated], [1, 1], 'and is not counted twice at the horizon');
  ok('a graduation after the 130 s tracking window reaches the pending launch and is tallied');
}

// ── 1b. and the same event inside the window still counts (no regression)
{
  fresh();
  await _poll('robinhood');
  launch('0xtok2', 25);
  await tick(1_000);
  await tick(61_000);
  graduate('0xtok2');
  await tick(30_000); // age ~92 s, still tracked
  assert.equal(status('robinhood').graduationsSeen, 1);
  assert.deepEqual([tally(21).settled, tally(21).graduated], [1, 1]);
  await tick(6 * HOUR);
  assert.deepEqual([tally(21).settled, tally(21).graduated], [1, 1]);
  ok('a graduation inside the tracking window is tallied as before');
}

// ── 2. a graduation inside the first minute is not forgotten at 60 s ────
{
  fresh();
  await _poll('robinhood');
  launch('0xtok3', 25);
  await tick(1_000);
  graduate('0xtok3');
  await tick(20_000); // graduated at ~21 s, before the 60 s window closes
  assert.equal(launches('robinhood')[0].graduatedAt, T, 'the row knows');
  assert.equal(_pending('robinhood').length, 0, 'not yet entered — the 60 s window is still open');
  await tick(45_000); // 60 s window closes now: entered already graduated, and so settled at once
  assert.equal(_pending('robinhood').length, 0);
  assert.deepEqual([tally(21).settled, tally(21).graduated], [1, 1], 'entered as graduated and settled as one');
  ok('a launch that graduates inside its first minute is entered as graduated, not reset to false');
}

// ── restarts: a model file with restored pendings, and nothing else ─────
const emptyTallies = (chain) => ({
  chain,
  tallies: [0, 1, 3, 6, 11, 21].map((b) => ({ bucket: b, settled: 0, graduated: 0 })),
  totalSettled: 0,
  totalGraduated: 0,
});
function restoreWith(pend, chain = 'robinhood') {
  _reset();
  script.reset();
  fourmeme.reset();
  head.n = 1000n;
  attach(host);
  fs.writeFileSync(
    path.join(dir, 'evm-runners.json'),
    JSON.stringify({
      version: 1,
      chains: { robinhood: emptyTallies('robinhood'), bnb: emptyTallies('bnb') },
      pending: { robinhood: chain === 'robinhood' ? pend : [], bnb: chain === 'bnb' ? pend : [] },
    }),
  );
  initModels(dir);
}
async function bnbPoll() {
  T += 6_000;
  head.n += 1n;
  await _poll('bnb');
}
const due = (n, prefix) => Array.from({ length: n }, (_, i) => ({ token: `0x${prefix}${String(i).padStart(4, '0')}`, bucket: 21, seenAt: T - 7 * HOUR, graduated: false }));

// ── 3. restored launches past the ask cap wait; they are not failed ─────
{
  restoreWith(due(200, 'r'));
  script.recordPhase = 1; // the chain says: every one of these graduated
  assert.equal(_pending('robinhood').length, 200);
  assert.ok(_pending('robinhood').every((p) => p.restored), 'every one is marked restored');
  await _poll('robinhood');
  assert.equal(script.recordCalls.length, 150, 'one round asks the chain about 150');
  const m1 = modelOf('robinhood');
  assert.deepEqual([m1.totalSettled, m1.totalGraduated], [150, 150], 'the 150 that were asked settle as the chain said');
  assert.equal(_pending('robinhood').length, 50, 'the other 50 are still pending — not failed, not asked yet');
  await tick(5_000);
  assert.equal(script.recordCalls.length, 200, 'the next round asks the rest');
  const m2 = modelOf('robinhood');
  assert.deepEqual([m2.totalSettled, m2.totalGraduated], [200, 200], 'and every one of the 200 settled as a graduation');
  assert.equal(_pending('robinhood').length, 0);
  ok('restored launches past the per-round cap wait for their turn instead of settling as failures');
}

// ── 4. a restored token the factory does not know leaves, untallied ─────
{
  restoreWith(due(1, 'ghost'));
  script.recordPhase = null;
  assert.equal(_pending('robinhood').length, 1);
  await _poll('robinhood');
  assert.equal(_pending('robinhood').length, 0, 'gone');
  assert.equal(modelOf('robinhood').totalSettled, 0, 'and not counted as anything');
  ok('a restored token the factory has no record of is dropped, never tallied as a failure');
}

// ── 4b. an unreadable chain leaves it pending, asked again next time ────
{
  restoreWith(due(1, 'wait'));
  script.recordThrow = true;
  await _poll('robinhood');
  assert.equal(_pending('robinhood').length, 1, 'still pending');
  assert.equal(modelOf('robinhood').totalSettled, 0);
  script.recordThrow = false;
  script.recordPhase = 0;
  await tick(5_000);
  assert.equal(_pending('robinhood').length, 0);
  assert.deepEqual([modelOf('robinhood').totalSettled, modelOf('robinhood').totalGraduated], [1, 0], 'phase 0 past the horizon is a real negative');
  ok('an unreadable chain is not a failure — the launch waits and is asked again');
}

// ── 5. settles do not overlap ───────────────────────────────────────────
{
  restoreWith(due(150, 'o'));
  script.recordDelayMs = 5;
  const first = _poll('robinhood');
  await new Promise((r) => setTimeout(r, 20)); // the first poll is done; its settle is mid-flight
  head.n += 1n;
  const second = _poll('robinhood');
  await Promise.all([first, second]);
  assert.equal(script.recordCalls.length, 150, `asked once each, not ${script.recordCalls.length}`);
  assert.equal(modelOf('robinhood').totalSettled, 150);
  ok('a poll that lands while a settle is in flight joins it rather than asking the chain again');
}

// ── 6. BNB: a negative is recorded only for a launch four.meme answered ──
//
// The BNB branch has no event feed at all; every outcome is an `infos`
// answer. The same cap-without-a-settle-guard bug applied here, and the
// Robinhood cases above did not exercise this branch (the auditor's point).
{
  const bnbTally = () => modelOf('bnb');
  restoreWith(due(200, 'b'), 'bnb');
  fourmeme.liquidityAdded = false;
  await _poll('bnb');
  assert.deepEqual(fourmeme.calls, [150], 'one round asks about 150, in one multicall');
  assert.deepEqual([bnbTally().totalSettled, bnbTally().totalGraduated], [150, 0], 'the 150 answered settle as the chain said');
  assert.equal(_pending('bnb').length, 50, 'the other 50 wait — not failed');
  await tick(5_000);
  await _poll('bnb');
  assert.deepEqual(fourmeme.calls, [150, 50]);
  assert.deepEqual([bnbTally().totalSettled, bnbTally().totalGraduated], [200, 0]);
  ok('BNB: launches past the per-round cap wait to be asked instead of settling as failures');

  restoreWith(due(120, 'g'), 'bnb');
  fourmeme.liquidityAdded = true;
  await _poll('bnb');
  assert.deepEqual([bnbTally().totalSettled, bnbTally().totalGraduated], [120, 120], 'liquidityAdded is a graduation');
  ok('BNB: an answered graduation is tallied as one');

  restoreWith(due(30, 'u'), 'bnb');
  fourmeme.answer = false;
  await _poll('bnb');
  assert.deepEqual(fourmeme.calls, [30]);
  assert.equal(_pending('bnb').length, 30, 'nothing settled');
  assert.equal(bnbTally().totalSettled, 0);
  fourmeme.answer = true;
  await tick(5_000);
  await _poll('bnb');
  assert.equal(_pending('bnb').length, 0);
  assert.deepEqual([bnbTally().totalSettled, bnbTally().totalGraduated], [30, 0]);
  ok('BNB: a launch the helper could not answer for stays pending and is asked again');
}

// ── 7. BNB: a curve quoted in something other than BNB has no BNB number ─
//
// four.meme lets the creator pick the quote asset; on 2026-09-11 only 22 %
// of live launches were BNB-quoted, and the rest were being summed as BNB.
{
  const bnbLaunch = (token, buyers) => {
    head.n += 1n;
    fourmeme.launches = [{ token, creator: '0xdep', name: 'N', symbol: 'SYM', totalSupply: 0n, launchTime: 0n, blockNumber: head.n, txHash: '0x' }];
    fourmeme.trades = Array.from({ length: buyers }, (_, i) => ({
      token,
      isBuy: true,
      trader: `0xb${i}`,
      quoteWei: 10n ** 18n, // "1" of whatever the quote is
      tokensRaw: 1n,
      feeWei: 0n,
      offers: 0n,
      funds: 0n,
      blockNumber: head.n,
      txHash: '0x',
      logIndex: i,
    }));
  };
  const bnbTick = async (ms) => {
    T += ms;
    head.n += 1n;
    await _poll('bnb');
  };

  restoreWith([], 'bnb');
  fourmeme.quote = '0x55d398326f99059ff775485246999027b3197955'; // USDT
  await _poll('bnb');
  bnbLaunch('0xusdtcurve', 7);
  await bnbTick(1_000);
  await bnbTick(61_000);
  const l = launches('bnb')[0];
  assert.equal(l.quote, 'other', 'the launch knows it is not BNB-quoted');
  const w = l.windows.find((x) => x.windowS === 60);
  assert.equal(w.buys, 7, 'buys are counted on any curve');
  assert.equal(w.uniqueBuyers, 7);
  assert.equal(w.netNative, null, 'but there is no BNB number for a USDT curve');
  assert.equal(w.volumeNative, null);
  ok('BNB: a launch quoted in another asset counts its buys and shows no BNB figure');

  restoreWith([], 'bnb');
  await _poll('bnb');
  bnbLaunch('0xbnbcurve', 3);
  await bnbTick(1_000);
  await bnbTick(61_000);
  const lb = launches('bnb')[0];
  assert.equal(lb.quote, 'native');
  const wb = lb.windows.find((x) => x.windowS === 60);
  assert.ok(Math.abs(wb.netNative - 3) < 1e-9, 'a BNB-quoted curve sums its BNB');
  ok('BNB: a BNB-quoted launch still has its money column');
}

// ── 8. BNB: a graduation learned at settle reaches the page and the count ─
{
  restoreWith(due(1, 'grad'), 'bnb');
  fourmeme.liquidityAdded = true;
  assert.equal(status('bnb').graduationsSeen, 0);
  await _poll('bnb');
  assert.equal(status('bnb').graduationsSeen, 1, 'counted');
  assert.deepEqual([modelOf('bnb').totalSettled, modelOf('bnb').totalGraduated], [1, 1]);
  ok('BNB: a graduation found at settle is counted where the page reads it');
}

// ── 9. BNB: a token the helper never answers for is dropped, not re-asked forever ─
{
  restoreWith(due(1, 'ghost'), 'bnb');
  fourmeme.answer = false;
  for (let i = 0; i < 29; i++) await bnbPoll();
  assert.equal(_pending('bnb').length, 1, 'still asked after 29 rounds');
  await bnbPoll();
  assert.equal(_pending('bnb').length, 0, 'dropped on the 30th');
  assert.equal(modelOf('bnb').totalSettled, 0, 'and never counted');
  ok('BNB: a launch the helper never answers for is dropped after 30 rounds, uncounted');
}

stop('robinhood');
stop('bnb');
Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nevmsettle: ${passed}/${passed} passed`);
