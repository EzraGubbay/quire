// Registers the Quire MCP server's tools and resources on an SDK McpServer. Auth-agnostic: the route wraps
// this (bearer today, OAuth later) without touching anything here. Four read tools plus an additive write
// tool (upload_markdown; off with MCP_WRITE_ENABLED=false) — nothing edits or deletes.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
import {
  type FileFormat,
  listAllFileResources,
  listCourseFiles,
  listCourses,
  type ResolvedFile,
  readFileBytes,
  resolveFile,
} from './courses';
import { kb, mcpWriteEnabled, uploadLimits, uploadMarkdown } from './upload';

const FORMATS = ['pdf', 'original', 'markdown'] as const;
const READ_ONLY = { readOnlyHint: true } as const;
const asFormat = (v: string | null): FileFormat | undefined =>
  v && (FORMATS as readonly string[]).includes(v) ? (v as FileFormat) : undefined;

const MAX_INLINE_BYTES = Number(process.env.MCP_MAX_INLINE_BYTES ?? 10 * 1024 * 1024);
const PUBLIC_BASE = (process.env.QUIRE_PUBLIC_URL ?? 'https://quire.ezragubbay.com').replace(/\/+$/, '');
const mb = (n: number) => (n / (1024 * 1024)).toFixed(n < 1024 * 1024 ? 2 : 1);

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } };
const text = (value: unknown): { content: Content[] } => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

// The original (.pptx/.key/…) is served by the /original route; everything else downloads as the PDF.
const downloadUrl = (r: ResolvedFile): string => {
  const base = `${PUBLIC_BASE}/api/projects/${encodeURIComponent(r.slug)}/documents/${encodeURIComponent(r.docId)}`;
  return r.format === 'original' ? `${base}/original` : `${base}/file?download=1`;
};

async function fileToolResult(
  course: string,
  fileId: string,
  format?: FileFormat,
): Promise<{ content: Content[] }> {
  const r = await resolveFile(course, fileId, format);
  if (r.kind === 'markdown') return text(r.text ?? '');
  if (r.sizeBytes > MAX_INLINE_BYTES) {
    return text(
      `"${r.filename}" is ${mb(r.sizeBytes)} MB, over the ${mb(MAX_INLINE_BYTES)} MB inline limit. ` +
        `Download it at ${downloadUrl(r)} (send the Authorization: Bearer header), ` +
        `or read the resource quire://course/${r.slug}/file/${r.docId}.`,
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
          uri: `quire://course/${r.slug}/file/${r.docId}`,
          mimeType: r.mimeType,
          blob: bytes.toString('base64'),
        },
      },
    ],
  };
}

/** Default get_file result: page text with page markers (text only — the form every client reads). */
async function textToolResult(
  course: string,
  fileId: string,
  pages?: string,
): Promise<{ content: Content[] }> {
  const { doc, courseName } = await loadDoc(course, fileId);
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

async function imagesToolResult(
  course: string,
  fileId: string,
  pages: string,
): Promise<{ content: Content[] }> {
  const { doc } = await loadDoc(course, fileId);
  if (!doc.filePath) return text('This file has no PDF to render; use get_file for its text.');
  const wanted = parsePageSpec(pages, doc.pageCount ?? UNKNOWN_PAGE_CAP);
  const batch = wanted.slice(0, MAX_IMAGES_PER_CALL);
  const imgs = await loadPageImages(doc, batch);
  // Fewer images than asked for means the selection ran past the PDF's real end.
  const pastEnd = imgs.length < batch.length;
  const content: Content[] = [];
  const sent = new Set<number>();
  let used = 0;
  for (const img of imgs) {
    if (sent.size > 0 && used + img.data.length > IMAGE_B64_BUDGET) break;
    content.push({ type: 'text', text: `Page ${img.pageNo} of "${doc.title}":` });
    content.push({ type: 'image', data: img.data, mimeType: 'image/jpeg' });
    sent.add(img.pageNo);
    used += img.data.length;
  }
  const lastSent = Math.max(0, ...sent);
  const rest = wanted.filter((n) => n > lastSent && (!pastEnd || imgs.some((i) => i.pageNo === n)));
  if (sent.size === 0) {
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
async function pagesAsText(course: string, fileId: string): Promise<string> {
  const { doc, courseName } = await loadDoc(course, fileId);
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

function registerWriteTools(server: McpServer): void {
  const limits = uploadLimits();
  server.tool(
    'upload_markdown',
    'WRITES to Quire: creates a new Markdown note (section="notes", the default) or Markdown document ' +
      '(section="documents") in a course, optionally inside an existing folder. Never edits or deletes. ' +
      'Re-sending the same title and text returns the existing item instead of a copy; note titles are ' +
      `unique per course. Max ${kb(limits.maxMarkdownBytes)}. For Markdown you write yourself.`,
    {
      course: z.string().describe('course slug or id, from list_courses'),
      markdown: z
        .string()
        .describe('the Markdown text; a leading "# Title" line is used as the title if none is given'),
      section: z.enum(['notes', 'documents']).optional().describe('notes (default) or documents'),
      title: z
        .string()
        .optional()
        .describe('1-200 characters; default: the first "# Heading" of the markdown'),
      folder: z
        .string()
        .optional()
        .describe('existing folder name or id in that section; default: top level'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => text(await uploadMarkdown(args)),
  );
}

export function registerQuireMcp(server: McpServer): void {
  server.tool(
    'list_courses',
    'List all Quire courses. Each has a stable slug (use it as the course id elsewhere), name, code, semester, and file count.',
    {},
    READ_ONLY,
    async () => text({ courses: await listCourses() }),
  );

  server.tool(
    'list_course_files',
    "List a course's files, each labeled lecture / recitation / homework / exam / book / paper / other, with a stable fileId and a resourceUri for retrieval.",
    { course: z.string().describe('course slug or id, from list_courses') },
    READ_ONLY,
    async ({ course }) => text(await listCourseFiles(course)),
  );

  server.tool(
    'get_file',
    'Read a course file. By default returns its text page by page ("--- Page N ---" markers, ~30k characters ' +
      'per call; pass `pages` to continue) and flags pages that are mostly figures, contain embedded images ' +
      'or are heavy on formulas. Use get_page_images to see diagrams, slides, formulas or scans. format="pdf"/"original" returns the raw file as an embedded binary ' +
      'resource, which only Claude Code can open (other clients fail or drop it); use it only when the user ' +
      'needs the file itself.',
    {
      course: z.string().describe('course slug or id'),
      fileId: z.string().describe('the fileId from list_course_files'),
      pages: z
        .string()
        .optional()
        .describe('pages to read, e.g. "1-10", "3,7" or "20-" (to the end); default: from page 1'),
      format: z
        .enum(['text', 'pdf', 'original', 'markdown'])
        .optional()
        .describe(
          'text (default) = extracted page text; pdf/original = raw binary file; markdown = note body',
        ),
    },
    READ_ONLY,
    async ({ course, fileId, pages, format }) =>
      !format || format === 'text'
        ? textToolResult(course, fileId, pages)
        : fileToolResult(course, fileId, format),
  );

  server.tool(
    'get_page_images',
    `Render pages of a course file's PDF as JPEG images (max ${MAX_IMAGES_PER_CALL} per call) to see slides, ` +
      'diagrams, formulas, tables or scanned pages.',
    {
      course: z.string().describe('course slug or id'),
      fileId: z.string().describe('the fileId from list_course_files'),
      pages: z.string().describe('pages to render, e.g. "4", "2-5" or "1,3,8"'),
    },
    READ_ONLY,
    async ({ course, fileId, pages }) => imagesToolResult(course, fileId, pages),
  );

  if (mcpWriteEnabled()) registerWriteTools(server);

  server.resource(
    'course-file',
    new ResourceTemplate('quire://course/{slug}/file/{docId}', {
      list: async () => ({ resources: await listAllFileResources() }),
    }),
    async (uri, variables) => {
      const slug = String(variables.slug);
      const docId = String(variables.docId);
      const r = await resolveFile(slug, docId, asFormat(uri.searchParams.get('format')));
      if (r.kind === 'markdown') {
        return { contents: [{ uri: uri.href, mimeType: r.mimeType, text: r.text ?? '' }] };
      }
      if (r.sizeBytes > MAX_INLINE_BYTES) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/plain',
              text: `${r.filename} is ${mb(r.sizeBytes)} MB, over the ${mb(MAX_INLINE_BYTES)} MB inline limit. Download: ${downloadUrl(r)}`,
            },
          ],
        };
      }
      const bytes = await readFileBytes(r.rel as string);
      const blob = { uri: uri.href, mimeType: r.mimeType, blob: bytes.toString('base64') };
      if (r.format !== 'pdf') return { contents: [blob] };
      // Lead with the page text so clients that can't open a PDF blob still get the content.
      const extracted = await pagesAsText(slug, docId).catch(() => null);
      return {
        contents: extracted ? [{ uri: uri.href, mimeType: 'text/plain', text: extracted }, blob] : [blob],
      };
    },
  );
}
