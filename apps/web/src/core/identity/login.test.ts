import { describe, expect, it, vi } from 'vitest';
import { allowedSessionLogin, resolveWebLogin } from './login';

const sess = (login: unknown) => ({ user: { login } });

describe('allowedSessionLogin', () => {
  it.each([
    ['null', null, 'Owner', null],
    ['undefined', undefined, 'Owner', null],
    ['empty object', {}, 'Owner', null],
    ['user without login', { user: {} }, 'Owner', null],
    ['empty login', sess(''), 'Owner', null],
    ['numeric login', sess(42), 'Owner', null],
    ['allowed login', sess('Owner'), 'Owner', 'Owner'],
    ['allowed login, other casing', sess('OWNER'), 'Owner', 'OWNER'],
    ['other login', sess('mallory'), 'Owner', null],
    ['empty allow-list', sess('Owner'), '', null],
  ])('%s', (_name, session, allowed, expected) => {
    expect(allowedSessionLogin(session, allowed)).toBe(expected);
  });
});

describe('resolveWebLogin', () => {
  const make = (over: Partial<Parameters<typeof resolveWebLogin>[0]> = {}) => {
    const session = vi.fn(async () => sess('Owner') as unknown);
    const apiKeyAuthorized = vi.fn(async () => false);
    return {
      session,
      apiKeyAuthorized,
      input: { authMode: 'GitHub', allowedLogin: 'Owner', session, ...over },
    };
  };

  it("authMode 'none' is local and calls no thunk", async () => {
    const { input, session, apiKeyAuthorized } = make({ authMode: 'none' });
    expect(await resolveWebLogin({ ...input, apiKeyAuthorized })).toEqual({ kind: 'local', login: 'local' });
    expect(session).not.toHaveBeenCalled();
    expect(apiKeyAuthorized).not.toHaveBeenCalled();
  });

  it.each(['GitHub', ''])("authMode %j is not 'none'", async (authMode) => {
    const { input, session } = make({ authMode });
    expect(await resolveWebLogin(input)).toEqual({ kind: 'login', login: 'Owner' });
    expect(session).toHaveBeenCalled();
  });

  it('a matching API key resolves to api-key and never consults the session', async () => {
    const { input, session } = make();
    expect(await resolveWebLogin({ ...input, apiKeyAuthorized: async () => true })).toEqual({
      kind: 'api-key',
      login: 'api-key',
    });
    expect(session).not.toHaveBeenCalled();
  });

  it('a non-matching API key falls through to the session', async () => {
    const { input, apiKeyAuthorized } = make();
    expect(await resolveWebLogin({ ...input, apiKeyAuthorized })).toEqual({ kind: 'login', login: 'Owner' });
    expect(apiKeyAuthorized).toHaveBeenCalled();
  });

  it('without an apiKeyAuthorized thunk the result is never api-key', async () => {
    const { input } = make({ session: async () => null });
    expect(await resolveWebLogin(input)).toBeNull();
  });

  it('returns the session casing', async () => {
    const { input } = make({ session: async () => sess('OWNER') });
    expect(await resolveWebLogin(input)).toEqual({ kind: 'login', login: 'OWNER' });
  });

  it.each([
    ['other login', sess('mallory'), 'Owner'],
    ['no login', { user: {} }, 'Owner'],
    ['no session', null, 'Owner'],
    ['empty allow-list', sess('Owner'), ''],
  ])('%s resolves to null', async (_n, s, allowedLogin) => {
    const { input } = make({ session: async () => s, allowedLogin });
    expect(await resolveWebLogin(input)).toBeNull();
  });
});
