import { revokeToken } from '@/lib/mobile/auth';
import { requireDevice } from '@/lib/mobile/device-auth';

export const dynamic = 'force-dynamic';

/** Revoke the calling device's token. */
export async function DELETE(req: Request) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  await revokeToken(a.principal.tokenId);
  return new Response(null, { status: 204 });
}
