import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '@/db/schema';
import { PermanentJobError } from './queue';
import {
  createJobWorker,
  type JobContext,
  type JobHandler,
  jobsEnabled,
  registeredJobTypes,
  registerJobHandler,
  startJobWorker,
  stopJobWorker,
  type WorkerDeps,
} from './worker';

const LEASE = 30_000;
const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  type: 'a',
  dedupeKey: null,
  payload: { n: 1 },
  status: 'running',
  attempts: 1,
  maxAttempts: 5,
  runAfter: new Date(0),
  leaseUntil: null,
  lockedBy: 'w',
  lastError: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  finishedAt: null,
  ...over,
});

function fakeQueue(next: () => Job | undefined = () => job()) {
  return {
    enqueue: vi.fn(),
    claimNext: vi.fn(async () => next()),
    heartbeat: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    release: vi.fn(async () => true),
  };
}
const build = (
  queue: ReturnType<typeof fakeQueue>,
  handlers: Map<string, JobHandler>,
  extra: Partial<WorkerDeps> = {},
) =>
  createJobWorker({
    queue,
    paused: async () => false,
    handlers,
    workerId: 'w',
    leaseMs: LEASE,
    ...extra,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  await stopJobWorker();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  (globalThis as { __quireJobHandlers?: unknown }).__quireJobHandlers = undefined;
});

describe('createJobWorker', () => {
  it('idles without any query when no handler is registered', async () => {
    const queue = fakeQueue();
    const paused = vi.fn(async () => false);
    const w = build(queue, new Map(), { paused });
    expect(await w.tick()).toBe('idle');
    expect(paused).not.toHaveBeenCalled();
    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  it('does not claim while paused', async () => {
    const queue = fakeQueue();
    const w = build(queue, new Map([['a', vi.fn(async () => {})]]), { paused: async () => true });
    expect(await w.tick()).toBe('paused');
    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  it('claims only registered types and completes on success', async () => {
    const queue = fakeQueue();
    const handler = vi.fn(async () => {});
    const w = build(
      queue,
      new Map([
        ['a', handler],
        ['b', handler],
      ]),
    );
    expect(await w.tick()).toBe('ran');
    expect(queue.claimNext).toHaveBeenCalledWith('w', ['a', 'b'], LEASE);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1', payload: { n: 1 } }),
      expect.any(Object),
    );
    expect(queue.complete).toHaveBeenCalledWith('j1', 'w');
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('is idle when nothing is due', async () => {
    const w = build(
      fakeQueue(() => undefined),
      new Map([['a', vi.fn(async () => {})]]),
    );
    expect(await w.tick()).toBe('idle');
  });

  it('retries on a throw and kills on PermanentJobError', async () => {
    const queue = fakeQueue();
    const boom = new Error('boom');
    const w = build(
      queue,
      new Map([
        [
          'a',
          async () => {
            throw boom;
          },
        ],
      ]),
    );
    await w.tick();
    expect(queue.fail).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }), 'w', boom, {
      permanent: false,
    });

    const queue2 = fakeQueue();
    const perm = new PermanentJobError('bad');
    const w2 = build(
      queue2,
      new Map([
        [
          'a',
          async () => {
            throw perm;
          },
        ],
      ]),
    );
    await w2.tick();
    expect(queue2.fail).toHaveBeenCalledWith(expect.anything(), 'w', perm, { permanent: true });
  });

  it('runs one job at a time', async () => {
    const queue = fakeQueue();
    let release!: () => void;
    const w = build(
      queue,
      new Map([
        [
          'a',
          () =>
            new Promise<void>((r) => {
              release = r;
            }),
        ],
      ]),
    );
    const first = w.tick();
    expect(await w.tick()).toBe('busy');
    await vi.advanceTimersByTimeAsync(0);
    expect(await w.tick()).toBe('busy');
    release();
    expect(await first).toBe('ran');
    expect(queue.claimNext).toHaveBeenCalledTimes(1);
  });

  it('heartbeats every third of the lease and aborts when the lease is lost', async () => {
    const queue = fakeQueue();
    let ctx!: JobContext;
    let release!: () => void;
    const w = build(
      queue,
      new Map([
        [
          'a',
          (_j, c) => {
            ctx = c;
            return new Promise<void>((r) => {
              release = r;
            });
          },
        ],
      ]),
    );
    const p = w.tick();
    await vi.advanceTimersByTimeAsync(LEASE / 3);
    expect(queue.heartbeat).toHaveBeenCalledWith('j1', 'w', LEASE);
    expect(ctx.signal.aborted).toBe(false);
    queue.heartbeat.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(LEASE / 3);
    expect(ctx.signal.aborted).toBe(true);
    release();
    await p;
  });

  it('stop() aborts the job, releases it (no failure) and later ticks are stopped', async () => {
    const queue = fakeQueue();
    let settled = false;
    const w = build(
      queue,
      new Map([
        [
          'a',
          (_j, c) =>
            new Promise<void>((_r, rej) => {
              c.signal.addEventListener('abort', () =>
                setTimeout(() => {
                  settled = true;
                  rej(new Error('aborted'));
                }, 10),
              );
            }),
        ],
      ]),
    );
    const p = w.tick();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = w.stop();
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    expect(settled).toBe(true);
    await p;
    expect(queue.release).toHaveBeenCalledWith('j1', 'w');
    expect(queue.fail).not.toHaveBeenCalled();
    expect(await w.tick()).toBe('stopped');
  });

  it('survives a throwing claim', async () => {
    const queue = fakeQueue();
    queue.claimNext.mockRejectedValueOnce(Object.assign(new Error('secret value'), { code: '08006' }));
    const w = build(queue, new Map([['a', vi.fn(async () => {})]]));
    expect(await w.tick()).toBe('idle');
    expect(console.warn).toHaveBeenCalledWith('[jobs] tick failed (08006)');
  });
});

describe('registry and switch', () => {
  it('last registration wins', () => {
    registerJobHandler('x', async () => {});
    const second = vi.fn(async () => {});
    registerJobHandler('x', second);
    expect(registeredJobTypes()).toEqual(['x']);
    expect(
      (globalThis as unknown as { __quireJobHandlers: Map<string, unknown> }).__quireJobHandlers.get('x'),
    ).toBe(second);
  });

  it('jobsEnabled defaults on and honours 0/false/off/no', () => {
    expect(jobsEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) expect(jobsEnabled({ JOBS_ENABLED: v })).toBe(false);
    for (const v of ['1', 'true']) expect(jobsEnabled({ JOBS_ENABLED: v })).toBe(true);
  });
});

describe('startJobWorker', () => {
  const deps = () => ({
    queue: fakeQueue(),
    paused: async () => false,
    handlers: new Map<string, JobHandler>(),
  });

  it('starts once per process', () => {
    expect(startJobWorker({ deps: deps() })).toBe(true);
    expect(startJobWorker({ deps: deps() })).toBe(false);
  });

  it('stays off when JOBS_ENABLED=0', () => {
    vi.stubEnv('JOBS_ENABLED', '0');
    expect(startJobWorker({ deps: deps() })).toBe(false);
  });

  it('installs no signal handlers unless asked', () => {
    const before = process.listenerCount('SIGTERM');
    startJobWorker({ deps: deps() });
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
