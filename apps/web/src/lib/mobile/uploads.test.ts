import { describe, expect, it, vi } from 'vitest';
import { UploadJob } from './schema';
import { readIdempotencyKey, readRawPdf, runUploadJob, toUploadJob } from './uploads';

const pdf = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://x/u', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...headers },
    body,
    // @ts-expect-error node fetch needs duplex for stream bodies
    duplex: 'half',
  });

describe('readIdempotencyKey', () => {
  it('returns the trimmed key', () => {
    expect(readIdempotencyKey(pdf('x', { 'Idempotency-Key': '  abc ' }))).toBe('abc');
  });
  it('rejects missing, blank and oversized keys', () => {
    expect(readIdempotencyKey(pdf('x'))).toBeNull();
    expect(readIdempotencyKey(pdf('x', { 'Idempotency-Key': '   ' }))).toBeNull();
    expect(readIdempotencyKey(pdf('x', { 'Idempotency-Key': 'k'.repeat(256) }))).toBeNull();
  });
});

describe('readRawPdf', () => {
  it('reads the raw body as bytes', async () => {
    const r = await readRawPdf(pdf('%PDF-1.4\n'));
    expect(r.ok && new TextDecoder().decode(r.bytes)).toBe('%PDF-1.4\n');
  });
  it('rejects a non-PDF content type', async () => {
    const r = await readRawPdf(pdf('x', { 'Content-Type': 'multipart/form-data; boundary=a' }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('rejects an empty body', async () => {
    expect(await readRawPdf(pdf(''))).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('rejects a body over the limit with too_large', async () => {
    expect(await readRawPdf(pdf('123456'), 5)).toMatchObject({ ok: false, code: 'too_large' });
  });
  it('enforces the limit on the stream even without a content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
        c.enqueue(new Uint8Array(4));
        c.close();
      },
    });
    expect(await readRawPdf(pdf(stream), 5)).toMatchObject({ ok: false, code: 'too_large' });
  });
});

describe('toUploadJob', () => {
  it('omits absent fileId/error and matches the contract', () => {
    const j = toUploadJob({ id: 'u1', status: 'queued', fileId: null, error: null });
    expect(j).toEqual({ uploadId: 'u1', status: 'queued' });
    expect(UploadJob.parse(j)).toEqual(j);
  });
  it('includes fileId when done and error when failed', () => {
    expect(toUploadJob({ id: 'u', status: 'done', fileId: 'f', error: null })).toEqual({
      uploadId: 'u',
      status: 'done',
      fileId: 'f',
    });
    expect(toUploadJob({ id: 'u', status: 'failed', fileId: null, error: 'bad' })).toEqual({
      uploadId: 'u',
      status: 'failed',
      error: 'bad',
    });
  });
});

describe('runUploadJob', () => {
  const mk = () => ({
    setProcessing: vi.fn(async () => {}),
    setDone: vi.fn(async () => {}),
    setFailed: vi.fn(async () => {}),
    createDoc: vi.fn(async () => ({ id: 'doc1', filePath: 'a.pdf' as string | null })),
    index: vi.fn(async () => {}),
    revalidate: vi.fn(),
  });

  it('creates the document, indexes it, then marks done with the fileId', async () => {
    const d = mk();
    await runUploadJob('job1', 'proj1', new Uint8Array([1]), d);
    expect(d.setProcessing).toHaveBeenCalledWith('job1');
    expect(d.createDoc).toHaveBeenCalledWith(
      'proj1',
      expect.objectContaining({ fileName: expect.stringMatching(/\.pdf$/) }),
    );
    expect(d.index).toHaveBeenCalledWith('proj1', 'document', 'doc1');
    expect(d.setDone).toHaveBeenCalledWith('job1', 'doc1');
    expect(d.revalidate).toHaveBeenCalled();
    expect(d.setFailed).not.toHaveBeenCalled();
  });

  it('marks failed with the error when ingestion throws', async () => {
    const d = mk();
    d.createDoc.mockRejectedValueOnce(new Error('not a pdf'));
    await runUploadJob('job1', 'proj1', new Uint8Array([1]), d);
    expect(d.setFailed).toHaveBeenCalledWith('job1', 'Could not read the PDF: not a pdf');
    expect(d.index).not.toHaveBeenCalled();
    expect(d.setDone).not.toHaveBeenCalled();
  });

  it('still marks done when indexing fails (same as the web route)', async () => {
    const d = mk();
    d.index.mockRejectedValueOnce(new Error('ai down'));
    await runUploadJob('job1', 'proj1', new Uint8Array([1]), d);
    expect(d.setDone).toHaveBeenCalledWith('job1', 'doc1');
  });
});
