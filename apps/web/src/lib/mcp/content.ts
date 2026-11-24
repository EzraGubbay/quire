// Turns a course file into MCP content every Claude client can actually read. A PDF returned as an embedded
// `application/pdf` blob is opaque to most clients (Claude Code saves it to disk; chat clients show it as a
// binary attachment or drop it), so the default representation is the page text with `--- Page N ---`
// markers — the one form every client (Claude Code, Desktop/claude.ai, voice) passes to the model. Page images
// are opt-in (get_page_images): small JPEGs for figures, unverified in voice and dropped by the API connector.
// The pure helpers (parsePageSpec, formatRanges, buildTextResult) unit-test without a DB.
import type { Document } from '@/db/schema';
import { getDocument, getDocumentPages } from '@/lib/documents';
import { readStoredFile } from '@/lib/files';
import { extractPdf } from '@/lib/pdf';
import { renderPages } from '@/lib/slides';
import { resolveCourse } from './courses';

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
/** Without a stored page count, cap page selections here (renderPages skips pages past the real end). */
export const UNKNOWN_PAGE_CAP = 2000;
/** A page with less extractable text than this is treated as a figure / scan. */
export const SPARSE_CHARS = 40;
/** Don't extract text on the fly from PDFs bigger than this (pages are normally stored at upload). */
const MAX_ON_THE_FLY_BYTES = 60 * 1024 * 1024;

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
}): TextResult {
  const budget = input.budget ?? TEXT_BUDGET;
  const shown: number[] = [];
  const sparse: number[] = [];
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
  return { text: lines.join('\n'), shown, remaining, sparse };
}

export interface LoadedDoc {
  doc: Document;
  courseName: string;
  slug: string;
}

export async function loadDoc(course: string, fileId: string): Promise<LoadedDoc> {
  const project = await resolveCourse(course);
  if (!project) throw new Error(`No course found for "${course}"`);
  const doc = await getDocument(project.id, fileId);
  if (!doc) throw new Error(`No file "${fileId}" in course "${project.slug}"`);
  return { doc, courseName: project.name, slug: project.slug };
}

/** Page texts by page number: the stored per-page text, or a one-off extraction when none was stored. */
export async function loadPageTexts(doc: Document): Promise<Map<number, string>> {
  const rows = await getDocumentPages(doc.id);
  if (rows.length > 0) return new Map(rows.map((r) => [r.pageNo, r.text]));
  if (!doc.filePath) return new Map();
  if ((doc.fileSize ?? 0) > MAX_ON_THE_FLY_BYTES) {
    throw new Error('No stored text for this large PDF. Use get_page_images to read its pages.');
  }
  const pdf = await extractPdf(await readStoredFile(doc.filePath));
  return new Map(pdf.pages.map((t, i) => [i + 1, t]));
}

/** JPEG page images as base64, in page order (cached on disk after the first render). */
export async function loadPageImages(
  doc: Document,
  pageNos: number[],
): Promise<{ pageNo: number; data: string }[]> {
  // 1024×1568 max, q60: ~50–150 KB. The file size in the cache name invalidates it when the PDF is replaced.
  const imgs = await renderPages(doc, pageNos, {
    cacheName: `mcp-${doc.fileSize ?? 0}`,
    maxWidth: 1024,
    maxHeight: 1568,
    quality: 60,
  });
  return Promise.all(
    imgs.map(async (img) => ({
      pageNo: img.pageNo,
      data: (await readStoredFile(img.path)).toString('base64'),
    })),
  );
}
