// Push outbox (ADR 0003 §1, §3.2–§3.3): one row per (event, registration). `enqueuePush` is the only entry point for
// triggers (S2b); it filters by category server-side, dedupes on (registration_id, dedupe_key) and slides a
// coalescing group's unbatched rows later, never earlier. It never throws into its caller.
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { mobileTokens, mobilePushOutbox as outbox, mobilePushRegistrations as regs } from '@/db/schema';
import { type PushConfig, pushConfig } from './config';
import type { PushCategory, PushEvent } from './events';

/** A group's first row waits this long for more; each enqueue pushes the group out again… */
export const COALESCE_DELAY_MS = 90_000;
/** …but never past the oldest unbatched row's `created_at` + this. */
export const COALESCE_CAP_MS = 10 * 60 * 1000;

export interface OutboxRow {
  id: string;
  registrationId: string;
  type: string;
  dedupeKey: string;
  groupKey: string | null;
  batchId: string | null;
  data: Record<string, string>;
  priority: string;
  expiresAt: Date;
  notBefore: Date;
  attempts: number;
  createdAt: Date;
  sentAt: Date | null;
  deadAt: Date | null;
  lastError: string | null;
}

/** A pending row joined with its registration's FCM token (only for devices whose token is not revoked). */
export interface DueRow extends OutboxRow {
  fcmToken: string;
}

export type NewOutboxRow = Pick<
  OutboxRow,
  'registrationId' | 'type' | 'dedupeKey' | 'groupKey' | 'data' | 'priority' | 'expiresAt'
> &
  Partial<Pick<OutboxRow, 'batchId' | 'notBefore' | 'sentAt' | 'deadAt' | 'lastError' | 'attempts'>>;

/** Persistence seam for the outbox and the registration updates the dispatcher makes. */
export interface OutboxStore {
  /** Registration ids of these owners whose device token is active and whose categories include `category`. */
  targets(owners: readonly string[], category: PushCategory): Promise<string[]>;
  /** Insert with ON CONFLICT (registration_id, dedupe_key) DO NOTHING; true when a row was inserted. */
  insert(row: NewOutboxRow, now: Date): Promise<boolean>;
  /**
   * The group's unbatched pending rows → `not_before = greatest(not_before, least(now + 90 s, oldest created_at +
   * 10 min))`. Only ever later.
   */
  slideGroup(registrationId: string, groupKey: string, now: Date): Promise<void>;
  /** Pending rows with `not_before <= now`, oldest first, for active registrations only. */
  due(now: Date, limit: number): Promise<DueRow[]>;
  /** Whether a frozen batch of this (registration, group) is still pending (awaiting retry). */
  hasPendingBatch(registrationId: string, groupKey: string): Promise<boolean>;
  /** Stamp `batch_id` on exactly these ids where it is still null; returns the ids stamped. */
  stampBatch(ids: readonly string[], batchId: string): Promise<string[]>;
  /** Every pending row of a batch (loaded by `batch_id`, not from a limited selection). */
  batchRows(batchId: string): Promise<DueRow[]>;
  markSent(batchId: string, now: Date): Promise<void>;
  markBatchDead(batchId: string, now: Date, code: string): Promise<void>;
  markRowsDead(ids: readonly string[], now: Date, code: string): Promise<void>;
  retryBatch(batchId: string, attempts: number, notBefore: Date): Promise<void>;
  /** Delete rows sent/dead before `before`, and stale pending rows that expired before it. */
  purge(before: Date): Promise<number>;
  deleteRegistration(registrationId: string): Promise<void>;
  registrationSent(registrationId: string, now: Date): Promise<void>;
  registrationError(registrationId: string, code: string): Promise<void>;
}

/** A thrown error's SQLSTATE (also from `cause`: drizzle wraps PG errors) or class only: messages can quote values. */
export const errTag = (e: unknown) => {
  const x = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  return String(
    (typeof x?.code === 'string' && x.code) ||
      (typeof x?.cause?.code === 'string' && x.cause.code) ||
      (typeof x?.name === 'string' && x.name) ||
      'Error',
  );
};

/**
 * Enqueue one event for every matching registration of `audience` (owner logins). No-op when push is disabled,
 * for events without a category (push.test is sent synchronously) or already expired. Returns rows inserted.
 */
export async function enqueuePush(
  audience: readonly string[],
  event: PushEvent,
  deps: { store?: OutboxStore; config?: () => PushConfig; now?: Date } = {},
): Promise<number> {
  try {
    if (!(deps.config ?? pushConfig)().enabled) return 0;
    if (!event.category || audience.length === 0 || event.ttlSeconds <= 0) return 0;
    const store = deps.store ?? dbOutbox;
    const now = deps.now ?? new Date();
    const expiresAt = new Date(now.getTime() + event.ttlSeconds * 1000);
    let inserted = 0;
    for (const registrationId of await store.targets(audience, event.category)) {
      const ok = await store.insert(
        {
          registrationId,
          type: event.type,
          dedupeKey: event.dedupeKey,
          groupKey: event.groupKey,
          data: event.data,
          priority: event.priority,
          expiresAt,
          // ADR §1: a grouped row starts at now + 90 s; the slide below only ever moves it later.
          notBefore: event.groupKey ? new Date(now.getTime() + COALESCE_DELAY_MS) : now,
        },
        now,
      );
      if (!ok) continue;
      inserted++;
      if (event.groupKey) await store.slideGroup(registrationId, event.groupKey, now);
    }
    return inserted;
  } catch (e) {
    console.warn(`[push] enqueue failed (${errTag(e)})`);
    return 0;
  }
}

const pending = and(isNull(outbox.sentAt), isNull(outbox.deadAt));
const unbatchedGroup = (registrationId: string, groupKey: string) =>
  and(
    eq(outbox.registrationId, registrationId),
    eq(outbox.groupKey, groupKey),
    isNull(outbox.batchId),
    pending,
  );

const dueColumns = {
  id: outbox.id,
  registrationId: outbox.registrationId,
  type: outbox.type,
  dedupeKey: outbox.dedupeKey,
  groupKey: outbox.groupKey,
  batchId: outbox.batchId,
  data: outbox.data,
  priority: outbox.priority,
  expiresAt: outbox.expiresAt,
  notBefore: outbox.notBefore,
  attempts: outbox.attempts,
  createdAt: outbox.createdAt,
  sentAt: outbox.sentAt,
  deadAt: outbox.deadAt,
  lastError: outbox.lastError,
  fcmToken: regs.fcmToken,
};

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

// Single-process assumption (ADR Consequences): a second replica would need `FOR UPDATE SKIP LOCKED` in `due`.
export const dbOutbox: OutboxStore = {
  async targets(owners, category) {
    const rows = await db
      .select({ id: regs.id })
      .from(regs)
      .innerJoin(mobileTokens, eq(mobileTokens.id, regs.tokenId))
      .where(
        and(
          inArray(mobileTokens.ownerLogin, [...owners]),
          isNull(mobileTokens.revokedAt),
          sql`${category} = ANY(${regs.categories})`,
        ),
      );
    return rows.map((r) => r.id);
  },
  async insert(row, now) {
    const got = await db
      .insert(outbox)
      .values({ ...row, notBefore: row.notBefore ?? now, createdAt: now })
      .onConflictDoNothing({ target: [outbox.registrationId, outbox.dedupeKey] })
      .returning({ id: outbox.id });
    return got.length > 0;
  },
  async slideGroup(registrationId, groupKey, now) {
    const oldest = sql`(SELECT min(o2.created_at) FROM mobile_push_outbox o2 WHERE o2.registration_id = ${registrationId}
      AND o2.group_key = ${groupKey} AND o2.batch_id IS NULL AND o2.sent_at IS NULL AND o2.dead_at IS NULL)`;
    const target = sql`least(${ts(new Date(now.getTime() + COALESCE_DELAY_MS))}, ${oldest} + ${sql.raw(`interval '${COALESCE_CAP_MS / 1000} seconds'`)})`;
    await db
      .update(outbox)
      .set({ notBefore: sql`greatest(${outbox.notBefore}, ${target})` })
      .where(unbatchedGroup(registrationId, groupKey));
  },
  async due(now, limit) {
    return db
      .select(dueColumns)
      .from(outbox)
      .innerJoin(regs, eq(regs.id, outbox.registrationId))
      .innerJoin(mobileTokens, and(eq(mobileTokens.id, regs.tokenId), isNull(mobileTokens.revokedAt)))
      .where(and(pending, lte(outbox.notBefore, now)))
      .orderBy(outbox.notBefore, outbox.createdAt)
      .limit(limit);
  },
  async hasPendingBatch(registrationId, groupKey) {
    const [row] = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.registrationId, registrationId),
          eq(outbox.groupKey, groupKey),
          isNotNull(outbox.batchId),
          pending,
        ),
      )
      .limit(1);
    return !!row;
  },
  async stampBatch(ids, batchId) {
    if (ids.length === 0) return [];
    const rows = await db
      .update(outbox)
      .set({ batchId })
      .where(and(inArray(outbox.id, [...ids]), isNull(outbox.batchId), pending))
      .returning({ id: outbox.id });
    return rows.map((r) => r.id);
  },
  async batchRows(batchId) {
    return db
      .select(dueColumns)
      .from(outbox)
      .innerJoin(regs, eq(regs.id, outbox.registrationId))
      .innerJoin(mobileTokens, and(eq(mobileTokens.id, regs.tokenId), isNull(mobileTokens.revokedAt)))
      .where(and(eq(outbox.batchId, batchId), pending))
      .orderBy(outbox.createdAt);
  },
  async markSent(batchId, now) {
    await db
      .update(outbox)
      .set({ sentAt: now })
      .where(and(eq(outbox.batchId, batchId), pending));
  },
  async markBatchDead(batchId, now, code) {
    await db
      .update(outbox)
      .set({ deadAt: now, lastError: code })
      .where(and(eq(outbox.batchId, batchId), pending));
  },
  async markRowsDead(ids, now, code) {
    if (ids.length === 0) return;
    await db
      .update(outbox)
      .set({ deadAt: now, lastError: code })
      .where(and(inArray(outbox.id, [...ids]), pending));
  },
  async retryBatch(batchId, attempts, notBefore) {
    await db
      .update(outbox)
      .set({ attempts, notBefore })
      .where(and(eq(outbox.batchId, batchId), pending));
  },
  async purge(before) {
    const rows = await db
      .delete(outbox)
      .where(
        or(lt(outbox.sentAt, before), lt(outbox.deadAt, before), and(pending, lt(outbox.expiresAt, before))),
      )
      .returning({ id: outbox.id });
    return rows.length;
  },
  async deleteRegistration(registrationId) {
    await db.delete(regs).where(eq(regs.id, registrationId));
  },
  async registrationSent(registrationId, now) {
    await db.update(regs).set({ lastSentAt: now }).where(eq(regs.id, registrationId));
  },
  async registrationError(registrationId, code) {
    await db.update(regs).set({ lastError: code }).where(eq(regs.id, registrationId));
  },
};
