// The Quire MCP write tool upload_markdown (text the model writes itself; no tool takes file bytes). Additive only (never edits or deletes) and idempotent: re-sending the same content
// returns the existing item. Built on the existing ingestion functions, unchanged. Errors are thrown with
// actionable text; the SDK turns them into isError results.
import type { FolderScope } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import type { Project } from '@/db/schema';
import { indexOwner } from '@/lib/ai/index';
import { createMarkdownDocument, listFolders } from '@/lib/documents';
import { sha256 } from '@/lib/files';
import { createNote } from '@/lib/notes';
import { projectBase } from '@/lib/projects';
import { resolveCourse } from './courses';
import { findMarkdownDoc, findNoteByTitle } from './upload-store';

const PUBLIC_BASE = () =>
  (process.env.QUIRE_PUBLIC_URL ?? 'https://quire.ezragubbay.com').replace(/\/+$/, '');
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

/** Caps, read at call time so a restart (or a test) picks up env changes. */
export const uploadLimits = () => ({
  maxMarkdownBytes: num(process.env.MCP_UPLOAD_MAX_MARKDOWN_BYTES, 512 * 1024),
});

/** Write tools are on unless MCP_WRITE_ENABLED is 0/false/off/no. Read on every registration. */
export const mcpWriteEnabled = (): boolean =>
  !['0', 'false', 'off', 'no'].includes((process.env.MCP_WRITE_ENABLED ?? '').trim().toLowerCase());

export const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 200;

export type UploadResult = {
  status: 'created' | 'duplicate';
  section: 'notes' | 'documents';
  course: { slug: string; name: string };
  fileId?: string;
  noteId?: string;
  title: string;
  folder: string | null;
  openUrl?: string;
  next: string;
};

export async function resolveUploadCourse(course: string): Promise<Project> {
  const project = await resolveCourse(course);
  if (!project || project.kind !== 'course') {
    throw new Error(`No course found for "${course}". Call list_courses for the valid slugs.`);
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
    throw new Error(
      `Several ${scope} folders in "${project.name}" are named "${wanted}": pass one of these ids instead: ` +
        matches.map((f) => f.id).join(', '),
    );
  }
  const names = folders.map((f) => `"${f.name}"`).join(', ');
  throw new Error(
    `No ${scope} folder "${wanted}" in "${project.name}". ` +
      (names ? `Existing folders: ${names}. ` : 'It has no folders. ') +
      'Omit folder to put it at the top level.',
  );
}

function checkTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new Error('title is empty.');
  if (t.length > MAX_TITLE) throw new Error(`title is longer than ${MAX_TITLE} characters.`);
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
    throw new Error('No title: pass `title`, or start the markdown with a "# Heading" line.');
  }
  return { title: checkTitle(h1), body: text.slice(m[0].length).replace(/^\n+/, '') };
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
        throw new Error(
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
  if (!args.markdown.trim()) throw new Error('markdown is empty.');
  if (Buffer.byteLength(args.markdown, 'utf8') > limits.maxMarkdownBytes) {
    throw new Error(
      `markdown is over the ${kb(limits.maxMarkdownBytes)} limit; split it into several uploads.`,
    );
  }
  const { title, body } = splitTitle(args.markdown, args.title);
  if (!body.trim()) throw new Error('markdown has no text besides its title heading.');
  const project = await resolveUploadCourse(args.course);
  const folder = await resolveFolder(project, section, args.folder);
  return ingestMarkdown(project, { section, title, body, folder });
}
