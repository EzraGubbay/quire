import { describe, expect, it, vi } from 'vitest';
import { UploadJob } from './schema';
import {
  decodeMarkdown,
  readIdempotencyKey,
  readRawPdf,
  readUpload,
  runUploadJob,
  sanitizeUploadName,
  titleFromUpload,
  toUploadJob,
} from './uploads';

const pdf = (body: BodyInit | null, headers: Record<string, string> = {}, query = '') =>
  new Request(`http://x/u${query}`, {
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
    expect(j).toEqual({ uploadId: 'u1', status: 'queued', kind: 'document' });
    expect(UploadJob.parse(j)).toEqual(j);
  });
  it('includes fileId when done and error when failed', () => {
    expect(toUploadJob({ id: 'u', status: 'done', fileId: 'f', error: null })).toEqual({
      uploadId: 'u',
      status: 'done',
      kind: 'document',
      fileId: 'f',
    });
    expect(toUploadJob({ id: 'u', status: 'failed', fileId: null, error: 'bad' })).toEqual({
      uploadId: 'u',
      status: 'failed',
      kind: 'document',
      error: 'bad',
    });
  });
  it('emits kind and noteId for a note job', () => {
    const j = toUploadJob({
      id: 'u',
      status: 'done',
      fileId: null,
      noteId: 'n1',
      target: 'note',
      error: null,
    });
    expect(j).toEqual({ uploadId: 'u', status: 'done', kind: 'note', noteId: 'n1' });
    expect(UploadJob.parse(j)).toEqual(j);
  });
});

const md = (body: BodyInit | null, query = '', type = 'text/markdown; charset=utf-8') =>
  pdf(body, { 'Content-Type': type }, query);

describe('readUpload', () => {
  it('defaults to a PDF document with the legacy file name (backward compatible)', async () => {
    const r = await readUpload(pdf('%PDF-1.4\n'));
    expect(r).toMatchObject({ ok: true, format: 'pdf', target: 'document', fileName: 'mobile-upload.pdf' });
  });
  it('reads Markdown as a note with the name', async () => {
    const r = await readUpload(md('# hi', '?kind=note&name=week1.md'));
    expect(r).toMatchObject({ ok: true, format: 'markdown', target: 'note', fileName: 'week1.md' });
  });
  it('accepts text/x-markdown and defaults Markdown to a document', async () => {
    const r = await readUpload(md('# hi', '', 'text/x-markdown'));
    expect(r).toMatchObject({
      ok: true,
      format: 'markdown',
      target: 'document',
      fileName: 'mobile-upload.md',
    });
  });
  it('rejects a PDF as a note, an unknown kind and unsupported types', async () => {
    expect(await readUpload(pdf('x', {}, '?kind=note'))).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(await readUpload(md('x', '?kind=bogus'))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await readUpload(md('x', '', 'text/plain'))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await readUpload(md('x', '', 'image/png'))).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('rejects an empty body', async () => {
    expect(await readUpload(md(''))).toMatchObject({ ok: false, code: 'invalid_request' });
  });
  it('caps Markdown at 2 MB with the 2 MB message, but still takes a 2.5 MB PDF', async () => {
    const r = await readUpload(md(new Uint8Array(2 * 1024 * 1024 + 1)));
    expect(r).toMatchObject({ ok: false, code: 'too_large', message: 'Upload is larger than 2 MB' });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1024 * 1024));
        c.enqueue(new Uint8Array(1024 * 1024 + 1));
        c.close();
      },
    });
    expect(await readUpload(md(stream))).toMatchObject({ ok: false, code: 'too_large' });
    expect((await readUpload(pdf(new Uint8Array(2.5 * 1024 * 1024)))).ok).toBe(true);
  });
  it('reduces the name to its basename and round-trips Hebrew', async () => {
    const q = (n: string) => `?name=${encodeURIComponent(n)}`;
    expect(await readUpload(pdf('x', {}, q('../../a.pdf')))).toMatchObject({ fileName: 'a.pdf' });
    expect(await readUpload(pdf('x', {}, q('C:\\x\\a.pdf')))).toMatchObject({ fileName: 'a.pdf' });
    expect(await readUpload(pdf('x', {}, q('הרצאה 3.pdf')))).toMatchObject({ fileName: 'הרצאה 3.pdf' });
  });
});

describe('PDF names always end in .pdf', () => {
  const q = (n: string) => `?name=${encodeURIComponent(n)}`;
  it('appends .pdf to extensionless or foreign names', async () => {
    expect(await readUpload(pdf('x', {}, q('Lecture 3')))).toMatchObject({ fileName: 'Lecture 3.pdf' });
    expect(await readUpload(pdf('x', {}, q('x.pptx')))).toMatchObject({ fileName: 'x.pptx.pdf' });
    expect(await readUpload(pdf('x', {}, q('A.PDF')))).toMatchObject({ fileName: 'A.PDF' });
  });
  it('keeps the extension when a 300-char name is truncated', async () => {
    const r = await readUpload(pdf('x', {}, q('a'.repeat(300))));
    expect(r.ok && r.fileName.endsWith('.pdf') && [...r.fileName].length === 255).toBe(true);
    const r2 = await readUpload(pdf('x', {}, q(`${'b'.repeat(300)}.pdf`)));
    expect(r2.ok && r2.fileName.endsWith('.pdf')).toBe(true);
  });
  it('does not touch Markdown names', async () => {
    expect(await readUpload(md('x', q('week1')))).toMatchObject({ fileName: 'week1' });
  });
});

describe('sanitizeUploadName', () => {
  it('strips control, C1, zero-width and bidi characters', () => {
    expect(sanitizeUploadName('a\u0000b\u0085c\u202ed\u200be\ufefff.md', 'f')).toBe('abcdef.md');
  });
  it('falls back when nothing is left', () => {
    expect(sanitizeUploadName('\u202e\u0001', 'fb.md')).toBe('fb.md');
    expect(sanitizeUploadName(null, 'fb.md')).toBe('fb.md');
  });
  it('caps at 255 code points without splitting surrogate pairs', () => {
    const out = sanitizeUploadName('😀'.repeat(300), 'f');
    expect([...out]).toHaveLength(255);
    expect(out).toBe('😀'.repeat(255));
  });
});

describe('decodeMarkdown', () => {
  it('decodes UTF-8 and strips a BOM', () => {
    expect(decodeMarkdown(new TextEncoder().encode('שלום'))).toBe('שלום');
    expect(decodeMarkdown(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });
  it('returns null for invalid UTF-8', () => {
    expect(decodeMarkdown(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe('titleFromUpload', () => {
  it('derives the title from the file name', () => {
    expect(titleFromUpload('Lecture_03-notes.md')).toBe('Lecture 03 notes');
    expect(titleFromUpload('todo.txt')).toBe('todo');
  });
  it('falls back to the first heading, then Untitled', () => {
    expect(titleFromUpload(null, 'intro\n# Heading\n')).toBe('Heading');
    expect(titleFromUpload('', 'no heading')).toBe('Untitled');
    expect(titleFromUpload(null)).toBe('Untitled');
  });
});

describe('runUploadJob', () => {
  const mk = () => ({
    setProcessing: vi.fn(async () => {}),
    setDone: vi.fn(async () => {}),
    setFailed: vi.fn(async () => {}),
    createDoc: vi.fn(async () => ({ id: 'doc1', filePath: 'a.pdf' as string | null })),
    createMarkdownDoc: vi.fn(async () => ({ id: 'md1' })),
    createNote: vi.fn(async () => ({ id: 'note1' })),
    index: vi.fn(async () => {}),
    revalidate: vi.fn(),
  });
  const job = (over: Partial<Parameters<typeof runUploadJob>[0]> = {}) => ({
    id: 'job1',
    projectId: 'proj1',
    target: 'document' as const,
    format: 'pdf' as const,
    fileName: 'Lecture 3.pdf',
    data: new Uint8Array([1]),
    ...over,
  });
  const text = (t: string) => new TextEncoder().encode(t);

  it('creates the document with the real file name, indexes it, then marks done with the fileId', async () => {
    const d = mk();
    await runUploadJob(job(), d);
    expect(d.setProcessing).toHaveBeenCalledWith('job1');
    expect(d.createDoc).toHaveBeenCalledWith('proj1', expect.objectContaining({ fileName: 'Lecture 3.pdf' }));
    expect(d.index).toHaveBeenCalledWith('proj1', 'document', 'doc1');
    expect(d.setDone).toHaveBeenCalledWith('job1', { fileId: 'doc1' });
    expect(d.revalidate).toHaveBeenCalledWith('document');
    expect(d.setFailed).not.toHaveBeenCalled();
  });

  it('marks failed with the error when ingestion throws', async () => {
    const d = mk();
    d.createDoc.mockRejectedValueOnce(new Error('not a pdf'));
    await runUploadJob(job(), d);
    expect(d.setFailed).toHaveBeenCalledWith('job1', 'Could not read the PDF: not a pdf');
    expect(d.index).not.toHaveBeenCalled();
    expect(d.setDone).not.toHaveBeenCalled();
  });

  it('still marks done when indexing fails (same as the web route)', async () => {
    const d = mk();
    d.index.mockRejectedValueOnce(new Error('ai down'));
    await runUploadJob(job(), d);
    expect(d.setDone).toHaveBeenCalledWith('job1', { fileId: 'doc1' });
  });

  it('Markdown + document creates a Markdown document and is done with a fileId', async () => {
    const d = mk();
    await runUploadJob(job({ format: 'markdown', fileName: 'week_1.md', data: text('# W1') }), d);
    expect(d.createMarkdownDoc).toHaveBeenCalledWith('proj1', 'week 1', '# W1');
    expect(d.index).toHaveBeenCalledWith('proj1', 'document', 'md1');
    expect(d.setDone).toHaveBeenCalledWith('job1', { fileId: 'md1' });
    expect(d.revalidate).toHaveBeenCalledWith('document');
    expect(d.createNote).not.toHaveBeenCalled();
  });

  it('Markdown + note creates a note and is done with a noteId', async () => {
    const d = mk();
    await runUploadJob(
      job({ target: 'note', format: 'markdown', fileName: 'week1.md', data: text('body') }),
      d,
    );
    expect(d.createNote).toHaveBeenCalledWith('proj1', 'week1', 'body');
    expect(d.index).toHaveBeenCalledWith('proj1', 'note', 'note1');
    expect(d.setDone).toHaveBeenCalledWith('job1', { noteId: 'note1' });
    expect(d.revalidate).toHaveBeenCalledWith('note');
  });

  it('marks a note job failed when createNote throws, and done when only indexing fails', async () => {
    const d = mk();
    d.createNote.mockRejectedValueOnce(new Error('db down'));
    const n = job({ target: 'note', format: 'markdown', data: text('x') });
    await runUploadJob(n, d);
    expect(d.setFailed).toHaveBeenCalledWith('job1', 'Could not create the note: db down');
    expect(d.setDone).not.toHaveBeenCalled();
    const d2 = mk();
    d2.index.mockRejectedValueOnce(new Error('ai down'));
    await runUploadJob(n, d2);
    expect(d2.setDone).toHaveBeenCalledWith('job1', { noteId: 'note1' });
  });
});
