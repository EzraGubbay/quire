'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ChatMessage, ChatThread } from '@/db/schema';
import { reindexProject } from '@/lib/ai/index';
import { clearProviderBlock, spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { createThread, deleteThread, getThread, listMessages, listThreads } from '@/lib/chat';
import { listDocuments } from '@/lib/documents';
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

export async function newThreadAndGoAction(slug: string, documentId?: string | null): Promise<void> {
  const id = await newThreadAction(slug, documentId ?? null);
  redirect(`/p/${slug}/chat/${id}`);
}

export interface AskContext {
  summary: Awaited<ReturnType<typeof spendSummary>>;
  configured: boolean;
  /** Document titles offered by the composer's `[[` / `doc.` completer. */
  titles: string[];
  /** Chats in scope (the document's, or the unscoped project chats), newest first. */
  threads: Pick<ChatThread, 'id' | 'title' | 'updatedAt'>[];
  /** Messages of the newest chat in scope. */
  messages: ChatMessage[];
}

/** Everything the Ask panel needs on open: spend state, completer titles, the chats in scope and the latest one's messages. */
export async function askContextAction(slug: string, documentId?: string | null): Promise<AskContext> {
  const project = await projectOr404(slug);
  const [summary, docs, all] = await Promise.all([
    spendSummary(),
    listDocuments(project.id),
    listThreads(project.id),
  ]);
  const threads = all.filter((t) => (documentId ? t.documentId === documentId : !t.documentId));
  const newest = threads[0];
  const messages = newest ? await listMessages(newest.id) : [];
  return {
    summary,
    configured: aiConfigured(),
    titles: docs.map((d) => d.title),
    threads: threads.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })),
    messages,
  };
}

export async function threadMessagesAction(slug: string, threadId: string): Promise<ChatMessage[]> {
  const project = await projectOr404(slug);
  const thread = await getThread(project.id, threadId);
  if (!thread) throw new Error('thread not found');
  return listMessages(threadId);
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
