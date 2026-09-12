// Where the panels sit, and the rules for keeping that sane.
//
// Split out of PanelGrid so the arithmetic can be tested without a renderer.
// The component keeps the React; this keeps the decisions.
//
// One rule matters more than the rest and is the reason this file exists:
// EVERY RENDERED PANEL MUST HAVE A LAYOUT ENTRY, in the same pass that renders
// it. react-grid-layout falls back to a 1x1 box for a child it has no entry
// for, and then reports that box as the user's arrangement — so a single frame
// without an entry is enough to persist a tiny panel permanently.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a caller declares for a panel: a Box plus optional minimums. */
export interface PanelLayout extends Box {
  minW?: number;
  minH?: number;
}

/** `.v2` — see PanelGrid: v1 stores can contain 1x1 boxes the old bug wrote. */
export function storageKey(gridId: string): string {
  return `krypt.panels.${gridId}.v2`;
}

/** A box only counts if every field is a real number and it has area. */
export function isBox(v: unknown): v is Box {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  for (const k of ['x', 'y', 'w', 'h']) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k] as number)) return false;
  }
  return (b.w as number) >= 1 && (b.h as number) >= 1;
}

export function loadBoxes(gridId: string): Record<string, Box> {
  try {
    const raw = window.localStorage.getItem(storageKey(gridId));
    if (!raw) return {};
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return {};
    const out: Record<string, Box> = {};
    for (const e of saved) {
      if (!e || typeof e !== 'object') continue;
      const { i } = e as { i?: unknown };
      if (typeof i !== 'string' || !isBox(e)) continue;
      const { x, y, w, h } = e as unknown as Box;
      out[i] = { x, y, w, h };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveBoxes(gridId: string, boxes: Record<string, Box>): void {
  try {
    window.localStorage.setItem(storageKey(gridId), JSON.stringify(Object.entries(boxes).map(([i, b]) => ({ i, ...b }))));
  } catch {
    /* arrangement is a convenience; losing it must never break the page */
  }
}

export function clearBoxes(gridId: string): void {
  try {
    window.localStorage.removeItem(storageKey(gridId));
  } catch {
    /* nothing saved is the same as reset */
  }
}

/**
 * The layout handed to the grid: one entry per panel, always.
 *
 * A saved box wins over the declared default, but the minimums come from the
 * declaration either way — a build that raises a panel's minimum must not be
 * overridden by an arrangement saved before it.
 */
export function deriveLayout<T extends { key: string; layout: PanelLayout }>(panels: readonly T[], boxes: Record<string, Box>): Array<PanelLayout & { i: string }> {
  return panels.map((p) => {
    const saved = boxes[p.key];
    const base = { ...p.layout, i: p.key };
    if (!saved) return base;
    return {
      ...base,
      ...saved,
      w: Math.max(saved.w, p.layout.minW ?? 1),
      h: Math.max(saved.h, p.layout.minH ?? 1),
    };
  });
}

/**
 * Fold a grid change into what we already had.
 *
 * MERGE, never replace: the grid only ever reports the panels currently on
 * screen, so replacing would forget the size of every panel the user has
 * switched off — and switching one back on would reset it instead of
 * restoring it. Degenerate boxes are dropped rather than stored.
 */
export function mergeBoxes(current: Record<string, Box>, next: ReadonlyArray<{ i: string } & Partial<Box>>): Record<string, Box> {
  const out = { ...current };
  for (const e of next) {
    if (typeof e?.i !== 'string' || !isBox(e)) continue;
    out[e.i] = { x: e.x as number, y: e.y as number, w: e.w as number, h: e.h as number };
  }
  return out;
}
