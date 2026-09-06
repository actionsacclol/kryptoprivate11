// Wallet file lifecycle — the real module, against real files.
//
// walletstore.test.mjs pins the pure rules; this pins what actually happens on
// disk, because that is where a key is kept. The keystore is stubbed (see
// electronstub.mjs) so this stays offline, but the file reads, the migration
// and the "which wallet signs" decisions are the production ones.
//
// The scenario that matters most is the RESTART: every assertion below that
// reloads the module is checking that what you see after reopening the app is
// what you left.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const freshDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-wallet-'));
  process.env.KRYPT_TEST_USERDATA = dir;
  return dir;
};

/** Re-import the module with a cache-busting query = an app restart. */
let gen = 0;
const loadWallet = async () => import(`./.wallet.mjs?v=${gen++}`);

const walletsFile = (dir) => path.join(dir, 'wallets.json');
const legacyFile = (dir) => path.join(dir, 'wallet.json');

const LEGACY_PUB = 'LegacyPubKey1111111111111111111111111111111';
const legacyBody = (over = {}) =>
  JSON.stringify({
    version: 1,
    publicKey: LEGACY_PUB,
    secretEnc: Buffer.from('stub:00ff', 'utf8').toString('base64'),
    homeAddress: null,
    maxBalanceSol: 2,
    createdAt: 1,
    ...over,
  });

test('a generated wallet becomes active and survives a restart', async () => {
  freshDir();
  let w = await loadWallet();
  const r = w.generate('Main');
  assert.equal(r.ok, true, r.message);
  assert.equal(w.info().exists, true);
  assert.equal(w.info().label, 'Main');
  const pub = w.publicKey();
  assert.ok(pub && pub.length > 30);

  w = await loadWallet(); // restart
  assert.equal(w.publicKey(), pub, 'the same wallet signs after a restart');
  assert.equal(w.info().walletCount, 1);
});

test('a second wallet does NOT take over signing', async () => {
  const dir = freshDir();
  const w = await loadWallet();
  w.generate('First');
  const first = w.publicKey();
  w.generate('Second');
  assert.equal(w.list().length, 2);
  assert.equal(w.publicKey(), first, 'generating never switches the signer');
  assert.equal(w.list().filter((x) => x.active).length, 1, 'exactly one active');
  assert.ok(fs.existsSync(walletsFile(dir)));
});

test('selecting switches the signer, and it sticks across a restart', async () => {
  freshDir();
  let w = await loadWallet();
  w.generate('First');
  w.generate('Second');
  const second = w.list().find((x) => !x.active);
  const sel = w.select(second.id);
  assert.equal(sel.ok, true, sel.message);
  assert.equal(w.publicKey(), second.publicKey);

  w = await loadWallet();
  assert.equal(w.publicKey(), second.publicKey, 'still the chosen wallet');
  assert.equal(w.info().label, second.label);
});

test('selecting an unknown id is refused', async () => {
  freshDir();
  const w = await loadWallet();
  w.generate('Only');
  const before = w.publicKey();
  assert.equal(w.select('w_nope').ok, false);
  assert.equal(w.publicKey(), before);
});

test('the SAME key cannot be imported twice', async () => {
  const dir = freshDir();
  const w = await loadWallet();
  w.generate('Main');
  const dest = path.join(dir, 'backup.json');
  assert.equal(w.backupToFile(dest).ok, true);
  const bytes = fs.readFileSync(dest, 'utf8');
  const again = w.importSecret(bytes, 'Copy');
  assert.equal(again.ok, false, 'a duplicate key must be refused');
  assert.equal(w.list().length, 1);
});

test('an exported key round-trips into a fresh install', async () => {
  const dir = freshDir();
  let w = await loadWallet();
  w.generate('Original');
  const pub = w.publicKey();
  const dest = path.join(dir, 'backup.json');
  w.backupToFile(dest);
  const bytes = fs.readFileSync(dest, 'utf8');

  freshDir(); // a different machine
  w = await loadWallet();
  const imported = w.importSecret(bytes, 'Restored');
  assert.equal(imported.ok, true, imported.message);
  assert.equal(w.publicKey(), pub, 'the recovered wallet has the same address');
});

test('removing the ACTIVE wallet promotes another rather than stranding the app', async () => {
  freshDir();
  const w = await loadWallet();
  w.generate('First');
  w.generate('Second');
  const active = w.list().find((x) => x.active);
  const other = w.list().find((x) => !x.active);
  assert.equal(w.remove(active.id).ok, true);
  assert.equal(w.publicKey(), other.publicKey, 'the survivor signs');
  assert.equal(w.info().exists, true);
});

test('removing the LAST wallet leaves none, and it stays gone after a restart', async () => {
  const dir = freshDir();
  let w = await loadWallet();
  w.generate('Only');
  assert.equal(w.remove().ok, true);
  assert.equal(w.info().exists, false);
  assert.equal(w.publicKey(), null);

  w = await loadWallet();
  assert.equal(w.info().exists, false, 'a removed wallet must not come back');
  assert.equal(fs.existsSync(walletsFile(dir)), true, 'an empty file is kept, not deleted');
});

test('a legacy single-wallet install migrates on first read', async () => {
  const dir = freshDir();
  fs.writeFileSync(
    legacyFile(dir),
    legacyBody({ homeAddress: 'HomeAddr111111111111111111111111111111111', maxBalanceSol: 3, createdAt: 12345 }),
    'utf8',
  );
  const w = await loadWallet();
  assert.equal(w.info().exists, true, 'the existing wallet is found, not lost');
  assert.equal(w.publicKey(), LEGACY_PUB);
  assert.equal(w.info().homeAddress, 'HomeAddr111111111111111111111111111111111');
  assert.equal(w.info().maxBalanceSol, 3, 'its settings come across');
  assert.equal(w.info().walletCount, 1);
  assert.equal(fs.existsSync(walletsFile(dir)), true, 'migrated into the new file');
  assert.equal(fs.existsSync(legacyFile(dir)), true, 'the old file is KEPT — it holds a key');
});

test('a removed wallet is not resurrected by the legacy file', async () => {
  const dir = freshDir();
  fs.writeFileSync(legacyFile(dir), legacyBody(), 'utf8');
  let w = await loadWallet();
  assert.equal(w.info().exists, true);
  assert.equal(w.remove().ok, true);

  w = await loadWallet(); // restart, with wallet.json still on disk
  assert.equal(w.info().exists, false, 'the legacy file must not undo the removal');
});

test('per-wallet settings do not leak between wallets', async () => {
  freshDir();
  const w = await loadWallet();
  w.generate('First');
  w.generate('Second');
  w.setMaxBalance(7);
  const activeId = w.info().id;
  const other = w.list().find((x) => x.id !== activeId);
  assert.equal(w.list().find((x) => x.id === activeId).maxBalanceSol, 7);
  assert.equal(other.maxBalanceSol, 2, 'the other wallet keeps its own cap');
});

test('signing is refused when no wallet is held', async () => {
  freshDir();
  const w = await loadWallet();
  const r = w.signVersionedTransaction(new Uint8Array([1, 2, 3]), { intent: 'trade', maxOutflowLamports: 0 });
  assert.equal(r.ok, false);
  assert.match(r.message, /no wallet/i);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`wallet: ${passed}/${cases.length} tests passed`);
}

await run();
