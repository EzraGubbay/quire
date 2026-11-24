// get_file / get_page_images / resources/read through the real registerQuireMcp + content.ts, with the data
// layer mocked, and page rendering exercised for real (pdf.js + @napi-rs/canvas) on the e2e fixture PDF.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from '@/db/schema';
import { SAMPLE_TEXT, samplePdf } from '@/lib/testing/sample-pdf';

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
const { loadPageContent } = await import('./content');

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

/** Hebrew TeX page, Hebrew Word page with an image, math page, figure page: see lib/testing/sample-pdf. */
const sample = samplePdf();
const sampleDoc = (over: Partial<Document> = {}): Document =>
  doc({ id: 's1', filePath: 'p1/s1.pdf', fileSize: sample.byteLength, pageCount: 4, ...over });
/** Stored rows as the upload-time extractor wrote them: what get_file must no longer serve. */
const staleRows = [1, 2, 3, 4].map((pageNo) => ({
  pageNo,
  text: `stale stored text of page ${pageNo}, `.repeat(3),
}));

beforeAll(async () => {
  await mkdir(path.join(tmp, 'p1'), { recursive: true });
  await copyFile(path.resolve(__dirname, '../../../e2e/fixtures/ten-pages.pdf'), path.join(tmp, 'p1/d1.pdf'));
  await writeFile(path.join(tmp, 'p1/s1.pdf'), sample);
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
    // The PDF is not on disk here, so the text stored at upload stands in.
    getDocument.mockResolvedValue(doc({ id: 'd0', filePath: 'p1/gone.pdf' }));
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
    getDocument.mockResolvedValue(doc({ id: 'd0', filePath: 'p1/gone.pdf' }));
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

describe('get_file text is re-extracted from the PDF', () => {
  beforeEach(async () => {
    getDocument.mockResolvedValue(sampleDoc());
    getDocumentPages.mockResolvedValue(staleRows);
    for (const f of await readdir(path.join(tmp, 'p1'))) {
      if (f.includes('.mcp-text-')) await rm(path.join(tmp, 'p1', f));
    }
  });
  const getText = async (args: Record<string, unknown> = {}) => {
    const res = await call('get_file', { course: 'parallel', fileId: 's1', ...args });
    expect(res.content).toHaveLength(1);
    return res.content[0]?.text as string;
  };

  it('serves logical-order Hebrew, unsplit words and numbers instead of the stored rows', async () => {
    const text = await getText();
    expect(text).not.toContain('stale stored text');
    for (const [i, page] of SAMPLE_TEXT.entries()) expect(text).toContain(`--- Page ${i + 1} ---\n${page}\n`);
    // The acceptance strings, spelled out.
    expect(text).toContain('תרגיל 2 – רדוקציות ו־NP-שלמות');
    expect(text).toContain('\nמועד ההגשה: יום רביעי, 25.11.2026');
    expect(text).toContain('הקורס משלב בין:');
    expect(text).toContain('first deadline - 29.11');
    expect(text).toContain('16 בנובמבר');
    expect(text).toContain('P ≠ NP');
    expect(text).not.toMatch(/\p{M}/u);
    expect(text).toContain('Achieve a time complexity of O(log n).');
  });

  it('flags the figure-only page, the page with an embedded image and the math-heavy page', async () => {
    const text = await getText();
    expect(text).toContain(
      '[Pages 4 have little or no text (figures, diagrams or scans). Call get_page_images with pages="4" to see them.]',
    );
    expect(text).toContain(
      '[Pages 2 contain images or figures that this text does not include. Call get_page_images with pages="2" to see them.]',
    );
    expect(text).toContain(
      '[Pages 3 contain formulas whose layout (fractions, sums, limits) is flattened in this text. ' +
        'Call get_page_images with pages="3" to read them exactly.]',
    );
  });

  it('only flags the pages it was asked for', async () => {
    const text = await getText({ pages: '1' });
    expect(text).toContain('--- Page 1 ---');
    expect(text).not.toContain('--- Page 2 ---');
    expect(text).not.toContain('get_page_images');
  });

  it('caches the analysed pages on disk and serves them without the PDF', async () => {
    const first = await getText();
    const cacheFile = path.join(tmp, 'p1', `s1.mcp-text-v1-${sample.byteLength}.json`);
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
    expect(cache.v).toBe(1);
    expect(Object.keys(cache.pages)).toEqual(['1', '2', '3', '4']);
    expect(cache.pages['2']).toEqual({ t: SAMPLE_TEXT[1], f: 1 });
    expect(cache.pages['3']).toEqual({ t: SAMPLE_TEXT[2], m: 1 });
    expect((await readdir(path.join(tmp, 'p1'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Same size, no file: only the cache can answer.
    getDocument.mockResolvedValue(sampleDoc({ filePath: 'p1/gone.pdf' }));
    expect(await getText()).toBe(first);
  });

  it('analyses only as many pages as the text budget shows', async () => {
    const content = await loadPageContent(sampleDoc(), undefined, 50);
    expect(content.wanted).toEqual([1, 2, 3, 4]);
    expect(content.texts.get(1)).toBe(SAMPLE_TEXT[0]);
    // Page 1 already overflows 50 characters; the rest keep their stored text and are not analysed.
    expect(content.texts.get(2)).toBe(staleRows[1]?.text);
    const cacheFile = path.join(tmp, 'p1', `s1.mcp-text-v1-${sample.byteLength}.json`);
    expect(Object.keys(JSON.parse(await readFile(cacheFile, 'utf8')).pages)).toEqual(['1']);
    // A later call adds to the cache instead of replacing it.
    await loadPageContent(sampleDoc(), '3');
    expect(Object.keys(JSON.parse(await readFile(cacheFile, 'utf8')).pages)).toEqual(['1', '3']);
  });

  it('ignores a cache written by another extractor version or for another file size', async () => {
    const cacheFile = path.join(tmp, 'p1', `s1.mcp-text-v1-${sample.byteLength}.json`);
    await writeFile(cacheFile, JSON.stringify({ v: 0, pages: { 1: { t: 'from an old extractor' } } }));
    expect(await getText({ pages: '1' })).toContain(SAMPLE_TEXT[0]);
    await writeFile(cacheFile, 'not json');
    expect(await getText({ pages: '1' })).toContain(SAMPLE_TEXT[0]);
  });

  it('falls back to the stored rows when the PDF cannot be read', async () => {
    getDocument.mockResolvedValue(sampleDoc({ id: 's2', filePath: 'p1/gone.pdf' }));
    const text = await getText();
    expect(text).toContain('--- Page 1 ---\nstale stored text of page 1');
    expect(text).not.toContain('contain images');
  });

  it('reports a bad page selection instead of falling back', async () => {
    await expect(getText({ pages: '9' })).rejects.toThrow(/4 page/);
  });

  it('counts the pages itself when neither the row nor the stored text knows', async () => {
    getDocument.mockResolvedValue(sampleDoc({ pageCount: null }));
    getDocumentPages.mockResolvedValue([]);
    const text = await getText({ pages: '4' });
    expect(text).toContain('4 pages · showing page 4');
    expect(text).toContain('--- Page 4 ---\nFig. 1');
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
    const dir = path.join(tmp, 'p1', 'd1.mcp2-777');
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
    const dir = path.join(tmp, 'p1', 'd1.mcp2-888');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2.jpg'), Buffer.from('ffd8ffe0cafe', 'hex'));
    const res = await call('get_page_images', { course: 'parallel', fileId: 'd1', pages: '2' });
    expect(res.content.find((c) => c.type === 'image')?.data).toBe(
      Buffer.from('ffd8ffe0cafe', 'hex').toString('base64'),
    );
  });

  it('shrinks a page until its JPEG fits maxBytes', async () => {
    const { renderPages } = await import('@/lib/slides');
    const d = { projectId: 'p1', id: 'd1', filePath: 'p1/d1.pdf' };
    const [big] = await renderPages(d, [3], { cacheName: 'capA', maxWidth: 1024, quality: 90 });
    const bigSize = (await stat(path.join(tmp, big?.path as string))).size;
    const cap = Math.floor(bigSize * 0.5);
    const [small] = await renderPages(d, [3], {
      cacheName: 'capB',
      maxWidth: 1024,
      quality: 90,
      maxBytes: cap,
    });
    expect((await stat(path.join(tmp, small?.path as string))).size).toBeLessThanOrEqual(cap);
  }, 60_000);

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
