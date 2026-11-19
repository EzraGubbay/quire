// Thin mobile mappers + loaders for /api/mobile/v1/courses. Data assembly and labelling are reused from
// lib/mcp/courses (listCourses / listCourseFiles / resolveCourse) and lib/sessions — nothing is re-labelled here.
import type { Session } from '@/db/schema';
import { listDocuments } from '@/lib/documents';
import {
  listCourseFiles,
  listCourses,
  type CourseFile as McpCourseFile,
  type CourseSummary as McpCourseSummary,
  resolveCourse,
} from '@/lib/mcp/courses';
import { listNotes } from '@/lib/notes';
import {
  listSessions,
  listSessionsWithDocuments,
  type SessionWithDocuments,
  sessionTitle,
} from '@/lib/sessions';
import type { CourseDetail, CourseFile, CourseSession, CourseSummary } from './schema';

/** MCP file → mobile file: drops MCP-only `kind`/`resourceUri`, adds `updatedAt`. */
export function toCourseFile(f: McpCourseFile, updatedAt: Date): CourseFile {
  return {
    fileId: f.fileId,
    title: f.title,
    type: f.type,
    ...(f.session ? { session: f.session } : {}),
    ...(f.folder ? { folder: f.folder } : {}),
    pageCount: f.pageCount,
    sizeBytes: f.sizeBytes,
    hasPdf: f.hasPdf,
    hasOriginal: f.hasOriginal,
    hasMarkdown: f.hasMarkdown,
    updatedAt: updatedAt.toISOString(),
  };
}

export function toCourseSession(s: SessionWithDocuments, noteId: string | undefined): CourseSession {
  return {
    kind: s.kind,
    number: s.number,
    title: sessionTitle(s),
    date: s.date ?? null,
    fileIds: s.documents.map((d) => d.id),
    noteId: noteId ?? null,
  };
}

const tally = (keys: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
};

export function toCourseDetail(
  summary: McpCourseSummary,
  sessions: Pick<Session, 'kind'>[],
  files: Pick<McpCourseFile, 'type'>[],
  noteCount: number,
): CourseDetail {
  return {
    ...summary,
    counts: {
      sessions: tally(sessions.map((s) => s.kind)),
      files: tally(files.map((f) => f.type)),
      notes: noteCount,
    },
  };
}

/** Resolve a slug/UUID to a `kind = course` project, or null (→ 404). */
async function courseProject(course: string) {
  const p = await resolveCourse(course);
  return p && p.kind === 'course' ? p : null;
}

export const loadCourses = (): Promise<CourseSummary[]> => listCourses();

export async function loadCourseDetail(course: string): Promise<CourseDetail | null> {
  const p = await courseProject(course);
  if (!p) return null;
  const [all, sessions, { files }, notes] = await Promise.all([
    listCourses(),
    listSessions(p.id),
    listCourseFiles(p.id),
    listNotes(p.id),
  ]);
  const summary = all.find((c) => c.id === p.id);
  return summary ? toCourseDetail(summary, sessions, files, notes.length) : null;
}

export async function loadCourseFiles(course: string): Promise<CourseFile[] | null> {
  const p = await courseProject(course);
  if (!p) return null;
  const [{ files }, docs] = await Promise.all([listCourseFiles(p.id), listDocuments(p.id)]);
  const updated = new Map(docs.map((d) => [d.id, d.updatedAt]));
  return files.map((f) => toCourseFile(f, updated.get(f.fileId) ?? new Date(0)));
}

export async function loadCourseSessions(course: string): Promise<CourseSession[] | null> {
  const p = await courseProject(course);
  if (!p) return null;
  const [lectures, recitations, notes] = await Promise.all([
    listSessionsWithDocuments(p.id, 'lecture'),
    listSessionsWithDocuments(p.id, 'recitation'),
    listNotes(p.id),
  ]);
  // Earliest-created note per session, matching sessions.sessionNote().
  const noteBySession = new Map<string, string>();
  for (const n of [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (n.sessionId && !noteBySession.has(n.sessionId)) noteBySession.set(n.sessionId, n.id);
  }
  return [...lectures, ...recitations].map((s) => toCourseSession(s, noteBySession.get(s.id)));
}
