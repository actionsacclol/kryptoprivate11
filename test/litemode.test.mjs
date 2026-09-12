// Lite mode — the store behind the Hub's "Laggy?" button and Settings ›
// Display. What is pinned: the class lands on the root, the mirror seeds the
// next boot, subscribers hear one change per flip, and nothing here throws
// on a page that has no storage or no root.

import assert from 'node:assert';
import { _reset, applyLite, getLite, initLite, readMirror, setLite, subscribe } from './.litemode.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const fakeStorage = (initial = {}) => {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), map: m };
};
const fakeRoot = () => {
  const set = new Set();
  return {
    classList: {
      toggle: (name, force) => {
        const want = force === undefined ? !set.has(name) : force;
        if (want) set.add(name);
        else set.delete(name);
        return want;
      },
    },
    has: (name) => set.has(name),
  };
};

{
  _reset();
  assert.equal(readMirror(fakeStorage()), false, 'no mirror is off');
  assert.equal(readMirror(fakeStorage({ 'krypt.lite': '1' })), true);
  assert.equal(readMirror(fakeStorage({ 'krypt.lite': '0' })), false);
  assert.equal(readMirror(null), false, 'no storage at all is off');
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
  assert.equal(readMirror(throwing), false, 'a storage that throws is off, not an exception');
  ok('the mirror reads on, off, missing, absent and throwing as booleans');
}

{
  _reset();
  const root = fakeRoot();
  const storage = fakeStorage();
  let heard = 0;
  const off = subscribe(() => { heard += 1; });
  setLite(true, { root, storage });
  assert.equal(getLite(), true);
  assert.equal(root.has('lite'), true, 'the class is on the root');
  assert.equal(storage.map.get('krypt.lite'), '1', 'and mirrored for the next boot');
  assert.equal(heard, 1);
  setLite(true, { root, storage });
  assert.equal(heard, 1, 'setting the same value again is silent');
  setLite(false, { root, storage });
  assert.equal(root.has('lite'), false);
  assert.equal(storage.map.get('krypt.lite'), '0');
  assert.equal(heard, 2);
  off();
  setLite(true, { root, storage });
  assert.equal(heard, 2, 'an unsubscribed listener hears nothing');
  ok('setLite applies the class, mirrors the value, and notifies once per real change');
}

{
  _reset();
  const root = fakeRoot();
  assert.equal(initLite({ storage: fakeStorage({ 'krypt.lite': '1' }), root }), true);
  assert.equal(root.has('lite'), true, 'a lite machine boots with the class already on');
  assert.equal(getLite(), true);
  const root2 = fakeRoot();
  assert.equal(initLite({ storage: fakeStorage(), root: root2 }), false);
  assert.equal(root2.has('lite'), false);
  ok('initLite seeds the store and the root from the mirror before React mounts');
}

{
  _reset();
  assert.doesNotThrow(() => applyLite(true, null));
  assert.doesNotThrow(() => setLite(true, { root: null, storage: null }));
  assert.equal(getLite(), true, 'the mode still flips with nowhere to write it');
  const badStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.doesNotThrow(() => setLite(false, { root: fakeRoot(), storage: badStorage }));
  assert.equal(getLite(), false);
  ok('no root, no storage, or a storage that throws never breaks the switch');
}

console.log(`\nlitemode: ${passed}/${passed} passed`);
