import { hierarchy, tree } from 'd3-hierarchy';

/** The fields the layout needs from a mind-map node (a subset of the DB row, so it stays testable). */
export interface LayoutNode {
  id: string;
  parentId: string | null;
  collapsed: boolean;
  /** Stored drag override; null → use the computed position. */
  x: number | null;
  y: number | null;
  sortOrder: number;
}

export interface LayoutResult {
  /** Final position per visible node: the computed auto-layout position, overridden by a stored drag. */
  positions: Map<string, { x: number; y: number }>;
  /** Nodes that should be drawn (everything except descendants of a collapsed node). */
  visible: Set<string>;
  /** How many hidden children each visible node has (so the UI can badge a collapsed node). */
  hiddenChildren: Map<string, number>;
  width: number;
  height: number;
}

interface TreeDatum {
  id: string | null;
  children: TreeDatum[];
}

/** Breadth between sibling rows and depth between generations (px). Left-to-right tree. */
const ROW = 64;
const COL = 220;
const PAD = 60;

/**
 * Auto-arranges the forest left-to-right with d3-hierarchy. Multiple roots are hung off one virtual root so a
 * single `tree()` pass lays them all out without overlap. Descendants of a collapsed node are omitted. A node with
 * a stored `x`/`y` (from a user drag) keeps that position; everything else uses the computed one.
 */
export function layoutMindMap(nodes: LayoutNode[]): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const hiddenChildren = new Map<string, number>();
  const visible = new Set<string>();
  if (nodes.length === 0) return { positions, visible, hiddenChildren, width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenBy = new Map<string | null, LayoutNode[]>();
  for (const n of nodes) {
    // Treat a dangling parent reference as a root so no node is ever dropped.
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const arr = childrenBy.get(key) ?? [];
    arr.push(n);
    childrenBy.set(key, arr);
  }
  for (const arr of childrenBy.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);

  // Build the visible sub-forest, stopping descent at a collapsed node (but keeping the collapsed node itself).
  const build = (parentKey: string | null): TreeDatum[] =>
    (childrenBy.get(parentKey) ?? []).map((n) => {
      visible.add(n.id);
      const kids = childrenBy.get(n.id) ?? [];
      if (n.collapsed && kids.length) {
        hiddenChildren.set(n.id, countSubtree(n.id, childrenBy));
        return { id: n.id, children: [] };
      }
      return { id: n.id, children: build(n.id) };
    });

  const root: TreeDatum = { id: null, children: build(null) };
  const laid = tree<TreeDatum>().nodeSize([ROW, COL])(hierarchy<TreeDatum>(root, (d) => d.children));

  let minRow = Number.POSITIVE_INFINITY;
  laid.each((d) => {
    if (d.data.id === null) return;
    // d3 lays the tree top-down (d.x = breadth, d.y = depth); swap for a left-to-right map.
    minRow = Math.min(minRow, d.x);
    positions.set(d.data.id, { x: PAD + (d.depth - 1) * COL, y: d.x });
  });
  // Shift every computed row so the topmost sits at the padding.
  const shift = Number.isFinite(minRow) ? PAD - minRow : 0;
  for (const [id, p] of positions) positions.set(id, { x: p.x, y: p.y + shift });

  // Apply stored drag overrides last.
  for (const n of nodes) {
    if (visible.has(n.id) && n.x !== null && n.y !== null) positions.set(n.id, { x: n.x, y: n.y });
  }

  let width = 0;
  let height = 0;
  for (const p of positions.values()) {
    width = Math.max(width, p.x);
    height = Math.max(height, p.y);
  }
  return {
    positions,
    visible,
    hiddenChildren,
    width: width + PAD + COL,
    height: height + PAD + ROW,
  };
}

function countSubtree(id: string, childrenBy: Map<string | null, LayoutNode[]>): number {
  let total = 0;
  for (const c of childrenBy.get(id) ?? []) total += 1 + countSubtree(c.id, childrenBy);
  return total;
}

export const MINDMAP_LAYOUT = { ROW, COL, PAD };
