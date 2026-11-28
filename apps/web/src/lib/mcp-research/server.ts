// Registers the Quire Research MCP server (/research/mcp). Research-worded and scope-locked to
// kind='research' projects: it never registers course or Drive tools. Read tools always; additive write tools
// unless MCP_RESEARCH_WRITE_ENABLED=false. Nothing edits or deletes.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_IMAGES_PER_CALL, TEXT_BUDGET } from '@/lib/mcp/content';
import type { FileFormat } from '@/lib/mcp/courses';
import { RESEARCH_SCOPE } from '@/lib/mcp/scope';
import {
  fileToolResult,
  imagesToolResult,
  readFileResource,
  text,
  textToolResult,
} from '@/lib/mcp/tool-results';
import {
  createUploadLinkTool,
  kb,
  uploadLimits,
  uploadMarkdown,
  uploadPdfFromUrl,
  uploadStatusTool,
} from '@/lib/mcp/upload';
import { addPaper } from './papers';
import {
  getNoteMarkdown,
  listAllResearchFileResources,
  listProjectFiles,
  listResearchProjects,
} from './projects';

const FORMATS = ['pdf', 'original', 'markdown'] as const;
const READ_ONLY = { readOnlyHint: true } as const;
const asFormat = (v: string | null): FileFormat | undefined =>
  v && (FORMATS as readonly string[]).includes(v) ? (v as FileFormat) : undefined;
const S = RESEARCH_SCOPE;
const PROJECT = z.string().describe('research project slug or id, from list_projects');

function registerWriteTools(server: McpServer): void {
  const limits = uploadLimits();
  server.tool(
    'upload_markdown',
    'WRITES to Quire: creates a new Markdown note (section="notes", the default) or Markdown document ' +
      '(section="documents") in a research project, optionally inside an existing folder. Never edits or ' +
      'deletes. Re-sending the same title and text returns the existing item instead of a copy; note titles ' +
      `are unique per project. Max ${kb(limits.maxMarkdownBytes)}. For Markdown you write yourself; to upload ` +
      'an existing .md file use create_upload_link.',
    {
      project: PROJECT,
      markdown: z
        .string()
        .describe('the Markdown text; a leading "# Title" line is used as the title if none is given'),
      section: z.enum(['notes', 'documents']).optional().describe('notes (default) or documents'),
      title: z.string().optional().describe('1-200 characters; default: the first "# Heading"'),
      folder: z
        .string()
        .optional()
        .describe('existing folder name or id in that section; default: top level'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ project, ...rest }) => text(await uploadMarkdown({ course: project, ...rest }, S)),
  );

  server.tool(
    'upload_pdf',
    'WRITES to Quire: downloads a PDF from a public https URL (the server fetches it, max 50 MB) into a ' +
      "research project's Documents. Public https URL only (no logins, no private or local addresses; pass the " +
      'direct PDF link, e.g. https://arxiv.org/pdf/<id>); for a local file use create_upload_link. The same PDF ' +
      'already in the project is returned instead of a copy. Large PDFs may return status "processing"; ' +
      'calling again is safe. Never edits or deletes.',
    {
      project: PROJECT,
      url: z.string().max(2048).describe('public https link to the PDF'),
      title: z.string().optional().describe('1-200 characters; default: taken from the PDF'),
      folder: z.string().optional().describe('existing Documents folder name or id; default: top level'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ project, ...rest }) => text(await uploadPdfFromUrl({ course: project, ...rest }, S)),
  );

  server.tool(
    'add_paper',
    'WRITES to Quire: adds a paper to a research project from an arXiv id or URL (e.g. "2401.01234", ' +
      'arxiv.org/abs/...) or a DOI, with its title, authors, year and abstract, and the PDF when one can be ' +
      'fetched (otherwise a metadata-only record). The same arXiv paper (any version) or DOI already in the ' +
      'project is returned instead of a copy. A plain URL is not accepted: use upload_pdf. Never edits or deletes.',
    {
      project: PROJECT,
      reference: z.string().max(2048).describe('arXiv id or URL, or a DOI'),
      folder: z.string().optional().describe('existing Documents folder name or id; default: top level'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args) => text(await addPaper(args)),
  );

  server.tool(
    'create_upload_link',
    'WRITES to Quire (via the link): creates a one-time upload URL (valid 10 minutes, single use) for an ' +
      "EXISTING local file, .pdf into a research project's Documents or .md into its Notes or Documents. The " +
      'file bytes never pass through this tool: run the returned curl (PUT) on the machine that has the file, ' +
      'then check get_upload_status. The same file uploaded again returns the existing item. Never edits or deletes.',
    {
      project: PROJECT,
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
    async ({ project, ...rest }) => text(await createUploadLinkTool({ course: project, ...rest }, S)),
  );

  server.tool(
    'get_upload_status',
    'Report what an upload link produced: pending (not used yet), processing, created, duplicate, failed ' +
      'or expired, with the new file or note id once done.',
    { uploadId: z.string().describe('the uploadId returned by create_upload_link') },
    READ_ONLY,
    async ({ uploadId }) => text(uploadStatusTool({ uploadId }, S)),
  );
}

export function registerQuireResearchMcp(server: McpServer): void {
  server.tool(
    'list_projects',
    'List all Quire research projects. Each has a stable slug (use it as the project id elsewhere), name, description and counts of documents, notes and sources.',
    {},
    READ_ONLY,
    async () => text({ projects: await listResearchProjects() }),
  );

  server.tool(
    'list_project_files',
    "List a research project's documents (papers carry authors, year, arXiv id, DOI, source URL and an abstract snippet), notes and web sources, each with a stable id.",
    { project: PROJECT },
    READ_ONLY,
    async ({ project }) => text(await listProjectFiles(project)),
  );

  server.tool(
    'get_file',
    // Same constant buildTextResult enforces (MCP_TEXT_BUDGET_CHARS), so the claim cannot drift.
    'Read a research document. By default returns its text page by page ("--- Page N ---" markers, up to ' +
      `${TEXT_BUDGET.toLocaleString('en-US')} characters of page text per call; pass \`pages\` to continue) ` +
      'and flags pages that are mostly figures, contain ' +
      'embedded images or are heavy on formulas. Use get_page_images to see figures, tables, formulas or ' +
      'scans. format="pdf"/"original" returns the raw file as an embedded binary resource, which only Claude ' +
      'Code can open; use it only when the user needs the file itself.',
    {
      project: z.string().describe('research project slug or id'),
      fileId: z.string().describe('the fileId from list_project_files'),
      pages: z
        .string()
        .optional()
        .describe('pages to read, e.g. "1-10", "3,7" or "20-"; default: from page 1'),
      format: z
        .enum(['text', 'pdf', 'original', 'markdown'])
        .optional()
        .describe('text (default) = extracted page text; pdf/original = raw binary; markdown = body'),
    },
    READ_ONLY,
    async ({ project, fileId, pages, format }) =>
      !format || format === 'text'
        ? textToolResult(project, fileId, pages, S)
        : fileToolResult(project, fileId, format, S),
  );

  server.tool(
    'get_page_images',
    `Render pages of a research document's PDF as JPEG images (max ${MAX_IMAGES_PER_CALL} per call) to see figures, tables, formulas or scanned pages.`,
    {
      project: z.string().describe('research project slug or id'),
      fileId: z.string().describe('the fileId from list_project_files'),
      pages: z.string().describe('pages to render, e.g. "4", "2-5" or "1,3,8"'),
    },
    READ_ONLY,
    async ({ project, fileId, pages }) => imagesToolResult(project, fileId, pages, S),
  );

  server.tool(
    'get_note',
    "Read a research project's note as Markdown.",
    { project: PROJECT, noteId: z.string().describe('the noteId from list_project_files') },
    READ_ONLY,
    async ({ project, noteId }) => text(await getNoteMarkdown(project, noteId)),
  );

  if (S.writeEnabled()) registerWriteTools(server);

  server.resource(
    'research-file',
    new ResourceTemplate('quire://research/{slug}/file/{docId}', {
      list: async () => ({ resources: await listAllResearchFileResources() }),
    }),
    async (uri, variables) =>
      readFileResource(
        uri,
        String(variables.slug),
        String(variables.docId),
        asFormat(uri.searchParams.get('format')),
        S,
      ),
  );
}
