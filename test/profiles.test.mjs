// Profiles (2026-09-26) — isolated copies of the app, one userData folder each.
//
// Three layers: the pure rules (shared/profiles.ts), the disk module run
// against a scratch appData (electron/system/profiles.ts has no electron
// import, so it runs here as-is), and source pins on main.ts for the two
// things a unit test cannot see — the lock is taken AFTER the profile folder
// is set, and nothing but a registry id can choose that folder.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from './.profilesshared.mjs';
import * as M from './.profilesmain.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// ── Pure rules ──────────────────────────────────────────────────────────
{
  for (const good of ['paper', 'a', 'paper-2', 'x1', 'abc-def-9']) assert.ok(P.isProfileId(good), good);
  for (const bad of ['', 'default', 'Paper', '-a', 'a-', '..', '../x', 'a/b', 'a\\b', 'C:', 'c:\\x', 'con', 'lpt3', 'a'.repeat(33), 'a b', 'a.b', null, 5]) {
    assert.ok(!P.isProfileId(bad), `refuses ${JSON.stringify(bad)}`);
  }
  ok('ids are short lowercase slugs; separators, dots, drive letters and Windows device names never match');
}
{
  const a = (argv, env) => P.parseProfileArg(argv, env);
  assert.deepEqual(a(['app.exe']), { kind: 'none' });
  assert.deepEqual(a(['app.exe', '--profile=paper']), { kind: 'id', id: 'paper' });
  assert.deepEqual(a(['app.exe', '--profile=default']), { kind: 'default' });
  assert.deepEqual(a(['app.exe', '--profile="paper"']), { kind: 'id', id: 'paper' });
  assert.deepEqual(a(['app.exe', '--profile=paper', '--profile=paper']), { kind: 'id', id: 'paper' });
  assert.equal(a(['app.exe', '--profile=paper', '--profile=live']).kind, 'invalid', 'two different profiles are ambiguous');
  assert.equal(a(['app.exe', '--profile', 'paper']).kind, 'invalid', 'the space form is refused, not guessed');
  // THE hardening rule: a path is never a profile.
  for (const raw of ['C:\\Users\\x\\evil', '../../Roaming/Krypto Bot', '/tmp/x', '\\\\server\\share', 'paper/../..', '%APPDATA%']) {
    assert.equal(a(['app.exe', `--profile=${raw}`]).kind, 'invalid', `a path is refused: ${raw}`);
  }
  // Env fallback, only when argv names nothing.
  assert.deepEqual(a(['app.exe'], { KRYPTO_PROFILE: 'paper' }), { kind: 'id', id: 'paper' });
  assert.deepEqual(a(['app.exe', '--profile=live'], { KRYPTO_PROFILE: 'paper' }), { kind: 'id', id: 'live' });
  assert.equal(a(['app.exe'], { KRYPTO_PROFILE: 'C:\\x' }).kind, 'invalid');
  assert.equal(P.profileArgFor('paper'), '--profile=paper');
  assert.throws(() => P.profileArgFor('../x'));
  ok('--profile=<id> is the only form; paths, ambiguity and junk are refused; env is a fallback only');
}
{
  assert.equal(P.cleanProfileName('  Paper \u0000 tests \n'), 'Paper tests');
  assert.equal(P.cleanProfileName('   '), null);
  assert.equal(P.cleanProfileName(7), null);
  assert.equal(P.cleanProfileName('x'.repeat(100)).length, P.MAX_PROFILE_NAME);
  assert.equal(P.slugForName('Paper Tests!', []), 'paper-tests');
  assert.equal(P.slugForName('Paper Tests', ['paper-tests']), 'paper-tests-2');
  assert.equal(P.slugForName('Default', []), 'profile', 'the reserved id is never produced');
  assert.equal(P.slugForName('日本語', []), 'profile');
  assert.equal(P.slugForName('con', []), 'profile');
  assert.ok(P.isProfileId(P.slugForName('a'.repeat(80), [])));
  ok('names are cleaned and slugs are unique, valid and never reserved');
}
{
  // FAIL CLOSED: only a missing file is empty.
  assert.deepEqual(P.parseRegistry(null), { ok: true, registry: { version: 1, profiles: [] } });
  const good = P.serializeRegistry({ version: 1, profiles: [{ id: 'paper', name: 'Paper', createdAt: 1, colour: 'sky' }] });
  const r = P.parseRegistry(good);
  assert.ok(r.ok && r.registry.profiles[0].id === 'paper');
  for (const bad of [
    '',
    '{',
    '[]',
    '{"version":2,"profiles":[]}',
    '{"version":1}',
    '{"version":1,"profiles":[{"id":"../x","name":"x","createdAt":1}]}',
    '{"version":1,"profiles":[{"id":"a","name":"x","createdAt":1},{"id":"a","name":"y","createdAt":2}]}',
    '{"version":1,"profiles":[{"id":"a","name":"","createdAt":1}]}',
    '{"version":1,"profiles":[{"id":"a","name":"x"}]}',
    '{"version":1,"profiles":[null]}',
  ]) {
    assert.equal(P.parseRegistry(bad).ok, false, `refuses ${bad.slice(0, 60)}`);
  }
  ok('the registry parses fail-closed: every malformed shape is an error, never an empty list');
}
{
  const src = {
    bots: { telegram: { enabled: true, token: 'TG', ownerId: '1', pushAlerts: true }, discord: { enabled: true, token: 'DC', ownerId: '2', pushAlerts: false }, trading: { enabled: true, maxBuySol: 0.1 } },
    mcp: { enabled: true, access: 'live', port: 8787, token: 'secret', budget: { maxBuySol: 1 } },
    execution: { liveEnabled: true, maxLiveSol: 2 },
    recorderDir: 'D:\\rec',
    theme: 'gold',
  };
  const c = P.cloneSettings(src, { mcpPort: 8790 });
  assert.equal(c.bots.telegram.token, '');
  assert.equal(c.bots.telegram.enabled, false);
  assert.equal(c.bots.telegram.ownerId, null);
  assert.equal(c.bots.discord.token, '');
  assert.equal(c.bots.trading.enabled, false);
  assert.equal(c.bots.telegram.pushAlerts, true, 'unrelated bot prefs survive');
  assert.deepEqual([c.mcp.enabled, c.mcp.token, c.mcp.port, c.mcp.access], [false, '', 8790, 'read']);
  assert.deepEqual(c.mcp.budget, { maxBuySol: 1 });
  assert.equal(c.execution.liveEnabled, false, 'a clone starts in Paper');
  assert.equal(c.execution.maxLiveSol, 2);
  assert.equal(c.recorderDir, '', 'two recorders never share one folder');
  assert.equal(c.theme, 'gold');
  assert.equal(src.bots.telegram.token, 'TG', 'the source object is not mutated');
  assert.equal(P.pickMcpPort([8787, 8788, 8790]), 8789);
  const a = P.cloneAutomation({ version: 1, scripts: [{ id: 's1', enabled: true, mode: 'paper' }], runtime: { s1: { buysToday: 3 } }, killSwitch: true });
  assert.deepEqual(a.scripts.map((s) => s.enabled), [false]);
  assert.deepEqual(a.runtime, {});
  assert.equal(a.killSwitch, true);
  assert.equal(P.cloneAutomation({ nope: 1 }), null);
  const plain = P.duplicatePlan(false);
  const withW = P.duplicatePlan(true);
  for (const w of ['wallets.json', 'evm-wallets.json', 'pump-session.json', 'Local State']) {
    assert.ok(!plain.files.includes(w), `${w} is NOT copied by default`);
    assert.ok(withW.files.includes(w), `${w} is copied with "also copy wallets"`);
  }
  for (const never of ['fills.json', 'adv-orders.json', 'paper-positions.json', 'copytrade.json', 'krypto-mode.json', 'krypto-trader.json', 'bridge-inflight.json', 'evm-fills.json']) {
    assert.ok(!withW.files.includes(never), `${never} is never copied`);
  }
  ok('a clone loses bot tokens, the AI token and live mode, gets its own MCP port and recordings, scripts off; ledgers/orders never copied');
}
{
  assert.equal(P.windowTitle('Krypto Bot', null, 0), 'Krypto Bot', 'nothing changes for a user with no profiles');
  assert.equal(P.windowTitle('Krypto Bot', null, 2), 'Krypto Bot — Default');
  assert.equal(P.windowTitle('Krypto Bot', 'Paper', 2), 'Krypto Bot — Paper');
  assert.equal(P.shortcutFileName('Krypto Bot', 'a/b:c*?'), 'Krypto Bot - abc.lnk');
  ok('window titles name the profile; shortcut names are Windows-safe');
}

// ── The disk module, against a scratch appData ────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krypto-profiles-'));
const appData = path.join(tmp, 'AppData');
const def = path.join(appData, 'Krypto Bot');
fs.mkdirSync(def, { recursive: true });
const root = path.join(appData, 'Krypto Bot Profiles');
const pick = (argv) => M.selectAtStartup({ appData, defaultUserData: def, argv, env: {} });

try {
  {
    const r = pick(['exe']);
    assert.deepEqual(r, { ok: true, id: null, dir: def });
    assert.equal(M.currentProfile().name, 'Default');
    assert.equal(pick(['exe', '--profile=nope']).ok, false, 'an unknown id is refused, not created');
    assert.ok(!fs.existsSync(path.join(root, 'nope')));
    assert.equal(pick(['exe', `--profile=${def}`]).ok, false);
    pick(['exe']);
    ok('no flag = Default, untouched; an unknown id or a path is refused and creates nothing');
  }
  // Source profile content.
  fs.writeFileSync(path.join(def, 'wallets.json'), '{"secret":"x"}');
  fs.writeFileSync(path.join(def, 'Local State'), '{"os_crypt":{}}');
  fs.writeFileSync(path.join(def, 'fills.json'), '{"version":1,"fills":[]}');
  fs.writeFileSync(path.join(def, 'order-templates.json'), '{"t":1}');
  fs.writeFileSync(path.join(def, 'automation.json'), JSON.stringify({ version: 1, scripts: [{ id: 's', enabled: true }], runtime: { s: {} } }));
  fs.writeFileSync(path.join(def, 'watchlist.json'), '{"broken');
  fs.mkdirSync(path.join(def, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(def, 'Local Storage', 'leveldb', '000003.log'), 'ls');
  fs.writeFileSync(path.join(def, 'Local Storage', 'leveldb', 'LOCK'), '');
  fs.writeFileSync(path.join(def, 'settings.json'), JSON.stringify({ mcp: { port: 8787 } }));
  const settings = { bots: { telegram: { enabled: true, token: 'TG', ownerId: '1' } }, mcp: { port: 8787, token: 't', enabled: true }, execution: { liveEnabled: true } };

  let blankId;
  let cloneId;
  {
    const b = M.create('Blank One');
    assert.ok(b.ok, b.message);
    blankId = b.id;
    const s = JSON.parse(fs.readFileSync(path.join(root, blankId, 'settings.json'), 'utf8'));
    assert.equal(s.mcp.port, 8788, 'a blank profile gets its own MCP port');
    assert.equal(s.mcp.enabled, false);
    assert.ok(!fs.existsSync(path.join(root, blankId, 'legal-acceptance.jsonl')), 'a blank profile asks for the terms again');
    assert.equal(M.create('blank one').ok, false, 'names are unique, case-insensitively');
    assert.equal(M.create('Default').ok, false);
    ok('create: a blank folder, its own MCP port, registered, no name clashes');
  }
  {
    const d = M.duplicate('Clone', false, settings);
    assert.ok(d.ok, d.message);
    cloneId = d.id;
    const dir = path.join(root, cloneId);
    assert.ok(!fs.existsSync(path.join(dir, 'wallets.json')), 'wallets not copied by default');
    assert.ok(!fs.existsSync(path.join(dir, 'Local State')));
    assert.ok(!fs.existsSync(path.join(dir, 'fills.json')), 'the ledger is never copied');
    assert.equal(fs.readFileSync(path.join(dir, 'order-templates.json'), 'utf8'), '{"t":1}');
    assert.ok(!fs.existsSync(path.join(dir, 'watchlist.json')), 'a torn JSON file is skipped, not copied');
    assert.ok(d.skipped.some((x) => x.startsWith('watchlist.json')), 'and the skip is reported');
    assert.ok(fs.existsSync(path.join(dir, 'Local Storage', 'leveldb', '000003.log')), 'renderer storage (layouts) copied');
    assert.ok(!fs.existsSync(path.join(dir, 'Local Storage', 'leveldb', 'LOCK')), 'the source instance’s LOCK is not');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(s.bots.telegram.token, '');
    assert.equal(s.execution.liveEnabled, false);
    assert.ok(![8787, 8788].includes(s.mcp.port), `the clone's MCP port (${s.mcp.port}) is not one another profile uses`);
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'automation.json'), 'utf8'));
    assert.equal(a.scripts[0].enabled, false);
    const w = M.duplicate('Clone With Wallets', true, settings);
    assert.ok(w.ok, w.message);
    assert.ok(fs.existsSync(path.join(root, w.id, 'wallets.json')));
    assert.ok(fs.existsSync(path.join(root, w.id, 'Local State')), 'the safeStorage key goes with the wallets');
    ok('duplicate: settings made safe, scripts off, no ledger, no wallets unless asked, torn files skipped');
  }
  {
    assert.equal(M.rename(cloneId, 'Paper').ok, true);
    assert.equal(M.rename('default', 'x').ok, false, 'the Default keeps its name');
    assert.equal(M.rename(cloneId, 'Blank One').ok, false);
    const v = M.view();
    assert.equal(v.profiles[0].isDefault, true);
    assert.equal(v.profiles[0].isCurrent, true);
    assert.ok(v.profiles.some((p) => p.id === cloneId && p.name === 'Paper'));
    ok('rename: registry only, unique names, never the Default');
  }
  {
    // Opening a profile by flag, and the per-profile running marker.
    const r = pick(['exe', `--profile=${cloneId}`]);
    assert.deepEqual(r, { ok: true, id: cloneId, dir: path.join(root, cloneId) });
    assert.equal(M.currentProfile().name, 'Paper');
    M.markRunning();
    assert.ok(fs.existsSync(path.join(root, cloneId, 'instance.json')));
    pick(['exe']);
    assert.equal(M.view().profiles.find((p) => p.id === cloneId).running, true, 'a live pid marks the profile running');
    let trashed = [];
    const trash = async (p) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true });
    };
    assert.equal((await M.remove(cloneId, trash)).ok, false, 'a running profile cannot be deleted');
    assert.equal((await M.remove('default', trash)).ok, false, 'the Default can never be deleted');
    fs.writeFileSync(path.join(root, cloneId, 'instance.json'), JSON.stringify({ pid: 2 ** 30, startedAt: 0 }));
    const del = await M.remove(cloneId, trash);
    assert.ok(del.ok, del.message);
    assert.deepEqual(trashed, [path.join(root, cloneId)], 'the folder goes to the Recycle Bin, never erased by us');
    assert.equal(pick(['exe', `--profile=${cloneId}`]).ok, false, 'a deleted profile cannot be opened');
    ok('delete: never the Default, never this window, never a running one; folder to the Recycle Bin');
  }
  {
    // Fail closed: a corrupt registry refuses every change and survives byte for byte.
    const reg = path.join(root, 'profiles.json');
    fs.writeFileSync(reg, '{"version":1,"profiles":[{"id":');
    const before = fs.readFileSync(reg);
    assert.equal(M.create('Another').ok, false);
    assert.equal(M.duplicate('Another', false, settings).ok, false);
    assert.equal(M.rename(blankId, 'Z').ok, false);
    assert.equal((await M.remove(blankId, async () => undefined)).ok, false);
    assert.ok(M.view().registryError);
    assert.equal(pick(['exe', `--profile=${blankId}`]).ok, false, 'a profile cannot be opened blind');
    assert.deepEqual(fs.readFileSync(reg), before, 'the unreadable registry is untouched');
    assert.deepEqual(pick(['exe']), { ok: true, id: null, dir: def }, 'the Default still opens');
    ok('an unreadable registry is not an empty one: nothing changes, nothing overwritten, Default still opens');
  }
  {
    // A junction/symlink in place of a profile folder is refused.
    const reg = path.join(root, 'profiles.json');
    fs.writeFileSync(reg, P.serializeRegistry({ version: 1, profiles: [{ id: 'linked', name: 'Linked', createdAt: 1, colour: null }] }));
    const target = path.join(tmp, 'elsewhere');
    fs.mkdirSync(target);
    let linked = false;
    try {
      fs.symlinkSync(target, path.join(root, 'linked'), 'junction');
      linked = true;
    } catch {
      /* no permission to link here — nothing to test */
    }
    if (linked) {
      assert.equal(pick(['exe', '--profile=linked']).ok, false);
      ok('a profile folder that is a junction/symlink is refused');
    } else {
      console.log('  skip a junction could not be created on this machine');
    }
    assert.throws(() => M.dirFor('..'));
    assert.throws(() => M.dirFor('default'));
    assert.equal(M.dirFor('paper'), path.join(path.resolve(root), 'paper'));
    ok('dirFor only ever yields <root>/<id>');
  }
} finally {
  pick(['exe']);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Source pins ────────────────────────────────────────────────────────
{
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const sel = main.indexOf('profiles.selectAtStartup(');
  const setp = main.indexOf("app.setPath('userData', profileSel.dir)");
  const lock = main.indexOf('app.requestSingleInstanceLock()');
  const firstRead = main.indexOf("path.join(app.getPath('userData')");
  assert.ok(sel > 0 && setp > sel, 'main selects the profile, then sets userData to it');
  assert.ok(lock > setp, 'the single-instance lock is taken AFTER userData is the profile folder — that is what makes it per profile');
  assert.ok(firstRead > setp, 'nothing reads userData before the profile is set');
  assert.ok(/const gotLock = profileSel\.ok && app\.requestSingleInstanceLock\(\)/.test(main), 'a refused profile never takes a lock or boots');
  const setPaths = [...main.matchAll(/app\.setPath\('userData'/g)].map((m) => m.index);
  assert.ok(setPaths.every((i) => i < lock), 'userData is never moved after the lock');
  // No raw path from argv or env: main hands argv to the module, which only
  // ever builds <root>/<id> from a registry entry.
  assert.ok(!/process\.argv[^\n]*setPath|setPath\([^)]*argv/.test(main));
  const mod = fs.readFileSync(new URL('../electron/system/profiles.ts', import.meta.url), 'utf8');
  const selFn = mod.slice(mod.indexOf('export function selectAtStartup('), mod.indexOf('export function currentProfile('));
  assert.ok(selFn.includes('parseProfileArg(') && selFn.includes('dirFor(entry.id)'), 'the folder comes from dirFor(registry id)');
  assert.ok(!/path\.(resolve|join)\(\s*arg/.test(selFn), 'no path is built from the raw argument');
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');
  const block = ipc.slice(ipc.indexOf("ipcMain.handle('profiles:list'"), ipc.indexOf("ipcMain.handle('profiles:shortcut'") + 400);
  assert.ok(!/path\.(join|resolve)\(/.test(block), 'profile IPC handlers never build a path from renderer input');
  ok('source pins: per-profile lock after the profile folder, no raw path from argv/env/IPC');
}

console.log(`\nprofiles: ${passed}/${passed} passed`);
