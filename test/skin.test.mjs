// The look store (src/state/skin.ts): the attribute on <html>, the
// localStorage mirror that seeds it before React mounts, and the subscribers.
// Every storage and root access is injectable, so this runs with fakes and
// checks the contract rather than the DOM.

import assert from 'node:assert';
import fs from 'node:fs';
import { DEFAULT_SKIN, SKINS, _reset, applySkin, cssColour, getSkin, initSkin, readMirror, setSkin, subscribe, surfaceMuted, surfaceText } from './.skin.mjs';
import { accent, accentSoft } from './.statetheme.mjs';

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
  const attrs = new Map();
  return { setAttribute: (n, v) => void attrs.set(n, v), get: (n) => attrs.get(n) ?? null };
};

{
  _reset();
  assert.equal(readMirror(fakeStorage()), DEFAULT_SKIN, 'no mirror is the default look');
  assert.equal(readMirror(fakeStorage({ 'krypt.skin': 'hacker' })), 'hacker');
  assert.equal(readMirror(fakeStorage({ 'krypt.skin': 'neon' })), DEFAULT_SKIN, 'a look this build does not ship falls back');
  assert.equal(readMirror(null), DEFAULT_SKIN, 'no storage at all');
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined };
  assert.equal(readMirror(throwing), DEFAULT_SKIN, 'a storage that throws');
  ok('the mirror reads back only a look that ships, and never throws');
}

{
  _reset();
  const root = fakeRoot();
  applySkin('minimal', root);
  assert.equal(root.get('data-skin'), 'minimal');
  applySkin('classic', null);
  ok('the attribute lands on the root, and no root is tolerated');
}

{
  _reset();
  const storage = fakeStorage();
  const root = fakeRoot();
  let fired = 0;
  const off = subscribe(() => fired++);
  setSkin('futuristic', { storage, root });
  assert.equal(getSkin(), 'futuristic');
  assert.equal(root.get('data-skin'), 'futuristic');
  assert.equal(storage.map.get('krypt.skin'), 'futuristic', 'mirrored for the next boot');
  assert.equal(fired, 1);
  setSkin('futuristic', { storage, root });
  assert.equal(fired, 1, 'setting the same look again tells nobody');
  setSkin('not-a-look', { storage, root });
  assert.equal(getSkin(), DEFAULT_SKIN, 'an unknown look is coerced to the default, not written through');
  assert.equal(root.get('data-skin'), DEFAULT_SKIN);
  assert.equal(fired, 2);
  off();
  setSkin('hacker', { storage, root });
  assert.equal(fired, 2, 'unsubscribed');
  ok('setting a look applies, mirrors, and notifies once per real change');
}

{
  _reset();
  const root = fakeRoot();
  const seeded = initSkin({ storage: fakeStorage({ 'krypt.skin': 'hacker' }), root });
  assert.equal(seeded, 'hacker');
  assert.equal(getSkin(), 'hacker');
  assert.equal(root.get('data-skin'), 'hacker', 'seeded before React mounts');
  assert.equal(initSkin({ storage: fakeStorage(), root: fakeRoot() }), DEFAULT_SKIN);
  ok('init seeds the attribute from the mirror');
}

{
  assert.deepEqual([...SKINS], ['classic', 'futuristic', 'minimal', 'hacker', 'retro', 'xp']);
  assert.equal(DEFAULT_SKIN, 'classic', 'the default is the look everyone already had');
  ok('six looks, classic first');
}

{
  // 2026-09-20: a user opened Widgets and the Chart panel threw "Cannot
  // parse color: rgb(140 146 171)". The chart library parses colours with
  // its own regexes and knows only the comma form; the helpers that feed it
  // (surfaces here, the accent in theme.ts) must produce exactly that. The
  // regexes are read from the installed library so an upgrade that changes
  // its parser fails here, not on a user's screen.
  const lib = fs.readFileSync(new URL('../node_modules/lightweight-charts/dist/lightweight-charts.standalone.development.js', import.meta.url), 'utf8');
  const rgbSrc = /const rgbRe = (\/.+?\/);/.exec(lib)?.[1];
  const rgbaSrc = /const rgbaRe = (\/.+?\/);/.exec(lib)?.[1];
  assert.ok(rgbSrc && rgbaSrc, 'the library still parses rgb()/rgba() with two regexes');
  const rgbRe = new RegExp(rgbSrc.slice(1, -1));
  const rgbaRe = new RegExp(rgbaSrc.slice(1, -1));
  assert.ok(!rgbRe.test('rgb(140 146 171)'), 'the modern space form is what the library refuses');
  // Outside a document the helpers answer with their fallbacks.
  assert.equal(surfaceMuted(), 'rgb(140, 146, 171)');
  assert.equal(surfaceText(0.04), 'rgba(240, 237, 226, 0.04)');
  assert.equal(accent(), 'rgb(139, 124, 232)');
  assert.equal(accent(0.5), 'rgba(139, 124, 232, 0.5)');
  assert.equal(accentSoft(0.85), 'rgba(183, 166, 255, 0.85)');
  assert.equal(cssColour('1 2 3'), 'rgb(1, 2, 3)');
  for (const v of [surfaceMuted(), surfaceText(), accent(), accentSoft()]) assert.ok(rgbRe.test(v), `the chart library parses ${v}`);
  for (const v of [surfaceMuted(0.5), surfaceText(0.04), accent(0.5), accentSoft(0.85)]) assert.ok(rgbaRe.test(v), `the chart library parses ${v}`);
  ok('every colour string handed to the chart is one its library parses');
}

console.log(`\nskin: ${passed}/${passed} passed`);
