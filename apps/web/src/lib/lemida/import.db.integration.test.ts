// @vitest-environment node
// importLemidaFile's retry/concurrency semantics against a real, migrated Postgres. Opt-in, like the other
// db.integration tests:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Every row belongs to run-unique projects and is deleted afterwards (the project cascade); never truncates.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSql } from '@/db/client';
import { documents, type LemidaFile, lemidaFiles, type Project, projects, sessions } from '@/db/schema';

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
  deleteDocument: vi.fn(),
}));
vi.mock('@/lib/homework', async (orig) => ({
  ...(await orig<typeof import('@/lib/homework')>()),
  updateAssignment: vi.fn(),
}));

import { createDeckDocument, deleteDocument } from '@/lib/documents';
import { sha256 } from '@/lib/files';
import { updateAssignment } from '@/lib/homework';
import { classifyLemidaFile } from './classify';
import { importLemidaFile } from './import';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const meta = { fileName: 'x.pdf' };

// The shared connection closes once, after every describe in this file has finished.
afterAll(async () => {
  await getSql().end();
});

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
  beforeEach(async () => {
    const realDelete = (await vi.importActual<typeof import('@/lib/documents')>('@/lib/documents'))
      .deleteDocument;
    const realUpdate = (await vi.importActual<typeof import('@/lib/homework')>('@/lib/homework'))
      .updateAssignment;
    vi.mocked(deleteDocument).mockReset();
    vi.mocked(deleteDocument).mockImplementation(realDelete);
    vi.mocked(updateAssignment).mockReset();
    vi.mocked(updateAssignment).mockImplementation(realUpdate);
    vi.mocked(classifyLemidaFile).mockReturnValue({
      kind: 'other',
      title: 'Notes',
      confidence: 1,
      rule: 'r',
    } as never);
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
  // #66: the catch-path twin race. A fails after creating its document (post-create failure on the homework
  // path); B (same bytes) twin-matches that in-flight document. Either interleaving must leave a retryable error.
  const TWIN_GONE = 'the matching document was deleted during import; will retry';
  const asHomework = () =>
    vi
      .mocked(classifyLemidaFile)
      .mockReturnValue({ kind: 'homework', title: 'HW', confidence: 1, rule: 'r' } as never);
  const expectHealsOnRetry = async (p: Project, data: Uint8Array) => {
    vi.mocked(classifyLemidaFile).mockReturnValue({
      kind: 'other',
      title: 'Notes',
      confidence: 1,
      rule: 'r',
    } as never);
    const r = await importLemidaFile(p, meta, data);
    expect(r).toMatchObject({ status: 'imported', duplicate: false });
    const rows = await rowsFor(p.id, sha256(data));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'imported', error: null });
    const docs = await docsFor(p.id);
    expect(docs.map((d) => d.id)).toContain(rows[0]?.placement.documentId);
  };

  it('8: A deletes its document after B adopted it as a twin: the row ends as a retryable error', async () => {
    const p = await newProject();
    const data = newBytes();
    const hash = sha256(data);
    asHomework();
    vi.mocked(updateAssignment).mockRejectedValue(new Error('db hiccup'));
    const realDelete = (await vi.importActual<typeof import('@/lib/documents')>('@/lib/documents'))
      .deleteDocument;
    let atDelete!: () => void;
    const reachedDelete = new Promise<void>((r) => {
      atDelete = r;
    });
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });
    vi.mocked(deleteDocument).mockImplementationOnce((async (...args: Parameters<typeof realDelete>) => {
      atDelete();
      await gate;
      return realDelete(...args);
    }) as never);

    const aPromise = importLemidaFile(p, meta, data);
    await reachedDelete; // A's error row exists; its document still exists with the hash.
    const b = await importLemidaFile(p, meta, data); // B twin-matches A's in-flight document.
    expect(b).toMatchObject({ status: 'duplicate', duplicate: true });
    releaseA();
    const a = await aPromise;

    expect(a).toMatchObject({ status: 'error' });
    const rows = await rowsFor(p.id, hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.placement.documentId).toBeUndefined();
    expect(await docsFor(p.id)).toHaveLength(0);

    vi.mocked(updateAssignment).mockReset();
    await expectHealsOnRetry(p, data);
  });

  it('9: B adopts a twin that A already deleted: B detects it and resets the row', async () => {
    const p = await newProject();
    const data = newBytes();
    const hash = sha256(data);
    const seeded = await seedError(p.id, hash);
    const [d] = await db
      .insert(documents)
      .values({ projectId: p.id, kind: 'pdf', title: 'in-flight', contentHash: hash })
      .returning();
    if (!d) throw new Error('no doc');

    // Hold a row lock on the error row so B blocks inside its upsert, after its twin select saw the document.
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((r) => {
      releaseLock = r;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => {
      markLocked = r;
    });
    let lockerPid = 0;
    const locker = db.transaction(async (tx) => {
      const pidRows = await tx.execute(sql`select pg_backend_pid() as pid`);
      lockerPid = Number((pidRows[0] as { pid: number }).pid);
      await tx.execute(sql`select 1 from lemida_files where id = ${seeded.id} for update`);
      markLocked();
      await lockGate;
    });
    locker.catch(() => markLocked()); // a failed lock attempt must not hang the test

    try {
      await locked;
      const bPromise = importLemidaFile(p, meta, data);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const res = await db.execute(
          sql`select count(*)::int as n from pg_stat_activity where ${lockerPid}::int = any(pg_blocking_pids(pid))`,
        );
        blocked = Number((res[0] as { n: number }).n) >= 1;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);

      // A's delete lands while B is blocked (A's release would have been a no-op: the row has no documentId yet).
      const realDelete = (await vi.importActual<typeof import('@/lib/documents')>('@/lib/documents'))
        .deleteDocument;
      await realDelete(p.id, d.id);
      releaseLock();
      await locker;
      const b = await bPromise;

      expect(b).toMatchObject({ status: 'error', duplicate: false, error: TWIN_GONE });
      const rows = await rowsFor(p.id, hash);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('error');
      expect(rows[0]?.placement.documentId).toBeUndefined();
      expect(await docsFor(p.id)).toHaveLength(0);
    } finally {
      releaseLock();
      await locker.catch(() => {});
    }

    await expectHealsOnRetry(p, data);
  });
});

describe.skipIf(!run)('importLemidaFile session placement (integration)', () => {
  const asLecture = (number: number | undefined, title?: string) =>
    vi
      .mocked(classifyLemidaFile)
      .mockReturnValue({ kind: 'lecture', number, title, confidence: 1, rule: 'r' } as never);
  const sessionsFor = (projectId: string) =>
    db.select().from(sessions).where(eq(sessions.projectId, projectId));

  beforeEach(() => {
    vi.mocked(createDeckDocument).mockReset();
    vi.mocked(createDeckDocument).mockImplementation((async (
      projectId: string,
      upload: { sessionId?: string | null; title?: string },
    ) => {
      const [d] = await db
        .insert(documents)
        .values({
          projectId,
          kind: 'pdf',
          title: upload.title ?? 'it',
          sessionId: upload.sessionId ?? null,
        })
        .returning();
      return { ...d, filePath: null };
    }) as never);
  });

  it('a lecture with no number creates no session and stays unattached', async () => {
    const p = await newProject();
    asLecture(undefined);
    const first = newBytes();
    await importLemidaFile(p, { fileName: 'Course overview.pdf' }, first);
    await importLemidaFile(p, { fileName: 'Course overview.pdf' }, newBytes());
    expect(await sessionsFor(p.id)).toHaveLength(0);
    const docs = await docsFor(p.id);
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.sessionId === null && d.title === 'Course overview')).toBe(true);
    const [row] = await rowsFor(p.id, sha256(first));
    expect(row?.status).toBe('imported');
    expect(row?.placement.sessionId).toBeUndefined();
    expect(row?.placement.documentId).toBeTruthy();
  });

  it('a numbered lecture attaches to the existing session and titles the deck from its file name', async () => {
    const p = await newProject();
    const [seeded] = await db
      .insert(sessions)
      .values({ projectId: p.id, kind: 'lecture', number: 3, title: '' })
      .returning();
    asLecture(3, 'Locks');
    await importLemidaFile(p, { fileName: 'Lecture 3 - Locks.pdf' }, newBytes());
    expect(await sessionsFor(p.id)).toHaveLength(1);
    const [doc] = await docsFor(p.id);
    expect(doc?.sessionId).toBe(seeded?.id);
    expect(doc?.title).toBe('Lecture 3 - Locks');
  });

  it('a numbered lecture with no session creates it', async () => {
    const p = await newProject();
    asLecture(4, 'Heaps');
    await importLemidaFile(p, { fileName: 'Lecture 4 - Heaps.pdf' }, newBytes());
    const all = await sessionsFor(p.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'lecture', number: 4 });
    const [doc] = await docsFor(p.id);
    expect(doc?.sessionId).toBe(all[0]?.id);
  });
});
