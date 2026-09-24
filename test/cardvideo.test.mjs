// Video backgrounds on share cards and trade replays (2026-09-21).
//
// The parts that can be checked without a browser: which container the
// recorder chooses, how long an export runs for, what counts as a video, and
// the source-level rules that are easy to break silently — the capture-before-
// mute ordering that carries the audio, the CSP that lets a local clip play
// at all, and the file kind travelling with the bytes so the extension cannot
// disagree with what is inside.

import assert from 'node:assert';
import fs from 'node:fs';
import { exportMsFor, isVideoFile, VIDEO_MAX_BYTES, VIDEO_MAX_EXPORT_MS } from './.cardvideo.mjs';
import { bestMime } from './.cardrecord.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};

{
  // What the picker lets through. An mp4 is the ask; the rest are the
  // containers a person plausibly has lying around.
  assert.equal(isVideoFile({ type: 'video/mp4' }), true);
  assert.equal(isVideoFile({ type: 'video/webm' }), true);
  assert.equal(isVideoFile({ type: 'video/quicktime' }), true);
  assert.equal(isVideoFile({ type: 'image/png' }), false);
  assert.equal(isVideoFile({ type: 'image/gif' }), false, 'a GIF stays on the GIF path, which decodes frames');
  assert.equal(isVideoFile({ type: '' }), false, 'a file with no type is not assumed to be a video');
  ok('a video file is told apart from an image, and a GIF is not one');
}

{
  // The export length. One whole pass, never longer than the cap, never so
  // short that the card is gone before it is read.
  assert.equal(exportMsFor({ durationMs: 8_000 }), 8_000, 'a normal clip records once, end to end');
  assert.equal(exportMsFor({ durationMs: 500 }), 2_000, 'a very short clip still gets two seconds');
  assert.equal(exportMsFor({ durationMs: 10 * 60 * 1000 }), VIDEO_MAX_EXPORT_MS, 'a long clip is capped');
  assert.equal(exportMsFor({ durationMs: 0 }), 6_000, 'an unknown duration falls back rather than recording nothing');
  assert.ok(VIDEO_MAX_EXPORT_MS <= 60_000, 'a share card is not a film');
  assert.ok(VIDEO_MAX_BYTES >= 50 * 1024 * 1024, 'a phone clip fits');
  ok('an export runs one pass of the clip, floored and capped');
}

{
  // The container choice. MP4 first, because it is the one every phone and
  // every chat app takes without re-encoding; WebM is the fallback; and a
  // build that can encode nothing says so rather than writing a broken file.
  const realMediaRecorder = globalThis.MediaRecorder;
  const withSupport = (supported) => {
    globalThis.MediaRecorder = function () {};
    globalThis.MediaRecorder.isTypeSupported = (m) => supported.some((s) => m.startsWith(s));
  };

  withSupport(['video/mp4', 'video/webm']);
  assert.equal(bestMime().ext, 'mp4', 'MP4 wins when both are available');

  withSupport(['video/webm']);
  assert.equal(bestMime().ext, 'webm', 'WebM when MP4 is not encodable');
  assert.match(bestMime().mime, /opus/, 'and the WebM pick carries an audio codec, or the sound has nowhere to go');

  withSupport([]);
  assert.equal(bestMime(), null, 'nothing encodable is null, not a guess');

  globalThis.MediaRecorder = undefined;
  assert.equal(bestMime(), null, 'and a build with no MediaRecorder at all is null too');

  if (realMediaRecorder === undefined) delete globalThis.MediaRecorder;
  else globalThis.MediaRecorder = realMediaRecorder;
  ok('the container is the best the build can really write, MP4 first, audio-capable');
}

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // THE ROUTING THAT CARRIES THE AUDIO. A silent preview and a file with
  // sound cannot both rest on `el.muted`, because whether a muted element
  // still yields audio through captureStream() is not a thing to bet the
  // feature on — if it does not, every export is silently soundless.
  //
  // So the graph is explicit: the recording tap is connected unconditionally
  // and the SPEAKERS are the branch that gets connected and disconnected.
  const vb = src('../src/components/terminal/videoBackground.ts');
  assert.match(vb, /source\.connect\(dest\)/, 'the recording tap is wired');
  const tap = vb.indexOf('source.connect(dest)');
  // The IMPLEMENTATION, not the two type declarations above it.
  const setAudible = vb.indexOf('setAudible: (on: boolean) => {');
  assert.ok(tap > 0 && setAudible > tap, 'and wired BEFORE anything decides whether it is audible');
  assert.match(vb, /if \(on\) source\.connect\(ctx\.destination\);/, 'audible means the speaker branch is connected');
  assert.match(vb, /else source\.disconnect\(ctx\.destination\);/, 'and muted means only that branch is dropped');
  // The recording destination is never the thing being disconnected.
  assert.doesNotMatch(vb, /disconnect\(dest\)/, 'the recording tap is never disconnected');
  // Detection happens before the graph takes the element's output over.
  const detect = vb.indexOf('const hasAudio = detectAudio(el)');
  const build = vb.indexOf('buildAudioGraph(el)');
  assert.ok(detect > 0 && build > detect, 'whether there IS audio is asked before the graph takes the output');
  // And the element must not stay muted behind the graph: in Chromium a
  // muted element attenuates its own source node, which would silence the
  // RECORDING as well as the speakers. It is dropped once play() has started,
  // where the graph already owns the output.
  assert.match(vb, /if \(graph\) el\.muted = false;/, 'the element is unmuted once the graph owns its output');
  const play = vb.indexOf('.play()');
  assert.ok(play > tap, 'and playback starts after the tap is wired, not before');
  ok('the recording tap is unconditional and only the speakers are muted');
}

{
  // Neither surface may reach past the graph and mute the element itself:
  // that is the ambiguous path the graph exists to replace.
  for (const file of ['../src/components/terminal/PnlCard.tsx', '../src/components/terminal/TradeReplay.tsx']) {
    const s = src(file);
    assert.match(s, /bgVideo\?\.setAudible\(previewSound\)/, `${file} toggles the speaker branch`);
    assert.doesNotMatch(s, /\.el\.muted\s*=/, `${file} never mutes the element behind the graph's back`);
    assert.match(s, /audioFrom: bgVideo\?\.stream \?\? null/, `${file} hands the recorded stream to the recorder`);
    assert.doesNotMatch(s, /getAudioTracks\(\)\.forEach|removeTrack/, `${file} never strips the audio track`);
  }
  ok('both surfaces mute the speakers only, and pass the audio to the recorder');
}

{
  // The bytes and the extension must agree. main names the file from the
  // `kind` the renderer sends, and an unknown kind falls back to gif rather
  // than inventing an extension.
  const ipc = src('../electron/ipc.ts');
  assert.match(ipc, /raw === 'mp4' \|\| raw === 'webm' \|\| raw === 'gif' \? raw : 'gif'/, 'the kind is validated, not trusted');
  assert.match(ipc, /cardName\(name, k\)/, 'and the filename is built from the validated kind');
  const preload = src('../electron/preload.ts');
  assert.match(preload, /card:saveFile', name, bytes, kind \?\? 'gif'/, 'preload always sends a kind');
  assert.match(preload, /card:copyFile', name, bytes, kind \?\? 'gif'/);
  ok('the file kind travels with the bytes and is validated in main');
}

{
  // A picked video plays from a blob: URL, which media-src has to allow.
  // Without this the element fails to load and the card silently keeps its
  // gradient — a CSP refusal looks exactly like a broken file.
  const sec = src('../electron/system/webSecurity.ts');
  // The policy lines are double-quoted and contain single-quoted 'self',
  // so the match runs to the closing DOUBLE quote.
  const media = [...sec.matchAll(/"media-src[^"]*"/g)].map((m) => m[0]);
  assert.ok(media.length >= 2, 'both the production and the dev policy set media-src');
  for (const m of media) assert.match(m, /blob:/, `media-src must allow blob: — found "${m}"`);
  // And the widening stops there: a background is local bytes, never a fetch.
  for (const m of media) assert.doesNotMatch(m, /https?:/, `media-src never opens a network origin — found "${m}"`);
  ok('the policy allows a local blob video and no remote media');
}

{
  // A video background cannot live in localStorage (tens of megabytes), so it
  // is kept on disk. The old code's answer to an oversized background was to
  // silently not remember it; a video that vanished every time would be the
  // same surprise.
  const card = src('../src/components/terminal/PnlCard.tsx');
  // Prettier wraps these calls across lines, so the pins tolerate the break.
  assert.match(card, /card\s*\.\s*saveBackground/, 'the picked video is handed to main to keep');
  assert.match(card, /card\s*\.\s*loadBackground/, 'and asked for again when the card opens');
  assert.match(card, /BG_VIDEO_KEY/, 'with a flag saying which kind of background is remembered');
  const ipc = src('../electron/ipc.ts');
  assert.match(ipc, /clearBackgroundFiles\(\); \/\/ one background/, 'keeping a new one replaces the old file');
  assert.match(ipc, /BG_TYPES\[mime\]/, 'and the type decides the extension, rather than the renderer naming a path');
  ok('a video background is kept on disk, one at a time, named by main');
}

{
  // ONE background at a time. The draw prefers the video, so a GIF or image
  // chosen while a video is in place has to drop the video — otherwise both
  // are set, the video keeps rendering, and the UI says a GIF was picked.
  const card = src('../src/components/terminal/PnlCard.tsx');
  const gifPick = card.slice(card.indexOf('onPick={(dataUrl)'), card.indexOf('onPick={(dataUrl)') + 700);
  assert.match(gifPick, /useVideo\(null\)/, 'the card drops a video when a GIF is picked');
  assert.match(card, /if \(isVideoFile\(file\)\)/, 'and a picked video takes the video path, not the data-URL one');

  const replay = src('../src/components/terminal/TradeReplay.tsx');
  const useBg = replay.slice(replay.indexOf('const useBackground'), replay.indexOf('const useBackground') + 700);
  assert.match(useBg, /setBgVideo\(\(prev\) => \{/, 'the replay drops a video when an image or GIF is chosen');
  assert.match(replay, /if \(isVideoFile\(file\)\)/, 'and routes a picked video to the video path');
  ok('choosing one kind of background drops the other, on both surfaces');
}

console.log(`\ncardvideo: ${passed}/${passed} passed`);
