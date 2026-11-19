import { describe, expect, it, vi } from 'vitest';
import { requireDevice } from './device-auth';
import type { Principal } from './auth';

const principal: Principal = { login: 'local', tokenId: 'd1', deviceName: 'Pixel', createdAt: new Date() };

describe('requireDevice', () => {
  it('returns the principal when authenticate succeeds', async () => {
    const r = await requireDevice(new Request('http://x'), vi.fn().mockResolvedValue(principal));
    expect(r).toEqual({ principal });
  });

  it('returns a 401 unauthorized envelope otherwise', async () => {
    const r = await requireDevice(new Request('http://x'), vi.fn().mockResolvedValue(null));
    expect('response' in r).toBe(true);
    if (!('response' in r)) return;
    expect(r.response.status).toBe(401);
    const body = await r.response.json();
    expect(body.error.code).toBe('unauthorized');
    expect(typeof body.error.message).toBe('string');
    expect(r.response.headers.get('www-authenticate')).toBe('Bearer');
  });
});
