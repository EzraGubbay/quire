// Registers the Quire MCP server's tools and resources on an SDK McpServer. Auth-agnostic: the route wraps
// this (bearer today, OAuth later) without touching anything here. Four read tools plus additive write
// tools (upload_markdown, create_upload_link, get_upload_status; off with MCP_WRITE_ENABLED=false) — nothing edits or deletes.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_IMAGES_PER_CALL } from './content';
import { type FileFormat, listAllFileResources, listCourseFiles, listCourses } from './courses';
import { driveConfig } from './drive/config';
import { registerDriveTools } from './drive/tools';
import { COURSE_SCOPE, mcpWriteEnabled } from './scope';
import { fileToolResult, imagesToolResult, readFileResource, text, textToolResult } from './tool-results';
import {
  createUploadLinkTool,
  kb,
  uploadLimits,
  uploadMarkdown,
  uploadPdfFromUrl,
  uploadStatusTool,
} from './upload';

const FORMATS = ['pdf', 'original', 'markdown'] as const;
const READ_ONLY = { readOnlyHint: true } as const;
const asFormat = (v: string | null): FileFormat | undefined =>
  v && (FORMATS as readonly string[]).includes(v) ? (v as FileFormat) : undefined;

function registerWriteTools(server: McpServer): void {
  const limits = uploadLimits();
  server.tool(
    'upload_markdown',
    'WRITES to Quire: creates a new Markdown note (section="notes", the default) or Markdown document ' +
      '(section="documents") in a course, optionally inside an existing folder. Never edits or deletes. ' +
      'Re-sending the same title and text returns the existing item instead of a copy; note titles are ' +
      `unique per course. Max ${kb(limits.maxMarkdownBytes)}. For Markdown you write yourself; to upload an ` +
      'existing .md file use create_upload_link.',
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
    async (args) => text(await uploadMarkdown(args, COURSE_SCOPE)),
  );

  server.tool(
    'upload_pdf',
    'WRITES to Quire: downloads a PDF from a public https URL (the server fetches it, max 50 MB) into a ' +
      "course's Documents. Public https URL only (no logins, no private or local addresses; pass the direct " +
      'PDF link, e.g. https://arxiv.org/pdf/<id>); for a local file use create_upload_link. The same PDF ' +
      'already in the course is returned instead of a copy. Large PDFs may return status "processing"; ' +
      'calling again is safe. Never edits or deletes.',
    {
      course: z.string().describe('course slug or id, from list_courses'),
      url: z.string().max(2048).describe('public https link to the PDF'),
      title: z.string().optional().describe('1-200 characters; default: taken from the PDF'),
      folder: z.string().optional().describe('existing Documents folder name or id; default: top level'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args) => text(await uploadPdfFromUrl(args, COURSE_SCOPE)),
  );

  server.tool(
    'create_upload_link',
    'WRITES to Quire (via the link): creates a one-time upload URL (valid 10 minutes, single use) for an ' +
      "EXISTING local file, .pdf into a course's Documents or .md into its Notes or Documents. The file bytes " +
      'never pass through this tool: run the returned curl (PUT) on the machine that has the file, then check ' +
      'get_upload_status. The same file uploaded again returns the existing item. Never edits or deletes.',
    {
      course: z.string().describe('course slug or id, from list_courses'),
      section: z
        .enum(['documents', 'notes'])
        .describe('documents (PDF or Markdown) or notes (Markdown only)'),
      filename: z.string().describe('name of the local file, ending in .pdf, .md or .markdown'),
      contentType: z.string().optional().describe('default application/pdf or text/markdown'),
      title: z.string().optional().describe('1-200 characters; default: from the file'),
      folder: z
        .string()
        .optional()
        .describe('existing folder name or id in that section; default: top level'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => text(await createUploadLinkTool(args, COURSE_SCOPE)),
  );

  server.tool(
    'get_upload_status',
    'Report what an upload link produced: pending (not used yet), processing, created, duplicate, failed ' +
      'or expired, with the new file or note id once done.',
    { uploadId: z.string().describe('the uploadId returned by create_upload_link') },
    READ_ONLY,
    async ({ uploadId }) => text(uploadStatusTool({ uploadId }, COURSE_SCOPE)),
  );

  const drive = driveConfig();
  if (drive.enabled) registerDriveTools(server, drive);
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
        ? textToolResult(course, fileId, pages, COURSE_SCOPE)
        : fileToolResult(course, fileId, format, COURSE_SCOPE),
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
    async ({ course, fileId, pages }) => imagesToolResult(course, fileId, pages, COURSE_SCOPE),
  );

  if (mcpWriteEnabled()) registerWriteTools(server);

  server.resource(
    'course-file',
    new ResourceTemplate('quire://course/{slug}/file/{docId}', {
      list: async () => ({ resources: await listAllFileResources() }),
    }),
    async (uri, variables) =>
      readFileResource(
        uri,
        String(variables.slug),
        String(variables.docId),
        asFormat(uri.searchParams.get('format')),
        COURSE_SCOPE,
      ),
  );
}
