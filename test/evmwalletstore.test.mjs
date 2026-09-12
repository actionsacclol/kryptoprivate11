// electron/evm/evmWalletStore.ts — Robinhood Chain wallet bookkeeping.
//
// The same invariants as the Solana store (test/walletstore.test.mjs), for
// the same reason: none of these failure modes throw, they leave you signing
// with a wallet you did not choose.
//
//   • every chain's active id always names a wallet that exists, or is null
//     because no wallet on file may sign there
//   • adding never changes who signs, except the first wallet a chain can
//     use — and a wallet made FOR a chain whose signer is missing or shared
//     with the other chain, which is the split being asked for
//   • the same address cannot be held twice (case-insensitively)
//   • removing the active wallet promotes the OLDEST ELIGIBLE survivor
//   • a wallet made for one chain is never the other chain's fallback
//   • a file for another chain, or another version, is not this chain's list

import assert from 'node:assert';
import {
  activeWallet,
  addWallet,
  addWalletFor,
  assignWallet,
  cleanLabel,
  emptyFile,
  healActive,
  nextLabel,
  parseFile,
  removeWallet,
  renameWallet,
  selectWallet,
  MAX_EVM_WALLETS,
} from './.evmwalletstore.mjs';

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

const CHAIN = 4663;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const w = (id, over = {}) => ({
  id,
  label: `EVM wallet ${id}`,
  address: addr(parseInt(id, 36) + 1),
  secretEnc: `enc_${id}`,
  createdAt: 1_000,
  ...over,
});
const withWallets = (...ws) =>
  healActive({ version: 1, chainId: CHAIN, active: { robinhood: ws[0]?.id ?? null, bnb: ws[0]?.id ?? null }, wallets: ws });

/** Who signs on a chain. Robinhood is the default for the assertions that
 *  predate the per-chain split and are about the LIST, not about the choice. */
const act = (f, chain = 'robinhood') => f.active[chain];

// ── active-wallet invariant ───────────────────────────────────────────

ok('an empty file has no active wallet and carries the chain id', () => {
  const f = emptyFile(CHAIN);
  assert.equal(act(f), null);
  assert.equal(f.chainId, CHAIN);
  assert.equal(activeWallet(f), null);
});

ok('the first wallet added becomes the signer on EVERY chain', () => {
  const r = addWallet(emptyFile(CHAIN), w('a'));
  assert.equal(r.ok, true);
  assert.equal(act(r.file), 'a');
  assert.equal(act(r.file, 'bnb'), 'a');
  assert.equal(activeWallet(r.file, 'robinhood').id, 'a');
  assert.equal(activeWallet(r.file, 'bnb').id, 'a');
});

ok('a second wallet does NOT change who signs, on either chain', () => {
  const one = addWallet(emptyFile(CHAIN), w('a')).file;
  const two = addWallet(one, w('b'));
  assert.equal(two.ok, true);
  assert.equal(act(two.file), 'a');
  assert.equal(act(two.file, 'bnb'), 'a');
  assert.equal(two.file.wallets.length, 2);
});

ok('the same address cannot be held twice, whatever the case', () => {
  const one = addWallet(emptyFile(CHAIN), w('a')).file;
  const dupe = addWallet(one, w('z', { address: w('a').address.toUpperCase().replace('0X', '0x') }));
  assert.equal(dupe.ok, false);
  assert.match(dupe.message, /already/);
  assert.equal(dupe.file.wallets.length, 1);
});

ok('a duplicate id is refused', () => {
  const one = addWallet(emptyFile(CHAIN), w('a')).file;
  const dupe = addWallet(one, w('a', { address: addr(999) }));
  assert.equal(dupe.ok, false);
});

ok('a malformed address is refused at add time', () => {
  const r = addWallet(emptyFile(CHAIN), w('a', { address: 'So11111111111111111111111111111111111111112' }));
  assert.equal(r.ok, false);
});

ok(`at most ${MAX_EVM_WALLETS} wallets`, () => {
  let f = emptyFile(CHAIN);
  for (let i = 0; i < MAX_EVM_WALLETS; i++) f = addWallet(f, w(`w${i}`)).file;
  assert.equal(f.wallets.length, MAX_EVM_WALLETS);
  const over = addWallet(f, w('extra'));
  assert.equal(over.ok, false);
  assert.match(over.message, /At most/);
});

// ── switching ─────────────────────────────────────────────────────────

ok('selecting an existing wallet makes it the signer; a missing id is refused', () => {
  const f = withWallets(w('a'), w('b'));
  const r = selectWallet(f, 'robinhood', 'b');
  assert.equal(r.ok, true);
  assert.equal(act(r.file), 'b');
  const again = selectWallet(r.file, 'robinhood', 'b');
  assert.equal(again.ok, true);
  assert.match(again.message, /already/);
  assert.equal(selectWallet(f, 'robinhood', 'nope').ok, false);
});

ok('choosing a signer on one chain leaves the other chain alone', () => {
  // The whole point of the per-chain split: two chains, two addresses, one
  // list of keys. Before 2026-09-11 this was impossible — selecting anywhere
  // moved both.
  const f = withWallets(w('a'), w('b'));
  const r = selectWallet(f, 'bnb', 'b');
  assert.equal(r.ok, true);
  assert.equal(act(r.file, 'bnb'), 'b', 'BNB moved');
  assert.equal(act(r.file, 'robinhood'), 'a', 'and Robinhood did not');
  assert.match(r.message, /BNB/, 'and the message says which chain it changed');
});

ok('a chain keeps its own signer when the other one changes', () => {
  const f = selectWallet(withWallets(w('a'), w('b'), w('c')), 'bnb', 'c').file;
  const r = selectWallet(f, 'robinhood', 'b');
  assert.equal(act(r.file, 'robinhood'), 'b');
  assert.equal(act(r.file, 'bnb'), 'c', 'BNB is untouched by a Robinhood switch');
});

// ── removal ───────────────────────────────────────────────────────────

ok('removing the active wallet promotes the OLDEST survivor', () => {
  const f = withWallets(w('a', { createdAt: 3 }), w('b', { createdAt: 1 }), w('c', { createdAt: 2 }));
  const r = removeWallet(f, 'a');
  assert.equal(r.ok, true);
  assert.equal(act(r.file), 'b');
  assert.equal(r.file.wallets.length, 2);
});

ok('removing a non-active wallet leaves the signer alone', () => {
  const f = withWallets(w('a'), w('b'));
  const r = removeWallet(f, 'b');
  assert.equal(act(r.file), 'a');
});

ok('removing a wallet only re-points the chains that were using it', () => {
  const f = selectWallet(withWallets(w('a', { createdAt: 1 }), w('b', { createdAt: 2 }), w('c', { createdAt: 3 })), 'bnb', 'c').file;
  assert.equal(act(f, 'robinhood'), 'a');
  const r = removeWallet(f, 'c');
  assert.equal(r.ok, true);
  assert.equal(act(r.file, 'bnb'), 'a', 'BNB lost its signer and promoted the oldest survivor');
  assert.equal(act(r.file, 'robinhood'), 'a', 'Robinhood never lost anything');
});

ok('removing the last wallet leaves every chain with no signer', () => {
  const f = withWallets(w('a'));
  const r = removeWallet(f, 'a');
  assert.equal(r.ok, true);
  assert.equal(r.file.wallets.length, 0);
  assert.equal(act(r.file), null);
});

ok('removing an unknown id is refused', () => {
  assert.equal(removeWallet(withWallets(w('a')), 'x').ok, false);
});

// ── healing ───────────────────────────────────────────────────────────

ok('healActive repairs a dangling active id to the oldest wallet, per chain', () => {
  const f = healActive({
    version: 1,
    chainId: CHAIN,
    active: { robinhood: 'ghost', bnb: 'b' },
    wallets: [w('a', { createdAt: 5 }), w('b', { createdAt: 2 })],
  });
  assert.equal(act(f), 'b', 'the dangling one is repaired');
  assert.equal(act(f, 'bnb'), 'b', 'and a valid one is left as it was');
});

ok('healActive leaves a valid file untouched', () => {
  const raw = { version: 1, chainId: CHAIN, active: { robinhood: 'a', bnb: 'a' }, wallets: [w('a'), w('b')] };
  assert.strictEqual(healActive(raw), raw);
});

// ── parsing ───────────────────────────────────────────────────────────

ok('parseFile reads a good file and skips malformed entries without dropping the rest', () => {
  const raw = {
    version: 1,
    chainId: CHAIN,
    activeId: 'a',
    wallets: [
      w('a'),
      { id: 'bad1', address: 'nope', secretEnc: 'x', createdAt: 1 },
      { id: '', address: addr(7), secretEnc: 'x' },
      { id: 'bad3', address: addr(8) }, // no secretEnc
      null,
      w('b'),
      w('dupe', { address: w('a').address.toUpperCase().replace('0X', '0x') }),
    ],
  };
  const f = parseFile(raw, CHAIN);
  assert.deepEqual(f.wallets.map((x) => x.id), ['a', 'b']);
  assert.equal(act(f), 'a');
});

ok('parseFile heals a dangling active id', () => {
  const f = parseFile({ version: 1, chainId: CHAIN, active: { robinhood: 'gone', bnb: 'gone' }, wallets: [w('a')] }, CHAIN);
  assert.equal(act(f), 'a');
});

// -- migration: one signer becomes one signer per chain ----------------
//
// This file holds the only copy of every EVM key, so the widening has to be
// invisible to somebody who never asked for it. A file written before
// 2026-09-11 has a single `activeId` and no `active` object at all.

ok('a pre-split file keeps signing with exactly the wallet it always did', () => {
  const legacy = { version: 1, chainId: CHAIN, activeId: 'b', wallets: [w('a', { createdAt: 1 }), w('b', { createdAt: 2 })] };
  const f = parseFile(legacy, CHAIN);
  assert.equal(act(f, 'robinhood'), 'b');
  assert.equal(act(f, 'bnb'), 'b', 'both chains inherit the one signer — a widening, never a reset');
  assert.equal(f.wallets.length, 2, 'and no key is lost on the way');
});

ok('a pre-split file with a dangling activeId still heals to the oldest', () => {
  const legacy = { version: 1, chainId: CHAIN, activeId: 'ghost', wallets: [w('a', { createdAt: 9 }), w('b', { createdAt: 4 })] };
  const f = parseFile(legacy, CHAIN);
  assert.equal(act(f, 'robinhood'), 'b');
  assert.equal(act(f, 'bnb'), 'b');
});

ok('a half-written file — one chain named, the other missing — falls back rather than blanking', () => {
  // Belt and braces: a crash between writes must not leave BNB with no
  // signer while Robinhood has one.
  const raw = { version: 1, chainId: CHAIN, activeId: 'a', active: { robinhood: 'b' }, wallets: [w('a', { createdAt: 1 }), w('b', { createdAt: 2 })] };
  const f = parseFile(raw, CHAIN);
  assert.equal(act(f, 'robinhood'), 'b', 'the written choice wins');
  assert.equal(act(f, 'bnb'), 'a', 'the missing one falls back to the legacy id');
});

ok('a new file names both chains and no longer needs the legacy key', () => {
  const raw = { version: 1, chainId: CHAIN, active: { robinhood: 'a', bnb: 'b' }, wallets: [w('a'), w('b')] };
  const f = parseFile(raw, CHAIN);
  assert.equal(act(f, 'robinhood'), 'a');
  assert.equal(act(f, 'bnb'), 'b', 'two chains, two signers, one list of keys');
});

ok('parseFile refuses the wrong version, the wrong chain, and non-objects', () => {
  assert.equal(parseFile({ version: 2, chainId: CHAIN, activeId: null, wallets: [] }, CHAIN), null);
  assert.equal(parseFile({ version: 1, chainId: 1, activeId: null, wallets: [] }, CHAIN), null);
  assert.equal(parseFile({ version: 1, chainId: CHAIN, wallets: 'x' }, CHAIN), null);
  assert.equal(parseFile(null, CHAIN), null);
  assert.equal(parseFile('text', CHAIN), null);
});

ok('parseFile accepts a file with no chainId (written by this version, which always sets it — defensive)', () => {
  const f = parseFile({ version: 1, activeId: null, wallets: [w('a')] }, CHAIN);
  assert.equal(f.chainId, CHAIN);
  assert.equal(f.wallets.length, 1);
});

ok('parseFile fills a missing label and createdAt', () => {
  const f = parseFile({ version: 1, chainId: CHAIN, activeId: null, wallets: [{ id: 'a', address: addr(3), secretEnc: 'e' }] }, CHAIN);
  assert.equal(f.wallets[0].label, 'EVM wallet');
  assert.equal(f.wallets[0].createdAt, 0);
});

// ── labels ────────────────────────────────────────────────────────────

ok('nextLabel skips taken numbers', () => {
  assert.equal(nextLabel(emptyFile(CHAIN)), 'EVM wallet 1');
  const f = withWallets(w('a', { label: 'EVM wallet 1' }), w('b', { label: 'EVM wallet 3' }));
  assert.equal(nextLabel(f), 'EVM wallet 2');
});

ok('nextLabel names the chain when asked', () => {
  assert.equal(nextLabel(emptyFile(CHAIN), 'bnb'), 'BNB wallet 1');
  assert.equal(nextLabel(withWallets(w('a', { label: 'BNB wallet 1' })), 'bnb'), 'BNB wallet 2');
});

// ── a home chain per wallet ────────────────────────────────────────────
//
// The complaint: "BNB Wallet shows my Robinhood wallet." The pre-split key
// was seeded as BNB's signer, and a wallet made from the BNB page joined the
// list without BNB using it. These pin the rules that end that.

const wf = (id, chain, over = {}) => w(id, { createdFor: chain, ...over });

ok('a wallet made for a chain whose signer is SHARED takes over that chain only', () => {
  const f = withWallets(w('legacy'));
  assert.equal(act(f, 'robinhood'), 'legacy');
  assert.equal(act(f, 'bnb'), 'legacy', 'setup: one key, both chains');
  const r = addWalletFor(f, w('b'), 'bnb');
  assert.equal(r.ok, true);
  assert.equal(r.switched, true);
  assert.equal(act(r.file, 'bnb'), 'b', 'BNB now signs with its own wallet');
  assert.equal(act(r.file, 'robinhood'), 'legacy', 'Robinhood keeps the old one');
  assert.equal(r.file.wallets.find((x) => x.id === 'b').createdFor, 'bnb', 'and the wallet remembers what it was made for');
  assert.match(r.message, /signs on BNB/);
});

ok('a wallet made for a chain that already has its own signer is added, not switched to', () => {
  const split = addWalletFor(withWallets(w('legacy')), w('b'), 'bnb').file;
  const r = addWalletFor(split, w('c'), 'bnb');
  assert.equal(r.ok, true);
  assert.equal(r.switched, false);
  assert.equal(act(r.file, 'bnb'), 'b', 'adding never changes who signs');
  // Robinhood's signer is no longer shared once the split happened, so a
  // new Robinhood wallet does not take over either.
  const r2 = addWalletFor(r.file, w('d'), 'robinhood');
  assert.equal(r2.switched, false);
  assert.equal(act(r2.file, 'robinhood'), 'legacy');
});

ok('a wallet made for a chain with NO signer becomes its signer', () => {
  const f = addWallet(emptyFile(CHAIN), wf('r', 'robinhood')).file;
  assert.equal(act(f, 'bnb'), null, 'setup: BNB has nothing it may use');
  const r = addWalletFor(f, w('b'), 'bnb');
  assert.equal(r.switched, true);
  assert.equal(act(r.file, 'bnb'), 'b');
  assert.equal(act(r.file, 'robinhood'), 'r');
});

ok('the switch is refused whole while the chain is armed, and a plain add still goes through', () => {
  const f = withWallets(w('legacy'));
  const r = addWalletFor(f, w('b'), 'bnb', false);
  assert.equal(r.ok, false);
  assert.match(r.message, /Paper/);
  assert.strictEqual(r.file, f, 'nothing was added either — no half-done split');
  const split = addWalletFor(f, w('b'), 'bnb').file;
  const r2 = addWalletFor(split, w('c'), 'bnb', false);
  assert.equal(r2.ok, true, 'an add that needs no switch is not blocked by the arm');
  assert.equal(r2.switched, false);
});

ok('a chain never borrows a wallet made for the other chain', () => {
  const only = addWallet(emptyFile(CHAIN), wf('b', 'bnb'));
  assert.equal(act(only.file, 'bnb'), 'b');
  assert.equal(act(only.file, 'robinhood'), null, 'Robinhood has no signer rather than a BNB wallet');
  assert.equal(activeWallet(only.file, 'robinhood'), null);
  const both = addWallet(only.file, wf('r', 'robinhood')).file;
  assert.equal(act(both, 'robinhood'), 'r');
  const gone = removeWallet(both, 'r').file;
  assert.equal(act(gone, 'robinhood'), null, "removing Robinhood's only own wallet leaves it with none, not with BNB's");
  assert.equal(act(gone, 'bnb'), 'b', 'BNB is untouched');
  const healed = healActive({ version: 1, chainId: CHAIN, active: { robinhood: 'ghost', bnb: 'b' }, wallets: [wf('b', 'bnb')] });
  assert.equal(act(healed, 'robinhood'), null, 'healing a dangling id does not borrow either');
});

ok('a pre-split wallet is still every chain\'s fallback', () => {
  const f = addWallet(emptyFile(CHAIN), wf('b', 'bnb')).file;
  const g = addWallet(f, w('legacy')).file;
  assert.equal(act(g, 'robinhood'), 'legacy', 'a wallet with no home may sign anywhere that needs one');
  assert.equal(act(g, 'bnb'), 'b', 'but does not displace a chain\'s own');
});

ok('assigning a wallet to a chain is refused while it signs on another, and works once it does not', () => {
  const f = withWallets(w('legacy'), w('x'));
  const r = assignWallet(f, 'legacy', 'robinhood');
  assert.equal(r.ok, false, 'it still signs on BNB');
  assert.match(r.message, /BNB/);
  const split = addWalletFor(f, w('b'), 'bnb').file;
  const r2 = assignWallet(split, 'legacy', 'robinhood');
  assert.equal(r2.ok, true);
  assert.equal(r2.file.wallets.find((x) => x.id === 'legacy').createdFor, 'robinhood');
  assert.equal(act(r2.file, 'robinhood'), 'legacy', 'assigning changes what a page lists, never who signs');
  assert.match(assignWallet(r2.file, 'legacy', 'robinhood').message, /already/);
  assert.equal(assignWallet(split, 'nope', 'bnb').ok, false);
});

ok('parseFile keeps a home chain, leaves a pre-split wallet without one, and ignores a chain it does not know', () => {
  const raw = {
    version: 1,
    chainId: CHAIN,
    active: { robinhood: 'a', bnb: 'b' },
    wallets: [w('a'), { ...w('b'), createdFor: 'bnb' }, { ...w('c'), createdFor: 'mars' }],
  };
  const f = parseFile(raw, CHAIN);
  assert.equal(f.wallets.find((x) => x.id === 'a').createdFor, undefined);
  assert.equal(f.wallets.find((x) => x.id === 'b').createdFor, 'bnb');
  assert.equal(f.wallets.find((x) => x.id === 'c').createdFor, undefined, 'an unknown chain is not a home');
  assert.equal(act(f, 'robinhood'), 'a');
  assert.equal(act(f, 'bnb'), 'b');
});

ok('cleanLabel collapses whitespace, caps length, and falls back to a numbered label', () => {
  assert.equal(cleanLabel('  my   hood  ', 1), 'my hood');
  assert.equal(cleanLabel('', 4), 'EVM wallet 4');
  assert.equal(cleanLabel('   ', 2), 'EVM wallet 2');
  assert.equal(cleanLabel('x'.repeat(100), 1).length, 32);
});

ok('renameWallet uses cleanLabel and refuses unknown ids', () => {
  const f = withWallets(w('a'));
  const r = renameWallet(f, 'a', '  Trading  ');
  assert.equal(r.ok, true);
  assert.equal(r.file.wallets[0].label, 'Trading');
  assert.equal(renameWallet(f, 'a', '').file.wallets[0].label, 'EVM wallet 1');
  assert.equal(renameWallet(f, 'zz', 'x').ok, false);
});

console.log(`\n${passed} evm wallet store cases passed`);
