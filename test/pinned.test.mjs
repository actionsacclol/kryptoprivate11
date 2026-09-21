// src/panels/pinned.ts — the pages a user pinned to their own sidebar.
//
// Small surface, but it feeds a MENU: a bad entry here is a dead click, and a
// throw here is a sidebar that will not render. So the rules pinned are the
// defensive ones — a missing store, a corrupt store, a store full of ids from
// a build that no longer exists, and a browser that refuses storage entirely.

import assert from 'node:assert';

// A localStorage stand-in we can break on purpose.
function installWindow({ throwing = false } = {}) {
  const data = new Map();
  const listeners = new Map();
  globalThis.window = {
    localStorage: {
      getItem(k) {
        if (throwing) throw new Error('site data blocked');
        return data.has(k) ? data.get(k) : null;
      },
      setItem(k, v) {
        if (throwing) throw new Error('site data blocked');
        data.set(k, v);
      },
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent(ev) {
      for (const cb of listeners.get(ev.type) ?? []) cb(ev);
      return true;
    },
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
  return { data, listeners };
}

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const { data } = installWindow();
const { loadPinned, savePinned, subscribePinned, isPinnable } = await import('./.pinned.mjs');

{
  assert.deepEqual(loadPinned(), [], 'nothing stored is nothing pinned');
  ok('an empty store pins nothing');
}

{
  savePinned(['discover', 'orders']);
  assert.deepEqual(loadPinned(), ['discover', 'orders'], 'round trips');
  ok('a pin list round-trips through storage');
}

{
  // The pages that make no sense in a menu. `token` needs a selected token,
  // and `workspace` is the page doing the pinning.
  assert.equal(isPinnable('token'), false);
  assert.equal(isPinnable('evmToken'), false);
  assert.equal(isPinnable('workspace'), false);
  assert.equal(isPinnable('discover'), true);
  ok('token pages and Widgets itself cannot be pinned');
}

{
  // A build that removes a page must not leave a dead entry someone can click.
  data.set('krypt.panels.pinnedRoutes.v1', JSON.stringify(['discover', 'token', 'workspace', 42, null]));
  assert.deepEqual(loadPinned(), ['discover'], 'unpinnable and non-string entries are dropped');
  ok('stale and unpinnable entries never reach the sidebar');
}

{
  for (const bad of ['{', 'null', '"a string"', '{"not":"an array"}']) {
    data.set('krypt.panels.pinnedRoutes.v1', bad);
    assert.deepEqual(loadPinned(), [], `a ${bad} store reads as empty, not a throw`);
  }
  ok('a corrupt store reads as empty rather than throwing');
}

{
  // Same-document storage events do not fire, so the store announces its own
  // changes. This is what updates the sidebar while the picker is open.
  let fired = 0;
  const stop = subscribePinned(() => {
    fired += 1;
  });
  savePinned(['trades']);
  assert.equal(fired, 1, 'a save notifies subscribers');
  stop();
  savePinned(['orders']);
  assert.equal(fired, 1, 'and unsubscribing stops it');
  ok('subscribers are told when the pin list changes, and can stop listening');
}

{
  // A browser with site data blocked must not take the menu down with it.
  installWindow({ throwing: true });
  assert.doesNotThrow(() => savePinned(['discover']), 'a blocked write is swallowed');
  assert.deepEqual(loadPinned(), [], 'a blocked read is an empty list');
  ok('storage being unavailable is survivable, not fatal');
}

console.log(`\npinned: ${passed}/${passed} passed`);
