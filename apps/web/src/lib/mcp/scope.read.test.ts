// RESEARCH_SCOPE reads through the real courses.ts / content.ts / tool-results.ts over a mocked data layer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const course = { id: '22222222-2222-4222-8222-222222222222', slug: 'algo', name: 'Algo', kind: 'course' };
const research = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'kairos',
  name: 'KAIROS',
  kind: 'research',
};
vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async (s: string) => [research, course].find((p) => p.slug === s)),
  getProjectById: vi.fn(async (id: string) => [research, course].find((p) => p.id === id)),
  listProjects: vi.fn(async () => []),
  projectMeta: vi.fn(() => ({})),
}));
const getDocument = vi.fn();
vi.mock('@/lib/documents', () => ({
  getDocument,
  getDocumentPages: vi.fn(async () => []),
  listDocuments: vi.fn(async () => []),
  countDocuments: vi.fn(async () => 0),
  listFolders: vi.fn(async () => []),
  listPracticeExams: vi.fn(async () => []),
}));
vi.mock('@/lib/sessions', () => ({ listSessions: vi.fn(async () => []), sessionTitle: vi.fn() }));
vi.mock('@/lib/homework', () => ({ listAssignments: vi.fn(async () => []) }));
vi.mock('@/lib/lemida/files', () => ({ lemidaFilesByProject: vi.fn(async () => []) }));
vi.mock('@/lib/files', () => ({ readStoredFile: vi.fn(), filePath: vi.fn() }));

const { resolveFile } = await import('./courses');
const { loadDoc } = await import('./content');
const { oversizeHint } = await import('./tool-results');
const { COURSE_SCOPE, RESEARCH_SCOPE } = await import('./scope');

beforeEach(() => {
  vi.clearAllMocks();
  getDocument.mockResolvedValue({ id: 'd1', kind: 'markdown', title: 'T', markdownBody: 'b' });
});

describe('RESEARCH_SCOPE refuses course projects', () => {
  it('resolveFile, every format, by slug and UUID', async () => {
    for (const ref of ['algo', course.id]) {
      for (const f of ['pdf', 'markdown', 'original', undefined] as const) {
        await expect(resolveFile(ref, 'd1', f, RESEARCH_SCOPE)).rejects.toThrow(
          `No project found for "${ref}"`,
        );
      }
    }
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('loadDoc by slug and UUID; a research project loads', async () => {
    await expect(loadDoc('algo', 'd1', RESEARCH_SCOPE)).rejects.toThrow('No project found');
    await expect(loadDoc(course.id, 'd1', RESEARCH_SCOPE)).rejects.toThrow('No project found');
    expect(getDocument).not.toHaveBeenCalled();
    await expect(loadDoc('kairos', 'd1', RESEARCH_SCOPE)).resolves.toMatchObject({ slug: 'kairos' });
  });
  it('the course scope refuses a research project the same way', async () => {
    await expect(resolveFile('kairos', 'd1', 'pdf', COURSE_SCOPE)).rejects.toThrow('No course found');
  });
});

describe('oversize hint', () => {
  const r = { slug: 'kairos', docId: 'd1', format: 'pdf', filename: 'x.pdf' } as never;
  it('research never prints the /api download URL', () => {
    const hint = oversizeHint(r, RESEARCH_SCOPE);
    expect(hint).not.toContain('/api/');
    expect(hint).toContain('/p/kairos/documents/d1');
  });
  it('course keeps it', () => {
    expect(oversizeHint(r, COURSE_SCOPE)).toContain('/api/projects/kairos/documents/d1/file?download=1');
  });
});
