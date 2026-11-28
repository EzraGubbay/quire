// @vitest-environment node
// Characterization of requireSession() outcomes: modes x credentials, plus edge scenarios, as explicit tables.
// Any diff in a table is a behaviour change and must be intentional (listed in the PR that makes it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  session: null as unknown,
  headers: {} as Record<string, string>,
  headersCalls: 0,
  authCalls: 0,
}));
vi.mock('next/headers', () => ({
  headers: async () => {
    h.headersCalls++;
    return new Headers(h.headers);
  },
}));
vi.mock('@/auth', () => ({
  auth: async () => {
    h.authCalls++;
    return h.session;
  },
}));

const MASTER = 'qk_test_master';
const RESEARCH = 'qk_r_test_research';
const ALLOWED = 'Owner';
const OTHER = 'mallory';
const DEVICE = `dEv1ce_${'x'.repeat(36)}`;
const NA = { 'next-action': '0'.repeat(40) };

const sess = (login?: string) => ({ user: { login }, expires: '2099-01-01T00:00:00.000Z' });

type Cred = { id: string; headers: Record<string, string>; session: unknown };
const CREDS: Cred[] = [
  { id: 'none', headers: {}, session: null },
  { id: 'master', headers: { authorization: `Bearer ${MASTER}` }, session: null },
  { id: 'research', headers: { authorization: `Bearer ${RESEARCH}` }, session: null },
  { id: 'jwt-ok', headers: {}, session: sess(ALLOWED) },
  { id: 'jwt-other', headers: {}, session: sess(OTHER) },
  { id: 'device', headers: { authorization: `Bearer ${DEVICE}` }, session: null },
  { id: 'master+na', headers: { authorization: `Bearer ${MASTER}`, ...NA }, session: null },
  { id: 'research+na', headers: { authorization: `Bearer ${RESEARCH}`, ...NA }, session: null },
];

async function outcome(): Promise<string> {
  vi.resetModules();
  const { requireSession, UnauthorizedError } = await import('./require-session');
  try {
    const r = await requireSession();
    return r === 'local' || r === 'api-key' ? r : `login:${r}`;
  } catch (e) {
    return e instanceof UnauthorizedError ? 'throw' : `other:${(e as Error)?.name}`;
  }
}

function table(src: string): string[][] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()));
}
const lines = (rows: string[][]) => rows.map((r) => r.join(' | '));

const MODES: { label: string; mode: string | undefined }[] = [
  { label: 'AUTH_MODE=none', mode: 'none' },
  { label: 'AUTH_MODE unset', mode: undefined },
  { label: 'AUTH_MODE=github', mode: 'github' },
  { label: 'AUTH_MODE=GitHub', mode: 'GitHub' },
];

const MODE_EXPECTED = `
mode             | none  | master  | research | jwt-ok      | jwt-other | device | master+na | research+na
AUTH_MODE=none   | local | local   | local    | local       | local     | local  | local     | local
AUTH_MODE unset  | local | local   | local    | local       | local     | local  | local     | local
AUTH_MODE=github | throw | api-key | throw    | login:Owner | throw     | throw  | api-key   | throw
AUTH_MODE=GitHub | throw | api-key | throw    | login:Owner | throw     | throw  | api-key   | throw
`;

function setMode(mode: string | undefined) {
  if (mode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = mode;
}

beforeEach(() => {
  h.session = null;
  h.headers = {};
  h.headersCalls = 0;
  h.authCalls = 0;
  process.env.ALLOWED_GITHUB_LOGIN = ALLOWED;
  process.env.QUIRE_API_KEY = MASTER;
  process.env.QUIRE_RESEARCH_API_KEY = RESEARCH;
});
afterEach(() => {
  delete process.env.AUTH_MODE;
  delete process.env.ALLOWED_GITHUB_LOGIN;
  delete process.env.QUIRE_API_KEY;
  delete process.env.QUIRE_RESEARCH_API_KEY;
});

describe('requireSession decision matrix', () => {
  it('modes x credentials', async () => {
    const actual: string[][] = [['mode', ...CREDS.map((c) => c.id)]];
    const sideEffects: Record<string, { headers: number; auth: number }> = {};
    for (const m of MODES) {
      setMode(m.mode);
      h.headersCalls = 0;
      h.authCalls = 0;
      const row = [m.label];
      for (const c of CREDS) {
        h.headers = c.headers;
        h.session = c.session;
        row.push(await outcome());
      }
      sideEffects[m.label] = { headers: h.headersCalls, auth: h.authCalls };
      actual.push(row);
    }
    const expected = table(MODE_EXPECTED);
    expect(expected[0]).toEqual(['mode', ...CREDS.map((c) => c.id)]);
    expect(expected.slice(1).map((r) => r[0])).toEqual(MODES.map((m) => m.label));
    expect(lines(actual)).toEqual(lines(expected));
    // AUTH_MODE none/unset never reads headers or loads/calls auth.
    expect(sideEffects['AUTH_MODE=none']).toEqual({ headers: 0, auth: 0 });
    expect(sideEffects['AUTH_MODE unset']).toEqual({ headers: 0, auth: 0 });
  });
});

type Edge = {
  label: string;
  headers?: Record<string, string>;
  session?: unknown;
  env?: Record<string, string | undefined>;
};
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const EDGES: Edge[] = [
  { label: 'master bearer + jwt-other session', headers: bearer(MASTER), session: sess(OTHER) },
  { label: 'master bearer + jwt-ok session', headers: bearer(MASTER), session: sess(ALLOWED) },
  { label: 'research bearer + jwt-ok session', headers: bearer(RESEARCH), session: sess(ALLOWED) },
  { label: 'device bearer + jwt-ok session', headers: bearer(DEVICE), session: sess(ALLOWED) },
  { label: "jwt login 'OWNER' (allowed 'Owner')", session: sess('OWNER') },
  { label: 'session {user:{}} (no login)', session: { user: {} } },
  { label: 'session {expires} (no user)', session: { expires: 'x' } },
  { label: "jwt-ok, ALLOWED_GITHUB_LOGIN=''", session: sess(ALLOWED), env: { ALLOWED_GITHUB_LOGIN: '' } },
  {
    label: "login '' and ALLOWED_GITHUB_LOGIN=''",
    session: sess(''),
    env: { ALLOWED_GITHUB_LOGIN: '' },
  },
  {
    label: 'jwt-ok, ALLOWED_GITHUB_LOGIN unset',
    session: sess(ALLOWED),
    env: { ALLOWED_GITHUB_LOGIN: undefined },
  },
  {
    label: "'Bearer ' with QUIRE_API_KEY=''",
    headers: { authorization: 'Bearer ' },
    env: { QUIRE_API_KEY: '' },
  },
  {
    label: "'Bearer ' with QUIRE_API_KEY unset",
    headers: { authorization: 'Bearer ' },
    env: { QUIRE_API_KEY: undefined },
  },
  { label: "'bearer <master>' (lowercase scheme)", headers: { authorization: `bearer ${MASTER}` } },
  { label: "'Bearer <master> ' (trailing space)", headers: { authorization: `Bearer ${MASTER} ` } },
];

// Note: the trailing-space row is `api-key` because the Headers API trims trailing whitespace from values
// before requireSession reads it (plan predicted throw; the code is the truth).
const EDGE_EXPECTED = `
scenario                                  | outcome
master bearer + jwt-other session         | api-key
master bearer + jwt-ok session            | api-key
research bearer + jwt-ok session          | login:Owner
device bearer + jwt-ok session            | login:Owner
jwt login 'OWNER' (allowed 'Owner')       | login:OWNER
session {user:{}} (no login)              | throw
session {expires} (no user)               | throw
jwt-ok, ALLOWED_GITHUB_LOGIN=''           | throw
login '' and ALLOWED_GITHUB_LOGIN=''      | throw
jwt-ok, ALLOWED_GITHUB_LOGIN unset        | throw
'Bearer ' with QUIRE_API_KEY=''           | throw
'Bearer ' with QUIRE_API_KEY unset        | throw
'bearer <master>' (lowercase scheme)      | throw
'Bearer <master> ' (trailing space)       | api-key
`;

describe('requireSession edge scenarios (AUTH_MODE=github)', () => {
  it('matches the edge table', async () => {
    process.env.AUTH_MODE = 'github';
    const actual: string[][] = [['scenario', 'outcome']];
    for (const e of EDGES) {
      process.env.ALLOWED_GITHUB_LOGIN = ALLOWED;
      process.env.QUIRE_API_KEY = MASTER;
      for (const [k, v] of Object.entries(e.env ?? {})) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      h.headers = e.headers ?? {};
      h.session = e.session ?? null;
      actual.push([e.label, await outcome()]);
    }
    const expected = table(EDGE_EXPECTED);
    expect(expected.slice(1).map((r) => r[0])).toEqual(EDGES.map((e) => e.label));
    expect(lines(actual)).toEqual(lines(expected));
  });
});
