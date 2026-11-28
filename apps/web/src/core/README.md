# Core

`src/core/` holds the backend's business rules, shared by every transport (web actions, route handlers, the mobile API, MCP, Lemida). It is the nucleus of a future `quire-backend`. See [ADR 0001](../../../../docs/adr/0001-unified-backend.md) and the [architecture overview](../../../../docs/architecture.md).

## What belongs here

- Business rules used by more than one transport: resolving courses and projects, the file catalog and labels, notes context, sessions (naming, attach, integrity, repair), extraction, content, intake, chat rules, the change feed.
- Framework-free platform seams: `http/file-response`, `jobs`, `pdf/open`, `text/names`.

## What does not

- Transports: `app/actions`, `app/api/**`, MCP route handlers.
- UI.
- Auth and session lookup. Device-token auth stays in `lib/mobile/auth.ts`.
- Web-only domains: tests, homework, mindmap, experiments.

## The fence

`architecture.guard.test.ts` enforces it, tests included:

- No imports of `next` or `next/*`, `next-auth`, `react` or `react-dom`, `@/app/*`, `@/components/*` or `@/auth`. This covers `import type`, re-exports, dynamic imports, `require`, and relative paths that resolve to those.
- No calls to `revalidatePath`, `revalidateTag`, `updateTag`, `after`, `headers`, `cookies`, `notFound`, `redirect` or `permanentRedirect`.
- No JSX.
- No `'use client'` or `'use server'` directives.

Allowed: `@/db/*`, Drizzle, `node:*`, `zod`, `@quire/shared`, Web-standard `Request`, `Response`, `Headers` and `URL`, and `@/lib/*` **only if that module is itself Next-free**. The guard checks direct imports only, so that last rule is on you and the reviewer.

## Inject, don't import

Framework effects come in as deps (`revalidate`, `defer`), following `RunDeps` and `runUploadJob(job, deps)` in `lib/mobile/uploads.ts`.

- Core throws or returns domain errors. Each transport maps them to its own envelope: `notFound()` in pages, the mobile error JSON, the MCP tool error.
- Core takes a project `kind` scope, never a caller identity.
- The data is single-tenant.

## Strangler and shim rule

- Moving code into core leaves a one-line re-export shim at the old path (`export { x } from '@/core/…';`).
- Callers switch to `@/core/…` only in files the story already edits.
- No bulk regex, sed or codemod edits without owner approval.
- A shim is removed only by a story that removes its last caller.

## Server Action ID stability

- Never move or rename a `'use server'` export in `app/actions/*.ts`; open tabs hold action IDs across deploys.
- The action stays where it is, keeps its name, keeps `requireSession()` as its first statement, then calls core, then revalidates.
- Core never contains `'use server'`. This guard and `app/actions/require-session.guard.test.ts` both enforce it.

## Conflict rule

When two copies of a rule disagree, the desktop/web behavior wins. Transport-only limits (such as MCP's inline-argument cap) are flagged in the PR, not changed.

## Tests

Unit tests sit beside the code (`*.test.ts`). DB tests are named `*.db.integration.test.ts` and run with `QUIRE_DB_TESTS=1`.
