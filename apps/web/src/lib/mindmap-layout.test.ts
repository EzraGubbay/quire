import { describe, expect, it } from 'vitest';
import { type LayoutNode, layoutMindMap, MINDMAP_LAYOUT } from './mindmap-layout';

let seq = 0;
const node = (id: string, parentId: string | null, patch: Partial<LayoutNode> = {}): LayoutNode => ({
  id,
  parentId,
  collapsed: false,
  x: null,
  y: null,
  sortOrder: seq++,
  ...patch,
});

describe('layoutMindMap', () => {
  it('returns nothing for an empty forest', () => {
    const r = layoutMindMap([]);
    expect(r.visible.size).toBe(0);
    expect(r.positions.size).toBe(0);
    expect(r.width).toBe(0);
  });

  it('places a single root and reports it visible', () => {
    const r = layoutMindMap([node('a', null)]);
    expect(r.visible.has('a')).toBe(true);
    expect(r.positions.get('a')?.x).toBe(MINDMAP_LAYOUT.PAD);
  });

  it('lays a child deeper (further right) than its parent', () => {
    const r = layoutMindMap([node('a', null), node('b', 'a')]);
    const a = r.positions.get('a');
    const b = r.positions.get('b');
    expect(a && b && b.x > a.x).toBe(true);
    expect(b?.x).toBe(MINDMAP_LAYOUT.PAD + MINDMAP_LAYOUT.COL);
  });

  it('separates two siblings onto different rows', () => {
    const r = layoutMindMap([node('a', null), node('b', 'a'), node('c', 'a')]);
    expect(r.positions.get('b')?.y).not.toBe(r.positions.get('c')?.y);
  });

  it('hides the descendants of a collapsed node and counts them', () => {
    const r = layoutMindMap([node('a', null, { collapsed: true }), node('b', 'a'), node('c', 'b')]);
    expect(r.visible.has('a')).toBe(true);
    expect(r.visible.has('b')).toBe(false);
    expect(r.visible.has('c')).toBe(false);
    expect(r.hiddenChildren.get('a')).toBe(2);
  });

  it('honors a stored drag position as an override', () => {
    const r = layoutMindMap([node('a', null, { x: 999, y: 777 })]);
    expect(r.positions.get('a')).toEqual({ x: 999, y: 777 });
  });

  it('treats a dangling parent reference as a root instead of dropping the node', () => {
    const r = layoutMindMap([node('orphan', 'missing-id')]);
    expect(r.visible.has('orphan')).toBe(true);
    expect(r.positions.get('orphan')?.x).toBe(MINDMAP_LAYOUT.PAD);
  });

  it('keeps independent roots (a forest) all visible', () => {
    const r = layoutMindMap([node('r1', null), node('r2', null), node('c', 'r1')]);
    expect(r.visible.has('r1')).toBe(true);
    expect(r.visible.has('r2')).toBe(true);
    expect(r.visible.has('c')).toBe(true);
  });
});

/** True when the nominal boxes of two laid-out nodes intersect. */
function overlaps(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) < MINDMAP_LAYOUT.BOX_W && Math.abs(a.y - b.y) < MINDMAP_LAYOUT.BOX_H;
}

function pos(r: ReturnType<typeof layoutMindMap>, id: string) {
  const p = r.positions.get(id);
  if (!p) throw new Error(`no position for ${id}`);
  return p;
}

describe('layoutMindMap: placing new (auto-positioned) nodes', () => {
  const { ROW, COL } = MINDMAP_LAYOUT;

  it('anchors a fresh child beside its dragged parent, not at the ghost tidy-tree slot', () => {
    // A busy map: root "AI" with three auto-laid branches, each with a couple of children. "Graph Problems"
    // was dragged to the far bottom-left; the user then adds a child to it.
    const forest = [
      node('ai', null),
      node('search', 'ai'),
      node('s1', 'search'),
      node('s2', 'search'),
      node('logic', 'ai'),
      node('l1', 'logic'),
      node('graph', 'ai', { x: 20, y: 900 }),
      node('g1', 'graph'),
      node('g2', 'graph'),
      node('new', 'graph'), // the just-added node: no stored position
    ];
    const r = layoutMindMap(forest);
    const parent = pos(r, 'graph');
    const child = pos(r, 'new');
    // One column to the right of the parent's actual position ...
    expect(child.x).toBe(parent.x + COL);
    // ... and on a row within reach of it (its siblings are stacked ROW apart around the parent).
    expect(Math.abs(child.y - parent.y)).toBeLessThanOrEqual(2 * ROW);
    // Nothing on the map overlaps it.
    for (const id of r.visible) if (id !== 'new') expect(overlaps(child, pos(r, id))).toBe(false);
  });

  it('a child of an un-dragged parent still gets the plain tidy slot', () => {
    const r = layoutMindMap([node('a', null), node('b', 'a'), node('c', 'a')]);
    const a = pos(r, 'a');
    expect(pos(r, 'b').x).toBe(a.x + COL);
    expect(pos(r, 'c').x).toBe(a.x + COL);
    // d3 centres the parent over its children: one above, one below.
    expect(pos(r, 'b').y).toBe(a.y - ROW / 2);
    expect(pos(r, 'c').y).toBe(a.y + ROW / 2);
  });

  it('a dragged parent carries its un-dragged subtree with it', () => {
    const base = layoutMindMap([node('a', null), node('b', 'a'), node('c', 'b')]);
    const moved = layoutMindMap([node('a', null, { x: 500, y: 700 }), node('b', 'a'), node('c', 'b')]);
    const dx = 500 - pos(base, 'a').x;
    const dy = 700 - pos(base, 'a').y;
    expect(pos(moved, 'b')).toEqual({ x: pos(base, 'b').x + dx, y: pos(base, 'b').y + dy });
    expect(pos(moved, 'c')).toEqual({ x: pos(base, 'c').x + dx, y: pos(base, 'c').y + dy });
  });

  it('pushes an auto-laid node below a dragged node that sits on its slot', () => {
    const r0 = layoutMindMap([node('a', null), node('b', 'a')]);
    const slot = pos(r0, 'b');
    // A second root was dragged right onto the slot b would take.
    const r = layoutMindMap([node('a', null), node('b', 'a'), node('q', null, { x: slot.x, y: slot.y })]);
    expect(pos(r, 'q')).toEqual(slot); // the dragged node never moves
    expect(overlaps(pos(r, 'b'), pos(r, 'q'))).toBe(false);
    expect(pos(r, 'b').x).toBe(slot.x); // nudged along the column, not thrown elsewhere
    expect(pos(r, 'b').y).toBeGreaterThan(slot.y);
  });

  it('never lets two visible nodes overlap when only one branch was dragged', () => {
    const forest: LayoutNode[] = [node('r', null)];
    for (let i = 0; i < 6; i++) {
      forest.push(node(`b${i}`, 'r'));
      for (let j = 0; j < 3; j++) forest.push(node(`b${i}-${j}`, `b${i}`));
    }
    // Drag one branch right on top of another branch's node, so both sets of children want the same column.
    const before = layoutMindMap(forest);
    const target = pos(before, 'b1');
    const dragged = forest.find((n) => n.id === 'b4');
    if (!dragged) throw new Error('missing');
    dragged.x = target.x;
    dragged.y = target.y;
    const r = layoutMindMap(forest);
    const ids = [...r.visible];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (!a || !b) continue;
        // The dragged node itself may sit on top of whatever the user dropped it on; everything else must clear.
        if (a === 'b4' || b === 'b4') continue;
        expect(overlaps(pos(r, a), pos(r, b)), `${a} overlaps ${b}`).toBe(false);
      }
  });
});
