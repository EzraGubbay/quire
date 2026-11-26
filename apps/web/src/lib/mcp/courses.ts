// Read-only data assembly for the Quire MCP server: list courses, list a course's files labeled by type
// (lecture / recitation / homework / exam / book / paper / other), and resolve a file's bytes. The labeling
// is a pure function (labelDocument) so it unit-tests without a DB. Everything here reuses the existing
// project / document / session / homework libs — no new queries except lemidaFilesByProject.
import { stat } from 'node:fs/promises';
import type { LemidaKind } from '@quire/shared';
import type { Document, Session } from '@/db/schema';
import { countDocuments, getDocument, listDocuments, listFolders, listPracticeExams } from '@/lib/documents';
import { filePath, readStoredFile } from '@/lib/files';
import { listAssignments } from '@/lib/homework';
import { lemidaFilesByProject } from '@/lib/lemida/files';
import { getProjectById, getProjectBySlug, listProjects, projectMeta } from '@/lib/projects';
import { listSessions, sessionTitle } from '@/lib/sessions';

export type FileType = 'lecture' | 'recitation' | 'homework' | 'exam' | 'book' | 'paper' | 'other';
export type FileFormat = 'pdf' | 'original' | 'markdown';

export interface CourseSummary {
  slug: string;
  id: string;
  name: string;
  code: string;
  semester: string;
  type: string;
  fileCount: number;
}

export interface CourseFile {
  /** documents.id — stable, feeds get_file and the resource URI. */
  fileId: string;
  title: string;
  type: FileType;
  /** When the file is a deck attached to a lecture/recitation. */
  session?: { number: number; title: string };
  /** Folder name otherwise. */
  folder?: string;
  pageCount: number | null;
  sizeBytes: number | null;
  kind: 'pdf' | 'markdown';
  hasPdf: boolean;
  hasOriginal: boolean;
  hasMarkdown: boolean;
  resourceUri: string;
}

export interface LabelContext {
  sessionsById: Map<string, Session>;
  practiceExamFolderId: string | null;
  homeworkDocIds: Set<string>;
  folderNameById: Map<string, string>;
  lemidaByDocId: Map<string, LemidaKind>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Label one document by its placement. First match wins. Pure — unit-tested against hand-built fixtures.
 * Current structural placement (a session, the practice-exam folder, a homework link) wins over the stored
 * Lemida label; a confident Lemida label only fills in when placement is ambiguous.
 */
export function labelDocument(
  doc: Document,
  ctx: LabelContext,
): { type: FileType; session?: { number: number; title: string }; folder?: string } {
  const folderName = doc.folderId ? ctx.folderNameById.get(doc.folderId) : undefined;
  // 1. Deck on a lecture/recitation session.
  if (doc.sessionId) {
    const s = ctx.sessionsById.get(doc.sessionId);
    if (s) return { type: s.kind, session: { number: s.number, title: sessionTitle(s) } };
  }
  // 2. Practice-exam folder.
  if (doc.folderId && doc.folderId === ctx.practiceExamFolderId) return { type: 'exam', folder: folderName };
  // 3. Homework: an assignment's sheet/returned doc, or the "Homework" folder.
  if (ctx.homeworkDocIds.has(doc.id) || folderName === 'Homework') {
    return { type: 'homework', folder: folderName };
  }
  // 4. Course material → book.
  if (folderName === 'Course material') return { type: 'book', folder: folderName };
  // 5. A confident Lemida label (the human/learned decision) fills the gap when placement is ambiguous.
  const lemida = ctx.lemidaByDocId.get(doc.id);
  if (lemida && lemida !== 'unknown' && lemida !== 'other') {
    return { type: lemida as FileType, folder: folderName };
  }
  // 6. Research paper vs. plain other.
  if (doc.arxivId || doc.doi || doc.sourceUrl) return { type: 'paper', folder: folderName };
  return { type: 'other', folder: folderName };
}

/**
 * Resolve a course by slug or UUID. Only `kind='course'` projects resolve: a research project answers exactly
 * like a missing slug, so the course server neither serves nor confirms the existence of research projects.
 */
export async function resolveCourse(course: string) {
  const project = UUID_RE.test(course) ? await getProjectById(course) : await getProjectBySlug(course);
  return project?.kind === 'course' ? project : undefined;
}

/** All courses with cheap per-course file counts. */
export async function listCourses(): Promise<CourseSummary[]> {
  const courses = await listProjects({ kind: 'course' });
  return Promise.all(
    courses.map(async (p) => {
      const meta = projectMeta(p);
      return {
        slug: p.slug,
        id: p.id,
        name: p.name,
        code: meta.code,
        semester: meta.semester,
        type: meta.type,
        fileCount: await countDocuments(p.id),
      };
    }),
  );
}

async function buildLabelContext(projectId: string): Promise<LabelContext> {
  const [sessions, folders, practice, assignments, lemida] = await Promise.all([
    listSessions(projectId),
    listFolders(projectId, 'documents'),
    listPracticeExams(projectId),
    listAssignments(projectId),
    lemidaFilesByProject(projectId),
  ]);
  return {
    sessionsById: new Map(sessions.map((s) => [s.id, s])),
    practiceExamFolderId: practice.folderId,
    folderNameById: new Map(folders.map((f) => [f.id, f.name])),
    homeworkDocIds: new Set(
      assignments
        .flatMap((a) => [a.sheetDocumentId, a.returnedDocumentId])
        .filter((id): id is string => Boolean(id)),
    ),
    lemidaByDocId: new Map(
      lemida
        .map((f) => [f.placement?.documentId, f.correctedKind ?? f.detectedKind] as const)
        .filter((e): e is readonly [string, LemidaKind] => Boolean(e[0])),
    ),
  };
}

export async function listCourseFiles(
  course: string,
): Promise<{ course: { slug: string; name: string }; files: CourseFile[] }> {
  const project = await resolveCourse(course);
  if (!project) throw new Error(`No course found for "${course}"`);
  const [docs, ctx] = await Promise.all([listDocuments(project.id), buildLabelContext(project.id)]);
  const files = docs.map((d): CourseFile => {
    const label = labelDocument(d, ctx);
    return {
      fileId: d.id,
      title: d.title,
      type: label.type,
      session: label.session,
      folder: label.folder,
      pageCount: d.pageCount,
      sizeBytes: d.fileSize,
      kind: d.kind,
      hasPdf: Boolean(d.filePath),
      hasOriginal: Boolean(d.originalPath),
      hasMarkdown: d.kind === 'markdown',
      resourceUri: `quire://course/${project.slug}/file/${d.id}`,
    };
  });
  return { course: { slug: project.slug, name: project.name }, files };
}

/** Flattened file list across all courses, for MCP resources/list. */
export async function listAllFileResources(): Promise<
  { uri: string; name: string; mimeType: string; description: string }[]
> {
  const courses = await listProjects({ kind: 'course' });
  const perCourse = await Promise.all(courses.map((c) => listCourseFiles(c.slug)));
  return perCourse.flatMap(({ course, files }) =>
    files.map((f) => ({
      uri: f.resourceUri,
      name: `${course.name} — ${f.title}`,
      mimeType: f.hasPdf ? 'application/pdf' : f.hasMarkdown ? 'text/markdown' : 'application/octet-stream',
      description: f.type,
    })),
  );
}

const OFFICE_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  key: 'application/vnd.apple.keynote',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

const extOf = (p: string): string => /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() ?? '';
const safeTitle = (title: string): string =>
  title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
    .slice(0, 80) || 'document';

/** Size of a stored file, or a clean error that never leaks the absolute server path to the client. */
async function sizeOnDisk(rel: string): Promise<number> {
  const info = await stat(filePath(rel)).catch(() => null);
  if (!info) throw new Error('File is missing on disk.');
  return info.size;
}

export interface ResolvedFile {
  kind: 'binary' | 'markdown';
  /** The representation actually resolved — drives which download route the fallback URL points at. */
  format: FileFormat;
  mimeType: string;
  filename: string;
  slug: string;
  docId: string;
  sizeBytes: number;
  /** Markdown body (kind === 'markdown'). */
  text?: string;
  /** Relative path under FILES_DIR to stream the bytes (kind === 'binary'). */
  rel?: string;
}

/** Resolve the chosen representation's metadata (and size) without reading large files into memory. */
export async function resolveFile(
  course: string,
  fileId: string,
  format?: FileFormat,
): Promise<ResolvedFile> {
  const project = await resolveCourse(course);
  if (!project) throw new Error(`No course found for "${course}"`);
  const doc = await getDocument(project.id, fileId);
  if (!doc) throw new Error(`No file "${fileId}" in course "${project.slug}"`);
  const chosen: FileFormat =
    format ?? (doc.filePath ? 'pdf' : doc.kind === 'markdown' ? 'markdown' : 'original');
  const base = { slug: project.slug, docId: doc.id, format: chosen };

  if (chosen === 'markdown') {
    if (doc.kind !== 'markdown') throw new Error('This file has no markdown body.');
    const text = `# ${doc.title}\n\n${doc.markdownBody ?? ''}`;
    return {
      ...base,
      kind: 'markdown',
      mimeType: 'text/markdown',
      filename: `${safeTitle(doc.title)}.md`,
      sizeBytes: Buffer.byteLength(text),
      text,
    };
  }
  if (chosen === 'original') {
    if (!doc.originalPath) throw new Error('This file has no original (pptx/key/odp) upload.');
    const ext = extOf(doc.originalName ?? doc.originalPath);
    return {
      ...base,
      kind: 'binary',
      mimeType: OFFICE_MIME[ext] ?? 'application/octet-stream',
      filename: doc.originalName ?? `${safeTitle(doc.title)}.${ext || 'bin'}`,
      sizeBytes: await sizeOnDisk(doc.originalPath),
      rel: doc.originalPath,
    };
  }
  if (!doc.filePath) throw new Error('This file has no PDF.');
  return {
    ...base,
    kind: 'binary',
    mimeType: 'application/pdf',
    filename: `${safeTitle(doc.title)}.pdf`,
    sizeBytes: await sizeOnDisk(doc.filePath),
    rel: doc.filePath,
  };
}

export const readFileBytes = (rel: string): Promise<Buffer> =>
  readStoredFile(rel).catch(() => {
    throw new Error('File is missing on disk.');
  });
