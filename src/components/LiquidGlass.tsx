// The liquid-glass surface (2026-09-28).
//
// One wrapper, used wherever the app wants a slab of glass: every overlay,
// the Hub's tiles, the Widgets panels. It decides ONE thing — what the box
// is made of right now — and renders one of three:
//
//   lens   @samasante/liquid-glass in material mode: a single
//          `backdrop-filter: blur() saturate() url(#displacement)` on the
//          wrapper and a lit rim drawn over it. The children are ordinary
//          flow content, crisp and interactive; the filter only ever touches
//          what is painted BEHIND the box. Overlays only — see glass.ts for
//          the frame cost that keeps it off anything that stays on screen.
//   frost  `.glass-frost` from src/index.css: blur + saturate + the same lit
//          rim, no displacement. Free (measured), so the Hub's tiles can sit
//          over the animating backdrop all day.
//   flat   `.glass`: an opaque-ish panel, no filter, no map generation, no
//          ResizeObserver. Lite mode and the two hard looks (Hacker, Retro).
//
// Deciding it HERE rather than with a CSS override means a lite machine
// never pays for the displacement map either — the library draws that on a
// canvas per lens.
//
// ── Rules the callers follow ───────────────────────────────────────────
//
// 1. The box behind a lens must be painted by something the lens can see.
//    `backdrop-filter` samples up to the nearest ancestor that has opacity,
//    a filter, a mask or a backdrop-filter of its own (the "backdrop root"),
//    so a glass card inside a fading parent sees only the parent — nothing —
//    until the fade ends, and a scrim with `backdrop-blur` hides the page
//    from every lens above it. Overlays therefore fade THE SCRIM (or nothing)
//    and slide the glass with a transform only; scrims under a lens carry
//    no blur. test/glass.test.mjs pins both.
// 2. A filtered wrapper is a stacking context and the containing block for
//    fixed descendants. Nothing renders a fixed overlay from inside one.
// 3. No `ref`: the library's component is a plain function. A caller that
//    needs focus (the modal) puts a focusable div inside.

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { Glass } from '@samasante/liquid-glass';
import { useLite } from '../state/useLite';
import { useSkin } from '../state/useSkin';
import { GLASS_TINT, glassModeFor, glassOpticsFor, type GlassSurface } from '../state/glass';
import { cls } from '../utils/format';

export type { GlassSurface } from '../state/glass';

export function LiquidGlass({
  surface,
  tint,
  className,
  style,
  display = 'block',
  children,
  ...rest
}: {
  surface: GlassSurface;
  /** A translucent background class in place of the surface's own tint —
   *  a toast is coloured by its level. Must stay translucent. */
  tint?: string;
  className?: string;
  style?: CSSProperties;
  /** The library sets `display: inline-block` inline, which beats any
   *  Tailwind `flex`; say what the box is here instead. */
  display?: CSSProperties['display'];
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'style' | 'className'>) {
  const lite = useLite();
  const skin = useSkin();
  const mode = glassModeFor(surface, skin, lite);
  if (mode === 'flat') {
    // No tint class here: `.glass` paints its own near-opaque panel, and a
    // translucent wash with nothing blurring behind it is just noise.
    return (
      <div className={cls('glass', className)} style={{ display, ...style }} {...rest}>
        {children}
      </div>
    );
  }
  if (mode === 'frost') {
    return (
      <div className={cls('glass-frost', tint ?? GLASS_TINT[surface], className)} style={{ display, ...style }} {...rest}>
        {children}
      </div>
    );
  }
  const optics = glassOpticsFor(skin);
  return (
    <Glass optics={optics ?? undefined} className={cls('glass-lens', tint ?? GLASS_TINT[surface], className)} style={{ display, ...style }} {...rest}>
      {children}
    </Glass>
  );
}
