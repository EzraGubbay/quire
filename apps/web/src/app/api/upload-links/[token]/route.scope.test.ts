// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPdfDocument = vi.fn();
vi.mock('@/lib/documents', () => ({
  createPdfDocument,
  createMarkdownDocument: vi.fn(),
  listFolders: vi.fn(),
}));
vi.mock('@/lib/notes', () => ({ createNote: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/mcp/upload-store', () => ({
  findDuplicatePdf: vi.fn(async () => undefined),
  setContentHash: vi.fn(),
  findNoteByTitle: vi.fn(),
  findMarkdownDoc: vi.fn(),
}));
vi.mock('@/lib/mcp/courses', () => ({ resolveCourse: vi.fn() }));
const getProjectById = vi.fn();
vi.mock('@/lib/projects', () => ({
  getProjectById,
  projectBase: (p: { slug: string }) => `/x/${p.slug}`,
}));

const route = await import('./route');
const links = await import('@/lib/mcp/upload-links');

const research = { id: 'p1', slug: 'kairos', name: 'KAIROS', kind: 'research' };
const course = { id: 'p1', slug: 'algo', name: 'Algo', kind: 'course' };
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const binding = {
  projectId: 'p1',
  section: 'documents',
  kind: 'pdf',
  filename: 'a.pdf',
  folderId: null,
  folderName: null,
  contentType: 'application/pdf',
  maxBytes: 1000,
} as const;
const put = (token: string) =>
  route.PUT(
    new Request(`http://x/api/upload-links/${token}`, {
      method: 'PUT',
      body: pdf as never,
      headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) },
    }),
    { params: Promise.resolve({ token }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  links.__storeForTests().links.clear();
  links.__storeForTests().statuses.clear();
  createPdfDocument.mockResolvedValue({ id: 'd1', title: 'A', pageCount: 1 });
});
afterEach(() => {
  delete process.env.MCP_WRITE_ENABLED;
  delete process.env.MCP_RESEARCH_WRITE_ENABLED;
});

describe('PUT route scope binding', () => {
  it('research link to a research project -> 201 with a `project` owner', async () => {
    getProjectById.mockResolvedValue(research);
    const { token } = links.createLink({ ...binding, scope: 'research' });
    const res = await put(token);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project).toEqual({ slug: 'kairos', name: 'KAIROS' });
    expect(body.course).toBeUndefined();
  });
  it('research link whose project is a course -> 422, nothing ingested', async () => {
    getProjectById.mockResolvedValue(course);
    const { token } = links.createLink({ ...binding, scope: 'research' });
    const res = await put(token);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/project for this link no longer exists/);
    expect(createPdfDocument).not.toHaveBeenCalled();
  });
  it('course link whose project became research -> 422, nothing ingested', async () => {
    getProjectById.mockResolvedValue(research);
    const { token } = links.createLink({ ...binding, scope: 'course' });
    const res = await put(token);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/course for this link no longer exists/);
    expect(createPdfDocument).not.toHaveBeenCalled();
  });
  it('write flags are independent per link scope', async () => {
    process.env.MCP_WRITE_ENABLED = 'false';
    getProjectById.mockResolvedValue(course);
    expect((await put(links.createLink({ ...binding, scope: 'course' }).token)).status).toBe(404);
    getProjectById.mockResolvedValue(research);
    expect((await put(links.createLink({ ...binding, scope: 'research' }).token)).status).toBe(201);
    delete process.env.MCP_WRITE_ENABLED;
    process.env.MCP_RESEARCH_WRITE_ENABLED = 'false';
    expect((await put(links.createLink({ ...binding, scope: 'research' }).token)).status).toBe(404);
  });
  it('an invalid token is 410 even with the course flag off', async () => {
    process.env.MCP_WRITE_ENABLED = 'false';
    expect((await put('A'.repeat(43))).status).toBe(410);
  });
});
