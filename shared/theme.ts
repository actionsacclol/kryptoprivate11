// Which accent themes exist. A leaf: no imports, no DOM.
//
// It lives in shared/ rather than with the renderer's theme store because
// `AppSettings.theme` is typed by it and main validates it — and shared/ does
// not import from src/, which is a rule the layering audit checks. The DOM
// half (the attribute on <html>, the localStorage mirror, the subscribers)
// stays in src/state/theme.ts and imports these names from here.
//
// Two axes since 2026-09-20. A THEME (accent) moves one colour. A SKIN
// (look) moves the fonts, the surfaces, the corner radius and the effects —
// the character of the screen. Neither moves the colours that carry
// meaning — emerald for up, rose and crimson for down, gold for money — and
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

// ── Looks ─────────────────────────────────────────────────────────────

export const SKINS = ['classic', 'futuristic', 'minimal', 'hacker', 'retro', 'xp'] as const;

export type SkinId = (typeof SKINS)[number];

/** Classic is what the app always looked like; a save from before looks
 *  existed, or a build with no attribute on <html>, renders it. */
export const DEFAULT_SKIN: SkinId = 'classic';

export function isSkinId(v: unknown): v is SkinId {
  return typeof v === 'string' && (SKINS as readonly string[]).includes(v);
}

/** Label, a line on the character, and the fonts — English, like the accents. */
export const SKIN_META: Record<SkinId, { label: string; note: string; fonts: string }> = {
  classic: { label: 'Classic', note: 'The arcane terminal: engraved plates, serif headings, a soft glow', fonts: 'Cinzel · Spline Sans · JetBrains Mono' },
  futuristic: { label: 'Futuristic', note: 'Sharp corners, a faint grid, wide uppercase headings', fonts: 'Orbitron · Rajdhani · Share Tech Mono' },
  minimal: { label: 'Minimal', note: 'Flat and quiet. Nothing glows; more room around everything', fonts: 'Inter · Inter · JetBrains Mono' },
  hacker: { label: 'Hacker', note: 'A black screen, monospace everywhere, scanlines, a blinking cursor', fonts: 'VT323 · Share Tech Mono · Share Tech Mono' },
  retro: { label: 'Retro', note: 'An arcade cabinet: pixel headings with a hard shadow, chunky panels, faint CRT lines', fonts: 'Press Start 2P · Share Tech Mono · Share Tech Mono' },
  // The first LIGHT look. Its fonts are the system's own — Tahoma and
  // Trebuchet MS are what XP actually used, and on a machine without them
  // the stack falls to the OS sans; nothing is downloaded either way.
  xp: { label: 'XP / Y2K', note: 'Luna blue on white with a Bliss sky behind it — the first light look', fonts: 'Trebuchet MS · Tahoma · Lucida Console (your system’s)' },
};
