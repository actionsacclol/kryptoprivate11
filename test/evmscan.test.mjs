// The per-chain Observatory: three of them, and they never mix.
//
// Two properties are pinned here because they are the ones a user would be
// misled by:
//
//   1. ISOLATION — Robinhood and BNB keep separate counts, separate cursors
//      and separate launch lists. A number under a BNB heading is a BNB
//      number or it is nothing.
//   2. HONEST NULLS — a window that has not closed, a head block never read,
//      a chain never started: all of those are null, not 0. On a scanner page
//      "no buys" and "we have not finished counting" look identical if the
//      second one renders as a zero.

import assert from 'node:assert';
import { emptyScanStatus } from './.evmscanshared.mjs';
import { _addPending, _pending, _reset, initModels, modelOf, persistModels } from './.evmscanner.mjs';
import { _measure } from './.evmscanner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  const rh = emptyScanStatus('robinhood');
  const bnb = emptyScanStatus('bnb');
  assert.equal(rh.chain, 'robinhood');
  assert.equal(bnb.chain, 'bnb');
  assert.notStrictEqual(rh, bnb, 'two chains never share a status object');

  // Everything unread is null, so the page can render an em dash.
  for (const k of ['lastBlock', 'behind', 'startedAt', 'lastPollAt', 'lastError']) {
    assert.equal(rh[k], null, `${k} starts unknown, not 0`);
  }
  // Counts genuinely start at zero — we have seen nothing, which is a fact.
  for (const k of ['launchesSeen', 'tradesSeen', 'tracking', 'graduationsSeen']) {
    assert.equal(rh[k], 0, `${k} is a real count`);
  }
  assert.equal(rh.running, false);
  ok('a fresh status is per chain, and unread fields are null rather than 0');
}

const trackedAt = (seenAt, buys, sells, creator = '0xcreator') => ({
  launch: { chain: 'robinhood', token: '0xtok', name: '', symbol: 'T', creator, seenAt, blockNumber: 1, windows: [], graduatedAt: null },
  key: '0xcurve',
  creator,
  buys,
  sells,
  done: new Set(),
  curvePct: null,
});

{
  const t0 = 1_000_000;
  const tr = trackedAt(t0, [
    { trader: '0xa', native: 0.5, at: t0 + 10_000 },
    { trader: '0xb', native: 0.25, at: t0 + 30_000 },
    { trader: '0xa', native: 0.25, at: t0 + 50_000 },
    // Outside the 60 s window — must not be counted in it.
    { trader: '0xc', native: 5, at: t0 + 90_000 },
  ], [
    { trader: '0xb', native: 0.1, at: t0 + 40_000 },
  ]);

  const w60 = _measure(tr, 60);
  assert.equal(w60.buys, 3, 'only the buys inside the window');
  assert.equal(w60.sells, 1);
  assert.equal(w60.uniqueBuyers, 2, '0xa bought twice and counts once');
  assert.ok(Math.abs(w60.volumeNative - 1.0) < 1e-9, 'volume is buys only');
  assert.ok(Math.abs(w60.netNative - 0.9) < 1e-9, 'net is buys minus sells');
  assert.equal(w60.creatorSold, false, 'the creator did not sell');

  const w120 = _measure(tr, 120);
  assert.equal(w120.buys, 4, 'the later buy lands in the 120 s window');
  assert.equal(w120.uniqueBuyers, 3);
  ok('a window counts exactly the events inside it, and unique buyers are unique');
}

{
  // Curve progress is READ, not derived. When it was never read the window
  // says so rather than reporting a curve at 0%.
  const w = _measure(trackedAt(0, [], []), 60);
  assert.equal(w.curvePct, null, 'unread curve progress is null, never 0');
  assert.equal(w.buys, 0, 'but a genuine zero count is a zero');
  ok('unread curve progress is null while a real zero count stays 0');
}

{
  // Money columns exist only in the chain's own coin. A four.meme curve
  // quoted in USDT counts its buys and shows NO BNB figure — until
  // 2026-09-11 its USDT was summed and ranked as BNB (78 % of live launches).
  const tr = trackedAt(0, [{ trader: '0xa', native: 1, at: 5 }, { trader: '0xb', native: 2, at: 6 }], []);
  tr.launch.chain = 'bnb';
  tr.quote = 'other';
  const w = _measure(tr, 60);
  assert.equal(w.buys, 2, 'buys are counted');
  assert.equal(w.uniqueBuyers, 2);
  assert.equal(w.netNative, null, 'no BNB number for a USDT curve');
  assert.equal(w.volumeNative, null);
  tr.quote = 'native';
  assert.ok(Math.abs(_measure(tr, 60).netNative - 3) < 1e-9, 'a BNB-quoted curve sums its BNB');
  tr.quote = undefined;
  assert.equal(_measure(tr, 60).netNative, null, 'and an UNREAD quote on BNB is not assumed to be BNB');
  tr.launch.chain = 'robinhood';
  assert.ok(Math.abs(_measure(tr, 60).netNative - 3) < 1e-9, 'while a Pons curve is ETH by construction');
  ok('a window sums money only when the curve is quoted in the chain\'s own coin');
}

{
  const t0 = 2_000_000;
  const tr = trackedAt(t0, [{ trader: '0xa', native: 1, at: t0 + 5_000 }], [{ trader: '0xcreator', native: 1, at: t0 + 20_000 }]);
  assert.equal(_measure(tr, 60).creatorSold, true, 'the creator selling inside the window is recorded');
  ok('a creator selling in the window is reported');
}

// ── Launches in flight survive a restart ────────────────────────────────
//
// They did not, and it cost the whole BNB model: a launch settles six hours
// after it is seen, `pending` lived only in memory, and so any restart inside
// that window threw away everything still in flight. Measured 2026-09-10 —
// zero BNB launches settled in the nine hours after its detector was fixed,
// because the app kept restarting. A model that can only learn from
// uninterrupted six-hour stretches does not learn.

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evmscan-'));
  _reset();
  initModels(dir);

  const now = Date.now();
  _addPending('robinhood', { token: '0xAAA1', bucket: 21, seenAt: now - 60_000, graduated: false });
  _addPending('robinhood', { token: '0xBBB2', bucket: 6, seenAt: now - 120_000, graduated: true });
  _addPending('bnb', { token: '0xCCC3', bucket: 11, seenAt: now - 30_000, graduated: false });
  persistModels();

  // A restart: everything in memory is gone, the file is all there is.
  _reset();
  initModels(dir);

  const rh = _pending('robinhood');
  assert.equal(rh.length, 2, 'both Robinhood launches came back');
  assert.equal(_pending('bnb').length, 1, 'and BNB keeps its own, separately');
  assert.deepEqual(rh.map((p) => p.token).sort(), ['0xaaa1', '0xbbb2'], 'addresses are normalised, as everywhere else');
  const revived = rh.find((p) => p.token === '0xaaa1');
  assert.equal(revived.bucket, 21, 'the bucket it was measured into is what it settles into');
  assert.equal(revived.seenAt, now - 60_000, 'and its age is its own, not the restart time');
  ok('launches still awaiting an outcome survive a restart, per chain');
}

{
  // Every restored launch is marked, and the mark is what sends it to the
  // chain for a direct answer instead of trusting an event feed that was not
  // running. Without this, restoring them would record false negatives — the
  // exact failure that made BNB's base rate read 0 %.
  const rh = _pending('robinhood');
  for (const p of rh) assert.equal(p.restored, true, `${p.token} is marked as restored`);
  ok('a restored launch is marked, so its outcome is re-read rather than assumed');
}

{
  // Saved on ENTRY, not only when something settles.
  //
  // The first version of this persisted only on a model change, which meant
  // nothing reached disk until the first launch settled — six hours away on a
  // fresh model, so a restart inside that window still lost everything. Found
  // by running the packaged build, not by a test, which is why there is now
  // a test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evmscan-'));
  _reset();
  initModels(dir);
  _addPending('bnb', { token: '0xEEE5', bucket: 3, seenAt: Date.now(), graduated: false });
  persistModels();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'evm-runners.json'), 'utf8'));
  assert.equal(saved.pending.bnb.length, 1, 'a launch in flight is on disk before anything has settled');
  assert.equal(saved.chains.bnb.totalSettled, 0, 'and the model is still empty, as it should be');
  ok('a launch awaiting its outcome reaches disk before the first settle');
}

{
  // A model recorded by a detector this build no longer uses is discarded.
  // Its pendings are NOT: a pending launch's bucket was measured the same
  // way on every build, and its outcome is asked of the chain directly
  // before it is counted (`restored`), so the detector that entered it has
  // no say in the number it becomes. Until 2026-09-11 they went with the
  // tallies — the Robinhood re-stamp that day would have thrown away 2,911
  // chain-verifiable launches for nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evmscan-'));
  fs.writeFileSync(
    path.join(dir, 'evm-runners.json'),
    JSON.stringify({
      version: 1,
      chains: { bnb: { chain: 'bnb', tallies: [{ bucket: 21, settled: 500, graduated: 0 }], totalSettled: 500, totalGraduated: 0, gradSource: 'none' } },
      pending: { bnb: [{ token: '0xdead', bucket: 21, seenAt: Date.now(), graduated: false }] },
    }),
    'utf8',
  );
  _reset();
  initModels(dir);
  assert.equal(modelOf('bnb').totalSettled, 0, 'outcomes from the old detector are not counted');
  const kept = _pending('bnb');
  assert.equal(kept.length, 1, 'but the launch it was watching is kept');
  assert.equal(kept[0].restored, true, 'marked restored, so the chain is asked before it counts');
  ok('a stale detector stamp discards the tallies and keeps the pendings for the chain to verify');
}

{
  // An unreadable file is not an empty one: the house rule, applied here too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evmscan-'));
  fs.writeFileSync(path.join(dir, 'evm-runners.json'), '{ this is not json', 'utf8');
  _reset();
  initModels(dir);
  _addPending('bnb', { token: '0xnew', bucket: 6, seenAt: Date.now(), graduated: false });
  persistModels();
  assert.equal(fs.readFileSync(path.join(dir, 'evm-runners.json'), 'utf8'), '{ this is not json', 'the damaged file is left alone');
  ok('an unreadable model file is never overwritten by an empty one');
}

console.log(`\nevmscan: ${passed}/${passed} passed`);
