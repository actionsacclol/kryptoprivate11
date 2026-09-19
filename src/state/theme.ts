// Accent theme — one attribute on <html>, and the CSS does the rest.
//
// Built the same way as lite mode (src/state/liteMode.ts), for the same
// reasons: App deliberately does not subscribe to app state, so a null-leaf
// host mirrors the setting into here; and settings arrive over IPC after the
// first render, so a localStorage mirror seeds the attribute before React
// mounts and nobody gets one purple frame before their blue loads.
//
// Per machine, like the layout and like lite mode. A theme is a property of
// the screen you are sitting at, not of the account.
//
// What a theme moves is ONLY the accent — see the comment block at the top of
// src/index.css for why the semantic colours (emerald up, rose down, gold
// money) are not themeable and never will be.

// The identity lives in shared/theme.ts: AppSettings is typed by it and main
// validates it, and shared/ does not import from src/.
import { DEFAULT_THEME, isThemeId, type ThemeId } from '@shared/theme';

export { THEMES, THEME_META, DEFAULT_THEME, isThemeId, type ThemeId } from '@shared/theme';

const KEY = 'krypt.theme';
const ATTR = 'data-theme';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type RootLike = { setAttribute(name: string, value: string): unknown };

let theme: ThemeId = DEFAULT_THEME;
const listeners = new Set<() => void>();

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some contexts throw on the accessor itself.
    return null;
  }
};
const defaultRoot = (): RootLike | null => (typeof document === 'undefined' ? null : document.documentElement);

/** The last theme this machine saw. Missing, unreadable or unknown = purple. */
export function readMirror(storage: StorageLike | null = defaultStorage()): ThemeId {
  try {
    const v = storage?.getItem(KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Put the attribute on the root. Tolerates no root at all. */
export function applyTheme(next: ThemeId, root: RootLike | null = defaultRoot()): void {
  try {
    root?.setAttribute(ATTR, next);
  } catch {
    /* a root that cannot be attributed is a page that cannot be styled anyway */
  }
}

export function getTheme(): ThemeId {
  return theme;
}

/**
 * Set the theme. Applies the attribute, mirrors it for the next boot, and
 * tells subscribers — once, and only when it actually changed.
 *
 * An unknown id is coerced to the default rather than written through: the
 * attribute matches no CSS block, so the app would render with no accent at
 * all and look broken in a way nothing would explain.
 */
export function setTheme(
  next: ThemeId,
  opts: { storage?: StorageLike | null; root?: RootLike | null } = {},
): void {
  const safe = isThemeId(next) ? next : DEFAULT_THEME;
  const storage = 'storage' in opts ? opts.storage ?? null : defaultStorage();
  const root = 'root' in opts ? opts.root ?? null : defaultRoot();
  applyTheme(safe, root);
  try {
    storage?.setItem(KEY, safe);
  } catch {
    /* no mirror; the attribute is applied and settings still hold the truth */
  }
  if (safe === theme) return;
  theme = safe;
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Seed from the mirror before React mounts. Idempotent. */
export function initTheme(opts: { storage?: StorageLike | null; root?: RootLike | null } = {}): ThemeId {
  const storage = 'storage' in opts ? opts.storage ?? null : defaultStorage();
  const root = 'root' in opts ? opts.root ?? null : defaultRoot();
  const next = readMirror(storage);
  applyTheme(next, root);
  theme = next;
  return next;
}

/** Test seam. */
export function _reset(): void {
  theme = DEFAULT_THEME;
  listeners.clear();
}

// ── Reading the accent from JavaScript ──────────────────────────────
//
// CSS gets the accent through `var(--krypt-accent)`. Canvas, SVG attributes,
// WebGL uniforms and chart libraries do not - they want a colour string, and
// they are handed one at render time. Those were all hardcoded `#8B7CE8`,
// which is why the first cut of themes changed the backdrop and almost
// nothing else (user report, 2026-09-18).
//
// Read from the live computed style rather than a table, so there is exactly
// one place a theme's colour is defined: src/index.css.

/** `139 124 232` — the raw channels, or the purple default if unreadable. */
export function accentChannels(): string {
  try {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '139 124 232';
    const v = getComputedStyle(document.documentElement).getPropertyValue('--krypt-accent').trim();
    return /^\d{1,3} \d{1,3} \d{1,3}$/.test(v) ? v : '139 124 232';
  } catch {
    return '139 124 232';
  }
}

/** A colour string for canvas, SVG or a chart library. `alpha` omitted = solid. */
export function accent(alpha?: number): string {
  const ch = accentChannels();
  return alpha === undefined ? `rgb(${ch})` : `rgb(${ch} / ${alpha})`;
}

/** The soft accent, same rules. */
export function accentSoft(alpha?: number): string {
  let ch = '183 166 255';
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--krypt-accent-soft').trim();
      if (/^\d{1,3} \d{1,3} \d{1,3}$/.test(v)) ch = v;
    }
  } catch {
    /* default stands */
  }
  return alpha === undefined ? `rgb(${ch})` : `rgb(${ch} / ${alpha})`;
}

/** Accent as `#rrggbb`, for the few consumers that will not parse rgb() -
 *  THREE.Color and WebGL uniforms among them. */
export function accentHex(): string {
  const [r, g, b] = accentChannels().split(' ').map((n) => Number(n));
  const hx = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** The soft accent as `#rrggbb`. */
export function accentSoftHex(): string {
  const m = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(accentSoft());
  if (!m) return '#B7A6FF';
  const hx = (n: string) => Math.max(0, Math.min(255, Number(n) | 0)).toString(16).padStart(2, '0');
  return `#${hx(m[1])}${hx(m[2])}${hx(m[3])}`;
}

/**
 * The accent as GLSL-ready channels, 0..1.
 *
 * The shader's constants were written as `139/255` and friends, so a plain
 * divide matches them exactly - no colour-space conversion, and swapping a
 * theme in cannot shift the brightness of the backdrop.
 */
export function accentVec3(): [number, number, number] {
  const [r, g, b] = accentChannels().split(' ').map((n) => Number(n) / 255);
  return [r, g, b];
}

/** The soft accent, same normalisation. */
export function accentSoftVec3(): [number, number, number] {
  const m = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(accentSoft());
  if (!m) return [0.718, 0.651, 1.0];
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
}
