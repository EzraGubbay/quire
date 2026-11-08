# Mind map: auto-placement & auto-rearrangement (deferred design note)

**Status:** not started — scoped for a later pickup. Written 2026-11-08 alongside the node-editing
work (placeholder-on-add, shrink-to-fit nodes, add-sibling, keyboard shortcuts).

## What the user asked for

> "Make the mind map auto-place new nodes, and auto-rearrange itself so that it fits the nodes'
> visibility."

Two things:

1. **Auto-place new nodes** — a newly added child/sibling should land in a sensible spot next to its
   relatives, never on top of another node or off in dead space.
2. **Auto-rearrange for visibility** — when nodes are added, removed, renamed (→ resized),
   collapsed/expanded, the whole map should reflow into a tidy, non-overlapping arrangement and stay
   within (or be brought into) view.

## Where we are today

- Layout lives in `apps/web/src/lib/mindmap-layout.ts`. It hangs the whole forest off one virtual root
  and runs **d3-hierarchy** `tree().nodeSize([ROW, COL])` once, left-to-right. `ROW = 64` (fixed breadth
  between siblings), `COL = 220` (fixed depth between generations).
- **Node size is not an input to the layout.** The tree assumes a uniform cell. Node boxes are now
  shrink-to-fit up to a `NODE_W = 176` cap (and can wrap to multiple lines), so real widths/heights vary
  but the layout still spaces everything as if every node were one fixed cell.
- **Manual drags pin a node.** `layoutMindMap` computes auto positions, then overrides any node that has a
  stored `x`/`y` (set by a drag; persisted via `moveMindMapNodeAction`, cleared by
  `resetMindMapPositionAction`). So the live map is a *mix* of auto-placed and hand-placed nodes.
- New nodes are created with `x = null, y = null`, so they already take an auto-layout slot. New-node
  placement only looks wrong when the parent/siblings were **hand-dragged**: the newcomer uses its tidy
  auto-slot, which ignores the manual cluster and can land far away or overlap it.
- The viewport (`view = {tx, ty, k}`) never follows structural changes — only the explicit zoom buttons
  and `fit()` move it. A new node can appear off-screen.
- Positions are applied as plain inline `left/top`; there is **no transition**, so any reflow would jump.

## The crux

Genuine auto-arrangement and the current **drag-to-pin** model are in tension. You cannot both "let the
user place nodes anywhere" and "keep everything tidy and non-overlapping automatically." A decision is
required (see Option A/B below) — this is the main design call, not a coding detail.

## Major implementation changes

### 1. Make node size feed the layout (prerequisite for everything)
- Measure each node's **width and height** (we already measure width into `widths` via a
  `useLayoutEffect` in `mind-map-view.tsx`; add height the same way).
- Swap the uniform `tree().nodeSize([ROW, COL])` for a **variable-size tidy tree**. d3-hierarchy's `tree`
  only does uniform cells; use **`d3-flextree`** (new dependency), which takes a per-node size and lays out
  a non-overlapping tree with variable boxes. This is the core algorithmic change and a rewrite of
  `mindmap-layout.ts` + its unit tests (`mindmap-layout.test.ts`).
- Layout now depends on measured sizes, so it becomes a **two-pass render**: render → measure sizes →
  `useMemo(() => layout(nodes, sizes), [nodes, sizes])` → re-render. Handle first paint (no sizes yet) with
  fallback sizes to avoid a visible jump.

### 2. Resolve the drag/auto tension (pick one)
- **Option A — auto-layout is authoritative (recommended, simplest coherent model).** Retire per-node drag
  persistence. A "drag" becomes **reorder siblings** (changes `sortOrder`), not free positioning. Remove /
  repurpose the `x`/`y` columns, `moveMindMapNodeAction`, `resetMindMapPositionAction`, and the
  drag-override branch in `layoutMindMap`. Overlaps become impossible; new-node placement "just works".
  Needs a small data migration (existing `x`/`y` become ignored).
- **Option B — hybrid (much harder).** Keep manual pins; auto-arrange the *unpinned* nodes and flow them
  around the pinned ones with collision avoidance (force-directed relaxation, e.g. the already-present
  `d3-force`, layered on top of the tidy tree). Significant complexity, fiddly to make stable, and reflow
  can still shove a pinned node's neighbours unexpectedly.

### 3. Smooth reflow (so rearrangement doesn't teleport)
- Animate node position changes — CSS `transition` on the node's `transform`, or an rAF tween between old
  and new positions.
- **Edges must animate too.** They're SVG paths recomputed from positions each render; during a tween the
  paths need to be recomputed per frame (or driven by the same animated positions) or they'll detach from
  the moving boxes. This is the fiddliest part.

### 4. Keep things in view ("fits the nodes' visibility")
- On a structural change, gently **pan** so the affected node (new/selected) is on-screen — compute its
  world→screen position and nudge `tx/ty` only if it's outside the viewport. Avoid a forced full `fit()` on
  every edit; constantly re-fitting fights the user's own zoom/pan and is disorienting.
- Optionally offer an explicit "auto-fit on changes" toggle rather than making it unconditional.

## Files in scope
- `apps/web/src/lib/mindmap-layout.ts` — algorithm swap (flextree), size params. **Rewrite.**
- `apps/web/src/lib/mindmap-layout.test.ts` — **rewrite** for variable sizes / flextree.
- `apps/web/src/components/mindmap/mind-map-view.tsx` — measure heights, pass sizes into layout, reflow
  animation, viewport-follow; drag handler becomes reorder (Option A).
- `apps/web/src/components/mindmap/mind-map.module.css` — position transitions.
- `apps/web/src/app/actions/mindmap.ts`, `apps/web/src/lib/mindmap.ts`, `apps/web/src/db/schema.ts` —
  retire/repurpose `x`/`y` + move/reset actions (Option A); add a migration.
- `apps/web/package.json` — add `d3-flextree` (+ `@types`).

## Risk / why it's deferred
Model change (drag semantics + a DB migration), a new layout dependency, a full rewrite of the layout and
its tests, and non-trivial reflow/edge animation. Each is independently shippable: **(1) size-aware
flextree layout** is the valuable first slice and can land before touching the drag model or animation.

## Suggested order for pickup
1. Measure node height; introduce `d3-flextree` behind the existing override model (tidy tree now respects
   real box sizes — immediate win, overlaps for wrapped/wide nodes go away).
2. Decide Option A vs B. If A: migrate away from `x`/`y`, make drag reorder siblings.
3. Add reflow + edge animation.
4. Add gentle viewport-follow for new/selected nodes.
