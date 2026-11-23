// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runMigrations = vi.fn(async () => {});
const startPushLoop = vi.fn(() => true);
vi.mock('./db/migrate', () => ({ runMigrations }));
vi.mock('./lib/mobile/push/scheduler', () => ({ startPushLoop }));
vi.mock('./lib/ai/synthesis', () => ({ failStaleGenerating: async () => 0 }));
vi.mock('./lib/ai/tests', () => ({ failStaleTests: async () => 0 }));

const { register } = await import('./instrumentation');

beforeEach(() => {
  runMigrations.mockClear();
  startPushLoop.mockClear();
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
  });

  it('starts the push loop under SKIP_MIGRATIONS=1 too', async () => {
    vi.stubEnv('SKIP_MIGRATIONS', '1');
    await register();
    expect(runMigrations).not.toHaveBeenCalled();
    expect(startPushLoop).toHaveBeenCalledOnce();
  });

  it('does nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(startPushLoop).not.toHaveBeenCalled();
  });
});
