// One panel, alone, in its own frameless window.
//
// A popped-out panel is the SAME component the Widgets grid renders — the
// registry is the single source, so a panel never behaves differently
// depending on which window it is in. What changes is the chrome around it:
// there is none.
//
// FRAMELESS MEANS THIS WINDOW OWNS TWO THINGS THE OS USUALLY DOES.
//
//  1. Moving it. With no title bar there is nothing to grab, so the whole
//     surface is an app-region drag handle and every interactive thing inside
//     it has to opt back OUT (`.no-drag`), or a click on a row would move the
//     window instead of opening a coin.
//  2. Closing it. There is no X in a frame either. The close control is
//     revealed on hover so the resting state stays clean, which is the point
//     of popping a panel out — but it is always in the same corner, and the
//     window also answers Escape, because a control you have to find by
//     hovering is not a control you can rely on.
//
// It talks to main over the same preload bridge as any window: `ipc.ts`
// broadcasts engine events to EVERY window rather than a remembered one, so
// this gets the same live data with no extra plumbing.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { PANELS, PanelActionsContext } from './registry';
import { AppBackdrop, BACKDROP_QUIET } from '../components/viz/LiquidMetal';
import { ChainFilter, PanelChainContext, useChainFilter } from './chainFilter';
// Re-exported so existing importers (src/main.tsx) keep one place to ask.
export { isPanelWindow, panelIdFromHash } from './windowId';

export function PanelWindow({ panelId }: { panelId: string }) {
  const spec = PANELS.find((p) => p.id === panelId) ?? null;
  const [hover, setHover] = useState(false);
  // The same per-panel filter the grid uses, read from the same storage — so a
  // panel popped out while showing BNB opens showing BNB.
  const [chain, setChain] = useChainFilter(panelId);

  // Escape closes, so the window is never trapped when a pointer cannot find
  // the hover target — a touchpad user, or a panel dragged mostly offscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.krypt.panels?.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!spec) {
    return (
      <div className="flex h-screen items-center justify-center bg-krypt-panel p-6 text-center text-body text-krypt-muted">
        <div>
          <div className="mb-1 text-white/80">That panel is not in this build</div>
          <div className="text-micro">“{panelId}” — it may have been renamed or removed since this window was opened.</div>
        </div>
      </div>
    );
  }

  const Body = spec.Body;
  return (
    // `app-drag` on the shell, `no-drag` on everything you can actually use.
    <div
      className="app-drag relative flex h-screen flex-col overflow-hidden bg-krypt-void"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* This window does not render App, so it has no backdrop of its own.
          One field per popped-out window, at the same quiet intensity every
          page but the Hub uses — a ninth of the pixels and 15 fps. It mounts
          only when reduceEffects is known to be false, like the app's. */}
      <AppBackdrop intensity={BACKDROP_QUIET} />
      {/* No title bar. A thin strip carries the name only while the pointer is
          over the window, so the resting state is the panel and nothing else. */}
      <div
        className={`relative z-10 flex shrink-0 items-center justify-between px-3 transition-opacity duration-150 ${hover ? 'opacity-100' : 'opacity-0'}`}
        style={{ height: 26 }}
      >
        <span className="truncate text-micro font-semibold uppercase tracking-label text-krypt-muted">{spec.title}</span>
        {/* This span is deliberately NOT `no-drag`: it is the middle of the
            title strip and one of the few places left to grab a window that
            has no title bar. The select inside it opts out on its own. */}
        {(spec.chainAware || spec.HeaderControl) && (
          <span className="mx-2 flex min-w-0 flex-1 justify-center">
            {spec.chainAware ? <ChainFilter value={chain} onChange={setChain} /> : spec.HeaderControl ? <spec.HeaderControl /> : null}
          </span>
        )}
        <button
          type="button"
          className="no-drag rounded p-0.5 text-krypt-muted transition hover:bg-white/10 hover:text-white"
          onClick={() => void window.krypt.panels?.close()}
          title="Close (Esc)"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* `relative z-10`: the backdrop above is `fixed` with no z-index, and a
          positioned element paints over static siblings — without this the
          field would sit on top of the panel instead of behind it. */}
      <div className="no-drag relative z-10 min-h-0 flex-1 overflow-auto px-3 pb-3">
        {/* Opening a coin from a popped-out panel raises the MAIN window and
            navigates it. This window keeps showing its panel — that is the
            arrangement someone popped it out for. */}
        <PanelActionsContext.Provider value={{ openToken: (mint, c) => void window.krypt.panels?.openToken(mint, c) }}>
          <PanelChainContext.Provider value={chain}>
            <Body />
          </PanelChainContext.Provider>
        </PanelActionsContext.Provider>
      </div>
    </div>
  );
}
