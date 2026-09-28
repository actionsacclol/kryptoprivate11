// Auto-swap USDC → SOL (2026-09-27): the decision and the runner.
//
// The rules that keep this from being a way to lose money by accident:
// off = never; disarmed = never (and no reads either); dust = never; one
// attempt per wallet per cooldown whatever happened; unknown balance = never
// and never an attempt; a pass never throws; a kick is debounced.
import assert from 'node:assert';
import { sweepDecision, usdcFromRaw, USDC_SWEEP_MIN_USDC, USDC_SWEEP_COOLDOWN_MS } from './.usdcsweep.mjs';
import * as runner from './.usdcsweeprunner.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const T0 = 1_790_000_000_000;
const on = { enabled: true, live: true, now: T0 };
const fresh = () => ({ lastAttemptAt: null, inFlight: false });

test('the decision: every gate in order, unknown never swaps and never counts as an attempt', () => {
  assert.deepEqual(sweepDecision(5, fresh(), { ...on, enabled: false }), { swap: false, why: 'off' });
  assert.deepEqual(sweepDecision(5, fresh(), { ...on, live: false }), { swap: false, why: 'not live' });
  assert.deepEqual(sweepDecision(5, { lastAttemptAt: null, inFlight: true }, on), { swap: false, why: 'in flight' });
  assert.deepEqual(sweepDecision(5, { lastAttemptAt: T0 - 60_000, inFlight: false }, on), { swap: false, why: 'cooldown' });
  assert.deepEqual(sweepDecision(5, { lastAttemptAt: T0 - USDC_SWEEP_COOLDOWN_MS, inFlight: false }, on), { swap: true }, 'the cooldown is inclusive at its end');
  assert.deepEqual(sweepDecision(null, fresh(), on), { swap: false, why: 'unknown balance' });
  assert.deepEqual(sweepDecision(Number.NaN, fresh(), on), { swap: false, why: 'unknown balance' });
  assert.deepEqual(sweepDecision(0.1, fresh(), on), { swap: false, why: 'below minimum' });
  assert.deepEqual(sweepDecision(0, fresh(), on), { swap: false, why: 'below minimum' });
  assert.deepEqual(sweepDecision(USDC_SWEEP_MIN_USDC, fresh(), on), { swap: true });
  assert.deepEqual(sweepDecision(1.64, fresh(), on), { swap: true });
  assert.equal(usdcFromRaw(1_635_016n), 1.635016);
});

function makeDeps(over = {}) {
  const calls = { reads: [], swaps: [], logs: [], announced: [] };
  let now = T0;
  const deps = {
    calls,
    setNow: (t) => (now = t),
    enabled: () => over.enabled ?? true,
    live: () => over.live ?? true,
    wallets: () => over.wallets ?? [
      { id: 'w1', publicKey: 'A111111111111111111111111111111111111111111', label: 'Main' },
      { id: 'w2', publicKey: 'B222222222222222222222222222222222222222222', label: 'Caller 2' },
      { id: 'w3', publicKey: 'C333333333333333333333333333333333333333333', label: '' },
    ],
    usdcHeld: async (pk) => {
      calls.reads.push(pk);
      const bal = (over.balances ?? { A: 1_640_000n, B: 50_000n, C: null })[pk[0]];
      if (bal instanceof Error) throw bal;
      return bal === undefined ? null : bal;
    },
    swap: async (walletId, usdc) => {
      calls.swaps.push({ walletId, usdc });
      if (over.swapResult) return over.swapResult;
      if (over.swapThrows) throw new Error('signer busy');
      return { ok: true, message: 'Landed 4AqMzoBv…', signature: 'sig' };
    },
    log: (level, line) => calls.logs.push(`${level}: ${line}`),
    announce: (line) => calls.announced.push(line),
    now: () => now,
  };
  return deps;
}

test('a pass swaps the wallet over the minimum once, leaves dust and unreadables alone and says so once', async () => {
  runner._reset();
  const d = makeDeps();
  runner.attach(d);
  const r = await runner.runPass();
  assert.deepEqual(r, { swapped: 1, skipped: 2 });
  assert.deepEqual(d.calls.swaps, [{ walletId: 'w1', usdc: 1.64 }]);
  assert.equal(d.calls.reads.length, 3, 'every wallet was read');
  assert.ok(d.calls.logs.some((l) => /^info: auto-swap: 1\.64 USDC → SOL in "Main"/.test(l)), 'the swap is logged with the wallet');
  assert.ok(d.calls.logs.some((l) => /"Caller 2".*0\.05 USDC is under the minimum/.test(l)), 'dust is named once');
  assert.ok(d.calls.logs.some((l) => /C33333.*could not be read/.test(l)), 'an unreadable balance is named once');
  assert.deepEqual(d.calls.announced, ['Swapped 1.64 USDC to SOL in Main']);
  // The same pass again, inside the cooldown: nothing swapped, and the dust/unknown lines are not repeated.
  const logsBefore = d.calls.logs.length;
  const r2 = await runner.runPass();
  assert.deepEqual(r2, { swapped: 0, skipped: 3 });
  assert.equal(d.calls.swaps.length, 1, 'one attempt per wallet per cooldown');
  assert.equal(d.calls.reads.length, 5, 'the cooled-down wallet is not even read; the other two are');
  assert.equal(d.calls.logs.length, logsBefore, 'no repeated lines');
  // Past the cooldown, with USDC still there (the swap did not land after all), it tries again.
  d.setNow(T0 + USDC_SWEEP_COOLDOWN_MS + 1);
  const r3 = await runner.runPass();
  assert.equal(r3.swapped, 1);
  assert.equal(d.calls.swaps.length, 2);
});

test('off or disarmed: nothing is read and nothing is swapped', async () => {
  for (const over of [{ enabled: false }, { live: false }]) {
    runner._reset();
    const d = makeDeps(over);
    runner.attach(d);
    const r = await runner.runPass();
    assert.equal(r.swapped, 0);
    assert.equal(d.calls.reads.length, 0, 'a disarmed or switched-off sweep spends no RPC calls');
    assert.equal(d.calls.swaps.length, 0);
  }
});

test('a refused or throwing swap is logged as a warning, counts as the attempt, and never escapes the pass', async () => {
  runner._reset();
  const d = makeDeps({ swapResult: { ok: false, message: 'Switch to Live and arm to swap — nothing was sent' } });
  runner.attach(d);
  const r = await runner.runPass();
  assert.equal(r.swapped, 0);
  assert.equal(d.calls.swaps.length, 1);
  assert.ok(d.calls.logs.some((l) => /^warn: auto-swap: 1\.64 USDC in "Main" \(A11111…\) NOT swapped — Switch to Live.*next try in 10 min/.test(l)), d.calls.logs.join('\n'));
  assert.deepEqual(d.calls.announced, [], 'nothing is announced for a swap that did not happen');
  await runner.runPass();
  assert.equal(d.calls.swaps.length, 1, 'the failure started the cooldown');
  runner._reset();
  const d2 = makeDeps({ swapThrows: true });
  runner.attach(d2);
  const r2 = await runner.runPass();
  assert.equal(r2.swapped, 0);
  assert.ok(d2.calls.logs.some((l) => /^warn: auto-swap: "Main".*signer busy/.test(l)));
  // A throwing balance read is an unknown, not a crash.
  runner._reset();
  const d3 = makeDeps({ balances: { A: new Error('rpc down'), B: 50_000n, C: 300_000n } });
  runner.attach(d3);
  const r3 = await runner.runPass();
  assert.deepEqual(d3.calls.swaps, [{ walletId: 'w3', usdc: 0.3 }], 'the readable wallet over the minimum is swapped');
  assert.equal(r3.swapped, 1);
});

test('a kick runs one pass soon; several kicks in a row are one pass; a pass never overlaps another', async () => {
  runner._reset();
  const d = makeDeps();
  runner.attach(d);
  runner.kick(5);
  runner.kick(5);
  runner.kick(5);
  await tick(40);
  assert.equal(d.calls.swaps.length, 1, 'three kicks, one pass, one swap');
  // Overlap: a slow read while another pass is asked for.
  runner._reset();
  let release;
  const slow = new Promise((r) => (release = r));
  const d2 = makeDeps();
  d2.usdcHeld = async () => {
    await slow;
    return 1_000_000n;
  };
  runner.attach(d2);
  const p1 = runner.runPass();
  const p2 = runner.runPass();
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.swapped + r2.swapped, 3, 'one pass did the work, the other returned at once');
  assert.deepEqual(r2, { swapped: 0, skipped: 0 });
  runner._reset();
});

test('the setting and the wiring exist where the doc says', async () => {
  const fs = await import('node:fs');
  const types = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8');
  assert.ok(/autoSwapUsdc: boolean;/.test(types), 'ExecutionSettings has the field');
  assert.ok(/autoSwapUsdc: true,/.test(types), 'on by default');
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');
  assert.ok(ipc.includes("store.load().execution.autoSwapUsdc !== false"), 'absent on an older save reads as on');
  assert.ok(ipc.includes("if (ev.kind === 'holdings') usdcSweep.kick();"), 'a holdings change kicks a pass');
  assert.ok(/swap\.execute\(\{ chain: 'solana', inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: usdc, slippagePct: 1, speed: 'normal' \}, swapDeps\(\), false, walletId\)/.test(ipc), 'the same swap path as the rewards button — the fee rides on it');
  const wallet = fs.readFileSync(new URL('../src/pages/Wallet.tsx', import.meta.url), 'utf8');
  assert.ok(wallet.includes('label="Auto-swap USDC to SOL"'), 'the switch is on the Sol Wallet page');
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      console.log(`ok  ${c.name}`);
    } catch (err) {
      console.log(`FAIL ${c.name}\n  ${err?.stack ?? err}`);
    }
  }
  console.log(`usdcsweep: ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
}

await run();
