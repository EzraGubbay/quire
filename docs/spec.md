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
- Phone shell (2026-09-05, pass 2): phones get a one-row top bar (`components/phone-bar.tsx`) and a bottom tab bar (`components/tab-bar.tsx`: Overview, Documents, Notes, Chat, More sheet with Sources, Experiments, Discover, project settings) instead of the folio app bar; Notes and Chat are list page → detail page with a back link; the overview swaps the graph card for Recent notes where `graph` is off and shows real recent runs; inputs are 16px on phones (no iOS focus zoom), chips and rows are finger-sized, safe areas are padded top and bottom.
- Incident 2026-09-05: the Pi's Wi-Fi went dead from about 14:40 to 20:47 BST (cloudflared: QUIC timeouts, "no free edge addresses", DNS failures); a reboot brought it back. Kernel had logged `brcmfmac: power save enabled`. Fix on the Pi: Wi-Fi power save disabled, `net-watchdog.timer` bounces the Wi-Fi after three failed reachability checks, journal made persistent (`infra/pi/install-net-watchdog.sh`). Ethernet would be more robust than Wi-Fi if a cable can reach the Pi.
- Chat scope and resilience (2026-09-11): Ask opens the most recent chat in scope (the document's, or the project's) instead of creating one; a chat is created on the first question or via New chat, and the panel has a switcher for that document's chats. The Documents page has a per-row chat button to `/chat?doc=<id>`, where the rail lists only that document's chats and new ones are scoped to it. In any composer `doc.` or `[[` opens a document picker; the pick is written `[[Title]]`, which the server resolves to the document and retrieves from directly. OpenAI's transient 500s are retried before the first token, fall back to the light model, keep partial text if cut off mid-stream, and show a Retry button. MathJax is self-hosted (`/mathjax/`) and chat answers typeset once complete.
- Apple Pencil (assessed, not built): Safari gives pen pointer events with pressure and tilt at up to 240 Hz and hover on M2+ iPads, but no coalesced or predicted events; good enough for margin sketches and pen highlighting, not a Notability replacement. Planned as a tablet-only `ink` feature: SVG stroke layer per page, strokes stored in scale-1 page coordinates, prototype latency on the real iPad first.

### Courses (grill session 2026-10-19 to 2026-10-21)
Quire gains a second side for university courses. This supersedes "course platform out of scope" in Context.

- **Shape**: one Next.js app, two sides. A `Courses | Research` segmented switch sits in the app bar next to the mark (on phones, at the top of the More sheet). Courses home `/courses`, course pages `/c/<slug>/…`; research home `/research`, project pages stay `/p/<slug>/…`. `/` redirects to the side last used on that device. Login, viewer, annotations, notes, chat, AI budget, macros and settings are shared.
- **Storage**: a course is a `projects` row with `kind = 'course'` (new column, existing rows `research`), so every project-scoped table works unchanged. Course-only data gets its own tables keyed by `project_id`.
- **+ Course** dialog: name, type, course code, semester (e.g. 2027 A), description, links (Moodle, recordings, course site). All editable in course settings.
- **Type**: Practical / Theoretical / Mixed. It sets defaults only and gates nothing: the synthesis prompt addendum (code-first vs. proof-first) and which note templates show first.
- **Home and archive** (one shared component, also used for the research Projects home): an Active card, then an "Archived (n)" section, collapsed by default, with its open state remembered per device. Active rows have an Archive icon button, archived rows an ArchiveRestore button. Archiving is instant, with no confirm, and shows an "Archived <name> · Undo" toast. Archived items leave the app-bar switcher, ⌘K and the "due" widgets, but still open by URL and stay fully editable. Archiving is purely a UI filter. The Courses home also shows "Due this week" across active courses.
- **Course tabs**: Overview, Lectures, Recitations, Homework, Tests, Documents, Notes, Chat. No Experiments, Sources or Discover (research only).
- **Overview**: due next, latest lecture, To re-read list, open questions/todos from annotations, recent notes, quick links.

#### Lectures and Recitations
- Two tabs with the same shape: number, title, date, and attached files. Recitations are not paired with lectures; any relation is semantic, by title.
- **Adding**: drop one or many decks/PDFs. Each file becomes an entry with number and title parsed from the filename (`Lecture 2 - SIMD - A 2027.pptx` → #2 "SIMD") and the date defaulting to today, all editable. `+ Lecture` / `+ Recitation` creates an empty one.
- **PPTX**: the original is kept for "Download / Open .pptx", which is how animated decks get presented (PowerPoint/Keynote; no in-browser animation playback). A Gotenberg (headless LibreOffice) container on the Pi converts to PDF on upload, with Carlito, Liberation and Culmus (David) fonts installed. "Replace rendering" swaps in a PowerPoint-exported PDF, which then wins. The PDF is what is viewed, annotated, text-extracted and rendered to slide images.
- **Lecture page**: slides in the viewer on the left, that lecture's raw note in the editor on the right (created on first keystroke, linked to the lecture, filed under Raw). A toggle swaps the right pane between note and annotations. `[[Lecture 2#14]]` cites slide 14.
- Slides are Hebrew (RTL); notes are English. The viewer, editor and chat handle mixed-direction text per paragraph; math and code stay LTR.

#### Notes in courses
- Same editor as research (CodeMirror, Read/Edit, wiki links, macro autocomplete, live preview). Notes gain folders (shared tree and drag-to-move with Documents). Every course starts with non-deletable **Raw** and **Synthesized** folders; user folders and subfolders are allowed.
- New renderers, available in every project of either kind: syntax highlighting (C/C++/CUDA/Python/asm) in notes, synthesized notes and chat; a read-only code viewer for source files in Documents, annotatable by line; callouts for Definition / Theorem / Lemma / Claim / Proof / Example / Remark (numbered per note, collapsible proofs, `[[Note#Theorem 3]]` links); ` ```algorithm ` pseudocode blocks rendered like LaTeX algorithmic; Mermaid diagrams (TikZ via TikZJax later if needed).
- **Term labels** (decided 2026-10-21): the lightweight way to mark a Definition, Claim or Theorem in a note is a bold label at the start of a paragraph, `**Theorem:**`, inserted by a toolbar button or a keyboard shortcut (one per kind: ⌥D / ⌥C / ⌥T, with ⌃⌥ as an alternate). The label renders bold with a tinted highlight behind it, never recolouring the text: theorem purple, definition a medium blue (between cyan and navy), claim dark orange, each with a dark-mode variant. Other labels (Lemma, Proof, Corollary, Example, Remark) get the same treatment with neutral hues. The synthesis prompt uses these labels rather than callouts.
- **Synthesize** (button on a raw note): asks only for a title, shows a cost estimate, then creates a note in Synthesized at once with a greyed title and a loading shimmer while the model runs in the background (`after()`). It survives navigation. Failure shows the error and Retry, keeping the title.
  - Prompt: an adapted copy of the `lecture-note-synthesis` skill kept in the repo (`lib/ai/prompts/`). Steps 1 (ask about splitting), 2 (conversation context) and 4 (write files) are removed. It adds: one-shot, no follow-up, not a dialogue; return only the Markdown body of one note, with no H1, no preamble or sign-off, and no wrapping code fence. Also added: use the course's macros (sent in the prompt), the callout and algorithm syntax above, English with key Hebrew terms in parentheses on first use, and the type addendum.
  - Input: the raw note, course name and description, and the linked lecture's/recitation's slides as images plus their numbered text, so `*(See slide 14)*` resolves.
  - Model: new `synthesis` slot in AI settings, default `gpt-5.6-terra` (the middle of Sol > Terra > Luna). Logged in `ai_usage` and subject to the cap.
  - Re-synthesizing creates a new note; the previous one gets an "(older)" marker and is never overwritten. Synthesized notes can also be written by hand, with an optional "Synthesized from…" picker. Either way, a `synthesized` link records the relation (backlinks both ways, graph edge).

#### Homework
- Track and store only; solutions are written elsewhere (LaTeX/LyX/Overleaf, code repos). Assignments are created manually with `+ Assignment`: number, title, due date/time, problem sheet (annotatable document).
- Per-question checklist (Q1, Q2a…): status todo / working / done / stuck, plus working notes (Markdown + math). Progress = done / total. Assignment status: not started / in progress / submitted / graded.
- Submission: files or a repo link. Grade & feedback: score / max, the returned PDF (annotatable), and "what I lost points on", which feeds test generation.
- "Ask about this question": a chat scoped to the sheet and course material, in hint mode by default (hints, pointers to lectures and definitions, checking your reasoning). A per-chat "Full solution" toggle is off by default and labelled.
- Due dates live in the app only (Homework tab sorted by due date, overdue/soon badges, Overview, Courses home). No external calendar or task sync.

#### Tests and re-reading
- **Tests** tab with two generators, both triggered manually:
  - **Weekly test**: pick the lectures/recitations to cover. Recall-oriented and allowed to be dry; not exam-like. Needs no practice exams. Model: Terra.
  - **Tri-weekly test**: all material to date, exam style and difficulty, heavily inspired by the practice exams without copying them. The button is disabled until the course has ≥ 5 practice exams ("3/5 practice exams"). A nudge appears once 3 weeks have passed since the last one. Model: Sol.
- **Practice Exams**: a non-deletable built-in folder in each course's Documents. Each exam has an optional year/term (e.g. 2024 A, Moed B) and an optional attached solution file, which is sent too for calibration when present. Every exam there counts toward the 5.
- Taking a test: it is generated as a PDF (math typeset) to take on paper or the iPad, with no AI grading. Afterwards the in-app page reveals each model answer, and you mark pass / partial / fail.
- **Re-reading** applies only to what failed. For each partial/fail, the model returns deep links to the specific note sections (scroll to and highlight the heading) and slide numbers, each with a one-line reason and the missed concept. These appear on the result page and as a tickable To re-read list on Overview. Missed concepts feed the next weekly test.

#### Phone (course side)
On: course list and archive, Overview, Homework list/status, Tests list and reveal/marking, Notes reading, Chat. Lite: lecture slides (viewer only), raw-note quick capture (textarea). Off: side-by-side lecture page, synthesis and test generation dialogs, folder drag-and-drop.

#### AI provider
Stay on OpenAI for everything for now. DeepSeek (`https://api.deepseek.com`, OpenAI-compatible; `deepseek-v4-pro`, and `deepseek-flash` = V4.1-Flash-1017, the one with image input) is a later option. It needs a separate embeddings provider first, because DeepSeek has no embeddings API.

## Data model (Postgres, Drizzle)

`projects`, `folders`(project, parent, name, order), `documents`(project, folder, kind pdf|markdown, title, authors[], year, abstract, source_url, arxiv_id, doi, file_path, markdown_body, reading_status, last_page, progress, tags[]), `document_pages`(document, page_no, text) for PDF text, `annotations`(project, document nullable for unanchored, type note|insight|idea|question|todo, body, quote, anchor jsonb, page_no, orphaned bool), `notes`(project, title/slug, body), `links`(from_kind, from_id, to_kind, to_id, kind wiki|mention|belongs|suggested) as the single edge table for the graph and backlinks, `sources`(project, type, url, title, description, tags[], snapshot_text), `experiments`, `runs`(experiment, name, status, params jsonb, started, finished), `run_metrics`(run, key, step, value, ts), `run_artifacts`, `run_logs`, `observations`(run, body), `chat_threads`, `chat_messages`(role, content, citations jsonb, model, usage), `embeddings`(owner_kind, owner_id, chunk_no, text, vector(1536)), `ai_usage`(ts, task, model, in_tokens, out_tokens, cost_usd), `macros`(project nullable, name, definition), `settings` (singleton: models per task, monthly cap, macros global).

Courses additions (2026-10-21): `projects.kind` research|course, `projects.meta` jsonb (type, code, semester, links); `notes.folder_id` (folders gain `scope` documents|notes and `builtin` raw|synthesized|practice_exams|null); `notes.status` ready|generating|failed and `notes.session_id`; `sessions`(project, kind lecture|recitation, number, title, date, sort) with `documents.session_id` and `documents.original_path` for the kept .pptx; `documents.exam_meta` jsonb (term, solution document) for Practice Exams; `assignments`(project, number, title, due_at, status, sheet document, submission files/repo URL, score, max_score, returned document, lost_points); `assignment_questions`(assignment, label, status, notes, order); `tests`(project, kind weekly|triweekly, covers session ids, pdf_path, created, marked_at); `test_questions`(test, n, body, model_answer, result pass|partial|fail|null, concept); `reread_items`(test_question, target kind/id, anchor heading or slide, reason, done); `link_kind` gains `synthesized`; AI settings gain `models.synthesis`, `models.testWeekly`, `models.testTriweekly`.

## Progress (updated 2026-10-21)

- Phase 6 (Courses) built 2026-10-21 on `feat/courses`: two-sided app (`/courses`, `/research`, `/c/<slug>`, `/p/<slug>`, switch in the app bar, `/` remembers the side), shared Active/Archived home with Undo toast, courses with type/code/semester/links, course tabs, lectures and recitations (drop decks, filename parsing, Gotenberg `.pptx`→PDF with "Replace rendering" and `.pptx` download, side-by-side raw note with autosave, slide citations), note folders with built-in Raw/Synthesized, term labels (buttons + ⌃⌥D/C/T), callouts, algorithm blocks, Mermaid, code highlighting, RTL per block, Synthesize (Terra, slide images, background with pending/failed states), homework (checklist, submissions, grade and feedback, hint-mode tutor chat), tests (weekly/tri-weekly to PDF via Gotenberg or a print view, self-marking, re-read list), phone gating. Verified with the Playwright suite (`courses.spec.ts`, `phone.spec.ts` course test) under `AI_MOCK=1` and by hand with the two PP decks.

## Progress (updated 2026-09-03)

- Phase 0 done: live at quire.ezragubbay.com, GitHub login, CI + deploy via the Pi runner, nightly B2 backups.
- Phase 1 done: projects, folders, PDF upload/URL/arXiv/DOI import, pdf.js viewer with reading position, Markdown documents with editor, annotations (five types, panel, popover, filters, search) on PDFs and Markdown, Overview.
- Phase 2 done: notes with read/edit modes, wiki links and backlinks, dangling-link creation, promote to document, graph (d3-force + Folio NoteGraph), math macros (global + project) with settings pages, ⌘K palette.
- 2026-09-06: annotation bodies support `[[wiki links]]` (autocomplete in the card, edges in `links`, linked annotations of any type join the graph, backlinks list them). Math in annotation bodies is still deferred (MathJax inside clamped cards).
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

### Phase 6 — Courses
1. `projects.kind`, `/courses` + `/research` homes, the switch, `+ Course`, the shared Active/Archived list with archive/unarchive + Undo for both sides; course tab set.
2. Note folders with Raw/Synthesized built-ins; callouts, code highlighting, algorithm blocks, Mermaid.
3. Lectures and Recitations: sessions, filename parsing, Gotenberg conversion + Replace rendering, side-by-side lecture page, slide citations.
4. Synthesize: prompt file, slide images, `synthesis` model slot, background generation with pending note UI.
5. Homework: assignments, question checklist, submissions, grades, hint-mode question chat.
6. Tests: Practice Exams folder, weekly and tri-weekly generation to PDF, reveal/marking, re-read list, feedback into the next weekly.
7. Phone pass for the course side.

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
