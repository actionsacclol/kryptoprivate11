# Liquid glass (2026-09-28)

The app's overlays are liquid glass now, and its standing surfaces are frosted
glass. The engine for the lens is `@samasante/liquid-glass` (MIT, React peer
only, 104 KB ESM). Its material mode puts one
`backdrop-filter: blur() saturate() url(#svg)` on the wrapper, where the
`url()` is an SVG displacement filter fed by a rounded-rect signed-distance map
the library draws on a canvas per surface, and lays a lit rim over it. Chromium
runs the live bend; Electron is Chromium, so this app always gets it. The
children are ordinary flow content: crisp, selectable, clickable.

## The measurement that shaped it

On the Hub, 1304×821, RTX 3080, 240 Hz, frame gaps over two seconds
(`test/glass.e2e.mjs` and the same probe with the filter swapped by a style):

| Configuration | p50 | p95 |
|---|---|---|
| 13 lenses (`blur+saturate+url`) over the 30 fps backdrop | 54 ms | 63 ms |
| the same 13 with `blur+saturate` only | 4.2 ms | 4.3 ms |
| `url()` on, but the backdrop canvas hidden | 4.2 ms | 4.3 ms |
| `url()` on two lenses over the backdrop | 4.2 ms | 17 ms |
| Lite mode | 4.2 ms | 4.3 ms |

The displacement pass costs about 5 ms per lens every time the pixels behind
it change, and a plain blur costs nothing anyone can measure. So the lens is
reserved for things that open and close, and nothing that stays on screen
carries it.

## What is what

| Surface | Material | Where |
|---|---|---|
| `sheet` | **lens** (library) | modal, token and wallet drawers, search palette, profile menu, toasts, onboarding card, the five plate dialogs, the Widgets picker, the callouts rail |
| `tile` | **frost** (`.glass-frost`: blur + saturate + lit rim + specular band, no displacement) | Hub tiles, the $KRYPTO card, the two Hub pills, Widgets panels |
| the frame | **chrome** (`.glass-chrome`: the old dark fill, a lit top edge, no filter) | top bar, sidebar |
| Lite mode, Hacker, Retro | **flat** (`.glass`: an opaque-ish panel, no filter) | every surface above |

Buttons (`PrimaryButton`, `GhostButton`, `IconButton`, the top bar's segmented
controls) are lit from above by `.glass-btn`, a pseudo-element gradient under
the label. Cards (`.plate`) gained a faint top-down wash and a brighter top
edge so a page of cards and a glass drawer read as one material family.

`src/state/glass.ts` is the pure half: the surface → material table, the tint
per surface (a Tailwind wash of `--krypt-panel`, so a light look gets light
glass with no second table), the lens optics, and how each look shifts them.
`src/components/LiquidGlass.tsx` renders one of the three from the lite and
skin stores. Only the sheet surface ever mounts the library, so the Hub's
dozen tiles generate no displacement maps at all.

## The rule about blur

`backdrop-filter` re-runs its filter every frame that anything painted behind
the element changes. A filtered surface may therefore sit over the backdrop
layer (frost is free there) or over the page for as long as an overlay is
open; the frame, on screen for the life of the app, carries no filter. A
frosted top bar was tried and read worse than the old near-black one, so the
frame kept its fills and gained only the lit edge.

Two things make `backdrop-filter` silently show nothing, and both are pinned
by `test/glass.test.mjs`:

- **A scrim under a lens must not blur.** An element with its own
  `backdrop-filter`, `opacity < 1`, `filter` or `mask` is a *backdrop root*: a
  lens inside it sees only that element's contents. Every scrim that holds a
  glass box now only dims (`bg-black/60…75`); the box frosts the page itself.
- **An overlay that wraps a lens slides, it does not fade.** `TokenDrawer`,
  `WalletDrawer` and the callouts rail animate `x` only. A parent fading from
  0 to 1 would hide the page from the lens until the fade ended, then snap.

Two more consequences the callers respect: a filtered element is a stacking
context, and it is the containing block for fixed descendants (nothing renders
a fixed overlay from inside a lens). The library's component takes no `ref`,
so the modal keeps its focusable box as a plain div inside the glass.

## Looks

Classic is the reference. Futuristic splits colour harder and frosts less;
Minimal is the Apple frost (almost no split, more blur); XP is Aero, a bright
rim on glass that is light by itself. Hacker and Retro have no glass: a black
terminal and an arcade cabinet are the wrong hosts for a slab of it, so they
render the flat surface, styled like their `.plate`. The tint never carries the
accent and the rim is white light; emerald, rose and gold stay data
(`test/theme.test.mjs` sweeps `glass.ts` like every file under `src/`).

## Pins

- `test/glass.test.mjs` (in the gate): the table covers every look; only
  Hacker and Retro are lens-less; Lite is always flat; the lens is a surface
  (frost ≥ 4, strength ≤ 0.1, no brightness veil, map ≤ 256, never
  desaturating); only overlays carry it; every tint is translucent; the
  stylesheet has the four classes, the Lite guard and the look switches; the
  frame carries no filter; every converted surface renders `<LiquidGlass>`;
  no `fixed inset-0` scrim in those files blurs; the three sliding overlays
  animate transform only.
- `test/glass.e2e.mjs` (live, `KRYPT_DEBUG_PORT=9333 npm run dev`): every
  visible lens has a computed `blur()` and `url(#…)`; the Hub's tiles have
  `blur()` and no `url()`; the frame has no filter; nothing filtered is on
  screen with nothing open; Hub and Discover hold p95 ≤ 12 ms; the palette
  hit-tests above the page; the confirm and the toast are lenses; Lite leaves
  zero filtered surfaces; screenshots of each state and each look. `RELOAD=1`
  boots the page fresh first.

## Known limits

- The library's rim is white at every look; the per-look `specular` scales it.
- A look changed by the picker re-renders every surface (the table is keyed
  by look); a look set as the DOM attribute alone, as the drivers do, moves
  the stylesheet but not the material.
- A lens over a live chart re-filters on every tick while the drawer is open.
  One lens, one tick a second, a few milliseconds: measured as fine, kept
  transient by construction.

## Follow-up 2026-09-29: the lag audit

Measured with a CDP trace of GPU-process / viz / renderer-compositor busy time (not only frame gaps,
which a strong GPU hides), dev app, 1304×821, RTX 3080, 240 Hz.

- **The backdrop's motion was the multiplier.** Every frosted panel and every lens re-runs its
  backdrop-filter each time the pixels behind it change. Widgets (18 frosted panels) with the quiet
  backdrop moving at 15 fps: GPU 3.9 % / viz 5.4 %; with it still: 0.1 % / 1.4 %. Blur radius made no
  measurable difference (10 px, 6 px and 3 px all cost the same). "Frost is free" held only while
  nothing behind it moved.
- **The callouts rail was a lens that never closes.** Open beside Widgets: GPU 7.1 % / viz 10.3 % /
  renderer compositor 11.6 %, 222 fps against 240. As frost: 4.5 % / 6.9 %, 236 fps.
- **A lens over a changing page is the expensive case**: the onboarding card over a live page ran
  the GPU process at ~20 % and the renderer compositor at ~46 %.
- Cards (`backdrop-blur-sm`) resolve to no filter here; not a cost.

**Changes:**
1. `LiquidMetal`: quiet pages hold a STILL frame (one draw, loop stops; redraw on resize, accent
   change or a return to the Hub). The Hub keeps its motion.
2. `CalloutsRail`: frost with the sheet's 80 % tint instead of the lens.

**After (same run):** Hub 4.1 % GPU with the backdrop moving; Widgets 0.5 %, Widgets + rail 0.8 %
(the no-filter floor is 0.6 %), 240 fps and p95 4.3 ms everywhere.

**Caught on the way:** the first version declared the loop state after `resize()`, which runs at once
and read `running` — "Cannot access 'running' before initialization", no backdrop anywhere. Typecheck
cannot see a temporal-dead-zone read in a closure; it showed up only in the dev app's console. Pinned in
`test/glass.test.mjs` (rail is frost, quiet pages stop the loop, a still field repaints).
