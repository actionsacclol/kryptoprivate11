// A draggable, resizable panel grid.
//
// Panels already existed in this app as components (TradePanel, HoldersPanel,
// OrdersPanel and fifteen others); what was missing was somewhere to put
// several of them at once and let the user arrange it. That is all this is:
// a container. It knows nothing about what a panel contains.
//
// Layout is remembered per grid id in localStorage. That is deliberate:
// arrangement is a per-machine convenience, not state the app has to be
// correct about, so it must never be able to break a page. Every read and
// write is wrapped — a browser with site data blocked, or a stale layout from
// an older build, falls back to the default arrangement rather than throwing.
//
// ─── Why the layout is derived during render ─────────────────────────────
//
// It used to live in state, refreshed by an effect when the panel set changed.
// That has a window in it, and the window was the bug: switching a panel ON
// rendered the new child BEFORE the effect ran, so react-grid-layout found no
// entry for it, assigned its fallback 1x1, and fired onLayoutChange — which we
// persisted. The effect then reloaded the 1x1 it had just saved. Every panel
// you switched on arrived as a tiny box and stayed one.
//
// So the rendered layout is now computed from `panels` on every render, and the
// only thing held in state is what the USER has moved. There is no frame in
// which a panel exists without a layout.
//
// Drag is bound to `.panel-head`, so anything inside a panel body stays
// clickable and text stays selectable.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import { ExternalLink, RotateCcw, X } from 'lucide-react';
import { clearBoxes, deriveLayout, loadBoxes, mergeBoxes, saveBoxes, type Box } from '../panels/layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const Grid = WidthProvider(GridLayout);

export const GRID_COLS = 12;
const MARGIN = 10;
const ROW_HEIGHT = 34;
/** Height of the drag header, in px. Body height is calc'd against it. */
const HEAD_PX = 33;

export interface PanelDef {
  /** Stable across renders AND across builds — it keys the saved layout. */
  key: string;
  title: string;
  /** Right of the title, e.g. a count or a small control. */
  badge?: ReactNode;
  /** One control, centred in the header. A chain picker for panels whose rows
   *  belong to a chain, a token picker for the chart — the grid does not care
   *  which, it just gives it the middle. */
  headerControl?: ReactNode;
  body: ReactNode;
  /** Grid placement. `w`/`h` are columns and rows, not pixels. */
  layout: Omit<Layout, 'i'>;
}

export function PanelGrid({
  id,
  panels,
  className = '',
  onRemove,
  onPopOut,
}: {
  /** Namespaces the saved arrangement. One per workspace surface. */
  id: string;
  panels: PanelDef[];
  className?: string;
  /** When given, each panel gets a close button that calls this with its key. */
  onRemove?: (key: string) => void;
  /** When given, each panel gets a pop-out button that calls this with its key. */
  onPopOut?: (key: string) => void;
}) {
  // Only what the user moved. Keyed by grid id so switching surfaces reloads.
  const [boxes, setBoxes] = useState<Record<string, Box>>(() => loadBoxes(id));
  const [loadedFor, setLoadedFor] = useState(id);
  if (loadedFor !== id) {
    // Render-phase reset: cheaper and more correct than an effect, because it
    // happens BEFORE the children of the new grid are laid out.
    setLoadedFor(id);
    setBoxes(loadBoxes(id));
  }

  const dirty = useMemo(() => panels.some((p) => boxes[p.key] !== undefined), [panels, boxes]);

  // The layout handed to the grid. Every rendered panel has an entry, always:
  // its saved box if it has one, otherwise the default the caller declared.
  const layout = useMemo<Layout[]>(() => deriveLayout(panels, boxes) as Layout[], [panels, boxes]);

  const onChange = useCallback(
    (next: Layout[]) => {
      setBoxes((cur) => {
        const merged = mergeBoxes(cur, next);
        saveBoxes(id, merged);
        return merged;
      });
    },
    [id],
  );

  const reset = useCallback(() => {
    clearBoxes(id);
    setBoxes({});
  }, [id]);

  return (
    <div className={className}>
      {/* A fixed strip, always present. The reset button used to hang above
          the grid on a negative offset, which clipped against whatever sat
          above it and made every caller pass its own top margin. Reserving
          the row costs 24px and means the grid never jumps when the button
          appears. */}
      <div className="flex h-6 items-center justify-end">
        {dirty && (
          <button
            onClick={reset}
            className="flex items-center gap-1 rounded border border-white/10 bg-krypt-panel px-2 py-1 text-label text-krypt-muted transition hover:text-white"
            title="Put the panels back where they started"
          >
            <RotateCcw className="h-3 w-3" /> Reset layout
          </button>
        )}
      </div>
      <Grid
        className="layout"
        layout={layout}
        cols={GRID_COLS}
        rowHeight={ROW_HEIGHT}
        margin={[MARGIN, MARGIN]}
        containerPadding={[0, 0]}
        draggableHandle=".panel-head"
        // Buttons live INSIDE the drag handle, and react-draggable decides
        // from e.target: anything matching the handle starts a drag and gets
        // preventDefault(), which kills the click that would have followed. So
        // `onPointerDown` + stopPropagation was never enough — it stops React's
        // synthetic bubble, not the native default. `draggableCancel` is the
        // supported way to say "this bit of the handle is not a grab".
        draggableCancel=".panel-action"
        // Only the bottom-right corner. More handles on a dark, dense UI is
        // more ways to grab the wrong thing.
        resizeHandles={['se']}
        onLayoutChange={onChange}
        // Panels rise to fill space above them, which is what makes switching
        // one off tidy itself up rather than leave a hole.
        compactType="vertical"
        isBounded
        isDraggable
        isResizable
      >
        {panels.map((p) => (
          // Translucent so the app's own animated backdrop shows THROUGH the
          // panel rather than each panel running a field of its own — one
          // WebGL context for the window instead of one per widget, which a
          // browser would refuse at about sixteen anyway. The blur keeps text
          // crisp over a moving ground; lite mode strips it (index.css).
          <div key={p.key} className="group/panel flex flex-col overflow-hidden rounded-xl border border-white/10 bg-krypt-panel/70 backdrop-blur-md shadow-krypt-card">
            <div
              className="panel-head flex shrink-0 cursor-move items-center justify-between border-b border-white/10 px-3 select-none"
              style={{ height: HEAD_PX }}
            >
              <span className="truncate text-body font-semibold tracking-wide text-white/90">{p.title}</span>
              {/* Centred, between the title and the icons — the one control a
                  chain-aware panel needs often enough to be worth the room. */}
              {p.headerControl && <span className="mx-2 flex min-w-0 flex-1 justify-center">{p.headerControl}</span>}
              <span className="flex shrink-0 items-center gap-2">
                {p.badge}
                {onPopOut && (
                  <button
                    // Same rule as the close button: the header is the drag
                    // handle, so a click here must not also start a drag.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onPopOut(p.key)}
                    className="panel-action text-krypt-muted opacity-0 transition hover:text-white group-hover/panel:opacity-100"
                    title={`Pop ${p.title} out into its own window`}
                    aria-label={`Pop ${p.title} out`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
                {onRemove && (
                  <button
                    // The header is the drag handle, so a click inside it must
                    // not also start a drag.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onRemove(p.key)}
                    className="panel-action text-krypt-muted opacity-0 transition hover:text-white group-hover/panel:opacity-100"
                    title={`Remove ${p.title}`}
                    aria-label={`Remove ${p.title}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </div>
            {/* min-h-0 is what lets this scroll inside a flex column instead of
                pushing the panel taller than its grid box. */}
            <div className="min-h-0 flex-1 overflow-auto p-3">{p.body}</div>
          </div>
        ))}
      </Grid>
    </div>
  );
}
