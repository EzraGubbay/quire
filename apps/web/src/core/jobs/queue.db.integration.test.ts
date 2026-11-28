// @vitest-environment node
// The jobs queue against a real, migrated Postgres. Opt-in so `pnpm test` never needs a database:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run src/core/jobs
// Every row belongs to this run (type `it-<RUN>-…`) and is deleted afterwards; it never truncates, and
// claimers only ever ask for this run's types, so no other row is touched.
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { db, getSql } from '@/db/client';
import { jobs, settings } from '@/db/schema';
import { jobsPaused, setJobsPaused } from './pause';
import { jobQueue } from './queue';
import { createJobWorker } from './worker';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const type = (name: string) => `it-${RUN}-${name}`;
const key = (name: string) => `it-${RUN}-key-${name}`;
const q = jobQueue(db);
const row = async (id: string) => {
  const [r] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!r) throw new Error(`no job ${id}`);
  return r;
};
const expire = (id: string) =>
  db.execute(sql`update jobs set lease_until = now() - interval '1 second' where id = ${id}`);
const dbNow = async () => {
  const [r] = await getSql()<{ n: string }[]>`select now() as n`;
  return new Date(r?.n ?? 0).getTime();
};

afterEach(async () => {
  if (run) await db.execute(sql`delete from jobs where type like ${`it-${RUN}-%`}`);
});
afterAll(async () => {
  if (run) await getSql().end();
});

describe.skipIf(!run)('jobs queue (real Postgres)', () => {
  it('migration shape: 14 columns, partial unique dedupe index, claim index', async () => {
    const s = getSql();
    const idx = await s<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where tablename = 'jobs'`;
    const dedupe = idx.find((i) => i.indexname === 'jobs_dedupe_live_uq');
    expect(dedupe?.indexdef).toContain('UNIQUE');
    expect(dedupe?.indexdef).toContain('WHERE');
    expect(idx.some((i) => i.indexname === 'jobs_claim_idx')).toBe(true);
    const cols = await s<{ column_name: string }[]>`
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

  it('enqueue defaults', async () => {
    const { id, created } = await q.enqueue(type('defaults'), { a: 1 });
    expect(created).toBe(true);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 5, payload: { a: 1 } });
    expect(Math.abs(r.runAfter.getTime() - (await dbNow()))).toBeLessThan(5_000);
  });

  it('dedupe: live holders block, finished ones do not, no key never dedupes', async () => {
    const t = type('dedupe');
    const a = await q.enqueue(t, {}, { dedupeKey: key('d') });
    const b = await q.enqueue(t, {}, { dedupeKey: key('d') });
    expect(b).toEqual({ id: a.id, created: false });
    expect(
      await db
        .select()
        .from(jobs)
        .where(eq(jobs.dedupeKey, key('d'))),
    ).toHaveLength(1);

    const claimed = await q.claimNext('w1', [t]);
    expect(claimed?.id).toBe(a.id);
    await q.fail(claimed!, 'w1', new Error('x'));
    expect((await row(a.id)).status).toBe('failed');
    expect(await q.enqueue(t, {}, { dedupeKey: key('d') })).toEqual({ id: a.id, created: false });

    await db.execute(sql`update jobs set run_after = now() where id = ${a.id}`);
    const again = await q.claimNext('w1', [t]);
    await q.complete(again!.id, 'w1');
    const c = await q.enqueue(t, {}, { dedupeKey: key('d') });
    expect(c.created).toBe(true);
    expect(c.id).not.toBe(a.id);

    const n1 = await q.enqueue(t, {});
    const n2 = await q.enqueue(t, {});
    expect(n1.id).not.toBe(n2.id);
  });

  it('a future run_after is not claimable', async () => {
    const t = type('future');
    await q.enqueue(t, {}, { runAfter: new Date(Date.now() + 3_600_000) });
    expect(await q.claimNext('w1', [t])).toBeUndefined();
  });

  it('only claims the asked-for types; empty types claims nothing', async () => {
    const other = await q.enqueue(type('other'), {});
    expect(await q.claimNext('w1', [type('mine')])).toBeUndefined();
    expect(await q.claimNext('w1', [])).toBeUndefined();
    expect((await row(other.id)).status).toBe('queued');
  });

  it('claim sets running, attempts, owner and lease', async () => {
    const t = type('claim');
    await q.enqueue(t, {});
    const job = await q.claimNext('w1', [t], 60_000);
    expect(job).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'w1' });
    const delta = job!.leaseUntil!.getTime() - (await dbNow());
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThanOrEqual(60_000);
  });

  it('SKIP LOCKED: a row locked by another transaction is skipped, and two claimers never share a job', async () => {
    const t = type('skip');
    const a = await q.enqueue(t, { n: 'A' });
    await db.execute(sql`update jobs set run_after = now() - interval '1 minute' where id = ${a.id}`);
    const b = await q.enqueue(t, { n: 'B' });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from jobs where id = ${a.id} for update`);
      const got = await Promise.race([
        q.claimNext('w2', [t]),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 2_000)),
      ]);
      expect(got).not.toBe('blocked');
      expect((got as { id: string }).id).toBe(b.id);
    });

    const t2 = type('race');
    await q.enqueue(t2, {});
    const results = await Promise.all([q.claimNext('w1', [t2]), q.claimNext('w2', [t2])]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('lease expiry: re-claimable, and the old holder is fenced out', async () => {
    const t = type('lease');
    const { id } = await q.enqueue(t, {});
    await q.claimNext('w1', [t]);
    await expire(id);
    const again = await q.claimNext('w2', [t]);
    expect(again).toMatchObject({ id, attempts: 2, lockedBy: 'w2' });
    expect(await q.complete(id, 'w1')).toBe(false);
    expect(await q.heartbeat(id, 'w1')).toBe(false);
    const before = (await row(id)).leaseUntil!.getTime();
    expect(await q.heartbeat(id, 'w2', 600_000)).toBe(true);
    expect((await row(id)).leaseUntil!.getTime()).toBeGreaterThan(before);
    expect(await q.complete(id, 'w2')).toBe(true);
    const done = await row(id);
    expect(done.status).toBe('done');
    expect(done.finishedAt).not.toBeNull();
  });

  it('fail schedules a backoff retry, then goes dead when attempts run out', async () => {
    const t = type('retry');
    const { id } = await q.enqueue(t, {}, { maxAttempts: 2 });
    const first = await q.claimNext('w1', [t]);
    await q.fail(first!, 'w1', new Error('boom'));
    const failed = await row(id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('boom');
    expect(failed.leaseUntil).toBeNull();
    const wait = failed.runAfter.getTime() - (await dbNow());
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThan(35_000);
    expect(await q.claimNext('w1', [t])).toBeUndefined();

    await db.execute(sql`update jobs set run_after = now() where id = ${id}`);
    const second = await q.claimNext('w1', [t]);
    expect(second?.attempts).toBe(2);
    await q.fail(second!, 'w1', new Error('boom'));
    const dead = await row(id);
    expect(dead.status).toBe('dead');
    expect(dead.finishedAt).not.toBeNull();
    expect(await q.claimNext('w1', [t])).toBeUndefined();
  });

  it('a permanent failure is dead at once', async () => {
    const t = type('perm');
    const { id } = await q.enqueue(t, {});
    const job = await q.claimNext('w1', [t]);
    await q.fail(job!, 'w1', new Error('bad input'), { permanent: true });
    expect((await row(id)).status).toBe('dead');
  });

  it('an expired lease past its attempt budget is marked dead, not re-run', async () => {
    const t = type('budget');
    const { id } = await q.enqueue(t, {}, { maxAttempts: 1 });
    await q.claimNext('w1', [t]);
    await expire(id);
    expect(await q.claimNext('w2', [t])).toBeUndefined();
    expect((await row(id)).status).toBe('dead');
  });

  it('release returns the attempt and makes the job claimable at once', async () => {
    const t = type('release');
    const { id } = await q.enqueue(t, {});
    await q.claimNext('w1', [t]);
    expect(await q.release(id, 'w2')).toBe(false);
    expect(await q.release(id, 'w1')).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'queued', attempts: 0, lockedBy: null });
    expect((await q.claimNext('w1', [t]))?.attempts).toBe(1);
  });

  it('pause flag round-trips and keeps the other settings keys', async () => {
    const [before] = await db.select().from(settings).where(eq(settings.id, 1));
    const snapshot = (before?.data ?? {}) as Record<string, unknown>;
    try {
      await setJobsPaused(db, true);
      expect(await jobsPaused(db)).toBe(true);
      const [mid] = await db.select().from(settings).where(eq(settings.id, 1));
      const { jobs: midJobs, ...rest } = (mid?.data ?? {}) as Record<string, unknown>;
      const { jobs: _prev, ...restBefore } = snapshot;
      expect(rest).toEqual(restBefore);
      expect(midJobs).toMatchObject({ paused: true });
      await setJobsPaused(db, false);
      expect(await jobsPaused(db)).toBe(false);
    } finally {
      if (before) await db.update(settings).set({ data: snapshot }).where(eq(settings.id, 1));
      else await db.delete(settings).where(eq(settings.id, 1));
    }
  });

  it('worker: runs a due job to done, and leaves it queued while paused', async () => {
    const t = type('worker');
    const handler = vi.fn(async () => {});
    const { id } = await q.enqueue(t, { hello: 'world' });
    const worker = createJobWorker({
      queue: q,
      paused: () => jobsPaused(db),
      handlers: new Map([[t, handler]]),
    });
    const [before] = await db.select().from(settings).where(eq(settings.id, 1));
    const snapshot = (before?.data ?? {}) as Record<string, unknown>;
    try {
      await setJobsPaused(db, true);
      expect(await worker.tick()).toBe('paused');
      expect((await row(id)).status).toBe('queued');
      await setJobsPaused(db, false);
      expect(await worker.tick()).toBe('ran');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id, payload: { hello: 'world' } }),
        expect.anything(),
      );
      expect((await row(id)).status).toBe('done');
    } finally {
      if (before) await db.update(settings).set({ data: snapshot }).where(eq(settings.id, 1));
      else await db.delete(settings).where(eq(settings.id, 1));
    }
  });
});
