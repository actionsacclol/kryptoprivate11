# Chart interaction — measured 2026-09-20

The report: the Terminal's chart is laggy — dragging and wheel-zooming take
about two seconds to show, "somewhat ass atm".

## How it was measured

`npm run test:chart:e2e` (test/chartperf.e2e.mjs) attaches to the running dev
app over the DevTools protocol, opens a token, and DRAGS and WHEEL-ZOOMS the
chart with real input events (`Input.dispatchMouseEvent`) while sampling,
inside the renderer: frame gaps (a requestAnimationFrame loop), long tasks
(PerformanceObserver), IPC round trips to the main process every 50 ms
(`settings.get`), the browser→renderer acknowledgement time of every input
event, and a CPU profile (Profiler domain, 0.5 ms sampling) summarised by
file and by function.

Run on the developer's machine (RTX 3080, hardware acceleration on, 240 Hz),
against the same profile the user trades with (block feed on, scanner
running, live armed), on a Trending token at 1m and on the 1s interval.

## What it found

| phase | input ack p50 / max | frame gap p50 / max | IPC ping p50 / max | long tasks | chart code in profile |
|---|---|---|---|---|---|
| idle | — | 4.2 / 4 ms | 0.4 / 2 ms | 0 | 0.2 % |
| drag (63 events, 1.3 s) | 3 / 6 ms | 4.2 / 8 ms | 0.3 / 1 ms | 0 | 1.0 % |
| wheel (41 events, 2.2 s) | 6 / 11 ms | 4.2 / 8 ms | 0.4 / 25 ms | 0 | 0.6 % |
| fast drag after (62 events, 0.9 s) | 3 / 6 ms | 4.2 / 8 ms | 0.3 / 1 ms | 0 | 1.0 % |

The renderer's main thread was over 90 % idle during every phase; the chart
library was around 1 % of samples; React reconciliation under 1 %; no frame
was late; the main process answered in under a millisecond. Same numbers at
the 1s interval. **In this setup the chart responds to input inside one
frame. The two-second lag did not reproduce.**

What that rules out: renderer JavaScript (React re-render storms, the tick
and tail-poll updates, the priority-line and marker effects), main-process
stalls from the engine blocking input routing, and GPU fallback (the profile
reports hardware acceleration on; the setting is on in the user's profile).

What it does not rule out: the PACKAGED build (the profiler needs the dev
debug port), a specific token or moment with a much busier event stream, the
My Layout chart panel (not in the user's enabled panels, see below), or an
OS-level input issue (mouse polling, pointer precision) that synthetic
events do not pass through.

## What changed anyway

Two things were wrong by inspection, one is a feel improvement:

- **Height changes re-created the chart.** `KryptChart`'s create effect
  depended on `height`, so the My Layout chart panel — whose ResizeObserver
  feeds the height on every pointer move of a resize — tore the chart down
  and rebuilt it (new canvases, full setData, refit, pan and zoom lost)
  dozens of times a second. Height is now `chart.applyOptions({ height })`
  on the same chart.
- **Fresh `[]` props defeated the memo** on the layout panel's chart, so a
  panel drag re-ran the marker and price-line effects on every pointer move.
  Stable empties now.
- **Interaction options spelled out**, with kinetic scroll on the mouse (a
  drag keeps its momentum on release, as on every other trading chart; the
  library's default is off for the mouse), pinch zoom, axis drags to scale,
  and double-click on an axis to reset it.

Re-measured after the change: identical numbers, the chart still pans and
zooms. Nothing here can fix a lag that the measurement did not see.

## If it is still laggy

Say which of these it is, and the measurement can be aimed:

1. The Token page chart or the My Layout chart panel (the panel was the one
   re-creating itself on resize; it is not in this profile's enabled panels).
2. The packaged 3.x build or `npm run dev`.
3. Whether Lite mode (Hub → "Laggy?") changes it — that removes the WebGL
   backdrop and every blur behind the canvas, which the profiler cannot
   see because they cost on the GPU, not the main thread.
4. A token and interval where it happens, so the same driver can open it:
   `SCENARIO=new INTERVAL=1s npm run test:chart:e2e`.
