'use client';

import { Button, Icon } from '@ezragubbay/folio';
import {
  ChevronRight,
  CornerUpLeft,
  Crosshair,
  ListPlus,
  Maximize2,
  Pencil,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  createMindMapNodeAction,
  deleteMindMapNodeAction,
  moveMindMapNodeAction,
  renameMindMapNodeAction,
  reparentMindMapNodeAction,
  resetMindMapPositionAction,
  toggleMindMapCollapseAction,
} from '@/app/actions/mindmap';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import type { MindMapNode } from '@/db/schema';
import { type LayoutNode, layoutMindMap, MINDMAP_LAYOUT } from '@/lib/mindmap-layout';
import s from './mind-map.module.css';
import { NodeNotePanel } from './node-note-panel';

/**
 * Max node box width (px). Nodes now shrink-to-fit their label (CSS `width: max-content`) and only grow to
 * this cap before wrapping, so a short title like "AI" is a small box. It doubles as the fallback width for
 * edge geometry until a node's real width has been measured. (Sized to also hold the five-button action bar
 * of a selected node on one row.) Shared with the layout, which uses it to keep auto-placed nodes clear of
 * their neighbours.
 */
const NODE_W = MINDMAP_LAYOUT.NODE_W;
const MIN_K = 0.25;
const MAX_K = 2.5;
/** Six gentle hues, one per root; the whole subtree inherits its root's hue. */
const HUES = [210, 150, 275, 32, 340, 95];

type View = { tx: number; ty: number; k: number };

function toLayoutNodes(nodes: MindMapNode[]): LayoutNode[] {
  return nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    collapsed: n.collapsed,
    x: n.x,
    y: n.y,
    sortOrder: n.sortOrder,
  }));
}

export function MindMapView({ slug, initialNodes }: { slug: string; initialNodes: MindMapNode[] }) {
  const [nodes, setNodes] = useState<MindMapNode[]>(initialNodes);
  const [selected, setSelected] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // A just-created node whose rename box should open empty (placeholder) rather than pre-filled with the
  // default label, so the user types straight over it instead of erasing "New node" first.
  const [newNodeId, setNewNodeId] = useState<string | null>(null);
  // The live text in the open rename box. Tracked so the box can grow to fit what you type — a bare <input>
  // doesn't size to its value — and so a fresh node's box sizes to its placeholder rather than collapsing.
  const [draft, setDraft] = useState('');
  const [reparenting, setReparenting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MindMapNode | null>(null);
  // Multi-select: Cmd/Ctrl-click gathers several nodes into `multi` to move or delete as a group. `selected`
  // stays the single anchor (keyboard nav, the per-node action bar); `multi` drives the group operations and,
  // when non-empty, the selection highlight.
  const [multi, setMulti] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDeleteMany, setConfirmDeleteMany] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ tx: 40, ty: 40, k: 1 });
  // Measured border-box width of each rendered node, so an edge can meet its parent's real right edge now
  // that nodes are no longer a fixed width.
  const [widths, setWidths] = useState<Map<string, number>>(new Map());

  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  // Transient pan / pinch / node-drag state kept in refs so a move doesn't thrash React state.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinch = useRef<{ dist: number; k: number; cx: number; cy: number } | null>(null);
  const drag = useRef<{
    id: string;
    startX: number;
    startY: number;
    px: number;
    py: number;
    moved: boolean;
    // When the pressed node is part of a multi-selection, every member moves together; each entry holds a
    // member's start position so the same delta can be applied to all.
    group?: { id: string; px: number; py: number }[];
  } | null>(null);

  const layout = useMemo(() => layoutMindMap(toLayoutNodes(nodes)), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const childCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) if (n.parentId) m.set(n.parentId, (m.get(n.parentId) ?? 0) + 1);
    return m;
  }, [nodes]);

  // Re-measure node widths only when something that can change a box's width changes — its label, the
  // selection (the selected node grows an action bar), whether a node is in its rename box, or the live
  // rename text (the box grows as you type). Keyed on those (not run every render) so the setWidths it
  // triggers can't feed back into an update loop. Runs before paint so edges line up with the boxes, no flash.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-measure triggers — the body reads the DOM via a ref, not these values, and dropping them would stop widths updating.
  useLayoutEffect(() => {
    setWidths((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, el] of nodeEls.current) {
        if (!el?.isConnected) continue;
        const w = Math.round(el.offsetWidth);
        if (prev.get(id) !== w) {
          next.set(id, w);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [nodes, selected, renaming, draft]);

  // Root hue for every node (walk up to the root, index roots in sort order).
  const hueOf = useMemo(() => {
    const roots = nodes.filter((n) => !n.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
    const rootHue = new Map<string, number>();
    roots.forEach((r, i) => {
      rootHue.set(r.id, HUES[i % HUES.length] ?? 210);
    });
    const out = new Map<string, number>();
    for (const n of nodes) {
      let cur: MindMapNode | undefined = n;
      const seen = new Set<string>();
      while (cur?.parentId && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
      out.set(n.id, (cur && rootHue.get(cur.id)) ?? 210);
    }
    return out;
  }, [nodes, byId]);

  const descendants = useCallback(
    (id: string): Set<string> => {
      const kids = new Map<string | null, string[]>();
      for (const n of nodes) {
        const a = kids.get(n.parentId) ?? [];
        a.push(n.id);
        kids.set(n.parentId, a);
      }
      const out = new Set<string>([id]);
      const stack = [id];
      while (stack.length) {
        const c = stack.pop();
        if (c === undefined) break;
        for (const k of kids.get(c) ?? [])
          if (!out.has(k)) {
            out.add(k);
            stack.push(k);
          }
      }
      return out;
    },
    [nodes],
  );

  const patchNode = useCallback((id: string, patch: Partial<MindMapNode>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }, []);

  // ---- canvas pan + pinch zoom ----
  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        pinch.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          k: view.k,
          cx: (a.x + b.x) / 2,
          cy: (a.y + b.y) / 2,
        };
        pan.current = null;
      }
    }
  };
  const onCanvasPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const start = pinch.current;
      const k = Math.min(MAX_K, Math.max(MIN_K, (start.k * dist) / (start.dist || 1)));
      const rect = canvasRef.current?.getBoundingClientRect();
      const cx = start.cx - (rect?.left ?? 0);
      const cy = start.cy - (rect?.top ?? 0);
      setView((v) => ({ k, tx: cx - ((cx - v.tx) * k) / v.k, ty: cy - ((cy - v.ty) * k) / v.k }));
      return;
    }
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.x), ty: p.ty + (e.clientY - p.y) }));
    }
  };
  const endPointer = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) pan.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = e.clientX - (rect?.left ?? 0);
    const cy = e.clientY - (rect?.top ?? 0);
    const factor = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      return { k, tx: cx - ((cx - v.tx) * k) / v.k, ty: cy - ((cy - v.ty) * k) / v.k };
    });
  };

  // Add/remove a node from the multi-selection. If nothing was multi-selected yet, seed it with the current
  // single anchor so Cmd-clicking a second node selects both. Keeps `selected` as the anchor; closes the note.
  const toggleMulti = (id: string) => {
    setMulti((m) => {
      const next = new Set(m);
      if (next.size === 0 && selected && selected !== id) next.add(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(id);
    setOpenNote(null);
  };

  // ---- node drag (reposition) ----
  const onNodePointerDown = (e: ReactPointerEvent, node: MindMapNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const pos = layout.positions.get(node.id);
    if (!pos) return;
    // Dragging a member of a multi-selection moves the whole group; capture each member's start position.
    const group =
      multi.size > 1 && multi.has(node.id)
        ? [...multi]
            .map((id) => {
              const p = layout.positions.get(id);
              return p ? { id, px: p.x, py: p.y } : null;
            })
            .filter((g): g is { id: string; px: number; py: number } => g !== null)
        : undefined;
    drag.current = {
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      px: pos.x,
      py: pos.y,
      moved: false,
      group,
    };
  };
  const onNodePointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / view.k;
    const dy = (e.clientY - d.startY) / view.k;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.group) for (const g of d.group) patchNode(g.id, { x: g.px + dx, y: g.py + dy });
    else patchNode(d.id, { x: d.px + dx, y: d.py + dy });
  };
  const onNodePointerUp = (e: ReactPointerEvent, node: MindMapNode) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // A tap, not a drag.
      if (reparenting) void doReparent(reparenting, node.id);
      else if (e.metaKey || e.ctrlKey) toggleMulti(node.id);
      else {
        setMulti(new Set());
        setSelected(node.id);
        setOpenNote(node.id);
      }
      return;
    }
    // Persist the moved node — or every member of a moved group.
    for (const id of d.group ? d.group.map((g) => g.id) : [d.id]) {
      const final = byId.get(id);
      if (final && final.x !== null && final.y !== null) {
        void moveMindMapNodeAction(slug, id, final.x, final.y);
      }
    }
  };

  // ---- actions ----
  // Open a freshly created node straight into its rename box, flagged so the box shows a placeholder.
  // (Memoized so the keyboard-shortcut effect's dependencies stay stable and it isn't re-bound each render.)
  const beginNaming = useCallback((node: MindMapNode) => {
    setNodes((ns) => [...ns, node]);
    setSelected(node.id);
    setNewNodeId(node.id);
    setDraft(''); // open empty; the default label shows as placeholder
    setRenaming(node.id);
  }, []);
  const addRoot = async () => {
    const res = await createMindMapNodeAction(slug, { parentId: null, label: 'New topic' });
    if (res.node) beginNaming(res.node as MindMapNode);
    else setError(res.error ?? 'Could not add');
  };
  const addChild = useCallback(
    async (parentId: string) => {
      const res = await createMindMapNodeAction(slug, { parentId, label: 'New node' });
      if (res.node) {
        patchNode(parentId, { collapsed: false });
        beginNaming(res.node as MindMapNode);
      } else setError(res.error ?? 'Could not add');
    },
    [slug, patchNode, beginNaming],
  );
  // Add a node beside `node` (same parent — a new root when `node` is a root).
  const addSibling = useCallback(
    async (node: MindMapNode) => {
      const res = await createMindMapNodeAction(slug, { parentId: node.parentId, label: 'New node' });
      if (res.node) beginNaming(res.node as MindMapNode);
      else setError(res.error ?? 'Could not add');
    },
    [slug, beginNaming],
  );
  const rename = async (id: string, label: string) => {
    setRenaming(null);
    setNewNodeId((cur) => (cur === id ? null : cur));
    const clean = label.trim();
    if (!clean) return;
    patchNode(id, { label: clean });
    const res = await renameMindMapNodeAction(slug, id, clean);
    if (res.error) setError(res.error);
  };
  const toggleCollapse = useCallback(
    async (node: MindMapNode) => {
      const collapsed = !node.collapsed;
      patchNode(node.id, { collapsed });
      await toggleMindMapCollapseAction(slug, node.id, collapsed);
    },
    [slug, patchNode],
  );
  const doReparent = async (id: string, parentId: string | null) => {
    setReparenting(null);
    const res = await reparentMindMapNodeAction(slug, id, parentId);
    if (res.node) patchNode(id, { parentId: res.node.parentId, sortOrder: res.node.sortOrder });
    else setError(res.error ?? 'Could not move');
  };
  const resetPosition = async (id: string) => {
    patchNode(id, { x: null, y: null });
    await resetMindMapPositionAction(slug, id);
  };
  const remove = async (node: MindMapNode) => {
    setConfirmDelete(null);
    const gone = descendants(node.id);
    setNodes((ns) => ns.filter((n) => !gone.has(n.id)));
    if (openNote && gone.has(openNote)) setOpenNote(null);
    if (selected && gone.has(selected)) setSelected(null);
    const res = await deleteMindMapNodeAction(slug, node.id);
    if (res.error) setError(res.error);
  };
  // Delete every node in a multi-selection (and their descendants). Optimistically drop the whole union, then
  // delete only the top-most selected nodes server-side — a delete cascades to descendants, so deleting a node
  // whose ancestor is also selected would hit an already-gone row.
  const removeMany = async (ids: string[]) => {
    setConfirmDeleteMany(null);
    const gone = new Set<string>();
    for (const id of ids) for (const g of descendants(id)) gone.add(g);
    setNodes((ns) => ns.filter((n) => !gone.has(n.id)));
    if (openNote && gone.has(openNote)) setOpenNote(null);
    if (selected && gone.has(selected)) setSelected(null);
    setMulti(new Set());
    const set = new Set(ids);
    const underAnother = (id: string) => {
      let p = byId.get(id)?.parentId ?? null;
      while (p) {
        if (set.has(p)) return true;
        p = byId.get(p)?.parentId ?? null;
      }
      return false;
    };
    for (const id of ids) {
      if (underAnother(id)) continue;
      const res = await deleteMindMapNodeAction(slug, id);
      if (res.error) setError(res.error);
    }
  };

  // ---- keyboard shortcuts ----
  // All single-key, no modifiers: they work the same whether Quire runs as a browser PWA or inside the
  // Electron shell (Cmd/Ctrl combos would collide with the browser's own, so we avoid them). Active only
  // when a node is selected and you aren't typing in a field or editing a note.
  const siblingsOf = useCallback(
    (parentId: string | null) =>
      nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder),
    [nodes],
  );
  // Move the selection highlight. Deliberately independent of the note drawer: the drawer autofocuses its
  // editor, so pulling it along would capture the keyboard and halt navigation after one step.
  const select = useCallback((id: string) => {
    setSelected(id);
    setMulti(new Set()); // moving the single selection exits multi-select
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renaming) return; // the rename input owns the keyboard while it's open
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Enter/Space activate a focused button/link themselves — don't also run the map shortcut (Escape and
      // the others, which buttons ignore, stay live).
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        t &&
        (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SELECT')
      )
        return;

      if (e.key === 'Escape') {
        if (reparenting) setReparenting(null);
        else if (multi.size) setMulti(new Set());
        else if (openNote) setOpenNote(null);
        else if (selected) setSelected(null);
        else return;
        e.preventDefault();
        return;
      }
      if (reparenting) return; // don't mutate the tree mid-reparent
      const node = selected ? byId.get(selected) : null;
      if (!node) return;

      switch (e.key) {
        case 'Tab': // add child
          e.preventDefault();
          void addChild(node.id);
          break;
        case 'Enter': // add sibling
          e.preventDefault();
          void addSibling(node);
          break;
        case 'F2': // rename
          e.preventDefault();
          setNewNodeId(null);
          setDraft(node.label);
          setRenaming(node.id);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (multi.size > 1) setConfirmDeleteMany([...multi]);
          else setConfirmDelete(node);
          break;
        case ' ': // collapse / expand
          e.preventDefault();
          if ((childCount.get(node.id) ?? 0) > 0) void toggleCollapse(node);
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const sibs = siblingsOf(node.parentId);
          const i = sibs.findIndex((n) => n.id === node.id);
          const next = sibs[i + (e.key === 'ArrowDown' ? 1 : -1)];
          if (next) select(next.id);
          break;
        }
        case 'ArrowLeft': // go to parent
          e.preventDefault();
          if (node.parentId) select(node.parentId);
          break;
        case 'ArrowRight': {
          // go to first child (expanding if needed)
          e.preventDefault();
          const kids = siblingsOf(node.id);
          if (!kids.length) break;
          if (node.collapsed) void toggleCollapse(node);
          const first = kids[0];
          if (first) select(first.id);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    renaming,
    reparenting,
    openNote,
    selected,
    multi,
    byId,
    childCount,
    addChild,
    addSibling,
    toggleCollapse,
    siblingsOf,
    select,
  ]);

  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    const cx = (el?.clientWidth ?? 600) / 2;
    const cy = (el?.clientHeight ?? 400) / 2;
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      return { k, tx: cx - ((cx - v.tx) * k) / v.k, ty: cy - ((cy - v.ty) * k) / v.k };
    });
  };
  const fit = () => {
    const el = canvasRef.current;
    if (!el || layout.width === 0) return setView({ tx: 40, ty: 40, k: 1 });
    const k = Math.min(
      MAX_K,
      Math.max(MIN_K, Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height, 1)),
    );
    setView({ k, tx: (el.clientWidth - layout.width * k) / 2, ty: 24 });
  };

  const reparentTarget = reparenting ? byId.get(reparenting) : null;
  const reparentBlocked = reparenting ? descendants(reparenting) : null;

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <Button variant="primary" size="sm" icon={<Icon icon={Plus} />} onClick={() => void addRoot()}>
          Add root
        </Button>
        {selected && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon icon={CornerUpLeft} />}
            onClick={() => void resetPosition(selected)}
            title="Snap the selected node back to the auto-layout position"
          >
            Reset position
          </Button>
        )}
        <span className={s.spacer} />
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={ZoomOut} />}
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
        />
        <span className={s.zoomPct}>{Math.round(view.k * 100)}%</span>
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={ZoomIn} />}
          aria-label="Zoom in"
          onClick={() => zoomBy(1.2)}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={Maximize2} />}
          aria-label="Fit to view"
          onClick={fit}
        />
      </div>

      {reparentTarget && (
        <div className={s.banner} role="status" data-testid="mindmap-reparent">
          <Icon icon={Crosshair} size={16} />
          <span>
            Pick a new parent for <strong>{reparentTarget.label}</strong>, or
          </span>
          <Button variant="secondary" size="sm" onClick={() => void doReparent(reparentTarget.id, null)}>
            Make it a root
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setReparenting(null)}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <div className={s.banner} data-error role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div className={s.canvasWrap}>
        <div
          ref={canvasRef}
          className={s.canvas}
          // Focusable so the map keyboard shortcuts have a home that isn't a button; selection is shown on
          // the node itself, so no focus ring is needed here.
          tabIndex={0}
          data-testid="mindmap-canvas"
          data-reparenting={reparenting ? 'true' : undefined}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onWheel={onWheel}
        >
          {nodes.length === 0 ? (
            <div className={s.empty}>
              <p>Your mind map is empty.</p>
              <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => void addRoot()}>
                Add a root node
              </Button>
            </div>
          ) : (
            <div
              className={s.world}
              style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}
            >
              <svg
                className={s.edges}
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
                focusable="false"
              >
                {nodes.map((n) => {
                  if (!n.parentId || !layout.visible.has(n.id) || !layout.visible.has(n.parentId))
                    return null;
                  const c = layout.positions.get(n.id);
                  const p = layout.positions.get(n.parentId);
                  if (!c || !p) return null;
                  const x1 = p.x + (widths.get(n.parentId) ?? NODE_W);
                  const y1 = p.y;
                  const x2 = c.x;
                  const y2 = c.y;
                  const mx = (x1 + x2) / 2;
                  return (
                    <path
                      key={n.id}
                      className={s.edge}
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                      style={{ stroke: `hsl(${hueOf.get(n.id) ?? 210} 45% 55%)` }}
                    />
                  );
                })}
              </svg>
              {nodes.map((n) => {
                const pos = layout.positions.get(n.id);
                if (!pos || !layout.visible.has(n.id)) return null;
                const hue = hueOf.get(n.id) ?? 210;
                const kids = childCount.get(n.id) ?? 0;
                const hidden = layout.hiddenChildren.get(n.id) ?? 0;
                const blocked = reparentBlocked?.has(n.id) ?? false;
                return (
                  <div
                    key={n.id}
                    ref={(el) => {
                      if (el) nodeEls.current.set(n.id, el);
                      else nodeEls.current.delete(n.id);
                    }}
                    className={s.node}
                    data-selected={
                      (multi.size > 0 ? multi.has(n.id) : selected === n.id) ? 'true' : undefined
                    }
                    data-dim={reparenting && blocked ? 'true' : undefined}
                    data-testid="mindmap-node"
                    style={{
                      left: pos.x,
                      top: pos.y,
                      maxWidth: NODE_W,
                      ['--hue' as string]: String(hue),
                    }}
                    onPointerDown={(e) => onNodePointerDown(e, n)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={(e) => onNodePointerUp(e, n)}
                  >
                    {kids > 0 && (
                      <button
                        type="button"
                        className={s.caret}
                        data-collapsed={n.collapsed ? 'true' : undefined}
                        aria-label={n.collapsed ? `Expand (${hidden} hidden)` : 'Collapse'}
                        title={n.collapsed ? `Expand (${hidden} hidden)` : 'Collapse'}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleCollapse(n);
                        }}
                      >
                        <Icon icon={ChevronRight} size={16} />
                      </button>
                    )}
                    {renaming === n.id ? (
                      <input
                        // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened to rename
                        autoFocus
                        className={s.renameInput}
                        // Controlled so the box can grow as you type. A freshly created node opens empty with
                        // the default label as placeholder (type straight over it); an existing node opens with
                        // its text to edit. `size` tracks the live text (falling back to the placeholder when
                        // empty) so the <input> widens to fit what you type instead of staying a sliver.
                        value={draft}
                        size={Math.max((draft || (newNodeId === n.id ? n.label : '')).length + 1, 4)}
                        placeholder={newNodeId === n.id ? n.label : undefined}
                        aria-label="Node label"
                        onChange={(e) => setDraft(e.target.value)}
                        onPointerDown={(e) => e.stopPropagation()}
                        onBlur={(e) => void rename(n.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') {
                            setNewNodeId((cur) => (cur === n.id ? null : cur));
                            setRenaming(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className={s.label}
                        onPointerDown={(e) => e.stopPropagation()}
                        onDoubleClick={() => {
                          setNewNodeId(null);
                          setDraft(n.label);
                          setRenaming(n.id);
                        }}
                        onClick={(e) => {
                          if (reparenting) void doReparent(reparenting, n.id);
                          else if (e.metaKey || e.ctrlKey) toggleMulti(n.id);
                          else {
                            setMulti(new Set());
                            setSelected(n.id);
                            setOpenNote(n.id);
                          }
                        }}
                        title={
                          n.note.trim()
                            ? 'Has a note — click to open (⌘-click to multi-select)'
                            : 'Click to open the note (⌘-click to multi-select)'
                        }
                      >
                        <span className={s.labelText}>{n.label || 'Untitled'}</span>
                        {n.note.trim() && <span className={s.noteDot} role="img" aria-label="has note" />}
                      </button>
                    )}
                    {selected === n.id && multi.size < 2 && !reparenting && (
                      <div className={s.nodeBar} onPointerDown={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          title="Add child (Tab)"
                          aria-label="Add child"
                          onClick={() => void addChild(n.id)}
                        >
                          <Icon icon={Plus} size={16} />
                        </button>
                        <button
                          type="button"
                          title="Add sibling (Enter)"
                          aria-label="Add sibling"
                          onClick={() => void addSibling(n)}
                        >
                          <Icon icon={ListPlus} size={16} />
                        </button>
                        <button
                          type="button"
                          title="Rename (F2)"
                          aria-label="Rename"
                          onClick={() => {
                            setNewNodeId(null);
                            setDraft(n.label);
                            setRenaming(n.id);
                          }}
                        >
                          <Icon icon={Pencil} size={16} />
                        </button>
                        <button
                          type="button"
                          title="Move under…"
                          aria-label="Move under another node"
                          onClick={() => setReparenting(n.id)}
                        >
                          <Crosshair style={{ width: 14, height: 14 }} />
                        </button>
                        <button
                          type="button"
                          title="Delete node and its children (Delete)"
                          aria-label="Delete"
                          data-danger
                          onClick={() => setConfirmDelete(n)}
                        >
                          <Icon icon={Trash2} size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {openNote && byId.get(openNote) && (
          <NodeNotePanel
            key={openNote}
            slug={slug}
            node={byId.get(openNote) as MindMapNode}
            onClose={() => {
              setOpenNote(null);
              canvasRef.current?.focus(); // hand the keyboard back to the map
            }}
            onLabel={(label) => void rename(openNote, label)}
            onNoteSaved={(note) => patchNode(openNote, { note })}
          />
        )}
      </div>

      {confirmDelete && (
        <Dialog open title="Delete node?" onClose={() => setConfirmDelete(null)}>
          <p className={s.confirmText}>
            Delete <strong>{confirmDelete.label || 'this node'}</strong>
            {(childCount.get(confirmDelete.id) ?? 0) > 0 ? ' and all of its descendants' : ''}? This can't be
            undone.
          </p>
          <DialogActions>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="primary" data-danger onClick={() => void remove(confirmDelete)}>
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {confirmDeleteMany && (
        <Dialog
          open
          title={`Delete ${confirmDeleteMany.length} nodes?`}
          onClose={() => setConfirmDeleteMany(null)}
        >
          <p className={s.confirmText}>
            Delete <strong>{confirmDeleteMany.length} selected nodes</strong> and all of their descendants?
            This can't be undone.
          </p>
          <DialogActions>
            <Button variant="secondary" onClick={() => setConfirmDeleteMany(null)}>
              Cancel
            </Button>
            <Button variant="primary" data-danger onClick={() => void removeMany(confirmDeleteMany)}>
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}
