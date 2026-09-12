// Lite mode — one switch for a weak machine.
//
// The switch is `settings.reduceEffects` (Settings › Display "Reduce
// effects", and the Hub's "Laggy?" button — the same setting). It already
// kept the two WebGL scenes off; it now also stops every CSS transition and
// decorative animation, drops blur, glows, the big soft shadows and the
// star/dust backdrops, and tells framer-motion to skip transform and layout
// animation. All of that hangs off ONE class on <html>, `lite`, so the CSS
// does the work and no element needs a React re-render to comply.
//
// ─── Why a tiny store, not useAppState at the root ────────────────────────
//
// App deliberately does not subscribe to app state: the engine's 1/s status
// push would re-render every route (App.tsx says so). So LiteModeHost, a null
// leaf, mirrors the setting into here, and the root reads one boolean through
// useLite and re-renders only when it flips — which is a click, not a tick.
//
// ─── First paint ──────────────────────────────────────────────────────────
//
// Settings arrive over IPC after the first render. A localStorage mirror of
// the last value seeds the class before React mounts, so a lite user does
// not get one animated boot per launch. Per machine, like the layout: a slow
// PC is a property of the PC.
//
// ─── Deliberately NOT driven by prefers-reduced-motion ────────────────────
//
// Windows' "show animations" toggle maps to that media query and is off on a
// lot of gamer rigs — Radar3D keeps its orb turning for exactly this reason.
// Lite is something the user asks for, from a button that says what it does.

const KEY = 'krypt.lite';
const CLASS = 'lite';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type RootLike = { classList: { toggle(name: string, force?: boolean): unknown } };

let lite = false;
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

/** The last value this machine saw. Missing, unreadable or throwing = off. */
export function readMirror(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Put the class on (or take it off) the root. Tolerates no root at all. */
export function applyLite(on: boolean, root: RootLike | null = defaultRoot()): void {
  try {
    root?.classList.toggle(CLASS, on);
  } catch {
    /* a root that cannot be classed is a page that cannot be styled anyway */
  }
}

export function getLite(): boolean {
  return lite;
}

/**
 * Set the mode. Applies the class, mirrors the value for the next boot, and
 * tells subscribers — once, and only when the value actually changed.
 */
export function setLite(on: boolean, opts: { storage?: StorageLike | null; root?: RootLike | null } = {}): void {
  const storage = 'storage' in opts ? opts.storage ?? null : defaultStorage();
  const root = 'root' in opts ? opts.root ?? null : defaultRoot();
  applyLite(on, root);
  try {
    storage?.setItem(KEY, on ? '1' : '0');
  } catch {
    /* no mirror; the class is still applied and settings still hold the truth */
  }
  if (on === lite) return;
  lite = on;
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Seed from the mirror before React mounts. Idempotent. */
export function initLite(opts: { storage?: StorageLike | null; root?: RootLike | null } = {}): boolean {
  const storage = 'storage' in opts ? opts.storage ?? null : defaultStorage();
  const root = 'root' in opts ? opts.root ?? null : defaultRoot();
  const on = readMirror(storage);
  applyLite(on, root);
  lite = on;
  return on;
}

/** Test seam. */
export function _reset(): void {
  lite = false;
  listeners.clear();
}
