import { useEffect, useState } from 'react';
import { describeAction } from '@shared/hotkeys';
import type { AppSettings } from '@shared/types';
import { useHotkeys } from '../state/useHotkeys';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';

// Trading hotkeys (term.txt §22), hosted in a leaf that renders nothing.
//
// This used to live in `App`. The hotkey config is polled every 4 s so a
// binding changed in Settings takes effect at once — but holding that poll's
// result in ROOT state re-rendered the whole shell, every route included, on
// every tick. Down here the poll's setState reaches nobody but this null
// component; the keydown listener is installed once by useHotkeys and reads
// the latest settings through a ref, so behaviour is identical.
export function HotkeyHost({ mint, gated }: {
  /** The token the hotkeys may act on — only the OPEN token, never another. */
  mint: string | null;
  /** True while the onboarding gate is up: nothing behind it may fire. */
  gated: boolean;
}) {
  const toast = useToast();
  const modal = useModal();
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Hotkey config is read here rather than through AppStateProvider because
  // it must be fresh the moment it changes in Settings — a stale binding
  // that still fires would be the worst kind of surprise.
  useEffect(() => {
    const load = (): void => {
      void window.krypt.settings.get().then((r) => {
        if (r.ok && r.data) setSettings(r.data);
      });
    };
    load();
    const id = setInterval(load, 4_000);
    return () => clearInterval(id);
  }, []);

  useHotkeys({
    settings: settings?.hotkeys ?? null,
    mint,
    blocked: modal.isOpen || gated,
    onAction: (action) => {
      void (async () => {
        if (!mint) return;
        if (settings?.hotkeys.confirm !== false) {
          const yes = await modal.confirm({
            title: 'Hotkey trade',
            message: `${describeAction(action)} on the open token?`,
            confirmLabel: 'Trade',
            destructive: action.kind !== 'buy',
          });
          if (!yes) return;
        }
        if (action.kind === 'buy') {
          const r = await window.krypt.live.testTrade(mint, action.sol, false);
          r.ok ? toast.success(r.message) : toast.error(r.message);
        } else {
          const pct = action.kind === 'emergency_sell' ? 100 : action.percent;
          const r = await window.krypt.live.sellToken(mint, pct);
          r.ok ? toast.success(r.message) : toast.error(r.message);
        }
      })();
    },
  });

  return null;
}
