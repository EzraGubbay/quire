// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  claimNextCommand: vi.fn(),
  reapStaleCommands: vi.fn(),
  enqueueIfIdle: vi.fn(),
}));
vi.mock('@/lib/lemida/commands', () => ({
  claimNextCommand: mocks.claimNextCommand,
  reapStaleCommands: mocks.reapStaleCommands,
  enqueueIfIdle: mocks.enqueueIfIdle,
}));
vi.mock('@/lib/lemida/courses', () => ({ enabledMappings: vi.fn(async () => []) }));
vi.mock('@/lib/lemida/state', () => ({ saveLemidaState: vi.fn(async () => ({})) }));

const { GET, POST } = await import('./route');
const post = (body: unknown) =>
  POST(new Request('http://x/api/lemida/commands', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.reapStaleCommands.mockImplementation(async () => {
    mocks.calls.push('reap');
    return { leaseExpired: [], expired: [] };
  });
  mocks.claimNextCommand.mockImplementation(async () => {
    mocks.calls.push('claim');
    return undefined;
  });
});

describe('GET /api/lemida/commands', () => {
  it('claims unleased without ?lease=1', async () => {
    await GET(new Request('http://x/api/lemida/commands'));
    expect(mocks.claimNextCommand).toHaveBeenCalledWith({ leased: false });
  });
  it('claims leased with ?lease=1, reaping first', async () => {
    const res = await GET(new Request('http://x/api/lemida/commands?lease=1'));
    expect(mocks.claimNextCommand).toHaveBeenCalledWith({ leased: true });
    expect(mocks.calls).toEqual(['reap', 'claim']);
    expect(await res.json()).toEqual({ command: null });
  });
});

describe('POST /api/lemida/commands', () => {
  it('enqueues an idle sync and reports created', async () => {
    mocks.enqueueIfIdle.mockResolvedValue({ command: { id: 'c1' }, created: true });
    const res = await post({ kind: 'sync', trigger: 'auto-timer' });
    expect(mocks.enqueueIfIdle).toHaveBeenCalledWith('sync', { trigger: 'auto-timer' });
    expect(await res.json()).toEqual({ created: true, id: 'c1' });
  });
  it('passes through a no-mappings refusal', async () => {
    mocks.enqueueIfIdle.mockResolvedValue({ command: null, created: false, reason: 'no-mappings' });
    const res = await post({ kind: 'sync', trigger: 'auto-sign-in' });
    expect(await res.json()).toEqual({ created: false, reason: 'no-mappings', id: null });
  });
  it('rejects other kinds with 400', async () => {
    const res = await post({ kind: 'open_login' });
    expect(res.status).toBe(400);
    expect(mocks.enqueueIfIdle).not.toHaveBeenCalled();
  });
});
