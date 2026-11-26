// @vitest-environment node
// findDocsByHashes against a real, migrated Postgres. Opt-in, like the other db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { documents, projects } from '@/db/schema';
import { findDocsByHashes } from './store';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];

async function newProject(kind: 'course' | 'research') {
  const [p] = await db
    .insert(projects)
    .values({ slug: `drive-${RUN}-${projectIds.length}`, name: 'it', kind })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}

describe.skipIf(!run)('findDocsByHashes (integration)', () => {
  afterAll(async () => {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await getSql().end();
  });

  it('finds course documents by content_hash, ignores research projects, and handles an empty list', async () => {
    expect(await findDocsByHashes([])).toEqual([]);
    const course = await newProject('course');
    const research = await newProject('research');
    const h1 = `${RUN}${'a'.repeat(56)}`;
    const h2 = `${RUN}${'b'.repeat(56)}`;
    await db.insert(documents).values([
      { projectId: course.id, kind: 'pdf', title: 'in course', contentHash: h1 },
      { projectId: research.id, kind: 'pdf', title: 'in research', contentHash: h2 },
    ]);
    const hits = await findDocsByHashes([h1, h2, 'f'.repeat(64)]);
    expect(hits.map((h) => [h.hash, h.projectSlug, h.title])).toEqual([[h1, course.slug, 'in course']]);
  });
});
