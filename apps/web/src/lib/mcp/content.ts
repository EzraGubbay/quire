// Turns a course file into MCP content every Claude client can actually read. A PDF returned as an embedded
// `application/pdf` blob is opaque to most clients (Claude Code saves it to disk; chat clients show it as a
// binary attachment or drop it), so the default representation is the page text with `--- Page N ---`
// markers — the one form every client (Claude Code, Desktop/claude.ai, voice) passes to the model. Page images
// are opt-in (get_page_images): small JPEGs for figures, unverified in voice and dropped by the API connector.
// The pure helpers (parsePageSpec, formatRanges, buildTextResult) unit-test without a DB.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Document } from '@/db/schema';
import { getDocument, getDocumentPages } from '@/lib/documents';
import { filePath, readStoredFile } from '@/lib/files';
import { openPdfAnalyzer, type PageAnalysis, type PdfAnalyzer } from '@/lib/pdf';
import { renderPages } from '@/lib/slides';
import { resolveInScope } from './resolve';
import { COURSE_SCOPE, type McpScope } from './scope';

/**
 * Characters of page text per get_file call. Hebrew and math cost more tokens per character than English,
 * so 20k keeps a call well under Claude Code's 25k-token MCP cap and claude.ai's ~150k-character cap.
 */
const envBudget = Number(process.env.MCP_TEXT_BUDGET_CHARS);
export const TEXT_BUDGET = Number.isFinite(envBudget) && envBudget >= 1000 ? envBudget : 20_000;
/** Page images per get_page_images call (rendering is ~1–3 s/page on the Pi). */
export const MAX_IMAGES_PER_CALL = 4;
/**
 * Base64 characters of images per call. claude.ai caps a tool result at ~150k characters and may count image
 * data, so stop adding images past this (a call always returns at least one).
 */
export const IMAGE_B64_BUDGET = 100_000;
/** Per-image JPEG cap: 72 KB → ~96k base64 characters, under IMAGE_B64_BUDGET and claude.ai's ~150k cap. */
export const IMAGE_MAX_BYTES = 72_000;
/** Without a stored page count, cap page selections here (renderPages skips pages past the real end). */
export const UNKNOWN_PAGE_CAP = 2000;
/** A page with less extractable text than this is treated as a figure / scan. */
export const SPARSE_CHARS = 40;
/** Don't extract text on the fly from PDFs bigger than this (pages are normally stored at upload). */
const MAX_ON_THE_FLY_BYTES = 60 * 1024 * 1024;
/** Bump when the extractor's output changes: it is part of the on-disk cache name. */
const TEXT_CACHE_VERSION = 1;

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * Parse a page selection like "3", "2-5", "1-3,7" or "10-" (to the end) into sorted, de-duplicated page
 * numbers clamped to the document. Empty/undefined means every page.
 */
export function parsePageSpec(spec: string | undefined, pageCount: number): number[] {
  if (pageCount < 1) return [];
  if (!spec?.trim()) return range(1, pageCount);
  const out = new Set<number>();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part);
    if (!m) throw new Error(`Bad page range "${part}". Use e.g. "3", "2-5", "1-3,7" or "10-".`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? pageCount : Number(m[2]);
    if (a < 1 || b < a) throw new Error(`Bad page range "${part}".`);
    for (let i = a; i <= Math.min(b, pageCount); i++) out.add(i);
  }
  if (out.size === 0) throw new Error(`No pages in "${spec}": this file has ${pageCount} page(s).`);
  return [...out].sort((x, y) => x - y);
}

/** [1,2,3,7,9,10] → "1-3,7,9-10" (round-trips through parsePageSpec). */
export function formatRanges(pages: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === (pages[j] as number) + 1) j++;
    parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

export interface TextResult {
  text: string;
  /** Pages whose text is in `text`. */
  shown: number[];
  /** Requested pages left out for the budget — the next call's `pages`. */
  remaining: number[];
  /** Shown pages with (almost) no extractable text: figures, diagrams, scans. */
  sparse: number[];
  /** Shown pages that have text and also embedded images / figures the text cannot carry. */
  figures: number[];
  /** Shown pages whose formulas (fractions, sums, limits) are flattened in the text. */
  math: number[];
}

/**
 * Lay out page texts for the model: a header, `--- Page N ---` sections in order, and footers that say how to
 * get the rest and which pages are figures. Stops before the budget is exceeded (always shows ≥ 1 page; a
 * single over-budget page is cut and says so).
 */
export function buildTextResult(input: {
  title: string;
  courseName: string;
  pageCount: number;
  pageTexts: (pageNo: number) => string;
  wanted: number[];
  budget?: number;
  /** Pages known to draw embedded images / figures. */
  figurePages?: (pageNo: number) => boolean;
  /** Pages known to be math-heavy. */
  mathPages?: (pageNo: number) => boolean;
}): TextResult {
  const budget = input.budget ?? TEXT_BUDGET;
  const shown: number[] = [];
  const sparse: number[] = [];
  const figures: number[] = [];
  const math: number[] = [];
  const sections: string[] = [];
  let used = 0;
  let k = 0;
  for (; k < input.wanted.length; k++) {
    const n = input.wanted[k] as number;
    const body = input.pageTexts(n).trim();
    let block = `--- Page ${n} ---\n${body || '[no extractable text on this page]'}\n`;
    if (used + block.length > budget) {
      if (shown.length > 0) break;
      // Don't split a surrogate pair (math alphanumerics like 𝑥 are outside the BMP).
      const end = /[\uD800-\uDBFF]/.test(block.charAt(budget - 1)) ? budget - 1 : budget;
      block = `${block.slice(0, end)}\n[… page ${n} cut at ${budget} characters]\n`;
    }
    sections.push(block);
    used += block.length;
    shown.push(n);
    if (body.length < SPARSE_CHARS) sparse.push(n);
    else if (input.figurePages?.(n)) figures.push(n);
    if (input.mathPages?.(n)) math.push(n);
  }
  const remaining = input.wanted.slice(k);
  const lines = [
    `# ${input.title}`,
    `Course: ${input.courseName} · ${input.pageCount} page${input.pageCount === 1 ? '' : 's'} · showing ${
      shown.length === 0 ? 'no pages' : `page${shown.length === 1 ? '' : 's'} ${formatRanges(shown)}`
    }`,
    '',
    ...sections,
  ];
  if (remaining.length > 0) {
    lines.push(`[More pages: call get_file again with pages="${formatRanges(remaining)}".]`);
  }
  if (sparse.length > 0) {
    lines.push(
      `[Pages ${formatRanges(sparse)} have little or no text (figures, diagrams or scans). ` +
        `Call get_page_images with pages="${formatRanges(sparse)}" to see them.]`,
    );
  }
  if (figures.length > 0) {
    lines.push(
      `[Pages ${formatRanges(figures)} contain images or figures that this text does not include. ` +
        `Call get_page_images with pages="${formatRanges(figures)}" to see them.]`,
    );
  }
  if (math.length > 0) {
    lines.push(
      `[Pages ${formatRanges(math)} contain formulas whose layout (fractions, sums, limits) is flattened in ` +
        `this text. Call get_page_images with pages="${formatRanges(math)}" to read them exactly.]`,
    );
  }
  return { text: lines.join('\n'), shown, remaining, sparse, figures, math };
}

export interface LoadedDoc {
  doc: Document;
  courseName: string;
  slug: string;
}

export async function loadDoc(
  course: string,
  fileId: string,
  scope: McpScope = COURSE_SCOPE,
): Promise<LoadedDoc> {
  const project = await resolveInScope(scope, course);
  if (!project) throw new Error(`No ${scope.noun} found for "${course}"`);
  const doc = await getDocument(project.id, fileId);
  if (!doc) throw new Error(`No file "${fileId}" in ${scope.noun} "${project.slug}"`);
  return { doc, courseName: project.name, slug: project.slug };
}

export interface PageContent {
  pageCount: number;
  /** The requested pages (parsePageSpec of the selection). */
  wanted: number[];
  /** Text by page number, for at least every page the budget will show. */
  texts: Map<number, string>;
  figures: Set<number>;
  math: Set<number>;
}

type CachedPage = { t: string; f?: 1; m?: 1 };
type TextCache = { v: number; pages: Record<string, CachedPage> };

/** <project>/<doc>.mcp-text-v<N>-<size>.json: the version and the file size invalidate it. */
const textCachePath = (doc: Pick<Document, 'projectId' | 'id' | 'fileSize'>): string =>
  path.join(doc.projectId, `${doc.id}.mcp-text-v${TEXT_CACHE_VERSION}-${doc.fileSize ?? 0}.json`);

async function readTextCache(rel: string): Promise<TextCache> {
  try {
    const parsed = JSON.parse(await readFile(filePath(rel), 'utf8')) as TextCache;
    if (parsed?.v === TEXT_CACHE_VERSION && parsed.pages && typeof parsed.pages === 'object') return parsed;
  } catch {
    // missing or unreadable: start over
  }
  return { v: TEXT_CACHE_VERSION, pages: {} };
}

/** Temp file + rename, so a concurrent reader never sees half a cache. A failed write only costs a re-extract. */
async function writeTextCache(rel: string, cache: TextCache): Promise<void> {
  const target = filePath(rel);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, target);
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Page text and figure/math flags for a get_file call. The text is re-extracted from the PDF with the
 * current extractor (reading order for right-to-left text, real word gaps, image detection) rather than taken
 * from `document_pages`, whose rows were written by whatever extractor ran at upload. Only as many of the
 * wanted pages as the text budget can show are analysed, and each analysed page is cached on disk. The stored
 * rows remain the fallback when the PDF is missing, too large or unreadable.
 */
export async function loadPageContent(
  doc: Document,
  pages?: string,
  budget: number = TEXT_BUDGET,
): Promise<PageContent> {
  const rows = await getDocumentPages(doc.id);
  const texts = new Map(rows.map((r) => [r.pageNo, r.text]));
  const figures = new Set<number>();
  const math = new Set<number>();
  const tooLarge = (doc.fileSize ?? 0) > MAX_ON_THE_FLY_BYTES;
  if (!doc.filePath || tooLarge) {
    if (doc.filePath && rows.length === 0) {
      throw new Error('No stored text for this large PDF. Use get_page_images to read its pages.');
    }
    const pageCount = doc.pageCount ?? texts.size;
    return { pageCount, wanted: parsePageSpec(pages, pageCount), texts, figures, math };
  }

  const source = doc.filePath;
  const cacheRel = textCachePath(doc);
  const cache = await readTextCache(cacheRel);
  let analyzer: PdfAnalyzer | undefined;
  const open = async (): Promise<PdfAnalyzer> => {
    analyzer ??= await openPdfAnalyzer(await readStoredFile(source), SPARSE_CHARS);
    return analyzer;
  };
  let added = 0;
  try {
    let pageCount = doc.pageCount ?? rows.length;
    if (pageCount < 1) pageCount = (await open()).pageCount;
    const wanted = parsePageSpec(pages, pageCount);
    try {
      let used = 0;
      for (const n of wanted) {
        let page: CachedPage | undefined = cache.pages[n];
        if (!page) {
          const pdf = await open();
          if (n > pdf.pageCount) break;
          const fresh: PageAnalysis = await pdf.page(n);
          page = { t: fresh.text, ...(fresh.figure ? { f: 1 } : {}), ...(fresh.math ? { m: 1 } : {}) };
          cache.pages[n] = page;
          added++;
        }
        texts.set(n, page.t);
        if (page.f) figures.add(n);
        if (page.m) math.add(n);
        // buildTextResult stops at the first page that overflows the budget; nothing later is shown.
        used += page.t.length;
        if (used > budget) break;
      }
    } catch (err) {
      // Unreadable PDF: the stored text stands in. With nothing stored there is nothing to fall back to.
      if (rows.length === 0) throw err;
    }
    return { pageCount, wanted, texts, figures, math };
  } finally {
    await analyzer?.close().catch(() => undefined);
    if (added > 0) await writeTextCache(cacheRel, cache);
  }
}

/** JPEG page images as base64, in page order (cached on disk after the first render). */
export async function loadPageImages(
  doc: Document,
  pageNos: number[],
): Promise<{ pageNo: number; data: string }[]> {
  // 1024×1568 max, q60, shrunk until ≤ IMAGE_MAX_BYTES (one image always fits the per-call budget). The file
  // size in the cache name invalidates it when the PDF is replaced; v2 drops images cached before the cap.
  const imgs = await renderPages(doc, pageNos, {
    cacheName: `mcp2-${doc.fileSize ?? 0}`,
    maxWidth: 1024,
    maxHeight: 1568,
    quality: 60,
    maxBytes: IMAGE_MAX_BYTES,
  });
  return Promise.all(
    imgs.map(async (img) => ({
      pageNo: img.pageNo,
      data: (await readStoredFile(img.path)).toString('base64'),
    })),
  );
}
