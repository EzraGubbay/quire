// @vitest-environment node
// Empty-chat semantics (list filter, createThread reuse, boot prune) against a real, migrated Postgres. Opt-in:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to run-unique projects and is deleted afterwards (the project cascade); never truncates.
// pruneEmptyThreads deletes globally by design, so assertions only look at this run's ids.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { chatThreads, documents, type Project, projects } from '@/db/schema';
import { addMessage, createThread, listRecentCourseThreads, listThreads, pruneEmptyThreads } from './chat';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];

async function newProject(kind: 'course' | 'research' = 'course'): Promise<Project> {
  const [p] = await db
    .insert(projects)
    .values({ slug: `chat-empty-${RUN}-${projectIds.length}`, name: 'it', kind })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}
async function newDoc(projectId: string): Promise<string> {
  const [d] = await db
    .insert(documents)
    .values({ projectId, kind: 'markdown', title: 'd', markdownBody: 'x' })
    .returning();
  if (!d) throw new Error('no doc');
  return d.id;
}
const backdate = (id: string) =>
  db
    .update(chatThreads)
    .set({ updatedAt: new Date(Date.now() - 48 * 3600e3) })
    .where(eq(chatThreads.id, id));
const rows = (projectId: string) => db.select().from(chatThreads).where(eq(chatThreads.projectId, projectId));
const ids = (ts: Array<{ id: string }>) => ts.map((t) => t.id);

describe.skipIf(!run)('empty chat threads (integration)', () => {
  afterAll(async () => {
    for (const id of projectIds) await db.delete(projects).where(eq(projects.id, id));
    await getSql().end();
  });

  it('listThreads hides a thread with no messages until one is sent', async () => {
    const p = await newProject();
    const t = await createThread(p.id);
    expect(await listThreads(p.id)).toEqual([]);
    await addMessage(t.id, { role: 'user', content: 'hi' });
    expect(ids(await listThreads(p.id))).toEqual([t.id]);
  });

  it('listThreads includeId lists that empty thread and no other empty one', async () => {
    const p = await newProject();
    const a = await createThread(p.id);
    const b = await createThread(p.id, { mode: 'tutor-hint' });
    expect(ids(await listThreads(p.id, null, { includeId: a.id }))).toEqual([a.id]);
    expect(ids(await listThreads(p.id, null, { includeId: b.id }))).toEqual([b.id]);
  });

  it('listThreads keeps document scoping and hides an empty document thread', async () => {
    const p = await newProject();
    const docId = await newDoc(p.id);
    const empty = await createThread(p.id, { documentId: docId });
    expect(await listThreads(p.id, docId)).toEqual([]);
    await addMessage(empty.id, { role: 'user', content: 'q' });
    const other = await createThread(p.id, { documentId: null, title: 'T' });
    await addMessage(other.id, { role: 'user', content: 'q' });
    expect(ids(await listThreads(p.id, docId))).toEqual([empty.id]);
  });

  it('listRecentCourseThreads excludes empty threads and research projects', async () => {
    const course = await newProject('course');
    const research = await newProject('research');
    const emptyC = await createThread(course.id);
    const full = await createThread(course.id, { mode: 'tutor-hint' });
    await addMessage(full.id, { role: 'user', content: 'q' });
    const fullR = await createThread(research.id);
    await addMessage(fullR.id, { role: 'user', content: 'q' });
    const got = ids((await listRecentCourseThreads(500)).map((r) => r.thread));
    expect(got).toContain(full.id);
    expect(got).not.toContain(emptyC.id);
    expect(got).not.toContain(fullR.id);
  });

  it('createThread reuses an empty thread in the same scope and bumps updatedAt', async () => {
    const p = await newProject();
    const a = await createThread(p.id);
    await backdate(a.id);
    const b = await createThread(p.id);
    expect(b.id).toBe(a.id);
    expect(b.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await rows(p.id)).toHaveLength(1);
  });

  it('createThread does not reuse across scopes, non-empty candidates or an explicit title', async () => {
    const p = await newProject();
    const other = await newProject();
    const docId = await newDoc(p.id);
    const base = await createThread(p.id);
    const q1 = randomUUID();
    const variants = [
      await createThread(p.id, { documentId: docId }),
      await createThread(p.id, { assignmentQuestionId: q1 }),
      await createThread(p.id, { mode: 'tutor-full' }),
      await createThread(other.id),
      await createThread(p.id, { title: 'Named' }),
    ];
    const all = [base.id, ...ids(variants)];
    expect(new Set(all).size).toBe(all.length);

    await addMessage(base.id, { role: 'user', content: 'q' });
    const next = await createThread(p.id);
    expect(next.id).not.toBe(base.id);
  });

  it('pruneEmptyThreads deletes only stale empty threads, keeping any thread with a message', async () => {
    const p = await newProject();
    const staleEmpty = await createThread(p.id);
    const freshEmpty = await createThread(p.id, { mode: 'tutor-hint' });
    const staleWithAnswer = await createThread(p.id, { mode: 'tutor-full' });
    const staleMidTurn = await createThread(p.id, { title: 'mid-turn' });
    await addMessage(staleWithAnswer.id, { role: 'user', content: 'q' });
    await addMessage(staleWithAnswer.id, { role: 'assistant', content: 'a' });
    // A turn still streaming (or failed) has only the user row.
    await addMessage(staleMidTurn.id, { role: 'user', content: 'q' });
    for (const t of [staleEmpty, staleWithAnswer, staleMidTurn]) await backdate(t.id);

    const n = await pruneEmptyThreads();
    expect(n).toBeGreaterThanOrEqual(1);
    const left = ids(await rows(p.id));
    expect(left).not.toContain(staleEmpty.id);
    expect(left).toEqual(expect.arrayContaining([freshEmpty.id, staleWithAnswer.id, staleMidTurn.id]));
  });
});
