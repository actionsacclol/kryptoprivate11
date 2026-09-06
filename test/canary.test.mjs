// Canaries + integrity guard.
//
// The single most important assertion here is that a GENUINE build is inert:
// every canary passes and every degradation is neutral, forever, on every
// machine. If that ever failed, real users would be harmed — which is worse
// than any crack. The rest asserts the tripwires actually bite a tampered
// build, and bite it in a delayed, ramping, sell-safe way.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tamperFlags, tamperCount, isIntact } from './.canary.mjs';
import { PRESENCE, packIdentity } from './.presence.mjs';
import { resolvePresence, canonicalPresence } from './.presenceintegrity.mjs';
import {
  level,
  buySizeFactor,
  buyExtraSlippagePct,
  buyDelayMs,
  denyLocalBuild,
  scanExtraDelayMs,
  detectedTamper,
  seized,
  seizeMessage,
  SEIZE_LEVEL,
  GRACE_MS,
  RAMP_MS,
  __setForTest,
  __advance,
  __reset,
} from './.integrityguard.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

// ─── The genuine build is inert (the safety property) ─────────────────

ok('a genuine build trips ZERO canaries', () => {
  // Runs against the REAL compiled constants — this is the false-positive guard.
  assert.deepEqual(tamperFlags(), new Array(12).fill(false));
  assert.equal(tamperCount(), 0);
  assert.equal(isIntact(), true);
});

ok('a genuine build is never seized, at any elapsed time', () => {
  __reset();
  assert.equal(seized(), false, 'with the REAL constants — the false-positive guard');
  for (const t of [0, GRACE_MS, GRACE_MS + RAMP_MS, GRACE_MS + RAMP_MS * 100]) {
    __setForTest(0, t);
    assert.equal(seized(), false, `must never seize a clean build (t=${t})`);
  }
  __reset();
});

ok('a genuine build stays neutral no matter how much time passes', () => {
  __reset();
  // With the real tamperCount() === 0, level must be 0 at any clock value.
  for (const t of [0, GRACE_MS, GRACE_MS + RAMP_MS, GRACE_MS + RAMP_MS * 10]) {
    __setForTest(0, t); // 0 canaries tripped
    assert.equal(level(), 0, `level must be 0 at t=${t} on a clean build`);
  }
  __reset();
});

ok('every degradation helper is exactly neutral when clean', () => {
  __setForTest(0, GRACE_MS + RAMP_MS * 5);
  assert.equal(buySizeFactor(), 1, 'full buy size');
  assert.equal(buyExtraSlippagePct(), 0, 'no extra slippage');
  assert.equal(buyDelayMs(), 0, 'no delay');
  assert.equal(denyLocalBuild(), false, 'local builder allowed');
  assert.equal(scanExtraDelayMs(), 0, 'no scan delay');
  assert.equal(detectedTamper(), false);
  __reset();
});

// ─── The tampered build: delayed, then biting ─────────────────────────

ok('a tampered build looks completely fine during the grace period', () => {
  __setForTest(3, 0); // 3 canaries tripped, at t=0
  assert.equal(detectedTamper(), true, 'detection is immediate…');
  __advance(GRACE_MS - 1); // …but still inside grace
  assert.equal(level(), 0, 'no degradation yet — this is what makes it hard to trace');
  assert.equal(buySizeFactor(), 1);
  assert.equal(buyDelayMs(), 0);
  __reset();
});

ok('after grace, corrosion ramps up over time', () => {
  __setForTest(3, 0);
  __advance(GRACE_MS + RAMP_MS / 2); // halfway up the ramp
  const mid = level();
  assert.ok(mid > 0 && mid < 1, `mid-ramp level should be partial, got ${mid}`);
  __advance(GRACE_MS + RAMP_MS * 3); // well past full ramp
  const full = level();
  assert.ok(full >= mid, 'corrosion is monotonic in time');
  __reset();
});

ok('more tripped canaries corrode faster', () => {
  __setForTest(1, 0);
  __advance(GRACE_MS + RAMP_MS / 4);
  const few = level();
  __setForTest(6, 0);
  __advance(GRACE_MS + RAMP_MS / 4);
  const many = level();
  assert.ok(many >= few, 'more canaries → at least as much corrosion');
  __reset();
});

ok('a fully corroded build has a small, slow, expensive buy', () => {
  __setForTest(7, 0);
  __advance(GRACE_MS + RAMP_MS * 10); // everything tripped, long elapsed
  assert.ok(buySizeFactor() < 0.5, 'buy shrinks toward 40%');
  assert.ok(buyExtraSlippagePct() > 4, 'slippage widens');
  assert.ok(buyDelayMs() > 1500, 'latency injected — death for a sniper');
  assert.equal(denyLocalBuild(), true, 'forced onto the fee-charging relayer');
  assert.ok(scanExtraDelayMs() > 1500, 'telemetry goes stale');
  __reset();
});

// ─── Safety: exits are never touched ──────────────────────────────────

// ─── Attribution: the presence identity is tamper-resistant too ───────

ok('the presence identity resolves clean on a genuine build', () => {
  const r = resolvePresence(PRESENCE);
  assert.equal(r.state, 'ok');
  assert.equal(r.intact, true);
  assert.equal(r.identity.clientId, '1495323918234423406');
});

ok('editing the readable identity changes a decoy — the real one is still published', () => {
  const cracked = {
    clientId: '000000000000000000',
    buttons: [
      { label: 'Buy my cracked build', url: 'https://example.invalid' },
      { label: 'Not us', url: 'https://example.invalid/2' },
    ],
    largeImageKey: 'nope',
    largeImageText: 'Something Else',
  };
  const r = resolvePresence(cracked);
  assert.equal(r.state, 'identity-tampered', 'the edit is detected');
  // …and the canonical identity is what gets published regardless.
  assert.equal(r.identity.clientId, '1495323918234423406');
  assert.equal(r.identity.buttons[0].url, 'https://krypt.cc/tools');
  assert.equal(r.identity.buttons[1].url, 'https://discord.gg/muzFKR657F');
  assert.equal(r.identity.largeImageText, 'Krypto Bot');
});

ok('the packed identity round-trips through the blob byte for byte', () => {
  assert.equal(packIdentity(canonicalPresence()), packIdentity(PRESENCE));
});

// ─── The end state: refuses to open, never refuses to exit ────────────

ok('a tampered build is not seized during grace, or early in the ramp', () => {
  __setForTest(4, 0);
  __advance(GRACE_MS - 1);
  assert.equal(seized(), false, 'grace still looks fine — that is what makes it hard to trace');
  __advance(GRACE_MS + RAMP_MS * 0.1);
  assert.equal(seized(), false, 'and the early ramp only corrodes');
  __reset();
});

ok('a SINGLE tripped canary still ends in a seize — no partial crack sits below the line', () => {
  // Removing only the fee, or only the attribution, must not leave a build
  // that corrodes forever without ever stopping.
  __setForTest(1, 0);
  __advance(GRACE_MS + RAMP_MS * 3);
  assert.ok(level() >= SEIZE_LEVEL, `one canary must reach the line, got ${level()}`);
  assert.equal(seized(), true);
  __reset();
});

ok('the seize message names the cause, the remedy, and what still works', () => {
  const m = seizeMessage();
  assert.match(m, /modified/i, 'says what happened');
  assert.match(m, /krypt\.cc/, 'says how to fix it');
  assert.match(m, /Selling, closing and withdrawing/, 'says exits still work');
});

ok('a seized build heals the moment the canaries read clean again', () => {
  __setForTest(6, 0);
  __advance(GRACE_MS + RAMP_MS * 2);
  assert.equal(seized(), true);
  __setForTest(0, GRACE_MS + RAMP_MS * 3);
  assert.equal(seized(), false, 'reinstalling a genuine build must clear it instantly');
  __reset();
});

ok('nothing here can be applied to a sell — the helpers are buy-only by name and use', () => {
  // The guard exposes only buy-side and scan-side degradation. There is no
  // sellDelay/sellSizeFactor/denySell, by design. This test documents that the
  // surface itself excludes the exit path.
  const exported = { buySizeFactor, buyExtraSlippagePct, buyDelayMs, denyLocalBuild, scanExtraDelayMs };
  const names = Object.keys(exported).join(',');
  assert.ok(!/sell/i.test(names), 'no sell-side degradation exists');
});

ok('the seize is applied to buys only — the source proves it, not just the name', () => {
  // The guarantee is worth more than a naming convention: read the call site
  // and check the gate sits inside the `action === 'buy'` block, so a sell
  // can never reach it.
  const src = fs.readFileSync(new URL('../electron/engine/liveSigner.ts', import.meta.url), 'utf8');
  const buyBlock = src.slice(src.indexOf("if (p.action === 'buy') {"));
  const gate = buyBlock.indexOf('if (seized())');
  assert.ok(gate > 0, 'the seize gate is inside the buy block');
  // Nothing before the buy block may call it.
  const beforeBuy = src.slice(0, src.indexOf("if (p.action === 'buy') {"));
  assert.ok(!/seized\(\)/.test(beforeBuy), 'no seize check runs before the action is known to be a buy');
  assert.equal((src.match(/seized\(\)/g) ?? []).length, 1, 'exactly one seize gate in the trade path');
});

ok('self-heal: if tampering stops being detected, corrosion resets to zero', () => {
  __setForTest(4, 0);
  __advance(GRACE_MS + RAMP_MS); // corroded
  assert.ok(level() > 0);
  __setForTest(0, GRACE_MS + RAMP_MS * 2); // now clean again
  assert.equal(level(), 0, 'a clean signal must fully reset — no lingering penalty');
  __reset();
});

console.log(`canary: ${passed}/${passed} tests passed`);
