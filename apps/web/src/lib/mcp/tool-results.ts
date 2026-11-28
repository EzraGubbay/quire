// The scope-aware result builders behind get_file / get_page_images / resources/read, shared by the course
// server (lib/mcp/server.ts) and the research server (lib/mcp-research/server.ts). Moved verbatim from
// server.ts; the only differences for COURSE_SCOPE are none, and RESEARCH_SCOPE uses its own resource URIs and
// never prints the /api download URL (the research key cannot reach it).
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildTextResult,
  formatRanges,
  IMAGE_B64_BUDGET,
  loadDoc,
  loadPageContent,
  loadPageImages,
  MAX_IMAGES_PER_CALL,
  parsePageSpec,
  UNKNOWN_PAGE_CAP,
} from './content';
import { type FileFormat, type ResolvedFile, readFileBytes, resolveFile } from './courses';
import { COURSE_SCOPE, type McpScope } from './scope';

export const MAX_INLINE_BYTES = Number(process.env.MCP_MAX_INLINE_BYTES ?? 10 * 1024 * 1024);
const PUBLIC_BASE = (process.env.QUIRE_PUBLIC_URL ?? 'https://quire.ezragubbay.com').replace(/\/+$/, '');
export const mb = (n: number) => (n / (1024 * 1024)).toFixed(n < 1024 * 1024 ? 2 : 1);

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } };
export const text = (value: unknown): { content: Content[] } => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

// The original (.pptx/.key/…) is served by the /original route; everything else downloads as the PDF.
export const downloadUrl = (r: ResolvedFile): string => {
  const base = `${PUBLIC_BASE}/api/projects/${encodeURIComponent(r.slug)}/documents/${encodeURIComponent(r.docId)}`;
  return r.format === 'original' ? `${base}/original` : `${base}/file?download=1`;
};

/** What to say when a file is over the inline limit: a course gets the authenticated download URL; research
 *  (whose key cannot reach /api) gets the in-app page and the text/image tools. */
export function oversizeHint(r: ResolvedFile, scope: McpScope): string {
  if (scope.kind === 'course') {
    return (
      `Download it at ${downloadUrl(r)} (send the Authorization: Bearer header), ` +
      `or read the resource ${scope.uriPrefix}/${r.slug}/file/${r.docId}.`
    );
  }
  return (
    `Open it in Quire at ${PUBLIC_BASE}/p/${encodeURIComponent(r.slug)}/documents/${encodeURIComponent(r.docId)}, ` +
    'or read it with get_file (page text) or get_page_images.'
  );
}

export async function fileToolResult(
  course: string,
  fileId: string,
  format: FileFormat | undefined,
  scope: McpScope,
): Promise<{ content: Content[] }> {
  const r = await resolveFile(course, fileId, format, scope);
  if (r.kind === 'markdown') return text(r.text ?? '');
  if (r.sizeBytes > MAX_INLINE_BYTES) {
    return text(
      `"${r.filename}" is ${mb(r.sizeBytes)} MB, over the ${mb(MAX_INLINE_BYTES)} MB inline limit. ` +
        oversizeHint(r, scope),
    );
  }
  const bytes = await readFileBytes(r.rel as string);
  return {
    content: [
      {
        type: 'text',
        text:
          `Raw ${r.mimeType} file "${r.filename}" (${mb(r.sizeBytes)} MB) is attached as an embedded resource. ` +
          'Many clients cannot read binary attachments: for the content use get_file without format (page ' +
          'text) and get_page_images (pages as images).',
      },
      {
        type: 'resource',
        resource: {
          uri: `${scope.uriPrefix}/${r.slug}/file/${r.docId}`,
          mimeType: r.mimeType,
          blob: bytes.toString('base64'),
        },
      },
    ],
  };
}

/** Default get_file result: page text with page markers (text only — the form every client reads). */
export async function textToolResult(
  course: string,
  fileId: string,
  pages: string | undefined,
  scope: McpScope,
): Promise<{ content: Content[] }> {
  const { doc, courseName } = await loadDoc(course, fileId, scope);
  if (doc.kind === 'markdown' && !doc.filePath) {
    return text(`# ${doc.title}\n\n${doc.markdownBody ?? ''}`);
  }
  if (!doc.filePath) {
    return text(
      `"${doc.title}" has no PDF (its conversion may have failed), so there is no page text.` +
        (doc.originalPath ? ' The original upload is available with format="original" (raw binary).' : ''),
    );
  }
  const content = await loadPageContent(doc, pages);
  const result = buildTextResult({
    title: doc.title,
    courseName,
    pageCount: content.pageCount,
    pageTexts: (n) => content.texts.get(n) ?? '',
    wanted: content.wanted,
    figurePages: (n) => content.figures.has(n),
    mathPages: (n) => content.math.has(n),
  });
  return { content: [{ type: 'text', text: result.text }] };
}

export async function imagesToolResult(
  course: string,
  fileId: string,
  pages: string,
  scope: McpScope,
): Promise<{ content: Content[] }> {
  const { doc } = await loadDoc(course, fileId, scope);
  if (!doc.filePath) return text('This file has no PDF to render; use get_file for its text.');
  const wanted = parsePageSpec(pages, doc.pageCount ?? UNKNOWN_PAGE_CAP);
  const batch = wanted.slice(0, MAX_IMAGES_PER_CALL);
  const imgs = await loadPageImages(doc, batch);
  // Fewer images than asked for means the selection ran past the PDF's real end.
  const pastEnd = imgs.length < batch.length;
  const content: Content[] = [];
  const sent = new Set<number>();
  // Pages dealt with in this reply: sent as images, or reported blank in text.
  const handled = new Set<number>();
  let used = 0;
  for (const img of imgs) {
    if ('blank' in img) {
      content.push({
        type: 'text',
        text: `Page ${img.pageNo} of "${doc.title}" rendered blank, so no image is attached; get_file with pages="${img.pageNo}" has its text.`,
      });
      handled.add(img.pageNo);
      continue;
    }
    if (sent.size > 0 && used + img.data.length > IMAGE_B64_BUDGET) break;
    content.push({ type: 'text', text: `Page ${img.pageNo} of "${doc.title}":` });
    content.push({ type: 'image', data: img.data, mimeType: 'image/jpeg' });
    sent.add(img.pageNo);
    handled.add(img.pageNo);
    used += img.data.length;
  }
  const lastSent = Math.max(0, ...handled);
  const rest = wanted.filter((n) => n > lastSent && (!pastEnd || imgs.some((i) => i.pageNo === n)));
  if (handled.size === 0) {
    content.push({ type: 'text', text: 'No pages rendered: check the page numbers.' });
  } else if (rest.length > 0) {
    content.push({
      type: 'text',
      text: `[More pages: call get_page_images with pages="${formatRanges(rest)}".]`,
    });
  }
  return { content };
}

/** First budget's worth of a PDF's page text, for resources/read. */
export async function pagesAsText(course: string, fileId: string, scope: McpScope): Promise<string> {
  const { doc, courseName } = await loadDoc(course, fileId, scope);
  const content = await loadPageContent(doc);
  return buildTextResult({
    title: doc.title,
    courseName,
    pageCount: content.pageCount,
    pageTexts: (n) => content.texts.get(n) ?? '',
    wanted: content.wanted,
    figurePages: (n) => content.figures.has(n),
    mathPages: (n) => content.math.has(n),
  }).text;
}

/** resources/read for one file, for either server. */
export async function readFileResource(
  uri: URL,
  slug: string,
  docId: string,
  format: FileFormat | undefined,
  scope: McpScope,
): Promise<ReadResourceResult> {
  const r = await resolveFile(slug, docId, format, scope);
  if (r.kind === 'markdown') {
    return { contents: [{ uri: uri.href, mimeType: r.mimeType, text: r.text ?? '' }] };
  }
  if (r.sizeBytes > MAX_INLINE_BYTES) {
    const tail = scope.kind === 'course' ? `Download: ${downloadUrl(r)}` : oversizeHint(r, scope);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/plain',
          text: `${r.filename} is ${mb(r.sizeBytes)} MB, over the ${mb(MAX_INLINE_BYTES)} MB inline limit. ${tail}`,
        },
      ],
    };
  }
  const bytes = await readFileBytes(r.rel as string);
  const blob = { uri: uri.href, mimeType: r.mimeType, blob: bytes.toString('base64') };
  if (r.format !== 'pdf') return { contents: [blob] };
  // Lead with the page text so clients that can't open a PDF blob still get the content.
  const extracted = await pagesAsText(slug, docId, scope).catch(() => null);
  return {
    contents: extracted ? [{ uri: uri.href, mimeType: 'text/plain', text: extracted }, blob] : [blob],
  };
}
