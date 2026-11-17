# Quire MCP server

A read-only [MCP](https://modelcontextprotocol.io) endpoint that lets a Claude client browse Quire:

- **`list_courses`** — every course (stable `slug`, name, code, semester, file count).
- **`list_course_files`** (`course`) — the course's files, each labeled `lecture` / `recitation` /
  `homework` / `exam` / `book` / `paper` / `other`, with a stable `fileId` and a `resourceUri`.
- **`get_file`** (`course`, `fileId`, `format?`) — the file's bytes. Small PDFs/markdown come back inline;
  files over `MCP_MAX_INLINE_BYTES` (default 10 MB) return a download URL instead.
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
