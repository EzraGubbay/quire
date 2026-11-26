// import_from_drive and drive_inbox_status. Quire only ever READS Drive (read-only service account, Viewer on
// the Inbox); the result tells Claude to trash exactly the imported file id with the Drive connector. Ingestion
// is T2's ingestPdf / ingestMarkdown, unchanged, so dedupe and in-flight joins come with them. No sourceUrl is
// set on imports: lib/mcp/courses.ts would classify such a document as a paper.
import type { Project } from '@/db/schema';
import { sha256 } from '@/lib/files';
import {
  hasPdfMagic,
  ingestMarkdown,
  ingestPdf,
  markdownFromFile,
  raceDeadline,
  resolveFolder,
  resolveUploadCourse,
  type UploadResult,
  uploadLimits,
} from '../upload';
import { findDuplicatePdf } from '../upload-store';
import { classifyDriveFile, type DriveClient, type DriveMeta, driveClient, parseDriveFileId } from './client';
import { driveConfig, type EnabledDriveConfig } from './config';
import { DriveError } from './google-auth';
import { findDocsByHashes } from './store';

type Section = 'documents' | 'notes';

export interface DriveDeps {
  config?: EnabledDriveConfig;
  client?: DriveClient;
  now?: () => number;
  deadlineMs?: number;
}

export type DriveImportResult = Omit<UploadResult, 'status'> & {
  status: UploadResult['status'];
  drive?: { fileId: string; name: string; mimeType: string; sizeBytes: number | null };
  trash?: { tool: 'trash_file'; fileId: string };
  inboxLeftovers?: number;
};

const MB = 1024 * 1024;
const fmtMb = (n: number) => `${(n / MB).toFixed(1)} MB`;
const capMb = (n: number) => `${Math.round(n / MB)} MB`;

function resolveDeps(deps: DriveDeps): {
  config: EnabledDriveConfig;
  client: DriveClient;
  now: () => number;
} {
  const config =
    deps.config ??
    (() => {
      const c = driveConfig();
      if (!c.enabled) throw new Error('The Drive inbox is not configured on this Quire server.');
      return c;
    })();
  return { config, client: deps.client ?? driveClient(config), now: deps.now ?? Date.now };
}

// ---- in-process record of what was imported (Markdown/Google Docs have no hash to match on) ----
type Imported = { courseSlug: string; section: Section; id: string; title: string; at: number };
const IMPORT_TTL_MS = 24 * 3600_000;
const IMPORT_MAX = 500;
const g = globalThis as unknown as {
  __quireDriveImports?: Map<string, Imported>;
  __quireDriveInFlight?: Map<string, Promise<DriveImportResult>>;
};
function recordImport(fileId: string, v: Omit<Imported, 'at'>, now: number) {
  g.__quireDriveImports ??= new Map();
  const m = g.__quireDriveImports;
  m.delete(fileId);
  m.set(fileId, { ...v, at: now });
  for (const [k, e] of m) if (now - e.at > IMPORT_TTL_MS) m.delete(k);
  while (m.size > IMPORT_MAX) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}
const recalled = (fileId: string, now: number): Imported | undefined => {
  const e = g.__quireDriveImports?.get(fileId);
  return e && now - e.at <= IMPORT_TTL_MS ? e : undefined;
};

function once(key: string, work: () => Promise<DriveImportResult>): Promise<DriveImportResult> {
  g.__quireDriveInFlight ??= new Map();
  const inFlight = g.__quireDriveInFlight;
  const running = inFlight.get(key);
  if (running) return running;
  const p = work().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Drive failures become the fixed user-facing text; anything else (T2 ingestion errors) passes through. */
const asUserError = (e: unknown): Error => (e instanceof DriveError ? new Error(e.message) : (e as Error));

const notVisible = (inbox: string) =>
  `Quire can't see that Drive file. Save it directly in the "Quire Inbox" folder (folder id ${inbox}) with the Drive connector (create_file parentId ${inbox}, or copy_file/update_file to move an existing file there), then retry with the new file id.`;

const trashNext = (fileId: string, leftovers: number | undefined) =>
  `Now trash the Drive copy with the Google Drive connector: trash_file {fileId:"${fileId}"}. Trash exactly this id and nothing else.` +
  (leftovers
    ? ` ${leftovers} other file(s) are still in the Quire Inbox; call drive_inbox_status to review them.`
    : '');

export async function importFromDrive(
  args: { fileId: string; course: string; section: Section; folder?: string; title?: string },
  deps: DriveDeps = {},
): Promise<DriveImportResult> {
  const fileId = parseDriveFileId(args.fileId);
  // Course and folder problems are reported before any Drive call.
  const project = await resolveUploadCourse(args.course);
  const folder = await resolveFolder(project, args.section, args.folder);
  const { config, client, now } = resolveDeps(deps);
  const deadlineMs = deps.deadlineMs ?? uploadLimits().deadlineMs;
  const section = args.section;

  const work = once(`drive:${project.id}:${fileId}:${section}`, async () => {
    try {
      return await runImport();
    } catch (e) {
      throw asUserError(e);
    }
  });

  async function runImport(): Promise<DriveImportResult> {
    let meta: DriveMeta;
    try {
      meta = await client.getMeta(fileId);
    } catch (e) {
      if (e instanceof DriveError && e.code === 'NOT_VISIBLE')
        throw new Error(notVisible(config.inboxFolderId));
      throw e;
    }
    if (!meta.parents?.includes(config.inboxFolderId)) {
      throw new Error(
        `That file is not in the Quire Inbox folder (Quire only imports files saved directly in it, not in subfolders). Copy or move it there (parentId ${config.inboxFolderId}) and retry.`,
      );
    }
    const kind = classifyDriveFile(meta);
    if (meta.trashed) {
      const dup =
        meta.sha256Checksum && kind === 'pdf'
          ? await findDuplicatePdf(project.id, meta.sha256Checksum, meta.size ?? 0)
          : undefined;
      if (!dup) {
        throw new Error(
          'That file is in the Drive trash, so it was probably imported already. Check with drive_inbox_status or list_course_files; if it is not in Quire, restore it from the trash and retry.',
        );
      }
      return decorate(project, meta, duplicateOf(project, dup), now());
    }
    if (kind === 'unsupported') {
      throw new Error(
        `Quire imports PDFs, Markdown (.md) files and Google Docs (as Markdown). This file is ${meta.mimeType}. Save a PDF or .md instead.`,
      );
    }
    if (kind === 'pdf' && section === 'notes') {
      throw new Error('Notes hold Markdown only; use section "documents" for PDFs.');
    }
    const cap = kind === 'pdf' ? config.maxPdfBytes : config.maxMdBytes;
    if (kind !== 'gdoc' && meta.size !== undefined && meta.size > cap) {
      throw new Error(
        `The file is ${fmtMb(meta.size)}; Quire imports ${kind === 'pdf' ? 'PDFs' : 'Markdown files'} up to ${capMb(cap)}.`,
      );
    }
    if (kind === 'pdf') {
      if (meta.sha256Checksum) {
        const dup = await findDuplicatePdf(project.id, meta.sha256Checksum, meta.size ?? 0);
        if (dup) return decorate(project, meta, duplicateOf(project, dup), now());
      }
      const data = await downloadOrExplain(() => client.download(fileId, cap), cap);
      if (!hasPdfMagic(data)) throw new Error('That Drive file is labelled PDF but its bytes are not a PDF.');
      if (meta.sha256Checksum && sha256(data) !== meta.sha256Checksum) {
        throw new Error("The downloaded bytes did not match Drive's checksum; nothing was imported. Retry.");
      }
      const r = await ingestPdf(project, { data, fileName: meta.name, title: args.title, folder });
      return decorate(project, meta, r, now());
    }
    const bytes = await downloadOrExplain(
      () => (kind === 'gdoc' ? client.exportMarkdown(fileId, cap) : client.download(fileId, cap)),
      cap,
    );
    let md: string;
    try {
      md = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('That Drive file is not valid UTF-8 text, so it cannot be imported as Markdown.');
    }
    if (!md.trim()) throw new Error('That Drive file is empty.');
    const { title, body } = markdownFromFile(md, args.title, meta.name);
    if (!body.trim()) throw new Error('The Markdown has no text besides its title heading.');
    const r = await ingestMarkdown(project, { section, title, body, folder });
    return decorate(project, meta, r, now());
  }

  async function downloadOrExplain(run: () => Promise<Uint8Array>, cap: number): Promise<Uint8Array> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof DriveError && e.code === 'TOO_LARGE') {
        throw new Error(`The file is larger than the ${capMb(cap)} Quire imports.`);
      }
      if (e instanceof DriveError && e.code === 'NOT_VISIBLE')
        throw new Error(notVisible(config.inboxFolderId));
      throw e;
    }
  }

  async function decorate(
    p: Project,
    meta: DriveMeta,
    r: UploadResult,
    at: number,
  ): Promise<DriveImportResult> {
    const id = r.fileId ?? r.noteId;
    if (id && (r.status === 'created' || r.status === 'duplicate')) {
      recordImport(meta.id, { courseSlug: p.slug, section: r.section, id, title: r.title }, at);
    }
    let leftovers: number | undefined;
    try {
      leftovers = (await client.listInbox()).filter((f) => f.id !== meta.id).length;
    } catch {
      leftovers = undefined; // best effort
    }
    return {
      ...r,
      drive: { fileId: meta.id, name: meta.name, mimeType: meta.mimeType, sizeBytes: meta.size ?? null },
      trash: { tool: 'trash_file', fileId: meta.id },
      ...(leftovers === undefined ? {} : { inboxLeftovers: leftovers }),
      next: `Imported. ${r.next} ${trashNext(meta.id, leftovers)}`,
    };
  }

  const first = await raceDeadline(work, deadlineMs);
  if (first) return first as DriveImportResult;
  return {
    status: 'processing',
    section,
    course: { slug: project.slug, name: project.name },
    title: args.title?.trim() || fileId,
    folder: folder.name,
    next: 'Still importing from Drive. Wait a moment, then call import_from_drive again with the same input (retrying is safe and will not duplicate it). Do NOT trash the Drive file yet: trash only after a created or duplicate result.',
  };
}

function duplicateOf(
  project: Project,
  doc: { id: string; title: string; pageCount: number | null; fileSize: number | null },
): UploadResult {
  return {
    status: 'duplicate',
    section: 'documents',
    course: { slug: project.slug, name: project.name },
    fileId: doc.id,
    title: doc.title,
    folder: null,
    pageCount: doc.pageCount,
    sizeBytes: doc.fileSize ?? undefined,
    next: `This PDF is already in the course; nothing was written. Read it back with get_file {course:"${project.slug}", fileId:"${doc.id}"}.`,
  };
}

export async function driveInboxStatus(deps: DriveDeps = {}) {
  const { config, client, now } = resolveDeps(deps);
  const files = await client.listInbox().catch((e) => {
    throw asUserError(e);
  });
  const t = now();
  const hits = await findDocsByHashes(files.flatMap((f) => (f.sha256Checksum ? [f.sha256Checksum] : [])));
  const byHash = new Map(hits.map((h) => [h.hash, h]));
  const rows = files.map((f) => {
    const hit = f.sha256Checksum ? byHash.get(f.sha256Checksum) : undefined;
    const mem = recalled(f.id, t);
    const importedAs = hit
      ? { course: hit.projectSlug, section: 'documents' as const, fileId: hit.docId, title: hit.title }
      : mem
        ? {
            course: mem.courseSlug,
            section: mem.section,
            ...(mem.section === 'notes' ? { noteId: mem.id } : { fileId: mem.id }),
            title: mem.title,
          }
        : undefined;
    return {
      fileId: f.id,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: f.size ?? null,
      createdTime: f.createdTime ?? null,
      ageHours: f.createdTime ? Math.round(((t - Date.parse(f.createdTime)) / 3600_000) * 10) / 10 : null,
      ...(importedAs ? { importedAs } : {}),
    };
  });
  const imported = rows.filter((r) => r.importedAs);
  const pending = rows.length - imported.length;
  const parts: string[] = [];
  if (imported.length)
    parts.push(
      'Files with importedAs are already in Quire; trash each with trash_file {fileId} (one call per file, exactly that id).',
    );
  if (pending)
    parts.push(
      'Files without importedAs are not imported yet. Ask the user which course and section, then call import_from_drive.',
    );
  if (!rows.length) parts.push('The Quire Inbox is empty.');
  return {
    inbox: { folderId: config.inboxFolderId },
    count: rows.length,
    files: rows,
    next: parts.join(' '),
  };
}
