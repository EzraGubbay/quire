// PUT /api/upload-links/<token>: the file-bytes half of the MCP create_upload_link flow. Public in proxy.ts and
// authorized solely by the single-use token (lib/mcp/upload-links.ts); it never reads cookies or the bearer.
// Only PUT is exported, so every other verb is a 405, and there is no CORS handling, so a cross-origin
// browser PUT fails its preflight. Logs mention only the uploadId, never the token.

import { scopeOf } from '@/lib/mcp/scope';
import {
  ingestMarkdown,
  ingestPdf,
  markdownFromFile,
  raceDeadline,
  UploadError,
  type UploadResult,
} from '@/lib/mcp/upload';
import { claimLink, type Link, linkConfig, peekLink, setStatus, TOKEN_RE } from '@/lib/mcp/upload-links';
import { getProjectById } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => Response.json(body, { status });
const GONE =
  'This upload link is invalid, already used or expired. Ask Claude for a new one (create_upload_link).';

type BodyResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too-large' | 'mismatch' };

/** Reads the body into a buffer sized to the declared length. Stops early (cancelling the stream) when the body
 *  passes the cap or the declared length. */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  declared: number,
  max: number,
): Promise<BodyResult> {
  const out = new Uint8Array(declared);
  let total = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > declared) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: total + value.byteLength > max ? 'too-large' : 'mismatch' };
      }
      out.set(value, total);
      total += value.byteLength;
    }
  }
  return total === declared ? { ok: true, bytes: out } : { ok: false, reason: 'mismatch' };
}

export async function PUT(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return json({ error: GONE }, 410);
  const peeked = peekLink(token);
  if (!peeked) return json({ error: GONE }, 410);
  // The link's own scope decides whether writes are on: the course and research flags are independent.
  if (!scopeOf(peeked.scope).writeEnabled()) return json({ error: 'Not found.' }, 404);

  // Header problems do not consume the token: the user can fix the curl and retry.
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader === null) {
    return json({ error: 'Content-Length is required (use curl -T file, not chunked uploads).' }, 411);
  }
  const declared = Number(lengthHeader);
  if (!Number.isInteger(declared) || declared < 0) return json({ error: 'Invalid Content-Length.' }, 400);
  if (declared === 0) return json({ error: 'The upload is empty.' }, 400);
  if (declared > peeked.maxBytes) {
    return json(
      { error: `The file is over this link's ${Math.round(peeked.maxBytes / 1048576)} MB limit.` },
      413,
    );
  }
  const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  const boundType = peeked.contentType.toLowerCase();
  const typeOk =
    peeked.kind === 'pdf' ? type === boundType : type === 'text/markdown' || type === 'text/plain';
  if (!typeOk) {
    return json({ error: `Send this file with -H 'content-type: ${peeked.contentType}'.` }, 415);
  }

  const link = claimLink(token);
  if (!link) return json({ error: GONE }, 410);
  const { uploadId } = link;
  setStatus(uploadId, { state: 'processing' });
  const fail = (error: string, status: number) => {
    setStatus(uploadId, { state: 'failed', error });
    return json({ error, uploadId }, status);
  };

  try {
    return await ingestUpload(link, declared, req, fail);
  } catch (err) {
    // Not a message written for the user (a DB or filesystem error): log the id only, show a generic text.
    console.error(`[mcp upload-link ${uploadId}] failed:`, (err as Error).name);
    return fail('The upload failed on the server. Ask Claude for a new link and retry.', 500);
  }
}

async function ingestUpload(
  link: Link,
  declared: number,
  req: Request,
  fail: (error: string, status: number) => Response,
): Promise<Response> {
  const { uploadId } = link;
  let read: BodyResult;
  try {
    read = await readBody(req.body, declared, link.maxBytes);
  } catch {
    return fail('Upload interrupted; ask Claude for a new link.', 400);
  }
  if (!read.ok) {
    return read.reason === 'too-large'
      ? fail(`The file is over this link's ${Math.round(link.maxBytes / 1048576)} MB limit.`, 413)
      : fail(
          'Incomplete upload (the body did not match Content-Length). Ask Claude for a new link and retry.',
          400,
        );
  }
  const bytes = read.bytes;

  const project = await getProjectById(link.projectId);
  const scope = scopeOf(link.scope);
  if (!project || project.kind !== link.scope) {
    return fail(`The ${scope.noun} for this link no longer exists.`, 422);
  }
  const folder = { id: link.folderId, name: link.folderName };
  let work: Promise<UploadResult>;
  try {
    if (link.kind === 'pdf') {
      work = ingestPdf(project, { data: bytes, fileName: link.filename, title: link.title, folder }, scope);
    } else {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return fail('The file is not valid UTF-8 text.', 422);
      }
      if (!text.trim()) return fail('The Markdown file is empty.', 422);
      const { title, body } = markdownFromFile(text, link.title, link.filename);
      work = ingestMarkdown(project, { section: link.section, title, body, folder }, scope);
    }
  } catch (err) {
    if (err instanceof UploadError) return fail(err.message, 422);
    throw err;
  }

  const record = work.then(
    (r) => {
      setStatus(uploadId, { state: r.status === 'duplicate' ? 'duplicate' : 'created', result: { ...r } });
      return r;
    },
    (err: Error) => {
      setStatus(uploadId, {
        state: 'failed',
        error: err instanceof UploadError ? err.message : 'The upload failed on the server.',
      });
      throw err;
    },
  );
  let result: UploadResult | null;
  try {
    result = await raceDeadline(record, linkConfig().deadlineMs);
  } catch (err) {
    if (err instanceof UploadError) return json({ error: err.message, uploadId }, 422);
    throw err;
  }
  if (!result) {
    return json(
      { status: 'processing', uploadId, next: 'Still working; call get_upload_status {uploadId}.' },
      202,
    );
  }
  return json({ ...result, uploadId }, result.status === 'created' ? 201 : 200);
}
