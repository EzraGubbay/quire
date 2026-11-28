import { isAllowedLogin } from '@/lib/allowed-login';

/**
 * `session.user.login` when it is the allowed GitHub login (compared case-insensitively), returned in the
 * session's own casing; otherwise null. Synchronous and pure, so the proxy can use it too.
 */
export function allowedSessionLogin(session: unknown, allowedLogin: string): string | null {
  const login = (session as { user?: { login?: unknown } } | null | undefined)?.user?.login;
  return isAllowedLogin(login, allowedLogin) ? (login as string) : null;
}

export type WebLogin =
  | Readonly<{ kind: 'local'; login: 'local' }>
  | Readonly<{ kind: 'api-key'; login: 'api-key' }>
  | Readonly<{ kind: 'login'; login: string }>;

export type WebLoginInput = Readonly<{
  /** Compared with === 'none' only, as everywhere else: 'GitHub' and '' are not 'none'. */
  authMode: string;
  /** The ALLOWED_GITHUB_LOGIN value; an empty string allows nobody. */
  allowedLogin: string;
  /** Only callers that accept the master key pass this (Server Actions). Checked before the session, so the master key wins. */
  apiKeyAuthorized?: () => Promise<boolean>;
  /** Lazy: not called under authMode 'none' or when the API key matched. NextAuth is injected through it. */
  session: () => Promise<unknown>;
}>;

/** Which web login is this caller? Null means nobody the app allows. */
export async function resolveWebLogin(input: WebLoginInput): Promise<WebLogin | null> {
  if (input.authMode === 'none') return { kind: 'local', login: 'local' };
  if (input.apiKeyAuthorized && (await input.apiKeyAuthorized()))
    return { kind: 'api-key', login: 'api-key' };
  const login = allowedSessionLogin(await input.session(), input.allowedLogin);
  return login === null ? null : { kind: 'login', login };
}
