// Push registrations (ADR 0003 §3.1–§3.3): one per paired device, keyed by the calling `mobile_tokens` row. The
// FCM token is a device secret: it is stored, sent to FCM and nothing else (never returned, never logged).
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { mobilePushRegistrations as regs } from '@/db/schema';
import { PUSH_CATEGORIES, type PushCategory } from './events';

export interface RegistrationInput {
  fcmToken: string;
  platform: 'android';
  appVersion: string | null;
  categories: PushCategory[];
}

export interface RegistrationRow {
  id: string;
  tokenId: string;
  fcmToken: string;
  platform: string;
  appVersion: string | null;
  categories: string[];
  createdAt: Date;
  updatedAt: Date;
  lastSentAt: Date | null;
  lastError: string | null;
}

/** Persistence seam; the SQL implementation is `dbRegistrations`, tests use `memoryPushStore()`. */
export interface RegistrationStore {
  /**
   * Create or refresh the device's registration. The same input leaves `updatedAt` unchanged (idempotent). A row
   * holding the same FCM token under another device is deleted first: a token belongs to exactly one device.
   */
  upsert(tokenId: string, input: RegistrationInput, now: Date): Promise<RegistrationRow>;
  getByTokenId(tokenId: string): Promise<RegistrationRow | null>;
  deleteByTokenId(tokenId: string): Promise<void>;
}

/** Known categories only, duplicates collapsed, in canonical order; unknown values are ignored. */
export function normalizeCategories(input: readonly string[]): PushCategory[] {
  const set = new Set(input);
  return PUSH_CATEGORIES.filter((c) => set.has(c));
}

export const dbRegistrations: RegistrationStore = {
  async upsert(tokenId, input, now) {
    return db.transaction(async (tx) => {
      await tx.delete(regs).where(and(eq(regs.fcmToken, input.fcmToken), ne(regs.tokenId, tokenId)));
      const at = sql`${now.toISOString()}::timestamptz`;
      const changed = sql`(${regs.fcmToken}, ${regs.platform}, ${regs.appVersion}, ${regs.categories})
        IS DISTINCT FROM (excluded.fcm_token, excluded.platform, excluded.app_version, excluded.categories)`;
      const [row] = await tx
        .insert(regs)
        .values({ tokenId, ...input, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: regs.tokenId,
          set: {
            fcmToken: sql`excluded.fcm_token`,
            platform: sql`excluded.platform`,
            appVersion: sql`excluded.app_version`,
            categories: sql`excluded.categories`,
            updatedAt: sql`CASE WHEN ${changed} THEN ${at} ELSE ${regs.updatedAt} END`,
            // A new FCM token starts clean; the same token keeps its last error.
            lastError: sql`CASE WHEN ${regs.fcmToken} IS DISTINCT FROM excluded.fcm_token THEN NULL ELSE ${regs.lastError} END`,
          },
        })
        .returning();
      if (!row) throw new Error('push registration upsert returned no row');
      return row;
    });
  },
  async getByTokenId(tokenId) {
    const [row] = await db.select().from(regs).where(eq(regs.tokenId, tokenId)).limit(1);
    return row ?? null;
  },
  async deleteByTokenId(tokenId) {
    await db.delete(regs).where(eq(regs.tokenId, tokenId));
  },
};
