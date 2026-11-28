// @vitest-environment node
// Golden transcripts of both MCP servers against a seeded, synthetic course and research project, through the
// real SDK over an in-memory transport. Opt-in, like the other db.integration tests, and ONLY against a
// throwaway database (the seed deletes its own rows, but a dev database holding real data must never be used):
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run golden
// Regenerate the goldens with UPDATE_GOLDENS=1 and review the diff: it is the intended behaviour change.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinEnv } from '@/lib/testing/mcp-golden';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const tmp = run ? await mkdtemp(path.join(os.tmpdir(), 'quire-mcp-golden-')) : '';
if (run) {
  process.env.FILES_DIR = tmp;
  pinEnv();
}

type Seed = Awaited<ReturnType<typeof import('@/lib/testing/seed-course')['seedGolden']>>;
let seed: Seed;

describe.skipIf(!run)('MCP golden transcripts (integration)', () => {
  beforeAll(async () => {
    const { seedGolden } = await import('@/lib/testing/seed-course');
    seed = await seedGolden(RUN);
  });
  afterAll(async () => {
    await seed?.cleanup();
    await rm(tmp, { recursive: true, force: true });
    const { getSql } = await import('@/db/client');
    await getSql().end();
  });

  it('seed builds the fixture', async () => {
    const { listCourseFiles } = await import('./courses');
    const { listDocuments } = await import('@/lib/documents');
    const { listNotes } = await import('@/lib/notes');
    const { listSources } = await import('@/lib/sources');
    const { files } = await listCourseFiles(seed.course.id);
    expect(files).toHaveLength(8);
    expect(new Set(files.map((f) => f.type))).toEqual(
      new Set(['lecture', 'recitation', 'exam', 'homework', 'book', 'paper', 'other']),
    );
    expect(await listDocuments(seed.research.id)).toHaveLength(3);
    expect(await listNotes(seed.research.id)).toHaveLength(1);
    expect(await listSources(seed.research.id)).toHaveLength(1);
  });
});
