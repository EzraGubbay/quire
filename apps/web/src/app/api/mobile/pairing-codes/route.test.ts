// @vitest-environment node
// The pairing route resolves its owner through currentWebLogin, so these cases also cover that function.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mode: 'GitHub' as string, session: null as unknown }));
vi.mock('@/auth', () => ({
  get AUTH_MODE() {
    return h.mode;
  },
  auth: async () => h.session,
}));
vi.mock('@/db/client', () => ({ db: {} }));
const mint = vi.hoisted(() =>
  vi.fn(async (_login: string) => ({ code: 'ABCD2345', expiresAt: new Date(0) })),
);
vi.mock('@/lib/mobile/auth', () => ({ createPairingCode: mint, revokeToken: vi.fn() }));

import { POST } from './route';

const sess = (login?: string) => ({ user: { login } });

describe('POST /api/mobile/pairing-codes', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ALLOWED_GITHUB_LOGIN;
    process.env.ALLOWED_GITHUB_LOGIN = 'Owner';
    h.mode = 'GitHub';
    h.session = null;
    mint.mockClear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_GITHUB_LOGIN;
    else process.env.ALLOWED_GITHUB_LOGIN = saved;
  });

  it.each([
    ['mode none', 'none', null, 'local'],
    ['allowed login', 'GitHub', sess('Owner'), 'Owner'],
    ['allowed login, other casing', 'GitHub', sess('OWNER'), 'OWNER'],
  ])('%s mints a code for %s', async (_n, mode, session, expected) => {
    h.mode = mode;
    h.session = session;
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 'ABCD2345', expiresAt: new Date(0).toISOString() });
    expect(mint).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['a non-allowed login', sess('mallory')],
    ['a session without a login', sess(undefined)],
    ['no session', null],
  ])('refuses %s', async (_n, session) => {
    h.session = session;
    const res = await POST();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(mint).not.toHaveBeenCalled();
  });

  it('refuses the allowed login when ALLOWED_GITHUB_LOGIN is unset', async () => {
    delete process.env.ALLOWED_GITHUB_LOGIN;
    h.session = sess('Owner');
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mint).not.toHaveBeenCalled();
  });
});
