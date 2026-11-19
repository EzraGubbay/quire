import { AUTH_MODE, auth } from '@/auth';
import { createPairingCode } from '@/lib/mobile/auth';
import { fail, ok } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

/** Mint a pairing code for the signed-in web user (`local` under AUTH_MODE=none). Session-gated by proxy.ts. */
export async function POST() {
  const login =
    AUTH_MODE === 'none' ? 'local' : ((await auth())?.user as { login?: string } | undefined)?.login;
  if (!login) return fail('unauthorized', 'Sign in to the web app to pair a device');
  const { code, expiresAt } = await createPairingCode(login);
  return ok({ code, expiresAt: expiresAt.toISOString() });
}
