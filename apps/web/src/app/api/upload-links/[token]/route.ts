// PUT /api/upload-links/<token>: the file-bytes half of the MCP create_upload_link flow. Public in proxy.ts and
// authorized solely by the single-use token (lib/mcp/upload-links.ts); it never reads cookies or the bearer.
// Only PUT is exported, so every other verb is a 405, and there is no CORS handling, so a cross-origin
// browser PUT fails its preflight. Logs mention only the uploadId, never the token.

import {
  ingestMarkdown,
  ingestPdf,
  markdownFromFile,
  mcpWriteEnabled,
  raceDeadline,
  type UploadResult,
} from '@/lib/mcp/upload';
import { claimLink, linkConfig, peekLink, setStatus, TOKEN_RE } from '@/lib/mcp/upload-links';
import { getProjectById } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => Response.json(body, { status });
const GONE =
  'This upload link is invalid, already used or expired. Ask Claude for a new one (create_upload_link).';

/** Reads the body, counting bytes; null once it exceeds `max` (the stream is cancelled). */
async function readBody(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function PUT(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!mcpWriteEnabled()) return json({ error: 'Not found.' }, 404);
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return json({ error: GONE }, 410);
  const peeked = peekLink(token);
  if (!peeked) return json({ error: GONE }, 410);

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

  const bytes = await readBody(req.body, link.maxBytes);
  if (!bytes)
    return fail(`The file is over this link's ${Math.round(link.maxBytes / 1048576)} MB limit.`, 413);
  if (bytes.byteLength !== declared) {
    return fail(
      `Incomplete upload: received ${bytes.byteLength} of ${declared} bytes. Ask Claude for a new link and retry.`,
      400,
    );
  }

  const project = await getProjectById(link.projectId);
  if (!project || project.kind !== 'course') return fail('The course for this link no longer exists.', 422);
  const folder = { id: link.folderId, name: link.folderName };
  let work: Promise<UploadResult>;
  try {
    if (link.kind === 'pdf') {
      work = ingestPdf(project, { data: bytes, fileName: link.filename, title: link.title, folder });
    } else {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return fail('The file is not valid UTF-8 text.', 422);
      }
      if (!text.trim()) return fail('The Markdown file is empty.', 422);
      const { title, body } = markdownFromFile(text, link.title, link.filename);
      work = ingestMarkdown(project, { section: link.section, title, body, folder });
    }
  } catch (err) {
    return fail((err as Error).message, 422);
  }

  const record = work.then(
    (r) => {
      setStatus(uploadId, { state: r.status === 'duplicate' ? 'duplicate' : 'created', result: { ...r } });
      return r;
    },
    (err: Error) => {
      setStatus(uploadId, { state: 'failed', error: err.message });
      throw err;
    },
  );
  let result: UploadResult | null;
  try {
    result = await raceDeadline(record, linkConfig().deadlineMs);
  } catch (err) {
    return json({ error: (err as Error).message, uploadId }, 422);
  }
  if (!result) {
    return json(
      { status: 'processing', uploadId, next: 'Still working; call get_upload_status {uploadId}.' },
      202,
    );
  }
  return json({ ...result, uploadId }, result.status === 'created' ? 201 : 200);
}
