# Quire — research project manager on Folio

## Context

Goal is item 1 of the current `README.md`: the personal, tailored way to run an ongoing research project. Product name decided: **Quire** (a gathering of folios; "Lemma" kept as a possible rename). Everything else in the README (course platform, presentation site, Forge products) is out of scope; the README gets rewritten to describe Quire only, keeping the cross-cutting design facts.

Decisions below came from the grill session on 2026-09-03. Design context comes from `~/.design` (the design-system monorepo, spec at `docs/design-spec.md`) and the "Ezra Gubbay Design Directions" canvas (Folio reader + dashboard mocks). The Claude Design project **Folio** (`dd977406-7b03-4050-a29b-ec3b89cbb6e0`) now holds the synced core + folio component library; visuals will keep evolving there and the app must absorb that via package bumps, not forks.

## Decisions

### Product shape
- Hosted web app, installable PWA (iPad). A reduced mobile/iPad feature set is decided separately later; v1 targets desktop widths, must not break on iPad.
- Single user, isolated **Projects** (name, description, status active/archived, created). Project switcher in the app bar, home page lists projects. No cross-project search or links in v1.
- Per-project tabs: **Overview, Documents, Notes, Sources, Experiments, Chat**. ⌘K searches everything in the project.
- Tone: clean, clarity first. Folio register: warm paper, oxblood accent, Source Serif 4 / Source Sans 3 / IBM Plex Mono, light default + dark, WCAG AA.

### Documents (the annotatable things)
- **Document** = what opens in the document viewer with the annotations panel. Two kinds:
  - **Paper**: a PDF. Rendered with PDF.js (text layer for selection). Reading state: unread / reading / done, last page, % read.
  - **Markdown document**: authored by the user (summaries, write-ups). Viewed *rendered* in the same viewer and annotated the same way; edited on a separate edit page (same editor as notes).
- **Add document** dialog with four entry points: drop a PDF; paste a direct PDF URL; paste an arXiv ID/URL (PDF + metadata from the arXiv API); paste a DOI (Crossref metadata, PDF if openly available, else upload). Title/authors/year/abstract extracted and always editable. Markdown documents created blank or imported from `.md`.
- **Left file explorer** in the Documents tab: nested user folders, drag to move, PDF vs Markdown icons, tags, reading-status filter.

### Annotations (one component for PDF and Markdown)
- Right-side **pull-out panel** with a show/hide toggle; hidden = viewer takes the space.
- Add: **+** for a general (unanchored) annotation, or **select text → floating button** by the selection → anchored annotation.
- Five types: **Note** (default), **Insight**, **Idea**, **Question**, **Todo**. Quick-add creates a Note with the cursor in the body; clicking the coloured type label opens a list to change it.
- Card: truncated anchor quote on top, then longer-truncated body. Hover → highlights the anchored lines in the viewer + "scroll to" button. Click → expands full text. Body supports `[[wiki links]]` and math.
- Panel: unfiltered by default, one filter button per type, fuzzy search box.
- Anchoring: PDF → page + text quote + character offsets in the page text layer + rects. Markdown → text-quote selector over rendered text with re-anchoring after edits (fallback: orphaned flag, still listed).

### Notes
- Separate entity from Documents. Obsidian-style short/medium Markdown pages: `[[wiki links]]` (to notes, documents, sources), backlinks, math. Graph nodes. **Not annotatable.** "Promote to Markdown document" action.
- **Read/Edit modes**: rendered view by default; Edit toggles a CodeMirror 6 Markdown source editor with autocomplete for wiki links and math macros and a live rendered preview.

### Sources
- Any non-paper reference: web page, book, video, dataset, repo, blog post. URL, title, type, description, tags. Linkable from notes/annotations, graph node. Optional page-text snapshot for AI retrieval.

### Graph
- Nodes: Notes, Documents, Sources, and annotations of type Idea/Insight. Shape by entity, hue by annotation type (design-system `--folio-hl-*` colours).
- Edges: wiki-links, annotation→document, note→document mentions. AI-suggested connections as dashed edges to accept or dismiss. Click opens; filter by type; drag/zoom. Full-page view in Notes tab plus the small Overview widget (as mocked).
- Layout: d3-force computes positions, fed into the Folio `NoteGraph` component (it takes given x/y).

### Experiments
- Tracker only; nothing runs on the Pi. Experiment → Runs. Run: status (queued/running/done/failed), params, metrics over time, artifacts (files), logs, observations (free text with math + links). Runs link to Documents and Notes.
- Python client `quire` (`quire.init(project, experiment) → run; run.log(metrics); run.finish()`), authenticated with a Cloudflare Access service token + app API key. Manual create/edit in the UI too.

### Math
- MathJax 3 (via `better-react-mathjax` from the design package). Macro set: global (LaTeX `\newcommand` syntax, edited in settings) + per-project overrides. Feeds rendering and editor autocomplete everywhere: notes, Markdown documents, annotations, chat.

### AI
- Provider: **OpenAI API**, user's key. **GPT-5.6 Sol** for heavy questions, **GPT-5.6 Terra** for lighter operations (query rewriting, summaries, discovery ranking). OpenAI embeddings into pgvector.
- Provider adapter with per-task model assignment in settings (answer / light / embeddings). OpenAI-compatible adapter first; an Anthropic adapter and a local Ollama endpoint (laptop over Tailscale) are later options behind the same interface.
- Cost bounding, decided 2026-09-03:
  - Two caps. OpenAI-side hard monthly budget **$30** with an email alert at $20 (the backstop). App-side cap **$25/month** in settings, so the app always refuses first and you learn about it in the app, not from a provider error.
  - Ledger: every call records task, model, input/output/cached tokens and cost (from a price table in code) in `ai_usage`. Pre-flight estimate from the prompt size; a call that would cross the cap is refused before it is sent.
  - In-app signalling: a persistent banner on every AI surface at 80% ("$20 of $25 used this month") and at 100% ("Monthly AI budget reached. Resets 1 Oct. Raise it in Settings."); chat input, Ask, and Discovery are disabled with that message rather than failing silently. Settings shows month-to-date spend, per-task breakdown, and a per-day sparkline.
  - Provider errors: a 429 with `insufficient_quota` (OpenAI's own budget hit) sets a `provider_blocked` flag with the message and time; the same banner shows "OpenAI is refusing requests: budget exceeded on OpenAI's side" with a Retry button, and the flag clears automatically on the 1st. A 429 `rate_limit_exceeded` is transient: SDK retries with backoff, then a toast "Rate limited, try again in a minute", no lockout. Other 4xx/5xx show the error inline on the message.
- Surfaces: **Chat tab** (saved threads per project, streaming, citations to documents/notes/sources), **Ask slide-over** from anywhere including "Ask about this document" (the mock's AskPanel), **Source Discovery**: from a query, search the web + arXiv + Semantic Scholar, rank, show candidates with reasons, add to project in one click (NotebookLM-style).
- Retrieval: chunked embeddings over documents (PDF text), notes, annotations, sources; pgvector + Postgres full-text, hybrid ranking.

### Hosting, auth, ops
- **New Raspberry Pi** at 10.0.0.36 (Trixie, headless). Docker Compose: `app` (Next.js), `db` (`pgvector/pgvector:pg17`), `runner` (GitHub Actions self-hosted runner), `cloudflared`, `backup` (cron). Volumes: `pgdata`, `files` (PDFs, artifacts).
- Public via **Cloudflare Tunnel** (`quire-pi`, token read from the CLI with the account's origin cert) on the existing zone `ezragubbay.com` → **quire.ezragubbay.com**. Login via **NextAuth (Auth.js v5) with a GitHub OAuth app**, restricted to one GitHub login; JWT sessions, no adapter. Cloudflare Access was dropped on 2026-09-03 because enabling it asked for a payment method. `/api/*` also accepts `Authorization: Bearer $QUIRE_API_KEY` for the Python client and CI checks.
- **CI/CD**: GitHub Actions. On PR/push: lint, typecheck, unit tests, Playwright e2e against a Postgres service, build. On `main`: build multi-arch image (arm64) → GHCR → deploy job on the Pi's self-hosted runner: pull, migrate, `compose up`, health check, rollback on failure.
- **Backups**: nightly `pg_dump` + `rclone sync` of `files` to Backblaze B2 (10GB free); restore script; weekly restore test in CI is out of scope.
- Free everywhere except OpenAI usage.

### Stack
- **Next.js 16** (App Router, route handlers, Turbopack, `proxy.ts` for auth), React 19, TypeScript. `@ezragubbay/folio` + `@ezragubbay/core` from **npm** (published 2026-09-04; Turbopack cannot resolve symlinks outside the repo, so `pnpm link` is not an option for local iteration, bump versions instead).
- Drizzle ORM + drizzle-kit migrations, Postgres 17 + pgvector. Zod for validation. Serwist for the PWA. `pdfjs-dist` for the viewer. CodeMirror 6 (`@codemirror/lang-markdown`). `d3-force` for graph layout. `unified`/`remark` + `remark-math` + wiki-link plugin for Markdown rendering. OpenAI SDK. Vitest, Testing Library, Playwright. Biome for lint/format.
- Repo: `ezragubbay/quire`, public, MIT. Layout:
  - `apps/web` — Next.js app
  - `packages/shared` — types, zod schemas, annotation anchoring utils
  - `clients/python` — `quire` experiment client
  - `infra/` — `compose.yml`, `Dockerfile`, `pi/bootstrap.sh`, `cloudflared/`, `backup/`
  - `.github/workflows/ci.yml`, `deploy.yml`
  - `docs/spec.md` (this document, maintained), `docs/adr/`

### Platforms and feature flags (decided 2026-09-04)
- Three device classes: **phone**, **tablet**, **desktop**. Tablet has the same features as desktop (iPad = laptop) until a feature is Pencil- or touch-specific. Detection: width ≤ 700px or a mobile UA → phone; touch points > 1 → tablet (iPadOS reports a Mac UA); else desktop. The client writes `quire.platform` as a cookie so server rendering agrees; Settings has a "preview as" override.
- Flags live in code: `apps/web/src/lib/features.ts`, a feature × platform matrix with levels on / lite / off; `QUIRE_FEATURES_JSON` is an emergency env override. A meta flag `settings.flags` shows a read-only table of the matrix in Settings on desktop.
- Rule for new features: phone is for capture and lookup; a feature is phone-off if it needs a wide canvas, precise pointer selection, or long-form typing; lite when its read half is valuable on a phone.
- Phone today: on = overview, documents list and import, notes reading, sources, chat, ask, discover; lite = PDF viewer (1.5x pixel-ratio cap, canvases released outside a one-page window, no selection annotations), note editing (plain textarea), experiments (read-only), settings (theme + spend); off = text-selection annotations, Markdown document editor, graph, ⌘K palette.
- Theme: a stored default (light / dark / system) in Settings applies on every device; the app-bar toggle is a per-device override cleared by choosing in Settings.
- Debug mode (2026-09-05): Settings → Debug toggles a stored flag; when on, every client logs window errors, unhandled rejections, console warnings and viewer render events (page, canvas size, live canvas MB) to `client_logs` via `POST /api/client-log`, viewable in Settings or `GET /api/client-log`. First catch: the iPhone "crash" was not memory but pdf.js 5.7 calling `Map.prototype.getOrInsertComputed`, missing in iOS 18 Safari. Browsers now load the pdf.js legacy build and worker with an upsert polyfill prepended (`lib/pdf-polyfill.ts`, `scripts/copy-pdf-worker.mjs`). Open: a React hydration warning (#418) seen once on the phone after a reload; non-fatal, watch the log.
- Phone reader (2026-09-05): the document route is immersive on phones (`reader.immersive`): no app bar; the viewer fills the screen; a bottom bar (back, title, page `3 / 8` or `%` for Markdown, annotations, more) shows on a tap and hides on scroll; annotations and the more-menu (status, Ask, text size, delete) are bottom sheets (`components/ui/bottom-sheet`). Zoom (`reader.zoom`): pinch and double-tap on phones, −/fit/+ buttons on desktop and iPad, relative to fit-width (`use-pinch.ts`); Markdown scales its text size instead. Documents tab on phones: a one-line folder bar opens a folder sheet instead of the rail.
- Apple Pencil (assessed, not built): Safari gives pen pointer events with pressure and tilt at up to 240 Hz and hover on M2+ iPads, but no coalesced or predicted events; good enough for margin sketches and pen highlighting, not a Notability replacement. Planned as a tablet-only `ink` feature: SVG stroke layer per page, strokes stored in scale-1 page coordinates, prototype latency on the real iPad first.

## Data model (Postgres, Drizzle)

`projects`, `folders`(project, parent, name, order), `documents`(project, folder, kind pdf|markdown, title, authors[], year, abstract, source_url, arxiv_id, doi, file_path, markdown_body, reading_status, last_page, progress, tags[]), `document_pages`(document, page_no, text) for PDF text, `annotations`(project, document nullable for unanchored, type note|insight|idea|question|todo, body, quote, anchor jsonb, page_no, orphaned bool), `notes`(project, title/slug, body), `links`(from_kind, from_id, to_kind, to_id, kind wiki|mention|belongs|suggested) as the single edge table for the graph and backlinks, `sources`(project, type, url, title, description, tags[], snapshot_text), `experiments`, `runs`(experiment, name, status, params jsonb, started, finished), `run_metrics`(run, key, step, value, ts), `run_artifacts`, `run_logs`, `observations`(run, body), `chat_threads`, `chat_messages`(role, content, citations jsonb, model, usage), `embeddings`(owner_kind, owner_id, chunk_no, text, vector(1536)), `ai_usage`(ts, task, model, in_tokens, out_tokens, cost_usd), `macros`(project nullable, name, definition), `settings` (singleton: models per task, monthly cap, macros global).

## Progress (updated 2026-09-03)

- Phase 0 done: live at quire.ezragubbay.com, GitHub login, CI + deploy via the Pi runner, nightly B2 backups.
- Phase 1 done: projects, folders, PDF upload/URL/arXiv/DOI import, pdf.js viewer with reading position, Markdown documents with editor, annotations (five types, panel, popover, filters, search) on PDFs and Markdown, Overview.
- Phase 2 done: notes with read/edit modes, wiki links and backlinks, dangling-link creation, promote to document, graph (d3-force + Folio NoteGraph), math macros (global + project) with settings pages, ⌘K palette.
- Phase 3 done: sources with page snapshots, experiments/runs with metrics, logs, artifacts, observations, REST API, `quire-client` on PyPI (publish pending).
- Phase 4 done: OpenAI provider adapter (any OpenAI-compatible base URL), embeddings into pgvector on every save, cited streaming chat, Ask slide-over and Ask-about-document, discovery over arXiv + Semantic Scholar with light-model ranking, spend ledger with monthly cap, banners, provider-block handling, settings with prices and connection test. `AI_MOCK=1` runs everything without a key (used in CI).
- Phase 5 next: PWA manifest and service worker, iPad layout pass.

## Phases (each ends deployed and usable)

### Phase 0 — Foundations (first)
1. `git init` here, rewrite README for Quire, create `ezragubbay/quire` with `gh`, push.
2. Scaffold monorepo (pnpm workspaces, Next.js app, shared package), Folio provider + app shell (AppBar with the six tabs, project switcher, theme toggle), Biome, Vitest, Playwright, Dockerfile (arm64), `compose.yml`.
3. Pi bootstrap (`infra/pi/bootstrap.sh`, run over `ssh researchpi`): Docker + compose plugin, `cloudflared`, GitHub runner user, `/srv/quire` layout, unattended-upgrades, `ufw`. SSH alias `researchpi` in `~/.ssh/config`.
4. Cloudflare: new tunnel for the new Pi (remote-managed token) with `quire.ezragubbay.com → app:3000`; Access application + policy (your email); service token for API clients. Manual steps in the Zero Trust dashboard are listed in `infra/cloudflared/README.md`.
5. GitHub Actions `ci.yml` + `deploy.yml`; self-hosted runner registered on the Pi; GHCR image; first deploy of the hello shell; nightly backup container to B2.

### Phase 1 — Projects and Documents
Projects CRUD + home + switcher. Documents tab: folder tree, tags, status filter; Add-document dialog (upload, URL, arXiv, DOI) with metadata extraction; download and text extraction (`pdfjs` text per page) run synchronously inside the request (a few seconds for a typical paper). A job queue (pg-boss) is deferred to Phase 4, where embeddings need it; PDF viewer with text layer; Markdown document render + separate edit page; annotations panel (types, quick-add, anchored + general, hover/scroll-to, expand, filters, fuzzy search); Overview tab (counts, recent documents, open questions/todos from annotations).

### Phase 2 — Notes, math, graph
Notes tab: list + search, Read/Edit modes, CodeMirror editor with wiki-link and macro autocomplete, live preview; wiki-link resolution and backlinks via `links`; macros (global + project) in settings; graph page + overview widget with d3-force + Folio `NoteGraph`; promote note → document; ⌘K command palette over everything.

### Phase 3 — Sources and Experiments
Sources tab (CRUD, snapshot fetch, tags); Experiments tab (experiments, runs, metrics charts, artifacts upload, logs, observations); REST API for runs; Python client published to PyPI as `quire-client`; run ↔ document/note links.

### Phase 4 — AI
Provider adapter + settings (models per task, cap, spend view); embedding pipeline (job on create/update); Chat tab with threads, streaming, citations; Ask slide-over + Ask-about-this-document; Source Discovery (web + arXiv + Semantic Scholar) with one-click add; suggested graph edges.

### Phase 5 — PWA and iPad
Serwist service worker, manifest, offline app shell, install prompt; responsive pass for iPad widths (viewer + panel behaviour); decide the reduced mobile feature set then.

## Coordination with the design repo (`~/.design`, other session)
- Change `HIGHLIGHT_KINDS` from claim/method/result/question/todo to **note/insight/idea/question/todo** (tokens `--folio-hl-*`, `HighlightChip`, `AnnotationCard`, `NoteGraph` legend). Until then Quire aliases colours via CSS overrides.
- `NoteGraph` `NodeType` should become `document | note | source | idea`; add `insight` hue.
- New Folio components Quire will need (build in the design repo, not the app, so Claude Design keeps them): `AnnotationPanel` chrome (toggle, filter buttons, search), `AnnotationComposer` (quick-add card with type dropdown), `FileTree` row styles, `Tabs`, `Dialog`, `Field/Input/Select`, `Toast`, `EmptyState`, `CommandPalette`, `SlideOver`, `MetricSparkline`. Quire consumes whatever exists and falls back to local components styled with `--eg-*`/`--folio-*` variables.
- Publish `@ezragubbay/core` and `@ezragubbay/folio` to npm so CI can build.
- Brief for Claude Design when the screens are refined: the screen list in the earlier message (Notes editor, full graph, Sources, Experiments + run detail, Chat slide-over, project switcher, command palette, annotation popover, add-document flow, empty states, iPad width), light and dark each.

## Verification
- **Unit**: Vitest on shared utils (anchoring, wiki-link parsing, macro expansion, cost accounting), route handlers with a test Postgres.
- **E2E**: Playwright on CI: create project → add arXiv paper → open → select text → annotate → change type → filter → search; create note with `[[link]]` → graph shows edge; create experiment run via API → appears in UI.
- **Deploy**: `deploy.yml` health-checks `https://quire.ezragubbay.com/api/health` through Access with the service token; rollback to previous tag on failure.
- **Manual after each phase**: open on iPad as PWA; dark mode; a real PDF with equations; backup restore dry-run once in Phase 0.

## Deferred / out of scope
Mobile-specific feature subset; reflowed-HTML paper reader; Zotero import; multi-user; cross-project links; Anthropic/local model adapters (interface only); rename to Lemma.
