// get_file / get_page_images / resources/read through the real registerQuireMcp + content.ts, with the data
// layer mocked, and page rendering exercised for real (pdf.js + @napi-rs/canvas) on the e2e fixture PDF.
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from '@/db/schema';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'quire-mcp-'));
process.env.FILES_DIR = tmp;

const getDocument = vi.fn();
const getDocumentPages = vi.fn();
vi.mock('@/lib/documents', () => ({ getDocument, getDocumentPages }));
const resolveCourse = vi.fn();
const resolveFile = vi.fn();
const readFileBytes = vi.fn();
vi.mock('./courses', () => ({
  resolveCourse,
  resolveFile,
  readFileBytes,
  listCourses: vi.fn(),
  listCourseFiles: vi.fn(),
  listAllFileResources: vi.fn(),
}));

const { registerQuireMcp } = await import('./server');

type Handler = (args: Record<string, unknown>) => Promise<{ content: Record<string, unknown>[] }>;
type ResourceHandler = (
  uri: URL,
  vars: Record<string, string>,
) => Promise<{ contents: Record<string, unknown>[] }>;
const tools = new Map<string, Handler>();
let readResource: ResourceHandler;
registerQuireMcp({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => tools.set(name, h),
  resource: (_n: string, _t: unknown, h: ResourceHandler) => {
    readResource = h;
  },
} as never);
const call = (name: string, args: Record<string, unknown>) => (tools.get(name) as Handler)(args);

const doc = (over: Partial<Document> = {}): Document =>
  ({
    id: 'd1',
    projectId: 'p1',
    kind: 'pdf',
    title: 'Project: Simplified Waze Prototype',
    filePath: 'p1/d1.pdf',
    fileSize: 1000,
    pageCount: 3,
    markdownBody: null,
    ...over,
  }) as Document;

beforeAll(async () => {
  await mkdir(path.join(tmp, 'p1'), { recursive: true });
  await copyFile(path.resolve(__dirname, '../../../e2e/fixtures/ten-pages.pdf'), path.join(tmp, 'p1/d1.pdf'));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  resolveCourse.mockResolvedValue({ id: 'p1', slug: 'parallel', name: 'Parallel Systems Programming' });
  getDocument.mockResolvedValue(doc());
  getDocumentPages.mockResolvedValue([
    { pageNo: 1, text: 'Build a simplified Waze: road graph, live traffic, shortest paths with OpenMP.' },
    { pageNo: 2, text: '' },
    { pageNo: 3, text: 'Submission: a zip with the code and a short report, due before the deadline.' },
  ]);
});

describe('get_file (default text)', () => {
  it('returns only text content with page markers — never a binary resource', async () => {
    const res = await call('get_file', { course: 'parallel', fileId: 'd1' });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.type).toBe('text');
    const text = res.content[0]?.text as string;
    expect(text).toContain('# Project: Simplified Waze Prototype');
    expect(text).toContain('--- Page 1 ---\nBuild a simplified Waze');
    expect(text).toContain('--- Page 3 ---\nSubmission');
    expect(text).toContain('get_page_images with pages="2"');
  });

  it('honours pages', async () => {
    const res = await call('get_file', { course: 'parallel', fileId: 'd1', pages: '3' });
    const text = res.content[0]?.text as string;
    expect(text).toContain('--- Page 3 ---');
    expect(text).not.toContain('--- Page 1 ---');
  });

  it('extracts on the fly when no page text was stored', async () => {
    getDocumentPages.mockResolvedValue([]);
    getDocument.mockResolvedValue(doc({ pageCount: 10 }));
    const res = await call('get_file', { course: 'parallel', fileId: 'd1', pages: '1-2' });
    expect(res.content[0]?.text).toContain('--- Page 2 ---');
  });

  it('returns a markdown note body as text', async () => {
    getDocument.mockResolvedValue(doc({ kind: 'markdown', filePath: null, markdownBody: 'Hello **notes**' }));
    const res = await call('get_file', { course: 'parallel', fileId: 'd1' });
    expect(res.content).toEqual([
      { type: 'text', text: '# Project: Simplified Waze Prototype\n\nHello **notes**' },
    ]);
  });

  it('format="pdf" keeps the raw file but leads with a text explanation', async () => {
    resolveFile.mockResolvedValue({
      kind: 'binary',
      format: 'pdf',
      mimeType: 'application/pdf',
      filename: 'waze.pdf',
      slug: 'parallel',
      docId: 'd1',
      sizeBytes: 4,
      rel: 'p1/d1.pdf',
    });
    readFileBytes.mockResolvedValue(Buffer.from('%PDF'));
    const res = await call('get_file', { course: 'parallel', fileId: 'd1', format: 'pdf' });
    expect(res.content.map((c) => c.type)).toEqual(['text', 'resource']);
    expect(res.content[0]?.text).toMatch(/get_page_images/);
  });
});

describe('get_page_images', () => {
  it('renders real JPEGs for the requested pages, capped per call', async () => {
    getDocument.mockResolvedValue(doc({ pageCount: 10 }));
    const res = await call('get_page_images', { course: 'parallel', fileId: 'd1', pages: '1-6' });
    const images = res.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(4);
    for (const img of images) {
      expect(img.mimeType).toBe('image/jpeg');
      const bytes = Buffer.from(img.data as string, 'base64');
      expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
      expect(bytes.length).toBeLessThan(1024 * 1024);
    }
    expect(res.content.at(-1)?.text).toContain('pages="5-6"');
  }, 60_000);

  it('says so when the file has no PDF', async () => {
    getDocument.mockResolvedValue(doc({ filePath: null }));
    const res = await call('get_page_images', { course: 'parallel', fileId: 'd1', pages: '1' });
    expect(res.content[0]?.text).toMatch(/no PDF/);
  });

  it('re-renders a 0-byte cached page and leaves no temp files behind', async () => {
    getDocument.mockResolvedValue(doc({ pageCount: 10, fileSize: 777 }));
    const dir = path.join(tmp, 'p1', 'd1.mcp-777');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '7.jpg'), '');
    const res = await call('get_page_images', { course: 'parallel', fileId: 'd1', pages: '7' });
    const img = res.content.find((c) => c.type === 'image');
    expect(
      Buffer.from(img?.data as string, 'base64')
        .subarray(0, 3)
        .toString('hex'),
    ).toBe('ffd8ff');
    expect((await stat(path.join(dir, '7.jpg'))).size).toBeGreaterThan(0);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  it('serves a cached page without re-rendering', async () => {
    getDocument.mockResolvedValue(doc({ pageCount: 10, fileSize: 888 }));
    const dir = path.join(tmp, 'p1', 'd1.mcp-888');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2.jpg'), Buffer.from('ffd8ffe0cafe', 'hex'));
    const res = await call('get_page_images', { course: 'parallel', fileId: 'd1', pages: '2' });
    expect(res.content.find((c) => c.type === 'image')?.data).toBe(
      Buffer.from('ffd8ffe0cafe', 'hex').toString('base64'),
    );
  });

  it('stays bounded when the page count is unknown', async () => {
    getDocument.mockResolvedValue(doc({ pageCount: null, fileSize: 999 }));
    const res = await call('get_page_images', { course: 'parallel', fileId: 'd1', pages: '9-' });
    const images = res.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(res.content.filter((c) => c.type === 'text').map((c) => c.text)).toEqual([
      'Page 9 of "Project: Simplified Waze Prototype":',
      'Page 10 of "Project: Simplified Waze Prototype":',
    ]);
  }, 60_000);
});

describe('resources/read', () => {
  it('leads with the page text before the PDF blob', async () => {
    resolveFile.mockResolvedValue({
      kind: 'binary',
      format: 'pdf',
      mimeType: 'application/pdf',
      filename: 'waze.pdf',
      slug: 'parallel',
      docId: 'd1',
      sizeBytes: 4,
      rel: 'p1/d1.pdf',
    });
    readFileBytes.mockResolvedValue(Buffer.from('%PDF'));
    const res = await readResource(new URL('quire://course/parallel/file/d1'), {
      slug: 'parallel',
      docId: 'd1',
    });
    expect(res.contents).toHaveLength(2);
    expect(res.contents[0]?.text).toContain('--- Page 1 ---');
    expect(res.contents[1]?.blob).toBe(Buffer.from('%PDF').toString('base64'));
  });

  it('still returns the blob when text extraction fails', async () => {
    resolveFile.mockResolvedValue({
      kind: 'binary',
      format: 'pdf',
      mimeType: 'application/pdf',
      filename: 'waze.pdf',
      slug: 'parallel',
      docId: 'd1',
      sizeBytes: 4,
      rel: 'p1/d1.pdf',
    });
    readFileBytes.mockResolvedValue(Buffer.from('%PDF'));
    getDocumentPages.mockRejectedValue(new Error('db down'));
    const res = await readResource(new URL('quire://course/parallel/file/d1'), {
      slug: 'parallel',
      docId: 'd1',
    });
    expect(res.contents).toHaveLength(1);
    expect(res.contents[0]?.blob).toBeDefined();
  });
});

describe('get_file without a PDF', () => {
  it('points at format="original" when a deck has no PDF', async () => {
    getDocument.mockResolvedValue(doc({ filePath: null, originalPath: 'p1/d1.pptx' }));
    const res = await call('get_file', { course: 'parallel', fileId: 'd1' });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toMatch(/format="original"/);
  });
});
