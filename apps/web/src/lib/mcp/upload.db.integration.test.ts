// @vitest-environment node
// The MCP markdown-upload idempotency queries against a real, migrated Postgres. Opt-in, like the other
// db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to a run-unique project and is deleted afterwards (the project cascade).
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { documents, notes, type Project, projects } from '@/db/schema';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];

async function newProject(): Promise<Project> {
  const [p] = await db
    .insert(projects)
    .values({ slug: `mcp-upload-${RUN}-${projectIds.length}`, name: 'it', kind: 'course' })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}

describe.skipIf(!run)('MCP upload idempotency queries (integration)', () => {
  afterAll(async () => {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await getSql().end();
  });

  it('findNoteByTitle is case-insensitive and project-scoped', async () => {
    const { findNoteByTitle } = await import('./upload-store');
    const p = await newProject();
    const other = await newProject();
    const [n] = await db
      .insert(notes)
      .values({ projectId: p.id, title: 'Heap Sort', slug: 'heap-sort', body: 'b' })
      .returning();
    expect((await findNoteByTitle(p.id, 'heap sort'))?.id).toBe(n?.id);
    expect(await findNoteByTitle(other.id, 'heap sort')).toBeUndefined();
  });

  it('findMarkdownDoc matches only an exact title and body', async () => {
    const { findMarkdownDoc } = await import('./upload-store');
    const p = await newProject();
    const [d] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'markdown', title: 'T', markdownBody: 'body' })
      .returning();
    expect((await findMarkdownDoc(p.id, 'T', 'body'))?.id).toBe(d?.id);
    expect(await findMarkdownDoc(p.id, 'T', 'body2')).toBeUndefined();
    expect(await findMarkdownDoc(p.id, 't', 'body')).toBeUndefined();
  });
});
