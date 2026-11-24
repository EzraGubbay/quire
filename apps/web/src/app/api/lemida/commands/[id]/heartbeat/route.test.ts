// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const heartbeatCommand = vi.hoisted(() => vi.fn());
vi.mock('@/lib/lemida/commands', () => ({ heartbeatCommand }));
vi.mock('@/lib/lemida/state', () => ({ saveLemidaState: vi.fn(async () => ({})) }));

const { POST } = await import('./route');
const call = () => POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'abc' }) });

describe('POST heartbeat', () => {
  it('returns active from heartbeatCommand', async () => {
    heartbeatCommand.mockResolvedValueOnce(true);
    expect(await (await call()).json()).toEqual({ ok: true, active: true });
    expect(heartbeatCommand).toHaveBeenCalledWith('abc');
    heartbeatCommand.mockResolvedValueOnce(false);
    expect(await (await call()).json()).toEqual({ ok: true, active: false });
  });
});
