import { requireDevice } from '@/lib/mobile/device-auth';
import { fail } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

// Fallback for v1 paths with no handler yet. proxy.ts lets /api/mobile/v1/ through unauthenticated, so
// this guarantees unknown paths still answer 401 (no token) or a JSON 404, never an unauthenticated page.
async function handle(req: Request) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  return fail('not_found', 'No such endpoint');
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
