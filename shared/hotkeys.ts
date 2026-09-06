// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — trading hotkeys (term.txt section 22).
//
// These fire REAL trades on a single keypress, which makes them the most
// dangerous surface in the app. Three things constrain that:
//
//   1. They are OFF by default and each one must be bound deliberately.
//   2. They only act on the token currently open. There is no "hotkey buys
//      whatever is highlighted" — a keystroke can never hit a token the user
//      is not already looking at.
//   3. They are ignored while typing. Any input, textarea or contenteditable
//      focus swallows the key, so typing "1" into a filter box cannot buy.
//
// They also respect exactly the same gates as the trade panel: live
// execution on, engine armed, funded wallet, per-trade cap.
// ──────────────────────────────────────────────────────────────────────

export type HotkeyAction =
  | { kind: 'buy'; sol: number }
  | { kind: 'sell'; percent: number }
  | { kind: 'emergency_sell' };

export interface HotkeyBinding {
  id: string;
  /** Normalised combo, e.g. "1", "shift+s", "ctrl+alt+e". */
  combo: string;
  action: HotkeyAction;
  enabled: boolean;
}

export interface HotkeySettings {
  /** Master switch. Off = no trading key does anything. */
  enabled: boolean;
  /**
   * Require a confirmation dialog before a hotkey trade. Default ON — a
   * single keystroke spending real SOL with no confirmation is a footgun,
   * and the users who want it can turn it off knowing what they chose.
   */
  confirm: boolean;
  bindings: HotkeyBinding[];
}

/** The example set from term.txt, as real bindings. All disabled to start. */
export function defaultBindings(): HotkeyBinding[] {
  const b = (id: string, combo: string, action: HotkeyAction): HotkeyBinding => ({
    id, combo, action, enabled: false,
  });
  return [
    b('buy-1', '1', { kind: 'buy', sol: 0.1 }),
    b('buy-2', '2', { kind: 'buy', sol: 0.25 }),
    b('buy-3', '3', { kind: 'buy', sol: 0.5 }),
    b('sell-q', 'q', { kind: 'sell', percent: 25 }),
    b('sell-w', 'w', { kind: 'sell', percent: 50 }),
    b('sell-e', 'e', { kind: 'sell', percent: 100 }),
    b('panic', 'shift+s', { kind: 'emergency_sell' }),
  ];
}

export const DEFAULT_HOTKEYS: HotkeySettings = {
  enabled: false,
  confirm: true,
  bindings: defaultBindings(),
};

/** Turn a keyboard event into the normalised combo string used above. */
export function comboFromEvent(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

export function describeAction(a: HotkeyAction): string {
  switch (a.kind) {
    case 'buy':
      return `Buy ${a.sol} SOL`;
    case 'sell':
      return `Sell ${a.percent}%`;
    case 'emergency_sell':
      return 'Emergency sell — 100% of the open token';
  }
}

/** Combos we refuse to bind because the app or the OS needs them. */
const RESERVED = new Set([
  'ctrl+k', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+a', 'ctrl+z', 'ctrl+shift+i',
  'ctrl+r', 'ctrl+w', 'ctrl+q', 'f5', 'f12', 'escape', 'tab', 'enter', ' ',
]);

export function validateCombo(combo: string, bindings: HotkeyBinding[], selfId: string): { ok: boolean; message: string } {
  const c = combo.trim().toLowerCase();
  if (!c) return { ok: false, message: 'Press a key to bind' };
  if (RESERVED.has(c)) return { ok: false, message: `${c} is reserved by the app or the OS` };
  // A bare modifier is not a binding.
  if (['ctrl', 'alt', 'shift', 'meta'].includes(c)) return { ok: false, message: 'Add a key to the modifier' };
  const clash = bindings.find((b) => b.id !== selfId && b.combo === c && b.enabled);
  if (clash) return { ok: false, message: `Already bound to ${describeAction(clash.action)}` };
  return { ok: true, message: 'ok' };
}
