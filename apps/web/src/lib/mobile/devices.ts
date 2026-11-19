// Server-side device listing/revocation for the Settings UI. Scoped to the signed-in owner.
import { and, eq, isNull } from 'drizzle-orm';
import { AUTH_MODE, auth } from '@/auth';
import { db } from '@/db/client';
import { mobileTokens } from '@/db/schema';
import { revokeToken } from './auth';
import { type DeviceView, shapeDevices } from './pairing-ui';

/** Web-session login (`local` under AUTH_MODE=none), or null when signed out. */
export async function currentWebLogin(): Promise<string | null> {
  if (AUTH_MODE === 'none') return 'local';
  return ((await auth())?.user as { login?: string } | undefined)?.login ?? null;
}

export async function listDevices(ownerLogin: string): Promise<DeviceView[]> {
  const rows = await db
    .select({
      id: mobileTokens.id,
      deviceName: mobileTokens.deviceName,
      createdAt: mobileTokens.createdAt,
      lastUsedAt: mobileTokens.lastUsedAt,
      revokedAt: mobileTokens.revokedAt,
    })
    .from(mobileTokens)
    .where(and(eq(mobileTokens.ownerLogin, ownerLogin), isNull(mobileTokens.revokedAt)));
  return shapeDevices(rows);
}

/** Revoke a device only if it belongs to `ownerLogin`. */
export async function revokeOwnedDevice(ownerLogin: string, id: string): Promise<void> {
  const [row] = await db
    .select({ id: mobileTokens.id })
    .from(mobileTokens)
    .where(and(eq(mobileTokens.id, id), eq(mobileTokens.ownerLogin, ownerLogin)))
    .limit(1);
  if (row) await revokeToken(row.id);
}
