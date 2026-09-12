// src/panels/layout.ts — where My Layout's panels sit.
//
// This exists because of a real regression: a panel switched ON appeared as a
// tiny box and stayed one. react-grid-layout falls back to a 1x1 box for any
// child it has no layout entry for, and then reports that box back as the
// user's arrangement — so a single render without an entry is enough to
// persist a broken layout forever.
//
// The rule these tests hold down: every rendered panel has an entry, and a
// change is folded into what we had rather than replacing it.

import assert from 'node:assert';

function installWindow({ throwing = false } = {}) {
  const data = new Map();
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
      removeItem(k) {
        if (throwing) throw new Error('site data blocked');
        data.delete(k);
      },
    },
  };
  return data;
}

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const data = installWindow();
const { deriveLayout, mergeBoxes, loadBoxes, saveBoxes, clearBoxes, storageKey, isBox } = await import('./.panellayout.mjs');

const PANELS = [
  { key: 'engine', layout: { x: 0, y: 0, w: 4, h: 6, minW: 3, minH: 5 } },
  { key: 'wallet', layout: { x: 4, y: 0, w: 4, h: 6, minW: 3, minH: 5 } },
];

{
  // THE regression. A panel with nothing saved must arrive at its declared
  // size, not at react-grid-layout's 1x1 fallback.
  const out = deriveLayout(PANELS, {});
  assert.equal(out.length, 2, 'every panel gets an entry');
  assert.deepEqual(
    out.map((e) => [e.i, e.w, e.h]),
    [
      ['engine', 4, 6],
      ['wallet', 4, 6],
    ],
    'and it is the declared size',
  );
  ok('a panel with no saved box arrives at its declared size, never 1x1');
}

{
  const out = deriveLayout(PANELS, { engine: { x: 2, y: 3, w: 8, h: 10 } });
  const engine = out.find((e) => e.i === 'engine');
  assert.deepEqual([engine.x, engine.y, engine.w, engine.h], [2, 3, 8, 10], 'the saved box wins');
  const wallet = out.find((e) => e.i === 'wallet');
  assert.deepEqual([wallet.w, wallet.h], [4, 6], 'and its neighbour keeps its default');
  ok('a saved box wins over the default, panel by panel');
}

{
  // A build that raises a minimum must not be undone by an older arrangement.
  const out = deriveLayout(PANELS, { engine: { x: 0, y: 0, w: 1, h: 1 } });
  const engine = out.find((e) => e.i === 'engine');
  assert.deepEqual([engine.w, engine.h], [3, 5], 'a saved box below the minimum is raised to it');
  ok('the declared minimum outranks a smaller saved box');
}

{
  // The grid only ever reports what is on screen. Replacing would forget the
  // size of every panel currently switched off.
  const cur = { engine: { x: 0, y: 0, w: 4, h: 6 }, hidden: { x: 0, y: 6, w: 6, h: 9 } };
  const merged = mergeBoxes(cur, [{ i: 'engine', x: 1, y: 1, w: 5, h: 7 }]);
  assert.deepEqual(merged.engine, { x: 1, y: 1, w: 5, h: 7 }, 'the reported panel is updated');
  assert.deepEqual(merged.hidden, { x: 0, y: 6, w: 6, h: 9 }, 'the absent one is remembered');
  ok('a change is merged, so a switched-off panel keeps its size');
}

{
  const cur = { engine: { x: 0, y: 0, w: 4, h: 6 } };
  for (const bad of [{ i: 'engine', x: 0, y: 0, w: 0, h: 6 }, { i: 'engine', w: 4, h: 6 }, { i: 5, x: 0, y: 0, w: 4, h: 6 }, null]) {
    assert.deepEqual(mergeBoxes(cur, [bad]).engine, { x: 0, y: 0, w: 4, h: 6 }, `a ${JSON.stringify(bad)} entry is ignored`);
  }
  assert.equal(isBox({ x: 0, y: 0, w: 1, h: 1 }), true, 'a 1x1 is still structurally a box');
  assert.equal(isBox({ x: 0, y: 0, w: 0, h: 1 }), false, 'a zero-width one is not');
  ok('a degenerate or malformed box never replaces a good one');
}

{
  saveBoxes('g1', { engine: { x: 1, y: 2, w: 3, h: 4 } });
  assert.deepEqual(loadBoxes('g1'), { engine: { x: 1, y: 2, w: 3, h: 4 } }, 'round trips');
  assert.deepEqual(loadBoxes('g2'), {}, 'and grids do not share an arrangement');
  clearBoxes('g1');
  assert.deepEqual(loadBoxes('g1'), {}, 'reset clears it');
  ok('boxes round-trip per grid id, and reset clears them');
}

{
  // v1 stores can hold the 1x1 boxes the old bug wrote, so the key moved.
  assert.match(storageKey('my-layout'), /\.v2$/, 'the key is versioned');
  data.set('krypt.panels.my-layout', JSON.stringify([{ i: 'engine', x: 0, y: 0, w: 1, h: 1 }]));
  assert.deepEqual(loadBoxes('my-layout'), {}, 'a v1 store is not read at all');
  ok('the poisoned v1 arrangement is abandoned rather than migrated');
}

{
  for (const bad of ['{', 'null', '"text"', '{"not":"an array"}', '[1,2,3]']) {
    data.set(storageKey('corrupt'), bad);
    assert.deepEqual(loadBoxes('corrupt'), {}, `a ${bad} store reads as empty`);
  }
  ok('a corrupt store reads as empty rather than throwing');
}

{
  installWindow({ throwing: true });
  assert.doesNotThrow(() => saveBoxes('g', { a: { x: 0, y: 0, w: 1, h: 1 } }));
  assert.doesNotThrow(() => clearBoxes('g'));
  assert.deepEqual(loadBoxes('g'), {}, 'a blocked read is an empty arrangement');
  ok('storage being unavailable is survivable, not fatal');
}

console.log(`\npanellayout: ${passed}/${passed} passed`);
