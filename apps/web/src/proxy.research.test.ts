// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mode: 'github' as 'none' | 'github' }));
vi.mock('@/auth', () => ({
  get AUTH_MODE() {
    return h.mode;
  },
  githubConfigured: true,
  auth: (cb: (req: { auth: null; nextUrl: URL }) => Response) => (req: NextRequest) =>
    cb(Object.assign(req, { auth: null })),
}));

import { proxy } from './proxy';

const RKEY = 'qk_r_research';
const run = (method: string, path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers }), {} as never) as Response;
const passes = (method: string, path: string, headers: Record<string, string> = {}) =>
  run(method, path, headers).headers.get('x-middleware-next') === '1';
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

beforeEach(() => {
  h.mode = 'github';
  process.env.QUIRE_API_KEY = 'master';
  process.env.QUIRE_RESEARCH_API_KEY = RKEY;
});
afterEach(() => {
  delete process.env.QUIRE_API_KEY;
  delete process.env.QUIRE_RESEARCH_API_KEY;
});

describe('research key in the proxy', () => {
  it('passes at exactly /research/mcp for GET, POST and DELETE', () => {
    for (const m of ['GET', 'POST', 'DELETE']) expect(passes(m, '/research/mcp', bearer(RKEY))).toBe(true);
  });
  it('does not pass anywhere else', () => {
    for (const p of [
      '/mcp',
      '/research/mcp/x',
      '/research/mcp/',
      '/research',
      '/p/kairos',
      '/api/projects/kairos/documents/x/file',
    ]) {
      expect(passes('POST', p, bearer(RKEY)), p).toBe(false);
    }
    expect(run('POST', '/mcp', bearer(RKEY)).status).toBe(401);
    expect(run('GET', '/api/projects/kairos/documents/x/file', bearer(RKEY)).status).toBe(401);
    expect(run('GET', '/p/kairos', bearer(RKEY)).status).toBe(307);
  });
  it('does not pass with a next-action header', () => {
    const headers = { ...bearer(RKEY), 'next-action': '0'.repeat(40) };
    expect(passes('POST', '/research/mcp', headers)).toBe(false);
  });
  it('no bearer at /research/mcp is a 401, not a redirect', () => {
    expect(run('POST', '/research/mcp').status).toBe(401);
  });
  it('an unset research key never passes', () => {
    delete process.env.QUIRE_RESEARCH_API_KEY;
    expect(passes('POST', '/research/mcp', { authorization: 'Bearer ' })).toBe(false);
  });
  it('the master key still passes at /mcp (regression)', () => {
    expect(passes('POST', '/mcp', bearer('master'))).toBe(true);
  });
});
