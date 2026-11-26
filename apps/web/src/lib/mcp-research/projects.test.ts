import { beforeEach, describe, expect, it, vi } from 'vitest';

const KID = '11111111-1111-4111-8111-111111111111';
const research = { id: KID, slug: 'kairos', name: 'KAIROS', description: 'd', kind: 'research' };
const course = { id: '22222222-2222-4222-8222-222222222222', slug: 'algo', name: 'Algo', kind: 'course' };
const listProjects = vi.fn();
vi.mock('@/lib/projects', () => ({
  listProjects,
  getProjectBySlug: vi.fn(async (s: string) => [research, course].find((p) => p.slug === s)),
  getProjectById: vi.fn(async (id: string) => [research, course].find((p) => p.id === id)),
}));
const listDocuments = vi.fn();
vi.mock('@/lib/documents', () => ({
  listDocuments,
  countDocuments: vi.fn(async () => 2),
  listFolders: vi.fn(async (_id: string, scope: string) =>
    scope === 'notes' ? [{ id: 'nf', name: 'Ideas' }] : [{ id: 'df', name: 'Papers' }],
  ),
}));
const getNote = vi.fn();
vi.mock('@/lib/notes', () => ({
  getNote,
  listNotes: vi.fn(async () => [
    { id: 'n1', title: 'N', folderId: 'nf', updatedAt: new Date('2026-01-01T00:00:00Z') },
  ]),
}));
vi.mock('@/lib/sources', () => ({
  listSources: vi.fn(async () => [
    { id: 's1', type: 'web', title: 'S', url: 'https://x.y', description: 'z'.repeat(500), tags: ['t'] },
  ]),
}));

const { getNoteMarkdown, listProjectFiles, listResearchProjects } = await import('./projects');

beforeEach(() => {
  vi.clearAllMocks();
  listDocuments.mockResolvedValue([
    {
      id: 'd1',
      title: 'Attention',
      kind: 'pdf',
      folderId: 'df',
      pageCount: 5,
      fileSize: 10,
      filePath: 'p/d1.pdf',
      originalPath: null,
      readingStatus: 'unread',
      tags: [],
      authors: ['A'],
      year: 2017,
      arxivId: '1706.03762',
      doi: null,
      sourceUrl: null,
      abstract: 'a'.repeat(500),
    },
    {
      id: 'd2',
      title: 'Plain',
      kind: 'markdown',
      folderId: null,
      filePath: null,
      authors: [],
      year: null,
      abstract: '',
      tags: [],
      readingStatus: 'unread',
    },
  ]);
});

describe('research project data', () => {
  it('lists only research projects', async () => {
    listProjects.mockResolvedValue([research]);
    const r = await listResearchProjects();
    expect(listProjects).toHaveBeenCalledWith({ kind: 'research' });
    expect(r[0]).toMatchObject({ slug: 'kairos', documentCount: 2, noteCount: 1, sourceCount: 1 });
  });
  it('lists documents with paper metadata, notes and sources', async () => {
    const r = await listProjectFiles('kairos');
    expect(r.documents[0]?.paper?.abstract).toHaveLength(300);
    expect(r.documents[0]?.paper?.arxivId).toBe('1706.03762');
    expect(r.documents[0]?.folder).toBe('Papers');
    expect(r.documents[0]?.resourceUri).toBe('quire://research/kairos/file/d1');
    expect(r.documents[1]?.paper).toBeNull();
    expect(r.notes[0]).toMatchObject({ noteId: 'n1', folder: 'Ideas' });
    expect(r.sources[0]?.description).toHaveLength(300);
  });
  it('refuses a course by slug and by UUID', async () => {
    await expect(listProjectFiles('algo')).rejects.toThrow('No research project found');
    await expect(listProjectFiles(course.id)).rejects.toThrow('No research project found');
    expect(listDocuments).not.toHaveBeenCalled();
  });
  it('getNoteMarkdown returns Markdown and refuses a course', async () => {
    getNote.mockResolvedValue({ title: 'T', body: 'b' });
    expect(await getNoteMarkdown('kairos', 'n1')).toBe('# T\n\nb');
    await expect(getNoteMarkdown('algo', 'n1')).rejects.toThrow('No research project found');
  });
});
