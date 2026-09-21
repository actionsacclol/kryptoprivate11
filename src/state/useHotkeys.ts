import { useEffect, useRef } from 'react';
import { comboFromEvent, type HotkeyAction, type HotkeySettings } from '@shared/hotkeys';

// Trading hotkeys (term.txt §22).
//
// The three guards from the contract, implemented:
//
//   1. `settings.enabled` gates everything, and each binding has its own
//      `enabled` flag. Both ship off.
//   2. `mint` is the token currently OPEN. When it is null nothing fires —
//      there is no way for a keystroke to hit a token the user is not
//      looking at.
//   3. Typing swallows the key. Any input/textarea/select/contenteditable
//      focus, or a modifier-only press, returns early — so typing "1" into
//      the filter box cannot spend 0.1 SOL.
//
// `keydown` is used with capture so this runs before any component handler,
// and `repeat` events are dropped: holding a key down must not fire N trades.

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable === true) return true;
  // A focused play area (the Games panel) owns every key it gets, the way a
  // text field does: a Space to flap or an arrow to steer is not a trade.
  return typeof el.closest === 'function' && el.closest('[data-swallows-keys]') !== null;
}

export function useHotkeys({
  settings,
  mint,
  blocked = false,
  onAction,
}: {
  settings: HotkeySettings | null;
  /** The token currently open, or null. */
  mint: string | null;
  /** True while a modal is showing. A hotkey pressed against an open
   *  confirm must not stack a second confirm — each would resolve on its
   *  own and two trades would fire from one intent. */
  blocked?: boolean;
  onAction: (action: HotkeyAction, combo: string) => void;
}): void {
  // Held in refs so the listener is installed once and never goes stale —
  // re-binding on every settings change would drop keys mid-press.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const s = settingsRef.current;
      if (!s || !s.enabled) return;
      if (e.repeat) return;
      if (blockedRef.current) return;
      if (document.querySelector('[data-modal]')) return;
      if (isTyping(e.target)) return;
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      if (!mintRef.current) return;

      const combo = comboFromEvent(e);
      const binding = s.bindings.find((b) => b.enabled && b.combo === combo);
      if (!binding) return;

      e.preventDefault();
      e.stopPropagation();
      onActionRef.current(binding.action, combo);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);
}
