// Which accent themes exist. A leaf: no imports, no DOM.
//
// It lives in shared/ rather than with the renderer's theme store because
// `AppSettings.theme` is typed by it and main validates it — and shared/ does
// not import from src/, which is a rule the layering audit checks. The DOM
// half (the attribute on <html>, the localStorage mirror, the subscribers)
// stays in src/state/theme.ts and imports these names from here.
//
// What a theme moves is ONLY the accent. The colours that carry meaning —
// emerald for up, rose and crimson for down, gold for money — are fixed, and
// src/index.css explains why at the point where the values live.

export const THEMES = ['purple', 'blue', 'red', 'green', 'grey'] as const;

export type ThemeId = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeId = 'purple';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

/** Label and one-line description for the picker. English; the picker shows
 *  these beside a swatch, and a colour name is not worth eight catalogues. */
export const THEME_META: Record<ThemeId, { label: string; note: string }> = {
  purple: { label: 'Purple', note: 'The original' },
  blue: { label: 'Blue', note: 'Cooler, lower contrast' },
  red: { label: 'Red', note: 'Warm — kept clear of loss badges' },
  green: { label: 'Green', note: 'Teal — kept clear of fill badges' },
  grey: { label: 'Grey', note: 'No hue; only the data is coloured' },
};
