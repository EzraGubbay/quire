'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { reindexProject } from '@/lib/ai/index';
import { clearProviderBlock } from '@/lib/ai/ledger';
import { createThread, deleteThread } from '@/lib/chat';
import { getProjectBySlug } from '@/lib/projects';

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

export async function newThreadAction(slug: string, documentId?: string | null): Promise<string> {
  const project = await projectOr404(slug);
  const t = await createThread(project.id, { documentId: documentId ?? null });
  revalidatePath(`/p/${slug}/chat`);
  return t.id;
}

export async function newThreadAndGoAction(slug: string): Promise<void> {
  const id = await newThreadAction(slug);
  redirect(`/p/${slug}/chat/${id}`);
}

export async function deleteThreadAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteThread(project.id, id);
  revalidatePath(`/p/${slug}/chat`);
  redirect(`/p/${slug}/chat`);
}

export async function reindexAction(slug: string, force = false): Promise<{ indexed: number }> {
  const project = await projectOr404(slug);
  return reindexProject(project.id, force);
}

export async function clearProviderBlockAction(): Promise<void> {
  await clearProviderBlock();
  revalidatePath('/settings');
}
