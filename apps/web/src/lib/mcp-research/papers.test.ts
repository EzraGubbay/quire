import { beforeEach, describe, expect, it, vi } from 'vitest';

const research = { id: 'r1', slug: 'kairos', name: 'KAIROS', kind: 'research' };
const course = { id: 'c1', slug: 'algo', name: 'Algo', kind: 'course' };
vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async (s: string) => [research, course].find((p) => p.slug === s)),
  getProjectById: vi.fn(),
  projectBase: (p: { slug: string }) => `/p/${p.slug}`,
}));
const createPdfDocument = vi.fn();
const createPaperStub = vi.fn();
vi.mock('@/lib/documents', () => ({
  createPdfDocument,
  createPaperStub,
  listFolders: vi.fn(async () => []),
}));
vi.mock('@/lib/notes', () => ({ createNote: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const findPaperByRef = vi.fn();
vi.mock('@/lib/mcp/upload-store', () => ({
  findPaperByRef,
  findDuplicatePdf: vi.fn(async () => undefined),
  setContentHash: vi.fn(),
  findNoteByTitle: vi.fn(),
  findMarkdownDoc: vi.fn(),
}));
const resolveReference = vi.fn();
const downloadPdf = vi.fn();
vi.mock('@/lib/ingest', async (orig) => ({
  ...(await orig<typeof import('@/lib/ingest')>()),
  resolveReference,
  downloadPdf,
}));
const fetchPublicPdf = vi.fn();
vi.mock('@/lib/mcp/safe-fetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/safe-fetch')>()),
  fetchPublicPdf,
}));

const { addPaper } = await import('./papers');
const { FetchRefused } = await import('@/lib/mcp/safe-fetch');
const { UploadError } = await import('@/lib/mcp/upload');

const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const arxivMeta = {
  title: 'Attention',
  authors: ['A'],
  year: 2017,
  abstract: 'abs',
  arxivId: '1706.03762v7',
  sourceUrl: 'https://arxiv.org/abs/1706.03762',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
};

beforeEach(() => {
  vi.clearAllMocks();
  findPaperByRef.mockResolvedValue(undefined);
  resolveReference.mockResolvedValue(arxivMeta);
  fetchPublicPdf.mockResolvedValue({ data: pdf, fileName: '1706.03762.pdf' });
  createPdfDocument.mockResolvedValue({ id: 'd1', title: 'Attention', pageCount: 3 });
  createPaperStub.mockResolvedValue({ id: 's1', title: 'Attention' });
});

describe('add_paper', () => {
  it('arXiv with a pdfUrl uses the guarded fetch and passes identity and metadata', async () => {
    const r = await addPaper({ project: 'kairos', reference: 'arxiv.org/abs/1706.03762v7' });
    expect(fetchPublicPdf).toHaveBeenCalledWith('https://arxiv.org/pdf/1706.03762');
    expect(downloadPdf).not.toHaveBeenCalled();
    expect(createPdfDocument).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({
        arxivId: '1706.03762',
        meta: expect.objectContaining({ title: 'Attention', year: 2017 }),
      }),
    );
    expect(r).toMatchObject({ status: 'created', project: { slug: 'kairos' } });
  });
  it('a DOI with no pdfUrl creates a metadata stub', async () => {
    resolveReference.mockResolvedValue({ title: 'D', doi: '10.1000/abc', pdfUrl: null });
    const r = await addPaper({ project: 'kairos', reference: '10.1000/abc' });
    expect(fetchPublicPdf).not.toHaveBeenCalled();
    expect(createPaperStub).toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'created' });
    expect(r.next).toContain('upload_pdf');
  });
  it('a refused PDF fetch falls back to a stub', async () => {
    fetchPublicPdf.mockRejectedValue(new FetchRefused('nope'));
    const r = await addPaper({ project: 'kairos', reference: '1706.03762' });
    expect(createPaperStub).toHaveBeenCalled();
    expect(createPdfDocument).not.toHaveBeenCalled();
    expect(r.status).toBe('created');
  });
  it('a plain URL points to upload_pdf; garbage is refused', async () => {
    await expect(addPaper({ project: 'kairos', reference: 'https://example.com/x.pdf' })).rejects.toThrow(
      /upload_pdf/,
    );
    await expect(addPaper({ project: 'kairos', reference: 'not a paper' })).rejects.toBeInstanceOf(
      UploadError,
    );
  });
  it('an existing paper (found by arXiv base id or DOI) is a duplicate', async () => {
    findPaperByRef.mockResolvedValue({ id: 'old', title: 'Attention', pageCount: 3 });
    const r = await addPaper({ project: 'kairos', reference: '1706.03762v2' });
    expect(findPaperByRef).toHaveBeenCalledWith('r1', { arxivId: '1706.03762', doi: null });
    expect(r).toMatchObject({ status: 'duplicate', fileId: 'old' });
    expect(fetchPublicPdf).not.toHaveBeenCalled();
  });
  it('refuses a course project', async () => {
    await expect(addPaper({ project: 'algo', reference: '1706.03762' })).rejects.toThrow(
      /No project found.*list_projects/,
    );
  });
  it('two concurrent identical calls create once', async () => {
    const [a, b] = await Promise.all([
      addPaper({ project: 'kairos', reference: '1706.03762' }),
      addPaper({ project: 'kairos', reference: '1706.03762' }),
    ]);
    expect(createPdfDocument).toHaveBeenCalledTimes(1);
    expect(a.fileId).toBe(b.fileId);
  });

  it('refuses a malformed arXiv id before any lookup', async () => {
    await expect(addPaper({ project: 'kairos', reference: 'arxiv: 2401.1234x' })).rejects.toThrow(
      /not a valid arXiv id/,
    );
    expect(resolveReference).not.toHaveBeenCalled();
  });
  it('wraps a failed lookup as an UploadError', async () => {
    resolveReference.mockRejectedValue(new Error('arXiv API responded 503'));
    const err = await addPaper({ project: 'kairos', reference: '1706.03762' }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toContain('Could not look that paper up');
  });
  it('a non-FetchRefused fetch error propagates (no stub)', async () => {
    fetchPublicPdf.mockRejectedValue(new Error('boom'));
    await expect(addPaper({ project: 'kairos', reference: '1706.03762' })).rejects.toThrow('boom');
    expect(createPaperStub).not.toHaveBeenCalled();
  });
  it('a title over 200 chars does not fail the call; meta keeps the full title', async () => {
    const long = 'T'.repeat(300);
    resolveReference.mockResolvedValue({ ...arxivMeta, title: long });
    const r = await addPaper({ project: 'kairos', reference: '1706.03762' });
    expect(r.status).toBe('created');
    expect(createPdfDocument).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ meta: expect.objectContaining({ title: 'T'.repeat(200) }) }),
    );
  });
});
