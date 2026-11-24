// Renders a PDF's pages to JPEG files for vision input, with pdf.js (legacy build) and @napi-rs/canvas.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Document } from '@/db/schema';
import { filePath } from './files';

export interface SlideImage {
  pageNo: number;
  /** Relative to FILES_DIR. */
  path: string;
}

/** Token cost of one image at detail "high" after scaling to ~1280 px wide (6 tiles × 170 + 85). */
export const IMAGE_TOKENS_HIGH = 1105;

/** Where a document's slide images live: <project>/<doc>.slides/<n>.jpg. */
const slidesDir = (doc: Pick<Document, 'projectId' | 'id'>) => path.join(doc.projectId, `${doc.id}.slides`);

/**
 * Pages of a PDF as JPEGs (cached on disk; rendered once). Returns [] when the document has no file. Width is
 * capped so a slide costs about one high-detail image's worth of tokens.
 */
export async function renderPageImages(
  doc: Pick<Document, 'projectId' | 'id' | 'filePath' | 'pageCount'>,
  opts: { maxWidth?: number; quality?: number; maxPages?: number } = {},
): Promise<SlideImage[]> {
  if (!doc.filePath) return [];
  const maxWidth = opts.maxWidth ?? 1280;
  const dir = slidesDir(doc);
  const abs = filePath(dir);
  const want = Math.min(doc.pageCount ?? Number.MAX_SAFE_INTEGER, opts.maxPages ?? 200);
  const existing = await readdir(abs).catch(() => [] as string[]);
  const have = existing.filter((f) => /^\d+\.jpg$/.test(f)).length;
  if (have >= Math.min(want, doc.pageCount ?? want) && have > 0) {
    return existing
      .filter((f) => /^\d+\.jpg$/.test(f))
      .map((f) => Number(f.replace('.jpg', '')))
      .sort((a, b) => a - b)
      .slice(0, want)
      .map((n) => ({ pageNo: n, path: path.join(dir, `${n}.jpg`) }));
  }
  await mkdir(abs, { recursive: true });
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import('@napi-rs/canvas'),
    import('pdfjs-dist/legacy/build/pdf.mjs'),
  ]);
  const data = await readFile(filePath(doc.filePath));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const out: SlideImage[] = [];
  const n = Math.min(pdf.numPages, want);
  for (let i = 1; i <= n; i++) {
    const rel = path.join(dir, `${i}.jpg`);
    const target = filePath(rel);
    if (await stat(target).catch(() => null)) {
      out.push({ pageNo: i, path: rel });
      continue;
    }
    await renderPageTo(pdf, createCanvas, i, target, maxWidth, opts.quality ?? 80);
    out.push({ pageNo: i, path: rel });
  }
  await pdf.destroy();
  return out;
}

type PdfDoc = Awaited<ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument>['promise']>;
type CreateCanvas = typeof import('@napi-rs/canvas').createCanvas;

/**
 * Render one page of an open pdf.js document to a JPEG at `target` (white background, width ≤ maxWidth and,
 * when given, height ≤ maxHeight). Written to a temp file and renamed, so a crash, a full disk or a concurrent
 * reader never sees a truncated JPEG at `target`.
 */
async function renderPageTo(
  pdf: PdfDoc,
  createCanvas: CreateCanvas,
  pageNo: number,
  target: string,
  maxWidth: number,
  quality: number,
  maxHeight?: number,
): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    2,
    maxWidth / base.width,
    maxHeight ? maxHeight / base.height : Number.POSITIVE_INFINITY,
  );
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;
  const jpeg = await canvas.encode('jpeg', quality);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, jpeg);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  page.cleanup();
}

/**
 * Specific pages of a PDF as JPEGs, cached on disk under <project>/<doc>.<cacheName>/<n>.jpg — a cache of its
 * own, so a partial set never confuses renderPageImages' all-pages cache. Only uncached pages are rendered;
 * page numbers past the end of the document are skipped.
 */
export async function renderPages(
  doc: Pick<Document, 'projectId' | 'id' | 'filePath'>,
  pageNos: number[],
  opts: { cacheName: string; maxWidth: number; maxHeight?: number; quality: number },
): Promise<SlideImage[]> {
  if (!doc.filePath || pageNos.length === 0) return [];
  const dir = path.join(doc.projectId, `${doc.id}.${opts.cacheName}`);
  await mkdir(filePath(dir), { recursive: true });
  const out: SlideImage[] = [];
  const missing: number[] = [];
  for (const n of pageNos) {
    const rel = path.join(dir, `${n}.jpg`);
    const cached = await stat(filePath(rel)).catch(() => null);
    if (cached && cached.size > 0) out.push({ pageNo: n, path: rel });
    else missing.push(n);
  }
  if (missing.length > 0) {
    const [{ createCanvas }, pdfjs] = await Promise.all([
      import('@napi-rs/canvas'),
      import('pdfjs-dist/legacy/build/pdf.mjs'),
    ]);
    const data = await readFile(filePath(doc.filePath));
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
    try {
      for (const n of missing) {
        if (n < 1 || n > pdf.numPages) continue;
        const rel = path.join(dir, `${n}.jpg`);
        await renderPageTo(pdf, createCanvas, n, filePath(rel), opts.maxWidth, opts.quality, opts.maxHeight);
        out.push({ pageNo: n, path: rel });
      }
    } finally {
      await pdf.destroy();
    }
  }
  return out.sort((a, b) => a.pageNo - b.pageNo);
}

/** data: URL for a stored JPEG, for the chat API's image parts. */
export async function slideDataUrl(rel: string): Promise<string> {
  const buf = await readFile(filePath(rel));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
