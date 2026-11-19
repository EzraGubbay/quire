import { requireDevice } from '@/lib/mobile/device-auth';
import { ok } from '@/lib/mobile/respond';
import { API_VERSION } from '@/lib/mobile/schema';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const p = a.principal;
  return ok({
    login: p.login,
    apiVersion: API_VERSION,
    device: { id: p.tokenId, name: p.deviceName, createdAt: p.createdAt.toISOString() },
  });
}
