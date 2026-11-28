// @vitest-environment node
// Characterization of proxy() decisions: rows x credentials x modes, as explicit reviewable tables.
// Any diff in a table is a behaviour change and must be intentional (listed in the PR that makes it).
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mode: 'github' as string,
  configured: true,
  session: null as unknown,
}));
vi.mock('@/auth', () => ({
  get AUTH_MODE() {
    return h.mode;
  },
  get githubConfigured() {
    return h.configured;
  },
  // Polymorphic like NextAuth's `auth`: auth(cb) -> middleware wrapper; auth() -> Promise<session>.
  auth: (arg?: unknown) =>
    typeof arg === 'function'
      ? (req: NextRequest) => (arg as (r: unknown) => Response)(Object.assign(req, { auth: h.session }))
      : Promise.resolve(h.session),
}));

import { proxy } from './proxy';

const MASTER = 'qk_test_master';
const RESEARCH = 'qk_r_test_research';
const ALLOWED = 'Owner';
const OTHER = 'mallory';
const DEVICE = `dEv1ce_${'x'.repeat(36)}`; // 43 chars, device-token shaped
const TOKEN43 = 'A'.repeat(43);
const TOKEN42 = 'A'.repeat(42);
const NA = { 'next-action': '0'.repeat(40) };

const sess = (login?: string) => ({ user: { login }, expires: '2099-01-01T00:00:00.000Z' });

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

type Cred = { id: string; authorization?: string; session: unknown; nextAction?: boolean };
const CREDS: Cred[] = [
  { id: 'none', session: null },
  { id: 'master', authorization: `Bearer ${MASTER}`, session: null },
  { id: 'research', authorization: `Bearer ${RESEARCH}`, session: null },
  { id: 'jwt-ok', session: sess(ALLOWED) },
  { id: 'jwt-other', session: sess(OTHER) },
  { id: 'device', authorization: `Bearer ${DEVICE}`, session: null },
  { id: 'master+na', authorization: `Bearer ${MASTER}`, session: null, nextAction: true },
  { id: 'research+na', authorization: `Bearer ${RESEARCH}`, session: null, nextAction: true },
];

function outcome(res: Response): string {
  if (res.headers.get('x-middleware-next') === '1') return 'pass';
  if (res.status === 307) {
    const loc = res.headers.get('location');
    return loc && new URL(loc).pathname === '/api/auth/signin' ? '307' : `other:307->${loc}`;
  }
  if (res.status === 401 || res.status === 503) return String(res.status);
  return `other:${res.status}`;
}

async function run(
  method: string,
  path: string,
  headers: Record<string, string>,
  session: unknown,
): Promise<string> {
  h.session = session;
  const req = new NextRequest(`http://localhost:3000${path}`, { method, headers });
  return outcome((await proxy(req, {} as never)) as Response);
}

/** Parse a template-literal table into trimmed cell rows (blank lines dropped). */
function table(src: string): string[][] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()));
}
const lines = (rows: string[][]) => rows.map((r) => r.join(' | '));

async function actualTable(): Promise<string[][]> {
  const out: string[][] = [['row', ...CREDS.map((c) => c.id)]];
  for (const row of ROWS) {
    const cells: string[] = [];
    for (const c of CREDS) {
      const headers: Record<string, string> = { ...(row.headers ?? {}) };
      if (c.authorization) headers.authorization = c.authorization;
      if (c.nextAction) Object.assign(headers, NA);
      cells.push(await run(row.method, row.path, headers, c.session));
    }
    out.push([row.label, ...cells]);
  }
  return out;
}

async function expectMatrix(expectedSrc: string) {
  const expected = table(expectedSrc);
  expect(expected[0]).toEqual(['row', ...CREDS.map((c) => c.id)]);
  expect(expected.slice(1).map((r) => r[0])).toEqual(ROWS.map((r) => r.label));
  expect(lines(await actualTable())).toEqual(lines(expected));
}

const GITHUB = `
row                            | none | master | research | jwt-ok | jwt-other | device | master+na | research+na
GET /                          | 307  | pass   | 307      | pass   | 307       | 307    | pass      | 307
POST / [next-action]           | 307  | pass   | 307      | pass   | 307       | 307    | pass      | 307
POST /api/projects/x/runs      | 401  | pass   | 401      | pass   | 401       | 401    | pass      | 401
GET /api/lemida/commands       | 401  | pass   | 401      | pass   | 401       | 401    | pass      | 401
GET /api/mobile/v1/me          | pass | pass   | pass     | pass   | pass      | pass   | pass      | 401
POST /api/mobile/v1/auth/pair  | pass | pass   | pass     | pass   | pass      | pass   | pass      | 401
POST /api/mobile/pairing-codes | 401  | pass   | 401      | pass   | 401       | 401    | pass      | 401
POST /mcp                      | 401  | pass   | 401      | pass   | 401       | 401    | pass      | 401
POST /research/mcp             | 401  | pass   | pass     | pass   | 401       | 401    | pass      | 401
POST /research/mcp/x           | 307  | pass   | 307      | pass   | 307       | 307    | pass      | 307
POST /research/mcpx            | 307  | pass   | 307      | pass   | 307       | 307    | pass      | 307
PUT /api/upload-links/<43>     | pass | pass   | pass     | pass   | pass      | pass   | pass      | 401
GET /api/upload-links/<43>     | 401  | pass   | 401      | pass   | 401       | 401    | pass      | 401
PUT /api/upload-links/<42>     | 401  | pass   | 401      | pass   | 401       | 401    | pass      | 401
GET /api/health                | pass | pass   | pass     | pass   | pass      | pass   | pass      | 401
GET /icons/icon-192.png        | pass | pass   | pass     | pass   | pass      | pass   | pass      | 307
POST /icons/x/documents/y      | 307  | pass   | 307      | pass   | 307       | 307    | pass      | 307
`;

const GITHUB_UNCONFIGURED = `
row                            | none | master | research | jwt-ok | jwt-other | device | master+na | research+na
GET /                          | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
POST / [next-action]           | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
POST /api/projects/x/runs      | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
GET /api/lemida/commands       | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
GET /api/mobile/v1/me          | pass | pass   | pass     | pass   | pass      | pass   | pass      | 503
POST /api/mobile/v1/auth/pair  | pass | pass   | pass     | pass   | pass      | pass   | pass      | 503
POST /api/mobile/pairing-codes | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
POST /mcp                      | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
POST /research/mcp             | 503  | pass   | pass     | 503    | 503       | 503    | pass      | 503
POST /research/mcp/x           | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
POST /research/mcpx            | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
PUT /api/upload-links/<43>     | pass | pass   | pass     | pass   | pass      | pass   | pass      | 503
GET /api/upload-links/<43>     | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
PUT /api/upload-links/<42>     | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
GET /api/health                | pass | pass   | pass     | pass   | pass      | pass   | pass      | 503
GET /icons/icon-192.png        | pass | pass   | pass     | pass   | pass      | pass   | pass      | 503
POST /icons/x/documents/y      | 503  | pass   | 503      | 503    | 503       | 503    | pass      | 503
`;

const NONE = `
row                            | none | master | research | jwt-ok | jwt-other | device | master+na | research+na
GET /                          | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST / [next-action]           | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /api/projects/x/runs      | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
GET /api/lemida/commands       | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
GET /api/mobile/v1/me          | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /api/mobile/v1/auth/pair  | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /api/mobile/pairing-codes | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /mcp                      | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /research/mcp             | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /research/mcp/x           | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /research/mcpx            | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
PUT /api/upload-links/<43>     | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
GET /api/upload-links/<43>     | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
PUT /api/upload-links/<42>     | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
GET /api/health                | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
GET /icons/icon-192.png        | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
POST /icons/x/documents/y      | pass | pass   | pass     | pass   | pass      | pass   | pass      | pass
`;

beforeEach(() => {
  h.mode = 'github';
  h.configured = true;
  h.session = null;
  process.env.QUIRE_API_KEY = MASTER;
  process.env.QUIRE_RESEARCH_API_KEY = RESEARCH;
  process.env.ALLOWED_GITHUB_LOGIN = ALLOWED;
});
afterEach(() => {
  delete process.env.QUIRE_API_KEY;
  delete process.env.QUIRE_RESEARCH_API_KEY;
  delete process.env.ALLOWED_GITHUB_LOGIN;
});

describe('proxy decision matrix', () => {
  it('mode github (login configured)', async () => {
    await expectMatrix(GITHUB);
  });

  it('mode github, login not configured', async () => {
    h.configured = false;
    await expectMatrix(GITHUB_UNCONFIGURED);
  });

  it('mode none', async () => {
    h.mode = 'none';
    await expectMatrix(NONE);
  });

  it('the research key opens only POST /research/mcp (github mode)', async () => {
    const t = await actualTable();
    const head = t[0] ?? [];
    const col = (id: string) => t.slice(1).map((r) => r[head.indexOf(id)] ?? '');
    const none = col('none');
    const research = col('research');
    ROWS.forEach((row, i) => {
      const expected = row.label === 'POST /research/mcp' ? 'pass' : none[i];
      expect(research[i], row.label).toBe(expected);
    });
  });

  it('research key combined with a next-action header never passes', async () => {
    const t = await actualTable();
    const idx = (t[0] ?? []).indexOf('research+na');
    expect(t.slice(1).map((r) => r[idx])).not.toContain('pass');
  });

  it('F1 fixed (issue #111): a session for a non-allowed login is treated exactly like no session', async () => {
    const t = await actualTable();
    const head = t[0] ?? [];
    const none = head.indexOf('none');
    const other = head.indexOf('jwt-other');
    expect(t.slice(1).map((r) => r[other])).toEqual(t.slice(1).map((r) => r[none]));
  });
});

type Edge = {
  label: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  session?: unknown;
  env?: Record<string, string | undefined>;
};
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const EDGES: Edge[] = [
  { label: 'GET / session {user:{}} (no login)', method: 'GET', path: '/', session: { user: {} } },
  { label: 'GET / session {expires} (no user)', method: 'GET', path: '/', session: { expires: 'x' } },
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
    env: { QUIRE_API_KEY: '' },
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
    session: sess(ALLOWED),
  },
  {
    label: 'POST /research/mcp research key, QUIRE_RESEARCH_API_KEY unset',
    method: 'POST',
    path: '/research/mcp',
    headers: bearer(RESEARCH),
    env: { QUIRE_RESEARCH_API_KEY: undefined },
  },
  {
    label: "GET / jwt login 'OWNER' (allowed 'Owner')",
    method: 'GET',
    path: '/',
    session: sess('OWNER'),
  },
  {
    label: 'GET / jwt-ok, ALLOWED_GITHUB_LOGIN unset',
    method: 'GET',
    path: '/',
    session: sess(ALLOWED),
    env: { ALLOWED_GITHUB_LOGIN: undefined },
  },
  {
    label: 'POST /api/mobile/pairing-codes master + jwt-other',
    method: 'POST',
    path: '/api/mobile/pairing-codes',
    headers: bearer(MASTER),
    session: sess(OTHER),
  },
];

// Note: the trailing-space row is `pass` because the Headers API trims trailing whitespace from values
// before proxy ever sees it (plan predicted 401; the code is the truth).
const EDGE_EXPECTED = `
scenario                                                      | outcome
GET / session {user:{}} (no login)                            | 307
GET / session {expires} (no user)                             | 307
POST /mcp 'bearer <master>' (lowercase scheme)                | 401
POST /mcp 'Bearer <master> ' (trailing space)                 | pass
POST /mcp 'Bearer ' with QUIRE_API_KEY=''                     | 401
POST /research/mcp/ research key (trailing slash)             | 307
GET /research/mcp research key                                | pass
DELETE /research/mcp research key                             | pass
POST /api/projects/x/runs research key + jwt-ok               | pass
POST /research/mcp research key, QUIRE_RESEARCH_API_KEY unset | 401
GET / jwt login 'OWNER' (allowed 'Owner')                     | pass
GET / jwt-ok, ALLOWED_GITHUB_LOGIN unset                      | 307
POST /api/mobile/pairing-codes master + jwt-other             | pass
`;

describe('proxy edge scenarios (github mode)', () => {
  it('matches the edge table', async () => {
    const saved = { ...process.env };
    const actual: string[][] = [['scenario', 'outcome']];
    try {
      for (const e of EDGES) {
        for (const [k, v] of Object.entries(e.env ?? {})) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        actual.push([e.label, await run(e.method, e.path, e.headers ?? {}, e.session ?? null)]);
        process.env.QUIRE_API_KEY = saved.QUIRE_API_KEY;
        process.env.QUIRE_RESEARCH_API_KEY = saved.QUIRE_RESEARCH_API_KEY;
        process.env.ALLOWED_GITHUB_LOGIN = saved.ALLOWED_GITHUB_LOGIN;
      }
    } finally {
      process.env.QUIRE_API_KEY = saved.QUIRE_API_KEY;
      process.env.QUIRE_RESEARCH_API_KEY = saved.QUIRE_RESEARCH_API_KEY;
      process.env.ALLOWED_GITHUB_LOGIN = saved.ALLOWED_GITHUB_LOGIN;
    }
    const expected = table(EDGE_EXPECTED);
    expect(expected.slice(1).map((r) => r[0])).toEqual(EDGES.map((e) => e.label));
    expect(lines(actual)).toEqual(lines(expected));
  });
});
