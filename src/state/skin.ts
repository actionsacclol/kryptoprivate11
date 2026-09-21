// The look ("skin") — one attribute on <html>, and the CSS does the rest.
//
// The second axis of theming (2026-09-20). An accent (src/state/theme.ts)
// moves one colour; a look moves the fonts, the surfaces, the corner radius
// and the effects — the whole character of the screen — and leaves the
// accent to the accent. Built the same way as the accent and lite mode, for
// the same reasons: App does not subscribe to app state, so a null-leaf host
// mirrors the setting into here; settings arrive over IPC after the first
// render, so a localStorage mirror seeds the attribute before React mounts
// and nobody gets one Cinzel frame before their Orbitron loads.
//
// Per machine, like the accent. A look is a property of the screen you are
// sitting at, not of the account.
//
// What a look never moves: emerald (up), rose and crimson (down), gold
// (money). src/index.css says why where the values live.

import { DEFAULT_SKIN, isSkinId, type SkinId } from '@shared/theme';

export { SKINS, SKIN_META, DEFAULT_SKIN, isSkinId, type SkinId } from '@shared/theme';

const KEY = 'krypt.skin';
const ATTR = 'data-skin';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type RootLike = { setAttribute(name: string, value: string): unknown };

let skin: SkinId = DEFAULT_SKIN;
const listeners = new Set<() => void>();

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const defaultRoot = (): RootLike | null => (typeof document === 'undefined' ? null : document.documentElement);

/** The last look this machine saw. Missing, unreadable or unknown = classic. */
export function readMirror(storage: StorageLike | null = defaultStorage()): SkinId {
  try {
    const v = storage?.getItem(KEY);
    return isSkinId(v) ? v : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** Put the attribute on the root. Tolerates no root at all. */
export function applySkin(next: SkinId, root: RootLike | null = defaultRoot()): void {
  try {
    root?.setAttribute(ATTR, next);
  } catch {
    /* a root that cannot be attributed is a page that cannot be styled anyway */
  }
}

export function getSkin(): SkinId {
  return skin;
}

/**
 * Set the look. Applies the attribute, mirrors it for the next boot, and
 * tells subscribers — once, and only when it actually changed. An unknown
 * id is coerced to classic rather than written through: an attribute no CSS
 * block matches would leave the variables at their defaults, which IS
 * classic, so coercing merely makes the mirror say what the screen shows.
 */
export function setSkin(next: SkinId, opts: { storage?: StorageLike | null; root?: RootLike | null } = {}): void {
  const safe = isSkinId(next) ? next : DEFAULT_SKIN;
  const storage = 'storage' in opts ? opts.storage ?? null : defaultStorage();
  const root = 'root' in opts ? opts.root ?? null : defaultRoot();
  applySkin(safe, root);
  try {
    storage?.setItem(KEY, safe);
  } catch {
    /* no mirror; the attribute is applied and settings still hold the truth */
  }
  if (safe === skin) return;
  skin = safe;
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Seed from the mirror before React mounts. Idempotent. */
export function initSkin(opts: { storage?: StorageLike | null; root?: RootLike | null } = {}): SkinId {
  const storage = 'storage' in opts ? opts.storage ?? null : defaultStorage();
  const root = 'root' in opts ? opts.root ?? null : defaultRoot();
  const next = readMirror(storage);
  applySkin(next, root);
  skin = next;
  return next;
}

/** Test seam. */
export function _reset(): void {
  skin = DEFAULT_SKIN;
  listeners.clear();
}

// ── Reading the surfaces from JavaScript ──────────────────────────────
//
// The chart is a canvas: it cannot resolve `var()`, it wants a colour
// string. These read the live computed style, so there is exactly one
// place a look's surfaces are defined — src/index.css — and the chart's
// axes re-ink themselves when the look changes (see KryptChart).
//
// The string is the LEGACY comma form, `rgb(r, g, b)` / `rgba(r, g, b, a)`,
// on purpose. CSS and canvas accept either form, but lightweight-charts
// (4.2.3) parses colours itself with `^rgb\(\s*(-?\d{1,10})\s*,` … and
// throws "Cannot parse color: rgb(140 146 171)" on the modern
// space-separated one — which is what a user saw the moment they opened
// Widgets with the Chart panel on (2026-09-20). test/skin.test.mjs pins
// these against the library's own regexes.

/** `140 146 171` (+ alpha) → a colour string every consumer parses. */
export function cssColour(channels: string, alpha?: number): string {
  const [r, g, b] = channels.split(' ');
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function channels(name: string, fallback: string): string {
  try {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^\d{1,3} \d{1,3} \d{1,3}$/.test(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** The text colour of the current look, for canvas and SVG. */
export function surfaceText(alpha?: number): string {
  return cssColour(channels('--krypt-text', '240 237 226'), alpha);
}

/** The muted text colour of the current look. */
export function surfaceMuted(alpha?: number): string {
  return cssColour(channels('--krypt-muted', '140 146 171'), alpha);
}

/** The mono font stack of the current look, for a canvas that draws text. */
export function monoFont(): string {
  const fallback = '"JetBrains Mono", ui-monospace, monospace';
  try {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || fallback;
  } catch {
    return fallback;
  }
}
