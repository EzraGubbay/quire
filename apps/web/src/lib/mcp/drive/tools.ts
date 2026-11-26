// Registers import_from_drive and drive_inbox_status. Called from server.ts only when the Drive config is
// enabled and writes are on. Neither tool takes bytes: the file reaches Quire through Drive.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EnabledDriveConfig } from './config';
import { driveInboxStatus, importFromDrive } from './import';

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

export function registerDriveTools(server: McpServer, config: EnabledDriveConfig): void {
  const id = config.inboxFolderId;
  server.tool(
    'import_from_drive',
    `WRITES to Quire: imports one file from the user's Google Drive folder "Quire Inbox" (folder id ${id}) into a course's Documents or Notes. ` +
      'Use it for PDFs and files you saved to Drive. For Markdown you write yourself, use upload_markdown instead, which needs no Drive round-trip.\n' +
      `1. Save the file with the Google Drive connector's create_file, parentId ${id}. For .md, set contentMimeType text/markdown and disableConversionToGoogleType true. If the file is already in Drive, copy_file it with parentId ${id}.\n` +
      '2. Call this tool with the returned file id.\n' +
      "3. When it succeeds, trash exactly that file id with the Drive connector's trash_file.\n\n" +
      `PDFs up to ${Math.round(config.maxPdfBytes / 1048576)} MB, Markdown up to ${Math.round(config.maxMdBytes / 1048576)} MB; Google Docs are imported as Markdown.`,
    {
      fileId: z
        .string()
        .describe(
          'the Drive file id (or a drive.google.com / docs.google.com link) of a file in the Quire Inbox',
        ),
      course: z.string().describe('course slug or id, from list_courses'),
      section: z
        .enum(['documents', 'notes'])
        .describe('documents (PDF or Markdown) or notes (Markdown only)'),
      folder: z
        .string()
        .optional()
        .describe('existing folder name or id in that section; default: top level'),
      title: z.string().optional().describe('1-200 characters; default: from the file'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args) => json(await importFromDrive(args)),
  );
  server.tool(
    'drive_inbox_status',
    'Lists the files currently in the user\'s Google Drive "Quire Inbox" folder (not trashed), with size, age and, where Quire knows it, which course item each was imported as. ' +
      'Read-only: it never changes Drive or Quire.',
    {},
    { readOnlyHint: true, openWorldHint: true },
    async () => json(await driveInboxStatus()),
  );
}
