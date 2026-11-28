# ADR 0001: Unified backend: a modular monolith with a fenced core

Status: Accepted (2026-11-28, owner).
Issue: #52 · Epic: #98

## Context

Quire's backend is one Next.js 16 process on a self-hosted Raspberry Pi (`apps/web`). Five kinds of client reach it, each through its own path:

| Client | Path | Credential |
|---|---|---|
| Web | RSC pages, Server Actions, `/api/projects/**` | GitHub session |
| Electron desktop | Loads the web URL and calls `/api/lemida/*` | Shared session cookie |
| Android | `/api/mobile/v1` | Per-device token |
| Claude via MCP | `/mcp` (courses), `/research/mcp` (research) | Master key, research key |
| Python client, legacy lemida-agent | `/api/projects/*/runs`, `/api/lemida/*` | Master key |

Issue #52 flagged this design as iffy. Exploration confirmed concrete problems:

- **Duplication.** About 5 course resolvers; 3 file-byte servers, of which only the mobile one supports Range and ETag; 2 serializers for a course file; 2 sources of page text; about 7 ingestion paths with 3 dedupe strategies.
- **Inconsistent behavior.** The mobile notes and threads routes reject UUIDs, although the spec says slug or UUID, and they also resolve research projects.
- **Next APIs inside `lib/`.** `notFound`, `after`, `revalidatePath` and `headers` are called from domain code, for example `lib/lemida/files.ts`, `lib/mcp/upload.ts` and `lib/projects.ts`.
- **Identity resolved three ways.** `requireSession`, `currentWebLogin`, and inline in the pairing route.
- **Proxy-only routes.** The `/api/projects/**` and `/api/lemida/**` handlers rely entirely on `proxy.ts`.
- **Android duplicates about a dozen server rules.** Semester parsing, upload limits and routing, a port of the math-delimiter fix, get-or-create of a document's chat thread, file ordering, hand-written DTOs, chat retry without an idempotency key, and no change feed for offline sync.

## Decision

1. **Separate repos per client; unify the backend now.** quire-android and quire-ios are already separate repos. Splitting this repo into `quire-backend` and `quire-desktop` is supported in principle but deferred. What happens now is unifying the backend, so that no client, Android above all, holds duplicated backend or server rules.
   - Deduplication is the main goal.
   - **Conflict rule:** when duplicated implementations disagree, the desktop/web version wins, because desktop loads the web app and so web behavior is canonical.
   - **Transport-only limits** (for example MCP's 512 KB inline tool-argument cap) are not duplicates. They are flagged in the PR for the owner, not changed silently.
2. **Core lives in `apps/web/src/core/**`, fenced by a vitest guard.** Core holds business rules with no web-framework code. It is the nucleus of a future `quire-backend`; the fence makes that split a folder move rather than a rewrite. There is no workspace package now: the Drizzle schema lives in `apps/web` and the Dockerfile copies packages by hand, so a package would add risk with no consumer.
3. **Strangler moves.** Moved code leaves a one-line re-export shim at the old path, and callers switch only in files a story already edits. No bulk regex, sed or codemod edits without owner approval.
4. **Server Action IDs stay stable.** Never move or rename a `'use server'` export, because open tabs hold action IDs across deploys. Actions become thin adapters: `requireSession()`, then core, then `revalidatePath`.
5. **Identity at the edge.** One pure classifier (`core/identity/caller.ts`) serves the proxy, `requireSession` and route handlers. Core takes a project `kind` scope, never a caller. The data stays **single-tenant** (see [`docs/spec.md`](../spec.md), "Single user"); multi-user is out of scope. The research/course hard decoupling is preserved.
6. **Jobs, narrowly.** Keep `after()` for existing short work and raise `stop_grace_period` to 30 s so it drains on deploy. Add one DB `jobs` table with a leased in-process worker, only for long or resumable work (extraction, backfills, pruning).
7. **The mobile contract is additive only.** New fields and endpoints are fine; new values on existing enums are not, because Android has no fallback for unknown values. The source of truth is OpenAPI, the zod twins and generated fixtures, plus an `INDEX.json` of fixture hashes checked by Android CI. No Kotlin codegen and no v2.
8. **Migrations are expand-only, one open at a time.** Contract migrations (unique index, NOT NULL, DROP) are separate, allowlisted and owner-gated. A pre-deploy `pg_dump` runs whenever `apps/web/drizzle/**` changes, because an image rollback never rolls back the schema.
9. **Extraction v2 runs in shadow first.** New text goes to a separate `page_extractions` table. MCP `get_file` flips first, behind a setting that can be toggled back. `document_pages` (embeddings, search, chat) flips later, with owner approval, because re-embedding costs AI budget.
10. **Public repo.** All fixtures are built synthetically at test time. Real decks are checked only in prod, on an in-app shadow-diff page.
11. **Prod session data is fixed through an in-app repair screen** with preview and undo, run by the owner. There are no manual DB writes. The unique constraint ships only after the repair shows 0 duplicates.
12. **Lemida decks with no parseable number stay unattached** and are listed in the integrity report. They are never numbered by import order.

The full sequencing lives in the approved refactor plan (epic #98). The layout is described in [`docs/architecture.md`](../architecture.md).

## Consequences

Positive:

- Every client gets one answer from one implementation.
- Android can delete its duplicated rules story by story.
- A later `quire-backend` split is a folder move.

Negative:

- Temporary shims and two code paths exist while strangling.
- Each move must keep goldens and the mobile fixtures byte-stable.
- The fence checks direct imports only. A core file that imports an `@/lib` module which itself uses Next is not caught; core must import only Next-free `@/lib` modules, and reviewers check this by hand. A transitive check is a possible follow-up.
- More PRs, each small.

## Rejected options

- **Separate mobile backend service now.** It re-duplicates the domain layer (the very problem #52 names), adds a second deploy unit and auth surface on a single Pi, and the fence already makes a later extraction cheap.
- **`packages/core` workspace package now.** The schema lives in `apps/web`, the Dockerfile copies packages by hand, and there is no second consumer.
- **Mobile API v2.** Android ships with no fallback for unknown enum values. Additive v1 changes keep the app working with no forced upgrade.
- **Kotlin codegen from OpenAPI.** It churns hand-tuned DTOs. The drift check against fixture hashes catches the same breakage more cheaply.
- **tRPC or GraphQL**, and **replacing `mcp-handler`.** Neither addresses the duplication, and both add migration cost across every client.

## Out of scope

- A v2 mobile API.
- tRPC or GraphQL.
- Replacing `mcp-handler`.
- Multi-user support.
- Moving web-only domains (tests, homework, mindmap, experiments) into core.
- Kotlin codegen.
- Streaming uploads (#18).
- Deleting the legacy extractor.
