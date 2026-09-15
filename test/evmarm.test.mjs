// Arming one EVM chain must leave the other in Paper.
//
// This is the invariant the release checklist asks someone to click through
// before every ship: "arm and disarm each chain, confirm arming one leaves the
// others in Paper". It was verified by hand and pinned nowhere, so nothing
// stopped a future refactor collapsing the two chains onto one flag — and the
// failure mode is a user who armed BNB deliberately discovering that Robinhood
// went live with it.
//
// The rail keeps arm state per chain in a record keyed by chain, so the test is
// cheap: arm one, assert the other is untouched, both ways round.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-evmarm-'));
// BEFORE the rail is imported: the electron stub resolves userData from this
// variable, and the wallet store reads it at import time. Without it the store
// falls back to test/.walletdata, which PERSISTS between runs — the first
// assertion below ("no wallet yet") then passes once and fails for ever after,
// which is how this test failed in the suite having passed on its own.
process.env.KRYPT_TEST_USERDATA = userData;

const rail = await import('./.evmrail.mjs');
const settings = {
  evm: {
    robinhood: { enabled: true, rpcUrl: '', slippagePct: 5, runnerAlerts: {} },
    bnb: { enabled: true, rpcUrl: '', slippagePct: 5, runnerAlerts: {} },
  },
};

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`  ok   ${m}`);
};

rail.init({ userData, getSettings: () => settings, emit: () => {} });

// `arm` refuses without a wallet, which is itself worth stating: the refusal
// is the first guard, before any per-chain question.
{
  const r = rail.arm('bnb');
  assert.equal(r.ok, false, 'arming with no wallet is refused');
  assert.match(r.message, /wallet/i);
  ok('arming a chain with no wallet is refused, with the reason');
}

// One wallet, usable on both chains — the same address on each, which is
// exactly the arrangement that makes accidental shared arm state plausible.
const gen = rail.wallet.generate('arm-test');
assert.ok(gen.ok, `wallet: ${gen.message}`);

// ── both start in Paper ───────────────────────────────────────────────
assert.equal(rail.armed('robinhood'), false);
assert.equal(rail.armed('bnb'), false);
ok('both chains start in Paper');

// ── arming BNB leaves Robinhood alone ─────────────────────────────────
{
  const r = rail.arm('bnb');
  assert.equal(r.ok, true, `arm bnb: ${r.message}`);
  assert.equal(rail.armed('bnb'), true, 'bnb is live');
  assert.equal(rail.armed('robinhood'), false, 'ROBINHOOD MUST STILL BE PAPER');
  // The state object, not just the boolean: a shared object would show the
  // same armedAt on both and a boolean check alone would not notice.
  assert.equal(rail.liveState('robinhood').armedAt, null, 'robinhood was never armed');
  assert.notEqual(rail.liveState('bnb').armedAt, null, 'bnb records when it was armed');
  ok('arming BNB leaves Robinhood in Paper');
}

// ── disarming BNB does not disturb Robinhood ──────────────────────────
{
  rail.disarm('bnb', 'user');
  assert.equal(rail.armed('bnb'), false);
  assert.equal(rail.armed('robinhood'), false);
  assert.equal(rail.liveState('bnb').lastDisarmReason, 'user');
  ok('disarming BNB records the reason and leaves Robinhood alone');
}

// ── and the same the other way round ──────────────────────────────────
{
  const r = rail.arm('robinhood');
  assert.equal(r.ok, true, `arm robinhood: ${r.message}`);
  assert.equal(rail.armed('robinhood'), true);
  assert.equal(rail.armed('bnb'), false, 'BNB MUST STILL BE PAPER');
  assert.equal(rail.liveState('bnb').armedAt, null, 'bnb stayed disarmed');
  ok('arming Robinhood leaves BNB in Paper');
}

// ── a chain switched off in Settings cannot be armed ──────────────────
{
  settings.evm.bnb.enabled = false;
  const r = rail.arm('bnb');
  assert.equal(r.ok, false, 'a disabled chain refuses to arm');
  assert.match(r.message, /Settings/);
  assert.equal(rail.armed('bnb'), false);
  // The refusal must not have disturbed the chain that IS armed.
  assert.equal(rail.armed('robinhood'), true, 'the other chain is unaffected by a refusal');
  settings.evm.bnb.enabled = true;
  ok('a chain turned off in Settings refuses to arm, and the other chain is untouched');
}

// ── arming twice is idempotent, not a second arm ──────────────────────
{
  const first = rail.liveState('robinhood').armedAt;
  const r = rail.arm('robinhood');
  assert.equal(r.ok, true);
  assert.match(r.message, /Already live/);
  assert.equal(rail.liveState('robinhood').armedAt, first, 'armedAt is not reset by a second arm');
  ok('arming an already-live chain is idempotent');
}

rail.disarm('robinhood', 'user');
try {
  fs.rmSync(userData, { recursive: true, force: true });
} catch {
  /* a temp dir that will not delete is not a test failure */
}

console.log(`evmarm: ${passed}/${passed} tests passed`);
