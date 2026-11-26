// @vitest-environment node
// The mobile upload job store against a real, migrated Postgres. Opt-in, like db.integration.test.ts:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to a run-unique owner/project and is deleted afterwards; it never truncates.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { mobileUploadJobs, projects } from '@/db/schema';
import { createNote } from '@/lib/notes';
import { createOrGetJob, getOwnedJob, jobStore } from './uploads-store';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const OWNER = `upl-${RUN}`;
const projectIds: string[] = [];

async function course() {
  const [p] = await db
    .insert(projects)
    .values({ slug: `upl-${RUN}-${projectIds.length}`, name: 'it', kind: 'course', status: 'active' })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}

const pdf = {
  bytes: new Uint8Array([1, 2, 3]),
  target: 'document' as const,
  contentType: 'application/pdf',
  fileName: 'a.pdf',
};
const md = {
  bytes: new Uint8Array([35, 32, 104]),
  target: 'note' as const,
  contentType: 'text/markdown',
  fileName: 'n.md',
};

afterAll(async () => {
  if (!run) return;
  // Deleting the projects cascades to their jobs and notes.
  for (const id of projectIds) await db.delete(projects).where(eq(projects.id, id));
  await db.delete(mobileUploadJobs).where(eq(mobileUploadJobs.ownerLogin, OWNER));
  await getSql().end();
});

describe.skipIf(!run)('mobile upload job store (Postgres)', () => {
  it('returns the same job for the same key and keeps the first target', async () => {
    const c = await course();
    const first = await createOrGetJob(OWNER, c.id, 'k1', pdf);
    const again = await createOrGetJob(OWNER, c.id, 'k1', md);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.target).toBe('document');
    expect(again.job.fileName).toBe('a.pdf');
  });

  it('stores note_id on a note job and clears its data', async () => {
    const c = await course();
    const { job } = await createOrGetJob(OWNER, c.id, 'k2', md);
    expect(job).toMatchObject({ target: 'note', contentType: 'text/markdown', fileName: 'n.md' });
    const note = await createNote(c.id, 'n', '# h');
    await jobStore.setDone(job.id, { noteId: note.id });
    const done = await getOwnedJob(OWNER, job.id);
    expect(done).toMatchObject({ status: 'done', data: null, fileId: null, noteId: note.id });
  });

  it('defaults a pre-1.2 style insert to a PDF document job', async () => {
    const c = await course();
    const [row] = await db
      .insert(mobileUploadJobs)
      .values({ ownerLogin: OWNER, courseId: c.id, idempotencyKey: 'legacy' })
      .returning();
    expect(row).toMatchObject({ target: 'document', contentType: 'application/pdf', fileName: null });
  });
});
