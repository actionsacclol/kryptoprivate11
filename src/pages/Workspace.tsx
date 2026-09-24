// Widgets — the one page the user arranges themselves.
//
// Everywhere else in this app decides what you see. Here you pick the panels
// and drag them where you want them, and the arrangement is remembered.
//
// Three pieces of state, all per-machine conveniences:
//   · which panels are ON — kept here, in localStorage;
//   · where they sit and how big they are — kept by PanelGrid, same way;
//   · which PAGES are pinned to the left menu — panels/pinned.ts, because the
//     sidebar that renders them lives in App, far from this picker.
//
// None of it is state the app has to be correct about, so every read and write is
// wrapped: a browser with site data blocked, or a layout saved by an older
// build, falls back to the defaults rather than throwing. Losing an
// arrangement is a small annoyance; a page that will not render is not.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid, PanelLeft, X } from 'lucide-react';
import { PanelGrid } from '../components/PanelGrid';
import { PANELS, DEFAULT_ENABLED, PanelActionsContext } from '../panels/registry';
import { ChainFilter, PanelChainContext, loadChainFilter, storeChainFilter, type ChainFilterValue } from '../panels/chainFilter';
import { useToast } from '../state/ToastProvider';
import type { ChainKind } from '@shared/evm';
import { ROUTES, type RouteId } from '../components/Sidebar';
import { WORKSPACES, workspaceOf } from '../workspaces';
import { isPinnable, loadPinned, savePinned } from '../panels/pinned';

const STORE_KEY = 'krypt.panels.enabled.v1';
/**
 * Every panel id this install has been SHOWN (asked 2026-09-22: "all panels
 * toggled on when run first time"). A panel not in here is new to this user —
 * a fresh install, or a panel added in an update — so it starts ON, once.
 * One they then switch off stays off, because by then it is in here.
 *
 * Until this key existed a saved layout froze the set: someone who arranged
 * their grid before Runners, Callouts, Links or Games existed never saw them.
 * An install with a saved set but no seen-list is treated as having seen
 * nothing, so everything comes on one time and the list starts from there.
 */
const SEEN_KEY = 'krypt.panels.seen.v1';

function loadEnabled(): string[] {
  const known = PANELS.map((p) => p.id);
  let seen: Set<string> = new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) seen = new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    /* unreadable = nothing seen */
  }
  const unseen = known.filter((id) => !seen.has(id));
  // Every branch lands in `enabled` — none returns early — so a fresh
  // install records what it was shown too, and a panel switched off in the
  // first session is not switched back on at the second start.
  let enabled: string[] = DEFAULT_ENABLED;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(saved)) {
      // Keep only ids that still exist. A panel removed in a later build must
      // not leave a hole, and an unknown id must not reach the grid.
      const knownSet = new Set(known);
      const kept = saved.filter((x): x is string => typeof x === 'string' && knownSet.has(x));
      // An empty saved set is a real choice ("show me nothing"), so it is
      // kept — but a set that became empty only because every id went stale
      // is not.
      enabled = kept.length || saved.length === 0 ? kept : DEFAULT_ENABLED;
    }
  } catch {
    enabled = DEFAULT_ENABLED;
  }
  if (!unseen.length) return enabled;
  // Panels this user has never been shown come on, once. The merged set and
  // the seen-list are written TOGETHER, so calling this twice (React's dev
  // double-invoke, a popped-out window) returns the same answer both times.
  const merged = [...enabled, ...unseen.filter((id) => !enabled.includes(id))];
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(merged));
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(known));
  } catch {
    /* private window — every start is a first start, which is harmless */
  }
  return merged;
}

/** Pages that can be pinned, grouped by the workspace they belong to. */
function pinnableByWorkspace(): Array<{ title: string; routes: Array<{ id: RouteId; label: string; hint?: string }> }> {
  const byId = new Map(ROUTES.map((r) => [r.id, r]));
  return WORKSPACES.filter((w) => w.id !== 'layout')
    .map((w) => ({
      title: w.title,
      // `routes`, not routesFor(): a page borrowed by a workspace still belongs
      // to its home, and listing it twice in the picker would be confusing.
      routes: w.routes
        .filter((id) => isPinnable(id) && workspaceOf(id) === w.id)
        .map((id) => byId.get(id))
        .filter((r): r is (typeof ROUTES)[number] => !!r && !r.hidden)
        .map((r) => ({ id: r.id, label: r.label, hint: r.hint })),
    }))
    .filter((g) => g.routes.length > 0);
}

/**
 * Shared shell for the two pickers, so they cannot drift apart.
 *
 * Rendered through a PORTAL, anchored to its button. As a normal absolutely
 * positioned child it was clipped by the page's own `overflow-auto` scroll
 * container — the list simply ran out of visible area. A portal escapes every
 * clipping ancestor, and the position is then clamped to the viewport so a
 * long list scrolls inside itself rather than disappearing off an edge.
 */
function Picker({
  anchor,
  title,
  onClose,
  panelRef,
  children,
}: {
  anchor: HTMLElement | null;
  title: string;
  onClose: () => void;
  panelRef: React.MutableRefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);

  // Measured before paint, so the panel never shows in the wrong place first.
  useLayoutEffect(() => {
    if (!anchor) return undefined;
    const GAP = 8;
    const EDGE = 16;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({
        top: r.bottom + GAP,
        right: Math.max(EDGE, window.innerWidth - r.right),
        maxHeight: Math.max(160, window.innerHeight - r.bottom - GAP - EDGE),
      });
    };
    place();
    // `true` so an ancestor scrolling (not just the window) re-places it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', top: pos.top, right: pos.right, maxHeight: pos.maxHeight }}
      className="z-50 flex w-80 flex-col overflow-hidden rounded-xl border border-white/10 bg-krypt-panel shadow-krypt-card"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-label uppercase tracking-label text-krypt-muted/70">{title}</span>
        <button onClick={onClose} className="text-krypt-muted transition hover:text-white" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>
    </div>,
    document.body,
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-micro ${
        on ? 'border-krypt-purple bg-krypt-purple/20 text-krypt-purple' : 'border-white/15 text-transparent'
      }`}
      aria-hidden
    >
      ✓
    </span>
  );
}

export function Workspace({ openToken }: { openToken?: (mint: string, chain?: ChainKind) => void } = {}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<string[]>(loadEnabled);
  const [pinned, setPinned] = useState<RouteId[]>(loadPinned);
  const [open, setOpen] = useState<'panels' | 'pages' | null>(null);
  // Both the button row and the portalled panel, because a click inside a
  // portal is NOT inside this component's DOM subtree — checking only the row
  // would close the picker the moment you clicked an item in it.
  const barRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pagesBtn = useRef<HTMLButtonElement>(null);
  const panelsBtn = useRef<HTMLButtonElement>(null);
  const groups = useMemo(pinnableByWorkspace, []);
  const pinnableCount = useMemo(() => groups.reduce((a, g) => a + g.routes.length, 0), [groups]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(enabled));
    } catch {
      /* the choice is a convenience; losing it must never break the page */
    }
  }, [enabled]);

  // Click-away closes the picker. Pointerdown rather than click so it closes
  // on the press that starts a drag on the grid behind it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (barRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = useCallback((id: string) => {
    setEnabled((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  // Pins go through the shared store, not local state alone: the sidebar is
  // rendered by App and listens for the change, so the menu updates while the
  // picker is still open.
  const togglePin = useCallback((id: RouteId) => {
    setPinned((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      savePinned(next);
      return next;
    });
  }, []);

  // Panels render in registry order, not the order they were switched on, so
  // the default arrangement is stable no matter how someone got there.
  // One filter per chain-aware panel, read from and written to localStorage.
  // Held here rather than inside each Body so the header control and the rows
  // it filters are the same piece of state.
  const [chainFilters, setChainFilters] = useState<Record<string, ChainFilterValue>>(() => {
    const out: Record<string, ChainFilterValue> = {};
    for (const p of PANELS) if (p.chainAware) out[p.id] = loadChainFilter(p.id);
    return out;
  });
  const setChainFilter = useCallback((id: string, v: ChainFilterValue) => {
    setChainFilters((cur) => ({ ...cur, [id]: v }));
    storeChainFilter(id, v);
  }, []);

  const panels = useMemo(
    () =>
      PANELS.filter((p) => enabled.includes(p.id)).map((p) => {
        const value = chainFilters[p.id] ?? 'all';
        return {
          key: p.id,
          title: p.title,
          // The Body reads its chain from context, so a panel can be dropped
          // anywhere — grid or popped-out window — without being handed props.
          body: p.chainAware ? (
            <PanelChainContext.Provider value={value}>
              <p.Body />
            </PanelChainContext.Provider>
          ) : (
            <p.Body />
          ),
          headerControl: p.chainAware ? (
            <ChainFilter value={value} onChange={(v) => setChainFilter(p.id, v)} />
          ) : p.HeaderControl ? (
            <p.HeaderControl />
          ) : undefined,
          layout: p.layout,
        };
      }),
    [enabled, chainFilters, setChainFilter],
  );

  // Panels navigate through this rather than props: `<p.Body />` takes none,
  // and threading one callback through every panel to serve one of them would
  // be worse than a context that is empty for the rest.
  const actions = useMemo(() => ({ openToken }), [openToken]);

  return (
    <PanelActionsContext.Provider value={actions}>
    <div className="px-6 py-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Widgets</h1>
          <p className="text-note text-krypt-muted">Pick your panels and drag them where you want. Saved on this machine.</p>
        </div>

        <div className="flex items-center gap-2" ref={barRef}>
          <button
            ref={pagesBtn}
            onClick={() => setOpen((v) => (v === 'pages' ? null : 'pages'))}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-krypt-panel px-3 py-1.5 text-note text-white/90 transition hover:border-krypt-purple/50"
          >
            <PanelLeft className="h-3.5 w-3.5" />
            Pages
            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 text-label text-krypt-muted">
              {pinned.length}/{pinnableCount}
            </span>
          </button>

          <button
            ref={panelsBtn}
            onClick={() => setOpen((v) => (v === 'panels' ? null : 'panels'))}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-krypt-panel px-3 py-1.5 text-note text-white/90 transition hover:border-krypt-purple/50"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Panels
            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 text-label text-krypt-muted">
              {enabled.length}/{PANELS.length}
            </span>
          </button>

          {open === 'panels' && (
            <Picker anchor={panelsBtn.current} panelRef={panelRef} title="Panels on this page" onClose={() => setOpen(null)}>
              {PANELS.map((p) => {
                const on = enabled.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-white/5"
                  >
                    <Check on={on} />
                    <span className="min-w-0">
                      <span className="block text-note font-medium text-white/90">{p.title}</span>
                      <span className="block text-body leading-snug text-krypt-muted">{p.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </Picker>
          )}

          {open === 'pages' && (
            <Picker anchor={pagesBtn.current} panelRef={panelRef} title="Pages in your sidebar" onClose={() => setOpen(null)}>
              <p className="px-2 pb-1 text-body leading-snug text-krypt-muted">
                Any page from any workspace. Pinned pages appear in the menu on the left while you are on Widgets, and opening one keeps you here.
              </p>
              {groups.map((g) => (
                <div key={g.title} className="mt-1">
                  <div className="px-2 py-1 text-micro uppercase tracking-label text-krypt-muted/60">{g.title}</div>
                  {g.routes.map((r) => {
                    const on = pinned.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        onClick={() => togglePin(r.id)}
                        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5"
                      >
                        <Check on={on} />
                        <span className="min-w-0">
                          <span className="block text-note font-medium text-white/90">{r.label}</span>
                          {r.hint && <span className="block text-body leading-snug text-krypt-muted">{r.hint}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </Picker>
          )}
        </div>
      </div>

      {panels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-krypt-panel/40 py-16 text-center">
          <p className="text-value text-white/80">No panels yet.</p>
          <p className="mt-1 text-note text-krypt-muted">
            Open <span className="text-white/80">Panels</span> above and switch on what you want to see.
          </p>
        </div>
      ) : (
        <PanelGrid
          id="my-layout"
          panels={panels}
          onRemove={toggle}
          // Popping out does NOT remove the panel from the grid: the window is
          // a second view of it, and closing the window leaves the layout as
          // it was. Main refuses an id it has no panel for.
          onPopOut={(key) => {
            // A refusal has to SAY so. Swallowing the result left a failed
            // pop-out indistinguishable from a working one that opened a
            // window somewhere off screen.
            const api = window.krypt.panels;
            if (!api) {
              toast.error('This build cannot pop panels out — restart the app to pick up the new bridge.');
              return;
            }
            void api.popout(key).then(
              (r) => {
                if (!r.ok) toast.error(r.message);
              },
              (err: unknown) => toast.error(`Could not pop that panel out: ${(err as Error)?.message ?? String(err)}`),
            );
          }}
        />
      )}
    </div>
    </PanelActionsContext.Provider>
  );
}
