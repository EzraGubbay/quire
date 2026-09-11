import { and, asc, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { type ChatMessage, type ChatThread, chatMessages, chatThreads } from '@/db/schema';

/** Newest first. With `documentId`, only the chats scoped to that document. */
export async function listThreads(projectId: string, documentId?: string | null): Promise<ChatThread[]> {
  return db
    .select()
    .from(chatThreads)
    .where(
      documentId
        ? and(eq(chatThreads.projectId, projectId), eq(chatThreads.documentId, documentId))
        : eq(chatThreads.projectId, projectId),
    )
    .orderBy(desc(chatThreads.updatedAt))
    .limit(100);
}

/** The last question in a thread (for a retry after a failed answer). */
export async function lastUserMessage(threadId: string): Promise<ChatMessage | undefined> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, 'user')))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  return rows[0];
}

/** Removes failed assistant rows that follow the last question, so a retry does not leave error stubs behind. */
export async function dropFailedAfter(threadId: string, after: Date): Promise<void> {
  await db
    .delete(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.role, 'assistant'),
        isNotNull(chatMessages.error),
        gt(chatMessages.createdAt, after),
      ),
    );
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
