// The accent, for components that paint with JavaScript.
//
// Subscribes to the theme store so a canvas, an SVG or a chart re-renders with
// the new colour the moment the theme changes — CSS-driven elements get that
// for free from the variable, and these would otherwise keep the colour they
// were built with until something else happened to re-render them.

import { useSyncExternalStore } from 'react';
import { accent, accentHex, accentSoft, getTheme, subscribe } from './theme';

export interface Accent {
  /** `rgb(r, g, b)`, or `rgba(r, g, b, a)` when given an alpha — the comma
   *  form, because the chart library parses nothing else. */
  rgb: (alpha?: number) => string;
  /** The soft accent, same shape. */
  soft: (alpha?: number) => string;
  /** `#rrggbb`, for THREE.Color and WebGL uniforms. */
  hex: string;
}

export function useAccent(): Accent {
  // The theme id is the snapshot: it is a short string that changes only on a
  // click, so this re-renders exactly when the colour actually moved.
  useSyncExternalStore(subscribe, getTheme, getTheme);
  return { rgb: accent, soft: accentSoft, hex: accentHex() };
}
