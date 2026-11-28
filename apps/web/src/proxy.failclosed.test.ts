// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  AUTH_MODE: 'github',
  githubConfigured: true,
  auth: () => () => new Response('session-gate'),
}));
vi.mock('@/core/identity/caller', async (orig) => ({
  ...(await orig<typeof import('@/core/identity/caller')>()),
  classify: () => ({ kind: 'some-future-kind' }),
}));

import { proxy } from './proxy';

describe('proxy fails closed', () => {
  it('answers 401, never a pass-through, for a caller kind it has no mapping for', () => {
    const res = proxy(new NextRequest('http://localhost:3000/'), {} as never) as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get('x-middleware-next')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  });
});
