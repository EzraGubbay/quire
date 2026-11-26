import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mode: 'github' as 'none' | 'github',
  session: null as unknown,
  authz: null as string | null,
  headersCalled: 0,
}));

vi.mock('@/auth', () => ({
  auth: async () => h.session,
}));
vi.mock('next/headers', () => ({
  headers: async () => {
    h.headersCalled++;
    return new Headers(h.authz ? { authorization: h.authz } : {});
  },
}));

async function load() {
  vi.resetModules();
  return import('./require-session');
}

describe('requireSession', () => {
  afterEach(() => {
    delete process.env.AUTH_MODE;
  });

  beforeEach(() => {
    h.mode = 'github';
    process.env.AUTH_MODE = 'github';
    h.session = null;
    h.authz = null;
    h.headersCalled = 0;
    process.env.ALLOWED_GITHUB_LOGIN = 'Ezra';
    process.env.QUIRE_API_KEY = 'key';
  });

  it('AUTH_MODE none returns local without reading headers', async () => {
    process.env.AUTH_MODE = 'none';
    const { requireSession } = await load();
    await expect(requireSession()).resolves.toBe('local');
    expect(h.headersCalled).toBe(0);
  });
  it('allows the allowed login, case-insensitively', async () => {
    h.session = { user: { login: 'EZRA' } };
    const { requireSession } = await load();
    await expect(requireSession()).resolves.toBe('EZRA');
  });
  it('rejects another login', async () => {
    h.session = { user: { login: 'mallory' } };
    const { requireSession, UnauthorizedError } = await load();
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it('rejects no session', async () => {
    const { requireSession, UnauthorizedError } = await load();
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it('accepts a valid API key bearer', async () => {
    h.authz = 'Bearer key';
    const { requireSession } = await load();
    await expect(requireSession()).resolves.toBe('api-key');
  });
  it('rejects a wrong bearer', async () => {
    h.authz = 'Bearer nope';
    const { requireSession, UnauthorizedError } = await load();
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it('never lets an empty or unset key match', async () => {
    h.authz = 'Bearer ';
    const { requireSession, UnauthorizedError } = await load();
    process.env.QUIRE_API_KEY = '';
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
    delete process.env.QUIRE_API_KEY;
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
