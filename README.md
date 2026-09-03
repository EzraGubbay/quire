# Quire

A personal research project manager. One workspace per research project: papers and your own write-ups in an annotatable viewer, Obsidian-style linked notes with a graph, a source catalogue, an experiment tracker, and an AI assistant over everything in the project.

Built on the [Folio](https://github.com/ezragubbay/design) research design register: warm paper, oxblood accent, Source Serif 4 / Source Sans 3 / IBM Plex Mono, light and dark, WCAG AA.

## What it does

- **Documents**: PDFs (upload, URL, arXiv, DOI) and Markdown documents you write, in one viewer with a pull-out annotations panel. Five annotation types: Note, Insight, Idea, Question, Todo. Highlight text to annotate, or add general notes.
- **Notes**: short linked Markdown pages with `[[wiki links]]`, backlinks, math macros, read/edit modes, and a graph of notes, documents, sources, and ideas.
- **Sources**: any non-paper reference, catalogued and linkable.
- **Experiments**: a tracker for runs, metrics, artifacts, and observations, fed by a small Python client from wherever your code runs.
- **AI**: chat over the project, ask about a document, and discover new sources. Cost-capped, provider-agnostic.

The full specification and decision log is in [`docs/spec.md`](docs/spec.md).

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js app (UI + API) |
| `packages/shared` | Types, schemas, anchoring utilities shared by app and clients |
| `clients/python` | `quire` experiment client |
| `infra/` | Dockerfile, Compose, Raspberry Pi bootstrap, Cloudflare Tunnel, backups |
| `.github/workflows` | CI (lint, typecheck, test, e2e, build) and deploy to the Pi |

## Running locally

```sh
pnpm install
docker compose -f infra/compose.dev.yml up -d   # Postgres 17 + pgvector
cp apps/web/.env.example apps/web/.env
pnpm db:migrate
pnpm dev
```

## Deployment

Self-hosted on a Raspberry Pi behind a Cloudflare Tunnel, with login by Cloudflare Access. Pushes to `main` build an arm64 image to GHCR and a self-hosted runner on the Pi deploys it. See [`infra/README.md`](infra/README.md).

## Licence

MIT.
