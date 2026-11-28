// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type CallerEnv,
  type CallerKind,
  type CallerRequest,
  capabilities,
  classify,
  RESEARCH_MCP_PATH,
} from './caller';

const MK = 'MK';
const RK = 'RK';
const A43 = 'A'.repeat(43);
const A42 = 'A'.repeat(42);
const DEVICE43 = `dEv1ce_${'x'.repeat(36)}`;
const NA = { 'next-action': '0'.repeat(40) };
const B = (k: string) => ({ authorization: `Bearer ${k}` });

const E: CallerEnv = { authMode: 'github', masterKey: MK, researchKey: RK, githubConfigured: true };

type Case = {
  label: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** A plain {has,get} object instead of Headers, to show the pure function does not trim. */
  raw?: boolean;
  env?: Partial<CallerEnv>;
  kind: CallerKind;
};

const CASES: Case[] = [
  // public
  { label: 'GET /api/health', method: 'GET', path: '/api/health', kind: 'public' },
  { label: 'HEAD /api/health', method: 'HEAD', path: '/api/health', kind: 'public' },
  ...['/manifest.webmanifest', '/sw.js', '/offline', '/pdf.worker.min.mjs'].map(
    (path): Case => ({ label: `GET ${path}`, method: 'GET', path, kind: 'public' }),
  ),
  { label: 'GET /icons/icon-192.png', method: 'GET', path: '/icons/icon-192.png', kind: 'public' },
  {
    label: 'GET /pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
    method: 'GET',
    path: '/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
    kind: 'public',
  },
  {
    label: 'GET /mathjax font',
    method: 'GET',
    path: '/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Bold.woff',
    kind: 'public',
  },
  { label: 'POST /api/auth/signin/github', method: 'POST', path: '/api/auth/signin/github', kind: 'public' },
  {
    label: 'POST /api/mobile/v1/auth/pair',
    method: 'POST',
    path: '/api/mobile/v1/auth/pair',
    kind: 'public',
  },
  {
    label: 'GET /api/mobile/v1/me device token',
    method: 'GET',
    path: '/api/mobile/v1/me',
    headers: B(DEVICE43),
    kind: 'public',
  },
  { label: 'PUT upload-link 43', method: 'PUT', path: `/api/upload-links/${A43}`, kind: 'public' },
  {
    label: 'GET /api/health research key (public beats every credential)',
    method: 'GET',
    path: '/api/health',
    headers: B(RK),
    kind: 'public',
  },
  {
    label: 'GET /api/health authMode none (public before local)',
    method: 'GET',
    path: '/api/health',
    env: { authMode: 'none' },
    kind: 'public',
  },
  // not public: next-action, method, look-alikes
  {
    label: 'GET /api/health [next-action]',
    method: 'GET',
    path: '/api/health',
    headers: NA,
    kind: 'needs-session',
  },
  {
    label: 'POST /api/mobile/v1/me [next-action]',
    method: 'POST',
    path: '/api/mobile/v1/me',
    headers: NA,
    kind: 'needs-session',
  },
  {
    label: 'POST /api/auth/signin [next-action]',
    method: 'POST',
    path: '/api/auth/signin',
    headers: NA,
    kind: 'needs-session',
  },
  {
    label: 'PUT upload-link 43 [next-action]',
    method: 'PUT',
    path: `/api/upload-links/${A43}`,
    headers: NA,
    kind: 'needs-session',
  },
  { label: 'PUT upload-link 42', method: 'PUT', path: `/api/upload-links/${A42}`, kind: 'needs-session' },
  {
    label: 'PUT upload-link 43 + /extra',
    method: 'PUT',
    path: `/api/upload-links/${A43}/extra`,
    kind: 'needs-session',
  },
  { label: 'GET upload-link 43', method: 'GET', path: `/api/upload-links/${A43}`, kind: 'needs-session' },
  { label: 'POST /api/health', method: 'POST', path: '/api/health', kind: 'needs-session' },
  {
    label: 'POST /icons/x/documents/y [next-action]',
    method: 'POST',
    path: '/icons/x/documents/y',
    headers: NA,
    kind: 'needs-session',
  },
  ...['/icons/x/documents/y', '/api/healthz', '/offlinex', '/mathjax/../etc/passwd'].map(
    (path): Case => ({ label: `GET ${path}`, method: 'GET', path, kind: 'needs-session' }),
  ),
  {
    label: 'POST /api/mobile/pairing-codes',
    method: 'POST',
    path: '/api/mobile/pairing-codes',
    kind: 'needs-session',
  },
  // local
  { label: 'GET / authMode none', method: 'GET', path: '/', env: { authMode: 'none' }, kind: 'local' },
  {
    label: 'POST / [next-action] authMode none',
    method: 'POST',
    path: '/',
    headers: NA,
    env: { authMode: 'none' },
    kind: 'local',
  },
  {
    label: 'POST /mcp authMode none, unconfigured',
    method: 'POST',
    path: '/mcp',
    env: { authMode: 'none', githubConfigured: false },
    kind: 'local',
  },
  {
    label: "GET / authMode 'GitHub'",
    method: 'GET',
    path: '/',
    env: { authMode: 'GitHub' },
    kind: 'needs-session',
  },
  { label: "GET / authMode ''", method: 'GET', path: '/', env: { authMode: '' }, kind: 'needs-session' },
  // research key
  {
    label: 'POST /research/mcp RK',
    method: 'POST',
    path: '/research/mcp',
    headers: B(RK),
    kind: 'research-key',
  },
  {
    label: 'GET /research/mcp RK',
    method: 'GET',
    path: '/research/mcp',
    headers: B(RK),
    kind: 'research-key',
  },
  {
    label: 'DELETE /research/mcp RK',
    method: 'DELETE',
    path: '/research/mcp',
    headers: B(RK),
    kind: 'research-key',
  },
  // No method filter today: the route itself answers 405.
  {
    label: 'PUT /research/mcp RK',
    method: 'PUT',
    path: '/research/mcp',
    headers: B(RK),
    kind: 'research-key',
  },
  {
    label: 'POST /research/mcp RK [next-action]',
    method: 'POST',
    path: '/research/mcp',
    headers: { ...B(RK), ...NA },
    kind: 'needs-session',
  },
  {
    label: 'POST /research/mcp/ RK',
    method: 'POST',
    path: '/research/mcp/',
    headers: B(RK),
    kind: 'needs-session',
  },
  {
    label: 'POST /research/mcp/x RK',
    method: 'POST',
    path: '/research/mcp/x',
    headers: B(RK),
    kind: 'needs-session',
  },
  {
    label: 'POST /research/mcpx RK',
    method: 'POST',
    path: '/research/mcpx',
    headers: B(RK),
    kind: 'needs-session',
  },
  { label: 'POST /mcp RK', method: 'POST', path: '/mcp', headers: B(RK), kind: 'needs-session' },
  {
    label: 'POST /api/projects/x/runs RK',
    method: 'POST',
    path: '/api/projects/x/runs',
    headers: B(RK),
    kind: 'needs-session',
  },
  { label: 'GET / RK', method: 'GET', path: '/', headers: B(RK), kind: 'needs-session' },
  {
    label: 'POST /research/mcp RK, researchKey undefined',
    method: 'POST',
    path: '/research/mcp',
    headers: B(RK),
    env: { researchKey: undefined },
    kind: 'needs-session',
  },
  {
    label: "POST /research/mcp 'Bearer ', researchKey ''",
    method: 'POST',
    path: '/research/mcp',
    headers: { authorization: 'Bearer ' },
    env: { researchKey: '' },
    kind: 'needs-session',
  },
  {
    label: 'POST /research/mcp RK, unconfigured (research before unconfigured)',
    method: 'POST',
    path: '/research/mcp',
    headers: B(RK),
    env: { githubConfigured: false },
    kind: 'research-key',
  },
  {
    label: 'POST /mcp RK, unconfigured',
    method: 'POST',
    path: '/mcp',
    headers: B(RK),
    env: { githubConfigured: false },
    kind: 'unconfigured',
  },
  // master key
  { label: 'POST /mcp MK', method: 'POST', path: '/mcp', headers: B(MK), kind: 'master-key' },
  {
    label: 'POST /api/projects/x/runs MK',
    method: 'POST',
    path: '/api/projects/x/runs',
    headers: B(MK),
    kind: 'master-key',
  },
  // The master key may run Server Actions, as today.
  {
    label: 'POST / MK [next-action]',
    method: 'POST',
    path: '/',
    headers: { ...B(MK), ...NA },
    kind: 'master-key',
  },
  // The proxy passes the master key on the research path; the route rejects it.
  {
    label: 'POST /research/mcp MK',
    method: 'POST',
    path: '/research/mcp',
    headers: B(MK),
    kind: 'master-key',
  },
  {
    label: 'POST /research/mcp MK [next-action]',
    method: 'POST',
    path: '/research/mcp',
    headers: { ...B(MK), ...NA },
    kind: 'master-key',
  },
  {
    label: 'GET / MK, unconfigured (master before unconfigured)',
    method: 'GET',
    path: '/',
    headers: B(MK),
    env: { githubConfigured: false },
    kind: 'master-key',
  },
  {
    label: 'POST /mcp lowercase bearer',
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `bearer ${MK}` },
    kind: 'needs-session',
  },
  {
    label: 'POST /mcp bare key',
    method: 'POST',
    path: '/mcp',
    headers: { authorization: MK },
    kind: 'needs-session',
  },
  {
    label: 'POST /mcp two spaces',
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `Bearer  ${MK}` },
    kind: 'needs-session',
  },
  {
    label: 'POST /mcp raw trailing space (the pure function does not trim)',
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `Bearer ${MK} ` },
    raw: true,
    kind: 'needs-session',
  },
  {
    label: 'POST /mcp Headers trailing space (the Headers API trims)',
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `Bearer ${MK} ` },
    kind: 'master-key',
  },
  {
    label: "POST /mcp 'Bearer ', masterKey ''",
    method: 'POST',
    path: '/mcp',
    headers: { authorization: 'Bearer ' },
    env: { masterKey: '' },
    kind: 'needs-session',
  },
  {
    label: "POST /mcp 'Bearer undefined', masterKey undefined",
    method: 'POST',
    path: '/mcp',
    headers: { authorization: 'Bearer undefined' },
    env: { masterKey: undefined },
    kind: 'needs-session',
  },
  {
    label: 'POST /mcp MK, masterKey undefined',
    method: 'POST',
    path: '/mcp',
    headers: B(MK),
    env: { masterKey: undefined },
    kind: 'needs-session',
  },
  // both keys equal
  {
    label: 'POST /research/mcp K, keys equal',
    method: 'POST',
    path: '/research/mcp',
    headers: B('K'),
    env: { masterKey: 'K', researchKey: 'K' },
    kind: 'research-key',
  },
  {
    label: 'POST /mcp K, keys equal',
    method: 'POST',
    path: '/mcp',
    headers: B('K'),
    env: { masterKey: 'K', researchKey: 'K' },
    kind: 'master-key',
  },
  // unconfigured / session
  {
    label: 'GET / unconfigured',
    method: 'GET',
    path: '/',
    env: { githubConfigured: false },
    kind: 'unconfigured',
  },
  {
    label: 'POST /api/mobile/v1/me [next-action] unconfigured',
    method: 'POST',
    path: '/api/mobile/v1/me',
    headers: NA,
    env: { githubConfigured: false },
    kind: 'unconfigured',
  },
  {
    label: 'GET /api/health unconfigured',
    method: 'GET',
    path: '/api/health',
    env: { githubConfigured: false },
    kind: 'public',
  },
  {
    label: 'GET /api/projects/x/runs device token',
    method: 'GET',
    path: '/api/projects/x/runs',
    headers: B(DEVICE43),
    kind: 'needs-session',
  },
  { label: 'GET /', method: 'GET', path: '/', kind: 'needs-session' },
];

function requestFor(c: Case): CallerRequest {
  const init = c.headers ?? {};
  if (c.raw) {
    const lower = Object.fromEntries(Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      method: c.method,
      pathname: c.path,
      headers: { has: (n) => n.toLowerCase() in lower, get: (n) => lower[n.toLowerCase()] ?? null },
    };
  }
  return { method: c.method, pathname: c.path, headers: new Headers(init) };
}

describe('classify', () => {
  it('has unique labels', () => {
    const labels = CASES.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(CASES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    expect(classify(requestFor(c), { ...E, ...c.env }).kind).toBe(c.kind);
  });

  it('research-key only ever on exactly the research path without a next-action header', () => {
    const hits = CASES.filter((c) => classify(requestFor(c), { ...E, ...c.env }).kind === 'research-key');
    expect(hits.length).toBeGreaterThan(0);
    for (const c of hits) {
      expect(c.path, c.label).toBe(RESEARCH_MCP_PATH);
      expect(Object.keys(c.headers ?? {}), c.label).not.toContain('next-action');
    }
  });

  it('a next-action request is never public or research-key', () => {
    const withAction = CASES.filter((c) => 'next-action' in (c.headers ?? {}));
    expect(withAction.length).toBeGreaterThan(0);
    for (const c of withAction) {
      const { kind } = classify(requestFor(c), { ...E, ...c.env });
      expect(kind, c.label).not.toBe('public');
      expect(kind, c.label).not.toBe('research-key');
    }
  });
});

describe('capabilities', () => {
  it('matches the recorded table for all six kinds', () => {
    const kinds: CallerKind[] = [
      'public',
      'local',
      'master-key',
      'research-key',
      'needs-session',
      'unconfigured',
    ];
    expect(Object.fromEntries(kinds.map((k) => [k, capabilities(k)]))).toEqual({
      public: { proxy: 'pass', reach: 'public', serverActions: 'no' },
      local: { proxy: 'pass', reach: 'any', serverActions: 'yes' },
      'master-key': { proxy: 'pass', reach: 'any', serverActions: 'yes' },
      'research-key': { proxy: 'pass', reach: 'research-mcp', serverActions: 'no' },
      'needs-session': { proxy: 'session-gate', reach: 'session', serverActions: 'session' },
      unconfigured: { proxy: 'unavailable', reach: 'none', serverActions: 'no' },
    });
  });
});
