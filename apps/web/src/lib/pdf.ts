// Server-side PDF text extraction with pdf.js (legacy build runs in Node without a DOM).
import { openPdf } from '@/core/pdf/open';
import { layoutPage, MATH_HEAVY_SCORE, type PdfTextItem } from './pdf-layout';

export interface ExtractedPdf {
  pageCount: number;
  pages: string[];
  /** From the PDF info dictionary, when present. */
  title?: string;
  author?: string;
}

/** One page of a PDF as the MCP tools present it. */
export interface PageAnalysis {
  text: string;
  /** The page draws embedded images / figures that the text does not contain. */
  figure: boolean;
  /** The page has formula layout (fractions, sums, sub/superscripts) that text flattens. */
  math: boolean;
}

/** Share of the page an embedded image / figure must cover for the page to count as a figure page. */
export const FIGURE_MIN_COVERAGE = 0.02;

interface RawTextItem {
  str: string;
  dir?: string;
  transform?: number[];
  width?: number;
  fontName?: string;
  hasEOL?: boolean;
}

/**
 * Strip characters a Postgres `text` column can't hold. PDF text layers routinely emit a NUL (`\u0000`)
 * or other control byte for some glyphs, and — rarely — an unpaired UTF-16 surrogate; any one of them makes
 * the whole page insert fail. Keep tab and newline; keep valid surrogate pairs (astral chars like 𝔸, emoji).
 */
export function cleanPdfText(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is exactly the point.
  const noControls = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
  return noControls
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

const tidy = (text: string): string =>
  cleanPdfText(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();

/** The pre-layout join (every item followed by a space or newline): the fallback when layout cannot run. */
function joinItems(items: RawTextItem[]): string {
  let text = '';
  for (const raw of items) {
    text += raw.str;
    text += raw.hasEOL ? '\n' : ' ';
  }
  return text;
}

/**
 * Page text (reading order, real word gaps) and its math score from pdf.js text items. Exported for tests.
 */
export function layoutItems(rawItems: unknown[]): { text: string; mathScore: number } {
  const items = (rawItems as RawTextItem[]).filter((it) => typeof it.str === 'string');
  const placed: PdfTextItem[] = [];
  let upright = 0;
  let sideways = 0;
  for (const it of items) {
    const [a = 1, b = 0, , , x = 0, y = 0] = it.transform ?? [];
    if (it.str.trim() !== '') {
      if (a <= 0 || Math.abs(b) > Math.abs(a)) sideways++;
      else upright++;
    }
    placed.push({
      str: it.str,
      rtl: it.dir === 'rtl',
      x,
      y,
      width: it.width ?? 0,
      fontSize: Math.hypot(a, b) || 1,
      fontName: it.fontName ?? '',
      eol: it.hasEOL === true,
    });
  }
  // Positions only mean "left to right along a baseline" for upright text; rotated pages keep the plain join.
  if (sideways <= upright) {
    try {
      const page = layoutPage(placed);
      return { text: tidy(page.text), mathScore: page.mathScore };
    } catch {
      // fall through to the plain join
    }
  }
  return { text: tidy(joinItems(items)), mathScore: 0 };
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const scaleOf = (m: Matrix): number => Math.abs(m[0] * m[3] - m[1] * m[2]);

const IMAGE_OPS = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'paintImageXObjectRepeat',
  'paintImageMaskXObject',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
  'paintSolidColorImageMask',
];
const PAINT_OPS = ['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'shadingFill'];
/** A form XObject is a drawn figure when it holds real path painting and covers this share of the page. */
const FORM_MIN_COVERAGE = 0.03;
const FORM_MAX_COVERAGE = 0.9;
const FORM_MIN_PATHS = 5;

/**
 * Share of the page (0–1) covered by embedded raster images and drawn form XObjects, from a pdf.js operator
 * list. An image is painted into the unit square of the current transform, so its area is the determinant;
 * the transform is tracked through save/restore/transform and nested forms. Pure: unit-tests on hand-built
 * operator lists.
 */
export function imageCoverage(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: Record<string, number>,
  pageArea: number,
): number {
  if (!(pageArea > 0)) return 0;
  const imageOps = new Set(IMAGE_OPS.map((n) => ops[n]));
  const paintOps = new Set(PAINT_OPS.map((n) => ops[n]));
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const saved: Matrix[] = [];
  const forms: { area: number; paths: number }[] = [];
  let covered = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i] as number;
    const args = argsArray[i] as unknown[] | null | undefined;
    if (fn === ops.save) {
      saved.push(ctm);
    } else if (fn === ops.restore) {
      ctm = saved.pop() ?? ctm;
    } else if (fn === ops.transform && args) {
      ctm = multiply(ctm, Array.from(args as number[]) as Matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      saved.push(ctm);
      const [matrix, bbox] = (args ?? []) as [ArrayLike<number> | null, ArrayLike<number> | null];
      if (matrix) ctm = multiply(ctm, Array.from(matrix) as Matrix);
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bbox ? Array.from(bbox) : [];
      forms.push({ area: Math.abs((x1 - x0) * (y1 - y0)) * scaleOf(ctm), paths: 0 });
    } else if (fn === ops.paintFormXObjectEnd) {
      ctm = saved.pop() ?? ctm;
      const form = forms.pop();
      const share = form ? form.area / pageArea : 0;
      if (form && form.paths >= FORM_MIN_PATHS && share >= FORM_MIN_COVERAGE && share <= FORM_MAX_COVERAGE) {
        covered += form.area;
      }
    } else if (fn === ops.constructPath && args && paintOps.has(args[0] as number)) {
      for (const form of forms) form.paths++;
    } else if (imageOps.has(fn)) {
      covered += Math.min(scaleOf(ctm), pageArea);
    }
  }
  return Math.min(1, covered / pageArea);
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDoc['getPage']>>;

async function figureOnPage(pdfjs: PdfJs, page: PdfPage): Promise<boolean> {
  const list = await page.getOperatorList();
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
  const coverage = imageCoverage(
    list.fnArray,
    list.argsArray,
    pdfjs.OPS as unknown as Record<string, number>,
    Math.abs((x1 - x0) * (y1 - y0)),
  );
  return coverage >= FIGURE_MIN_COVERAGE;
}

export interface PdfAnalyzer {
  pageCount: number;
  /** Text and figure/math flags of one page (1-based). */
  page(pageNo: number): Promise<PageAnalysis>;
  close(): Promise<void>;
}

/**
 * Opens a PDF for page-by-page analysis (the caller decides how many pages it needs). The operator list —
 * the costly part: pdf.js decodes the page's images for it — is only read for pages with at least
 * `minFigureChars` of text; a page with less is reported as a figure/scan by its emptiness alone.
 */
export async function openPdfAnalyzer(data: Uint8Array, minFigureChars = 0): Promise<PdfAnalyzer> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await openPdf(data);
  return {
    pageCount: doc.numPages,
    async page(pageNo) {
      const page = await doc.getPage(pageNo);
      try {
        const content = await page.getTextContent();
        const { text, mathScore } = layoutItems(content.items);
        const figure =
          text.length >= minFigureChars ? await figureOnPage(pdfjs, page).catch(() => false) : false;
        return { text, figure, math: mathScore >= MATH_HEAVY_SCORE };
      } finally {
        page.cleanup();
      }
    },
    close: () => doc.destroy(),
  };
}

export async function extractPdf(data: Uint8Array): Promise<ExtractedPdf> {
  // openPdf hands pdf.js a copy of the bytes, so the caller's buffer stays intact.
  const doc = await openPdf(data);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(layoutItems(content.items).text);
    page.cleanup();
  }
  const meta = (await doc.getMetadata().catch(() => null))?.info as
    | { Title?: string; Author?: string }
    | undefined;
  await doc.destroy();
  const out: ExtractedPdf = { pageCount: doc.numPages, pages };
  if (meta?.Title?.trim()) out.title = cleanPdfText(meta.Title).trim();
  if (meta?.Author?.trim()) out.author = cleanPdfText(meta.Author).trim();
  return out;
}

/** A best-effort title from the first page when the PDF has no metadata title: the first non-trivial line. */
export function guessTitle(firstPage: string, fallback: string): string {
  const line = firstPage
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 12 && l.length <= 200 && !/^(arxiv|https?:|doi|abstract)/i.test(l));
  return line ?? fallback;
}
