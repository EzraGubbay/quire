# Quire MCP server

An [MCP](https://modelcontextprotocol.io) endpoint that lets a Claude client browse Quire and add Markdown to it (the read tools are read-only; the write tools are additive, never edit or delete, and can be switched off):

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
- **`upload_pdf`** (`course`, `url`, `title?`, `folder?`) — **writes**: the *server* downloads a public https PDF
  into the course's Documents (the model passes only a URL). Use the direct PDF link (`https://arxiv.org/pdf/<id>`);
  landing pages are not scraped. Same PDF again returns `duplicate`; very slow extractions return `processing`
  after 40 s and finish in the background (calling again is safe). Max `MCP_UPLOAD_MAX_URL_BYTES` (50 MB).
- **`create_upload_link`** (`course`, `section`: `documents`|`notes`, `filename` `.pdf`/`.md`/`.markdown`,
  `contentType?`, `title?`, `folder?`) — **writes (via the link)**. For an *existing local file* (no tool ever
  takes file bytes): mints a single-use `PUT` URL bound to that course, section, folder, filename and type. It
  returns `uploadId`, `uploadUrl`, `expiresAt`, `maxBytes` (95 MB PDF / 2 MB Markdown) and a ready `curl`:
  `curl --fail-with-body -sS -T ./file.pdf -H 'content-type: application/pdf' '<uploadUrl>'`. Claude Code runs it
  with Bash; in Claude Desktop / claude.ai the user runs it in a terminal. PDFs go to Documents (Notes hold
  Markdown only). The PUT answers `201 created` / `200 duplicate` with the id, `202` if extraction outlasts 90 s.
- **`get_upload_status`** (`uploadId`) — read-only: `pending`, `processing`, `created`, `duplicate`, `failed`
  or `expired`, with the new id when done (kept 24 h).
- Files are also exposed as **MCP resources** (`quire://course/<slug>/file/<docId>`), the idiomatic way for
  Claude to fetch a document.

## Endpoint & auth

- **URL:** `https://quire.ezragubbay.com/mcp` (Streamable HTTP, stateless). Served by the Next.js app
  (`apps/web/src/app/mcp/route.ts`) — no separate process or tunnel change.
- **Auth:** the endpoint sits behind `apps/web/src/proxy.ts`. In production (`AUTH_MODE=github`) a client
  authenticates with `Authorization: Bearer $QUIRE_API_KEY` (the key already in `/srv/quire/.env`). Locally
  (`AUTH_MODE=none`) it is open.
- **Scope:** the course server only serves `kind='course'` projects; a research project's slug or id answers
  "No course found".
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
- `MCP_UPLOAD_LINK_TTL_MS` (default `600000`), `MCP_UPLOAD_LINK_MAX_OPEN` (`50`),
  `MCP_UPLOAD_LINK_MAX_PDF_BYTES` (`99614720` = 95 MB: Cloudflare's edge limit is 100 MB per request),
  `MCP_UPLOAD_LINK_MAX_MD_BYTES` (`2097152`), `MCP_UPLOAD_LINK_DEADLINE_MS` (`90000`, kept under Cloudflare's
  100 s origin timeout), `MCP_UPLOAD_DEADLINE_MS` (`40000`). All are passed through by `infra/compose.yml`.

## Verify the write tool locally

```sh
# tools/list shows upload_markdown (annotations included) and the read tools with readOnlyHint
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -X POST http://127.0.0.1:3000/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Create, then repeat (expect status "created", then "duplicate")
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -X POST http://127.0.0.1:3000/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"upload_markdown","arguments":{"course":"<slug>","title":"MCP smoke note","markdown":"Hello from MCP."}}}'
```
## Upload-link security model

`PUT /api/upload-links/<token>` is the only public path this adds (`proxy.ts` allows only a `PUT` to
`/api/upload-links/<43-char token>`; deeper paths, other methods and look-alikes stay session-gated). It never reads cookies or the bearer: the token alone
authorizes it. The token is 256 random bits, single use, valid 10 minutes, and only its sha256 is held (in the
app process's memory; a restart makes links answer 410, so just mint a new one). Everything the upload may do is
bound when the link is minted, so a leaked URL can only write that one file to that one place, once. Only `PUT`
is served and there is no CORS handling. Size/type problems detected from headers (411/413/415) leave the link
usable; once the body is read the link is spent (400 length mismatch, 422 not a PDF / invalid UTF-8, 410 replay or
expiry). Uploading the same bytes again returns `duplicate`. A Markdown link accepts `text/markdown` *or*
`text/plain` on purpose (curl and many tools label `.md` files plain text); a PDF link accepts only
`application/pdf`. The route relies on `Content-Length` to detect truncated bodies: on the first real upload
through Cloudflare, confirm the PUT succeeds (a 411/400 would mean the header was dropped). `MCP_WRITE_ENABLED=false` makes the route 404.

Verify locally (replace `$SLUG`; add the bearer header to the MCP calls if auth is on):

```sh
# call create_upload_link via tools/call, then run the curl it returns; run it again: 410
curl -s -o /dev/null -w '%{http_code}\n' -X PUT http://127.0.0.1:3000/api/upload-links/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA   # 410
```

## Drive inbox (mobile/voice)

For files Claude can save to Google Drive (PDFs, larger files, `.md`) when it cannot run curl, e.g. the Claude
mobile app or voice mode. Claude never re-types the bytes into a Quire tool call.

Flow: Claude saves the file into the Drive folder **"Quire Inbox"** (Drive connector `create_file`, `parentId` = the
folder id; for `.md` set `contentMimeType: text/markdown` and `disableConversionToGoogleType: true`) -> calls
`import_from_drive {fileId, course, section, folder?, title?}` -> Quire downloads it with its own read-only service
account, checks it and ingests it (the same path and dedupe as `upload_markdown` / PDF uploads) -> the result names
the exact `trash_file {fileId}` for Claude to call with the Drive connector (set `trash_file` to *Needs approval* in
claude.ai). `drive_inbox_status {}` lists what is in the Inbox and which files are already imported.

- Accepted: PDF (Documents only), Markdown (Notes or Documents), Google Docs (exported as Markdown). Caps: 80 MB PDF,
  2 MB Markdown (`DRIVE_IMPORT_MAX_PDF_BYTES` / `DRIVE_IMPORT_MAX_MD_BYTES`), checked from Drive metadata before any
  download and again while streaming. Imported PDFs carry no `sourceUrl` (a source URL would label them papers).
- Idempotent: a PDF whose Drive `sha256Checksum` is already in the course returns `duplicate` without downloading.
- A call still running after `MCP_UPLOAD_DEADLINE_MS` returns `status:"processing"`; retrying is safe. Do not trash
  after `processing`, only after `created` / `duplicate`.

**Setup** (one-off; the step-by-step list is `zz-your-steps-drive-inbox-upload.md`, kept by the maintainer): create the
Drive folder, create a service account with no project roles and a JSON key, share the folder with the service account
as **Viewer**, then set the GitHub Actions **secret** `DRIVE_SERVICE_ACCOUNT_JSON_BASE64` (base64 of the key JSON, one
line) and **variable** `QUIRE_DRIVE_INBOX_FOLDER_ID`. `deploy.yml` writes both into `/srv/quire/.env`. If either is
missing or invalid, the Drive tools are not registered and the log shows one line `[drive] disabled: <reason>`
(`missing`, `bad_base64`, `bad_json`, `wrong_type`, `missing_field:*`, `bad_private_key`, `missing_folder`,
`bad_folder`). They are also off when `MCP_WRITE_ENABLED=false`.

**Security model**
- The service account is dedicated (separate from the FCM one), has the `drive.readonly` scope and is a Viewer of the
  Inbox only: Quire cannot write or delete anything in Drive. JWT signing uses `node:crypto`; no `googleapis` package.
- Quire refuses any file that is not a direct child of the Inbox, even if the account could see it elsewhere.
- Only `oauth2.googleapis.com` and `www.googleapis.com` are called, with a fixed base and the encoded file id.
- The key, JWT, token, Drive response bodies and file names are never logged or returned; tool errors are fixed text.
- Residual risk: prompt-injected content could make Claude import an Inbox file into a course (additive, deduped,
  visible) or ask to trash a file; with `trash_file` on *Needs approval* each trash needs the user's tap.

**Fallbacks.** Without the Drive route: `create_upload_link` (PUT with curl) where a shell exists, or share the file to
the Quire Android app (its upload feature) for files generated on the phone.

**Verify.** `drive_inbox_status {}` proves auth and the folder share. Then save a small PDF into the Inbox with
`create_file`, call `import_from_drive` (expect `created`, then `duplicate`), and trash the Drive file with the id the
result names. Also check: a file outside the Inbox -> "Quire can't see that Drive file"; a `.docx` -> unsupported;
a PDF with `section:"notes"` -> refused. On the phone, check the text chat and the voice chat separately.

## SSRF policy for `upload_pdf{url}`

The fetch (`lib/mcp/safe-fetch.ts`) accepts only `https://` URLs without credentials on port 443. DNS is resolved
once by the guard and the socket connects only to a vetted address (no rebinding window); a hostname is refused
if *any* of its addresses is loopback, private (10/8, 172.16/12, 192.168/16), link-local/metadata (169.254/16),
CGNAT/tailnet (100.64/10), multicast/reserved, or the IPv6 equivalents (including IPv4-mapped, NAT64 and 6to4).
Redirects are followed by hand (max 3) and every hop is re-checked, so an https-to-http downgrade or a redirect
to a private address fails. The response must be a 200 with `%PDF-` content, is capped at
`MCP_UPLOAD_MAX_URL_BYTES` (aborted mid-stream) and the whole fetch has a 25 s budget. Errors never echo
resolved addresses.
- `MCP_UPLOAD_MAX_URL_BYTES` — max size of a fetched PDF (default `52428800`).
