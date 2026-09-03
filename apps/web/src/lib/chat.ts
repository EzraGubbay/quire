import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type ChatMessage, type ChatThread, chatMessages, chatThreads } from '@/db/schema';

export async function listThreads(projectId: string): Promise<ChatThread[]> {
  return db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.projectId, projectId))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(100);
}

export async function getThread(projectId: string, id: string): Promise<ChatThread | undefined> {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, id), eq(chatThreads.projectId, projectId)))
    .limit(1);
  return rows[0];
}

export async function createThread(
  projectId: string,
  opts: { title?: string; documentId?: string | null } = {},
): Promise<ChatThread> {
  const [row] = await db
    .insert(chatThreads)
    .values({ projectId, title: opts.title ?? 'New chat', documentId: opts.documentId ?? null })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function renameThread(id: string, title: string): Promise<void> {
  await db
    .update(chatThreads)
    .set({ title: title.slice(0, 120), updatedAt: new Date() })
    .where(eq(chatThreads.id, id));
}

export async function touchThread(id: string): Promise<void> {
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, id));
}

export async function deleteThread(projectId: string, id: string): Promise<void> {
  await db.delete(chatThreads).where(and(eq(chatThreads.id, id), eq(chatThreads.projectId, projectId)));
}

export async function listMessages(threadId: string): Promise<ChatMessage[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt));
}

export interface Citation {
  n: number;
  kind: string;
  id: string;
  title: string;
  href: string;
  pageNo: number | null;
}

export async function addMessage(
  threadId: string,
  input: Partial<ChatMessage> & { role: string; content: string },
): Promise<ChatMessage> {
  const [row] = await db
    .insert(chatMessages)
    .values({ threadId, ...input })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}
