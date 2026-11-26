import { headers } from 'next/headers';
import { isAllowedLogin } from '@/lib/allowed-login';
import { isApiKeyAuthorization } from '@/lib/api-key';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** Every Server Action calls this first: actions are directly POSTable, so proxy.ts alone is not enough. */
export async function requireSession(): Promise<string> {
  // Same default as @/auth. Checked first, and @/auth is imported lazily, so AUTH_MODE=none (local dev, e2e,
  // vitest) never loads next-auth or reads headers.
  if ((process.env.AUTH_MODE ?? 'none') === 'none') return 'local';
  const { auth } = await import('@/auth');
  if (isApiKeyAuthorization((await headers()).get('authorization'))) return 'api-key';
  const login = ((await auth())?.user as { login?: string } | undefined)?.login;
  if (isAllowedLogin(login)) return login as string;
  throw new UnauthorizedError();
}
