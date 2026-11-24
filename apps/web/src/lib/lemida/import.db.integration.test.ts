// @vitest-environment node
// importLemidaFile's retry/concurrency semantics against a real, migrated Postgres. Opt-in, like the other
// db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to run-unique projects and is deleted afterwards (the project cascade); never truncates.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSql } from '@/db/client';
import { documents, type LemidaFile, lemidaFiles, type Project, projects } from '@/db/schema';

vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));
vi.mock('@/lib/mobile/push/triggers', () => ({ notifyFilesAdded: vi.fn(async () => {}) }));
vi.mock('./classify', async (orig) => ({
  ...(await orig<typeof import('./classify')>()),
  classifyLemidaFile: vi.fn(() => ({ kind: 'other', title: 'Notes', confidence: 1, rule: 'r' })),
}));
vi.mock('@/lib/documents', async (orig) => ({
  ...(await orig<typeof import('@/lib/documents')>()),
  createDeckDocument: vi.fn(),
}));

import { createDeckDocument } from '@/lib/documents';
import { sha256 } from '@/lib/files';
import { importLemidaFile } from './import';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const meta = { fileName: 'x.pdf' };

async function newProject(): Promise<Project> {
  const [p] = await db
    .insert(projects)
    .values({ slug: `lemida-retry-${RUN}-${projectIds.length}`, name: 'it', kind: 'course' })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}
const newBytes = () => new TextEncoder().encode(randomUUID());
const rowsFor = (projectId: string, hash: string): Promise<LemidaFile[]> =>
  db
    .select()
    .from(lemidaFiles)
    .where(and(eq(lemidaFiles.projectId, projectId), eq(lemidaFiles.sha256, hash)));
const docsFor = (projectId: string) => db.select().from(documents).where(eq(documents.projectId, projectId));
async function seedError(projectId: string, hash: string): Promise<LemidaFile> {
  const [row] = await db
    .insert(lemidaFiles)
    .values({ projectId, fileName: 'x.pdf', sha256: hash, status: 'error', error: 'boom' })
    .returning();
  if (!row) throw new Error('no row');
  return row;
}

describe.skipIf(!run)('importLemidaFile retry (integration)', () => {
  beforeEach(() => {
    vi.mocked(createDeckDocument).mockReset();
    // Inserts a real documents row; the delay lets concurrent imports interleave.
    vi.mocked(createDeckDocument).mockImplementation((async (projectId: string) => {
      await new Promise((r) => setTimeout(r, 30));
      const [d] = await db.insert(documents).values({ projectId, kind: 'pdf', title: 'it' }).returning();
      return { ...d, filePath: null };
    }) as never);
  });
  afterAll(async () => {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    await getSql().end();
  });

  it('first import ok', async () => {
    const p = await newProject();
    const data = newBytes();
    const r = await importLemidaFile(p, meta, data);
    const rows = await rowsFor(p.id, sha256(data));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'imported', error: null });
    expect(r).toMatchObject({ duplicate: false, error: null });
    expect(await docsFor(p.id)).toHaveLength(1);
  });

  it('a duplicate of an ok hash is not re-imported', async () => {
    const p = await newProject();
    const data = newBytes();
    const a = await importLemidaFile(p, meta, data);
    const b = await importLemidaFile(p, meta, data);
    expect(b).toMatchObject({ duplicate: true, lemidaFileId: a.lemidaFileId });
    expect(await rowsFor(p.id, sha256(data))).toHaveLength(1);
    expect(await docsFor(p.id)).toHaveLength(1);
  });

  it('an error row is retried in place', async () => {
    const p = await newProject();
    const data = newBytes();
    const seeded = await seedError(p.id, sha256(data));
    const r = await importLemidaFile(p, meta, data);
    const rows = await rowsFor(p.id, sha256(data));
    expect(rows).toHaveLength(1);
    const row = rows[0] as LemidaFile;
    expect(row.id).toBe(seeded.id);
    expect(row).toMatchObject({ status: 'imported', error: null });
    expect(row.placement.documentId).toBeTruthy();
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(seeded.updatedAt.getTime());
    expect(r.lemidaFileId).toBe(seeded.id);
  });

  it('a retry that fails again keeps one error row with the new text', async () => {
    const p = await newProject();
    const data = newBytes();
    const seeded = await seedError(p.id, sha256(data));
    vi.mocked(createDeckDocument).mockRejectedValueOnce(new Error('again'));
    const r = await importLemidaFile(p, meta, data);
    const rows = await rowsFor(p.id, sha256(data));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: seeded.id, status: 'error', error: 'again' });
    expect(r).toMatchObject({ status: 'error', error: 'again' });
    expect(await docsFor(p.id)).toHaveLength(0);
  });

  const expectOneWinner = async (
    p: Project,
    hash: string,
    results: { duplicate: boolean; lemidaFileId: string }[],
  ) => {
    const rows = await rowsFor(p.id, hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe('error');
    expect(results.filter((x) => !x.duplicate)).toHaveLength(1);
    expect(results.filter((x) => x.duplicate)).toHaveLength(1);
    expect(new Set(results.map((x) => x.lemidaFileId)).size).toBe(1);
    expect(await docsFor(p.id)).toHaveLength(1);
  };

  it('concurrent retries of an error row end with one row', async () => {
    const p = await newProject();
    const data = newBytes();
    await seedError(p.id, sha256(data));
    const results = await Promise.all([importLemidaFile(p, meta, data), importLemidaFile(p, meta, data)]);
    await expectOneWinner(p, sha256(data), results);
  });

  it('concurrent first imports end with one row', async () => {
    const p = await newProject();
    const data = newBytes();
    const results = await Promise.all([importLemidaFile(p, meta, data), importLemidaFile(p, meta, data)]);
    await expectOneWinner(p, sha256(data), results);
  });

  it('an error row plus a leftover twin document resolves as duplicate', async () => {
    const p = await newProject();
    const data = newBytes();
    const hash = sha256(data);
    const seeded = await seedError(p.id, hash);
    const [twin] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'pdf', title: 'old', contentHash: hash })
      .returning();
    const r = await importLemidaFile(p, meta, data);
    expect(r).toMatchObject({ status: 'duplicate', duplicate: true, lemidaFileId: seeded.id });
    const rows = await rowsFor(p.id, hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.placement.documentId).toBe(twin?.id);
    expect(await docsFor(p.id)).toHaveLength(1);
    expect(createDeckDocument).not.toHaveBeenCalled();
  });
});
