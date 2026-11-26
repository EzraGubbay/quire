import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  AUTH_MODE: 'github',
  githubConfigured: true,
  auth: () => (req: NextRequest) => {
    const p = req.nextUrl.pathname;
    return p.startsWith('/api/') || p === '/mcp'
      ? new Response('Unauthorized', { status: 401 })
      : new Response(null, { status: 307 });
  },
}));

const { proxy } = await import('./proxy');
const run = (path: string, headers: Record<string, string> = {}, method = 'PUT') =>
  proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers }), {} as never);
const passes = (r: Response | undefined) => r?.headers.get('x-middleware-next') === '1';

afterEach(() => {
  delete process.env.QUIRE_API_KEY;
});

describe('proxy public prefixes', () => {
  const token = 'A'.repeat(43);
  it('lets /api/upload-links/<token> through without a bearer or session', () => {
    expect(passes(run(`/api/upload-links/${token}`) as Response)).toBe(true);
  });
  it.each([
    '/api/upload-links',
    '/api/upload-links/',
    '/api/upload-linksX/abc',
    '/api/upload-links-evil/x',
    '/api/upload-links/documents/x',
    '/api/upload-links/a/b',
    `/api/upload-links/${token}/extra`,
    '/api/upload-links/short',
  ])('keeps %s session-gated', (p) => {
    expect((run(p) as Response).status).toBe(401);
  });
  it.each(['GET', 'POST', 'DELETE'])('keeps %s on a valid-looking token path gated', (method) => {
    expect((run(`/api/upload-links/${token}`, {}, method) as Response).status).toBe(401);
  });
  it('keeps other write routes gated and accepts the bearer on /mcp', () => {
    expect((run('/api/projects/x/documents/upload') as Response).status).toBe(401);
    expect((run('/mcp', {}, 'POST') as Response).status).toBe(401);
    process.env.QUIRE_API_KEY = 'k';
    expect(passes(run('/mcp', { authorization: 'Bearer k' }, 'POST') as Response)).toBe(true);
  });
  it('still lets the existing public prefixes through', () => {
    expect(passes(run('/api/health', {}, 'GET') as Response)).toBe(true);
    expect(passes(run('/api/mobile/v1/me', {}, 'GET') as Response)).toBe(true);
  });
});
