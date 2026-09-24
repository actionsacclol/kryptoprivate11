# Video backgrounds, with sound — 2026-09-21

Asked: let users upload an MP4 background, with audio, on the share cards and
the videos.

Both surfaces take one now: the PnL/trade card and the trade replay. Pick or
drop an MP4 (also WebM, MOV, MKV), it plays behind the card, and the exported
file carries the clip's sound.

## What changed for the user

- **Upload takes video.** The same button and the same drag-and-drop that
  already took an image. A video replaces whatever background was there, and
  choosing an image or a GIF replaces the video — one background at a time.
- **The preview is silent until asked.** A card that starts shouting when it
  opens is a card people close. A Sound button appears only when the clip
  actually has audio, and it changes the speakers only, never the file.
- **The export is a real video with the sound in it.** MP4 where the build can
  encode one, WebM otherwise, and the button says which.
- **Copy video** puts the file on the clipboard the way Copy GIF already did,
  so it pastes straight into Discord, Telegram or Slack.
- **The background is remembered** across restarts.

## Why the audio goes through Web Audio

The obvious implementation is to mute the element for the preview and capture
it for the file. That rests on whether a muted element still yields audio
through `captureStream()`, and in Chromium a muted element also attenuates its
own `MediaElementAudioSourceNode`. Bet the feature on that and the failure mode
is every exported card being silently soundless, with nothing anywhere saying
so.

So the routing is explicit instead:

```
source ──► MediaStreamDestination   always — this is what gets recorded
       └─► ctx.destination          only while the preview is audible
```

The recording tap is connected unconditionally. "Muted" is the speaker branch
being disconnected, and nothing else. The element itself is unmuted once
playback has started, because by then the graph owns its output and the only
path to the speakers is the branch the toggle controls.

Three orderings hold this together, and all three are pinned in
`test/cardvideo.test.mjs`:

1. Audio is **detected** before the graph takes the element's output over —
   afterwards the element has no output of its own left to report on.
2. The recording tap is wired **before** anything decides whether the preview
   is audible.
3. `play()` happens after the tap exists, and only then is `muted` dropped.

## Storage

An image background is a data URL in `localStorage`, capped at 1.5 MB, and the
old behaviour for anything larger was to silently not remember it. A 40 MB clip
cannot go there at all, and a background that quietly vanished every time would
be the same surprise in a louder form.

A picked video is written to one file under `userData/card-background/` instead,
replacing whatever was there. Main names the file from the MIME type; nothing
takes a path from the renderer. A flag in `localStorage` records which kind of
background is remembered, so the card knows whether to read storage or ask main.

## The policy

`media-src` was `'self'`, which refuses a `blob:` URL — and a CSP refusal looks
exactly like a broken file. It is now `'self' blob:` in both the production and
the development policy. That is the renderer's own bytes from a file the user
handed it; no network origin is opened, and a test asserts `media-src` never
gains an `http(s):` source.

## Shared, not duplicated

The card and the replay each carried their own MediaRecorder block, and neither
could record audio. Both now go through `src/components/terminal/cardRecord.ts`,
so the audio path cannot be fixed in one and stay broken in the other. It picks
the best container the build can really write, refuses rather than resolving on
an empty recording, and takes either a fixed duration (the card) or a stop
signal (the replay, which ends when playback ends).

`card:saveFile` and `card:copyFile` now carry the file **kind** with the bytes,
validated in main, so the extension cannot disagree with what is inside. The
byte cap moved from 25 MB to 120 MB: a 30 s card at 6 Mbit/s is about 22 MB and
was sitting right against the old ceiling.

## Limits

| Thing | Value |
|---|---|
| Largest video accepted | 200 MB |
| Longest export | 30 s |
| Shortest export | 2 s |
| Export length otherwise | one whole pass of the clip |

A clip longer than the cap still plays and loops behind the card; only the
export is bounded. One pass, not two: with sound, a second loop is a repeat the
viewer hears.

## Not done

- **No GIF export from a video background.** A GIF has no sound, and
  re-encoding a clip into 150 palettised frames is a worse artefact than the
  file the user already has. The GIF buttons are hidden when a video is in
  place, and the video buttons take over.
- **The replay does not remember its background.** A replay is opened about one
  trade and closed; only the card keeps one.
- **Not verified on a running build.** The logic, the orderings and the IPC are
  pinned by tests that read the source, but nobody has yet picked a real MP4 in
  a packaged app and played the result back.
