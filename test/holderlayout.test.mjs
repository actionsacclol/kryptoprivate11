// Bubble-map geometry tests.
//
// The holder map is a picture of concentration, so its two failure modes are
// both silent: overlapping bubbles overstate how many wallets there are, and
// a radius-proportional scale makes a large holder look far larger than it
// is. Neither is obvious by eye — hence these.
//
// The public Solana RPCs refuse `getTokenLargestAccounts` (429 and 403,
// checked 2026-08-24), so real holder data needs a Helius key and cannot be
// part of an offline suite. The geometry, which is the part that can be
// wrong, is tested here directly.

import assert from 'node:assert';
import { MAP_H, MAP_W, packCircles, radiusFor } from './.holderlayout.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const nodes = (pcts) => pcts.map((pct, i) => ({ id: `w${i}`, pct }));

// ── Radius scaling ────────────────────────────────────────────────────

test('bubble AREA is proportional to percentage, not radius', () => {
  // A 4% holder must be 2x the radius of a 1% holder (area 4x), not 4x.
  const r1 = radiusFor(1, 4);
  const r4 = radiusFor(4, 4);
  assert.ok(Math.abs(r4 / r1 - 2) < 0.01, `expected a 2x radius ratio, got ${(r4 / r1).toFixed(3)}`);
  const area1 = Math.PI * r1 * r1;
  const area4 = Math.PI * r4 * r4;
  assert.ok(Math.abs(area4 / area1 - 4) < 0.05, 'area ratio must match the percentage ratio');
});

test('radius is clamped so dust stays visible and whales stay on screen', () => {
  assert.ok(radiusFor(0.0001, 100) >= 7, 'a tiny holder must still be clickable');
  assert.ok(radiusFor(100, 100) <= 72, 'the largest bubble must fit the viewport');
});

test('a zero percentage does not produce NaN', () => {
  const r = radiusFor(0, 0);
  assert.ok(Number.isFinite(r) && r > 0, `expected a finite radius, got ${r}`);
});

// ── Packing ───────────────────────────────────────────────────────────

test('no two placed bubbles overlap', () => {
  const placed = packCircles(nodes([25, 18, 12, 9, 7, 6, 5, 4, 3, 3, 2, 2, 1, 1, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05]));
  assert.ok(placed.length > 10, 'most nodes should place');
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r);
      assert.ok(gap >= -0.001, `${a.node.id} and ${b.node.id} overlap by ${(-gap).toFixed(2)}px`);
    }
  }
});

test('every placed bubble is inside the viewport', () => {
  const placed = packCircles(nodes([40, 20, 15, 10, 8, 5, 3, 2, 1, 1, 1, 1]));
  for (const p of placed) {
    assert.ok(p.x - p.r >= 0, `${p.node.id} crosses the left edge`);
    assert.ok(p.x + p.r <= MAP_W, `${p.node.id} crosses the right edge`);
    assert.ok(p.y - p.r >= 0, `${p.node.id} crosses the top edge`);
    assert.ok(p.y + p.r <= MAP_H, `${p.node.id} crosses the bottom edge`);
  }
});

test('the layout is DETERMINISTIC across runs', () => {
  // A force simulation would fail this. Stability is why it is not one:
  // the same token must look the same every time you open it.
  const input = nodes([30, 20, 14, 9, 6, 4, 3, 2, 1, 0.5]);
  const a = packCircles(input);
  const b = packCircles(input);
  assert.deepEqual(
    a.map((p) => [p.node.id, Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round(p.r * 1000)]),
    b.map((p) => [p.node.id, Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round(p.r * 1000)]),
  );
});

test('input order does not change the layout', () => {
  const asc = nodes([1, 5, 20, 3, 9]);
  const desc = [...asc].reverse();
  const a = packCircles(asc);
  const b = packCircles(desc);
  const key = (list) => list.map((p) => `${p.node.id}@${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort().join('|');
  assert.equal(key(a), key(b), 'sorting inside the packer must make it order-independent');
});

test('the largest holder is placed at the centre', () => {
  const placed = packCircles(nodes([50, 10, 5, 2]));
  const biggest = placed.find((p) => p.node.pct === 50);
  assert.ok(biggest);
  assert.ok(Math.abs(biggest.x - MAP_W / 2) < 0.01);
  assert.ok(Math.abs(biggest.y - MAP_H / 2) < 0.01);
});

test('an empty holder list produces an empty layout, not a crash', () => {
  assert.deepEqual(packCircles([]), []);
});

test('a single holder is placed and centred', () => {
  const placed = packCircles(nodes([100]));
  assert.equal(placed.length, 1);
  assert.equal(placed[0].x, MAP_W / 2);
});

test('unplaceable bubbles are DROPPED rather than overlapped', () => {
  // Fifty equal holders cannot all fit; the map must lose some rather than
  // stack them, because stacked bubbles misstate the distribution.
  const many = nodes(new Array(50).fill(2));
  const placed = packCircles(many);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 0.001, 'dropped, never overlapped');
    }
  }
  assert.ok(placed.length <= many.length);
});

test('bubbles are ordered largest first so the eye lands on concentration', () => {
  const placed = packCircles(nodes([3, 40, 12, 1, 25]));
  for (let i = 1; i < placed.length; i++) {
    assert.ok(placed[i].node.pct <= placed[i - 1].node.pct);
  }
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
  console.log(`holderlayout: ${passed}/${cases.length} tests passed`);
}

await run();
