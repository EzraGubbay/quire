import { createHash } from 'node:crypto';
// upload_markdown / upload_pdf orchestration with the data layer mocked: caps, validation, course and folder
// resolution, idempotency, the deadline, and side effects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMarkdownDocument = vi.fn();
const listFolders = vi.fn();
const createPdfDocument = vi.fn();
vi.mock('@/lib/documents', () => ({ createMarkdownDocument, createPdfDocument, listFolders }));
const createNote = vi.fn();
vi.mock('@/lib/notes', () => ({ createNote }));
const indexOwner = vi.fn();
vi.mock('@/lib/ai/index', () => ({ indexOwner }));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath }));
const findNoteByTitle = vi.fn();
const findMarkdownDoc = vi.fn();
const findDuplicatePdf = vi.fn();
const setContentHash = vi.fn();
vi.mock('./upload-store', () => ({ findNoteByTitle, findMarkdownDoc, findDuplicatePdf, setContentHash }));
const resolveCourse = vi.fn();
vi.mock('./courses', () => ({ resolveCourse }));

const { createUploadLinkTool, ingestPdf, raceDeadline, splitTitle, uploadMarkdown, uploadStatusTool } =
  await import('./upload');
const { __storeForTests, setStatus } = await import('./upload-links');

const project = { id: 'p1', slug: 'algo', name: 'Algorithms', kind: 'course' };

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pdfDoc = (over = {}) => ({
  id: 'd1',
  title: 'Lecture',
  pageCount: 3,
  fileSize: pdfBytes.length,
  ...over,
});

beforeEach(() => {
  __storeForTests().links.clear();
  __storeForTests().statuses.clear();
  vi.clearAllMocks();
  resolveCourse.mockResolvedValue(project);
  listFolders.mockResolvedValue([]);
  findNoteByTitle.mockResolvedValue(undefined);
  findDuplicatePdf.mockResolvedValue(undefined);
  createPdfDocument.mockResolvedValue(pdfDoc());
  findMarkdownDoc.mockResolvedValue(undefined);
  indexOwner.mockResolvedValue(undefined);
  createNote.mockResolvedValue({ id: 'n1', slug: 'my-note', title: 'My note' });
  createMarkdownDocument.mockResolvedValue({ id: 'm1' });
});
afterEach(() => {
  delete process.env.MCP_UPLOAD_MAX_MARKDOWN_BYTES;
});

describe('splitTitle', () => {
  it('takes the title from the leading H1 and strips it', () => {
    expect(splitTitle('# Heap sort\n\nBody', undefined)).toEqual({ title: 'Heap sort', body: 'Body' });
  });
  it('strips a leading H1 that matches an explicit title (any case)', () => {
    expect(splitTitle('# heap SORT\nBody', 'Heap sort').body).toBe('Body');
  });
  it('keeps a different H1 when the title is explicit', () => {
    expect(splitTitle('# Other\nBody', 'Mine')).toEqual({ title: 'Mine', body: '# Other\nBody' });
  });
  it('errors with no title and no H1', () => {
    expect(() => splitTitle('just text', undefined)).toThrow(/No title/);
  });
  it('normalizes CRLF and trailing whitespace', () => {
    expect(splitTitle('# T\r\n\r\nline\r\n\r\n', undefined).body).toBe('line');
  });
});

describe('splitTitle edge cases', () => {
  it('keeps a trailing # that belongs to the title', () => {
    expect(splitTitle('# C#\nbody').title).toBe('C#');
  });
  it('drops closing #s that follow whitespace', () => {
    expect(splitTitle('# Title ##\nbody').title).toBe('Title');
  });
  it('treats a 4-space-indented heading as code, not a title', () => {
    expect(() => splitTitle('    # code\nbody')).toThrow(/No title/);
  });
});

describe('uploadMarkdown validation', () => {
  it('rejects empty, over-long titles and over-cap bodies (UTF-8 bytes)', async () => {
    await expect(uploadMarkdown({ course: 'algo', markdown: '  \n', title: 'x' })).rejects.toThrow(/empty/);
    await expect(uploadMarkdown({ course: 'algo', markdown: 'x', title: 'a'.repeat(201) })).rejects.toThrow(
      /200/,
    );
    process.env.MCP_UPLOAD_MAX_MARKDOWN_BYTES = '100';
    // 60 Hebrew letters = 60 chars but 120 bytes
    await expect(uploadMarkdown({ course: 'algo', markdown: 'א'.repeat(60), title: 'x' })).rejects.toThrow(
      /limit/,
    );
    expect(createNote).not.toHaveBeenCalled();
  });
  it('refuses unknown courses and research projects', async () => {
    resolveCourse.mockResolvedValueOnce(undefined);
    await expect(uploadMarkdown({ course: 'nope', markdown: 'x', title: 't' })).rejects.toThrow(
      /list_courses/,
    );
    resolveCourse.mockResolvedValueOnce({ ...project, kind: 'research' });
    await expect(uploadMarkdown({ course: 'algo', markdown: 'x', title: 't' })).rejects.toThrow(
      /list_courses/,
    );
  });
});

describe('folders', () => {
  const folders = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Week 1' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Week 2' },
  ];
  it('matches by name case-insensitively and by id, with the section scope', async () => {
    listFolders.mockResolvedValue(folders);
    const r = await uploadMarkdown({ course: 'algo', markdown: 'b', title: 't', folder: ' week 2 ' });
    expect(listFolders).toHaveBeenCalledWith('p1', 'notes');
    expect(createNote).toHaveBeenCalledWith('p1', 't', 'b', { folderId: folders[1]?.id });
    expect(r.folder).toBe('Week 2');
    await uploadMarkdown({
      course: 'algo',
      markdown: 'b',
      title: 't2',
      section: 'documents',
      folder: folders[0]?.id,
    });
    expect(listFolders).toHaveBeenLastCalledWith('p1', 'documents');
    expect(createMarkdownDocument).toHaveBeenCalledWith('p1', 't2', 'b', folders[0]?.id);
  });
  it('lists existing names for an unknown folder, ids for an ambiguous one', async () => {
    listFolders.mockResolvedValue(folders);
    await expect(
      uploadMarkdown({ course: 'algo', markdown: 'b', title: 't', folder: 'Nope' }),
    ).rejects.toThrow(/"Week 1", "Week 2"/);
    listFolders.mockResolvedValue([folders[0], { ...folders[1], name: 'WEEK 1' }]);
    await expect(
      uploadMarkdown({ course: 'algo', markdown: 'b', title: 't', folder: 'week 1' }),
    ).rejects.toThrow(/2222/);
  });
});

describe('markdown idempotency', () => {
  it('notes: same title (other case) and body is a duplicate', async () => {
    findNoteByTitle.mockResolvedValue({ id: 'n9', slug: 's', title: 'My Note', body: 'text' });
    const r = await uploadMarkdown({ course: 'algo', markdown: 'text\n', title: 'my note' });
    expect(r).toMatchObject({ status: 'duplicate', noteId: 'n9' });
    expect(createNote).not.toHaveBeenCalled();
  });
  it('notes: same title, different body errors with the existing id', async () => {
    findNoteByTitle.mockResolvedValue({ id: 'n9', slug: 's', title: 'My Note', body: 'old' });
    await expect(uploadMarkdown({ course: 'algo', markdown: 'new', title: 'My Note' })).rejects.toThrow(/n9/);
    expect(createNote).not.toHaveBeenCalled();
  });
  it('documents: identical title+body is a duplicate; same title with another body is created', async () => {
    findMarkdownDoc.mockResolvedValueOnce({ id: 'm9' });
    expect(
      await uploadMarkdown({ course: 'algo', markdown: 'b', title: 't', section: 'documents' }),
    ).toMatchObject({
      status: 'duplicate',
      fileId: 'm9',
    });
    expect(
      await uploadMarkdown({ course: 'algo', markdown: 'b2', title: 't', section: 'documents' }),
    ).toMatchObject({
      status: 'created',
      fileId: 'm1',
    });
  });
});

describe('markdown result and side effects', () => {
  it('creates a note, indexes it, revalidates, and survives a throwing revalidatePath', async () => {
    revalidatePath.mockImplementation(() => {
      throw new Error('outside request scope');
    });
    const r = await uploadMarkdown({ course: 'algo', markdown: '# My note\n\nHello' });
    expect(createNote).toHaveBeenCalledWith('p1', 'My note', 'Hello', { folderId: null });
    expect(indexOwner).toHaveBeenCalledWith('p1', 'note', 'n1');
    expect(revalidatePath).toHaveBeenCalledWith('/c/algo/notes');
    expect(r).toMatchObject({ status: 'created', section: 'notes', noteId: 'n1', title: 'My note' });
    expect(r.openUrl).toBe('https://quire.ezragubbay.com/c/algo/notes/my-note');
    revalidatePath.mockReset();
  });
  it('documents: result carries a get_file hint and indexes as a document', async () => {
    const r = await uploadMarkdown({ course: 'algo', markdown: '# Doc\nx', section: 'documents' });
    expect(indexOwner).toHaveBeenCalledWith('p1', 'document', 'm1');
    expect(r.next).toContain('get_file');
    expect(r.openUrl).toBe('https://quire.ezragubbay.com/c/algo/documents/m1');
  });
});

describe('duplicates and concurrency', () => {
  const folders = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Week 1' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Week 2' },
  ];
  it("reports the existing note's real folder and says nothing was moved", async () => {
    listFolders.mockResolvedValue(folders);
    findNoteByTitle.mockResolvedValue({
      id: 'n9',
      slug: 's',
      title: 'T',
      body: 'b',
      folderId: folders[1]?.id,
    });
    const r = await uploadMarkdown({ course: 'algo', markdown: 'b', title: 'T', folder: 'Week 1' });
    expect(r).toMatchObject({ status: 'duplicate', folder: 'Week 2' });
    expect(r.next).toMatch(/Week 2.*nothing was moved/);
  });
  it('same for a markdown document at the top level', async () => {
    listFolders.mockResolvedValue(folders);
    findMarkdownDoc.mockResolvedValue({ id: 'm9', folderId: null });
    const r = await uploadMarkdown({
      course: 'algo',
      markdown: 'b',
      title: 'T',
      section: 'documents',
      folder: 'Week 1',
    });
    expect(r).toMatchObject({ status: 'duplicate', folder: null });
    expect(r.next).toMatch(/top level.*nothing was moved/);
  });
  it('adds no move note when the folder matches', async () => {
    findNoteByTitle.mockResolvedValue({ id: 'n9', slug: 's', title: 'T', body: 'b', folderId: null });
    const r = await uploadMarkdown({ course: 'algo', markdown: 'b', title: 'T' });
    expect(r.next).not.toMatch(/moved/);
  });
  it('two concurrent identical calls create one note', async () => {
    let release!: () => void;
    createNote.mockImplementation(
      () =>
        new Promise((res) => {
          release = () => res({ id: 'n1', slug: 's', title: 'T' });
        }),
    );
    const a = uploadMarkdown({ course: 'algo', markdown: 'b', title: 'T' });
    const b = uploadMarkdown({ course: 'algo', markdown: 'b', title: 'T' });
    await vi.waitFor(() => expect(createNote).toHaveBeenCalled());
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect([ra.noteId, rb.noteId]).toEqual(['n1', 'n1']);
  });
  it('document titles differing only by case are not joined', async () => {
    await uploadMarkdown({ course: 'algo', markdown: 'b', title: 'T', section: 'documents' });
    await uploadMarkdown({ course: 'algo', markdown: 'b', title: 't', section: 'documents' });
    expect(createMarkdownDocument).toHaveBeenCalledTimes(2);
  });
  it('rejects markdown that is empty once the H1 is stripped', async () => {
    await expect(uploadMarkdown({ course: 'algo', markdown: '# Only title\n' })).rejects.toThrow(/no text/);
  });
});

describe('create_upload_link', () => {
  const folders = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Week 1' }];
  it('returns a bound link with a ready curl', async () => {
    const r = await createUploadLinkTool({ course: 'algo', section: 'documents', filename: "O'Brien.pdf" });
    expect(r.uploadUrl).toMatch(/^https:\/\/quire\.ezragubbay\.com\/api\/upload-links\/[A-Za-z0-9_-]{43}$/);
    expect(Math.abs(new Date(r.expiresAt).getTime() - (Date.now() + 600_000))).toBeLessThan(2000);
    expect(r.maxBytes).toBe(100 * 1024 * 1024);
    expect(r.curl).toContain("-T './O'\\''Brien.pdf'");
    expect(r.curl).toContain("-H 'content-type: application/pdf'");
    expect(r.curl).toContain(`'${r.uploadUrl}'`);
    const md = await createUploadLinkTool({ course: 'algo', section: 'notes', filename: 'n.md' });
    expect(md.maxBytes).toBe(2 * 1024 * 1024);
    expect(md.contentType).toBe('text/markdown');
  });
  it('rejects bad filenames, notes+pdf and content type mismatches', async () => {
    await expect(
      createUploadLinkTool({ course: 'algo', section: 'documents', filename: 'x.docx' }),
    ).rejects.toThrow(/\.pdf, \.md/);
    await expect(
      createUploadLinkTool({ course: 'algo', section: 'notes', filename: 'x.pdf' }),
    ).rejects.toThrow(/Notes hold Markdown/);
    await expect(
      createUploadLinkTool({
        course: 'algo',
        section: 'documents',
        filename: 'x.pdf',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow(/does not match/);
    expect(
      (
        await createUploadLinkTool({
          course: 'algo',
          section: 'notes',
          filename: 'x.md',
          contentType: 'text/markdown; charset=utf-8',
        })
      ).contentType,
    ).toBe('text/markdown');
  });
  it('refuses unknown courses and research projects, and resolves the folder at creation', async () => {
    resolveCourse.mockResolvedValueOnce(undefined);
    await expect(
      createUploadLinkTool({ course: 'x', section: 'documents', filename: 'a.pdf' }),
    ).rejects.toThrow(/list_courses/);
    resolveCourse.mockResolvedValueOnce({ ...project, kind: 'research' });
    await expect(
      createUploadLinkTool({ course: 'x', section: 'documents', filename: 'a.pdf' }),
    ).rejects.toThrow(/list_courses/);
    listFolders.mockResolvedValue(folders);
    const r = await createUploadLinkTool({
      course: 'algo',
      section: 'notes',
      filename: 'a.md',
      folder: 'week 1',
    });
    expect(listFolders).toHaveBeenCalledWith('p1', 'notes');
    expect(r.folder).toBe('Week 1');
    await expect(
      createUploadLinkTool({ course: 'algo', section: 'notes', filename: 'a.md', folder: 'nope' }),
    ).rejects.toThrow(/Week 1/);
  });
});

describe('get_upload_status', () => {
  it('reports states and explains unknown ids', async () => {
    const r = await createUploadLinkTool({ course: 'algo', section: 'documents', filename: 'a.pdf' });
    expect(uploadStatusTool({ uploadId: r.uploadId })).toMatchObject({ state: 'pending' });
    setStatus(r.uploadId, { state: 'created', result: { fileId: 'd1' } });
    expect(uploadStatusTool({ uploadId: r.uploadId })).toMatchObject({
      state: 'created',
      result: { fileId: 'd1' },
    });
    expect(uploadStatusTool({ uploadId: 'nope' })).toMatch(/Unknown uploadId/);
  });
});

describe('ingestPdf', () => {
  const folder = { id: null, name: null };
  it('rejects non-PDF bytes', async () => {
    await expect(
      ingestPdf(project as never, { data: new TextEncoder().encode('hello'), fileName: 'a.pdf', folder }),
    ).rejects.toThrow(/not a PDF/);
  });
  it('creates, appends .pdf, records the hash, indexes and revalidates', async () => {
    const r = await ingestPdf(project as never, {
      data: pdfBytes,
      fileName: 'lec',
      title: ' T ',
      sourceUrl: 'https://x/y.pdf',
      folder,
    });
    expect(createPdfDocument).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ fileName: 'lec.pdf', sourceUrl: 'https://x/y.pdf', meta: { title: 'T' } }),
    );
    expect(setContentHash).toHaveBeenCalledWith('d1', sha(pdfBytes));
    expect(indexOwner).toHaveBeenCalledWith('p1', 'document', 'd1');
    expect(revalidatePath).toHaveBeenCalledWith('/c/algo/documents');
    expect(r).toMatchObject({ status: 'created', fileId: 'd1', pageCount: 3 });
  });
  it('wraps extractor failures and returns duplicates', async () => {
    createPdfDocument.mockRejectedValueOnce(new Error('bad xref'));
    await expect(ingestPdf(project as never, { data: pdfBytes, fileName: 'a.pdf', folder })).rejects.toThrow(
      'Could not read that PDF: bad xref',
    );
    findDuplicatePdf.mockResolvedValue(pdfDoc({ id: 'old' }));
    const r = await ingestPdf(project as never, { data: pdfBytes, fileName: 'a.pdf', folder });
    expect(r).toMatchObject({ status: 'duplicate', fileId: 'old' });
    expect(findDuplicatePdf).toHaveBeenCalledWith('p1', sha(pdfBytes), pdfBytes.length);
  });
  it('two concurrent identical calls create one document', async () => {
    let release!: () => void;
    createPdfDocument.mockImplementation(
      () =>
        new Promise((res) => {
          release = () => res(pdfDoc());
        }),
    );
    const a = ingestPdf(project as never, { data: pdfBytes, fileName: 'a.pdf', folder });
    const b = ingestPdf(project as never, { data: pdfBytes, fileName: 'a.pdf', folder });
    await vi.waitFor(() => expect(createPdfDocument).toHaveBeenCalled());
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(createPdfDocument).toHaveBeenCalledTimes(1);
    expect([ra.fileId, rb.fileId]).toEqual(['d1', 'd1']);
  });
});

describe('raceDeadline', () => {
  it('returns null when late, finishes in the background, and does not leak rejections', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const late = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('late')), 40));
    expect(await raceDeadline(late, 10)).toBeNull();
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    err.mockRestore();
    const ok = { status: 'created' } as never;
    expect(await raceDeadline(Promise.resolve(ok), 1000)).toBe(ok);
  });
});
