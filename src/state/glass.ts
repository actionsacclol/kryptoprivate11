// Liquid glass — the material table (2026-09-28).
//
// The lens itself is @samasante/liquid-glass: one `backdrop-filter` that
// frosts, saturates and RUNS AN SVG DISPLACEMENT MAP over whatever is painted
// behind the element, so a surface bends the page like a slab of glass
// rather than tinting it like a sheet of plastic. Chromium does the live
// bend; Electron is Chromium, so this app always gets it. The children
// render crisp on top — the filter never touches the element's own pixels.
//
// This file is the pure half: which surfaces exist and what each one is
// made of. No React, no DOM — test/glass.test.mjs reads it through esbuild.
// The component that applies it is src/components/LiquidGlass.tsx.
//
// ── Two materials, because one of them costs frames ──────────────────
//
// MEASURED on the Hub (test/glass.e2e.mjs pattern, 1304×821, RTX 3080, 240 Hz):
//
//   13 lenses with the SVG url() over the 30 fps backdrop   p50 54 ms  (18 fps)
//   the same 13 with blur()+saturate() only                 p50  4 ms  (240 fps)
//   url() on, backdrop canvas hidden (nothing changing)      p50  4 ms
//   url() on 2 lenses over the backdrop                      p95 17 ms
//
// So the displacement pass costs ~5 ms per lens every time the pixels behind
// it change, and a plain blur costs nothing anyone can measure. A trading
// terminal cannot spend 5 ms a frame on a reflection, so:
//
// `sheet`  — the LENS. Anything that opens OVER the page and closes again:
//            modals, drawers, the search palette, menus, toasts, dialogs,
//            the onboarding card, the callouts rail. One or two at a time,
//            over a page that mostly sits still, for seconds.
// `tile`   — FROST: blur + saturate + a lit rim, no displacement. The Hub's
//            tiles and the Widgets panels sit over the animating backdrop
//            for as long as the page is open; they get the glass that is
//            free. Same cost the Widgets panels already paid.
//
// The top bar and the sidebar are neither: they are `.glass-chrome` in
// src/index.css, a dark fill with a lit edge and no filter at all. A frosted
// bar over the backdrop looked worse than the old near-black one (user,
// 2026-09-28), and the frame is the one thing that is on screen forever.
//
// ── What a look does to it ─────────────────────────────────────────────
//
// Classic is the reference. Futuristic splits colour harder and frosts less;
// Minimal is the Apple frost (almost no split, more blur); XP is Aero — a
// bright rim on glass that is light BY ITSELF, because every tint below
// reads `--krypt-panel`, which XP sets to white. Hacker and Retro have no
// glass at all: a black terminal and an arcade cabinet are the wrong hosts
// for a slab of it. They, and Lite mode, get the flat `.glass` surface.
//
// Nothing here carries the accent or a colour that means something. The
// tint is the look's panel colour; the rim is white light at an angle.
// Emerald, rose and gold stay data (test/theme.test.mjs sweeps this file).

import type { GlassOptics } from '@samasante/liquid-glass';
import { SKINS, type SkinId } from '@shared/theme';

/** Re-exported so the test that walks the table walks the same list. */
export { SKINS } from '@shared/theme';

export type GlassSurface = 'sheet' | 'tile';

export const GLASS_SURFACES: readonly GlassSurface[] = ['sheet', 'tile'];

/** What each surface is made of when glass is allowed at all. */
export type GlassMode = 'lens' | 'frost' | 'flat';

export const GLASS_MODE: Record<GlassSurface, Exclude<GlassMode, 'flat'>> = {
  sheet: 'lens',
  tile: 'frost',
};

/**
 * The tint, as a Tailwind class on the wrapper: the material treats the
 * element's translucent background as the glass colour. It reads the look's
 * panel channel through `--krypt-panel`, so a light look gets light glass
 * and no per-look tint table is needed. Must stay translucent — an opaque
 * background hides everything behind it, and the library warns in dev.
 */
export const GLASS_TINT: Record<GlassSurface, string> = {
  sheet: 'bg-krypt-panel/80',
  tile: 'bg-krypt-panel/45',
};

/**
 * Displacement-map resolution for the lens. The map is a rounded-rect
 * signed-distance field drawn to a canvas once per size change; 256 is
 * plenty for a rim band and a quarter of the library's 512 default.
 */
const MAP = 256;

/** The lens, on the reference look. */
const SHEET: Partial<GlassOptics> = {
  mapSize: MAP,
  strength: 0.05,
  depth: 0.5,
  curvature: 0.3,
  bend: 0.45,
  bendWidth: 0.14,
  dispersion: 0.3,
  frost: 12,
  saturate: 1.15,
  sheen: 0.35,
  sheenWidth: 3,
  sheenFalloff: 1.5,
  sheenAngle: 45,
  glow: 0.1,
  glowSpread: 1,
  glowFalloff: 0.5,
  specular: 0.8,
  brightness: 0,
};

type LookShift = (o: Partial<GlassOptics>) => Partial<GlassOptics>;

/** How each look moves the lens. `null` = no glass on this look at all. */
const LOOK: Record<SkinId, LookShift | null> = {
  classic: (o) => o,
  futuristic: (o) => ({
    ...o,
    dispersion: (o.dispersion ?? 0) * 1.5,
    sheen: 0.5,
    specular: 0.9,
    frost: Math.max(4, (o.frost ?? 0) - 3),
  }),
  minimal: (o) => ({
    ...o,
    dispersion: 0.1,
    bend: 0.3,
    frost: (o.frost ?? 0) + 4,
    sheen: 0.25,
    specular: 0.6,
  }),
  xp: (o) => ({
    ...o,
    dispersion: 0.25,
    frost: Math.max(o.frost ?? 0, 10),
    sheen: 0.5,
    specular: 1.2,
  }),
  hacker: null,
  retro: null,
};

/** The looks that carry glass. Derived from the table so the two cannot disagree. */
export const GLASS_LOOKS: readonly SkinId[] = SKINS.filter((s) => LOOK[s] !== null);

/** What a surface is made of right now: Lite and the hard looks are flat. */
export function glassModeFor(surface: GlassSurface, skin: SkinId, lite: boolean): GlassMode {
  if (lite || LOOK[skin] === null) return 'flat';
  return GLASS_MODE[surface];
}

/** The lens for the sheet surface on a look, or null when that look has no glass. */
export function glassOpticsFor(skin: SkinId): Partial<GlassOptics> | null {
  const shift = LOOK[skin];
  if (!shift) return null;
  return shift({ ...SHEET });
}
