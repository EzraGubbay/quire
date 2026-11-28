// @vitest-environment node
// The jobs queue against a real, migrated Postgres. Opt-in so `pnpm test` never needs a database:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run src/core/jobs
// Every row belongs to this run (type `it-<RUN>-…`) and is deleted afterwards; it never truncates.
import { afterAll, describe, expect, it } from 'vitest';
import { getSql } from '@/db/client';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;

afterAll(async () => {
  if (run) await getSql().end();
});

describe.skipIf(!run)('jobs queue (real Postgres)', () => {
  it('migration shape: 14 columns, partial unique dedupe index, claim index', async () => {
    const q = getSql();
    const idx = await q<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where tablename = 'jobs'`;
    const dedupe = idx.find((i) => i.indexname === 'jobs_dedupe_live_uq');
    expect(dedupe?.indexdef).toContain('UNIQUE');
    expect(dedupe?.indexdef).toContain('WHERE');
    expect(idx.some((i) => i.indexname === 'jobs_claim_idx')).toBe(true);
    const cols = await q<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'jobs'`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      [
        'id',
        'type',
        'dedupe_key',
        'payload',
        'status',
        'attempts',
        'max_attempts',
        'run_after',
        'lease_until',
        'locked_by',
        'last_error',
        'created_at',
        'updated_at',
        'finished_at',
      ].sort(),
    );
  });
});
