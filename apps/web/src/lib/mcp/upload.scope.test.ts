import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMarkdownDocument = vi.fn();
const createPdfDocument = vi.fn();
const listFolders = vi.fn();
vi.mock('@/lib/documents', () => ({ createMarkdownDocument, createPdfDocument, listFolders }));
vi.mock('@/lib/notes', () => ({ createNote: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const findMarkdownDoc = vi.fn();
vi.mock('./upload-store', () => ({
  findMarkdownDoc,
  findNoteByTitle: vi.fn(),
  findDuplicatePdf: vi.fn(),
  setContentHash: vi.fn(),
}));
const getProjectBySlug = vi.fn();
vi.mock('@/lib/projects', () => ({
  getProjectBySlug,
  getProjectById: vi.fn(),
  projectBase: (p: { kind: string; slug: string }) => `/${p.kind === 'course' ? 'c' : 'p'}/${p.slug}`,
}));

const { uploadMarkdown, createUploadLinkTool, uploadStatusTool, UploadError } = await import('./upload');
const { COURSE_SCOPE, RESEARCH_SCOPE } = await import('./scope');
const { __storeForTests } = await import('./upload-links');

const research = { id: 'r1', slug: 'kairos', name: 'KAIROS', kind: 'research' };
const course = { id: 'c1', slug: 'algo', name: 'Algo', kind: 'course' };
const bySlug = (s: string) => [research, course].find((p) => p.slug === s);

beforeEach(() => {
  vi.clearAllMocks();
  __storeForTests().links.clear();
  __storeForTests().statuses.clear();
  getProjectBySlug.mockImplementation(async (s: string) => bySlug(s));
  listFolders.mockResolvedValue([]);
  findMarkdownDoc.mockResolvedValue(undefined);
  createMarkdownDocument.mockResolvedValue({ id: 'm1' });
});

describe('RESEARCH_SCOPE uploads', () => {
  it('creates in a research project with a `project` owner key and read-back hint', async () => {
    const r = await uploadMarkdown(
      { course: 'kairos', section: 'documents', markdown: '# T\n\nbody' },
      RESEARCH_SCOPE,
    );
    expect(r.status).toBe('created');
    expect(r.project).toEqual({ slug: 'kairos', name: 'KAIROS' });
    expect(r.course).toBeUndefined();
    expect(r.next).toContain('get_file {project:"kairos"');
    expect(r.openUrl).toContain('/p/kairos/documents/m1');
  });
  it('refuses a course project with the research wording', async () => {
    const err = await uploadMarkdown({ course: 'algo', markdown: '# T\n\nb' }, RESEARCH_SCOPE).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toMatch(/No project found for "algo".*list_projects/);
  });
  it('the course scope refuses a research project and keeps `course` key', async () => {
    const err = await uploadMarkdown({ course: 'kairos', markdown: '# T\n\nb' }).catch((e) => e);
    expect(err.message).toMatch(/No course found.*list_courses/);
    const ok = await uploadMarkdown({ course: 'algo', section: 'documents', markdown: '# T\n\nb' });
    expect(ok.course).toEqual({ slug: 'algo', name: 'Algo' });
    expect(ok.project).toBeUndefined();
  });
});

describe('links and statuses are bound to their scope', () => {
  it('research link binds scope research; statuses are not visible across servers', async () => {
    const link = await createUploadLinkTool(
      { course: 'kairos', section: 'notes', filename: 'a.md' },
      RESEARCH_SCOPE,
    );
    expect([...__storeForTests().links.values()][0]?.scope).toBe('research');
    expect(link.project).toEqual({ slug: 'kairos', name: 'KAIROS' });
    expect(uploadStatusTool({ uploadId: link.uploadId }, RESEARCH_SCOPE)).toMatchObject({ state: 'pending' });
    expect(uploadStatusTool({ uploadId: link.uploadId }, COURSE_SCOPE)).toMatch(/Unknown uploadId/);
    expect(uploadStatusTool({ uploadId: link.uploadId })).toMatch(/Unknown uploadId/);
  });
  it('course link is unknown to the research server', async () => {
    const link = await createUploadLinkTool({ course: 'algo', section: 'notes', filename: 'a.md' });
    expect(uploadStatusTool({ uploadId: link.uploadId }, RESEARCH_SCOPE)).toMatch(/Unknown uploadId/);
  });
});

describe('uploadStatusTool output', () => {
  it('never exposes the internal scope key (course and research)', async () => {
    const c = await createUploadLinkTool({ course: 'algo', section: 'notes', filename: 'a.md' });
    const cs = uploadStatusTool({ uploadId: c.uploadId });
    expect(cs).not.toHaveProperty('scope');
    expect(Object.keys(cs as object).sort()).toEqual(['expiresAt', 'state', 'updatedAt', 'uploadId']);
    const r = await createUploadLinkTool(
      { course: 'kairos', section: 'notes', filename: 'a.md' },
      RESEARCH_SCOPE,
    );
    expect(uploadStatusTool({ uploadId: r.uploadId }, RESEARCH_SCOPE)).not.toHaveProperty('scope');
  });
});
