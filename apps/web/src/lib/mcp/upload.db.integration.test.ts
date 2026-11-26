// @vitest-environment node
// The MCP markdown-upload idempotency queries against a real, migrated Postgres. Opt-in, like the other
// db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to a run-unique project and is deleted afterwards (the project cascade).
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { documents, notes, type Project, projects } from '@/db/schema';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];
let tmp = '';
const sha = async (b: Uint8Array) => (await import('@/lib/files')).sha256(b);

async function newProject(kind: 'course' | 'research' = 'course'): Promise<Project> {
  const [p] = await db
    .insert(projects)
    .values({ slug: `mcp-upload-${RUN}-${projectIds.length}`, name: 'it', kind })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}

describe.skipIf(!run)('MCP upload idempotency queries (integration)', () => {
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'quire-mcp-it-'));
    process.env.FILES_DIR = tmp;
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await getSql().end();
  });

  it('findDuplicatePdf matches on content_hash', async () => {
    const { findDuplicatePdf } = await import('./upload-store');
    const p = await newProject();
    const bytes = new TextEncoder().encode(`%PDF-1.7 ${randomUUID()}`);
    const hash = await sha(bytes);
    const [d] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'pdf', title: 'a', contentHash: hash, fileSize: bytes.length })
      .returning();
    expect((await findDuplicatePdf(p.id, hash, bytes.length))?.id).toBe(d?.id);
    expect(await findDuplicatePdf(p.id, 'f'.repeat(64), bytes.length)).toBeUndefined();
  });

  it('findDuplicatePdf backfills an unhashed same-size row and ignores other sizes', async () => {
    const { findDuplicatePdf } = await import('./upload-store');
    const p = await newProject();
    const bytes = new TextEncoder().encode(`%PDF-1.7 ${randomUUID()}`);
    const rel = `${p.id}/hand.pdf`;
    await mkdir(path.join(tmp, p.id), { recursive: true });
    await writeFile(path.join(tmp, rel), bytes);
    const [same] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'pdf', title: 'hand', filePath: rel, fileSize: bytes.length })
      .returning();
    await db.insert(documents).values({
      projectId: p.id,
      kind: 'pdf',
      title: 'other',
      filePath: `${p.id}/missing.pdf`,
      fileSize: bytes.length + 5,
    });
    const hash = await sha(bytes);
    expect((await findDuplicatePdf(p.id, hash, bytes.length))?.id).toBe(same?.id);
    const [after] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, same?.id ?? ''));
    expect(after?.contentHash).toBe(hash);
    expect(await findDuplicatePdf(p.id, 'e'.repeat(64), bytes.length + 5)).toBeUndefined();
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

  it('research-scope markdown ingest creates a row and dedupes like a course', async () => {
    const { ingestMarkdown } = await import('./upload');
    const { RESEARCH_SCOPE } = await import('./scope');
    const p = await newProject('research');
    const a = { section: 'documents', title: 'RT', body: 'body', folder: { id: null, name: null } } as const;
    const first = await ingestMarkdown(p, a, RESEARCH_SCOPE);
    expect(first.status).toBe('created');
    expect(first.project?.slug).toBe(p.slug);
    const second = await ingestMarkdown(p, a, RESEARCH_SCOPE);
    expect(second.status).toBe('duplicate');
    expect(second.fileId).toBe(first.fileId);
  });

  it('findPaperByRef matches arXiv base id across versions and DOI case, project-scoped', async () => {
    const { findPaperByRef } = await import('./upload-store');
    const p = await newProject('research');
    const other = await newProject('research');
    const [a] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'pdf', title: 'a', arxivId: '1706.03762v5' })
      .returning();
    const [b] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'pdf', title: 'b', doi: '10.1000/ABC' })
      .returning();
    expect((await findPaperByRef(p.id, { arxivId: '1706.03762' }))?.id).toBe(a?.id);
    expect((await findPaperByRef(p.id, { arxivId: '1706.03762v9' }))?.id).toBe(a?.id);
    expect((await findPaperByRef(p.id, { doi: '10.1000/abc' }))?.id).toBe(b?.id);
    expect(await findPaperByRef(p.id, { arxivId: '1706.0376' })).toBeUndefined();
    expect(await findPaperByRef(other.id, { arxivId: '1706.03762' })).toBeUndefined();
    expect(await findPaperByRef(p.id, {})).toBeUndefined();
  });
});
