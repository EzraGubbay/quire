import { and, asc, eq, gte, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  type Assignment,
  type AssignmentFile,
  type AssignmentQuestion,
  assignmentFiles,
  assignmentQuestions,
  assignments,
  type Document,
  documents,
  type Project,
} from '@/db/schema';
import { removeStoredFile, storeFile } from '@/lib/files';
import { projectBase } from '@/lib/projects';

export const fmtDue = (d: Date): string =>
  d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export interface DueSoonItem {
  id: string;
  title: string;
  courseName: string;
  href: string;
  dueAt: string;
}

/** Unsubmitted assignments due in the next seven days across the given courses, soonest first. */
export async function dueSoonAcrossCourses(courses: Project[], days = 7): Promise<DueSoonItem[]> {
  if (courses.length === 0) return [];
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);
  const rows = await db
    .select()
    .from(assignments)
    .where(
      and(
        inArray(
          assignments.projectId,
          courses.map((c) => c.id),
        ),
        isNotNull(assignments.dueAt),
        gte(assignments.dueAt, new Date(now.getTime() - 86_400_000)),
        lte(assignments.dueAt, until),
        notInArray(assignments.status, ['submitted', 'graded']),
      ),
    )
    .orderBy(asc(assignments.dueAt));
  const byId = new Map(courses.map((c) => [c.id, c]));
  return rows.flatMap((a: Assignment) => {
    const course = byId.get(a.projectId);
    if (!course || !a.dueAt) return [];
    return [
      {
        id: a.id,
        title: `#${a.number} ${a.title}`,
        courseName: course.name,
        href: `${projectBase(course)}/homework/${a.id}`,
        dueAt: fmtDue(a.dueAt),
      },
    ];
  });
}

export async function listAssignments(projectId: string): Promise<Assignment[]> {
  return db
    .select()
    .from(assignments)
    .where(eq(assignments.projectId, projectId))
    .orderBy(asc(assignments.dueAt));
}

export interface AssignmentWithProgress extends Assignment {
  done: number;
  total: number;
}

export async function listAssignmentsWithProgress(projectId: string): Promise<AssignmentWithProgress[]> {
  const rows = await db
    .select({
      a: assignments,
      done: sql<number>`(select count(*)::int from ${assignmentQuestions} q where q.assignment_id = ${assignments.id} and q.status = 'done')`,
      total: sql<number>`(select count(*)::int from ${assignmentQuestions} q where q.assignment_id = ${assignments.id})`,
    })
    .from(assignments)
    .where(eq(assignments.projectId, projectId))
    .orderBy(asc(assignments.dueAt), asc(assignments.number));
  return rows.map((r) => ({ ...r.a, done: r.done, total: r.total }));
}

export interface AssignmentDetail extends Assignment {
  questions: AssignmentQuestion[];
  files: AssignmentFile[];
  sheet: Document | null;
  returned: Document | null;
}

export async function getAssignment(projectId: string, id: string): Promise<AssignmentDetail | undefined> {
  const [a] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.projectId, projectId), eq(assignments.id, id)))
    .limit(1);
  if (!a) return undefined;
  const [questions, files, docs] = await Promise.all([
    db
      .select()
      .from(assignmentQuestions)
      .where(eq(assignmentQuestions.assignmentId, id))
      .orderBy(asc(assignmentQuestions.position), asc(assignmentQuestions.createdAt)),
    db
      .select()
      .from(assignmentFiles)
      .where(eq(assignmentFiles.assignmentId, id))
      .orderBy(asc(assignmentFiles.createdAt)),
    db
      .select()
      .from(documents)
      .where(
        inArray(
          documents.id,
          [a.sheetDocumentId, a.returnedDocumentId]
            .filter((x): x is string => Boolean(x))
            .concat(['00000000-0000-0000-0000-000000000000']),
        ),
      ),
  ]);
  return {
    ...a,
    questions,
    files,
    sheet: docs.find((d) => d.id === a.sheetDocumentId) ?? null,
    returned: docs.find((d) => d.id === a.returnedDocumentId) ?? null,
  };
}

export async function nextAssignmentNumber(projectId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${assignments.number})` })
    .from(assignments)
    .where(eq(assignments.projectId, projectId));
  return (row?.max ?? 0) + 1;
}

export async function createAssignment(
  projectId: string,
  input: { number?: number; title: string; dueAt?: Date | null; questions?: string[] },
): Promise<Assignment> {
  const number = input.number ?? (await nextAssignmentNumber(projectId));
  const [row] = await db
    .insert(assignments)
    .values({ projectId, number, title: input.title, dueAt: input.dueAt ?? null })
    .returning();
  if (!row) throw new Error('insert returned no row');
  if (input.questions?.length)
    await db
      .insert(assignmentQuestions)
      .values(input.questions.map((label, i) => ({ assignmentId: row.id, label, position: i })));
  return row;
}

export async function updateAssignment(
  projectId: string,
  id: string,
  patch: Partial<
    Pick<
      Assignment,
      | 'number'
      | 'title'
      | 'dueAt'
      | 'status'
      | 'repoUrl'
      | 'score'
      | 'maxScore'
      | 'lostPoints'
      | 'notes'
      | 'sheetDocumentId'
      | 'returnedDocumentId'
    >
  >,
): Promise<void> {
  await db
    .update(assignments)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(assignments.projectId, projectId), eq(assignments.id, id)));
}

export async function deleteAssignment(projectId: string, id: string): Promise<AssignmentFile[]> {
  const files = await db.select().from(assignmentFiles).where(eq(assignmentFiles.assignmentId, id));
  await db.delete(assignments).where(and(eq(assignments.projectId, projectId), eq(assignments.id, id)));
  return files;
}

export async function addQuestion(assignmentId: string, label: string): Promise<AssignmentQuestion> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${assignmentQuestions.position})` })
    .from(assignmentQuestions)
    .where(eq(assignmentQuestions.assignmentId, assignmentId));
  const [q] = await db
    .insert(assignmentQuestions)
    .values({ assignmentId, label, position: (row?.max ?? -1) + 1 })
    .returning();
  if (!q) throw new Error('insert returned no row');
  return q;
}

export async function updateQuestion(
  id: string,
  patch: Partial<Pick<AssignmentQuestion, 'label' | 'status' | 'notes' | 'position'>>,
): Promise<void> {
  await db
    .update(assignmentQuestions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assignmentQuestions.id, id));
}

export async function deleteQuestion(id: string): Promise<void> {
  await db.delete(assignmentQuestions).where(eq(assignmentQuestions.id, id));
}

/** Submitted files live under <project>/assignments/<assignment>/<fileId>.<ext>. */
export async function addSubmissionFile(
  projectId: string,
  assignmentId: string,
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<AssignmentFile> {
  const [row] = await db
    .insert(assignmentFiles)
    .values({
      assignmentId,
      name: file.name,
      filePath: '',
      size: file.data.byteLength,
      contentType: file.contentType,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  const ext =
    file.name
      .split('.')
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'bin';
  const rel = await storeFile(projectId, `assignments/${assignmentId}/${row.id}`, ext, file.data);
  await db.update(assignmentFiles).set({ filePath: rel }).where(eq(assignmentFiles.id, row.id));
  return { ...row, filePath: rel };
}

export async function removeSubmissionFile(id: string): Promise<AssignmentFile | undefined> {
  const [row] = await db.delete(assignmentFiles).where(eq(assignmentFiles.id, id)).returning();
  if (row) await removeStoredFile(row.filePath);
  return row;
}

/** Status derived from the parts: graded when scored, submitted when files or a repo are in, else by question progress. */
export function deriveStatus(
  a: Pick<Assignment, 'score' | 'repoUrl' | 'status'>,
  files: number,
  done: number,
  total: number,
): Assignment['status'] {
  if (a.score != null) return 'graded';
  if (a.status === 'submitted' || a.status === 'graded') return a.status;
  if (files > 0 || a.repoUrl) return 'submitted';
  if (done > 0 || total > 0) return done > 0 ? 'in_progress' : 'not_started';
  return 'not_started';
}

/** The next unsubmitted assignments for the overview, soonest first (overdue included). */
export async function nextDue(projectId: string, limit = 4): Promise<Assignment[]> {
  return db
    .select()
    .from(assignments)
    .where(and(eq(assignments.projectId, projectId), notInArray(assignments.status, ['submitted', 'graded'])))
    .orderBy(sql`${assignments.dueAt} nulls last`, asc(assignments.number))
    .limit(limit);
}
