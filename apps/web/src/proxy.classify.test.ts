// @vitest-environment node
// Property test: the pure classifier, plus a model of the proxy's response semantics, must reproduce every
// cell recorded by the S0.2 characterization matrix. The recorded tables are read from that file's source so
// the outputs are never duplicated here. Does not import ./proxy or @/auth.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CallerEnv, capabilities, classify, RESEARCH_MCP_PATH } from '@/core/identity/caller';

const MASTER = 'qk_test_master';
const RESEARCH = 'qk_r_test_research';
const DEVICE = `dEv1ce_${'x'.repeat(36)}`;
const TOKEN43 = 'A'.repeat(43);
const TOKEN42 = 'A'.repeat(42);
const NA = { 'next-action': '0'.repeat(40) };

type Row = { label: string; method: string; path: string; headers?: Record<string, string> };
const ROWS: Row[] = [
  { label: 'GET /', method: 'GET', path: '/' },
  { label: 'POST / [next-action]', method: 'POST', path: '/', headers: NA },
  { label: 'POST /api/projects/x/runs', method: 'POST', path: '/api/projects/x/runs' },
  { label: 'GET /api/lemida/commands', method: 'GET', path: '/api/lemida/commands' },
  { label: 'GET /api/mobile/v1/me', method: 'GET', path: '/api/mobile/v1/me' },
  { label: 'POST /api/mobile/v1/auth/pair', method: 'POST', path: '/api/mobile/v1/auth/pair' },
  { label: 'POST /api/mobile/pairing-codes', method: 'POST', path: '/api/mobile/pairing-codes' },
  { label: 'POST /mcp', method: 'POST', path: '/mcp' },
  { label: 'POST /research/mcp', method: 'POST', path: '/research/mcp' },
  { label: 'POST /research/mcp/x', method: 'POST', path: '/research/mcp/x' },
  { label: 'POST /research/mcpx', method: 'POST', path: '/research/mcpx' },
  { label: 'PUT /api/upload-links/<43>', method: 'PUT', path: `/api/upload-links/${TOKEN43}` },
  { label: 'GET /api/upload-links/<43>', method: 'GET', path: `/api/upload-links/${TOKEN43}` },
  { label: 'PUT /api/upload-links/<42>', method: 'PUT', path: `/api/upload-links/${TOKEN42}` },
  { label: 'GET /api/health', method: 'GET', path: '/api/health' },
  { label: 'GET /icons/icon-192.png', method: 'GET', path: '/icons/icon-192.png' },
  { label: 'POST /icons/x/documents/y', method: 'POST', path: '/icons/x/documents/y', headers: NA },
];

type Cred = { id: string; authorization?: string; hasSession: boolean; nextAction?: boolean };
const CREDS: Cred[] = [
  { id: 'none', hasSession: false },
  { id: 'master', authorization: `Bearer ${MASTER}`, hasSession: false },
  { id: 'research', authorization: `Bearer ${RESEARCH}`, hasSession: false },
  { id: 'jwt-ok', hasSession: true },
  { id: 'jwt-other', hasSession: true },
  { id: 'device', authorization: `Bearer ${DEVICE}`, hasSession: false },
  { id: 'master+na', authorization: `Bearer ${MASTER}`, hasSession: false, nextAction: true },
  { id: 'research+na', authorization: `Bearer ${RESEARCH}`, hasSession: false, nextAction: true },
];

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
type Edge = {
  label: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  hasSession?: boolean;
  env?: Partial<CallerEnv>;
};
const EDGES: Edge[] = [
  { label: 'GET / session {user:{}} (no login)', method: 'GET', path: '/', hasSession: true },
  { label: 'GET / session {expires} (no user)', method: 'GET', path: '/' },
  {
    label: "POST /mcp 'bearer <master>' (lowercase scheme)",
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `bearer ${MASTER}` },
  },
  {
    label: "POST /mcp 'Bearer <master> ' (trailing space)",
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `Bearer ${MASTER} ` },
  },
  {
    label: "POST /mcp 'Bearer ' with QUIRE_API_KEY=''",
    method: 'POST',
    path: '/mcp',
    headers: { authorization: 'Bearer ' },
    env: { masterKey: '' },
  },
  {
    label: 'POST /research/mcp/ research key (trailing slash)',
    method: 'POST',
    path: '/research/mcp/',
    headers: bearer(RESEARCH),
  },
  {
    label: 'GET /research/mcp research key',
    method: 'GET',
    path: '/research/mcp',
    headers: bearer(RESEARCH),
  },
  {
    label: 'DELETE /research/mcp research key',
    method: 'DELETE',
    path: '/research/mcp',
    headers: bearer(RESEARCH),
  },
  {
    label: 'POST /api/projects/x/runs research key + jwt-ok',
    method: 'POST',
    path: '/api/projects/x/runs',
    headers: bearer(RESEARCH),
    hasSession: true,
  },
  {
    label: 'POST /research/mcp research key, QUIRE_RESEARCH_API_KEY unset',
    method: 'POST',
    path: '/research/mcp',
    headers: bearer(RESEARCH),
    env: { researchKey: undefined },
  },
];

/** Pull a recorded `const NAME = \`...\`` table out of the S0.2 file's source. */
const SOURCE = readFileSync(path.join(__dirname, 'proxy.matrix.test.ts'), 'utf8');
function recorded(name: string): string[][] {
  const m = new RegExp(`const ${name} = \`([^\`]*)\``).exec(SOURCE);
  expect(m, `table ${name} found in proxy.matrix.test.ts`).not.toBeNull();
  const rows = (m?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()));
  expect(rows.length, `table ${name} non-empty`).toBeGreaterThan(1);
  return rows;
}

/** The proxy's response semantics as a pure function of the classified kind. */
function predicted(kind: Parameters<typeof capabilities>[0], hasSession: boolean, pathname: string): string {
  const cap = capabilities(kind).proxy;
  if (cap === 'pass') return 'pass';
  if (cap === 'unavailable') return '503';
  if (hasSession) return 'pass';
  const apiLike =
    pathname.startsWith('/api/') ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname === RESEARCH_MCP_PATH;
  return apiLike ? '401' : '307';
}

const BASE: CallerEnv = {
  authMode: 'github',
  masterKey: MASTER,
  researchKey: RESEARCH,
  githubConfigured: true,
};

const MODES: { name: string; table: string; env: Partial<CallerEnv> }[] = [
  { name: 'GITHUB', table: 'GITHUB', env: {} },
  { name: 'GITHUB_UNCONFIGURED', table: 'GITHUB_UNCONFIGURED', env: { githubConfigured: false } },
  { name: 'NONE', table: 'NONE', env: { authMode: 'none' } },
];

describe('classify() reproduces the recorded S0.2 matrix', () => {
  it.each(MODES)('mode $name', ({ table, env }) => {
    const rec = recorded(table);
    expect(rec[0]).toEqual(['row', ...CREDS.map((c) => c.id)]);
    expect(rec.slice(1).map((r) => r[0])).toEqual(ROWS.map((r) => r.label));
    const mismatches: string[] = [];
    let cells = 0;
    ROWS.forEach((row, i) => {
      CREDS.forEach((cred, j) => {
        const headers = new Headers({
          ...(row.headers ?? {}),
          ...(cred.authorization ? { authorization: cred.authorization } : {}),
          ...(cred.nextAction ? NA : {}),
        });
        const { kind } = classify({ method: row.method, pathname: row.path, headers }, { ...BASE, ...env });
        const got = predicted(kind, cred.hasSession, row.path);
        const want = rec[i + 1]?.[j + 1];
        cells++;
        if (got !== want) mismatches.push(`${row.label} x ${cred.id}: got ${got}, recorded ${want}`);
      });
    });
    expect(cells).toBe(ROWS.length * CREDS.length);
    expect(mismatches).toEqual([]);
  });

  it('the edge scenarios (github mode)', () => {
    const rec = recorded('EDGE_EXPECTED');
    expect(rec.slice(1).map((r) => r[0])).toEqual(EDGES.map((e) => e.label));
    const mismatches: string[] = [];
    EDGES.forEach((e, i) => {
      const { kind } = classify(
        { method: e.method, pathname: e.path, headers: new Headers(e.headers ?? {}) },
        { ...BASE, ...e.env },
      );
      const got = predicted(kind, e.hasSession ?? false, e.path);
      const want = rec[i + 1]?.[1];
      if (got !== want) mismatches.push(`${e.label}: got ${got}, recorded ${want}`);
    });
    expect(mismatches).toEqual([]);
  });
});
