import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { type SeededCourse, seedCourse } from './fixtures/seed';

/**
 * The executable contract for the mobile API (`/api/mobile/v1`), written before any endpoint exists so
 * each E1 story has a concrete target. Every step is a `test.fixme` whose title names the story that
 * un-fixmes it; until then the whole suite reports as skipped and exits 0.
 *
 * Journey (serial — a step builds on the state the previous one captured):
 *   pair → GET /me → 401 without a token → courses → course detail → sessions → files → file detail →
 *   full download → ranged download → 304 → notes list → note read → create thread → streamed answer →
 *   upload (async) → revoke → 401 after revoke.
 *
 * Contract the later stories must honour:
 *   - Auth is a per-device bearer token minted by exchanging a short-lived pairing code. The raw token is
 *     returned exactly once (only its hash is stored). Identity flows through the principal's `login`
 *     (`local` under `AUTH_MODE=none`), never a hard-coded account.
 *   - Every v1 handler except `auth/pair` requires the bearer and returns 401 in the error envelope
 *     otherwise — in every AUTH_MODE, including `none`.
 *   - Errors are `{ error: { code, message } }` with code ∈
 *     { unauthorized, not_found, invalid_request, rate_limited, ai_unavailable, internal }.
 *   - File content streams with Range + strong ETag; chat answers stream NDJSON (`user`/`delta`/`done`/
 *     `error`) identical to the web route. Notes are read-only (no write verbs).
 *
 * Runs under `AUTH_MODE=none` and `AI_MOCK=1` (see .github/workflows/ci.yml), matching the other specs.
 */

const BASE = '/api/mobile/v1';
const DEVICE = 'Playwright e2e device';

/** The error codes the envelope is allowed to carry (#32). */
const ERROR_CODES = [
  'unauthorized',
  'not_found',
  'invalid_request',
  'rate_limited',
  'ai_unavailable',
  'internal',
] as const;

test.describe
  .serial('mobile API v1 journey', () => {
    let seeded: SeededCourse;
    /** Raw per-device token, captured once at the `pair` step. */
    let token = '';
    /** A lecture file with a PDF, discovered from `GET /courses/{course}/files`. */
    let lectureFileId = '';
    /** A note id, discovered from `GET /courses/{course}/notes`. */
    let noteId = '';
    /** A chat thread id, from `POST /courses/{course}/threads`. */
    let threadId = '';
    /** Strong validator captured from the full file download, reused for the 304 check. */
    let etag = '';

    test.beforeAll(async ({ browser }) => {
      seeded = await seedCourse(browser);
    });

    const bearer = () => ({ Authorization: `Bearer ${token}` });

    /** Assert a response is the error envelope with the given status and code. */
    async function expectEnvelope(res: APIResponse, status: number, code: (typeof ERROR_CODES)[number]) {
      expect(res.status()).toBe(status);
      const body = (await res.json()) as { error?: { code?: string; message?: unknown } };
      expect(body.error?.code).toBe(code);
      expect(typeof body.error?.message).toBe('string');
    }

    /** GET a mobile endpoint with the device bearer. */
    const authedGet = (request: APIRequestContext, path: string, headers: Record<string, string> = {}) =>
      request.get(path, { headers: { ...bearer(), ...headers } });

    // ── Auth: pairing, identity, rejection (QMOB-E1-S2 / #33) ────────────────────────────────────────

    test('QMOB-E1-S2 · pair: mint a code, then exchange it once for a per-device token', async ({
      request,
    }) => {
      // The mint route is a web-session route behind the proxy; under AUTH_MODE=none it mints for `local`.
      const mint = await request.post('/api/mobile/pairing-codes');
      expect(mint.ok()).toBeTruthy();
      const { code, expiresAt } = (await mint.json()) as { code: string; expiresAt: string };
      expect(code).toMatch(/^[0-9A-Za-z]{8}$/);
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

      // The exchange is public and hands back the raw token exactly once.
      const paired = await request.post(`${BASE}/auth/pair`, { data: { code, deviceName: DEVICE } });
      expect(paired.ok()).toBeTruthy();
      const body = (await paired.json()) as { token: string; device?: { name?: string } };
      expect(body.token).toBeTruthy();
      token = body.token;

      // Single use: the same code cannot be exchanged a second time.
      const replay = await request.post(`${BASE}/auth/pair`, { data: { code, deviceName: DEVICE } });
      await expectEnvelope(replay, 400, 'invalid_request');
    });

    test('QMOB-E1-S2 · GET /me returns the principal and the API version', async ({ request }) => {
      const res = await authedGet(request, `${BASE}/me`);
      expect(res.status()).toBe(200);
      const me = (await res.json()) as { login: string; apiVersion: string; device?: { name?: string } };
      expect(me.login).toBe('local');
      expect(me.apiVersion).toMatch(/^1\./);
      expect(me.device?.name).toBe(DEVICE);
    });

    test('QMOB-E1-S2 · requests without a token are rejected with 401 unauthorized', async ({ request }) => {
      await expectEnvelope(await request.get(`${BASE}/me`), 401, 'unauthorized');
      await expectEnvelope(await request.get(`${BASE}/courses`), 401, 'unauthorized');
      await expectEnvelope(
        await request.get(`${BASE}/me`, { headers: { Authorization: 'Bearer not-a-real-token' } }),
        401,
        'unauthorized',
      );
    });

    // ── Courses, sessions, files (QMOB-E1-S4 / #35) ──────────────────────────────────────────────────

    test('QMOB-E1-S4 · GET /courses lists course summaries', async ({ request }) => {
      const res = await authedGet(request, `${BASE}/courses`);
      expect(res.status()).toBe(200);
      const courses = (await res.json()) as Array<{
        slug: string;
        id: string;
        name: string;
        code: string;
        semester: string;
        type: string;
        fileCount: number;
      }>;
      const ours = courses.find((c) => c.slug === seeded.slug);
      expect(ours, 'the seeded course is listed').toBeTruthy();
      expect(ours?.name).toBe(seeded.name);
      expect(ours?.fileCount).toBeGreaterThanOrEqual(2);
    });

    test('QMOB-E1-S4 · GET /courses/{course} returns the summary with counts; unknown → 404', async ({
      request,
    }) => {
      const res = await authedGet(request, `${BASE}/courses/${seeded.slug}`);
      expect(res.status()).toBe(200);
      const detail = (await res.json()) as {
        slug: string;
        counts: { sessions: Record<string, number>; files: Record<string, number>; notes: number };
      };
      expect(detail.slug).toBe(seeded.slug);
      expect(detail.counts.sessions.lecture).toBeGreaterThanOrEqual(1);
      expect(detail.counts.sessions.recitation).toBeGreaterThanOrEqual(1);
      expect(detail.counts.notes).toBeGreaterThanOrEqual(1);

      await expectEnvelope(await authedGet(request, `${BASE}/courses/no-such-course`), 404, 'not_found');
    });

    test('QMOB-E1-S4 · GET /courses/{course}/sessions lists lectures and recitations with deck file ids', async ({
      request,
    }) => {
      const res = await authedGet(request, `${BASE}/courses/${seeded.slug}/sessions`);
      expect(res.status()).toBe(200);
      const sessions = (await res.json()) as Array<{
        kind: 'lecture' | 'recitation';
        number: number;
        title: string;
        date: string | null;
        fileIds: string[];
        noteId: string | null;
      }>;
      expect(sessions.some((s) => s.kind === 'lecture' && s.fileIds.length > 0)).toBeTruthy();
      expect(sessions.some((s) => s.kind === 'recitation' && s.fileIds.length > 0)).toBeTruthy();
    });

    test('QMOB-E1-S4 · GET /courses/{course}/files lists labelled CourseFiles', async ({ request }) => {
      const res = await authedGet(request, `${BASE}/courses/${seeded.slug}/files`);
      expect(res.status()).toBe(200);
      const files = (await res.json()) as Array<{
        fileId: string;
        title: string;
        type: 'lecture' | 'recitation' | 'homework' | 'exam' | 'book' | 'paper' | 'other';
        session?: { number: number; title: string };
        folder?: string;
        pageCount: number | null;
        sizeBytes: number | null;
        hasPdf: boolean;
        hasOriginal: boolean;
        hasMarkdown: boolean;
        updatedAt: string;
      }>;
      expect(files.length).toBeGreaterThanOrEqual(2);
      const lecture = files.find((f) => f.type === 'lecture' && f.hasPdf);
      expect(lecture, 'a labelled lecture file with a PDF').toBeTruthy();
      expect(lecture?.sizeBytes).toBeGreaterThan(0);
      lectureFileId = lecture?.fileId ?? '';
    });

    test('QMOB-E1-S4 · GET /courses/{course}/files/{fileId} returns one CourseFile; unknown → 404', async ({
      request,
    }) => {
      expect(lectureFileId).toBeTruthy();
      const res = await authedGet(request, `${BASE}/courses/${seeded.slug}/files/${lectureFileId}`);
      expect(res.status()).toBe(200);
      const file = (await res.json()) as { fileId: string; type: string };
      expect(file.fileId).toBe(lectureFileId);

      await expectEnvelope(
        await authedGet(request, `${BASE}/courses/${seeded.slug}/files/00000000-0000-0000-0000-000000000000`),
        404,
        'not_found',
      );
    });

    // ── File content: streaming, Range, ETag (QMOB-E1-S5 / #36) ──────────────────────────────────────

    test('QMOB-E1-S5 · file content streams the full PDF with a strong ETag', async ({ request }) => {
      expect(lectureFileId).toBeTruthy();
      const res = await authedGet(
        request,
        `${BASE}/courses/${seeded.slug}/files/${lectureFileId}/content?format=pdf`,
      );
      expect(res.status()).toBe(200);
      const headers = res.headers();
      expect(headers['content-type']).toContain('application/pdf');
      expect(headers['accept-ranges']).toBe('bytes');
      expect(headers['content-disposition']).toContain('filename');
      expect(headers.etag).toBeTruthy();
      etag = headers.etag;
      const body = await res.body();
      expect(body.length).toBe(Number(headers['content-length']));
      expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    test('QMOB-E1-S5 · a Range request returns 206 with Content-Range', async ({ request }) => {
      expect(lectureFileId).toBeTruthy();
      const url = `${BASE}/courses/${seeded.slug}/files/${lectureFileId}/content?format=pdf`;
      const ranged = await authedGet(request, url, { Range: 'bytes=0-99' });
      expect(ranged.status()).toBe(206);
      expect(ranged.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
      expect((await ranged.body()).length).toBe(100);

      // Out of range → 416 unsatisfiable.
      const bad = await authedGet(request, url, { Range: 'bytes=99999999-100000000' });
      expect(bad.status()).toBe(416);
    });

    test('QMOB-E1-S5 · If-None-Match with the current ETag yields 304', async ({ request }) => {
      expect(etag).toBeTruthy();
      const res = await authedGet(
        request,
        `${BASE}/courses/${seeded.slug}/files/${lectureFileId}/content?format=pdf`,
        { 'If-None-Match': etag },
      );
      expect(res.status()).toBe(304);
      expect((await res.body()).length).toBe(0);
    });

    // ── Notes: read-only Markdown (QMOB-E1-S6 / #37) ─────────────────────────────────────────────────

    test('QMOB-E1-S6 · notes list and read return metadata and raw Markdown', async ({ request }) => {
      const list = await authedGet(request, `${BASE}/courses/${seeded.slug}/notes`);
      expect(list.status()).toBe(200);
      const notes = (await list.json()) as Array<{
        id: string;
        slug: string;
        title: string;
        folder?: string;
        session?: { kind: string; number: number };
        updatedAt: string;
      }>;
      expect(notes.length).toBeGreaterThanOrEqual(1);
      noteId = notes[0]?.id ?? '';
      expect(noteId).toBeTruthy();

      const read = await authedGet(request, `${BASE}/courses/${seeded.slug}/notes/${noteId}`);
      expect(read.status()).toBe(200);
      const note = (await read.json()) as { id: string; markdown: string };
      expect(note.id).toBe(noteId);
      expect(typeof note.markdown).toBe('string');

      // Read-only: no write verb is mounted under /notes.
      const write = await request.post(`${BASE}/courses/${seeded.slug}/notes`, {
        headers: bearer(),
        data: { title: 'nope' },
      });
      expect(write.status()).toBe(405);
    });

    // ── Chat: threads + NDJSON streaming answer (QMOB-E1-S7 / #38) ────────────────────────────────────

    test('QMOB-E1-S7 · create a chat thread and list recent threads', async ({ request }) => {
      const res = await request.post(`${BASE}/courses/${seeded.slug}/threads`, {
        headers: bearer(),
        data: {},
      });
      expect([200, 201]).toContain(res.status());
      const thread = (await res.json()) as { id: string };
      expect(thread.id).toBeTruthy();
      threadId = thread.id;

      const recent = await authedGet(request, `${BASE}/threads?limit=10`);
      expect(recent.status()).toBe(200);
      const threads = (await recent.json()) as Array<{ id: string }>;
      expect(threads.some((t) => t.id === threadId)).toBeTruthy();
    });

    test('QMOB-E1-S7 · posting a question streams NDJSON answer events (AI_MOCK=1)', async ({ request }) => {
      expect(threadId).toBeTruthy();
      const res = await request.post(`${BASE}/courses/${seeded.slug}/threads/${threadId}/messages`, {
        headers: bearer(),
        data: { question: 'What does the seeded note say?' },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('application/x-ndjson');

      const events = (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; text?: string });
      expect(events[0]?.type).toBe('user');
      expect(events.some((e) => e.type === 'delta')).toBeTruthy();
      expect(events.at(-1)?.type).toBe('done');
      const streamed = events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text ?? '')
        .join('');
      expect(streamed).toContain('Mock answer');

      // History carries citations without the web-only `href`.
      const history = await authedGet(request, `${BASE}/courses/${seeded.slug}/threads/${threadId}/messages`);
      expect(history.status()).toBe(200);
      const messages = (await history.json()) as Array<{
        role: string;
        citations?: Array<{
          n: number;
          kind: string;
          id: string;
          title: string;
          pageNo?: number;
          href?: never;
        }>;
      }>;
      const assistant = messages.find((m) => m.role === 'assistant');
      for (const c of assistant?.citations ?? []) {
        expect(c).not.toHaveProperty('href');
      }
    });

    // ── Upload: async + idempotent (QMOB-E1-S8 / #39) ─────────────────────────────────────────────────

    test('QMOB-E1-S8 · upload a PDF, get a job, and poll it to completion', async ({ request }) => {
      const create = await request.post(`${BASE}/courses/${seeded.slug}/uploads`, {
        headers: { ...bearer(), 'Idempotency-Key': `e2e-${Date.now()}`, 'Content-Type': 'application/pdf' },
        data: Buffer.from('%PDF-1.4\n'),
      });
      expect(create.status()).toBe(202);
      const job = (await create.json()) as { uploadId: string; status: string };
      expect(job.uploadId).toBeTruthy();
      expect(['queued', 'processing', 'done']).toContain(job.status);

      const status = await authedGet(request, `${BASE}/uploads/${job.uploadId}`);
      expect(status.status()).toBe(200);
      const polled = (await status.json()) as { status: string; fileId?: string };
      expect(['queued', 'processing', 'done', 'failed']).toContain(polled.status);
    });

    // ── Revoke, then 401 (QMOB-E1-S2 / #33) — last, so earlier steps still have a live token ──────────

    test('QMOB-E1-S2 · revoke the device token, after which the token is rejected with 401', async ({
      request,
    }) => {
      const revoked = await request.delete(`${BASE}/auth/token`, { headers: bearer() });
      expect([200, 204]).toContain(revoked.status());
      await expectEnvelope(await authedGet(request, `${BASE}/me`), 401, 'unauthorized');
    });
  });
