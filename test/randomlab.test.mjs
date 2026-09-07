// The warmer's money-safety rules, driven with a fake host and no chain:
// bags are never forgotten (disarm, throw, restart), the loss cap judges
// CLOSED trades only, a restarted run starts from zero, and a sell that
// keeps failing is handed to the user by name after the retry cap.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lab = await import('./.randomlab.mjs');
const { __internals, attach, init, start, stop, status } = lab;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-lab-'));
assert.equal(init(tmp), 0, 'no file yet restores nothing');

const cfg = {
  follow: { enabled: false },
  random: {
    enabled: true, universe: 'trending', minLiquidityUsd: 0,
    tradeSolMin: 0.01, tradeSolMax: 0.01, holdSecMin: 5, holdSecMax: 5,
    gapSecMin: 5, gapSecMax: 5, maxOpenPerWallet: 1, maxLossSol: 0.005, maxTradesPerHour: 100,
  },
};
const cash = new Map(); // signature → SOL delta (buys negative)
const host = {
  armedFlag: true,
  sellImpl: async () => ({ ok: true, message: 'sold', signature: null }),
  armed: () => host.armedFlag,
  config: () => cfg,
  members: () => [
    { id: 'w1', label: 'one', publicKey: 'PK1' },
    { id: 'w2', label: 'two', publicKey: 'PK2' },
    { id: 'wa', label: 'main', publicKey: 'ACTIVE' },
  ],
  activePublicKey: () => 'ACTIVE',
  balanceSol: async () => 1,
  candidates: async () => [{ mint: 'MINT1', symbol: 'ONE' }],
  buys: 0,
  buy: async () => {
    const sig = `buy${++host.buys}`;
    cash.set(sig, -0.0102); // size + fees, as the ledger would see it
    return { ok: true, message: 'ok', signature: sig, costSol: 0.0102 };
  },
  sell: (...a) => host.sellImpl(...a),
  realizedFor: (sigs) => sigs.reduce((a, s) => a + (cash.get(s) ?? 0), 0),
  log: () => {},
  emit: () => {},
};
attach(host);

// ── a buy is carried at cost, not counted as a loss ──────────────────
const s1 = start('g1');
assert.equal(s1.ok, true, s1.message);
const run = __internals.runs.get('g1');
clearTimeout(run.nextTimer); // the test drives ticks itself
await __internals.tick(run);
clearTimeout(run.nextTimer);
assert.equal(run.status.buys, 1);
assert.equal(run.status.open.length, 1);
assert.equal(run.status.open[0].costSol, 0.0102);
assert.equal(status()[0].running, true, 'holding a bag worth more than the cap does not stop the run');
assert.ok(Math.abs(status()[0].realizedSol) < 1e-9, 'open bag at cost → nothing realised yet');
const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'lab-runs.json'), 'utf8'));
assert.equal(persisted.runs[0].open.length, 1, 'the open bag is on disk');
console.log('ok  a held bag counts at cost, is persisted, and does not trip the cap');

// ── disarmed: the sell is re-queued, never dropped ───────────────────
host.armedFlag = false;
const open1 = run.status.open[0];
for (const t of run.sellTimers.values()) clearTimeout(t);
await __internals.sellOpen('g1', open1);
assert.equal(run.status.open.length, 1, 'bag still tracked while disarmed');
assert.equal(run.status.open[0].tries, 1);
assert.ok(run.status.open[0].sellAt > Date.now(), 'a retry is scheduled');
assert.match(run.status.lastLine, /disarmed/);
for (const t of run.sellTimers.values()) clearTimeout(t);
console.log('ok  a disarm re-queues the sell instead of abandoning the bag');

// ── a throwing sell is a failed attempt, not a lost bag or a crash ───
host.armedFlag = true;
host.sellImpl = async () => { throw new Error('socket closed'); };
await __internals.sellOpen('g1', run.status.open[0]); // must not reject
assert.equal(run.status.open.length, 1);
assert.equal(run.status.open[0].tries, 2);
assert.equal(run.status.failed, 1);
for (const t of run.sellTimers.values()) clearTimeout(t);
console.log('ok  a throw inside the sell path retries instead of rejecting');

// ── the loss cap fires on the CLOSED trade ───────────────────────────
host.sellImpl = async () => {
  cash.set('sell1', 0.004); // sold for less than it cost
  return { ok: true, message: 'sold', signature: 'sell1' };
};
await __internals.sellOpen('g1', run.status.open[0]);
assert.equal(run.status.open.length, 0);
assert.equal(run.status.sells, 1);
assert.ok(run.status.realizedSol < -0.005, `realised ${run.status.realizedSol}`);
assert.equal(run.status.running, false, 'cap hit once the trade closed');
assert.match(run.status.stopReason, /loss cap/);
console.log('ok  the cap fires on realised loss of the closed trade');

// ── a restart is judged from zero, not re-tripped by old fills ───────
const s2 = start('g1');
assert.equal(s2.ok, true, s2.message);
const run2 = __internals.runs.get('g1');
clearTimeout(run2.nextTimer);
__internals.resetTradeClock(); // the 10 s global lab spacing is not what this measures
assert.ok(Math.abs(status()[0].realizedSol) < 1e-9, 'baseline absorbs the earlier loss');
assert.equal(run2.gen, run.gen + 1);
await __internals.tick(run2);
clearTimeout(run2.nextTimer);
assert.equal(run2.status.running, true, 'the old loss does not stop the new run');
assert.equal(run2.status.buys, 1);
console.log('ok  a restarted run starts from zero');

// ── a stale generation cannot touch the live run ─────────────────────
await __internals.tick(run); // the replaced run object
assert.equal(run.status.buys, 1, 'the stale run did nothing');
console.log('ok  callbacks from a replaced run bail out');

// ── the retry cap hands the bag to the user by name ──────────────────
for (const t of run2.sellTimers.values()) clearTimeout(t);
run2.status.open[0].tries = 4;
host.sellImpl = async () => ({ ok: false, message: 'nothing to sell', signature: null });
await __internals.sellOpen('g1', run2.status.open[0]);
assert.equal(run2.status.open.length, 0, 'no longer occupying the open slot');
assert.match(run2.status.lastLine, /could not sell .* after 5 tries/);
assert.match(run2.status.lastLine, /MINT1/);
assert.match(run2.status.lastLine, /^(one|two):/, 'names the wallet'); // the tick picks a random eligible wallet
// A bag that cannot be sold is counted as lost: its cost is no longer carried.
assert.equal(run2.status.running, false);
assert.match(run2.status.stopReason, /loss cap/);
console.log('ok  after the retry cap the bag is reported by wallet and mint, and counts as lost');

// ── restart of the app restores open bags and re-arms their sells ────
run2.status.open.push({ walletId: 'w2', mint: 'MINT2', symbol: 'TWO', boughtAt: Date.now(), sellAt: Date.now() + 60_000, costSol: 0.01 });
stop('g1');
const fresh = await import('./.randomlab.mjs?fresh=1');
assert.equal(fresh.init(tmp), 1, 'one open bag restored');
const restored = fresh.status()[0];
assert.equal(restored.open[0].mint, 'MINT2');
assert.match(restored.stopReason, /restored/);
const r2 = fresh.__internals.runs.get('g1');
assert.equal(r2.sellTimers.size, 1, 'its sell timer is armed');
for (const t of r2.sellTimers.values()) clearTimeout(t);
console.log('ok  an app restart restores open bags and re-arms their sells');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('randomlab: all tests passed');
process.exit(0);
