import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  type Annotation,
  type Assignment,
  annotations,
  type Document,
  documents,
  experiments,
  type Note,
  notes,
  type RereadItem,
  type Run,
  runs,
  type Session,
  sessions,
} from '@/db/schema';
import { nextDue } from './homework';
import { openRereadItems, practiceExamCount, weeksSinceLastTriweekly } from './tests';

export interface OverviewData {
  counts: { documents: number; annotations: number; open: number };
  recentDocuments: Document[];
  /** Question and Todo annotations, newest first, with their document title. */
  openItems: (Annotation & { documentTitle: string | null })[];
  lastActivity: Date | null;
}

export async function getOverview(projectId: string): Promise<OverviewData> {
  const [counts] = await db
    .select({
      documents: sql<number>`(select count(*)::int from ${documents} where ${documents.projectId} = ${projectId})`,
      annotations: sql<number>`(select count(*)::int from ${annotations} where ${annotations.projectId} = ${projectId})`,
      open: sql<number>`(select count(*)::int from ${annotations} where ${annotations.projectId} = ${projectId} and ${annotations.type} in ('question','todo'))`,
    })
    .from(sql`(select 1) as one`);
  const recentDocuments = await db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(desc(documents.updatedAt))
    .limit(6);
  const openRows = await db
    .select({ a: annotations, documentTitle: documents.title })
    .from(annotations)
    .leftJoin(documents, eq(documents.id, annotations.documentId))
    .where(and(eq(annotations.projectId, projectId), inArray(annotations.type, ['question', 'todo'])))
    .orderBy(desc(annotations.createdAt))
    .limit(8);
  const [last] = await db
    .select({
      at: sql<Date | null>`greatest(max(${documents.updatedAt}), (select max(${annotations.updatedAt}) from ${annotations} where ${annotations.projectId} = ${projectId}))`,
    })
    .from(documents)
    .where(eq(documents.projectId, projectId));
  return {
    counts: counts ?? { documents: 0, annotations: 0, open: 0 },
    recentDocuments,
    openItems: openRows.map((r) => ({ ...r.a, documentTitle: r.documentTitle })),
    lastActivity: last?.at ? new Date(last.at) : null,
  };
}

/** Latest runs across the project's experiments, for the overview card. */
export async function recentRuns(
  projectId: string,
  limit = 3,
): Promise<{ run: Run; experimentName: string }[]> {
  return db
    .select({ run: runs, experimentName: experiments.name })
    .from(runs)
    .innerJoin(experiments, eq(runs.experimentId, experiments.id))
    .where(eq(experiments.projectId, projectId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}

export interface CourseOverviewData {
  counts: { lectures: number; recitations: number; notes: number; openAssignments: number };
  latestLecture: Session | null;
  latestRecitation: Session | null;
  nextDue: Assignment[];
  reread: (RereadItem & { testTitle: string })[];
  openItems: (Annotation & { documentTitle: string | null })[];
  recentNotes: Note[];
  weeksSinceTriweekly: number | null;
  practiceExams: number;
}

export async function getCourseOverview(projectId: string): Promise<CourseOverviewData> {
  const [counts] = await db
    .select({
      lectures: sql<number>`(select count(*)::int from ${sessions} where ${sessions.projectId} = ${projectId} and ${sessions.kind} = 'lecture')`,
      recitations: sql<number>`(select count(*)::int from ${sessions} where ${sessions.projectId} = ${projectId} and ${sessions.kind} = 'recitation')`,
      notes: sql<number>`(select count(*)::int from ${notes} where ${notes.projectId} = ${projectId})`,
      openAssignments: sql<number>`(select count(*)::int from assignments a where a.project_id = ${projectId} and a.status not in ('submitted','graded'))`,
    })
    .from(sql`(select 1) as one`);
  const [latestLecture] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, 'lecture')))
    .orderBy(desc(sessions.number), desc(sessions.createdAt))
    .limit(1);
  const [latestRecitation] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, 'recitation')))
    .orderBy(desc(sessions.number), desc(sessions.createdAt))
    .limit(1);
  const [due, reread, openRows, recentNotes, weeks, exams] = await Promise.all([
    nextDue(projectId, 4),
    openRereadItems(projectId, 8),
    db
      .select({ a: annotations, documentTitle: documents.title })
      .from(annotations)
      .leftJoin(documents, eq(documents.id, annotations.documentId))
      .where(and(eq(annotations.projectId, projectId), inArray(annotations.type, ['question', 'todo'])))
      .orderBy(desc(annotations.createdAt))
      .limit(6),
    db.select().from(notes).where(eq(notes.projectId, projectId)).orderBy(desc(notes.updatedAt)).limit(6),
    weeksSinceLastTriweekly(projectId),
    practiceExamCount(projectId),
  ]);
  return {
    counts: counts ?? { lectures: 0, recitations: 0, notes: 0, openAssignments: 0 },
    latestLecture: latestLecture ?? null,
    latestRecitation: latestRecitation ?? null,
    nextDue: due,
    reread,
    openItems: openRows.map((r) => ({ ...r.a, documentTitle: r.documentTitle })),
    recentNotes,
    weeksSinceTriweekly: weeks,
    practiceExams: exams,
  };
}
