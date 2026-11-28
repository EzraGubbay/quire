import { headers } from 'next/headers';
import { resolveWebLogin } from '@/core/identity/login';
import { isApiKeyAuthorization } from '@/lib/api-key';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** Every Server Action calls this first: actions are directly POSTable, so proxy.ts alone is not enough. */
export async function requireSession(): Promise<string> {
  const resolved = await resolveWebLogin({
    // Same default as @/auth. Under AUTH_MODE=none (local dev, e2e, vitest) neither thunk runs, and @/auth is
    // imported lazily, so next-auth is never loaded and headers are never read.
    authMode: process.env.AUTH_MODE ?? 'none',
    allowedLogin: process.env.ALLOWED_GITHUB_LOGIN ?? '',
    apiKeyAuthorized: async () => isApiKeyAuthorization((await headers()).get('authorization')),
    session: async () => (await import('@/auth')).auth(),
  });
  if (resolved) return resolved.login;
  throw new UnauthorizedError();
}
