// In-process worker for the durable jobs queue (queue.ts). Concurrency 1: one job at a time, claimed with a
// lease that a heartbeat keeps extending while the handler runs.
//
// Handler contract: be idempotent and checkpoint, because a job can run more than once. Next exits on SIGTERM
// without waiting for this worker, so a job cut off by a deploy stays `running` until its lease expires
// (at most LEASE_MS) and is then claimed again, which costs one attempt. On a clean stop the worker aborts
// `ctx.signal` and returns the job to the queue; handlers should checkpoint and throw when it fires.
//
// With no handler registered the worker idles without a single query. It only claims types it has handlers
// for, so an older image never touches (or kills) jobs of a type it does not know.
import { randomUUID } from 'node:crypto';
import { db } from '@/db/client';
import type { Job } from '@/db/schema';
import { jobsPaused } from './pause';
import { type JobQueue, jobQueue, LEASE_MS, PermanentJobError } from './queue';

export const TICK_MS = 2_000;

export interface JobContext {
  /** Aborts on shutdown or when the lease was lost; checkpoint and throw. */
  signal: AbortSignal;
  workerId: string;
  /** Extend the lease now (the worker also does this on its own every third of the lease). */
  heartbeat(): Promise<boolean>;
}
export type JobHandler<P = unknown> = (job: Job & { payload: P }, ctx: JobContext) => Promise<void>;

type Registry = Map<string, JobHandler>;
const g = globalThis as unknown as {
  __quireJobHandlers?: Registry;
  __quireJobWorker?: { worker: JobWorker; timer: NodeJS.Timeout; detach: () => void };
};
// On globalThis so a dev re-evaluation of a handler module and the running worker see the same map.
const registry = (): Registry => {
  g.__quireJobHandlers ??= new Map();
  return g.__quireJobHandlers;
};

/** Register the handler for a job type. Registering a type twice replaces the earlier handler. */
export function registerJobHandler<P>(type: string, handler: JobHandler<P>): void {
  registry().set(type, handler as JobHandler);
}
export function registeredJobTypes(): string[] {
  return [...registry().keys()];
}

/** On unless JOBS_ENABLED is 0, false, off or no (any case). */
export function jobsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['0', 'false', 'off', 'no'].includes((env.JOBS_ENABLED ?? '').trim().toLowerCase());
}

export interface WorkerDeps {
  queue: JobQueue;
  paused(): Promise<boolean>;
  /** Default: the global registry. */
  handlers?: Map<string, JobHandler>;
  workerId?: string;
  leaseMs?: number;
  tickMs?: number;
}
export type TickResult = 'idle' | 'paused' | 'ran' | 'busy' | 'stopped';
export interface JobWorker {
  tick(): Promise<TickResult>;
  /** No new claims; abort the running job and resolve once it has settled. */
  stop(): Promise<void>;
}

/** Log tag without the message (messages can quote values): SQLSTATE when there is one, else the class. */
function errTag(e: unknown): string {
  const x = e as { code?: unknown; name?: unknown } | null;
  return typeof x?.code === 'string' ? x.code : typeof x?.name === 'string' ? x.name : 'Error';
}

/** The loop itself: no timers, no signals. */
export function createJobWorker(deps: WorkerDeps): JobWorker {
  const { queue } = deps;
  const workerId = deps.workerId ?? `w-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  let stopping = false;
  let inflight: Promise<TickResult> | undefined;
  const shutdown = new AbortController();

  async function runJob(job: Job, handler: JobHandler): Promise<void> {
    const lease = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, lease.signal]);
    const beat = async () => {
      const held = await queue.heartbeat(job.id, workerId, leaseMs);
      if (!held) lease.abort(new Error('lease lost'));
      return held;
    };
    const timer = setInterval(() => {
      beat().catch((e) => console.warn(`[jobs] heartbeat failed (${errTag(e)})`));
    }, leaseMs / 3);
    timer.unref();
    try {
      await handler(job, { signal, workerId, heartbeat: beat });
      await queue.complete(job.id, workerId);
    } catch (err) {
      if (shutdown.signal.aborted) {
        await queue.release(job.id, workerId);
        return;
      }
      const permanent = err instanceof PermanentJobError;
      await queue.fail(job, workerId, err, { permanent });
      const dead = permanent || job.attempts >= job.maxAttempts;
      console.warn(
        `[jobs] ${job.type} ${job.id} ${dead ? 'dead' : 'failed'} (${errTag(err)}), attempt ${job.attempts}/${job.maxAttempts}`,
      );
    } finally {
      clearInterval(timer);
    }
  }

  async function once(): Promise<TickResult> {
    const handlers = deps.handlers ?? registry();
    if (handlers.size === 0) return 'idle';
    try {
      if (await deps.paused()) return 'paused';
      const job = await queue.claimNext(workerId, [...handlers.keys()], leaseMs);
      if (!job) return 'idle';
      const handler = handlers.get(job.type);
      if (!handler) {
        await queue.release(job.id, workerId);
        return 'idle';
      }
      await runJob(job, handler);
      return 'ran';
    } catch (err) {
      console.warn(`[jobs] tick failed (${errTag(err)})`);
      return 'idle';
    }
  }

  return {
    tick() {
      if (stopping) return Promise.resolve('stopped');
      if (inflight) return Promise.resolve('busy');
      const p = once().finally(() => {
        inflight = undefined;
      });
      inflight = p;
      return p;
    },
    async stop() {
      stopping = true;
      shutdown.abort(new Error('shutdown'));
      await inflight;
    },
  };
}

/**
 * Start the worker once per process; false when it already runs or JOBS_ENABLED switches it off.
 * Signal handlers are opt-in: only the server's boot hook asks for them (a SIGTERM listener in a plain script
 * would suppress Node's default exit).
 */
export function startJobWorker(
  opts: { deps?: Partial<WorkerDeps>; installSignalHandlers?: boolean } = {},
): boolean {
  if (!jobsEnabled()) {
    console.log('[jobs] worker disabled (JOBS_ENABLED)');
    return false;
  }
  if (g.__quireJobWorker) return false;
  const tickMs = opts.deps?.tickMs ?? TICK_MS;
  const leaseMs = opts.deps?.leaseMs ?? LEASE_MS;
  const worker = createJobWorker({
    queue: jobQueue(db),
    paused: () => jobsPaused(db),
    ...opts.deps,
  });
  const kick = () => {
    worker
      .tick()
      .then((r) => {
        if (r === 'ran') setImmediate(kick).unref();
      })
      .catch(() => {});
  };
  const timer = setInterval(kick, tickMs);
  timer.unref();
  let detach = () => {};
  if (opts.installSignalHandlers) {
    const onStop = () => {
      console.log('[jobs] stopping: no new claims');
      void worker.stop();
    };
    process.once('SIGTERM', onStop);
    process.once('SIGINT', onStop);
    detach = () => {
      process.removeListener('SIGTERM', onStop);
      process.removeListener('SIGINT', onStop);
    };
  }
  g.__quireJobWorker = { worker, timer, detach };
  console.log(
    `[jobs] worker started (concurrency 1, tick ${tickMs} ms, lease ${leaseMs / 1000} s, handlers: ${(opts.deps?.handlers ?? registry()).size})`,
  );
  return true;
}

/** Tests only. */
export async function stopJobWorker(): Promise<void> {
  const cur = g.__quireJobWorker;
  if (!cur) return;
  g.__quireJobWorker = undefined;
  clearInterval(cur.timer);
  cur.detach();
  await cur.worker.stop();
}
