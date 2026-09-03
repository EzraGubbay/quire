import type { Anchor, AnnotationType } from '@quire/shared';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Annotation, annotations } from '@/db/schema';

export async function listAnnotations(projectId: string, documentId: string): Promise<Annotation[]> {
  return db
    .select()
    .from(annotations)
    .where(and(eq(annotations.projectId, projectId), eq(annotations.documentId, documentId)))
    .orderBy(asc(annotations.pageNo), asc(annotations.createdAt));
}

export interface AnnotationInput {
  documentId: string;
  type?: AnnotationType;
  body?: string;
  quote?: string;
  anchor?: Anchor | null;
}

export async function createAnnotation(projectId: string, input: AnnotationInput): Promise<Annotation> {
  const pageNo = input.anchor?.kind === 'pdf' ? input.anchor.page : null;
  const [row] = await db
    .insert(annotations)
    .values({
      projectId,
      documentId: input.documentId,
      type: input.type ?? 'note',
      body: input.body ?? '',
      quote: input.quote ?? input.anchor?.quote ?? '',
      anchor: input.anchor ?? null,
      pageNo,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function updateAnnotation(
  projectId: string,
  id: string,
  patch: Partial<Pick<Annotation, 'type' | 'body' | 'orphaned'>>,
): Promise<void> {
  await db
    .update(annotations)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(annotations.id, id), eq(annotations.projectId, projectId)));
}

export async function deleteAnnotation(projectId: string, id: string): Promise<void> {
  await db.delete(annotations).where(and(eq(annotations.id, id), eq(annotations.projectId, projectId)));
}
