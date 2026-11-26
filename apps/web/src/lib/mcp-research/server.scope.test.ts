// REQUIRED guard: every research tool and resource, wired through the real registerQuireResearchMcp, refuses a
// COURSE project (by slug and by UUID) and a course-minted uploadId. A tool that forgot to pass RESEARCH_SCOPE
// would leak course data to the research key; this test fails if one does.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COURSE_ID = '22222222-2222-4222-8222-222222222222';
const course = { id: COURSE_ID, slug: 'algo', name: 'Algo', kind: 'course' };
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
  projectBase: (p: { slug: string }) => `/x/${p.slug}`,
  projectMeta: vi.fn(() => ({})),
}));
const getDocument = vi.fn();
const createMarkdownDocument = vi.fn();
const createPdfDocument = vi.fn();
const createPaperStub = vi.fn();
const listDocuments = vi.fn(async () => []);
vi.mock('@/lib/documents', () => ({
  getDocument,
  getDocumentPages: vi.fn(async () => []),
  listDocuments,
  countDocuments: vi.fn(async () => 0),
  listFolders: vi.fn(async () => []),
  listPracticeExams: vi.fn(async () => []),
  createMarkdownDocument,
  createPdfDocument,
  createPaperStub,
}));
const getNote = vi.fn();
const createNote = vi.fn();
vi.mock('@/lib/notes', () => ({ getNote, createNote, listNotes: vi.fn(async () => []) }));
vi.mock('@/lib/sources', () => ({ listSources: vi.fn(async () => []) }));
vi.mock('@/lib/sessions', () => ({ listSessions: vi.fn(async () => []), sessionTitle: vi.fn() }));
vi.mock('@/lib/homework', () => ({ listAssignments: vi.fn(async () => []) }));
vi.mock('@/lib/lemida/files', () => ({ lemidaFilesByProject: vi.fn(async () => []) }));
vi.mock('@/lib/files', () => ({ readStoredFile: vi.fn(), filePath: vi.fn(), sha256: () => 'h' }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/mcp/upload-store', () => ({
  findPaperByRef: vi.fn(async () => undefined),
  findDuplicatePdf: vi.fn(async () => undefined),
  setContentHash: vi.fn(),
  findNoteByTitle: vi.fn(async () => undefined),
  findMarkdownDoc: vi.fn(async () => undefined),
}));
const resolveReference = vi.fn();
vi.mock('@/lib/ingest', async (orig) => ({
  ...(await orig<typeof import('@/lib/ingest')>()),
  resolveReference,
}));
const fetchPublicPdf = vi.fn();
vi.mock('@/lib/mcp/safe-fetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/safe-fetch')>()),
  fetchPublicPdf,
}));

const { registerQuireResearchMcp } = await import('./server');
const { createUploadLinkTool: createLinkIn } = await import('@/lib/mcp/upload');
const { COURSE_SCOPE } = await import('@/lib/mcp/scope');
const { registerQuireMcp } = await import('@/lib/mcp/server');
const createUploadLinkTool = (a: Parameters<typeof createLinkIn>[0]) => createLinkIn(a, COURSE_SCOPE);
const { __storeForTests } = await import('@/lib/mcp/upload-links');

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type ResourceHandler = (uri: URL, vars: Record<string, string>) => Promise<unknown>;
const tools = new Map<string, Handler>();
let readResource: ResourceHandler;
registerQuireResearchMcp({
  tool: (name: string, ...rest: unknown[]) => tools.set(name, rest.at(-1) as Handler),
  resource: (_n: string, _t: unknown, h: ResourceHandler) => {
    readResource = h;
  },
} as never);
const call = (name: string, args: Record<string, unknown>) => (tools.get(name) as Handler)(args);

const REFUSED = /No (research )?project found/;
beforeEach(() => {
  vi.clearAllMocks();
  __storeForTests().links.clear();
  __storeForTests().statuses.clear();
  getDocument.mockResolvedValue({ id: 'd1', kind: 'markdown', title: 'T', markdownBody: 'b' });
  getNote.mockResolvedValue({ title: 'T', body: 'b' });
  resolveReference.mockResolvedValue({ title: 'X', arxivId: '1706.03762', pdfUrl: null });
});

describe.each([
  ['slug', 'algo'],
  ['UUID', COURSE_ID],
])('every research tool refuses a course %s', (_label, ref) => {
  const cases: [string, Record<string, unknown>][] = [
    ['list_project_files', { project: ref }],
    ['get_file', { project: ref, fileId: 'd1' }],
    ['get_file', { project: ref, fileId: 'd1', format: 'pdf' }],
    ['get_file', { project: ref, fileId: 'd1', format: 'markdown' }],
    ['get_file', { project: ref, fileId: 'd1', format: 'original' }],
    ['get_page_images', { project: ref, fileId: 'd1', pages: '1' }],
    ['get_note', { project: ref, noteId: 'n1' }],
    ['upload_markdown', { project: ref, markdown: '# T\n\nbody' }],
    ['upload_markdown', { project: ref, markdown: '# T\n\nbody', section: 'documents' }],
    ['upload_pdf', { project: ref, url: 'https://example.com/a.pdf' }],
    ['add_paper', { project: ref, reference: '1706.03762' }],
    ['create_upload_link', { project: ref, section: 'notes', filename: 'a.md' }],
  ];
  it.each(cases)('%s', async (name, args) => {
    await expect(call(name, args)).rejects.toThrow(REFUSED);
    expect(getDocument).not.toHaveBeenCalled();
    expect(getNote).not.toHaveBeenCalled();
    expect(createMarkdownDocument).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
    expect(createPdfDocument).not.toHaveBeenCalled();
    expect(createPaperStub).not.toHaveBeenCalled();
    expect(fetchPublicPdf).not.toHaveBeenCalled();
    expect(__storeForTests().links.size).toBe(0);
  });
  it('resources/read', async () => {
    await expect(
      readResource(new URL(`quire://research/${ref}/file/d1`), { slug: ref, docId: 'd1' }),
    ).rejects.toThrow(REFUSED);
    expect(getDocument).not.toHaveBeenCalled();
  });
});

describe('get_upload_status', () => {
  it('refuses a course-minted uploadId and shows a research-minted one', async () => {
    const c = await createUploadLinkTool({ course: 'algo', section: 'notes', filename: 'a.md' });
    expect(await call('get_upload_status', { uploadId: c.uploadId })).toMatchObject({
      content: [{ text: expect.stringContaining('Unknown uploadId') }],
    });
    const r = (await call('create_upload_link', {
      project: 'kairos',
      section: 'notes',
      filename: 'a.md',
    })) as { content: { text: string }[] };
    const { uploadId } = JSON.parse(r.content[0]?.text as string);
    expect(await call('get_upload_status', { uploadId })).toMatchObject({
      content: [{ text: expect.stringContaining('"state": "pending"') }],
    });
  });
});

describe('reverse: the course server never reveals a research-minted uploadId', () => {
  it('get_upload_status on the course server says Unknown uploadId', async () => {
    const courseTools = new Map<string, Handler>();
    registerQuireMcp({
      tool: (name: string, ...rest: unknown[]) => courseTools.set(name, rest.at(-1) as Handler),
      resource: vi.fn(),
    } as never);
    const r = (await call('create_upload_link', {
      project: 'kairos',
      section: 'notes',
      filename: 'a.md',
    })) as {
      content: { text: string }[];
    };
    const { uploadId } = JSON.parse(r.content[0]?.text as string);
    expect(await (courseTools.get('get_upload_status') as Handler)({ uploadId })).toMatchObject({
      content: [{ text: expect.stringContaining('Unknown uploadId') }],
    });
  });
});

describe('sanity: research projects work through the same tools', () => {
  it('get_file reads a research document', async () => {
    const r = (await call('get_file', { project: 'kairos', fileId: 'd1' })) as {
      content: { text: string }[];
    };
    expect(r.content[0]?.text).toContain('# T');
  });
});
