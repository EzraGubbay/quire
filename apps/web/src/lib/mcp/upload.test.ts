// upload_markdown / upload_pdf orchestration with the data layer mocked: caps, validation, course and folder
// resolution, idempotency, the deadline, and side effects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMarkdownDocument = vi.fn();
const listFolders = vi.fn();
vi.mock('@/lib/documents', () => ({ createMarkdownDocument, listFolders }));
const createNote = vi.fn();
vi.mock('@/lib/notes', () => ({ createNote }));
const indexOwner = vi.fn();
vi.mock('@/lib/ai/index', () => ({ indexOwner }));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath }));
const findNoteByTitle = vi.fn();
const findMarkdownDoc = vi.fn();
vi.mock('./upload-store', () => ({ findNoteByTitle, findMarkdownDoc }));
const resolveCourse = vi.fn();
vi.mock('./courses', () => ({ resolveCourse }));

const { splitTitle, uploadMarkdown } = await import('./upload');

const project = { id: 'p1', slug: 'algo', name: 'Algorithms', kind: 'course' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveCourse.mockResolvedValue(project);
  listFolders.mockResolvedValue([]);
  findNoteByTitle.mockResolvedValue(undefined);
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
