import { and, asc, desc, eq, exists, gt, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type ChatMessage, type ChatThread, chatMessages, chatThreads, projects } from '@/db/schema';

/** How long an unsent (message-less) chat survives before the boot cleanup prunes it. */
export const EMPTY_THREAD_GRACE_MS = 24 * 60 * 60 * 1000;

/** SQL: the thread has at least one message (a question was sent). */
const hasMessages = () =>
  exists(db.select({ x: sql`1` }).from(chatMessages).where(eq(chatMessages.threadId, chatThreads.id)));

/**
 * Newest first. With `documentId`, only the chats scoped to that document. Only chats with at
 * least one message, plus `includeId` (the chat being viewed, which may still be empty).
 */
export async function listThreads(
  projectId: string,
  documentId?: string | null,
  opts: { includeId?: string } = {},
): Promise<ChatThread[]> {
  const visible = or(hasMessages(), opts.includeId ? eq(chatThreads.id, opts.includeId) : undefined);
  return db
    .select()
    .from(chatThreads)
    .where(
      and(
        documentId
          ? and(eq(chatThreads.projectId, projectId), eq(chatThreads.documentId, documentId))
          : eq(chatThreads.projectId, projectId),
        visible,
      ),
    )
    .orderBy(desc(chatThreads.updatedAt))
    .limit(100);
}

/** Most recently active threads across all courses, newest first, with their course slug. */
export async function listRecentCourseThreads(
  limit: number,
): Promise<Array<{ thread: ChatThread; courseSlug: string }>> {
  const rows = await db
    .select({ thread: chatThreads, courseSlug: projects.slug })
    .from(chatThreads)
    .innerJoin(projects, eq(chatThreads.projectId, projects.id))
    .where(and(eq(projects.kind, 'course'), hasMessages()))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit);
  return rows;
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

/**
 * Reuses an empty chat in the same scope (project, document, question, mode) so repeated New chat
 * never piles up untitled rows. An explicit `title` always inserts.
 */
export async function createThread(
  projectId: string,
  opts: {
    title?: string;
    documentId?: string | null;
    mode?: string;
    assignmentQuestionId?: string | null;
  } = {},
): Promise<ChatThread> {
  if (opts.title === undefined) {
    const documentId = opts.documentId ?? null;
    const questionId = opts.assignmentQuestionId ?? null;
    const [empty] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.projectId, projectId),
          documentId === null ? isNull(chatThreads.documentId) : eq(chatThreads.documentId, documentId),
          questionId === null
            ? isNull(chatThreads.assignmentQuestionId)
            : eq(chatThreads.assignmentQuestionId, questionId),
          eq(chatThreads.mode, opts.mode ?? 'default'),
          not(hasMessages()),
        ),
      )
      .orderBy(desc(chatThreads.updatedAt))
      .limit(1);
    if (empty) {
      const [reused] = await db
        .update(chatThreads)
        .set({ updatedAt: new Date() })
        .where(eq(chatThreads.id, empty.id))
        .returning();
      if (reused) return reused;
    }
  }
  const [row] = await db
    .insert(chatThreads)
    .values({
      projectId,
      title: opts.title ?? 'New chat',
      documentId: opts.documentId ?? null,
      mode: opts.mode ?? 'default',
      assignmentQuestionId: opts.assignmentQuestionId ?? null,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Deletes chats with no messages untouched for `olderThanMs`. Returns how many were removed. */
export async function pruneEmptyThreads(olderThanMs: number = EMPTY_THREAD_GRACE_MS): Promise<number> {
  const rows = await db
    .delete(chatThreads)
    .where(and(lt(chatThreads.updatedAt, new Date(Date.now() - olderThanMs)), not(hasMessages())))
    .returning({ id: chatThreads.id });
  return rows.length;
}

/** Tutor chats toggle between hints and full solutions. */
export async function setThreadMode(id: string, mode: string): Promise<void> {
  await db.update(chatThreads).set({ mode, updatedAt: new Date() }).where(eq(chatThreads.id, id));
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
