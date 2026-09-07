// The animated-card export plan (gifExport.ts): which background frames
// become GIF frames, at what delays, at what size. The rule that matters is
// that subsampling keeps the LOOP LENGTH — dropped frames give their time
// to the frame that stands in for them — and that the output never exceeds
// the caps that keep the file postable.
import assert from 'node:assert';
import { MAX_FRAMES, MAX_WIDTH, planGifExport } from './.gifexport.mjs';

{
  // Fewer frames than the cap: every frame is kept, timing untouched.
  const delays = [100, 100, 50, 150];
  const p = planGifExport({ delays }, 1200, 675);
  assert.deepEqual(p.picks, [0, 1, 2, 3]);
  assert.deepEqual(p.delays, delays);
  assert.deepEqual(p.elapsed, [0, 100, 200, 250]);
  assert.equal(p.width, MAX_WIDTH, 'a 1200-wide card is scaled to the cap');
  assert.equal(p.height, Math.round(675 * (MAX_WIDTH / 1200)));
  console.log('ok  a short background keeps every frame and its timing');
}

{
  // 150 frames of 40 ms: subsampled to the cap, loop length preserved.
  const delays = Array.from({ length: 150 }, () => 40);
  const p = planGifExport({ delays }, 1200, 675);
  assert.ok(p.picks.length <= MAX_FRAMES, `at most ${MAX_FRAMES} output frames: ${p.picks.length}`);
  assert.equal(p.delays.reduce((a, d) => a + d, 0), 150 * 40, 'the loop is as long as it was');
  assert.equal(p.elapsed[0], 0);
  assert.ok(p.elapsed.every((t, i) => i === 0 || t > p.elapsed[i - 1]), 'elapsed is increasing');
  assert.ok(p.delays.every((d) => d >= 20), 'no delay below what browsers honour');
  console.log('ok  a long background is subsampled without changing its loop length');
}

{
  // A small card is not upscaled.
  const p = planGifExport({ delays: [100] }, 400, 225);
  assert.equal(p.width, 400);
  assert.equal(p.height, 225);
  assert.deepEqual(p.picks, [0]);
  console.log('ok  a small card keeps its size');
}

console.log('gifexport: all tests passed');
