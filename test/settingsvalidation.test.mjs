// settings:update validation — the renderer-side half of the drain chain.
// `Partial<AppSettings>` is a compile-time claim; at runtime anything can
// arrive on that channel. These pin the runtime rule.

import assert from 'node:assert/strict';
import { validateSettingsPatch as v } from './.settingsvalidation.mjs';

// Ordinary updates pass through unchanged.
{
  const r = v({ execution: { maxLiveSol: 0.05 } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.patch.execution.maxLiveSol, 0.05);
  console.log('ok  a normal patch passes');
}

{
  const r = v({ recorderEnabled: false });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.patch.recorderEnabled, false);
  console.log('ok  top-level boolean passes');
}

// Unknown keys are dropped, not accepted and not fatal.
{
  const r = v({ recorderEnabled: true, __proto__hack: 1, totallyMadeUp: 'x' });
  assert.equal(r.ok, true, r.message);
  assert.equal('totallyMadeUp' in r.patch, false);
  assert.equal('__proto__hack' in r.patch, false);
  console.log('ok  unknown top-level keys are dropped');
}

{
  const r = v({ execution: { maxLiveSol: 0.05, secretBackdoor: true } });
  assert.equal(r.ok, true, r.message);
  assert.equal('secretBackdoor' in r.patch.execution, false);
  console.log('ok  unknown nested keys are dropped');
}

// Type confusion is rejected.
{
  assert.equal(v({ execution: { maxLiveSol: '999999' } }).ok, false);
  assert.equal(v({ recorderEnabled: 'yes' }).ok, false);
  assert.equal(v({ execution: 'not an object' }).ok, false);
  assert.equal(v(null).ok, false);
  assert.equal(v('string').ok, false);
  assert.equal(v([1, 2, 3]).ok, false);
  console.log('ok  type confusion is rejected');
}

// The money-critical bounds hold.
{
  assert.equal(v({ execution: { maxLiveSol: 1_000_000 } }).ok, false);
  assert.equal(v({ execution: { maxLiveSol: -1 } }).ok, false);
  assert.equal(v({ execution: { maxLiveSol: NaN } }).ok, false);
  assert.equal(v({ execution: { maxLiveSol: Infinity } }).ok, false);
  assert.equal(v({ execution: { liveSlippagePct: 100 } }).ok, false);
  assert.equal(v({ execution: { maxLiveSessionLossSol: 99_999 } }).ok, false);
  console.log('ok  out-of-range money values are rejected');
}

{
  assert.equal(v({ execution: { maxLiveConsecutiveLosses: 2.5 } }).ok, false);
  assert.equal(v({ execution: { maxLiveConsecutiveLosses: 3 } }).ok, true);
  console.log('ok  integer-only fields reject fractions');
}

// Enums are closed.
{
  assert.equal(v({ execution: { feeUrgency: 'competitive' } }).ok, true);
  assert.equal(v({ execution: { feeUrgency: 'ludicrous' } }).ok, false);
  assert.equal(v({ execution: { jitoTipPercentile: 75 } }).ok, true);
  assert.equal(v({ execution: { jitoTipPercentile: 99 } }).ok, false);
  console.log('ok  enum fields are closed');
}

// The migration stamp is not renderer-writable.
{
  const r = v({ settingsRevision: 0, recorderEnabled: true });
  assert.equal(r.ok, true, r.message);
  assert.equal('settingsRevision' in r.patch, false);
  console.log('ok  settingsRevision cannot be set from the renderer');
}

// Unbounded strings are rejected (log/disk amplification).
{
  assert.equal(v({ recorderDir: 'x'.repeat(5000) }).ok, false);
  console.log('ok  oversized strings are rejected');
}

console.log('settingsvalidation: all tests passed');

// The trading mode is NOT a setting. Live is the default (2026-08-29) and the
// only way to change it is live:setLive, which arms/disarms the engine in the
// same step — a raw patch would let the persisted bit lie about the engine.
//
// It is STRIPPED from a patch rather than rejecting one. Rejecting looked
// stricter but was worse: every panel that edits a sibling execution field
// sends `{ execution: { ...settings.execution, field: value } }`, so the
// spread carried liveEnabled along and the whole save failed. A user
// reported exactly that on 2026-09-06 — "use the Paper/Live switch" while
// already in Live, trying to change something else entirely.
{
  const r = v({ execution: { liveEnabled: false } });
  assert.equal(r.ok, true, 'sending it is not an error');
  assert.equal('liveEnabled' in (r.patch?.execution ?? {}), false, 'but it never reaches the store');
  assert.deepEqual(r.stripped, ['execution.liveEnabled']);
  console.log('ok  execution.liveEnabled never reaches the store from a patch');
}
{
  // The exact shape every Execution/Wallet toggle sends.
  const r = v({ execution: { liveEnabled: true, maxLiveSol: 0.02, mevMode: 'private' } });
  assert.equal(r.ok, true, 'a normal save is not held hostage by the mode bit riding along');
  assert.equal(r.patch.execution.maxLiveSol, 0.02, 'the field the user actually changed is saved');
  assert.equal(r.patch.execution.mevMode, 'private');
  assert.equal('liveEnabled' in r.patch.execution, false, 'and the mode bit is still dropped');
  console.log('ok  a spread patch saves its real edits and drops the mode bit');
}
{
  // Stripping only works because the store merges a patch KEY BY KEY. If it
  // replaced the execution object wholesale, a patch that no longer carries
  // liveEnabled would silently drop a Live user into Paper — a far worse bug
  // than the one being fixed. Pinned here because that merge is what makes
  // dropping the field safe.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../electron/system/settings-store.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /execution: \{ \.\.\.cur\.execution, \.\.\.\(patch\.execution \?\? \{\}\) \}/,
    'a patch must merge into the stored execution settings, never replace them',
  );
  console.log('ok  omitting the mode bit leaves the stored one untouched');
}
{
  // Stripping must not become a way to launder a bad value: the rest of the
  // patch is still checked.
  const r = v({ execution: { liveEnabled: true, maxLiveSol: 999 } });
  assert.equal(r.ok, false, 'an out-of-range sibling is still rejected');
  assert.match(r.message, /maxLiveSol/);
  console.log('ok  dropping the mode bit does not weaken any other check');
}

// Migration to revision 3 turns the OLD breaker defaults off exactly once and
// leaves a user's own numbers alone; earlier steps must not re-fire.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../electron/system/settings-store.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(fromRevision < 2\) \{/, 'revision-2 step is gated');
  assert.match(src, /if \(fromRevision < 3\) \{/, 'revision-3 step exists');
  assert.match(src, /maxLiveConsecutiveLosses === 2\) s\.execution\.maxLiveConsecutiveLosses = 0/);
  assert.match(src, /maxLiveSessionLossSol === 0\.03\) s\.execution\.maxLiveSessionLossSol = 0/);
  assert.match(src, /if \(fromRevision < 4\) \{/, 'revision-4 step exists');
  assert.match(src, /s\.execution\.localTxBuild = true;/, 'revision 4 turns the local builder on');
  const types = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(fromRevision < 5\) \{/, 'revision-5 step exists');
  assert.match(types, /SETTINGS_REVISION = 5;/);
  assert.match(types, /localTxBuild: true,/, 'local builder is the default');
  console.log('ok  revision-3 migration disables only the old breaker defaults, gated by revision');
  console.log('ok  revision-4 migration turns the local builder on; default is on');
}

// ── List settings are checked as lists ────────────────────────────────
{
  // typeof [] === typeof {} === 'object', so an object used to pass wherever
  // the default is an array and persist a value the engine throws on.
  const bad = v({ rpc: { extraWssUrls: { 0: 'wss://evil' } } });
  assert.equal(bad.ok, false, 'an object is not a list');
  assert.match(bad.message, /expected a list/);

  const nulled = v({ rpc: { extraWssUrls: null } });
  assert.equal(nulled.ok, false, 'null is not a list either');

  const wrongElem = v({ rpc: { extraWssUrls: [1, 2, 3] } });
  assert.equal(wrongElem.ok, false, 'numbers are not urls');
  assert.match(wrongElem.message, /expected string/);

  const tooMany = v({ rpc: { extraWssUrls: Array.from({ length: 33 }, () => 'wss://a') } });
  assert.equal(tooMany.ok, false, 'the list is bounded');
  assert.match(tooMany.message, /at most 32/);

  const good = v({ rpc: { extraWssUrls: ['wss://one', 'wss://two'] } });
  assert.equal(good.ok, true, good.message);
  console.log('ok  list settings reject objects, null, wrong element types and unbounded length');
}
