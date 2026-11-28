// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runMigrations = vi.fn(async () => {});
const startPushLoop = vi.fn(() => true);
vi.mock('./db/migrate', () => ({ runMigrations }));
const startJobWorker = vi.fn(() => true);
vi.mock('./lib/mobile/push/scheduler', () => ({ startPushLoop }));
vi.mock('./core/jobs/worker', () => ({ startJobWorker }));
vi.mock('./lib/ai/synthesis', () => ({ failStaleGenerating: async () => 0 }));
vi.mock('./lib/ai/tests', () => ({ failStaleTests: async () => 0 }));
const pruneEmptyThreads = vi.fn(async () => 0);
vi.mock('./lib/chat', () => ({ pruneEmptyThreads }));

const { register } = await import('./instrumentation');

beforeEach(() => {
  runMigrations.mockClear();
  startPushLoop.mockClear();
  startJobWorker.mockReset();
  startJobWorker.mockReturnValue(true);
  pruneEmptyThreads.mockReset();
  pruneEmptyThreads.mockResolvedValue(0);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('register', () => {
  it('migrates, then starts the push loop', async () => {
    vi.stubEnv('SKIP_MIGRATIONS', '');
    await register();
    expect(runMigrations).toHaveBeenCalledOnce();
    expect(startPushLoop).toHaveBeenCalledOnce();
    expect(runMigrations.mock.invocationCallOrder[0]).toBeLessThan(
      startPushLoop.mock.invocationCallOrder[0] as number,
    );
    expect(pruneEmptyThreads).toHaveBeenCalledOnce();
    expect(runMigrations.mock.invocationCallOrder[0]).toBeLessThan(
      pruneEmptyThreads.mock.invocationCallOrder[0] as number,
    );
  });

  it('still boots when the empty-chat prune fails', async () => {
    vi.stubEnv('SKIP_MIGRATIONS', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pruneEmptyThreads.mockRejectedValue(new Error('db down'));
    await expect(register()).resolves.toBeUndefined();
    expect(startPushLoop).toHaveBeenCalledOnce();
  });

  it('starts the push loop under SKIP_MIGRATIONS=1 too', async () => {
    vi.stubEnv('SKIP_MIGRATIONS', '1');
    await register();
    expect(runMigrations).not.toHaveBeenCalled();
    expect(pruneEmptyThreads).not.toHaveBeenCalled();
    expect(startPushLoop).toHaveBeenCalledOnce();
  });

  it('starts the jobs worker with signal handlers, also under SKIP_MIGRATIONS=1', async () => {
    vi.stubEnv('SKIP_MIGRATIONS', '1');
    await register();
    expect(startJobWorker).toHaveBeenCalledOnce();
    expect(startJobWorker).toHaveBeenCalledWith({ installSignalHandlers: true });
    expect(startPushLoop).toHaveBeenCalledOnce();
  });

  it('still boots when the jobs worker fails to start', async () => {
    vi.stubEnv('SKIP_MIGRATIONS', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startJobWorker.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(register()).resolves.toBeUndefined();
    expect(startPushLoop).toHaveBeenCalledOnce();
  });

  it('does nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(startPushLoop).not.toHaveBeenCalled();
    expect(startJobWorker).not.toHaveBeenCalled();
  });
});
