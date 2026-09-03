import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Annotation, annotations, type Document, documents } from '@/db/schema';

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
