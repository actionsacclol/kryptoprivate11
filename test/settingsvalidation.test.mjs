// settings:update validation — the renderer-side half of the drain chain.
// `Partial<AppSettings>` is a compile-time claim; at runtime anything can
// arrive on that channel. These pin the runtime rule.

import assert from 'node:assert/strict';
import { validateSettingsPatch as v } from './.settingsvalidation.mjs';
import { DEFAULT_SETTINGS, resolveRpc } from './.types.mjs';

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
  assert.equal(v({ execution: { maxLiveConsecutiveLosses: 51 } }).ok, false);
  assert.equal(v({ execution: { maxLiveConsecutiveLosses: -1 } }).ok, false);
  console.log('ok  integer-only fields reject fractions');
}

// 0 is "off" for both live breakers — the shipped default, and what the
// revision-3 migration writes. Until 2026-09-08 the streak bound started at
// 1, which rejected the default and with it every execution save.
{
  assert.equal(v({ execution: { maxLiveConsecutiveLosses: 0 } }).ok, true, 'streak breaker off');
  assert.equal(v({ execution: { maxLiveSessionLossSol: 0 } }).ok, true, 'session-loss breaker off');
  // What the auto-cashout switch actually sends: the stored block, spread.
  const r = v({ execution: { ...DEFAULT_SETTINGS.execution, autoCashout: true } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.patch.execution.autoCashout, true);
  assert.equal(r.patch.execution.maxLiveConsecutiveLosses, 0);
  console.log('ok  a breaker at 0 (off) passes, so an execution-block spread on defaults saves');
}

// Every shipped default passes its own bound — a default outside its bound
// blocks every panel that spreads the block it lives in.
{
  for (const [key, block] of Object.entries(DEFAULT_SETTINGS)) {
    if (key === 'settingsRevision') continue;
    const r = v({ [key]: block });
    assert.equal(r.ok, true, `default block "${key}" must validate: ${r.message}`);
  }
  console.log('ok  every default settings block passes validation');
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
  const src = fs.readFileSync(new URL('../electron/system/settings-store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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
  const src = fs.readFileSync(new URL('../electron/system/settings-store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /if \(fromRevision < 2\) \{/, 'revision-2 step is gated');
  assert.match(src, /if \(fromRevision < 3\) \{/, 'revision-3 step exists');
  assert.match(src, /maxLiveConsecutiveLosses === 2\) s\.execution\.maxLiveConsecutiveLosses = 0/);
  assert.match(src, /maxLiveSessionLossSol === 0\.03\) s\.execution\.maxLiveSessionLossSol = 0/);
  assert.match(src, /if \(fromRevision < 4\) \{/, 'revision-4 step exists');
  assert.match(src, /s\.execution\.localTxBuild = true;/, 'revision 4 turns the local builder on');
  const types = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /if \(fromRevision < 5\) \{/, 'revision-5 step exists');
  // Revision 6: Discord presence is on by default from 3.0.0, and revision 2
  // had turned it off for everyone — without this step the feature would be
  // "default on" for new installs only and silently off for every existing
  // user. The pinned number is what forces a migration to be WRITTEN when the
  // default changes, rather than the default quietly diverging from what is
  // already on disk.
  assert.match(src, /if \(fromRevision < 6\) \{/, 'revision-6 step exists');
  assert.match(src, /s\.discordRpcEnabled = true;/, 'revision 6 turns presence on');
  assert.match(types, /SETTINGS_REVISION = 6;/);
  assert.match(types, /discordRpcEnabled: true,/, 'presence is the default');
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

// Display settings (2026-09-08): two booleans a user reaches for after a
// blue screen. Both must pass as booleans and nothing else, and the
// hardware-acceleration one has to be read BEFORE Chromium is ready or the
// switch does nothing — pinned against main.ts.
{
  const good = v({ reduceEffects: true, hardwareAcceleration: false });
  assert.equal(good.ok, true, good.message);
  assert.equal(good.patch.reduceEffects, true);
  assert.equal(good.patch.hardwareAcceleration, false);
  assert.equal(v({ reduceEffects: 'yes' }).ok, false, 'a string is not a switch');
  assert.equal(v({ hardwareAcceleration: 0 }).ok, false, 'a number is not a switch');
  console.log('ok  the display switches are booleans and nothing else');
}

{
  const fs = await import('node:fs');
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const gate = main.indexOf('app.disableHardwareAcceleration()');
  const ready = main.indexOf('app.whenReady().then(bootstrap)');
  assert.ok(gate > 0 && ready > gate, 'hardware acceleration is decided before the app is ready');
  assert.match(main, /if \(!store\.load\(\)\.hardwareAcceleration\) \{\s*app\.disableHardwareAcceleration\(\)/, 'and only when the setting says so');
  assert.match(main, /app\.on\('child-process-gone'/, 'a dying GPU process is handled');
  assert.match(main, /store\.update\(\{ hardwareAcceleration: false \}\)/, 'and turns the setting off for the next start');
  console.log('ok  main.ts reads the GPU setting before ready and falls back after GPU crashes');
}

// A paired bot: pairing writes ownerId as a STRING over a null default, and
// every bots switch then spreads it back. Until 2026-09-08 that was "wrong
// type" — a paired user could not toggle push alerts or chat trading.
{
  const r = v({ bots: { ...DEFAULT_SETTINGS.bots, telegram: { ...DEFAULT_SETTINGS.bots.telegram, ownerId: '123456', pushAlerts: false } } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.patch.bots.telegram.ownerId, '123456');
  assert.equal(r.patch.bots.telegram.pushAlerts, false);
  assert.equal(v({ bots: { telegram: { ownerId: null } } }).ok, true, 'unpaired');
  assert.equal(v({ bots: { telegram: { ownerId: 123456 } } }).ok, false, 'a number is not an id');
  assert.equal(v({ bots: { telegram: { ownerId: { id: 1 } } } }).ok, false, 'nor an object');
  console.log('ok  a paired bot (string owner id over a null default) still saves');
}

// Third-level bounds and enums are enforced — they were dead rules.
{
  assert.equal(v({ strategy: { runnerAlerts: { maxPerHour: 0 } } }).ok, false);
  assert.equal(v({ strategy: { runnerAlerts: { maxPerHour: 2.5 } } }).ok, false);
  assert.equal(v({ strategy: { runnerAlerts: { maxPerHour: NaN } } }).ok, false);
  assert.equal(v({ strategy: { runnerAlerts: { maxPerHour: 12 } } }).ok, true);
  assert.equal(v({ strategy: { runnerAlerts: { minBucket: 'bogus' } } }).ok, false);
  assert.equal(v({ strategy: { runnerAlerts: { minBucket: 'top1' } } }).ok, true);
  // Four levels deep — the EVM chains' runner alerts. Until 2026-09-11 the
  // walk stopped one level short and every one of these saved.
  for (const chain of ['robinhood', 'bnb']) {
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { maxPerHour: 0 } } } }).ok, false, `${chain}: 0 an hour`);
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { maxPerHour: 99999 } } } }).ok, false, `${chain}: 99999 an hour`);
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { maxPerHour: 12 } } } }).ok, true);
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { minBucket: 99 } } } }).ok, false, `${chain}: bucket 99`);
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { minBucket: 'top1' } } } }).ok, false, `${chain}: a Solana bucket name`);
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { minBucket: 11 } } } }).ok, true);
    assert.equal(v({ evm: { [chain]: { runnerAlerts: { enabled: 'yes' } } } }).ok, false, `${chain}: a string for a boolean`);
    // And the endpoint: https or nothing, in main and not only on the page.
    assert.equal(v({ evm: { [chain]: { rpcUrl: 'http://rpc.example' } } }).ok, false, `${chain}: http endpoint`);
    assert.equal(v({ evm: { [chain]: { rpcUrl: 'https://rpc.example/v1' } } }).ok, true);
    assert.equal(v({ evm: { [chain]: { rpcUrl: '' } } }).ok, true, `${chain}: empty means the default`);
  }
  assert.equal(v({ bots: { trading: { maxBuySol: -1 } } }).ok, false);
  assert.equal(v({ bots: { trading: { maxBuySol: NaN } } }).ok, false);
  assert.equal(v({ bots: { trading: { maxBuySol: 0.1 } } }).ok, true);
  assert.equal(v({ bots: { trading: { requireConfirm: 'yes' } } }).ok, false, 'types still checked');
  console.log('ok  nested bounds and enums are enforced');
}

// The Helius feed socket is derived (key + switch) and never stored: the
// renderer hydrates from the RAW store, and a resolved copy that reached the
// store is dropped on load.
{
  const fs = await import('node:fs');
  const storeSrc = fs.readFileSync(new URL('../electron/system/settings-store.ts', import.meta.url), 'utf8');
  assert.match(storeSrc, /helius-rpc\\.com/, 'mergeState strips the derived feed socket from extraWssUrls');
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');
  assert.match(ipc, /'engine:snapshot'[^\n]*settings: store\.load\(\)/, 'the renderer hydrates from the raw store, not the resolved rpc');
  console.log('ok  the derived Helius socket never round-trips into settings.json');
}

// ── Discord webhooks: the ONE field that takes a URL from the renderer ─
//
// Everywhere else the main process refuses (the block-feed host is a pick
// from a hardcoded list for exactly this reason). A webhook is per user and
// unguessable by us, so it has to be typed in — and is pinned to Discord's
// own hosts instead. Without the allowlist this is a settings field that
// makes the app POST your flagged tokens to any host on the internet.

{
  const url = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf-ghijkl_MNOP';
  for (const patch of [
    { strategy: { runnerAlerts: { webhookUrl: url } } },
    { evm: { robinhood: { runnerAlerts: { webhookUrl: url } } } },
    { evm: { bnb: { runnerAlerts: { webhookUrl: url } } } },
  ]) {
    const r = v(patch);
    assert.equal(r.ok, true, r.message);
  }
  console.log('ok  a real Discord webhook URL is accepted on every chain');
}

{
  for (const url of [
    'https://discord.com/api/v10/webhooks/123456789012345678/tok',
    'https://discordapp.com/api/webhooks/123456789012345678/tok',
    'https://canary.discord.com/api/webhooks/123456789012345678/tok',
  ]) {
    const r = v({ strategy: { runnerAlerts: { webhookUrl: url } } });
    assert.equal(r.ok, true, `${url}: ${r.message}`);
  }
  console.log('ok  versioned paths, discordapp.com and canary. are accepted');
}

{
  // The field ships empty and every panel saves by spreading the stored
  // block, so the default has to pass its own rule (the 2026-09-08 trap).
  const r = v({ strategy: { runnerAlerts: { webhookUrl: '' } } });
  assert.equal(r.ok, true, r.message);
  console.log('ok  the empty string is OFF, not an error');
}

{
  for (const url of [
    'https://example.com/api/webhooks/1/2',
    'https://discord.com.evil.test/api/webhooks/1/2',
    'https://notdiscord.com/api/webhooks/1/2',
    'https://hooks.slack.com/services/T/B/x',
    'http://discord.com/api/webhooks/1/2',
    'https://127.0.0.1/api/webhooks/1/2',
    'https://localhost:8080/api/webhooks/1/2',
  ]) {
    const r = v({ strategy: { runnerAlerts: { webhookUrl: url } } });
    assert.equal(r.ok, false, `${url} MUST be refused`);
  }
  console.log('ok  every other host is refused — the whole safety of the feature');
}

{
  for (const url of [
    'https://discord.com/channels/123/456',
    'https://discord.com/api/users/@me',
    'https://discord.com/api/webhooks/123',
    'not a url at all',
  ]) {
    const r = v({ strategy: { runnerAlerts: { webhookUrl: url } } });
    assert.equal(r.ok, false, `${url} MUST be refused`);
  }
  console.log('ok  a Discord URL that is not a webhook is refused');
}

{
  // A refusal has to NAME the field. The panels all save by spreading the
  // stored block, and an unexplained rejection is the shape of the bug that
  // made execution settings unsaveable for a whole release (2026-09-06).
  const r = v({ strategy: { runnerAlerts: { webhookUrl: 'https://evil.test/x', maxPerHour: 5 } } });
  assert.equal(r.ok, false);
  assert.match(r.message, /webhookUrl/);
  console.log('ok  a webhook refusal names the field');
}

// ── The execution endpoint (2026-09-15) ──────────────────────────────
//
// `rpc.fastHttpUrl` is the fast lane for a provider of your own, and it is
// what every live buy and sell goes through. A bad value here is not a
// cosmetic problem: an http:// paste used to be exactly how an EVM endpoint
// silently fell back to the public one.

{
  const r = v({ rpc: { ...DEFAULT_SETTINGS.rpc, fastHttpUrl: 'https://my.endpoint.example/?api-key=abc' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.patch.rpc.fastHttpUrl, 'https://my.endpoint.example/?api-key=abc');
  console.log('ok  an https execution endpoint is accepted');
}

{
  for (const bad of ['http://my.endpoint.example', 'ws://nope', 'not a url']) {
    const r = v({ rpc: { ...DEFAULT_SETTINGS.rpc, fastHttpUrl: bad } });
    assert.equal(r.ok, false, `${bad} MUST be refused`);
    assert.match(r.message, /fastHttpUrl/, 'and the refusal names the field');
  }
  // Empty is the default and means "nothing changes" — it must always save,
  // or clearing the field would be impossible.
  assert.equal(v({ rpc: { ...DEFAULT_SETTINGS.rpc, fastHttpUrl: '' } }).ok, true);
  console.log('ok  a non-https execution endpoint is refused, and empty always saves');
}

{
  // The other two Solana URLs are deliberately NOT held to https: people run
  // a local validator, and http://127.0.0.1 is a legitimate httpUrl.
  const r = v({ rpc: { ...DEFAULT_SETTINGS.rpc, httpUrl: 'http://127.0.0.1:8899' } });
  assert.equal(r.ok, true, r.message);
  console.log('ok  a local validator is still a valid plain endpoint');
}

{
  // What actually decides where an order goes.
  const base = { ...DEFAULT_SETTINGS.rpc };
  assert.equal(resolveRpc(base).execHttpUrl, undefined, 'nothing configured = no fast lane, as before');

  const keyed = resolveRpc({ ...base, heliusApiKey: 'KEY123456' });
  assert.match(keyed.execHttpUrl, /helius-rpc\.com/, 'a key still derives the lane');

  const own = resolveRpc({ ...base, fastHttpUrl: 'https://mine.example/rpc' });
  assert.equal(own.execHttpUrl, 'https://mine.example/rpc', 'a typed endpoint fills it with no key at all');

  // A URL someone typed WINS over a key they also happen to have: silently
  // preferring the key would make the field a lie.
  const both = resolveRpc({ ...base, heliusApiKey: 'KEY123456', fastHttpUrl: 'https://mine.example/rpc' });
  assert.equal(both.execHttpUrl, 'https://mine.example/rpc');
  console.log('ok  resolveRpc: a typed execution endpoint wins over a derived one');
}

{
  // The round-trip trap (2026-09-08): a RESOLVED rpc block must never be
  // persisted, so the derived field is not something the validator accepts.
  const resolved = resolveRpc({ ...DEFAULT_SETTINGS.rpc, heliusApiKey: 'KEY123456' });
  const r = v({ rpc: resolved });
  assert.equal(r.ok, true, r.message);
  assert.equal('execHttpUrl' in r.patch.rpc, false, 'the derived lane is dropped, never stored');
  console.log('ok  a resolved rpc block round-trips without persisting the derived endpoint');
}

{
  // The scanner's curve-variant filter. An enum, so a junk value must be
  // refused rather than silently becoming "hide everything".
  for (const m of ['all', 'standard', 'mayhem']) {
    assert.equal(v({ strategy: { ...DEFAULT_SETTINGS.strategy, mayhemFilter: m } }).ok, true, m);
  }
  assert.equal(v({ strategy: { ...DEFAULT_SETTINGS.strategy, mayhemFilter: 'none' } }).ok, false);
  console.log('ok  the mayhem filter takes its three modes and refuses anything else');
}
