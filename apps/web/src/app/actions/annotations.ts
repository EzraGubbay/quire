'use server';

import { anchorSchema, annotationTypeSchema } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';
import type { Annotation } from '@/db/schema';
import { indexOwner, removeOwner } from '@/lib/ai/index';
import { createAnnotation, deleteAnnotation, updateAnnotation } from '@/lib/annotations';
import { getProjectBySlug } from '@/lib/projects';

const createSchema = z.object({
  documentId: z.string().uuid(),
  type: annotationTypeSchema.default('note'),
  body: z.string().max(20000).default(''),
  anchor: anchorSchema.nullable().default(null),
});

export async function createAnnotationAction(
  slug: string,
  input: z.input<typeof createSchema>,
): Promise<Annotation> {
  const parsed = createSchema.parse(input);
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  const row = await createAnnotation(project.id, parsed);
  after(() => indexOwner(project.id, 'annotation', row.id).catch(() => {}));
  revalidatePath(`/p/${slug}/documents/${parsed.documentId}`);
  return row;
}

const patchSchema = z.object({
  type: annotationTypeSchema.optional(),
  body: z.string().max(20000).optional(),
});

export async function updateAnnotationAction(
  slug: string,
  documentId: string,
  id: string,
  patch: z.input<typeof patchSchema>,
): Promise<void> {
  const parsed = patchSchema.parse(patch);
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  await updateAnnotation(project.id, id, parsed);
  after(() => indexOwner(project.id, 'annotation', id).catch(() => {}));
  revalidatePath(`/p/${slug}/documents/${documentId}`);
}

export async function deleteAnnotationAction(slug: string, documentId: string, id: string): Promise<void> {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  await deleteAnnotation(project.id, id);
  await removeOwner(project.id, 'annotation', id);
  revalidatePath(`/p/${slug}/documents/${documentId}`);
}
