import { PRACTICE_EXAMS_REQUIRED } from '@quire/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  documents,
  folders,
  type RereadItem,
  rereadItems,
  type Test,
  type TestQuestion,
  testQuestions,
  tests,
} from '@/db/schema';

export { PRACTICE_EXAMS_REQUIRED };

export async function listTests(projectId: string): Promise<Test[]> {
  return db.select().from(tests).where(eq(tests.projectId, projectId)).orderBy(desc(tests.createdAt));
}

export async function getTest(
  projectId: string,
  id: string,
): Promise<(Test & { questions: TestQuestion[] }) | undefined> {
  const [row] = await db
    .select()
    .from(tests)
    .where(and(eq(tests.projectId, projectId), eq(tests.id, id)))
    .limit(1);
  if (!row) return undefined;
  const questions = await db
    .select()
    .from(testQuestions)
    .where(eq(testQuestions.testId, id))
    .orderBy(asc(testQuestions.n));
  return { ...row, questions };
}

/** Practice exams = documents in the builtin Practice Exams folder that are not themselves someone's solution. */
export async function practiceExamCount(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .innerJoin(folders, eq(folders.id, documents.folderId))
    .where(
      and(
        eq(documents.projectId, projectId),
        eq(folders.builtin, 'practice_exams'),
        sql`${documents.id} not in (select (d2.exam_meta->>'solutionDocumentId')::uuid from documents d2 where d2.project_id = ${projectId} and d2.exam_meta->>'solutionDocumentId' is not null)`,
      ),
    );
  return row?.n ?? 0;
}

/** Weeks since the last tri-weekly test; null when none exists. */
export async function weeksSinceLastTriweekly(projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ at: tests.createdAt })
    .from(tests)
    .where(and(eq(tests.projectId, projectId), eq(tests.kind, 'triweekly'), sql`${tests.status} <> 'failed'`))
    .orderBy(desc(tests.createdAt))
    .limit(1);
  if (!row) return null;
  return Math.floor((Date.now() - row.at.getTime()) / (7 * 86_400_000));
}

export async function openRereadItems(
  projectId: string,
  limit = 12,
): Promise<(RereadItem & { testTitle: string })[]> {
  const rows = await db
    .select({ item: rereadItems, testTitle: tests.title })
    .from(rereadItems)
    .innerJoin(tests, eq(tests.id, rereadItems.testId))
    .where(and(eq(tests.projectId, projectId), eq(rereadItems.done, false)))
    .orderBy(desc(rereadItems.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.item, testTitle: r.testTitle }));
}

export { testScore } from './test-score';
