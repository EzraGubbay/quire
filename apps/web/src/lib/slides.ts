// Renders a PDF's pages to JPEG files for vision input, with pdf.js (legacy build) and @napi-rs/canvas.
// pdf.js is opened through openPdf (bundled fonts, CMaps, wasm) and the canvas through loadPdfCanvas (one copy).
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { openPdf } from '@/core/pdf/open';
import type { Document } from '@/db/schema';
import { filePath } from './files';
import { pageHasPaint } from './pdf';
import { loadPdfCanvas } from './pdf-canvas';

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
  const canvas = await loadPdfCanvas();
  const data = await readFile(filePath(doc.filePath));
  const pdf = await openPdf(data, { canvasFactory: canvas.CanvasFactory });
  const out: SlideImage[] = [];
  const n = Math.min(pdf.numPages, want);
  for (let i = 1; i <= n; i++) {
    const rel = path.join(dir, `${i}.jpg`);
    const target = filePath(rel);
    if (await stat(target).catch(() => null)) {
      out.push({ pageNo: i, path: rel });
      continue;
    }
    if ((await renderPageTo(pdf, canvas.createCanvas, i, target, maxWidth, opts.quality ?? 80)) === 'blank')
      continue;
    out.push({ pageNo: i, path: rel });
  }
  await pdf.destroy();
  return out;
}

type PdfDoc = Awaited<ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument>['promise']>;
type CreateCanvas = typeof import('@napi-rs/canvas').createCanvas;

/**
 * Whether RGBA pixels are one flat colour: per channel (R, G, B), max minus min is within `tolerance`. A
 * render that failed to paint comes out exactly flat; a real slide with only a page number does not.
 */
export function isFlat(data: Uint8ClampedArray | Uint8Array, tolerance = 6): boolean {
  let loR = 255;
  let hiR = 0;
  let loG = 255;
  let hiG = 0;
  let loB = 255;
  let hiB = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    if (r < loR) loR = r;
    if (r > hiR) hiR = r;
    if (g < loG) loG = g;
    if (g > hiG) hiG = g;
    if (b < loB) loB = b;
    if (b > hiB) hiB = b;
    if (hiR - loR > tolerance || hiG - loG > tolerance || hiB - loB > tolerance) return false;
  }
  return true;
}

const flatCanvas = (c: import('@napi-rs/canvas').Canvas): boolean =>
  isFlat(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);

/**
 * Render one page of an open pdf.js document to a JPEG at `target` (white background, width ≤ maxWidth and,
 * when given, height ≤ maxHeight). With maxBytes, quality and then scale step down until the JPEG fits (dense
 * text pages can otherwise exceed a client's size cap). Written to a temp file and renamed, so a crash, a full
 * disk or a concurrent reader never sees a truncated JPEG at `target`.
 *
 * Blank guard: a render that comes out one flat colour although the page paints something (text, paths, images)
 * is retried once at scale 1; if it is still flat, nothing is written and the result is 'blank', so a failed
 * render is never cached. A page that paints nothing is legitimately empty and is written as usual.
 */
async function renderPageTo(
  pdf: PdfDoc,
  createCanvas: CreateCanvas,
  pageNo: number,
  target: string,
  maxWidth: number,
  quality: number,
  maxHeight?: number,
  maxBytes?: number,
): Promise<'written' | 'blank'> {
  const { writeFile } = await import('node:fs/promises');
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  let scale = Math.min(
    2,
    maxWidth / base.width,
    maxHeight ? maxHeight / base.height : Number.POSITIVE_INFINITY,
  );
  let jpeg: Buffer | undefined;
  let last: import('@napi-rs/canvas').Canvas | undefined;
  // Without maxBytes this runs once, exactly as before. With it: up to 4 scales × 3 qualities.
  for (let attempt = 0; attempt < (maxBytes ? 4 : 1); attempt++, scale *= 0.8) {
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    last = canvas;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;
    for (const q of maxBytes ? [quality, quality - 10, quality - 20] : [quality]) {
      jpeg = await canvas.encode('jpeg', Math.max(20, q));
      if (!maxBytes || jpeg.length <= maxBytes) break;
    }
    if (!maxBytes || (jpeg && jpeg.length <= maxBytes)) break;
  }
  if (!jpeg) throw new Error(`page ${pageNo} did not render`);
  if (last && flatCanvas(last) && (await pageHasPaint(page))) {
    const retryScale = Math.min(
      1,
      maxWidth / base.width,
      maxHeight ? maxHeight / base.height : Number.POSITIVE_INFINITY,
    );
    const viewport = page.getViewport({ scale: retryScale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;
    if (flatCanvas(canvas)) {
      page.cleanup();
      return 'blank';
    }
    for (const q of maxBytes ? [quality, quality - 10, quality - 20] : [quality]) {
      jpeg = await canvas.encode('jpeg', Math.max(20, q));
      if (!maxBytes || jpeg.length <= maxBytes) break;
    }
  }
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, jpeg);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  page.cleanup();
  return 'written';
}

/**
 * Specific pages of a PDF as JPEGs, cached on disk under <project>/<doc>.<cacheName>/<n>.jpg — a cache of its
 * own, so a partial set never confuses renderPageImages' all-pages cache. Only uncached pages are rendered;
 * page numbers past the end of the document are skipped. A page that renders blank although it paints something
 * (see renderPageTo) is not cached and not returned; `onBlank` is told its number.
 */
export async function renderPages(
  doc: Pick<Document, 'projectId' | 'id' | 'filePath'>,
  pageNos: number[],
  opts: {
    cacheName: string;
    maxWidth: number;
    maxHeight?: number;
    quality: number;
    maxBytes?: number;
    onBlank?: (pageNo: number) => void;
  },
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
    const canvas = await loadPdfCanvas();
    const data = await readFile(filePath(doc.filePath));
    const pdf = await openPdf(data, { canvasFactory: canvas.CanvasFactory });
    try {
      for (const n of missing) {
        if (n < 1 || n > pdf.numPages) continue;
        const rel = path.join(dir, `${n}.jpg`);
        const result = await renderPageTo(
          pdf,
          canvas.createCanvas,
          n,
          filePath(rel),
          opts.maxWidth,
          opts.quality,
          opts.maxHeight,
          opts.maxBytes,
        );
        if (result === 'blank') {
          opts.onBlank?.(n);
          continue;
        }
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
