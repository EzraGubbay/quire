// Registers the Quire MCP server's tools and resources on an SDK McpServer. Auth-agnostic: the route wraps
// this (bearer today, OAuth later) without touching anything here. Read-only — it only reads courses/files.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type FileFormat,
  listAllFileResources,
  listCourseFiles,
  listCourses,
  readFileBytes,
  resolveFile,
} from './courses';

const MAX_INLINE_BYTES = Number(process.env.MCP_MAX_INLINE_BYTES ?? 10 * 1024 * 1024);
const PUBLIC_BASE = (process.env.QUIRE_PUBLIC_URL ?? 'https://quire.ezragubbay.com').replace(/\/+$/, '');
const mb = (n: number) => (n / (1024 * 1024)).toFixed(n < 1024 * 1024 ? 2 : 1);

type Content =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } };
const text = (value: unknown): { content: Content[] } => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const downloadUrl = (slug: string, docId: string) =>
  `${PUBLIC_BASE}/api/projects/${encodeURIComponent(slug)}/documents/${encodeURIComponent(docId)}/file?download=1`;

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
        `Download it at ${downloadUrl(r.slug, r.docId)} (send the Authorization: Bearer header), ` +
        `or read the resource quire://course/${r.slug}/file/${r.docId}.`,
    );
  }
  const bytes = await readFileBytes(r.rel as string);
  return {
    content: [
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

export function registerQuireMcp(server: McpServer): void {
  server.tool(
    'list_courses',
    'List all Quire courses. Each has a stable slug (use it as the course id elsewhere), name, code, semester, and file count.',
    {},
    async () => text({ courses: await listCourses() }),
  );

  server.tool(
    'list_course_files',
    "List a course's files, each labeled lecture / recitation / homework / exam / book / paper / other, with a stable fileId and a resourceUri for retrieval.",
    { course: z.string().describe('course slug or id, from list_courses') },
    async ({ course }) => text(await listCourseFiles(course)),
  );

  server.tool(
    'get_file',
    'Retrieve a course file. Small PDFs and markdown come back inline; large files return a download URL instead. Prefer reading the resourceUri from list_course_files when you can.',
    {
      course: z.string().describe('course slug or id'),
      fileId: z.string().describe('the fileId from list_course_files'),
      format: z
        .enum(['pdf', 'original', 'markdown'])
        .optional()
        .describe('which representation; defaults to the PDF (or markdown / original when there is no PDF)'),
    },
    async ({ course, fileId, format }) => fileToolResult(course, fileId, format),
  );

  server.resource(
    'course-file',
    new ResourceTemplate('quire://course/{slug}/file/{docId}', {
      list: async () => ({ resources: await listAllFileResources() }),
    }),
    async (uri, variables) => {
      const slug = String(variables.slug);
      const docId = String(variables.docId);
      const format = (uri.searchParams.get('format') as FileFormat | null) ?? undefined;
      const r = await resolveFile(slug, docId, format);
      if (r.kind === 'markdown') {
        return { contents: [{ uri: uri.href, mimeType: r.mimeType, text: r.text ?? '' }] };
      }
      if (r.sizeBytes > MAX_INLINE_BYTES) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/plain',
              text: `${r.filename} is ${mb(r.sizeBytes)} MB, over the ${mb(MAX_INLINE_BYTES)} MB inline limit. Download: ${downloadUrl(r.slug, r.docId)}`,
            },
          ],
        };
      }
      const bytes = await readFileBytes(r.rel as string);
      return { contents: [{ uri: uri.href, mimeType: r.mimeType, blob: bytes.toString('base64') }] };
    },
  );
}
