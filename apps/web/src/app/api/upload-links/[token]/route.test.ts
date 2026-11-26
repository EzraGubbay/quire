// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPdfDocument = vi.fn();
const createMarkdownDocument = vi.fn();
const listFolders = vi.fn();
vi.mock('@/lib/documents', () => ({ createPdfDocument, createMarkdownDocument, listFolders }));
const createNote = vi.fn();
vi.mock('@/lib/notes', () => ({ createNote }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const findDuplicatePdf = vi.fn();
const setContentHash = vi.fn();
const findNoteByTitle = vi.fn();
const findMarkdownDoc = vi.fn();
vi.mock('@/lib/mcp/upload-store', () => ({
  findDuplicatePdf,
  setContentHash,
  findNoteByTitle,
  findMarkdownDoc,
}));
vi.mock('@/lib/mcp/courses', () => ({ resolveCourse: vi.fn() }));
const getProjectById = vi.fn();
vi.mock('@/lib/projects', () => ({
  getProjectById,
  projectBase: (p: { slug: string }) => `/c/${p.slug}`,
}));

const route = await import('./route');
const links = await import('@/lib/mcp/upload-links');

const project = { id: 'p1', slug: 'algo', name: 'Algorithms', kind: 'course' };
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const small = {
  projectId: 'p1',
  section: 'documents',
  kind: 'pdf',
  filename: 'lec.pdf',
  folderId: 'f1',
  folderName: 'Week 1',
  contentType: 'application/pdf',
  maxBytes: 1000,
} as const;
const mdBase = {
  ...small,
  section: 'notes',
  kind: 'markdown',
  filename: 'my-note.md',
  contentType: 'text/markdown',
} as const;
const bytes = (s: string) => new TextEncoder().encode(s);

/** `len`: undefined = the body's real length, '' = no Content-Length header, otherwise that value. */
const put = (token: string, body: Uint8Array, headers: Record<string, string> = {}, len?: string) =>
  route.PUT(
    new Request(`http://x/api/upload-links/${token}`, {
      method: 'PUT',
      body: body.length ? (body as never) : undefined,
      headers: {
        'content-type': 'application/pdf',
        ...(len === '' ? {} : { 'content-length': len ?? String(body.length) }),
        ...headers,
      },
    }),
    { params: Promise.resolve({ token }) },
  );
const mint = (b: Parameters<typeof links.createLink>[0] = small) => links.createLink(b);

beforeEach(() => {
  vi.clearAllMocks();
  links.__storeForTests().links.clear();
  links.__storeForTests().statuses.clear();
  getProjectById.mockResolvedValue(project);
  findDuplicatePdf.mockResolvedValue(undefined);
  findNoteByTitle.mockResolvedValue(undefined);
  findMarkdownDoc.mockResolvedValue(undefined);
  createPdfDocument.mockResolvedValue({ id: 'd1', title: 'Lecture', pageCount: 2 });
  createNote.mockResolvedValue({ id: 'n1', slug: 'my-note', title: 'x' });
  createMarkdownDocument.mockResolvedValue({ id: 'm1' });
});
afterEach(() => {
  delete process.env.MCP_WRITE_ENABLED;
  delete process.env.MCP_UPLOAD_LINK_DEADLINE_MS;
  links.setClock(null);
});

describe('PUT /api/upload-links/<token>', () => {
  it('only exports PUT', () => {
    const r = route as Record<string, unknown>;
    expect(r.PUT).toBeDefined();
    for (const m of ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS']) expect(r[m]).toBeUndefined();
  });

  it('creates a PDF in the bound course/folder/filename (201), ignoring request extras', async () => {
    const { token, uploadId } = mint();
    const res = await put(token, pdf, { 'x-course': 'other', cookie: 'a=b' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'created', fileId: 'd1', uploadId, folder: 'Week 1' });
    expect(body.openUrl).toContain('/c/algo/documents/d1');
    expect(createPdfDocument).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ fileName: 'lec.pdf', folderId: 'f1' }),
    );
    expect(links.getStatus(uploadId)?.state).toBe('created');
  });

  it('creates notes and documents from Markdown (bound title, then H1, then filename)', async () => {
    let { token } = mint(mdBase);
    let res = await put(token, bytes('# Heap sort\n\nBody'), {
      'content-type': 'text/markdown; charset=utf-8',
    });
    expect(res.status).toBe(201);
    expect(createNote).toHaveBeenCalledWith('p1', 'Heap sort', 'Body', { folderId: 'f1' });
    ({ token } = mint({ ...mdBase, title: 'Bound' }));
    await put(token, bytes('# Other\ntext'), { 'content-type': 'text/markdown' });
    expect(createNote).toHaveBeenLastCalledWith('p1', 'Bound', '# Other\ntext', { folderId: 'f1' });
    ({ token } = mint(mdBase));
    await put(token, bytes('no heading'), { 'content-type': 'text/plain' });
    expect(createNote).toHaveBeenLastCalledWith('p1', 'my-note', 'no heading', { folderId: 'f1' });
    ({ token } = mint({ ...mdBase, section: 'documents' }));
    res = await put(token, bytes('# D\nx'), { 'content-type': 'text/markdown' });
    expect(res.status).toBe(201);
    expect(createMarkdownDocument).toHaveBeenCalledWith('p1', 'D', 'x', 'f1');
    expect(createNote).toHaveBeenCalledTimes(3);
  });

  it('is single use: a replay gets 410 and writes nothing', async () => {
    const { token } = mint();
    expect((await put(token, pdf)).status).toBe(201);
    expect((await put(token, pdf)).status).toBe(410);
    expect(createPdfDocument).toHaveBeenCalledTimes(1);
  });

  it('answers 410 after expiry and marks the status expired', async () => {
    let t = 1000;
    links.setClock(() => t);
    const { token, uploadId } = mint();
    t += 11 * 60 * 1000;
    expect((await put(token, pdf)).status).toBe(410);
    expect(links.getStatus(uploadId)?.state).toBe('expired');
    expect(createPdfDocument).not.toHaveBeenCalled();
  });

  it.each(['short', '..x', 'A'.repeat(44), 'A'.repeat(43)])(
    'refuses unknown or malformed token %j',
    async (token) => {
      expect((await put(token, pdf)).status).toBe(410);
      expect(createPdfDocument).not.toHaveBeenCalled();
    },
  );

  it('header failures do not consume the token', async () => {
    const { token } = mint();
    expect((await put(token, pdf, {}, '')).status).toBe(411);
    expect((await put(token, pdf, {}, '5000')).status).toBe(413);
    expect((await put(token, pdf, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await put(token, new Uint8Array(0))).status).toBe(400);
    expect((await put(token, pdf)).status).toBe(201);
  });

  it('rejects application/pdf on a markdown link (415)', async () => {
    const { token } = mint(mdBase);
    expect((await put(token, bytes('# x'), { 'content-type': 'application/pdf' })).status).toBe(415);
  });

  it('a body that disagrees with Content-Length is 400 and spends the link', async () => {
    const { token, uploadId } = mint();
    const res = await put(token, pdf, {}, String(pdf.length - 5));
    expect(res.status).toBe(400);
    expect(links.getStatus(uploadId)?.state).toBe('failed');
    expect((await put(token, pdf)).status).toBe(410);
  });

  it('a body streaming past the cap is 413 even if the header understates it', async () => {
    const { token, uploadId } = mint({ ...small, maxBytes: 10 });
    const res = await put(token, pdf, {}, '5');
    expect(res.status).toBe(413);
    expect(links.getStatus(uploadId)?.state).toBe('failed');
  });

  it('non-PDF bytes and invalid UTF-8 are 422 and fail the status', async () => {
    let { token, uploadId } = mint();
    expect((await put(token, bytes('hello world'))).status).toBe(422);
    expect(links.getStatus(uploadId)?.state).toBe('failed');
    ({ token, uploadId } = mint(mdBase));
    const res = await put(token, new Uint8Array([0xff, 0xfe, 0x41]), { 'content-type': 'text/markdown' });
    expect(res.status).toBe(422);
    expect(links.getStatus(uploadId)?.state).toBe('failed');
  });

  it('returns duplicate (200) for bytes already in the course', async () => {
    findDuplicatePdf.mockResolvedValue({ id: 'old', title: 'Old', pageCount: 1, fileSize: pdf.length });
    const { token } = mint();
    const res = await put(token, pdf);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'duplicate', fileId: 'old' });
    expect(createPdfDocument).not.toHaveBeenCalled();
  });

  it('is 404 with the write flag off and ingests nothing', async () => {
    process.env.MCP_WRITE_ENABLED = 'false';
    const { token } = mint();
    expect((await put(token, pdf)).status).toBe(404);
    expect(createPdfDocument).not.toHaveBeenCalled();
  });

  it('answers 202 at the deadline and the status later becomes created', async () => {
    process.env.MCP_UPLOAD_LINK_DEADLINE_MS = '10';
    createPdfDocument.mockImplementation(
      () => new Promise((res) => setTimeout(() => res({ id: 'd9', title: 'Slow', pageCount: 1 }), 60)),
    );
    const { token, uploadId } = mint();
    const res = await put(token, pdf);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'processing', uploadId });
    await vi.waitFor(() => expect(links.getStatus(uploadId)?.state).toBe('created'));
  });

  it('answers 400 and marks failed when the body stream errors mid-upload', async () => {
    const { token, uploadId } = mint();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(pdf.subarray(0, 5));
        c.error(new Error('aborted'));
      },
    });
    const res = await route.PUT(
      new Request(`http://x/api/upload-links/${token}`, {
        method: 'PUT',
        body: stream,
        // @ts-expect-error node needs duplex for streamed bodies
        duplex: 'half',
        headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) },
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ uploadId });
    expect(links.getStatus(uploadId)?.state).toBe('failed');
  });

  it('answers a generic 500 (no raw error text) and marks failed on a database error', async () => {
    getProjectById.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token, uploadId } = mint();
    const res = await put(token, pdf);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    expect(links.getStatus(uploadId)?.state).toBe('failed');
    err.mockRestore();
  });

  it('500 (not 422) when ingestion itself hits a database error', async () => {
    findDuplicatePdf.mockRejectedValue(new Error('relation "documents" does not exist'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token } = mint();
    const res = await put(token, pdf);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation/);
    err.mockRestore();
  });

  it('parallel PUTs on one token: exactly one wins, one document is created', async () => {
    const { token } = mint();
    const results = await Promise.all([put(token, pdf), put(token, pdf), put(token, pdf)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410, 410]);
    expect(createPdfDocument).toHaveBeenCalledTimes(1);
  });
});
