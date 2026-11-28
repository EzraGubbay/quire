// @vitest-environment node
// The session integrity loader against a real, migrated Postgres. Opt-in, like the other db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run session-integrity.db.integration
// Every row belongs to run-unique projects and is deleted afterwards (the project cascade); never truncates.
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { assignments, documents, folders, lemidaFiles, notes, projects, sessions } from '@/db/schema';
import { courseIntegritySummaries, loadIntegrityInputs, loadSessionIntegrity } from './session-integrity';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];

async function newCourse(label: string, status: 'active' | 'archived' = 'active') {
  const [p] = await db
    .insert(projects)
    .values({ slug: `session-check-${RUN}-${label}`, name: `Session check ${label}`, kind: 'course', status })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}
async function newSession(projectId: string, kind: 'lecture' | 'recitation', number: number, title: string) {
  const [s] = await db.insert(sessions).values({ projectId, kind, number, title }).returning();
  if (!s) throw new Error('no session');
  return s;
}
async function newDoc(projectId: string, title: string, extra: Partial<typeof documents.$inferInsert> = {}) {
  const [d] = await db
    .insert(documents)
    .values({ projectId, kind: 'pdf', title, ...extra })
    .returning();
  if (!d) throw new Error('no doc');
  return d;
}
const snapshot = async (projectId: string) => ({
  sessions: await db.select().from(sessions).where(eq(sessions.projectId, projectId)),
  documents: await db.select().from(documents).where(eq(documents.projectId, projectId)),
  notes: await db.select().from(notes).where(eq(notes.projectId, projectId)),
});

describe.skipIf(!run)('session integrity loader (integration)', () => {
  afterAll(async () => {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await getSql().end();
  });

  it('reports every seeded anomaly, skips the exclusions, and writes nothing', async () => {
    const A = await newCourse('a');
    const B = await newCourse('b');
    const C = await newCourse('c', 'archived');
    const pid = A.id;

    const l1 = await newSession(pid, 'lecture', 1, 'Threads');
    const l1b = await newSession(pid, 'lecture', 1, 'Locks');
    const l2 = await newSession(pid, 'lecture', 2, 'Memory');
    const l3 = await newSession(pid, 'lecture', 3, 'Sync');
    const l6 = await newSession(pid, 'lecture', 6, '');
    const l4 = await newSession(pid, 'lecture', 4, 'Paging');
    await newDoc(pid, 'Lecture 1 — Threads', { originalName: 'Lecture 1 - Threads.pptx', sessionId: l1.id });
    const b1 = await newDoc(pid, 'Lecture 3 — Sync', { sessionId: l2.id });
    await newDoc(pid, 'Lecture 4 — Paging', { originalName: 'Lecture 4 - Paging.pptx', sessionId: l4.id });
    const c2 = await newDoc(pid, 'Lecture 4 — Paging', {
      originalName: 'Lecture 4 - TLB.pptx',
      sessionId: l4.id,
    });
    await db
      .insert(notes)
      .values({ projectId: pid, title: 'n1', slug: 'n1', body: 'hello', sessionId: l3.id });
    await db
      .insert(notes)
      .values({ projectId: pid, title: 'n2', slug: 'n2', body: '  \n ', sessionId: l6.id });

    const e1 = await newDoc(pid, 'Course overview');
    const e2 = await newDoc(pid, 'Recitation 2 - Graphs');
    const e3 = await newDoc(pid, 'Lecture 9 - sheet');
    await newDoc(pid, 'Lecture 8 - exam', { examMeta: {} });
    const [practice] = await db
      .insert(folders)
      .values({ projectId: pid, name: 'Practice exams', builtin: 'practice_exams' })
      .returning();
    await newDoc(pid, 'Lecture 7 - midterm', { folderId: practice?.id });
    const e6 = await newDoc(pid, 'misc');
    await db.insert(assignments).values({ projectId: pid, title: 'hw', sheetDocumentId: e3.id });

    const lemida = (documentId: string, over: Partial<typeof lemidaFiles.$inferInsert>) =>
      db.insert(lemidaFiles).values({
        projectId: pid,
        fileName: 'f.pdf',
        sha256: randomUUID(),
        status: 'imported',
        placement: { documentId },
        ...over,
      });
    await lemida(e1.id, { detectedKind: 'lecture', sectionTitle: 'הרצאות' });
    await lemida(e2.id, { detectedKind: 'lecture', status: 'duplicate' });
    await lemida(e6.id, { detectedKind: 'lecture', correctedKind: 'homework' });

    const bs = await newSession(B.id, 'lecture', 1, 'Threads');
    await newDoc(B.id, 'Lecture 1 — Threads', { sessionId: bs.id });
    await newSession(C.id, 'lecture', 1, 'Threads');
    await newSession(C.id, 'lecture', 1, 'Threads');

    const before = await snapshot(pid);
    const report = await loadSessionIntegrity(pid);
    const ids = report.anomalies.map((a) => a.id).sort();
    expect(ids).toEqual(
      [
        'duplicate_number:lecture:1',
        `file_number_mismatch:${b1.id}`,
        `title_from_other_file:${b1.id}`,
        `title_from_other_file:${c2.id}`,
        `unnumbered_deck:${e1.id}`,
        `unnumbered_deck:${e2.id}`,
        `empty_session:${l1b.id}`,
        `empty_session:${l6.id}`,
      ].sort(),
    );
    expect(report.anomalies.find((a) => a.id === `title_from_other_file:${b1.id}`)).toMatchObject({
      sources: [{ displayTitle: 'Lecture 3 — Sync' }],
    });

    expect((await loadSessionIntegrity(B.id)).anomalies).toEqual([]);
    expect((await loadIntegrityInputs([])).size).toBe(0);

    const summaries = await courseIntegritySummaries();
    const a = summaries.find((s) => s.projectId === A.id);
    const b = summaries.find((s) => s.projectId === B.id);
    const c = summaries.find((s) => s.projectId === C.id);
    expect(a).toMatchObject({ problems: 6, duplicates: 1, notices: 2, archived: false });
    expect(a?.href).toBe(`/c/${A.slug}/settings#session-check`);
    expect(b).toMatchObject({ problems: 0, notices: 0, duplicates: 0 });
    expect(c).toMatchObject({ archived: true, duplicates: 1 });

    expect(await snapshot(pid)).toEqual(before);
  });
});
