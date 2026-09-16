// The token tab bar — the strip the scrolling launch ticker used to occupy.
//
// It sits above every page in a workspace, not only the token page, because
// the point is to get back to a chart from wherever you are: the watchlist,
// Discover, an order list. Clicking a tab is one hop to that coin; the tab
// you are on is marked, and everything else is one click away.
//
// Deliberately plain: a row of names. A price on each would need a
// subscription per tab and would put a moving number in the chrome of every
// page, which is the thing the ticker was doing wrong.

import { memo, useEffect } from 'react';
import { X } from 'lucide-react';
import { nativeSymbolOf } from '@shared/evm';
import { tabKey, tabLabel, type TokenTab } from '../state/tokenTabs';
import { cls } from '../utils/format';

interface Props {
  tabs: TokenTab[];
  /** Key of the tab currently on screen, or null when the token page is not
   *  the route — the bar still shows, so a tab is one click from anywhere. */
  activeKey: string | null;
  onSelect: (t: TokenTab) => void;
  onClose: (key: string) => void;
  onCloseAll: () => void;
}

export const TokenTabs = memo(function TokenTabs({ tabs, activeKey, onSelect, onClose, onCloseAll }: Props) {
  // Ctrl+Tab / Ctrl+Shift+Tab cycle, Alt+1..9 jump. Deliberately NOT Ctrl+W:
  // that closes the Electron window, and a trader reaching for it to shut a
  // chart would lose the app. Registered without capture so the trading
  // hotkeys (which use capture) always win a contested key.
  useEffect(() => {
    if (tabs.length === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (typing) return;
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const i = tabs.findIndex((t) => tabKey(t) === activeKey);
        const from = i < 0 ? 0 : i;
        const next = (from + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        onSelect(tabs[next]);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const t = tabs[Number(e.key) - 1];
        if (!t) return;
        e.preventDefault();
        onSelect(t);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeKey, onSelect]);

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-stretch border-b border-white/10 bg-black/40 select-none">
      <div className="flex-1 flex items-stretch overflow-x-auto scrollbar-thin">
        {tabs.map((t, i) => {
          const key = tabKey(t);
          const active = key === activeKey;
          return (
            <div
              key={key}
              className={cls(
                'group relative flex items-center gap-2 border-r border-white/10 pl-3 pr-1.5 py-1.5 transition flex-shrink-0',
                active ? 'bg-krypt-purple/20' : 'hover:bg-white/[0.04]',
              )}
            >
              <button
                onClick={() => onSelect(t)}
                // Middle-click closes, the way it does everywhere else.
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(key);
                  }
                }}
                title={`${t.mint}${t.chain === 'solana' ? '' : ` · ${nativeSymbolOf(t.chain)}`}${i < 9 ? ` · Alt+${i + 1}` : ''}`}
                className="flex items-center gap-1.5 font-mono text-body"
              >
                <span className={cls('font-semibold truncate max-w-[9rem]', active ? 'text-white' : 'text-krypt-muted')}>{tabLabel(t)}</span>
                {t.chain !== 'solana' && <span className="text-micro text-krypt-muted/50 uppercase">{nativeSymbolOf(t.chain)}</span>}
              </button>
              <button
                onClick={() => onClose(key)}
                title="Close"
                aria-label={`Close ${tabLabel(t)}`}
                className={cls(
                  'rounded p-0.5 text-krypt-muted/50 hover:text-white hover:bg-white/10 transition',
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <X className="h-3 w-3" />
              </button>
              {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-krypt-purple" />}
            </div>
          );
        })}
      </div>
      {tabs.length > 1 && (
        <button
          onClick={onCloseAll}
          className="flex items-center px-3 text-label text-krypt-muted/60 hover:text-white border-l border-white/10 transition flex-shrink-0"
          title="Close every open token"
        >
          Close all
        </button>
      )}
    </div>
  );
});
