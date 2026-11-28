import { createPairingCode } from '@/lib/mobile/auth';
import { currentWebLogin } from '@/lib/mobile/devices';
import { fail, ok } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

/** Mint a pairing code for the signed-in web user (`local` under AUTH_MODE=none). Session-gated by proxy.ts. */
export async function POST() {
  const login = await currentWebLogin();
  if (!login) return fail('unauthorized', 'Sign in to the web app to pair a device');
  const { code, expiresAt } = await createPairingCode(login);
  return ok({ code, expiresAt: expiresAt.toISOString() });
}
