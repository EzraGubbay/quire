// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mode: 'github' as 'none' | 'github' }));

// Stub the next-auth wrapper: no session ever, so the gate answers 307 (pages) or 401 (api/mcp).
vi.mock('@/auth', () => ({
  get AUTH_MODE() {
    return h.mode;
  },
  githubConfigured: true,
  auth: (cb: (req: { auth: null; nextUrl: URL }) => Response) => (req: NextRequest) =>
    cb(Object.assign(req, { auth: null })),
}));

import { isPublic, proxy } from './proxy';

const ACTION = { 'next-action': '0000000000000000000000000000000000000000' };
const ev = {} as never;

function run(method: string, path: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers }), ev) as Response;
}
function passes(method: string, path: string, headers: Record<string, string> = {}) {
  return run(method, path, headers).headers.get('x-middleware-next') === '1';
}
const hdr = (o: Record<string, string> = {}) => new Headers(o);

const EXACT = ['/api/health', '/manifest.webmanifest', '/sw.js', '/offline', '/pdf.worker.min.mjs'];
const ASSETS = [
  '/icons/icon-192.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
  '/pdfjs/standard_fonts/FoxitSerif.pfb',
  '/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  '/mathjax/tex-svg.js',
  '/mathjax/tex-mml-chtml.js',
  '/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Bold.woff',
];
const ANY_METHOD = [
  ['POST', '/api/auth/signin/github'],
  ['POST', '/api/auth/signout'],
  ['GET', '/api/auth/session'],
  ['POST', '/api/mobile/v1/auth/pair'],
  ['GET', '/api/mobile/v1/me'],
];
const LOOKALIKES = [
  '/sw.js/x/documents/y',
  '/offline/x/documents/y',
  '/offlinex',
  '/manifest.webmanifest/x/documents/y',
  '/pdf.worker.min.mjs/x/documents/y',
  '/api/health/documents/y',
  '/api/healthz',
  '/icons/x/documents/y',
  '/icons/x',
  '/icons/icon-192.png/x',
  '/icons/x/y.png',
  '/pdfjs/x/documents/y',
  '/pdfjs/cmaps/LICENSE',
  '/mathjax/x/documents/y',
  '/mathjax/../etc/passwd',
];

beforeEach(() => {
  h.mode = 'github';
  delete process.env.QUIRE_API_KEY;
});

const TOKEN = 'A'.repeat(43);
const UPLOAD_GATED = [
  '/api/upload-links',
  '/api/upload-links/',
  '/api/upload-linksX/abc',
  '/api/upload-links-evil/x',
  '/api/upload-links/documents/x',
  '/api/upload-links/a/b',
  `/api/upload-links/${TOKEN}/extra`,
  '/api/upload-links/short',
];

describe('upload links', () => {
  it('PUT /api/upload-links/<token> is public', () => {
    expect(isPublic('PUT', `/api/upload-links/${TOKEN}`, hdr())).toBe(true);
    expect(passes('PUT', `/api/upload-links/${TOKEN}`)).toBe(true);
  });
  it.each(UPLOAD_GATED)('PUT %s stays gated (401)', (p) => {
    expect(run('PUT', p).status).toBe(401);
  });
  it.each(['GET', 'POST', 'DELETE'])('%s on a valid token path stays gated (401)', (m) => {
    expect(run(m, `/api/upload-links/${TOKEN}`).status).toBe(401);
  });
  it('a next-action header on the token path is gated', () => {
    expect(passes('PUT', `/api/upload-links/${TOKEN}`, ACTION)).toBe(false);
  });
});

describe('isPublic', () => {
  it.each([...EXACT, ...ASSETS])('GET and HEAD %s is public', (p) => {
    expect(isPublic('GET', p, hdr())).toBe(true);
    expect(isPublic('HEAD', p, hdr())).toBe(true);
  });
  it.each(ANY_METHOD)('%s %s is public', (m, p) => {
    expect(isPublic(m, p, hdr())).toBe(true);
  });
  it.each(LOOKALIKES)('look-alike %s is gated', (p) => {
    expect(isPublic('GET', p, hdr())).toBe(false);
  });
  it.each(['/api/mobile/pairing-codes', '/api/upload-links', '/mcp', '/c/algo/documents'])(
    '%s is gated',
    (p) => {
      expect(isPublic('GET', p, hdr())).toBe(false);
    },
  );
  it.each([...EXACT, ...ASSETS, '/icons/x/documents/y'])(
    '%s is never public to POST or a next-action',
    (p) => {
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isPublic(m, p, hdr())).toBe(false);
      expect(isPublic('POST', p, hdr(ACTION))).toBe(false);
      expect(isPublic('GET', p, hdr(ACTION))).toBe(false);
    },
  );
  it('next-action wins even on the any-method API prefixes', () => {
    expect(isPublic('POST', '/api/auth/signin', hdr(ACTION))).toBe(false);
    expect(isPublic('POST', '/api/mobile/v1/me', hdr(ACTION))).toBe(false);
  });
});

describe('proxy', () => {
  it.each([...EXACT, ...ASSETS])('GET %s passes without a session', (p) => {
    expect(passes('GET', p)).toBe(true);
    expect(passes('HEAD', p)).toBe(true);
  });
  it.each(ANY_METHOD)('%s %s passes', (m, p) => {
    expect(passes(m, p)).toBe(true);
  });
  it.each(LOOKALIKES)('GET look-alike %s is redirected to sign-in', (p) => {
    const res = run('GET', p);
    expect(res.headers.get('x-middleware-next')).toBeNull();
    expect(p.startsWith('/api/') ? 401 : 307).toBe(res.status);
  });
  it.each(['/api/mobile/pairing-codes', '/api/upload-links', '/api/upload-linksX/abc'])(
    'GET %s is 401',
    (p) => {
      expect(run('GET', p).status).toBe(401);
    },
  );
  it.each([...EXACT, ...ASSETS, '/icons/x/documents/y'])('actions cannot reach %s', (p) => {
    const gated = (r: Response) =>
      [307, 401].includes(r.status) && r.headers.get('x-middleware-next') === null;
    expect(gated(run('POST', p, ACTION))).toBe(true); // action header
    expect(gated(run('POST', p))).toBe(true); // header-less MPA form post
    expect(gated(run('GET', p, ACTION))).toBe(true); // action header on GET
  });
  it('GET with a next-action header is gated even on a public path', () => {
    expect(passes('GET', '/icons/icon-192.png', ACTION)).toBe(false);
  });
  it('POST /api/health is gated', () => {
    expect(run('POST', '/api/health').status).toBe(401);
  });
  it('POST /icons/x/documents/y with a dummy action redirects to sign-in', () => {
    expect(run('POST', '/icons/x/documents/y', ACTION).status).toBe(307);
  });
  it('unchanged: /mcp needs auth, accepts the API key; pages redirect', () => {
    process.env.QUIRE_API_KEY = 'k';
    expect(run('POST', '/mcp').status).toBe(401);
    expect(passes('POST', '/mcp', { authorization: 'Bearer k' })).toBe(true);
    expect(run('GET', '/c/algo/documents').status).toBe(307);
  });
  it('unchanged: AUTH_MODE none passes everything', () => {
    h.mode = 'none';
    expect(passes('POST', '/icons/x/documents/y', ACTION)).toBe(true);
  });
});
