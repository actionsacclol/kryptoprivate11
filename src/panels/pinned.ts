// Pages the user pinned to their own sidebar.
//
// Widgets lets someone build a dashboard out of panels; this is the other
// half — the left-hand menu. Any page from any workspace can be pinned, so a
// user who lives in three pages does not have to keep going back to the Hub to
// hop between them.
//
// This is a tiny store rather than context because two very distant components
// need it: App renders the sidebar, and the Widgets page owns the picker.
// Threading a setter from one to the other would put a prop through the whole
// tree for a per-machine convenience.
//
// Like every other layout preference here, it is localStorage and every access
// is wrapped: losing a pin list is an annoyance, a page that will not render is
// not.

import type { RouteId } from '../components/Sidebar';

const KEY = 'krypt.panels.pinnedRoutes.v1';
const EVENT = 'krypt:pinned-routes';

/**
 * Routes that may never be pinned.
 *
 * `token` and `evmToken` are opened by clicking a token, not from a menu —
 * they mean nothing without one selected. `workspace` is the page doing the
 * pinning. Everything else in the app is fair game.
 */
const UNPINNABLE: ReadonlySet<string> = new Set(['token', 'evmToken', 'workspace']);

export function isPinnable(id: RouteId): boolean {
  return !UNPINNABLE.has(id);
}

export function loadPinned(): RouteId[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    // A route that no longer exists must not reach the sidebar, and a build
    // that removes a page must not leave a dead entry someone can click.
    return saved.filter((x): x is RouteId => typeof x === 'string' && isPinnable(x as RouteId));
  } catch {
    return [];
  }
}

export function savePinned(ids: readonly RouteId[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* a pin list is a convenience; losing it must never break the page */
  }
  // Same-document storage events do not fire, so the change is announced
  // directly. This is what lets the sidebar update while the picker is open.
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* nothing is listening, or CustomEvent is unavailable — the next mount reads it */
  }
}

/** Call `cb` whenever the pin list changes, in this window or another. */
export function subscribePinned(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}
