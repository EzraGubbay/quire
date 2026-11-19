// Per-device token auth for /api/mobile/v1. Raw tokens and pairing codes are never stored: only their
// SHA-256 hashes. Identity is the `ownerLogin` bound to the code at mint time and carried on the token,
// so nothing here assumes a single user.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { mobilePairingCodes, mobileTokens } from '@/db/schema';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
// Unambiguous (no 0/O/1/I/L) so it is easy to type from a screen; a subset of [0-9A-Za-z].
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface TokenRow {
  id: string;
  ownerLogin: string;
  deviceName: string;
  tokenHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface Principal {
  login: string;
  tokenId: string;
  deviceName: string;
  createdAt: Date;
}

/** Persistence seam; the SQL implementation is `dbStore`, tests use an in-memory one. */
export interface AuthStore {
  insertCode(codeHash: string, ownerLogin: string, expiresAt: Date): Promise<void>;
  /** Atomically mark an unused, unexpired code used and return its owner; null if none. */
  consumeCode(codeHash: string, now: Date): Promise<string | null>;
  insertToken(row: { ownerLogin: string; deviceName: string; tokenHash: string }): Promise<TokenRow>;
  findActiveByHash(tokenHash: string): Promise<TokenRow | null>;
  touch(id: string, now: Date): Promise<void>;
  revoke(id: string, now: Date): Promise<void>;
}

export const hashSecret = (s: string): string => createHash('sha256').update(s).digest('hex');

const normalizeCode = (code: string) => code.trim().toUpperCase();

export const dbStore: AuthStore = {
  async insertCode(codeHash, ownerLogin, expiresAt) {
    await db.insert(mobilePairingCodes).values({ codeHash, ownerLogin, expiresAt });
  },
  async consumeCode(codeHash, now) {
    // Single statement: concurrent exchanges of one code can win at most once.
    const [row] = await db
      .update(mobilePairingCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(mobilePairingCodes.codeHash, codeHash),
          isNull(mobilePairingCodes.usedAt),
          gt(mobilePairingCodes.expiresAt, now),
        ),
      )
      .returning({ ownerLogin: mobilePairingCodes.ownerLogin });
    return row?.ownerLogin ?? null;
  },
  async insertToken(row) {
    const [t] = await db.insert(mobileTokens).values(row).returning();
    if (!t) throw new Error('mobile token insert returned no row');
    return t;
  },
  async findActiveByHash(tokenHash) {
    const [t] = await db
      .select()
      .from(mobileTokens)
      .where(and(eq(mobileTokens.tokenHash, tokenHash), isNull(mobileTokens.revokedAt)))
      .limit(1);
    return t ?? null;
  },
  async touch(id, now) {
    await db.update(mobileTokens).set({ lastUsedAt: now }).where(eq(mobileTokens.id, id));
  },
  async revoke(id, now) {
    await db
      .update(mobileTokens)
      .set({ revokedAt: now })
      .where(and(eq(mobileTokens.id, id), isNull(mobileTokens.revokedAt)));
  },
};

export async function createPairingCode(
  ownerLogin: string,
  store: AuthStore = dbStore,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
  await store.insertCode(hashSecret(code), ownerLogin, expiresAt);
  return { code, expiresAt };
}

/** Exchange a code for a device token (returned raw, exactly once). Null if invalid, used or expired. */
export async function exchangePairingCode(
  code: string,
  deviceName: string,
  store: AuthStore = dbStore,
  now: Date = new Date(),
): Promise<{ token: string; device: { id: string; name: string; createdAt: string } } | null> {
  const ownerLogin = await store.consumeCode(hashSecret(normalizeCode(code)), now);
  if (!ownerLogin) return null;
  const token = randomBytes(32).toString('base64url');
  const row = await store.insertToken({ ownerLogin, deviceName, tokenHash: hashSecret(token) });
  return { token, device: { id: row.id, name: row.deviceName, createdAt: row.createdAt.toISOString() } };
}

/** Resolve `Authorization: Bearer <token>` to a Principal, or null (missing, wrong or revoked). */
export async function authenticate(
  req: Request,
  store: AuthStore = dbStore,
  now: Date = new Date(),
): Promise<Principal | null> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '');
  if (!m) return null;
  const row = await store.findActiveByHash(hashSecret(m[1] as string));
  if (!row) return null;
  await store.touch(row.id, now);
  return { login: row.ownerLogin, tokenId: row.id, deviceName: row.deviceName, createdAt: row.createdAt };
}

export async function revokeToken(tokenId: string, store: AuthStore = dbStore, now: Date = new Date()) {
  await store.revoke(tokenId, now);
}
