// The Quire MCP write tools: upload_markdown (text the model writes), create_upload_link / get_upload_status
// (an existing local file is PUT by curl, never passed through a tool call) and the shared ingestion they and
// the PUT route use. Additive only (never edits or deletes) and idempotent: re-sending the same content
// returns the existing item. Built on the existing ingestion functions, unchanged. Errors are thrown with
// actionable text; the SDK turns them into isError results.
import type { FolderScope } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import type { Project } from '@/db/schema';
import { indexOwner } from '@/lib/ai/index';
import { createMarkdownDocument, createPdfDocument, listFolders } from '@/lib/documents';
import { sha256 } from '@/lib/files';
import { createNote } from '@/lib/notes';
import { projectBase } from '@/lib/projects';
import { resolveCourse } from './courses';
import { createLink, getStatus, type LinkBinding, linkConfig, type UploadStatus } from './upload-links';
import { findDuplicatePdf, findMarkdownDoc, findNoteByTitle, setContentHash } from './upload-store';

const PUBLIC_BASE = () =>
  (process.env.QUIRE_PUBLIC_URL ?? 'https://quire.ezragubbay.com').replace(/\/+$/, '');
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

/** Caps, read at call time so a restart (or a test) picks up env changes. */
export const uploadLimits = () => ({
  maxMarkdownBytes: num(process.env.MCP_UPLOAD_MAX_MARKDOWN_BYTES, 512 * 1024),
  /** How long a tool call waits before answering "processing" (the client's request timeout is 60 s). */
  deadlineMs: num(process.env.MCP_UPLOAD_DEADLINE_MS, 40_000),
});

/** Write tools are on unless MCP_WRITE_ENABLED is 0/false/off/no. Read per registration and per PUT. */
export const mcpWriteEnabled = (): boolean =>
  !['0', 'false', 'off', 'no'].includes((process.env.MCP_WRITE_ENABLED ?? '').trim().toLowerCase());

export const kb = (n: number) => `${Math.round(n / 1024)} KB`;
export const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 200;

/** A failure whose message is written for the user/model. Anything else is an internal error: log it, show a generic text. */
export class UploadError extends Error {}

export type UploadResult = {
  status: 'created' | 'duplicate' | 'processing';
  section: 'notes' | 'documents';
  course: { slug: string; name: string };
  fileId?: string;
  noteId?: string;
  title: string;
  folder: string | null;
  pageCount?: number | null;
  sizeBytes?: number;
  openUrl?: string;
  next: string;
};

export async function resolveUploadCourse(course: string): Promise<Project> {
  const project = await resolveCourse(course);
  if (!project || project.kind !== 'course') {
    throw new UploadError(`No course found for "${course}". Call list_courses for the valid slugs.`);
  }
  return project;
}

export interface ResolvedFolder {
  id: string | null;
  name: string | null;
}

export async function resolveFolder(
  project: Project,
  scope: FolderScope,
  folder: string | undefined,
): Promise<ResolvedFolder> {
  const wanted = folder?.trim();
  if (!wanted) return { id: null, name: null };
  const folders = await listFolders(project.id, scope);
  const byId = UUID_RE.test(wanted)
    ? folders.find((f) => f.id.toLowerCase() === wanted.toLowerCase())
    : undefined;
  if (byId) return { id: byId.id, name: byId.name };
  const matches = folders.filter((f) => f.name.trim().toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1 && matches[0]) return { id: matches[0].id, name: matches[0].name };
  if (matches.length > 1) {
    throw new UploadError(
      `Several ${scope} folders in "${project.name}" are named "${wanted}": pass one of these ids instead: ` +
        matches.map((f) => f.id).join(', '),
    );
  }
  const names = folders.map((f) => `"${f.name}"`).join(', ');
  throw new UploadError(
    `No ${scope} folder "${wanted}" in "${project.name}". ` +
      (names ? `Existing folders: ${names}. ` : 'It has no folders. ') +
      'Omit folder to put it at the top level.',
  );
}

function checkTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new UploadError('title is empty.');
  if (t.length > MAX_TITLE) throw new UploadError(`title is longer than ${MAX_TITLE} characters.`);
  return t;
}

const normalizeMd = (s: string) => s.replace(/\r\n?/g, '\n').trimEnd();
// Closing #s only count after whitespace ("# C#" is the title C#); 4+ spaces of indent is a code block.
const H1_RE = /^(?:[ \t]*\n)*[ \t]{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*(?:\n|$)/;

/** Title and body: an explicit title wins; otherwise the leading `# H1`. A matching leading H1 is stripped
 *  from the body, because get_file prepends `# title` itself. */
export function splitTitle(markdown: string, title?: string): { title: string; body: string } {
  const text = normalizeMd(markdown);
  const m = H1_RE.exec(text);
  const h1 = m?.[1]?.trim();
  if (title?.trim()) {
    const t = checkTitle(title);
    const strip = m && h1?.toLowerCase() === t.toLowerCase();
    return { title: t, body: strip ? text.slice(m[0].length).replace(/^\n+/, '') : text };
  }
  if (!m || !h1) {
    throw new UploadError('No title: pass `title`, or start the markdown with a "# Heading" line.');
  }
  return { title: checkTitle(h1), body: text.slice(m[0].length).replace(/^\n+/, '') };
}

/** Title for an uploaded .md file: the bound title, else its leading H1, else the filename without extension. */
export function markdownFromFile(
  text: string,
  boundTitle: string | undefined,
  filename: string,
): { title: string; body: string } {
  if (boundTitle?.trim() || H1_RE.test(normalizeMd(text))) return splitTitle(text, boundTitle);
  const stem = filename.replace(/\.(md|markdown)$/i, '').trim() || 'Untitled';
  return { title: checkTitle(stem), body: normalizeMd(text) };
}

const g = globalThis as unknown as { __quireMcpInFlight?: Map<string, Promise<UploadResult>> };
/** Concurrent identical calls (tool or PUT) join the first one instead of racing it to a second row. */
function once(key: string, work: () => Promise<UploadResult>): Promise<UploadResult> {
  g.__quireMcpInFlight ??= new Map();
  const inFlight = g.__quireMcpInFlight;
  const running = inFlight.get(key);
  if (running) return running;
  const p = work().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Resolves with the result, or null when `ms` pass first (the work keeps running; failures are logged). */
export async function raceDeadline(work: Promise<UploadResult>, ms: number): Promise<UploadResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const first = await Promise.race([work, late]);
    if (first === null) work.catch((err) => console.error('[mcp upload] background finish failed:', err));
    return first;
  } finally {
    clearTimeout(timer);
  }
}

function afterCreate(project: Project, kind: 'document' | 'note', id: string): void {
  void indexOwner(project.id, kind, id).catch(() => {});
  try {
    revalidatePath(`${projectBase(project)}/${kind === 'note' ? 'notes' : 'documents'}`);
  } catch {
    // Outside a request scope (a background finish after the deadline): the page revalidates on next visit.
  }
}

const courseOf = (p: Project) => ({ slug: p.slug, name: p.name });
const docUrl = (p: Project, id: string) => `${PUBLIC_BASE()}${projectBase(p)}/documents/${id}`;
const noteUrl = (p: Project, slug: string) => `${PUBLIC_BASE()}${projectBase(p)}/notes/${slug}`;
const readBack = (p: Project, id: string) =>
  `Read it back with get_file {course:"${p.slug}", fileId:"${id}"}.`;

/** Where an existing item really lives (the requested folder is ignored by the duplicate lookups). */
async function placeOf(
  project: Project,
  scope: 'notes' | 'documents',
  folderId: string | null,
  requested: ResolvedFolder,
): Promise<{ folder: string | null; note: string }> {
  const name = folderId
    ? ((await listFolders(project.id, scope)).find((f) => f.id === folderId)?.name ?? null)
    : null;
  const differs = (folderId ?? null) !== (requested.id ?? null);
  return {
    folder: name,
    note: differs
      ? ` It already exists in ${name ? `folder "${name}"` : 'the top level'}; nothing was moved.`
      : '',
  };
}

/** Create a note or Markdown document, deduped. `body` and `title` are already split and normalized. */
export function ingestMarkdown(
  project: Project,
  a: { section: 'notes' | 'documents'; title: string; body: string; folder: ResolvedFolder },
): Promise<UploadResult> {
  const { section, title, body, folder } = a;
  const base = { section, course: courseOf(project), title, folder: folder.name } as const;
  // Note titles are case-insensitive-unique; document titles are not.
  const keyTitle = section === 'notes' ? title.toLowerCase() : title;
  const key = `md:${project.id}:${section}:${keyTitle}:${sha256(new TextEncoder().encode(body))}`;
  return once(key, async () => {
    if (section === 'notes') {
      const existing = await findNoteByTitle(project.id, title);
      if (existing) {
        if (normalizeMd(existing.body) === body) {
          const place = await placeOf(project, 'notes', existing.folderId, folder);
          return {
            status: 'duplicate',
            ...base,
            title: existing.title,
            folder: place.folder,
            noteId: existing.id,
            openUrl: noteUrl(project, existing.slug),
            next: `This exact note already exists; nothing was written.${place.note}`,
          };
        }
        throw new UploadError(
          `A note titled "${existing.title}" already exists in "${project.name}" (noteId ${existing.id}) with ` +
            'different text. Note titles are unique per course (wiki links resolve by title); choose another title.',
        );
      }
      const note = await createNote(project.id, title, body, { folderId: folder.id });
      afterCreate(project, 'note', note.id);
      return {
        status: 'created',
        ...base,
        noteId: note.id,
        openUrl: noteUrl(project, note.slug),
        next: 'Notes are not exposed through get_file; open the link to view it.',
      };
    }
    const existing = await findMarkdownDoc(project.id, title, body);
    if (existing) {
      const place = await placeOf(project, 'documents', existing.folderId, folder);
      return {
        status: 'duplicate',
        ...base,
        folder: place.folder,
        fileId: existing.id,
        openUrl: docUrl(project, existing.id),
        next: `This exact document already exists.${place.note} ${readBack(project, existing.id)}`,
      };
    }
    const doc = await createMarkdownDocument(project.id, title, body, folder.id);
    afterCreate(project, 'document', doc.id);
    return {
      status: 'created',
      ...base,
      fileId: doc.id,
      openUrl: docUrl(project, doc.id),
      next: readBack(project, doc.id),
    };
  });
}

export async function uploadMarkdown(args: {
  course: string;
  section?: 'notes' | 'documents';
  markdown: string;
  title?: string;
  folder?: string;
}): Promise<UploadResult> {
  const section = args.section ?? 'notes';
  const limits = uploadLimits();
  if (!args.markdown.trim()) throw new UploadError('markdown is empty.');
  if (Buffer.byteLength(args.markdown, 'utf8') > limits.maxMarkdownBytes) {
    throw new UploadError(
      `markdown is over the ${kb(limits.maxMarkdownBytes)} limit; split it, or use create_upload_link for a file.`,
    );
  }
  const { title, body } = splitTitle(args.markdown, args.title);
  if (!body.trim()) throw new UploadError('markdown has no text besides its title heading.');
  const project = await resolveUploadCourse(args.course);
  const folder = await resolveFolder(project, section, args.folder);
  return ingestMarkdown(project, { section, title, body, folder });
}

/** `%PDF-` within the first KB, as the PDF spec allows. */
export function hasPdfMagic(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 1024)).includes('%PDF-');
}

/** Validate, dedupe, create, hash and index a PDF. The shared tail of every PDF source. */
export function ingestPdf(
  project: Project,
  a: {
    data: Uint8Array;
    fileName: string;
    title?: string;
    folder: ResolvedFolder;
    sourceUrl?: string | null;
  },
): Promise<UploadResult> {
  if (!hasPdfMagic(a.data)) return Promise.reject(new UploadError('That is not a PDF (no %PDF header).'));
  const title = a.title?.trim() ? checkTitle(a.title) : undefined;
  const hash = sha256(a.data);
  const fileName = /\.pdf$/i.test(a.fileName) ? a.fileName : `${a.fileName}.pdf`;
  return once(`pdf:${project.id}:${hash}`, async () => {
    const existing = await findDuplicatePdf(project.id, hash, a.data.byteLength);
    if (existing) {
      const place = await placeOf(project, 'documents', existing.folderId, a.folder);
      return {
        status: 'duplicate',
        section: 'documents',
        course: courseOf(project),
        fileId: existing.id,
        title: existing.title,
        folder: place.folder,
        pageCount: existing.pageCount,
        sizeBytes: existing.fileSize ?? a.data.byteLength,
        openUrl: docUrl(project, existing.id),
        next: `This PDF is already in the course; nothing was written.${place.note} ${readBack(project, existing.id)}`,
      };
    }
    let doc: Awaited<ReturnType<typeof createPdfDocument>>;
    try {
      doc = await createPdfDocument(project.id, {
        fileName,
        data: a.data,
        folderId: a.folder.id,
        sourceUrl: a.sourceUrl ?? null,
        meta: title ? { title } : undefined,
      });
    } catch (err) {
      throw new UploadError(`Could not read that PDF: ${(err as Error).message}`);
    }
    await setContentHash(doc.id, hash);
    afterCreate(project, 'document', doc.id);
    return {
      status: 'created',
      section: 'documents',
      course: courseOf(project),
      fileId: doc.id,
      title: doc.title,
      folder: a.folder.name,
      pageCount: doc.pageCount,
      sizeBytes: a.data.byteLength,
      openUrl: docUrl(project, doc.id),
      next: readBack(project, doc.id),
    };
  });
}

/** The "still working" answer shared by the tools. */
export const processingResult = (
  project: Project,
  section: 'notes' | 'documents',
  title: string,
  folder: ResolvedFolder,
  sizeBytes?: number,
): UploadResult => ({
  status: 'processing',
  section,
  course: courseOf(project),
  title,
  folder: folder.name,
  sizeBytes,
  next:
    'Still extracting; it will appear in list_course_files shortly. Calling this tool again with the same ' +
    'input is safe and will not duplicate it.',
});

const MD_TYPES = ['text/markdown', 'text/plain'];
const mediaType = (ct: string) => ct.split(';')[0]?.trim().toLowerCase() ?? '';
/** Single-quote a string for a POSIX shell. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function createUploadLinkTool(args: {
  course: string;
  section: 'documents' | 'notes';
  filename: string;
  contentType?: string;
  title?: string;
  folder?: string;
}) {
  const filename = args.filename.trim();
  if (/[\\/\0]/.test(filename)) throw new UploadError('filename must be a bare file name, without / or \\.');
  if (filename.replace(/\.[^.]*$/, '').length > 200)
    throw new UploadError('filename is too long (max 200 characters before the extension).');
  const ext = /\.(pdf|md|markdown)$/i.exec(filename)?.[1]?.toLowerCase();
  if (!ext)
    throw new UploadError(
      'filename must end in .pdf, .md or .markdown (other file types are not supported).',
    );
  const kind = ext === 'pdf' ? 'pdf' : 'markdown';
  if (kind === 'pdf' && args.section === 'notes') {
    throw new UploadError('Notes hold Markdown only; use section "documents" for PDFs.');
  }
  let contentType = kind === 'pdf' ? 'application/pdf' : 'text/markdown';
  if (args.contentType?.trim()) {
    const given = mediaType(args.contentType);
    const ok = kind === 'pdf' ? given === 'application/pdf' : MD_TYPES.includes(given);
    if (!ok) {
      throw new UploadError(
        `contentType "${given}" does not match a .${ext} file; use ${kind === 'pdf' ? 'application/pdf' : 'text/markdown'}.`,
      );
    }
    contentType = given;
  }
  const title = args.title?.trim() ? checkTitle(args.title) : undefined;
  const project = await resolveUploadCourse(args.course);
  const folder = await resolveFolder(project, args.section, args.folder);
  const cfg = linkConfig();
  const binding: LinkBinding = {
    projectId: project.id,
    section: args.section,
    kind,
    filename: filename.slice(0, 255),
    title,
    folderId: folder.id,
    folderName: folder.name,
    contentType,
    maxBytes: kind === 'pdf' ? cfg.maxPdfBytes : cfg.maxMarkdownBytes,
  };
  const { token, uploadId, expiresAt } = createLink(binding);
  const uploadUrl = `${PUBLIC_BASE()}/api/upload-links/${token}`;
  return {
    uploadId,
    uploadUrl,
    method: 'PUT',
    expiresAt: expiresAt.toISOString(),
    maxBytes: binding.maxBytes,
    contentType,
    course: courseOf(project),
    section: args.section,
    folder: folder.name,
    curl: `curl --fail-with-body -sS -T ${shq(`./${filename}`)} -H ${shq(`content-type: ${contentType}`)} ${shq(uploadUrl)}`,
    instructions:
      'Run the curl on the machine that has the file (Claude Code: run it with Bash, replacing the path; ' +
      'Claude Desktop / claude.ai: ask the user to run it in a terminal). The link works once and expires at ' +
      `${expiresAt.toISOString()}. The PUT prints the result; you can also call get_upload_status {uploadId}.`,
  };
}

export function uploadStatusTool(args: { uploadId: string }): UploadStatus | string {
  const s = getStatus(args.uploadId.trim());
  if (!s) {
    return 'Unknown uploadId: the link may be older than 24 h or the server restarted; create a new link with create_upload_link.';
  }
  const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
  return { ...s, expiresAt: iso(s.expiresAt) as never, updatedAt: iso(s.updatedAt) as never };
}
