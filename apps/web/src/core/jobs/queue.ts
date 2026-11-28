// Durable job queue over the `jobs` table (ADR 0001, decision 6). Pure data access: no Next, no timers.
// Every time (lease, run_after, finished_at) is the database clock, never the app clock. Every outcome
// write (heartbeat, complete, fail, release) is fenced by `locked_by`: a worker whose lease expired and
// was re-claimed by another cannot overwrite the new holder's result.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { type Job, jobs } from '@/db/schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** The plain handle or a transaction, so a caller can enqueue atomically with its own writes. */
export type JobsExecutor = Db | Tx;

export const LEASE_MS = 5 * 60_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const LIVE_STATUSES = ['queued', 'running', 'failed'] as const;
const MAX_ERROR_CHARS = 2_000;
const MAX_EXHAUSTED_SKIPS = 10;

/** Delay before the retry that follows attempt number `attempts` (1-based): min(30 s * 2^(attempts-1), 1 h). */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30), BACKOFF_MAX_MS);
}

/** Thrown by a handler for an error that retrying cannot fix (bad input): the job goes straight to dead. */
export class PermanentJobError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface EnqueueOptions {
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
}

const live = sql`${jobs.status} in ('queued', 'running', 'failed')`;

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string } | undefined;
  return `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`.slice(0, MAX_ERROR_CHARS);
}

export function jobQueue(db: JobsExecutor) {
  const fence = (id: string, workerId: string) =>
    and(eq(jobs.id, id), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId));
  const cleared = { leaseUntil: null, lockedBy: null, updatedAt: sql`now()` } as const;

  async function insert(type: string, payload: unknown, opts: EnqueueOptions) {
    const values = {
      type,
      payload,
      dedupeKey: opts.dedupeKey,
      ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    };
    const q = db.insert(jobs).values(values);
    const rows = opts.dedupeKey
      ? await q.onConflictDoNothing({ target: jobs.dedupeKey, where: live }).returning({ id: jobs.id })
      : await q.returning({ id: jobs.id });
    return rows[0]?.id;
  }

  return {
    /** Insert; with a dedupeKey that a live job holds, a no-op returning that job's id (`created: false`). */
    async enqueue(
      type: string,
      payload: unknown,
      opts: EnqueueOptions = {},
    ): Promise<{ id: string; created: boolean }> {
      for (let attempt = 0; attempt < 2; attempt++) {
        const id = await insert(type, payload, opts);
        if (id) return { id, created: true };
        const [held] = await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, opts.dedupeKey as string), live))
          .limit(1);
        if (held) return { id: held.id, created: false };
        // The live holder finished between the insert and the lookup: try the insert once more.
      }
      throw new Error('enqueue: dedupe conflict could not be resolved');
    },

    /** Claim the oldest due job of `types` (or one whose lease expired) for `workerId`; undefined when none. */
    async claimNext(
      workerId: string,
      types: readonly string[],
      leaseMs = LEASE_MS,
    ): Promise<Job | undefined> {
      if (types.length === 0) return undefined;
      const typeList = sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      );
      for (let i = 0; i < MAX_EXHAUSTED_SKIPS; i++) {
        const claimed = await db.execute<{ id: string }>(sql`
          update jobs set status = 'running', attempts = attempts + 1, locked_by = ${workerId},
                 lease_until = now() + (${leaseMs}::double precision * interval '1 millisecond'), updated_at = now()
          where id = (
            select id from jobs
            where type in (${typeList})
              and ((status in ('queued', 'failed') and run_after <= now())
                or (status = 'running' and lease_until < now()))
            order by run_after, created_at
            limit 1
            for update skip locked)
          returning id`);
        const id = claimed[0]?.id;
        if (!id) return undefined;
        const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
        if (!job) return undefined;
        if (job.attempts <= job.maxAttempts) return job;
        // An expired lease that already used its whole attempt budget: dead, then look at the next one.
        await db
          .update(jobs)
          .set({
            status: 'dead',
            lastError: 'lease expired after the last attempt',
            finishedAt: sql`now()`,
            ...cleared,
          })
          .where(fence(id, workerId));
      }
      return undefined;
    },

    async heartbeat(id: string, workerId: string, leaseMs = LEASE_MS): Promise<boolean> {
      const rows = await db
        .update(jobs)
        .set({
          leaseUntil: sql`now() + (${leaseMs}::double precision * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(fence(id, workerId))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    async complete(id: string, workerId: string): Promise<boolean> {
      const rows = await db
        .update(jobs)
        .set({ status: 'done', finishedAt: sql`now()`, lastError: null, ...cleared })
        .where(fence(id, workerId))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    /** failed + run_after = now() + backoff, or dead when attempts are used up or the error is permanent. */
    async fail(
      job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>,
      workerId: string,
      err: unknown,
      opts: { permanent?: boolean } = {},
    ): Promise<boolean> {
      const dead = Boolean(opts.permanent) || job.attempts >= job.maxAttempts;
      const retryIn = backoffMs(job.attempts);
      const rows = await db
        .update(jobs)
        .set({
          ...(dead
            ? { status: 'dead' as const, finishedAt: sql`now()` }
            : {
                status: 'failed' as const,
                runAfter: sql`now() + (${retryIn}::double precision * interval '1 millisecond')`,
              }),
          lastError: describeError(err),
          ...cleared,
        })
        .where(fence(job.id, workerId))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    /** Shutdown: back to queued, the attempt returned, lease cleared. */
    async release(id: string, workerId: string): Promise<boolean> {
      const rows = await db
        .update(jobs)
        .set({
          status: 'queued',
          attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
          runAfter: sql`now()`,
          ...cleared,
        })
        .where(fence(id, workerId))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },
  };
}

export type JobQueue = ReturnType<typeof jobQueue>;
