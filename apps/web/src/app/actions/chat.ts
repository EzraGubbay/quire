'use server';

import { THREAD_MODES, type ThreadMode } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ChatMessage, ChatThread } from '@/db/schema';
import { reindexProject } from '@/lib/ai/index';
import { clearProviderBlock, spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { createThread, deleteThread, getThread, listMessages, listThreads, setThreadMode } from '@/lib/chat';
import { listDocuments } from '@/lib/documents';
import { deckNote } from '@/lib/notes';
import { baseFromSlug, getProjectBySlug, projectBase } from '@/lib/projects';

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

export interface AskScope {
  documentId?: string | null;
  /** Homework: tutor-hint by default; tutor-full after the labelled toggle. */
  mode?: ThreadMode;
  /** Homework question the chat is about (its chats are listed separately). */
  questionId?: string | null;
}

export async function newThreadAction(
  slug: string,
  documentId?: string | null,
  scope: AskScope = {},
): Promise<string> {
  const project = await projectOr404(slug);
  const mode =
    scope.mode && (THREAD_MODES as readonly string[]).includes(scope.mode) ? scope.mode : 'default';
  const t = await createThread(project.id, {
    documentId: documentId ?? scope.documentId ?? null,
    mode,
    assignmentQuestionId: scope.questionId ?? null,
  });
  revalidatePath(`${projectBase(project)}/chat`);
  return t.id;
}

export async function newThreadAndGoAction(slug: string, documentId?: string | null): Promise<void> {
  const id = await newThreadAction(slug, documentId ?? null);
  redirect(`${await baseFromSlug(slug)}/chat/${id}`);
}

export interface AskContext {
  summary: Awaited<ReturnType<typeof spendSummary>>;
  configured: boolean;
  /** Document titles offered by the composer's `[[` / `doc.` completer. */
  titles: string[];
  /** Chats in scope (the document's, the question's, or the unscoped project chats), newest first. */
  threads: Pick<ChatThread, 'id' | 'title' | 'updatedAt' | 'mode'>[];
  /** Messages of the newest chat in scope. */
  messages: ChatMessage[];
  /** Asking from a lecture or recitation deck: the working note sent along with the slides. */
  note: { title: string; sessionKind: string } | null;
}

/** Everything the Ask panel needs on open: spend state, completer titles, the chats in scope and the latest one's messages. */
export async function askContextAction(
  slug: string,
  documentId?: string | null,
  scope: AskScope = {},
): Promise<AskContext> {
  const project = await projectOr404(slug);
  const [summary, docs, all, working] = await Promise.all([
    spendSummary(),
    listDocuments(project.id),
    listThreads(project.id),
    project.kind === 'course' && documentId ? deckNote(project.id, documentId) : undefined,
  ]);
  const threads = all.filter((t) =>
    scope.questionId
      ? t.assignmentQuestionId === scope.questionId
      : documentId
        ? t.documentId === documentId && !t.assignmentQuestionId
        : !t.documentId && !t.assignmentQuestionId,
  );
  const newest = threads[0];
  const messages = newest ? await listMessages(newest.id) : [];
  return {
    summary,
    configured: aiConfigured(),
    titles: docs.map((d) => d.title),
    threads: threads.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, mode: t.mode })),
    messages,
    note: working ? { title: working.note.title, sessionKind: working.sessionKind } : null,
  };
}

export async function threadMessagesAction(slug: string, threadId: string): Promise<ChatMessage[]> {
  const project = await projectOr404(slug);
  const thread = await getThread(project.id, threadId);
  if (!thread) throw new Error('thread not found');
  return listMessages(threadId);
}

export async function setThreadModeAction(slug: string, threadId: string, mode: ThreadMode): Promise<void> {
  const project = await projectOr404(slug);
  const thread = await getThread(project.id, threadId);
  if (!thread) return;
  await setThreadMode(threadId, mode);
  revalidatePath(`${projectBase(project)}/chat/${threadId}`);
}

export async function deleteThreadAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteThread(project.id, id);
  revalidatePath(`${projectBase(project)}/chat`);
  redirect(`${projectBase(project)}/chat`);
}

export async function reindexAction(slug: string, force = false): Promise<{ indexed: number }> {
  const project = await projectOr404(slug);
  return reindexProject(project.id, force);
}

export async function clearProviderBlockAction(): Promise<void> {
  await clearProviderBlock();
  revalidatePath('/settings');
}
