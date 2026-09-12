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
// The fake ledger. A signature is in `cash` once its fill RECONCILED; a
// signature the map does not know is `unknown` — pending, unreadable, or
// never recorded — which is exactly what the real ledger reports.
const cash = new Map(); // signature → SOL delta (buys negative)
const priceFor = (map) => (sigs) => {
  let sol = 0;
  let unknown = 0;
  for (const s of new Set(sigs)) {
    if (map.has(s)) sol += map.get(s);
    else unknown += 1;
  }
  return { sol, unknown };
};
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
  realizedFor: priceFor(cash),
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
assert.equal(restored.realizedSol, null, 'a restored run claims no realised number from last session');
console.log('ok  an app restart restores open bags and re-arms their sells');

// ── lab-12: a restored run does not show last session's cash, and its cap
//    comes from the group config instead of a zero the page divides by ─────
{
  const m = await import('./.randomlab.mjs?lab12=1');
  assert.equal(m.init(tmp), 1);
  m.attach(host);
  const st = m.status()[0];
  assert.equal(st.realizedSol, null, 'realised is unknown until this session starts the run');
  assert.equal(st.maxLossSol, cfg.random.maxLossSol, 'the cap is read from the group config, not left at 0');
  for (const t of m.__internals.runs.get('g1').sellTimers.values()) clearTimeout(t);
  console.log('ok  a restored run reports realised as unknown and the configured cap');
}

// ── lab-1: a fill nobody can price is NOT a zero ─────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-lab1-'));
  const m = await import('./.randomlab.mjs?lab1=1');
  assert.equal(m.init(dir), 0);
  const priced = new Map(); // nothing reconciles until the test says so
  m.attach({
    armed: () => true,
    config: () => cfg,
    members: () => [
      { id: 'w1', label: 'one', publicKey: 'PK1' },
      { id: 'wa', label: 'main', publicKey: 'ACTIVE' },
    ],
    activePublicKey: () => 'ACTIVE',
    balanceSol: async () => 1,
    candidates: async () => [{ mint: 'MINTP', symbol: 'PEND' }],
    buy: async () => ({ ok: true, message: 'ok', signature: 'pending1', costSol: 0.01 }),
    sell: async () => ({ ok: true, message: 'sold', signature: 'pendsell' }),
    realizedFor: priceFor(priced),
    log: () => {},
    emit: () => {},
  });
  m.__internals.setUnknownGraceMs(0); // no waiting: the pending fill must stop it now
  m.__internals.resetTradeClock();
  const s = m.start('g1');
  assert.equal(s.ok, true, s.message);
  const r = m.__internals.runs.get('g1');
  clearTimeout(r.nextTimer);
  await m.__internals.tick(r); // buys; the fill never reconciles
  clearTimeout(r.nextTimer);
  assert.equal(r.status.buys, 1);
  assert.equal(m.status()[0].realizedSol, null, 'a pending fill renders as an em dash, never 0.000');
  m.__internals.resetTradeClock();
  await m.__internals.tick(r);
  clearTimeout(r.nextTimer);
  assert.equal(r.status.running, false, 'the run stops rather than trade blind to its own loss cap');
  assert.match(r.status.stopReason, /cannot price 1 fill/);
  assert.equal(r.status.buys, 1, 'and it bought nothing while blind');
  // Once the chain answers, the bag is added back at the cost the CHAIN saw.
  priced.set('pending1', -0.0102);
  assert.ok(Math.abs(m.status()[0].realizedSol) < 1e-9, 'a reconciled open bag is carried at its on-chain cost');
  for (const t of r.sellTimers.values()) clearTimeout(t);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  a pending fill is unknown, stops the run, and is never reported as 0 realised');
}

// ── lab-2: an unreadable run file is never overwritten ────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-lab2-'));
  const f = path.join(dir, 'lab-runs.json');
  const truncated = '{"version":1,"runs":[{"groupId":"g9","open":[{"walletId":"w1","mint":"MINT9","sym';
  fs.writeFileSync(f, truncated, 'utf8');
  const m = await import('./.randomlab.mjs?lab2=1');
  assert.equal(m.init(dir), 0, 'a truncated file restores nothing');
  assert.match(m.failure(), /corrupt/, 'and it is remembered as a failure, not as "no bags"');
  m.attach(host);
  m.__internals.resetTradeClock();
  const s = m.start('g1'); // start() persists — and must not, here
  assert.equal(s.ok, true, s.message);
  clearTimeout(m.__internals.runs.get('g1').nextTimer);
  assert.equal(fs.readFileSync(f, 'utf8'), truncated, 'the unreadable file is left byte-for-byte alone');
  assert.match(m.status()[0].loadFailure, /corrupt/, 'and the failure is surfaced in status()');
  assert.match(m.status()[0].lastLine, /will not be remembered/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  a truncated run file is reported and never written over');
}
{
  // A read error that is not ENOENT is the same rule: here the path is a
  // directory, so readFileSync fails without the file being absent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-lab2b-'));
  fs.mkdirSync(path.join(dir, 'lab-runs.json'));
  const m = await import('./.randomlab.mjs?lab2b=1');
  assert.equal(m.init(dir), 0);
  assert.match(m.failure(), /could not be read/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  an unreadable (non-ENOENT) run file fails closed too');
}
{
  // ENOENT is the fresh install, and it must NOT be a failure.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-lab2c-'));
  const m = await import('./.randomlab.mjs?lab2c=1');
  assert.equal(m.init(dir), 0);
  assert.equal(m.failure(), null, 'an absent file is a fresh start, not a failure');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  an absent run file is a fresh start');
}

// ── lab-10: the per-wallet open cap counts every run, not just this one ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-lab10-'));
  const m = await import('./.randomlab.mjs?lab10=1');
  assert.equal(m.init(dir), 0);
  const ledger = new Map();
  let buys = 0;
  m.attach({
    armed: () => true,
    config: () => cfg, // maxOpenPerWallet: 1
    members: () => [
      { id: 'w1', label: 'one', publicKey: 'PK1' },
      { id: 'wa', label: 'main', publicKey: 'ACTIVE' },
    ],
    activePublicKey: () => 'ACTIVE',
    balanceSol: async () => 1,
    candidates: async () => [{ mint: `MINT${buys}`, symbol: 'X' }],
    buy: async () => {
      const sig = `b${++buys}`;
      ledger.set(sig, -0.0102);
      return { ok: true, message: 'ok', signature: sig, costSol: 0.0102 };
    },
    sell: async () => ({ ok: true, message: 'sold', signature: null }),
    realizedFor: priceFor(ledger),
    log: () => {},
    emit: () => {},
  });
  m.__internals.setUnknownGraceMs(0);
  for (const g of ['gA', 'gB']) {
    m.__internals.resetTradeClock();
    const s = m.start(g);
    assert.equal(s.ok, true, s.message);
    const r = m.__internals.runs.get(g);
    clearTimeout(r.nextTimer);
    await m.__internals.tick(r);
    clearTimeout(r.nextTimer);
    for (const t of r.sellTimers.values()) clearTimeout(t);
  }
  const held = [...m.__internals.runs.values()].reduce((n, r) => n + r.status.open.filter((o) => o.walletId === 'w1').length, 0);
  assert.equal(held, 1, 'the second group does not get its own allowance on the same wallet');
  assert.match(m.__internals.runs.get('gB').status.lastLine, /open cap/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  the per-wallet open cap is counted across every run');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('randomlab: all tests passed');
process.exit(0);
