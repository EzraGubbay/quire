// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const completeCommand = vi.hoisted(() => vi.fn());
vi.mock('@/lib/lemida/commands', () => ({ completeCommand }));
vi.mock('@/lib/lemida/state', () => ({ saveLemidaState: vi.fn(async () => ({})) }));

const { POST } = await import('./route');
const ID = '2b1c3f5e-6a7d-4e8f-9a0b-1c2d3e4f5a6b';
const call = (id = ID) =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ status: 'error', result: { message: 'm' } }),
    }),
    { params: Promise.resolve({ id }) },
  );

describe('POST complete validation', () => {
  it('rejects a non-uuid id with 400 instead of hitting Postgres', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(400);
    expect(completeCommand).not.toHaveBeenCalled();
  });
});

describe('POST complete', () => {
  it('returns whether the completion was applied', async () => {
    completeCommand.mockResolvedValueOnce(true);
    expect(await (await call()).json()).toEqual({ ok: true, applied: true });
    expect(completeCommand).toHaveBeenCalledWith(ID, 'error', { message: 'm' });
    completeCommand.mockResolvedValueOnce(false);
    expect(await (await call()).json()).toEqual({ ok: true, applied: false });
  });
});
