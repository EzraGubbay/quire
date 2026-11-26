# Quire MCP server

An [MCP](https://modelcontextprotocol.io) endpoint that lets a Claude client browse Quire and add Markdown to it (the read tools are read-only; the write tool is additive, never edits or deletes, and can be switched off):

- **`list_courses`** — every course (stable `slug`, name, code, semester, file count).
- **`list_course_files`** (`course`) — the course's files, each labeled `lecture` / `recitation` /
  `homework` / `exam` / `book` / `paper` / `other`, with a stable `fileId` and a `resourceUri`.
- **`get_file`** (`course`, `fileId`, `format?`) — the file's bytes. Small PDFs/markdown come back inline;
  files over `MCP_MAX_INLINE_BYTES` (default 10 MB) return a download URL instead.
- **`upload_markdown`** (`course`, `markdown`, `section?`, `title?`, `folder?`) — **writes**: creates a Markdown
  note (`section: "notes"`, default) or Markdown document (`"documents"`) in a course, optionally in an existing
  folder (name or id; folders are never created). Never edits or deletes. Same title + text again returns
  `status: "duplicate"` with the existing id; a *note* with an existing title but different text is an error
  (note titles are unique per course because `[[wiki links]]` resolve by title; the tool enforces this, the database does not, so two concurrent calls with the same title and different text could both succeed). A leading `# Title` line
  supplies the title when `title` is omitted and is stripped from the body. Max `MCP_UPLOAD_MAX_MARKDOWN_BYTES`
  (512 KB). Results are one JSON text item: `{status, section, course, noteId|fileId, title, folder, openUrl, next}`.
  Read tools carry `readOnlyHint: true`; the write tool is `readOnlyHint: false, destructiveHint: false,
  idempotentHint: true`, so clients can auto-allow reads and confirm writes.
- Files are also exposed as **MCP resources** (`quire://course/<slug>/file/<docId>`), the idiomatic way for
  Claude to fetch a document.

## Endpoint & auth

- **URL:** `https://quire.ezragubbay.com/mcp` (Streamable HTTP, stateless). Served by the Next.js app
  (`apps/web/src/app/mcp/route.ts`) — no separate process or tunnel change.
- **Auth:** the endpoint sits behind `apps/web/src/proxy.ts`. In production (`AUTH_MODE=github`) a client
  authenticates with `Authorization: Bearer $QUIRE_API_KEY` (the key already in `/srv/quire/.env`). Locally
  (`AUTH_MODE=none`) it is open.
- **Never commit or paste the key.** Supply it from your own environment.

## Connect Claude Desktop

Claude Desktop's remote-connector UI expects OAuth, so bridge the remote endpoint to stdio with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which injects the bearer header.

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
2. Merge in the block from [`claude-desktop.example.json`](./claude-desktop.example.json) and replace
   `qk_replace_with_your_key` with your `QUIRE_API_KEY`.
3. Restart Claude Desktop. "quire" appears under tools; try *"list my Quire courses"*.

## Connect Claude Code

Claude Code speaks the `http` transport natively, so no bridge — the repo ships a project-scoped
[`.mcp.json`](../../.mcp.json) that registers the server with a `${QUIRE_API_KEY}` header. Just:

1. Export your key where Claude Code runs: `export QUIRE_API_KEY=qk_...` (never commit it).
2. Open this repo in Claude Code and approve the `quire` MCP server, or add it yourself:
   ```sh
   claude mcp add --transport http quire https://quire.ezragubbay.com/mcp \
     --header "Authorization: Bearer $QUIRE_API_KEY"
   ```
3. Run `/mcp` to confirm `quire` is connected and its tools are listed.

## Verify / debug

```sh
# Local (AUTH_MODE=none): initialize + list tools
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -X POST http://127.0.0.1:3000/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# Production: same, with the bearer
curl -s -H "authorization: Bearer $QUIRE_API_KEY" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -X POST https://quire.ezragubbay.com/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Interactive: the MCP Inspector
npx @modelcontextprotocol/inspector
# → connect to the URL (Streamable HTTP); add the Authorization header for production.
```

## Config

- `MCP_MAX_INLINE_BYTES` — max bytes returned inline before falling back to a download URL (default
  `10485760`). Large decks (~100 MB) always fall back.
- `QUIRE_PUBLIC_URL` — base URL used in the fallback download links (default `https://quire.ezragubbay.com`).
- `MCP_WRITE_ENABLED` — default on. `0`/`false`/`off`/`no` stops registering the write tools (they vanish from
  `tools/list`). Kill switch: set `MCP_WRITE_ENABLED=false` in `/srv/quire/.env` and restart the app
  (`infra/compose.yml` passes it through). The bearer key already allows writes through the web API, so the tools
  add no privilege; the residual risk is prompt-injected course content steering a client into calling them. Writes
  are additive, deduped and visible in the UI.
- `MCP_UPLOAD_MAX_MARKDOWN_BYTES` — max UTF-8 size of `upload_markdown` text (default `524288`).

## Verify the write tool locally

```sh
# tools/list shows upload_markdown (annotations included) and the read tools with readOnlyHint
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -X POST http://127.0.0.1:3000/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Create, then repeat (expect status "created", then "duplicate")
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -X POST http://127.0.0.1:3000/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"upload_markdown","arguments":{"course":"<slug>","title":"MCP smoke note","markdown":"Hello from MCP."}}}'
```
