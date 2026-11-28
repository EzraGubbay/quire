# Architecture

Quire's backend is one Next.js process (`apps/web`) that serves the web app, the Electron desktop app, the Android app, Claude via MCP, and a small Python client. This page maps the target layout of that backend to code. The decisions behind it are recorded in [`adr/0001-unified-backend.md`](adr/0001-unified-backend.md).

This is the **target** layout. As of this change, `apps/web/src/core/` holds only the fence (see its [README](../apps/web/src/core/README.md)). The pieces below land story by story under epic #98.

## Layers

```
Clients:  Web (RSC + Actions) | Electron (web + Lemida engine) | Android | Claude via MCP | Python
              |                      |                         |            |              |
L3 Transports (thin: authenticate -> call core -> map errors to own envelope -> revalidate/after)
   app/actions/*  app/api/projects/**  app/api/lemida/**  app/api/mobile/v1/**  app/mcp, app/research/mcp
              |
Identity  core/identity/{caller,login,assert}.ts   (pure classify; device tokens stay lib/mobile/auth.ts)
              |
L1 Core (fenced, no Next)  apps/web/src/core/**
   projects/resolve   catalog/{course-files,semester}   notes/context   sessions/{naming,attach,integrity,repair}
   content/page-text  extraction/{store,pptx/*,pdf-v2,job}  intake/{limits,title,dedupe,ingest}
   chat/{document-thread,idempotency}  changes/
              |
L0 Platform  db/ (Drizzle)  lib/files.ts  core/http/file-response.ts  core/jobs/{queue,worker}  core/pdf/open.ts  settings table
Contract     docs/api/mobile-v1.openapi.yaml + lib/mobile/schema.ts + docs/api/fixtures/mobile-v1/{*.json,INDEX.json} -> Android drift check
```

## Pieces

Paths are relative to `apps/web/src/`. "Absorbs" names existing code that moves behind a re-export shim.

| Piece | Responsibility | Code (absorbs) | Lands in |
|---|---|---|---|
| File responder | Range, ETag, If-Range, Content-Disposition and safe names for every byte route | `core/http/file-response.ts` (`lib/mobile/range.ts`); `core/text/names.ts` (`safeName`, `safeTitle`) | S1.1, S1.2 |
| Jobs | Durable, leased, deduped background work | `core/jobs/*` and table `jobs`, started in `instrumentation.ts` | S1.3 |
| Caller | Who is calling and what it may do | `core/identity/caller.ts` (`proxy.ts`, `lib/api-key.ts`); `login.ts` (`requireSession`, `currentWebLogin`, pairing route) | S2.1, S2.2 |
| Project resolution | Slug or UUID, scoped by kind | `core/projects/resolve.ts` (`lib/mcp/scope.ts`) | S3.1 |
| Catalog | One course-file DTO, labels, semester key, order | `core/catalog/course-files.ts` (`lib/mcp/courses.ts`) | S3.2, S8.2 |
| Notes context | Session to note mapping, note DTO | `core/notes/context.ts` (mobile notes `context.ts`) | S3.3 |
| Sessions | Name parsing, attach checks, anomaly report, repair | `core/sessions/*` (`lib/sessions.ts`, `lib/lemida/import.ts`) | E4 |
| Extraction | Per-page text and flags, versioned | `core/extraction/*` and table `page_extractions`; `lib/pdf-layout.ts` | E5 |
| Content | What MCP `get_file` serves | `core/content/page-text.ts` (`lib/mcp/content.ts`) | S5.9 |
| Intake | One `ingest()`: validate, hash, dedupe, store, extract, attach, index | `core/intake/*` (`findDuplicatePdf`, Lemida `backfillHashes`, upload limits, title rules) | E6 |
| Chat | Get-or-create document thread, idempotent messages | `core/chat/*`, `chat_messages.client_key`; `lib/chat-turn.ts` | E7 |
| Changes | Change feed for offline sync | table `change_log` and `GET /api/mobile/v1/changes` | S8.3 |

## Rules

- **The fence.** `src/core/**` imports no Next, React, `@/app`, `@/components` or `@/auth`, and calls no Next request or response function. A vitest guard enforces it.
- **Shims.** Moved code leaves a one-line re-export at its old path; callers switch only in files a story already edits.
- **Server Action IDs.** `'use server'` exports never move or get renamed.
- **Mobile contract.** Additive only: new fields and endpoints, no new values on existing enums.

Details are in the [core README](../apps/web/src/core/README.md).
