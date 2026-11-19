// Shared guard for every /api/mobile/v1 handler except auth/pair.
import { authenticate, type Principal } from './auth';
import { fail } from './respond';

export async function requireDevice(
  req: Request,
  authFn: (req: Request) => Promise<Principal | null> = authenticate,
): Promise<{ principal: Principal } | { response: Response }> {
  const principal = await authFn(req);
  if (principal) return { principal };
  const response = fail('unauthorized', 'Missing, invalid or revoked device token');
  response.headers.set('WWW-Authenticate', 'Bearer');
  return { response };
}
