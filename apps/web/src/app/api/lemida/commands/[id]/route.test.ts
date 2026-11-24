// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const completeCommand = vi.hoisted(() => vi.fn());
vi.mock('@/lib/lemida/commands', () => ({ completeCommand }));
vi.mock('@/lib/lemida/state', () => ({ saveLemidaState: vi.fn(async () => ({})) }));

const { POST } = await import('./route');
const call = () =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ status: 'error', result: { message: 'm' } }),
    }),
    { params: Promise.resolve({ id: 'abc' }) },
  );

describe('POST complete', () => {
  it('returns whether the completion was applied', async () => {
    completeCommand.mockResolvedValueOnce(true);
    expect(await (await call()).json()).toEqual({ ok: true, applied: true });
    expect(completeCommand).toHaveBeenCalledWith('abc', 'error', { message: 'm' });
    completeCommand.mockResolvedValueOnce(false);
    expect(await (await call()).json()).toEqual({ ok: true, applied: false });
  });
});
