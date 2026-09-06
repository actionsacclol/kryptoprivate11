// Replay frames are drawn, not laid out by a browser: overlapping text just
// renders on top of itself. This walks both shapes the panel offers and the
// awkward sizes in between.
import assert from 'node:assert';
import { approxWidth, replayLayout } from './.replaylayout.mjs';

const SHAPES = [
  { w: 1280, h: 720, name: '16:9' },
  { w: 720, h: 1280, name: '9:16' },
  { w: 1920, h: 1080, name: 'big 16:9' },
  { w: 540, h: 960, name: 'small 9:16' },
  { w: 900, h: 900, name: 'square' },
];

for (const s of SHAPES) {
  const l = replayLayout(s.w, s.h);

  // Each baseline must clear the ASCENDER of the line below it, or the
  // glyphs touch. A conservative ascender is 0.8 of the font size.
  const stack = [
    { y: l.wordmark, size: l.wordmarkSize, name: 'wordmark' },
    { y: l.ticker, size: l.tickerSize, name: 'ticker' },
    { y: l.big, size: l.bigSize, name: 'percentage' },
    { y: l.sol, size: l.solSize, name: 'SOL line' },
  ];
  for (let i = 1; i < stack.length; i++) {
    const gap = stack[i].y - stack[i - 1].y;
    assert.ok(
      gap >= stack[i].size * 0.8,
      `${s.name}: ${stack[i].name} (${stack[i].size}px) sits ${gap}px under ${stack[i - 1].name} — it would overlap`,
    );
  }

  // The chart gets real room, below the text and above the footer.
  assert.ok(l.chartTop > l.sol, `${s.name}: the chart starts below the numbers`);
  assert.ok(l.chartBottom > l.chartTop + s.h * 0.25, `${s.name}: the chart is worth drawing`);
  assert.ok(l.chartBottom < l.footer, `${s.name}: the chart clears the footer`);
  assert.ok(l.footer <= s.h - 20, `${s.name}: the footer is inside the frame`);

  // Nothing runs off the side.
  const usable = s.w - l.padX * 2;
  assert.ok(approxWidth('+9999.9%', l.bigSize) <= usable, `${s.name}: the widest percentage fits`);
  assert.ok(approxWidth('$LONGTICKER', l.tickerSize) <= usable, `${s.name}: a long ticker fits`);
  assert.ok(l.padX > 8, `${s.name}: there is a margin`);
  console.log(`ok  ${s.name}: nothing overlaps and nothing overflows`);
}

{
  // The case in the screenshot: 16:9, where the big number used to be sized
  // off the width and landed on the ticker.
  const l = replayLayout(1280, 720);
  assert.ok(l.big - l.ticker >= l.bigSize * 0.8, 'the percentage clears the ticker at 16:9');
  assert.ok(l.ticker - l.wordmark >= l.tickerSize * 0.8, 'the ticker clears the wordmark at 16:9');
  console.log('ok  the 16:9 frame that overlapped is fixed');
}
console.log('replaylayout: all tests passed');
