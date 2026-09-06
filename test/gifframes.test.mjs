// Frame timing for animated backgrounds. The decode itself needs a browser,
// but which frame is showing at a given moment is arithmetic, and getting it
// wrong means a background that stutters or freezes in an exported video.
import assert from 'node:assert';
import { canDecodeAnimation, dataUrlToBytes, dataUrlType, decodeAnimation, frameAt } from './.gifframes.mjs';

const anim = (delays) => ({
  frames: delays.map((_, i) => ({ id: i })),
  delays,
  width: 10,
  height: 10,
  durationMs: delays.reduce((a, d) => a + d, 0),
  close: () => {},
});

{
  const a = anim([100, 100, 100]);
  assert.equal(frameAt(a, 0).id, 0, 'the loop starts on the first frame');
  assert.equal(frameAt(a, 99).id, 0);
  assert.equal(frameAt(a, 100).id, 1, 'the boundary belongs to the next frame');
  assert.equal(frameAt(a, 250).id, 2);
  console.log('ok  each frame is shown for its own delay');
}

{
  // Uneven delays are the normal case in a real GIF.
  const a = anim([40, 500, 60]);
  assert.equal(frameAt(a, 39).id, 0);
  assert.equal(frameAt(a, 41).id, 1);
  assert.equal(frameAt(a, 539).id, 1, 'a long frame holds');
  assert.equal(frameAt(a, 541).id, 2);
  console.log('ok  uneven frame delays are respected');
}

{
  const a = anim([100, 100, 100]);
  assert.equal(frameAt(a, 300).id, 0, 'the loop wraps');
  assert.equal(frameAt(a, 1250).id, 0, 'and keeps wrapping (1250 into a 300 ms loop is 50 ms in)');
  assert.equal(frameAt(a, 1450).id, 2, 'four loops plus 250 ms is the third frame');
  assert.equal(frameAt(a, 30_000).id, 0, 'a long recording never runs off the end');
  console.log('ok  the loop wraps forever, so a long video never freezes');
}

{
  const one = anim([100]);
  assert.equal(frameAt(one, 5_000).id, 0, 'a single frame is always itself');
  const zero = { ...anim([0, 0]), durationMs: 0 };
  assert.equal(frameAt(zero, 10).id, 0, 'a zero-length loop does not divide by zero');
  console.log('ok  degenerate animations do not break the draw loop');
}

{
  // The bytes are parsed by hand because fetch() on a data: URL is refused
  // by this app's connect-src policy — which is what made every GIF fall
  // back to a still in the first place.
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const bytes = dataUrlToBytes(GIF);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, 'the payload decodes');
  assert.equal(String.fromCharCode(...bytes.slice(0, 3)), 'GIF', 'and it really is a GIF');
  assert.equal(dataUrlType(GIF), 'image/gif');
  assert.equal(dataUrlType('data:image/png,abc'), 'image/png', 'a type without ;base64 still reads');
  assert.equal(dataUrlToBytes('data:image/png,abc'), null, 'but only base64 payloads are decoded');
  assert.equal(dataUrlToBytes('not a data url'), null);
  assert.equal(dataUrlToBytes('data:image/gif;base64,!!!not base64!!!'), null);
  console.log('ok  data URLs are read without touching the network');
}

{
  // Off a browser there is no decoder, and the caller must get a REASON
  // rather than an exception, so the UI can say why it shows a still.
  assert.equal(canDecodeAnimation(), false, 'no ImageDecoder outside a browser');
  const r = await decodeAnimation('data:image/gif;base64,R0lGODlhAQABAAAAACw=');
  assert.equal(r.ok, false);
  assert.match(r.reason, /decoder/, r.reason);
  const bad = await decodeAnimation('not a data url');
  assert.equal(bad.ok, false);
  console.log('ok  a failed decode explains itself instead of throwing');
}
console.log('gifframes: all tests passed');
