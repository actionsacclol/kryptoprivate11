// Multi-wallet bookkeeping tests.
//
// This module decides WHICH KEY SIGNS. None of its failure modes throw — they
// just leave you trading a wallet you did not choose, which is the worst kind
// of quiet bug in this app. So the invariants are pinned directly:
//
//   • `activeId` always names a wallet that exists, or is null because none do
//   • adding a wallet never silently changes who is signing
//   • removing the active wallet promotes a successor, never leaves a dangler
//   • the same key cannot be held twice
//   • a v1 single-wallet file migrates rather than reading as "no wallet"
//
// No key material appears here: `secretEnc` is an opaque string throughout,
// exactly as the store sees it.

import assert from 'node:assert';
import {
  activeWallet,
  addWallet,
  cleanLabel,
  emptyFile,
  healActive,
  migrateLegacy,
  nextLabel,
  parseFile,
  patchActive,
  removeWallet,
  renameWallet,
  selectWallet,
  MAX_WALLETS,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupMembers,
  groupWallets,
} from './.walletstore.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const w = (id, over = {}) => ({
  id,
  label: `Wallet ${id}`,
  publicKey: `pub_${id}`,
  secretEnc: `enc_${id}`,
  homeAddress: null,
  maxBalanceSol: 2,
  createdAt: 1_000,
  ...over,
});

const withWallets = (...ws) => healActive({ version: 2, activeId: ws[0]?.id ?? null, wallets: ws });

// ── The active-wallet invariant ───────────────────────────────────────

test('an empty file has no active wallet', () => {
  const f = emptyFile();
  assert.equal(f.activeId, null);
  assert.equal(activeWallet(f), null);
});

test('an activeId pointing at a missing wallet self-heals to the oldest', () => {
  // A hand-edited file, or a wallet removed outside the app. Reading this as
  // "no wallet" would present as a vanished key on a machine holding two.
  const f = healActive({ version: 2, activeId: 'ghost', wallets: [w('b', { createdAt: 2000 }), w('a', { createdAt: 1000 })] });
  assert.equal(f.activeId, 'a', 'oldest wins, deterministically');
  assert.equal(activeWallet(f).id, 'a');
});

test('healing a file with no wallets nulls the active id', () => {
  const f = healActive({ version: 2, activeId: 'a', wallets: [] });
  assert.equal(f.activeId, null);
});

// ── Adding ────────────────────────────────────────────────────────────

test('the first wallet added becomes active', () => {
  const r = addWallet(emptyFile(), w('a'));
  assert.equal(r.ok, true);
  assert.equal(r.file.activeId, 'a');
});

test('a LATER wallet does not steal the signer', () => {
  // Generating or importing a key must never silently change which wallet
  // trades — switching is always an explicit act.
  const first = addWallet(emptyFile(), w('a')).file;
  const second = addWallet(first, w('b'));
  assert.equal(second.ok, true);
  assert.equal(second.file.activeId, 'a', 'still the original');
  assert.equal(second.file.wallets.length, 2);
});

test('the same key cannot be held twice', () => {
  const f = addWallet(emptyFile(), w('a')).file;
  const dup = addWallet(f, w('b', { publicKey: 'pub_a' }));
  assert.equal(dup.ok, false);
  assert.match(dup.message, /already/i);
  assert.equal(dup.file.wallets.length, 1, 'the file is unchanged on refusal');
});

test('a duplicate id is refused', () => {
  const f = addWallet(emptyFile(), w('a')).file;
  const dup = addWallet(f, w('a', { publicKey: 'pub_other' }));
  assert.equal(dup.ok, false);
});

test('the wallet count is capped', () => {
  let f = emptyFile();
  for (let i = 0; i < MAX_WALLETS; i++) f = addWallet(f, w(`k${i}`, { publicKey: `pub_k${i}` })).file;
  const over = addWallet(f, w('extra', { publicKey: 'pub_extra' }));
  assert.equal(over.ok, false);
  assert.equal(over.file.wallets.length, MAX_WALLETS);
});

// ── Selecting ─────────────────────────────────────────────────────────

test('selecting an unknown wallet is refused and changes nothing', () => {
  const f = withWallets(w('a'), w('b'));
  const r = selectWallet(f, 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.file.activeId, 'a');
});

test('selecting switches the signer', () => {
  const r = selectWallet(withWallets(w('a'), w('b')), 'b');
  assert.equal(r.ok, true);
  assert.equal(activeWallet(r.file).id, 'b');
});

test('selecting the already-active wallet is a no-op success', () => {
  const r = selectWallet(withWallets(w('a')), 'a');
  assert.equal(r.ok, true);
  assert.equal(r.file.activeId, 'a');
});

// ── Removing ──────────────────────────────────────────────────────────

test('removing the ACTIVE wallet promotes another', () => {
  const f = withWallets(w('a', { createdAt: 1000 }), w('b', { createdAt: 2000 }));
  const r = removeWallet(f, 'a');
  assert.equal(r.ok, true);
  assert.equal(r.file.wallets.length, 1);
  assert.equal(r.file.activeId, 'b', 'never left pointing at a removed wallet');
});

test('removing a NON-active wallet leaves the signer alone', () => {
  const f = withWallets(w('a'), w('b'));
  const r = removeWallet(f, 'b');
  assert.equal(r.file.activeId, 'a');
});

test('removing the last wallet leaves no active id', () => {
  const r = removeWallet(withWallets(w('a')), 'a');
  assert.equal(r.ok, true);
  assert.equal(r.file.wallets.length, 0);
  assert.equal(r.file.activeId, null);
  assert.equal(activeWallet(r.file), null);
});

test('removing an unknown wallet is refused', () => {
  const r = removeWallet(withWallets(w('a')), 'ghost');
  assert.equal(r.ok, false);
  assert.equal(r.file.wallets.length, 1);
});

// ── Labels and settings ───────────────────────────────────────────────

test('labels are trimmed, collapsed and bounded', () => {
  assert.equal(cleanLabel('  my   main  ', 1), 'my main');
  assert.equal(cleanLabel('', 3), 'Wallet 3', 'empty falls back to a numbered name');
  assert.equal(cleanLabel('   ', 2), 'Wallet 2');
  assert.ok(cleanLabel('x'.repeat(200), 1).length <= 32);
});

test('renaming touches only the named wallet', () => {
  const f = withWallets(w('a'), w('b'));
  const r = renameWallet(f, 'b', 'Sniper');
  assert.equal(r.ok, true);
  assert.equal(r.file.wallets.find((x) => x.id === 'b').label, 'Sniper');
  assert.equal(r.file.wallets.find((x) => x.id === 'a').label, 'Wallet a');
});

test('the next default label skips names already taken', () => {
  const f = withWallets(w('a', { label: 'Wallet 1' }), w('b', { label: 'Wallet 2' }));
  assert.equal(nextLabel(f), 'Wallet 3');
});

test('settings patch the ACTIVE wallet only', () => {
  const f = withWallets(w('a'), w('b'));
  const r = patchActive(f, { homeAddress: 'HOME', maxBalanceSol: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.file.wallets.find((x) => x.id === 'a').homeAddress, 'HOME');
  assert.equal(r.file.wallets.find((x) => x.id === 'b').homeAddress, null, 'the other wallet is untouched');
  assert.equal(r.file.wallets.find((x) => x.id === 'b').maxBalanceSol, 2);
});

test('patching with no wallet is refused rather than inventing one', () => {
  assert.equal(patchActive(emptyFile(), { maxBalanceSol: 5 }).ok, false);
});

// ── Reading what is on disk ───────────────────────────────────────────

const ids = () => 'generated_id';

test('a v1 single-wallet file migrates instead of reading as no wallet', () => {
  const legacy = {
    version: 1,
    publicKey: 'PUB',
    secretEnc: 'ENC',
    homeAddress: 'HOME',
    maxBalanceSol: 3,
    createdAt: 42,
  };
  const f = parseFile(legacy, 999, ids);
  assert.equal(f.wallets.length, 1);
  assert.equal(f.activeId, f.wallets[0].id, 'the migrated wallet is active');
  assert.equal(f.wallets[0].publicKey, 'PUB');
  assert.equal(f.wallets[0].secretEnc, 'ENC', 'the ciphertext is carried across verbatim');
  assert.equal(f.wallets[0].homeAddress, 'HOME');
  assert.equal(f.wallets[0].maxBalanceSol, 3);
  assert.equal(f.wallets[0].createdAt, 42);
});

test('migrateLegacy keeps a zero createdAt from becoming epoch zero', () => {
  const f = migrateLegacy(
    { version: 1, publicKey: 'P', secretEnc: 'E', homeAddress: null, maxBalanceSol: 0, createdAt: 0 },
    777,
    'id1',
  );
  assert.equal(f.wallets[0].createdAt, 777);
  assert.equal(f.wallets[0].maxBalanceSol, 2, 'a zero cap falls back to the default, never to zero');
});

test('a malformed entry is skipped without discarding the other wallets', () => {
  const f = parseFile(
    { version: 2, activeId: 'a', wallets: [w('a'), { id: 'broken' }, w('c', { publicKey: 'pub_c' })] },
    1,
    ids,
  );
  assert.equal(f.wallets.length, 2);
  assert.equal(f.activeId, 'a');
});

test('duplicate keys on disk collapse to one', () => {
  const f = parseFile({ version: 2, activeId: 'a', wallets: [w('a'), w('b', { publicKey: 'pub_a' })] }, 1, ids);
  assert.equal(f.wallets.length, 1);
});

test('an EMPTY v2 file parses, so a legacy fallback cannot resurrect a wallet', () => {
  // wallet.ts keeps the pre-multi-wallet `wallet.json` (it holds a key copy)
  // and falls back to it when the current file is unreadable. So removing the
  // last wallet writes an empty file rather than deleting one — if this
  // returned null, the removed wallet would come back on the next start.
  const f = parseFile({ version: 2, activeId: null, wallets: [] }, 1, ids);
  assert.notEqual(f, null);
  assert.equal(f.wallets.length, 0);
  assert.equal(f.activeId, null);
});

test('an unreadable shape returns null so the caller can fall back', () => {
  assert.equal(parseFile(null, 1, ids), null);
  assert.equal(parseFile({ version: 9 }, 1, ids), null);
  assert.equal(parseFile('nonsense', 1, ids), null);
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
  console.log(`walletstore: ${passed}/${cases.length} tests passed`);
}


// ── Groups (fan-out) ──────────────────────────────────────────────────

const threeWallets = () => {
  let f = emptyFile();
  f = addWallet(f, w('a')).file;
  f = addWallet(f, w('b')).file;
  f = addWallet(f, w('c')).file;
  return f;
};

test('a group is created empty and can be filled with members', () => {
  let f = threeWallets();
  f = createGroup(f, 'Snipers', 'g1').file;
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].walletIds.length, 0);
  f = setGroupMembers(f, 'g1', ['a', 'c']).file;
  assert.deepEqual(groupWallets(f, 'g1').map((x) => x.id), ['a', 'c']);
});

test('setGroupMembers drops ids that are not real wallets', () => {
  let f = threeWallets();
  f = createGroup(f, 'G', 'g1').file;
  f = setGroupMembers(f, 'g1', ['a', 'ghost', 'b']).file;
  assert.deepEqual(f.groups[0].walletIds, ['a', 'b']);
});

test('removing a wallet removes it from every group', () => {
  let f = threeWallets();
  f = createGroup(f, 'G', 'g1').file;
  f = setGroupMembers(f, 'g1', ['a', 'b', 'c']).file;
  f = removeWallet(f, 'b').file;
  assert.deepEqual(f.groups[0].walletIds, ['a', 'c'], 'the gone wallet must leave the group');
  assert.deepEqual(groupWallets(f, 'g1').map((x) => x.id), ['a', 'c']);
});

test('rename and delete a group', () => {
  let f = threeWallets();
  f = createGroup(f, 'Old', 'g1').file;
  f = renameGroup(f, 'g1', 'New').file;
  assert.equal(f.groups[0].name, 'New');
  f = deleteGroup(f, 'g1').file;
  assert.equal(f.groups.length, 0);
});

test('groups survive a round-trip through parseFile', () => {
  let f = threeWallets();
  f = createGroup(f, 'Snipers', 'g1').file;
  f = setGroupMembers(f, 'g1', ['a', 'b']).file;
  const reparsed = parseFile(JSON.parse(JSON.stringify(f)), 0, () => 'x');
  assert.equal(reparsed.groups.length, 1);
  assert.deepEqual(reparsed.groups[0].walletIds, ['a', 'b']);
});

test('a group member that vanished from disk is dropped on parse', () => {
  // Hand-crafted file: group references a wallet id that is not in the list.
  const raw = {
    version: 2,
    activeId: 'a',
    wallets: [{ id: 'a', publicKey: 'pub_a', secretEnc: 'enc_a', label: 'A', homeAddress: null, maxBalanceSol: 2, createdAt: 1 }],
    groups: [{ id: 'g1', name: 'G', walletIds: ['a', 'gone'] }],
  };
  const f = parseFile(raw, 0, () => 'x');
  assert.deepEqual(f.groups[0].walletIds, ['a'], 'a phantom member must not survive');
});

test('a v2 file with no groups key still parses (backward compat)', () => {
  const raw = {
    version: 2,
    activeId: 'a',
    wallets: [{ id: 'a', publicKey: 'pub_a', secretEnc: 'enc_a', label: 'A', homeAddress: null, maxBalanceSol: 2, createdAt: 1 }],
  };
  const f = parseFile(raw, 0, () => 'x');
  assert.deepEqual(f.groups, []);
});

await run();
