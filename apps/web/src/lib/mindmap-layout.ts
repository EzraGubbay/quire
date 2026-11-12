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
 * Max node box width (px); the view caps nodes at this and lets them shrink to their label. Also the fallback
 * width for edge geometry before a node has been measured.
 */
const NODE_W = 176;
/**
 * Nominal footprint used for collision checks between auto-laid nodes and the rest of the map. Width is the
 * node cap plus the collapse caret that hangs off its left edge; height is one tidy row, so tidy siblings
 * (exactly ROW apart) are never mistaken for an overlap, and adjacent depth columns (COL apart) never clash.
 */
const BOX_W = NODE_W + 24;
const BOX_H = ROW;

type Pt = { x: number; y: number };

/**
 * Arranges the forest left-to-right. Two kinds of node:
 *
 * - **Pinned** nodes carry a stored `x`/`y` from a user drag. They stay exactly there and act as obstacles.
 * - **Auto** nodes (no stored position, including every freshly created node) take the slot a tidy tree
 *   (d3-hierarchy, Reingold–Tilford) gives them — but *relative to their parent's actual position*, not the
 *   tidy tree's idea of where the parent is. So a new child of a dragged parent appears one column to its
 *   right, among its siblings, and an un-dragged subtree rides along when its parent is dragged.
 *
 * If that slot is already occupied (by a pinned node, or by another branch), the auto node — and with it its
 * own auto-laid subtree — is nudged down its column until it is clear. Pinned nodes are never moved.
 *
 * Multiple roots are hung off one virtual root so a single `tree()` pass spaces them. Descendants of a collapsed
 * node are omitted.
 */
export function layoutMindMap(nodes: LayoutNode[]): LayoutResult {
  const positions = new Map<string, Pt>();
  const hiddenChildren = new Map<string, number>();
  const visible = new Set<string>();
  if (nodes.length === 0) return { positions, visible, hiddenChildren, width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenBy = new Map<string | null, LayoutNode[]>();
  // Each node's effective parent: a dangling parent reference makes it a root so no node is ever dropped.
  const parentKey = new Map<string, string | null>();
  for (const n of nodes) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    parentKey.set(n.id, key);
    const arr = childrenBy.get(key) ?? [];
    arr.push(n);
    childrenBy.set(key, arr);
  }
  for (const arr of childrenBy.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);

  // Build the visible sub-forest, stopping descent at a collapsed node (but keeping the collapsed node itself).
  // `order` records the pre-order walk: a parent always precedes its children, siblings in sort order.
  const order: string[] = [];
  const build = (key: string | null): TreeDatum[] =>
    (childrenBy.get(key) ?? []).map((n) => {
      visible.add(n.id);
      order.push(n.id);
      const kids = childrenBy.get(n.id) ?? [];
      if (n.collapsed && kids.length) {
        hiddenChildren.set(n.id, countSubtree(n.id, childrenBy));
        return { id: n.id, children: [] };
      }
      return { id: n.id, children: build(n.id) };
    });

  const root: TreeDatum = { id: null, children: build(null) };
  const laid = tree<TreeDatum>().nodeSize([ROW, COL])(hierarchy<TreeDatum>(root, (d) => d.children));

  // The pure tidy-tree slot of every visible node.
  const tidy = new Map<string, Pt>();
  let minRow = Number.POSITIVE_INFINITY;
  laid.each((d) => {
    if (d.data.id === null) return;
    // d3 lays the tree top-down (d.x = breadth, d.y = depth); swap for a left-to-right map.
    minRow = Math.min(minRow, d.x);
    tidy.set(d.data.id, { x: PAD + (d.depth - 1) * COL, y: d.x });
  });
  // Shift every computed row so the topmost sits at the padding.
  const shift = Number.isFinite(minRow) ? PAD - minRow : 0;
  for (const [id, p] of tidy) tidy.set(id, { x: p.x, y: p.y + shift });

  // Pinned nodes first: they sit exactly where the user left them and everything else must steer around them.
  const obstacles: Pt[] = [];
  for (const id of order) {
    const n = byId.get(id);
    if (n && n.x !== null && n.y !== null) {
      const p = { x: n.x, y: n.y };
      positions.set(id, p);
      obstacles.push(p);
    }
  }

  // Auto nodes in pre-order, so a parent's final position is known before its children are anchored to it.
  for (const id of order) {
    if (positions.has(id)) continue;
    const slot = tidy.get(id);
    if (!slot) continue;
    const pk = parentKey.get(id) ?? null;
    const parentFinal = pk ? positions.get(pk) : undefined;
    const parentTidy = pk ? tidy.get(pk) : undefined;
    const p: Pt =
      parentFinal && parentTidy
        ? { x: slot.x + (parentFinal.x - parentTidy.x), y: slot.y + (parentFinal.y - parentTidy.y) }
        : { ...slot };
    nudgeClear(p, obstacles);
    positions.set(id, p);
    obstacles.push(p);
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

/**
 * Slide `p` down its column (in place) until its nominal box clears every obstacle. Each pass drops it just
 * below the lowest box it still touches, so it terminates after at most one pass per obstacle.
 */
function nudgeClear(p: Pt, obstacles: Pt[]): void {
  for (let guard = 0; guard <= obstacles.length; guard++) {
    let floor = Number.NEGATIVE_INFINITY;
    for (const o of obstacles) {
      if (Math.abs(o.x - p.x) < BOX_W && Math.abs(o.y - p.y) < BOX_H) floor = Math.max(floor, o.y);
    }
    if (floor === Number.NEGATIVE_INFINITY) return;
    p.y = floor + BOX_H;
  }
}

export const MINDMAP_LAYOUT = { ROW, COL, PAD, NODE_W, BOX_W, BOX_H };
