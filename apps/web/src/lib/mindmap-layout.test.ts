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
