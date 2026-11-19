// Pure parts of the mobile upload endpoint (QMOB-E1-S8): header/raw-body readers, job mapping and the job runner.
// The DB job store lives in uploads-store.ts. The runner takes the SAME ingestion functions the web upload route
// uses (createDeckDocument + indexOwner) as injected deps; nothing is re-implemented here.
import { MAX_UPLOAD_BYTES } from '@/lib/upload-limits';
import type { UploadJob } from './schema';

const MAX_KEY_LEN = 255;

/** The required `Idempotency-Key` header, trimmed; null when missing, blank or too long. */
export function readIdempotencyKey(req: Request): string | null {
  const key = req.headers.get('idempotency-key')?.trim();
  return key && key.length <= MAX_KEY_LEN ? key : null;
}

export type RawPdf =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: 'invalid_request' | 'too_large'; message: string };

/** Reads the raw request body as the PDF, enforcing the content type and size ceiling while streaming. */
export async function readRawPdf(req: Request, maxBytes: number = MAX_UPLOAD_BYTES): Promise<RawPdf> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/pdf')
    return { ok: false, code: 'invalid_request', message: 'Content-Type must be application/pdf' };
  const tooLarge = { ok: false, code: 'too_large', message: 'Upload is larger than 100 MB' } as const;
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { ok: false, code: 'invalid_request', message: 'Request body is empty' };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

export function toUploadJob(row: {
  id: string;
  status: UploadJob['status'];
  fileId: string | null;
  error: string | null;
}): UploadJob {
  return {
    uploadId: row.id,
    status: row.status,
    ...(row.fileId ? { fileId: row.fileId } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export interface RunDeps {
  setProcessing(jobId: string): Promise<void>;
  setDone(jobId: string, fileId: string): Promise<void>;
  setFailed(jobId: string, error: string): Promise<void>;
  createDoc(
    projectId: string,
    upload: { fileName: string; data: Uint8Array },
  ): Promise<{ id: string; filePath: string | null }>;
  index(projectId: string, kind: 'document', id: string): Promise<unknown>;
  revalidate(): void;
}

/** Background job body: processing -> createDeckDocument -> indexOwner -> done | failed. Never throws. */
export async function runUploadJob(jobId: string, projectId: string, data: Uint8Array, deps: RunDeps) {
  try {
    await deps.setProcessing(jobId);
    let doc: { id: string; filePath: string | null };
    try {
      doc = await deps.createDoc(projectId, { fileName: 'mobile-upload.pdf', data });
    } catch (err) {
      await deps.setFailed(jobId, `Could not read the PDF: ${(err as Error).message}`);
      return;
    }
    if (doc.filePath) await deps.index(projectId, 'document', doc.id).catch(() => {});
    await deps.setDone(jobId, doc.id);
    deps.revalidate();
  } catch (err) {
    await deps.setFailed(jobId, (err as Error).message).catch(() => {});
  }
}
