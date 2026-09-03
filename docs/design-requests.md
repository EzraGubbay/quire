# Requests for the Folio design system (`~/.design`, github.com/EzraGubbay/design)

Quire consumes `@ezragubbay/core` and `@ezragubbay/folio`. These are the changes Quire needs from the design repo, in priority order. Until each lands, Quire works around it locally with CSS-variable overrides or a local component styled with `--eg-*` / `--folio-*` tokens.

## 1. Publish to npm (blocks CI cleanliness)
`pnpm publish --access public` for `@ezragubbay/core` and `@ezragubbay/folio` at 0.1.0. Quire currently vendors tarballs in `vendor/` (see `vendor/README.md`) and will switch to version ranges the moment they exist.

## 2. Annotation types replace highlight kinds
Quire's annotation vocabulary is **note, insight, idea, question, todo** (default: note). The current `HIGHLIGHT_KINDS` (claim, method, result, question, todo) should become these five. Affects `kinds.ts`, tokens `--folio-hl-<kind>` and `--folio-hl-<kind>-text`, `Highlight`, `HighlightChip`, `AnnotationCard`, `NoteGraph` legend copy. Suggested hues: note = neutral warm grey-blue, insight = oxblood-adjacent rose, idea = amber, question = blue, todo = green; pastel on paper, luminous in dark; AA contrast for the `-text` pair.

## 3. NoteGraph node types
`NodeType` should be `document | note | source | idea` (papers and Markdown documents are both "document"). Add an `insight` variant sharing the idea shape with the insight hue, or let `kind` drive hue as today and keep four shapes.

## 4. Mark lockup name
`AppBar` renders `<Mark system="Folio" />`. Quire needs the lockup to read "Quire" (the register is Folio, the product is Quire). Add a `system` prop to `AppBar` that is passed to `Mark`.

## 5. Components Quire will need (Phase 1 to 4)
Build these in Folio so Claude Design keeps the source of truth; Quire ships a local fallback until they exist.
- `AnnotationPanel` chrome: header with show/hide toggle, five type filter buttons, fuzzy search input.
- `AnnotationComposer`: the quick-add card (type label as a dropdown trigger, body textarea autofocused).
- `SelectionPopover`: the floating "Annotate" button that appears beside a text selection.
- `FileTree` row: folder/PDF/Markdown icons, nesting indent, drag handle, active state.
- `Tabs` (in-page), `Dialog`, `SlideOver`, `CommandPalette`, `Toast`, `EmptyState`.
- Form controls: `Field`, `Input`, `Textarea`, `Select`, `TagInput`.
- `MetricSparkline` and `StatusDot` for experiment runs.
- `ChatMessage` with citation chips.

## 6. Screens for Claude Design (when refining visuals)
Notes editor (read/edit modes), full-page graph, Sources tab, Experiments tab and run detail, Chat tab and Ask slide-over, project switcher and home, command palette, annotation popover and composer, add-document dialog, empty states, iPad width for the reader. Light and dark for each.
