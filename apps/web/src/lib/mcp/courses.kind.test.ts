// The course MCP must never serve research projects (the leak fixed here): resolveCourse is the single choke point
// every read path goes through. These tests use the REAL courses.ts / content.ts / server.ts over a mocked data layer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KAIROS_ID = '11111111-1111-4111-8111-111111111111';
const COURSE_ID = '22222222-2222-4222-8222-222222222222';
const research = { id: KAIROS_ID, slug: 'kairos', name: 'KAIROS', kind: 'research' };
const course = { id: COURSE_ID, slug: 'parallel', name: 'Parallel', kind: 'course' };

const getProjectBySlug = vi.fn(async (s: string) => [research, course].find((p) => p.slug === s));
const getProjectById = vi.fn(async (id: string) => [research, course].find((p) => p.id === id));
vi.mock('@/lib/projects', () => ({
  getProjectBySlug,
  getProjectById,
  listProjects: vi.fn(async () => []),
  projectMeta: vi.fn(() => ({})),
}));
const getDocument = vi.fn();
const listDocuments = vi.fn(async () => []);
vi.mock('@/lib/documents', () => ({
  getDocument,
  getDocumentPages: vi.fn(async () => []),
  listDocuments,
  countDocuments: vi.fn(async () => 0),
  listFolders: vi.fn(async () => []),
  listPracticeExams: vi.fn(async () => []),
}));
vi.mock('@/lib/sessions', () => ({ listSessions: vi.fn(async () => []), sessionTitle: vi.fn() }));
vi.mock('@/lib/homework', () => ({ listAssignments: vi.fn(async () => []) }));
vi.mock('@/lib/lemida/files', () => ({ lemidaFilesByProject: vi.fn(async () => []) }));
vi.mock('@/lib/files', () => ({ readStoredFile: vi.fn(), filePath: vi.fn() }));

const { resolveCourse, listCourseFiles, resolveFile } = await import('./courses');
const { loadDoc } = await import('./content');
const { registerQuireMcp } = await import('./server');

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type ResourceHandler = (uri: URL, vars: Record<string, string>) => Promise<unknown>;
const tools = new Map<string, Handler>();
let readResource: ResourceHandler;
registerQuireMcp({
  tool: (name: string, ...rest: unknown[]) => tools.set(name, rest.at(-1) as Handler),
  resource: (_n: string, _t: unknown, h: ResourceHandler) => {
    readResource = h;
  },
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  getDocument.mockResolvedValue({
    id: 'd1',
    projectId: 'x',
    kind: 'markdown',
    title: 'T',
    markdownBody: 'b',
  });
});

describe('resolveCourse', () => {
  it('refuses a research project by slug', async () => {
    expect(await resolveCourse('kairos')).toBeUndefined();
  });
  it('refuses a research project by UUID', async () => {
    expect(await resolveCourse(KAIROS_ID)).toBeUndefined();
  });
  it('still resolves a course by slug and by UUID', async () => {
    expect(await resolveCourse('parallel')).toBe(course);
    expect(await resolveCourse(COURSE_ID)).toBe(course);
  });
});

describe('course data layer refuses research projects', () => {
  it('listCourseFiles rejects without listing documents', async () => {
    await expect(listCourseFiles('kairos')).rejects.toThrow('No course found for "kairos"');
    await expect(listCourseFiles(KAIROS_ID)).rejects.toThrow('No course found');
    expect(listDocuments).not.toHaveBeenCalled();
  });
  it('resolveFile rejects for every format', async () => {
    for (const f of ['pdf', 'markdown', 'original', undefined] as const) {
      await expect(resolveFile('kairos', 'd1', f)).rejects.toThrow('No course found for "kairos"');
    }
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('loadDoc rejects without reading the document', async () => {
    await expect(loadDoc('kairos', 'd1')).rejects.toThrow('No course found for "kairos"');
    expect(getDocument).not.toHaveBeenCalled();
  });
  it('a course still lists and loads', async () => {
    await expect(listCourseFiles('parallel')).resolves.toMatchObject({ course: { slug: 'parallel' } });
    await expect(loadDoc('parallel', 'd1')).resolves.toMatchObject({ slug: 'parallel' });
  });
});

describe('course MCP server refuses research projects', () => {
  it('list_course_files', async () => {
    await expect((tools.get('list_course_files') as Handler)({ course: 'kairos' })).rejects.toThrow(
      'No course found',
    );
  });
  it('get_file as text and as pdf', async () => {
    const getFile = tools.get('get_file') as Handler;
    await expect(getFile({ course: 'kairos', fileId: 'd1' })).rejects.toThrow('No course found');
    await expect(getFile({ course: KAIROS_ID, fileId: 'd1', format: 'pdf' })).rejects.toThrow(
      'No course found',
    );
  });
  it('get_page_images', async () => {
    await expect(
      (tools.get('get_page_images') as Handler)({ course: 'kairos', fileId: 'd1', pages: '1' }),
    ).rejects.toThrow('No course found');
  });
  it('resources/read of a research file', async () => {
    await expect(
      readResource(new URL('quire://course/kairos/file/d1'), { slug: 'kairos', docId: 'd1' }),
    ).rejects.toThrow('No course found');
  });
  it('a course slug still works', async () => {
    const res = (await (tools.get('get_file') as Handler)({ course: 'parallel', fileId: 'd1' })) as {
      content: { text: string }[];
    };
    expect(res.content[0]?.text).toContain('# T');
  });
});
