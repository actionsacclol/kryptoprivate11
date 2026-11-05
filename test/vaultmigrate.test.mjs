// Turning the app password on and off: the one step in the app that can lose
// every key at once. The real modules, against real files, with only the OS key
// store stubbed.
//
// The centre of this file is the crash test. It kills the move at EVERY single
// disk operation, in both directions, restarts, and checks that each key still
// opens to its own address. Throwaway keys only.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// Node never frees an imported module, and the crash loops restart hundreds of
// times. So the harness leaves npm packages out of its bundle (--packages=external
// in test-steps.json): they load once, and only the app's own modules, which hold
// the state a restart has to reset, are made again. Bundled, this file passed 2 GB
// of heap and died on the macOS runner.
let gen = 0;
const restart =async () => import(`./.vaultharness.mjs?v=${gen++}`);

const freshDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-vault-'));
  process.env.KRYPT_TEST_USERDATA = dir;
  return dir;
};

const PASSWORD = 'correct horse battery staple';
// A published test phrase, never to hold anything.
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

/** A profile with every kind of key: two Solana, one EVM, one All-in-One. */
async function seedProfile() {
  const dir = freshDir();
  const h = await restart();
  assert.equal(h.wallet.generate('One').ok, true);
  assert.equal(h.wallet.generate('Two').ok, true);
  assert.equal(h.evmWallet.generate('Evm', 'robinhood').ok, true);
  const a = h.aioWallet.importPhrase(PHRASE, 'Everything');
  assert.equal(a.ok, true, a.message);
  return { dir, h, keys: snapshot(h) };
}

const snapshot = (h) => ({
  solana: h.wallet.list().map((w) => w.publicKey).sort(),
  evm: h.evmWallet.list('robinhood').map((w) => w.address).sort(),
  aio: h.aioWallet.info().solanaAddress,
});

/** Every key opens to its own address. This is the whole point. */
function assertAllKeysOpen(h, keys, where) {
  assert.deepEqual(h.wallet.unusableKeys(), [], `${where}: a Solana key does not open`);
  assert.deepEqual(h.evmWallet.unusableKeys(), [], `${where}: an EVM key does not open`);
  assert.equal(h.aioWallet.phraseProblem(), null, `${where}: the phrase does not open`);
  assert.deepEqual(snapshot(h), keys, `${where}: the list of keys changed`);
}

const preVaultLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.pre-vault'));

// ── Disk faults ────────────────────────────────────────────────────────

const real = { renameSync: fs.renameSync, writeSync: fs.writeSync, unlinkSync: fs.unlinkSync };
class Crash extends Error {}

/** After `after` disk operations, every later one fails. To the code that is a
 *  dying process: no write after the fault lands, whatever it tries. */
function crashAfter(after) {
  let n = 0;
  const hit = () => {
    if (n++ >= after) throw new Crash(`simulated crash at operation ${after}`);
  };
  fs.renameSync = (...a) => (hit(), real.renameSync(...a));
  fs.writeSync = (...a) => (hit(), real.writeSync(...a));
  fs.unlinkSync = (...a) => (hit(), real.unlinkSync(...a));
  return () => n;
}

/** Only operation `at` fails, and everything after works: the clean-up runs. */
function failOnce(at) {
  let n = 0;
  const hit = () => {
    if (n++ === at) throw new Crash(`simulated fault at operation ${at}`);
  };
  fs.renameSync = (...a) => (hit(), real.renameSync(...a));
  fs.writeSync = (...a) => (hit(), real.writeSync(...a));
  fs.unlinkSync = (...a) => (hit(), real.unlinkSync(...a));
  return () => n;
}

function restoreFs() {
  Object.assign(fs, real);
}

const copyDir = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
};

// One scrypt setup is about a second, so it is shared by the crash loops.
let sharedPrepared = null;
async function prepared(h) {
  if (!sharedPrepared) {
    sharedPrepared = await h.vault.prepare(PASSWORD);
    // The real work factor is about a second per unlock, and the crash loops
    // unlock hundreds of times. This file is about the files, so its vault is
    // rewrapped at the lowest setting the app accepts. security.test.mjs runs the
    // real one, and the live run runs it under Electron.
    const c = h.crypto_;
    const kdf = c.newKdfParams(2 ** 14);
    const kek = await c.deriveKey(PASSWORD, kdf);
    const wrapped = c.aesSeal(kek, sharedPrepared.key, c.aad.dekPassword).toString('base64');
    sharedPrepared.vault.password = { kdf, dpapiSealed: Buffer.from(`stub:${wrapped}`, 'utf8').toString('base64') };
  }
  return { ...sharedPrepared, key: Buffer.from(sharedPrepared.key), vault: { ...sharedPrepared.vault } };
}

// ── The ordinary path ──────────────────────────────────────────────────

test('turning the password on encrypts every key and leaves no old format behind', async () => {
  const { dir, h, keys } = await seedProfile();
  const r = h.vaultMigrate.enable(await prepared(h));
  assert.equal(r.ok, true, r.message);
  assertAllKeysOpen(h, keys, 'after enable');
  for (const name of ['wallets.json', 'wallets.json.bak', 'evm-wallets.json', 'evm-wallets.json.bak', 'aio-wallet.json', 'aio-wallet.json.bak']) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    // The stub seals as "stub:<hex>" in base64, so any OS-key-store copy of a key
    // still on disk, in a main file or a backup, shows up here.
    assert.ok(!text.includes(Buffer.from('stub:').toString('base64').slice(0, 6)), `${name} still holds an OS-key-store record`);
  }
  assert.ok(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8').includes('kv1:'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8')).version, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'evm-wallets.json'), 'utf8')).version, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'aio-wallet.json'), 'utf8')).version, 2);
  assert.deepEqual(preVaultLeftovers(dir), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')).state, 'active');
});

test('after a restart nothing opens until the password goes in', async () => {
  const { h, keys } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  const next = await restart();
  assert.equal(next.vault.status(), 'sealed');
  assert.throws(() => next.vault.open('kv1:AAAA', 'x'), /locked/);
  assert.ok(next.wallet.unusableKeys().length > 0, 'a sealed vault must not open keys');
  assert.equal((await next.vault.unlock('wrong password entirely')).reason, 'wrong-password');
  assert.equal(next.vault.status(), 'sealed');
  assert.equal((await next.vault.unlock(PASSWORD)).ok, true);
  assertAllKeysOpen(next, keys, 'after unlock');
});

test('a wallet made after the password is set is encrypted with it', async () => {
  const { dir, h } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  const made = h.wallet.generate('New');
  assert.equal(made.ok, true, made.message);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8')).wallets.find((w) => w.publicKey === made.publicKey);
  assert.ok(stored.secretEnc.startsWith('kv1:'));
  const next = await restart();
  await next.vault.unlock(PASSWORD);
  assert.deepEqual(next.wallet.unusableKeys(), []);
});

test('a removed wallet leaves its key in neither the file nor the backup', async () => {
  const { dir, h } = await seedProfile();
  const target = h.wallet.list()[0];
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8')).wallets.find((w) => w.publicKey === target.publicKey).secretEnc;
  assert.equal(h.wallet.remove(target.id).ok, true);
  for (const name of ['wallets.json', 'wallets.json.bak']) {
    assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes(before), `${name} still holds the removed key`);
  }
});

test('a file being removed is never left half-gone under its own name', async () => {
  const { dir, h } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  // Crash between the zeroing and the unlink. The real name must already be free.
  const victim = path.join(dir, 'vault.json');
  const original = fs.readFileSync(victim);
  fs.writeFileSync(`${victim}.bak`, original);
  crashAfter(2); // the rename and the zeroing land, the unlink does not
  let threw = null;
  try {
    h.vault.commitDisable();
  } catch (e) {
    threw = e;
  }
  restoreFs();
  assert.ok(threw instanceof Crash);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.dead'));
  assert.ok(leftovers.length > 0, 'it stopped where this test meant it to');
  const next = await restart();
  next.vault.status();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.dead')), [], 'scrubbed at the next start');
});

test('turning it off puts every key back under the OS key store, and the vault is gone', async () => {
  const { dir, h, keys } = await seedProfile();
  const untouched = fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8');
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  const r = h.vaultMigrate.disable();
  assert.equal(r.ok, true, r.message);
  assertAllKeysOpen(h, keys, 'after disable');
  assert.equal(h.vault.status(), 'none');
  assert.ok(!fs.existsSync(path.join(dir, 'vault.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'vault.json.bak')));
  assert.ok(!fs.existsSync(path.join(dir, 'security.json')));
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8'));
  assert.equal(after.version, 2);
  assert.deepEqual(after.wallets.map((w) => w.secretEnc), JSON.parse(untouched).wallets.map((w) => w.secretEnc), 'the same OS-key-store bytes as before');
  const next = await restart();
  assert.equal(next.vault.status(), 'none');
  assertAllKeysOpen(next, keys, 'after disable and restart');
});

test('a key that will not open stops the whole move before anything changes', async () => {
  const { dir, h } = await seedProfile();
  const p = path.join(dir, 'wallets.json');
  const f = JSON.parse(fs.readFileSync(p, 'utf8'));
  f.wallets[1].secretEnc = f.wallets[0].secretEnc; // the key of a different wallet
  fs.writeFileSync(p, JSON.stringify(f));
  const before = fs.readFileSync(p);
  const next = await restart();
  const r = next.vaultMigrate.enable(await prepared(next));
  assert.equal(r.ok, false);
  assert.match(r.message, /does not match its address/);
  assert.ok(fs.readFileSync(p).equals(before), 'the file must be untouched');
  assert.equal(next.vault.status(), 'none');
});

test('an unreadable wallet file refuses the move and is left alone', async () => {
  const { dir } = await seedProfile();
  const p = path.join(dir, 'evm-wallets.json');
  fs.writeFileSync(p, '{"version":1,"wal');
  fs.rmSync(`${p}.bak`, { force: true });
  const next = await restart();
  const r = next.vaultMigrate.enable(await prepared(next));
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"version":1,"wal');
});

// ── Crash at every write ───────────────────────────────────────────────

async function checkAfterCrash(dir, keys, where) {
  restoreFs();
  const h = await restart();
  const status = h.vault.status();
  assert.ok(status === 'none' || status === 'sealed', `${where}: vault is ${status} (${h.vault.brokenReason()})`);
  if (status === 'sealed') assert.equal((await h.vault.unlock(PASSWORD)).ok, true, `${where}: the password no longer opens it`);
  assertAllKeysOpen(h, keys, where);
  assert.deepEqual(preVaultLeftovers(dir), [], `${where}: temporary copies were left behind`);
  return status;
}

/** Run `move` once clean to count its disk operations. */
async function countOperations(baseDir, runMove) {
  const dir = path.join(baseDir, 'count');
  copyDir(path.join(baseDir, 'base'), dir);
  process.env.KRYPT_TEST_USERDATA = dir;
  const h = await restart();
  await settle(h);
  const count = failOnce(Number.MAX_SAFE_INTEGER);
  const r = await runMove(h);
  restoreFs();
  assert.equal(r.ok, true, r.message);
  return count();
}

async function settle(h) {
  if (h.vault.status() === 'sealed') assert.equal((await h.vault.unlock(PASSWORD)).ok, true);
}

async function crashLoop(label, baseDir, keys, runMove, statusesExpected) {
  const total = await countOperations(baseDir, runMove);
  assert.ok(total > 8, `expected a real number of writes, counted ${total}`);
  const seen = new Set();
  for (let at = 0; at < total; at++) {
    const dir = path.join(baseDir, 'run');
    copyDir(path.join(baseDir, 'base'), dir);
    process.env.KRYPT_TEST_USERDATA = dir;
    const h = await restart();
    await settle(h);
    crashAfter(at);
    let threw = null;
    try {
      await runMove(h);
    } catch (e) {
      threw = e;
    }
    if (threw && !(threw instanceof Crash)) throw threw;
    restoreFs();
    // The recovery itself can be interrupted too: a second crash, partway through
    // putting things right at the next start, must cost nothing either.
    const during = at % 11;
    crashAfter(during);
    try {
      const interrupted = await restart();
      interrupted.vault.status();
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
    }
    seen.add(await checkAfterCrash(dir, keys, `${label}, crash at operation ${at} of ${total}, then at ${during} of the recovery`));

    // Now a fault that the running process survives and cleans up after.
    copyDir(path.join(baseDir, 'base'), dir);
    const g = await restart();
    await settle(g);
    failOnce(at);
    let r = null;
    try {
      r = await runMove(g);
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
    }
    restoreFs();
    if (r) assertAllKeysOpen(g, keys, `${label}, fault at operation ${at}, same process`);
    await checkAfterCrash(dir, keys, `${label}, fault at operation ${at}, after restart`);
  }
  for (const s of statusesExpected) assert.ok(seen.has(s), `${label}: never ended in state ${s}, so the loop did not cross the commit`);
  return total;
}

test('turning the password ON survives a crash at every single disk operation', async () => {
  const { dir, h, keys } = await seedProfile();
  await prepared(h);
  const base = path.join(dir, '..', `${path.basename(dir)}-on`);
  fs.mkdirSync(base);
  copyDir(dir, path.join(base, 'base'));
  const total = await crashLoop('enable', base, keys, async (x) => x.vaultMigrate.enable(await prepared(x)), ['none', 'sealed']);
  console.log(`  crashed the turn-on at each of ${total} disk operations`);
});

test('turning the password OFF survives a crash at every single disk operation', async () => {
  const { dir, h, keys } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  const base = path.join(dir, '..', `${path.basename(dir)}-off`);
  fs.mkdirSync(base);
  copyDir(dir, path.join(base, 'base'));
  const total = await crashLoop('disable', base, keys, async (x) => x.vaultMigrate.disable(), ['none', 'sealed']);
  console.log(`  crashed the turn-off at each of ${total} disk operations`);
});

// ── Old files ──────────────────────────────────────────────────────────

test('a key found only in the old wallet.json moves into the vault before the file goes', async () => {
  const { dir, h } = await seedProfile();
  const orphan = await restart();
  const seedDir = freshDir();
  const other = await restart();
  other.wallet.generate('Old');
  const old = JSON.parse(fs.readFileSync(path.join(seedDir, 'wallets.json'), 'utf8')).wallets[0];
  process.env.KRYPT_TEST_USERDATA = dir;
  assert.ok(orphan);
  const legacy = path.join(dir, 'wallet.json');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, publicKey: old.publicKey, secretEnc: old.secretEnc, homeAddress: null, maxBalanceSol: 2, createdAt: 1 }));
  const next = await restart();
  assert.equal(next.vaultMigrate.enable(await prepared(next)).ok, true);
  assert.ok(!fs.existsSync(legacy), 'the unprotected copy is gone');
  assert.deepEqual(next.vault.orphans().map((o) => o.publicKey), [old.publicKey], 'the key was not lost');
  assert.ok(next.keyExport.collectPayload().solana.some((w) => w.publicKey === old.publicKey), 'and it is in the backup');
  // Turning the password off gives it a home in the wallet list.
  assert.equal(next.vaultMigrate.disable().ok, true);
  assert.ok(next.wallet.list().some((w) => w.publicKey === old.publicKey));
  assert.ok(h);
});

test('a copy of a key already in the list is removed with wallet.json', async () => {
  const { dir, h } = await seedProfile();
  const held = JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8')).wallets[0];
  const legacy = path.join(dir, 'wallet.json');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, publicKey: held.publicKey, secretEnc: held.secretEnc, homeAddress: null, maxBalanceSol: 2, createdAt: 1 }));
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  assert.ok(!fs.existsSync(legacy));
  assert.deepEqual(h.vault.orphans(), []);
});

test('an unreadable wallet.json is left in place and reported', async () => {
  const { dir, h } = await seedProfile();
  const legacy = path.join(dir, 'wallet.json');
  fs.writeFileSync(legacy, 'not json');
  const r = h.vaultMigrate.enable(await prepared(h));
  assert.equal(r.ok, true, r.message);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'not json');
  assert.ok(r.warnings.some((w) => w.includes('wallet.json')), 'the user is told');
});

// ── Falling back, failing closed ───────────────────────────────────────

test('a corrupt wallets.json runs from its backup, read-only, and can still sign', async () => {
  const { dir, h, keys } = await seedProfile();
  h.wallet.generate('Three'); // so the backup holds a real earlier generation
  const lostLast = h.wallet.list().map((w) => w.publicKey).sort();
  assert.notDeepEqual(lostLast, keys.solana);
  fs.writeFileSync(path.join(dir, 'wallets.json'), '{"version":2,"wal');
  const next = await restart();
  assert.deepEqual(next.wallet.list().map((w) => w.publicKey).sort(), keys.solana);
  assert.deepEqual(next.wallet.unusableKeys(), []);
  assert.ok(next.wallet.failure(), 'the user is told');
  assert.equal(next.wallet.generate('Nope').ok, false, 'nothing is written over the damaged file');
  assert.equal(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8'), '{"version":2,"wal');
});

test('with a password on, missing wallet files never fall back to an empty list that can be written', async () => {
  const { dir, h } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  for (const n of ['wallets.json', 'wallets.json.bak']) fs.rmSync(path.join(dir, n));
  const next = await restart();
  await next.vault.unlock(PASSWORD);
  assert.ok(next.wallet.failure());
  assert.equal(next.wallet.generate('Nope').ok, false);
});

test('an unreadable vault.json refuses to start rather than reading as no password', async () => {
  const { dir, h } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  fs.writeFileSync(path.join(dir, 'vault.json'), 'garbage');
  fs.writeFileSync(path.join(dir, 'vault.json.bak'), 'garbage');
  const next = await restart();
  assert.equal(next.vault.status(), 'broken');
  assert.equal(next.vault.isOn(), false);
  assert.ok(next.vault.brokenReason());
});

test('an older build reads the new file versions as not understood, so it cannot sign from them', async () => {
  // The old parsers refused any version but their own. Pinned against the bytes
  // the app writes, because rollback safety rests on these numbers being new.
  const { dir, h } = await seedProfile();
  assert.equal(h.vaultMigrate.enable(await prepared(h)).ok, true);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, 'wallets.json'), 'utf8')).version, 2);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, 'evm-wallets.json'), 'utf8')).version, 1);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, 'aio-wallet.json'), 'utf8')).version, 1);
});

// ── Key backup file, against real wallets ──────────────────────────────

test('a key backup restores every key on a fresh install, and holds no address in the clear', async () => {
  const { h, keys } = await seedProfile();
  const text = await h.keyExport.encryptBackup(h.keyExport.collectPayload(), 'a separate file password', '9.9.9');
  for (const k of [...keys.solana, ...keys.evm]) assert.ok(!text.includes(k), 'an address leaked into the file');
  assert.equal((await h.keyExport.decryptBackup(text, 'the wrong password here')).ok, false);

  freshDir();
  const fresh = await restart();
  const opened = await fresh.keyExport.decryptBackup(text, 'a separate file password');
  assert.equal(opened.ok, true);
  const r = fresh.keyExport.importPayload(opened.payload);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(fresh.wallet.unusableKeys(), []);
  assert.deepEqual(fresh.evmWallet.unusableKeys(), []);
  assert.equal(fresh.aioWallet.phraseProblem(), null);
  for (const k of keys.solana) assert.ok(fresh.wallet.list().some((w) => w.publicKey === k));
  for (const k of keys.evm) assert.ok(fresh.evmWallet.list('robinhood').some((w) => w.address === k));
  // Importing the same file again adds nothing.
  const again = fresh.keyExport.importPayload(opened.payload);
  assert.equal(again.added, 0);
});

test('a backup does not set withdrawal addresses', async () => {
  const { h } = await seedProfile();
  const payload = h.keyExport.collectPayload();
  payload.solana[0].homeAddress = 'AttackerAddress111111111111111111111111111';
  freshDir();
  const fresh = await restart();
  fresh.keyExport.importPayload(payload);
  assert.ok(fresh.wallet.list().every((w) => w.homeAddress === null));
});

// ── Run ────────────────────────────────────────────────────────────────

for (const { name, fn } of cases) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    restoreFs();
    console.error(`  FAIL  ${name}\n${e.stack}`);
    process.exit(1);
  }
}
console.log(`vaultmigrate: ${passed} passed`);
