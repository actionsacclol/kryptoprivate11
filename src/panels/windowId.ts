// Which panel, if any, this window is.
//
// Deliberately its own module with NO imports. `isPanelWindow` is needed by
// things that sit very high in the tree — the toast layer, the app entry —
// and reading it from PanelWindow.tsx would drag the whole panel registry in
// with it. That registry imports AppStateProvider, which imports the toast
// layer, so asking PanelWindow this question created a genuine import cycle:
//
//   ToastProvider -> PanelWindow -> registry -> AppStateProvider -> ToastProvider
//
// A cycle like that can "work" and then hand back `undefined` at module init
// depending on which file the bundler reaches first. One tiny leaf module
// costs nothing and cannot participate in one.

/** `#panel=<id>` — how main tells a window which panel it is. */
export function panelIdFromHash(hash: string): string | null {
  const m = /(?:^|[#&])panel=([a-zA-Z0-9_-]{1,40})(?:&|$)/.exec(hash || '');
  return m ? m[1] : null;
}

/** True when THIS window is a popped-out panel rather than the app. */
export function isPanelWindow(): boolean {
  return panelIdFromHash(typeof window === 'undefined' ? '' : window.location.hash) !== null;
}
