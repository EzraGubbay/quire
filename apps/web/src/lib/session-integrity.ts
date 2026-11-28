import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  findSessionAnomalies,
  type IntegrityDocument,
  type IntegrityInput,
  type SessionIntegrityReport,
} from '@/core/sessions/integrity';
import { db } from '@/db/client';
import { assignments, documents, folders, lemidaFiles, notes, sessions } from '@/db/schema';
import { listProjects, projectBase } from '@/lib/projects';
import { sessionTitle } from '@/lib/sessions';

/** One IntegrityInput per project, in 5 SELECTs whatever the number of projects. Read-only. */
export async function loadIntegrityInputs(projectIds: string[]): Promise<Map<string, IntegrityInput>> {
  const out = new Map<string, IntegrityInput>();
  if (projectIds.length === 0) return out;
  for (const id of projectIds) out.set(id, { sessions: [], documents: [] });

  const [sessionRows, docRows, assignmentRows, noteRows, lemidaRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        projectId: sessions.projectId,
        kind: sessions.kind,
        number: sessions.number,
        title: sessions.title,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(inArray(sessions.projectId, projectIds)),
    db
      .select({
        id: documents.id,
        projectId: documents.projectId,
        kind: documents.kind,
        title: documents.title,
        originalName: documents.originalName,
        sessionId: documents.sessionId,
        examMeta: documents.examMeta,
        builtin: folders.builtin,
      })
      .from(documents)
      .leftJoin(folders, eq(documents.folderId, folders.id))
      .where(inArray(documents.projectId, projectIds)),
    db
      .select({ sheet: assignments.sheetDocumentId, returned: assignments.returnedDocumentId })
      .from(assignments)
      .where(
        and(
          inArray(assignments.projectId, projectIds),
          or(isNotNull(assignments.sheetDocumentId), isNotNull(assignments.returnedDocumentId)),
        ),
      ),
    // "Has a note" means has text: the session note is created empty on first open.
    db
      .selectDistinct({ projectId: notes.projectId, sessionId: notes.sessionId })
      .from(notes)
      .where(
        and(
          inArray(notes.projectId, projectIds),
          isNotNull(notes.sessionId),
          sql`${notes.body} ~ '[^[:space:]]'`,
        ),
      ),
    db
      .select({
        documentId: sql<string | null>`${lemidaFiles.placement}->>'documentId'`,
        detectedKind: lemidaFiles.detectedKind,
        correctedKind: lemidaFiles.correctedKind,
        sectionTitle: lemidaFiles.sectionTitle,
        fileName: lemidaFiles.fileName,
        updatedAt: lemidaFiles.updatedAt,
      })
      .from(lemidaFiles)
      .where(and(inArray(lemidaFiles.projectId, projectIds), eq(lemidaFiles.status, 'imported'))),
  ]);

  const noteSessions = new Set(noteRows.map((n) => n.sessionId));
  const assignmentDocs = new Set(
    assignmentRows.flatMap((a) => [a.sheet, a.returned]).filter((v) => v !== null),
  );

  // Latest imported row per document, kept only when it filed the document as a lecture or recitation.
  const latest = new Map<string, (typeof lemidaRows)[number]>();
  for (const r of lemidaRows) {
    if (!r.documentId) continue;
    const prev = latest.get(r.documentId);
    if (!prev || r.updatedAt > prev.updatedAt) latest.set(r.documentId, r);
  }

  for (const s of sessionRows) {
    out.get(s.projectId)?.sessions.push({
      id: s.id,
      kind: s.kind,
      number: s.number,
      title: s.title,
      displayTitle: sessionTitle(s),
      createdAt: s.createdAt,
      hasNoteText: noteSessions.has(s.id),
    });
  }
  for (const d of docRows) {
    const row = latest.get(d.id);
    const kind = row ? (row.correctedKind ?? row.detectedKind) : null;
    const doc: IntegrityDocument = {
      id: d.id,
      kind: d.kind,
      title: d.title,
      originalName: d.originalName,
      sessionId: d.sessionId,
    };
    if (d.examMeta != null || d.builtin === 'practice_exams') doc.role = 'exam';
    else if (assignmentDocs.has(d.id)) doc.role = 'assignment';
    if (row && (kind === 'lecture' || kind === 'recitation')) {
      doc.lemida = { kind, sectionTitle: row.sectionTitle, fileName: row.fileName };
    }
    out.get(d.projectId)?.documents.push(doc);
  }
  return out;
}

/** The report for one course. Read-only. */
export async function loadSessionIntegrity(projectId: string): Promise<SessionIntegrityReport> {
  const inputs = await loadIntegrityInputs([projectId]);
  return findSessionAnomalies(inputs.get(projectId) ?? { sessions: [], documents: [] });
}

export interface CourseIntegritySummary {
  projectId: string;
  slug: string;
  name: string;
  archived: boolean;
  /** `${projectBase(p)}/settings#session-check` */
  href: string;
  problems: number;
  notices: number;
  duplicates: number;
}

/** Every course, archived included, sorted by problems desc, then notices desc, then name. */
export async function courseIntegritySummaries(): Promise<CourseIntegritySummary[]> {
  const courses = await listProjects({ kind: 'course', status: 'all' });
  const inputs = await loadIntegrityInputs(courses.map((c) => c.id));
  return courses
    .map((c) => {
      const report = findSessionAnomalies(inputs.get(c.id) ?? { sessions: [], documents: [] });
      return {
        projectId: c.id,
        slug: c.slug,
        name: c.name,
        archived: c.status === 'archived',
        href: `${projectBase(c)}/settings#session-check`,
        problems: report.problems,
        notices: report.notices,
        duplicates: report.counts.duplicate_number,
      };
    })
    .sort((a, b) => b.problems - a.problems || b.notices - a.notices || a.name.localeCompare(b.name));
}
