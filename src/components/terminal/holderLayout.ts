// Bubble-map geometry for the holder graph (term.txt §7).
//
// Extracted from the component so it can be tested without a DOM: the
// packing is the part that can silently be wrong — overlapping bubbles
// misrepresent concentration, and a radius-proportional mapping exaggerates
// large holders — and neither failure is obvious by eye.
//
// The layout is DETERMINISTIC by design. A force simulation jitters on every
// re-render, never settles the same way twice, and makes it impossible to
// say "the big red bubble on the left" to someone looking at the same token.
// Circle packing gives the same picture every time.

export interface LayoutNode {
  id: string;
  /** 0..100; null = unknown share, packed as dust and labelled as unknown. */
  pct: number | null;
}

export interface PlacedCircle<T extends LayoutNode> {
  node: T;
  x: number;
  y: number;
  r: number;
}

export const MAP_W = 720;
export const MAP_H = 420;

const MIN_R = 7;
const MAX_R = 72;
/** Gap between bubbles so borders never touch. */
const PADDING = 3;
const EDGE = 4;

/**
 * Radius for a holding percentage.
 *
 * AREA is proportional to the percentage, so radius goes as sqrt — a 4%
 * holder is twice the radius of a 1% holder, not four times. Using radius
 * directly is the classic bubble-chart lie and would make concentration look
 * far worse than it is.
 */
export function radiusFor(pct: number, maxPct: number): number {
  const scaled = Math.sqrt(Math.max(pct, 0.01) / Math.max(maxPct, 0.01));
  return Math.max(MIN_R, Math.min(MAX_R, scaled * 66));
}

/**
 * Pack circles: largest at the centre, each subsequent one placed at the
 * first position along an outward spiral that collides with nothing.
 *
 * O(n²) in collisions, which is irrelevant at the few dozen nodes this ever
 * renders. A node that cannot be placed inside the viewport is DROPPED
 * rather than overlapped — an overlapping map misstates the distribution,
 * and the caller can compare `placed.length` against the input to say so.
 */
export function packCircles<T extends LayoutNode>(nodes: T[]): PlacedCircle<T>[] {
  if (!nodes.length) return [];
  const sorted = [...nodes].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || a.id.localeCompare(b.id));
  const maxPct = (sorted[0].pct ?? 0) || 1;

  const placed: PlacedCircle<T>[] = [];
  const fits = (x: number, y: number, r: number): boolean => {
    if (x - r < EDGE || x + r > MAP_W - EDGE) return false;
    if (y - r < EDGE || y + r > MAP_H - EDGE) return false;
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.y - y) < p.r + r + PADDING) return false;
    }
    return true;
  };

  for (const node of sorted) {
    const r = radiusFor(node.pct ?? 0, maxPct);
    if (!placed.length) {
      if (fits(MAP_W / 2, MAP_H / 2, r)) placed.push({ node, x: MAP_W / 2, y: MAP_H / 2, r });
      continue;
    }
    for (let step = 0; step < 6000; step++) {
      const angle = step * 0.35;
      const dist = 6 + step * 0.55;
      const x = MAP_W / 2 + Math.cos(angle) * dist;
      // Flattened vertically so the packing fills a 16:9-ish viewport rather
      // than a circle with empty corners.
      const y = MAP_H / 2 + Math.sin(angle) * dist * 0.62;
      if (fits(x, y, r)) {
        placed.push({ node, x, y, r });
        break;
      }
    }
  }
  return placed;
}
