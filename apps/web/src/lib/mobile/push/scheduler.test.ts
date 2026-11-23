// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPushConfig } from './config';
import {
  DISPATCH_EVERY_MS,
  PURGE_EVERY_MS,
  SCAN_DEADLINES_EVERY_MS,
  startPushLoop,
  stopPushLoop,
} from './scheduler';

const noop = async () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  stopPushLoop();
  resetPushConfig();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPushLoop', () => {
  it('starts once per process (idempotent across hot reloads)', () => {
    const tasks = { dispatch: vi.fn(noop), purge: vi.fn(noop), scanDeadlines: vi.fn(noop) };
    expect(startPushLoop(tasks)).toBe(true);
    expect(startPushLoop(tasks)).toBe(false);
  });

  it('dispatches every 30 s and purges daily, after a short first run', async () => {
    const tasks = { dispatch: vi.fn(noop), purge: vi.fn(noop), scanDeadlines: vi.fn(noop) };
    startPushLoop(tasks);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tasks.dispatch).toHaveBeenCalledTimes(1);
    expect(tasks.purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DISPATCH_EVERY_MS * 4);
    expect(tasks.dispatch).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(PURGE_EVERY_MS);
    expect(tasks.purge).toHaveBeenCalledTimes(2);
  });

  it('scans deadlines on the first run and every 10 min', async () => {
    const tasks = { dispatch: vi.fn(noop), purge: vi.fn(noop), scanDeadlines: vi.fn(noop) };
    startPushLoop(tasks);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tasks.scanDeadlines).toHaveBeenCalledTimes(1);
    expect(SCAN_DEADLINES_EVERY_MS).toBe(10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(SCAN_DEADLINES_EVERY_MS * 3);
    expect(tasks.scanDeadlines).toHaveBeenCalledTimes(4);
  });

  it('a failing deadline scan is swallowed and logged by error class only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startPushLoop({
      dispatch: noop,
      purge: noop,
      scanDeadlines: async () => {
        throw new SyntaxError('due_at SECRET');
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledWith('[push] scanDeadlines failed (SyntaxError)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  it('unrefs every timer so it never keeps a process alive', () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      const t = real(fn, ms);
      return Object.assign(t, { unref });
    }) as unknown as typeof setInterval);
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      const t = realTimeout(fn, ms);
      return Object.assign(t, { unref });
    }) as unknown as typeof setTimeout);
    startPushLoop({ dispatch: noop, purge: noop, scanDeadlines: noop });
    expect(unref).toHaveBeenCalledTimes(4);
  });

  it('a failing tick is swallowed and logged by error class only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startPushLoop({
      dispatch: async () => {
        throw Object.assign(new Error('connection to fcm-SECRET refused'), { code: 'ECONNREFUSED' });
      },
      purge: noop,
      scanDeadlines: noop,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn).toHaveBeenCalledWith('[push] dispatch failed (ECONNREFUSED)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
});
