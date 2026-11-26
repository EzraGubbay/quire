// Pure parts of the mobile upload endpoint (QMOB-E1-S8): header/raw-body readers, job mapping and the job runner.
// The DB job store lives in uploads-store.ts. The runner takes the SAME ingestion functions the web upload route
// uses (createDeckDocument + indexOwner) as injected deps; nothing is re-implemented here.
import { MAX_MARKDOWN_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from '@/lib/upload-limits';
import type { UploadJob } from './schema';

const MAX_KEY_LEN = 255;

/** The required `Idempotency-Key` header, trimmed; null when missing, blank or too long. */
export function readIdempotencyKey(req: Request): string | null {
  const key = req.headers.get('idempotency-key')?.trim();
  return key && key.length <= MAX_KEY_LEN ? key : null;
}

export type UploadTarget = 'document' | 'note';
export type UploadFormat = 'pdf' | 'markdown';

type Capped = { ok: true; bytes: Uint8Array } | { ok: false; code: 'invalid_request' | 'too_large' };

/** Streams the request body, stopping as soon as it exceeds `max` bytes (works without a Content-Length). */
async function readCapped(req: Request, max: number): Promise<Capped> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { ok: false, code: 'too_large' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: 'too_large' };
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { ok: false, code: 'invalid_request' };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

export type RawPdf =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: 'invalid_request' | 'too_large'; message: string };

/** Reads the raw request body as the PDF, enforcing the content type and size ceiling while streaming. */
export async function readRawPdf(req: Request, maxBytes: number = MAX_UPLOAD_BYTES): Promise<RawPdf> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/pdf')
    return { ok: false, code: 'invalid_request', message: 'Content-Type must be application/pdf' };
  const r = await readCapped(req, maxBytes);
  if (r.ok) return r;
  return r.code === 'too_large'
    ? { ok: false, code: 'too_large', message: 'Upload is larger than 100 MB' }
    : { ok: false, code: 'invalid_request', message: 'Request body is empty' };
}

export type ReadUpload =
  | { ok: true; format: UploadFormat; target: UploadTarget; fileName: string; bytes: Uint8Array }
  | { ok: false; code: 'invalid_request' | 'too_large'; message: string };

const MARKDOWN_TYPES = new Set(['text/markdown', 'text/x-markdown']);

const MAX_NAME_CODEPOINTS = 255;
/** Invisible characters: C0/C1 controls, zero-width, bidi marks and overrides, BOM. */
const isInvisible = (c: number) =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x2064) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0xfeff;

/** Basename only, invisible/control characters stripped, at most 255 code points; `fallback` if nothing is left. */
export function sanitizeUploadName(raw: string | null, fallback: string): string {
  const visible = [...(raw ?? '')].filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0)).join('');
  const base = visible.split(/[\\/]/).pop()?.trim() ?? '';
  return base ? [...base].slice(0, MAX_NAME_CODEPOINTS).join('') : fallback;
}

/**
 * createDeckDocument picks PDF vs Office handling from the name, so a PDF body must carry a `.pdf` name whatever the
 * client sent ("Lecture 3", "x.pptx"). The base is truncated so the extension survives the 255 cap.
 */
export function ensurePdfName(name: string): string {
  if (/\.pdf$/i.test(name)) return name;
  return `${[...name].slice(0, MAX_NAME_CODEPOINTS - 4).join('')}.pdf`;
}

/**
 * Reads a mobile upload: the content type picks the format (PDF or Markdown), `?kind=document|note` the target
 * (default document; notes are Markdown only) and `?name=` the original file name. No params = the original
 * PDF-to-document behaviour.
 */
export async function readUpload(
  req: Request,
  limits: { pdf: number; markdown: number } = { pdf: MAX_UPLOAD_BYTES, markdown: MAX_MARKDOWN_UPLOAD_BYTES },
): Promise<ReadUpload> {
  const bad = (message: string) => ({ ok: false, code: 'invalid_request', message }) as const;
  const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const format: UploadFormat | null =
    type === 'application/pdf' ? 'pdf' : MARKDOWN_TYPES.has(type) ? 'markdown' : null;
  if (!format) return bad('Content-Type must be application/pdf or text/markdown');
  const params = new URL(req.url).searchParams;
  const kind = params.get('kind') ?? 'document';
  if (kind !== 'document' && kind !== 'note') return bad('kind must be document or note');
  if (kind === 'note' && format === 'pdf') return bad('Notes accept Markdown only');
  const cleaned = sanitizeUploadName(
    params.get('name'),
    format === 'pdf' ? 'mobile-upload.pdf' : 'mobile-upload.md',
  );
  const fileName = format === 'pdf' ? ensurePdfName(cleaned) : cleaned;
  const max = format === 'pdf' ? limits.pdf : limits.markdown;
  const r = await readCapped(req, max);
  if (!r.ok)
    return r.code === 'too_large'
      ? {
          ok: false,
          code: 'too_large',
          message: `Upload is larger than ${format === 'pdf' ? '100 MB' : '2 MB'}`,
        }
      : bad('Request body is empty');
  return { ok: true, format, target: kind, fileName, bytes: r.bytes };
}

/** UTF-8 text of a Markdown upload (leading BOM stripped), or null when the bytes are not valid UTF-8. */
export function decodeMarkdown(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** Title from the file name (extension dropped, `_`/`-` runs to spaces), else the first `# ` heading, else Untitled. */
export function titleFromUpload(fileName: string | null, markdown?: string): string {
  const fromName = (fileName ?? '')
    .replace(/\.(md|markdown|txt|text|pdf)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (fromName) return fromName.slice(0, 200);
  const heading = markdown?.match(/^#[ \t]+(.+?)[ \t#]*$/m)?.[1]?.trim();
  return heading ? heading.slice(0, 200) : 'Untitled';
}

export function toUploadJob(row: {
  id: string;
  status: UploadJob['status'];
  fileId: string | null;
  error: string | null;
  target?: string | null;
  noteId?: string | null;
}): UploadJob {
  return {
    uploadId: row.id,
    status: row.status,
    kind: row.target === 'note' ? 'note' : 'document',
    ...(row.fileId ? { fileId: row.fileId } : {}),
    ...(row.noteId ? { noteId: row.noteId } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export interface RunDeps {
  setProcessing(jobId: string): Promise<void>;
  setDone(jobId: string, result: { fileId?: string; noteId?: string }): Promise<void>;
  setFailed(jobId: string, error: string): Promise<void>;
  createDoc(
    projectId: string,
    upload: { fileName: string; data: Uint8Array },
  ): Promise<{ id: string; filePath: string | null }>;
  createMarkdownDoc(projectId: string, title: string, body: string): Promise<{ id: string }>;
  createNote(projectId: string, title: string, body: string): Promise<{ id: string }>;
  index(projectId: string, kind: 'document' | 'note', id: string): Promise<unknown>;
  revalidate(target: UploadTarget): void;
}

export interface RunJob {
  id: string;
  projectId: string;
  target: UploadTarget;
  format: UploadFormat;
  fileName: string;
  data: Uint8Array;
}

/**
 * Background job body: processing -> create the document / Markdown document / note -> indexOwner -> done | failed.
 * Never throws.
 */
export async function runUploadJob(job: RunJob, deps: RunDeps) {
  const { id, projectId, target, format, fileName, data } = job;
  try {
    await deps.setProcessing(id);
    if (format === 'pdf') {
      let doc: { id: string; filePath: string | null };
      try {
        doc = await deps.createDoc(projectId, { fileName, data });
      } catch (err) {
        await deps.setFailed(id, `Could not read the PDF: ${(err as Error).message}`);
        return;
      }
      if (doc.filePath) await deps.index(projectId, 'document', doc.id).catch(() => {});
      await deps.setDone(id, { fileId: doc.id });
      deps.revalidate('document');
      return;
    }
    const body = decodeMarkdown(data);
    if (body === null) {
      await deps.setFailed(id, 'Markdown must be UTF-8 text');
      return;
    }
    const title = titleFromUpload(fileName, body);
    if (target === 'note') {
      let note: { id: string };
      try {
        note = await deps.createNote(projectId, title, body);
      } catch (err) {
        await deps.setFailed(id, `Could not create the note: ${(err as Error).message}`);
        return;
      }
      await deps.index(projectId, 'note', note.id).catch(() => {});
      await deps.setDone(id, { noteId: note.id });
      deps.revalidate('note');
      return;
    }
    let doc: { id: string };
    try {
      doc = await deps.createMarkdownDoc(projectId, title, body);
    } catch (err) {
      await deps.setFailed(id, `Could not create the document: ${(err as Error).message}`);
      return;
    }
    await deps.index(projectId, 'document', doc.id).catch(() => {});
    await deps.setDone(id, { fileId: doc.id });
    deps.revalidate('document');
  } catch (err) {
    await deps.setFailed(id, (err as Error).message).catch(() => {});
  }
}
