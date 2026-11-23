# Quire mobile API (v1)

The HTTP contract between the Quire web app and the native mobile clients, served under
`/api/mobile/v1`. The machine-readable source of truth is
[`api/mobile-v1.openapi.yaml`](api/mobile-v1.openapi.yaml); this page is the human walkthrough.

In the examples below `$BASE` is your Quire origin (for example `https://quire.example.com`) and
`$TOKEN` is a placeholder for the per-device token. Never paste a real token into docs, chat or logs.

## Pairing and auth

A device authenticates with a per-device bearer token. The token is minted by exchanging a
short-lived, single-use pairing code, and is shown exactly once (only its hash is stored).

1. In the web app, open Settings, Mobile devices, and generate a pairing code (it is also shown as a QR
   code). Programmatically this is the session-authenticated `POST /api/mobile/pairing-codes`, which is
   outside v1:

   ```sh
   curl -X POST "$BASE/api/mobile/pairing-codes" -H "Cookie: <web session>"
   # {"code":"AbC12345","expiresAt":"2026-11-03T10:10:00.000Z"}
   ```

2. Exchange the code for a token (public endpoint; failed attempts are rate limited per client IP):

   ```sh
   curl -X POST "$BASE/api/mobile/v1/auth/pair" \
     -H 'Content-Type: application/json' \
     -d '{"code":"AbC12345","deviceName":"Pixel 9"}'
   # {"token":"<TOKEN>","device":{"id":"...","name":"Pixel 9"}}
   ```

3. Send the token on every other request:

   ```sh
   curl "$BASE/api/mobile/v1/me" -H "Authorization: Bearer $TOKEN"
   # {"login":"local","apiVersion":"1.1.0","device":{...}}
   ```

4. Revoke the device (also possible from the web Settings page). Afterwards the token answers 401:

   ```sh
   curl -X DELETE "$BASE/api/mobile/v1/auth/token" -H "Authorization: Bearer $TOKEN"   # 204
   ```

Every operation except `POST /auth/pair` requires the bearer token and answers 401 `unauthorized`
otherwise, in every deployment mode.

## Endpoints

Paths are relative to `/api/mobile/v1`. `{course}` is a course slug or UUID.

| Method | Path | Purpose | Success |
|---|---|---|---|
| POST | `/auth/pair` | Exchange a pairing code for a device token (public) | 200 |
| DELETE | `/auth/token` | Revoke the calling device's token | 204 |
| GET | `/me` | Principal, device and `apiVersion` | 200 |
| GET | `/courses` | Course summaries | 200 |
| GET | `/courses/{course}` | Course detail with counts | 200 |
| GET | `/courses/{course}/sessions` | Lectures and recitations with deck file ids | 200 |
| GET | `/courses/{course}/files` | Labelled course files | 200 |
| GET | `/courses/{course}/files/{fileId}` | One course file | 200 |
| GET | `/courses/{course}/files/{fileId}/content` | File bytes (`?format=pdf\|original\|markdown`), Range + ETag | 200 / 206 / 304 |
| GET | `/courses/{course}/notes` | Note summaries (read-only) | 200 |
| GET | `/courses/{course}/notes/{noteId}` | Note with raw Markdown | 200 |
| GET | `/threads` | Recent chat threads across courses (`?limit=1..100`, default 20) | 200 |
| GET | `/courses/{course}/threads` | Threads of a course | 200 |
| POST | `/courses/{course}/threads` | Create a thread | 201 |
| DELETE | `/courses/{course}/threads/{threadId}` | Delete a thread | 204 |
| GET | `/courses/{course}/threads/{threadId}/messages` | Thread history | 200 |
| POST | `/courses/{course}/threads/{threadId}/messages` | Ask a question; answer streams as NDJSON | 200 |
| POST | `/courses/{course}/uploads` | Upload for background processing (provisional, E1-S8, not yet shipped) | 202 |
| GET | `/uploads/{uploadId}` | Poll an upload job (provisional, E1-S8, not yet shipped) | 200 |
| PUT | `/push/registration` | Create or refresh this device's push registration (idempotent) | 200 |
| GET | `/push/registration` | This device's push registration, or `null` | 200 |
| DELETE | `/push/registration` | Delete this device's push registration | 204 |
| POST | `/push/test` | Send a test notification to this device, synchronously | 200 |

### File content

```sh
# Full download; note the ETag
curl -i "$BASE/api/mobile/v1/courses/$COURSE/files/$FILE/content?format=pdf" -H "Authorization: Bearer $TOKEN" -o out.pdf
# First 100 bytes -> 206 with Content-Range: bytes 0-99/<total>
curl -i "$BASE/api/mobile/v1/courses/$COURSE/files/$FILE/content?format=pdf" -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-99'
# Revalidate -> 304 with an empty body
curl -i "$BASE/api/mobile/v1/courses/$COURSE/files/$FILE/content?format=pdf" -H "Authorization: Bearer $TOKEN" -H 'If-None-Match: "<etag>"'
```

An unsatisfiable range answers 416. Responses carry `Accept-Ranges: bytes`, a strong `ETag` and a
`Content-Disposition` filename.

## Chat stream (NDJSON)

`POST .../threads/{threadId}/messages` with `{"question": "..."}` responds `200` with
`Content-Type: application/x-ndjson`: one JSON event per line.

| `type` | Fields | Meaning |
|---|---|---|
| `user` | `message` | The persisted user message. Always first. |
| `delta` | `text` | A chunk of the answer; concatenate in order. Zero or more. |
| `done` | `message`, `fallback?` | The persisted assistant message (with `citations`). Terminal. |
| `error` | `code`, `message`, `kind?` | The answer failed after the stream began. Terminal. `code` is an error code below. |

Failures before the stream starts (bad body, unknown thread, AI down at the start) are a normal
non-200 response in the error envelope. Citations never carry the web-only `href`.

```sh
curl -N -X POST "$BASE/api/mobile/v1/courses/$COURSE/threads/$THREAD/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"question":"What is convolution?"}'
```

## Push notifications

The design is ADR 0003 in the Android repo (`quire-android/docs/adr/0003-push-notifications.md`). Every push is
an FCM **data message** carrying ids only (no titles or content); the app builds the notification itself.

### Registration

A paired device registers its FCM token once per app start. There is one registration per device, keyed by
the calling device token, never by a client-supplied id.

```sh
curl -X PUT "$BASE/api/mobile/v1/push/registration" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fcmToken":"<fcm token>","platform":"android","appVersion":"1.1.0","categories":["files","deadlines","notes"]}'
# {"registration":{"deviceId":"...","platform":"android","appVersion":"1.1.0","categories":[...],
#   "createdAt":"...","updatedAt":"..."},"pushEnabled":true}
```

- The same body always yields the same state (`updatedAt` changes only when something changed).
- `categories` is any subset of `files`, `deadlines`, `notes`. Unknown values are ignored and left out of
  the response; duplicates collapse. The server filters by category, so a disabled category never wakes the
  phone.
- `fcmToken` is never echoed or logged. If the same token is registered under another device (re-pairing on
  the same phone), it moves to the calling device.
- `pushEnabled` says whether this server can send at all. Registrations are stored either way.
- `GET` returns `{ "registration": … | null, "pushEnabled": bool }`; `DELETE` returns 204 even when nothing
  was registered.
- Revoking the device (`DELETE /auth/token` or web Settings, Mobile devices) deletes its registration and any
  pending pushes.

### Test push

`POST /push/test` (no body) sends `push.test` to the calling device within the request and reports FCM's
answer:

| Response | Meaning |
|---|---|
| `200 {"eventId","outcome":"sent"}` | FCM accepted the message |
| `200 {…,"outcome":"unregistered"}` | FCM no longer knows the token; the registration is already deleted, so register again |
| `200 {…,"outcome":"retryable"}` | Temporary FCM failure; nothing is queued |
| `200 {…,"outcome":"failed"}` | Any other FCM failure; nothing is queued |
| `400 invalid_request` | This device has no registration |
| `429 rate_limited` | More than one test per 30 s per device |
| `503 push_unavailable` | Push is not set up on this server |

### Payloads

Every value in the FCM `data` map is a string. Common keys: `v` (`"1"`), `type`, `eventId`. Clients drop
messages with an unknown `v` or `type`.

| `type` | Extra keys | Priority / TTL |
|---|---|---|
| `files.added` | `course`, `courseId`, `fileId` (newest in the batch), `count` | NORMAL / 7 days |
| `homework.due` | `course`, `courseId`, `assignmentId`, `number`, `dueAt`, `fileId?` | HIGH / until `dueAt` |
| `note.synthesized` | `course`, `courseId`, `noteId`, `outcome` (`ready` or `failed`) | NORMAL / 24 h |
| `push.test` | none | HIGH / 5 min |

`fileId` is always the mobile API's `fileId`. A burst of new files in one course is coalesced into one
`files.added` with `count > 1`, about 90 s after the last import. A retried message keeps its `eventId`.

### Server setup and key rotation

The server reads the Firebase service-account JSON, base64-encoded on one line, from
`FCM_SERVICE_ACCOUNT_JSON_BASE64`. In production the Deploy workflow writes it into `/srv/quire/.env` from the
Actions secret of the same name; nobody edits the Pi by hand. Without the variable, or with an invalid one,
push is disabled: the server logs `[push] disabled: <reason>` once, keeps accepting registrations and answers
`POST /push/test` with 503 `push_unavailable`.

**Rotating the key:** update the `FCM_SERVICE_ACCOUNT_JSON_BASE64` Actions secret, then run the Deploy
workflow by hand (`workflow_dispatch`). The secret only reaches the Pi on a deploy; Compose then recreates
the app container because its environment changed.

For local development and CI, `PUSH_TRANSPORT=fake` enables push without a credential: messages are recorded
and logged as `[push:fake] sent type=<type> registration=<id>` instead of being sent.

## Errors

Every non-2xx response, and every `error` stream event, uses
`{ "error": { "code": "...", "message": "..." } }` (stream events carry `code` and `message` at the
top level instead).

| `code` | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | Missing, malformed, unknown or revoked token |
| `not_found` | 404 | Unknown course, file, note or thread; unknown v1 path |
| `invalid_request` | 400 | Malformed body or parameter, bad or reused pairing code |
| `rate_limited` | 429 | Too many requests, or AI budget exhausted |
| `ai_unavailable` | 503 | The AI provider is unavailable |
| `internal` | 500 | Unexpected server error |
| `push_unavailable` | 503 | Push is not set up on this server (only `POST /push/test`) |

## Versioning policy

- This is **v1**. Within v1 changes are additive only: new endpoints, new optional request fields,
  new response fields. Clients must ignore unknown response fields. Existing fields are never removed,
  renamed, retyped or made stricter.
- Breaking changes ship as `/api/mobile/v2`, with v1 kept running alongside.
- `GET /me` returns `apiVersion` (`1.x.y`); additive releases bump the minor version.

## Contract fixtures

[`api/fixtures/mobile-v1/`](api/fixtures/mobile-v1/) holds one JSON file per OpenAPI example
(`<operationId>.<status>.json`, request bodies as `<operationId>.request.json`, one `error.<code>.json`
per error code) plus the chat streams as `.ndjson` (`postMessage.200.normal.ndjson` and
`postMessage.200.error-mid-stream.ndjson`). There is also one `push.<type>.json` per push payload
(`push.files.added.json`, `push.homework.due.json`, `push.note.synthesized.json`, `push.test.json`): the
FCM `data` map exactly as sent, generated from the builders in `apps/web/src/lib/mobile/push/events.ts`. Apps
can test against them offline.

They are generated from the spec: edit the examples in the OpenAPI file, then run
`pnpm --filter web mobile:fixtures`. A unit test fails when the committed fixtures are stale, and a
second test parses every example with the zod schemas in `apps/web/src/lib/mobile/schema.ts`.
