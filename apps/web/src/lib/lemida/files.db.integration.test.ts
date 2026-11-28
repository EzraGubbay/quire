// @vitest-environment node
// resolveReview against a real, migrated Postgres. Opt-in, like the other db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to run-unique projects and is deleted afterwards (the project cascade); never truncates.
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db, getSql } from '@/db/client';
import { documents, lemidaFiles, type Project, projects, sessions } from '@/db/schema';

vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));

import { resolveReview } from './files';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];

async function newProject(): Promise<Project> {
  const [p] = await db
    .insert(projects)
    .values({ slug: `lemida-review-${RUN}-${projectIds.length}`, name: 'it', kind: 'course' })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}

async function seedReview(projectId: string, fileName: string) {
  const [doc] = await db.insert(documents).values({ projectId, kind: 'pdf', title: 'it' }).returning();
  if (!doc) throw new Error('no doc');
  const [row] = await db
    .insert(lemidaFiles)
    .values({
      projectId,
      fileName,
      sha256: randomUUID(),
      status: 'needs_review',
      placement: { documentId: doc.id },
    })
    .returning();
  if (!row) throw new Error('no row');
  return { doc, row };
}
const sessionsFor = (projectId: string) =>
  db.select().from(sessions).where(eq(sessions.projectId, projectId));
const docById = async (id: string) => (await db.select().from(documents).where(eq(documents.id, id)))[0];
const rowById = async (id: string) => (await db.select().from(lemidaFiles).where(eq(lemidaFiles.id, id)))[0];

describe.skipIf(!run)('resolveReview lecture/recitation (integration)', () => {
  afterAll(async () => {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await getSql().end();
  });

  it('files a name with no number unattached and creates no session', async () => {
    const p = await newProject();
    const { doc, row } = await seedReview(p.id, 'misc-notes.pdf');
    await resolveReview(row.id, 'recitation');
    expect(await sessionsFor(p.id)).toHaveLength(0);
    const d = await docById(doc.id);
    expect(d?.sessionId).toBeNull();
    expect(d?.folderId).toBeNull();
    const r = await rowById(row.id);
    expect(r?.status).toBe('imported');
    expect(r?.correctedKind).toBe('recitation');
    expect(r?.placement.sessionId).toBeUndefined();
  });

  it('creates the numbered session for a name with a leading number', async () => {
    const p = await newProject();
    const { doc, row } = await seedReview(p.id, '07 Memory models.pdf');
    await resolveReview(row.id, 'recitation');
    const all = await sessionsFor(p.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'recitation', number: 7 });
    expect((await docById(doc.id))?.sessionId).toBe(all[0]?.id);
    expect((await rowById(row.id))?.placement.sessionId).toBe(all[0]?.id);
  });

  it('reuses an existing session with that number', async () => {
    const p = await newProject();
    const [seeded] = await db
      .insert(sessions)
      .values({ projectId: p.id, kind: 'recitation', number: 7, title: '' })
      .returning();
    const { doc, row } = await seedReview(p.id, '07 Memory models.pdf');
    await resolveReview(row.id, 'recitation');
    expect(await sessionsFor(p.id)).toHaveLength(1);
    expect((await docById(doc.id))?.sessionId).toBe(seeded?.id);
  });
});
