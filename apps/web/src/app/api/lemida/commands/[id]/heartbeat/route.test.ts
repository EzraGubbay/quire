// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const heartbeatCommand = vi.hoisted(() => vi.fn());
vi.mock('@/lib/lemida/commands', () => ({ heartbeatCommand }));
vi.mock('@/lib/lemida/state', () => ({ saveLemidaState: vi.fn(async () => ({})) }));

const { POST } = await import('./route');
const ID = '2b1c3f5e-6a7d-4e8f-9a0b-1c2d3e4f5a6b';
const call = (id = ID) =>
  POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id }) });

describe('POST heartbeat validation', () => {
  it('rejects a non-uuid id with 400 instead of hitting Postgres', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(400);
    expect(heartbeatCommand).not.toHaveBeenCalled();
  });
});

describe('POST heartbeat', () => {
  it('returns active from heartbeatCommand', async () => {
    heartbeatCommand.mockResolvedValueOnce(true);
    expect(await (await call()).json()).toEqual({ ok: true, active: true });
    expect(heartbeatCommand).toHaveBeenCalledWith(ID);
    heartbeatCommand.mockResolvedValueOnce(false);
    expect(await (await call()).json()).toEqual({ ok: true, active: false });
  });
});
