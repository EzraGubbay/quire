# Mind Map — feature spec (Phase 0, grilled 2026-10-28)

Output of the grilling session for the queued "Mind map" feature. This is the spec the
implementation session built from. **Implemented 2026-11-04** — see "Implemented" at the bottom
for the decisions taken on the open questions and the files that landed.

## One-line

A **user-authored**, hand-built mind map — one per course/project, available on **both** the
Courses and Research sides — where the user records *their own* evolving mental model of the
material. It is deliberately **separate** from the existing auto-generated notes graph.

## Decisions (from the grilling)

| Question | Decision |
|---|---|
| What it is | A custom, manually-maintained mind map of the user's own mental model. Not derived from notes. |
| Availability | Universal: the feature exists on **both** sides (courses + research). |
| Scope | **Per-course / per-project** — one map per project (matches existing per-project data keying). |
| Node source | **Hand-built only.** No auto-seeding from notes/wikilinks/term-labels. |
| Structure | A **forest**: independent root nodes (separate areas being explored) + parent/child/sibling nodes under them. |
| Interaction | **Editable** (add / rename / re-link / delete nodes) and click-through to a node's attached note. Must be comfortable on the **iPad PWA** (touch drag, pinch-zoom, large hit targets). |
| Layout | **Auto-layout from the relationships + drag-to-nudge** — structure arranges automatically; the user can drag a node to override and the position **persists**. Zoom in / out + pan. |
| Node attachment | Each node has a **hidden Markdown note**, revealed on click. Uses a Markdown editor **but with wikilinks disabled** — this note is its own thing, unrelated to the existing notes concept and to the notes graph. |

## Primary use case

The user is exploring one or more topics and wants to externalise the structure in their own
head: create a root per independent area, grow child/sibling nodes as understanding develops,
drag things where they make sense, and stash a free-form Markdown note behind each node (shown on
click) for the detail. It is a thinking tool owned entirely by the user, not a visualisation of
existing data.

## Explicitly NOT this feature

- **Not** the existing notes graph (`/[side]/[slug]/notes/graph`, `components/graph/graph-view.tsx`,
  `lib/graph.ts`). That one is auto-generated from notes/documents/sources, wikilink-edged,
  force-directed, and view-only. The mind map neither reads from nor writes to it.
- **No** auto-seeding, **no** term-label/wikilink extraction, **no** AI.
- The node notes are **not** Quire notes and do **not** support `[[wikilinks]]`.

## Data model (new, keyed per project)

Forest encoded via a nullable parent pointer (no separate edge table needed for the MVP):

- `mind_map_node`: `id`, `project_id` (FK), `parent_id` (nullable → root), `label` text,
  `note` text (Markdown, may be empty), `x` real / `y` real (nullable → use computed layout
  position until the user drags), `sort_order` int (sibling order), `collapsed` bool,
  `created_at` / `updated_at`.
- Optional later: `mind_map_edge` only if cross-tree links (a DAG) are wanted beyond the forest —
  **out of scope for MVP** (see open questions).

Writes via a server action, following the existing `app/actions/*` + drizzle patterns.
Gate behind a feature flag following the `currentFeature('graph')` / `lib/features.ts` +
`lib/platform-server.ts` pattern.

## UI / routing

- A tab/route under the existing `[side]/[slug]` segment, e.g. `/[side]/[slug]/mindmap`
  (`[side]` ∈ courses|research). Present on both sides, next to the existing Graph tab.
  Keep it visually distinct from "Graph" so the two aren't confused.
- Clicking a node opens its Markdown note in a side panel / drawer (reuse the editor; pass a prop
  to **disable wikilink autocomplete/resolution** — see `components/editor/markdown-editor.tsx`
  and `components/editor/wikilink-complete.tsx`).

## Suggested implementation

- **Layout:** add `d3-hierarchy` (tree/cluster layout) for the auto-arrange — `d3-force` (already a
  dep) is wrong for a structured parent/child mind map. Computed position is the default; a stored
  `x`/`y` (from a drag) overrides it. `d3-zoom` (or a CSS transform) for pinch/scroll zoom + pan.
- **Rendering:** a new interactive SVG/canvas component rather than reusing the view-only
  `@ezragubbay/folio` `NoteGraph`. Use pointer events (not mouse-only) so iPad drag/zoom work.
- **Editor reuse:** the existing CodeMirror Markdown editor for the per-node note, wikilinks off.
- Stack notes: Next.js 16.3.4 / React 19, biome lint. `apps/web/AGENTS.md` warns this Next.js has
  breaking changes — read `node_modules/next/dist/docs` before coding.

## Open questions for the implementation session

1. **Forest vs. DAG** — MVP is a strict forest (each node one parent). Do we ever want cross-links
   between branches? If yes, add `mind_map_edge` later; don't block MVP on it.
2. **Reparenting** — drag a node onto another to change its parent, or edit parent via a menu?
3. **Collapse/expand** subtrees (schema has `collapsed`; confirm the gesture).
4. **Per-node styling** — colors/icons per root or per node?
5. **Export** — print / PNG / Markdown outline export?
6. **Touch specifics** — long-press to add a child? two-finger pan vs. one-finger drag-node on iPad?

## Implemented (2026-11-04)

Built exactly as the decisions table specifies (forest, per-project, both sides, hand-built,
auto-layout + drag-persist, per-node Markdown note with wikilinks OFF). Decisions taken on the
open questions:

1. **Forest vs. DAG** — strict **forest** (one parent per node), as the MVP says. No `mind_map_edge`.
2. **Reparenting** — **menu-based**, not drag-onto: select a node → "Move under…" enters a pick
   mode (next node clicked becomes the parent) with a "Make it a root" button. Chosen over drag-onto
   so plain drag stays unambiguously *reposition*, and because it is reliable on touch. A server-side
   cycle guard rejects moving a node under itself or a descendant.
3. **Collapse/expand** — a **caret** on any node with children (click to toggle); a collapsed node
   shows a "(N hidden)" count. State persists.
4. **Per-node styling** — **one hue per root**, inherited by its whole subtree (6-colour palette).
5. **Export** — **deferred** (not built). Markdown-outline / PNG export can come later; nothing
   depends on it.
6. **Touch** — one-finger drag a node = reposition; drag the background / two-finger = pan; pinch =
   zoom; a selected node's **＋** adds a child. No long-press (ambiguous on trackpads). Pointer events
   throughout so iPad works.

Extra decision found during build: mutations `revalidatePath` the mind-map route so a later visit
re-reads the forest. The live canvas is uncontrolled after mount (`MindMapView` seeds from
`initialNodes` once), so this never disturbs an in-progress edit or drag — it only refreshes the
cached RSC for the next navigation.

**Files:** `db/schema.ts` (`mind_map_nodes` + `drizzle/0009`), `lib/mindmap.ts` (CRUD + cycle guard),
`lib/mindmap-layout.ts` (pure d3-hierarchy layout, `+ .test.ts`), `app/actions/mindmap.ts`,
`app/[side]/[slug]/mindmap/` (page + loading + css), `components/mindmap/` (`mind-map-view.tsx`
interactive SVG/HTML canvas with pointer pan/zoom/drag, `node-note-panel.tsx` autosave drawer),
`components/editor/markdown-editor.tsx` (`wikilinks` / `placeholderText` props), `lib/features.ts`
(`mindmap` flag: desktop + iPad, phone off), nav in `app-shell.tsx` + `command-palette.tsx`,
`e2e/mindmap.spec.ts`. Added dep: `d3-hierarchy`.
