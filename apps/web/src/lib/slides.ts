// Renders a PDF's pages to JPEG files for vision input, with pdf.js (legacy build) and @napi-rs/canvas.
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
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
  const { writeFile } = await import('node:fs/promises');
  const n = Math.min(pdf.numPages, want);
  for (let i = 1; i <= n; i++) {
    const rel = path.join(dir, `${i}.jpg`);
    const target = filePath(rel);
    if (await stat(target).catch(() => null)) {
      out.push({ pageNo: i, path: rel });
      continue;
    }
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, maxWidth / base.width);
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
    const jpeg = await canvas.encode('jpeg', opts.quality ?? 80);
    await writeFile(target, jpeg);
    page.cleanup();
    out.push({ pageNo: i, path: rel });
  }
  await pdf.destroy();
  return out;
}

/** data: URL for a stored JPEG, for the chat API's image parts. */
export async function slideDataUrl(rel: string): Promise<string> {
  const buf = await readFile(filePath(rel));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
