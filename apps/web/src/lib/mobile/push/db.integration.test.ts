// @vitest-environment node
// The SQL stores against a real, migrated Postgres. Opt-in so `pnpm test` never needs a database:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run src/lib/mobile/push/db.integration
// Every row it creates belongs to a run-unique owner and is deleted afterwards; it never truncates.
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSql } from '@/db/client';
import { mobilePushOutbox, mobilePushRegistrations, mobileTokens } from '@/db/schema';
import { dbStore } from '../auth';
import type { PushConfig } from './config';
import { backoffMs, dispatchDue, sendTestPush } from './dispatcher';
import { filesAdded, noteSynthesized } from './events';
import { COALESCE_DELAY_MS, dbOutbox, enqueuePush } from './outbox';
import { dbRegistrations } from './registrations';
import { fakeTransport } from './transport';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const OWNER = `push-it-${randomUUID()}`;
const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (ms: number) => new Date(t0.getTime() + ms);
const course = { courseSlug: 'signals', courseId: randomUUID() };
const file = (n: number) => filesAdded({ ...course, fileId: `doc-${n}`, lemidaFileId: `${OWNER}-lf-${n}` });

async function device() {
  const [t] = await db
    .insert(mobileTokens)
    .values({ ownerLogin: OWNER, deviceName: 'it', tokenHash: randomUUID() })
    .returning();
  return t as typeof mobileTokens.$inferSelect;
}
const register = (
  tokenId: string,
  fcmToken = `fcm-${randomUUID()}`,
  categories = ['files', 'notes'] as const,
) =>
  dbRegistrations.upsert(
    tokenId,
    { fcmToken, platform: 'android', appVersion: '1.1.0', categories: [...categories] },
    t0,
  );
const rowsOf = (registrationId: string) =>
  db
    .select()
    .from(mobilePushOutbox)
    .where(eq(mobilePushOutbox.registrationId, registrationId))
    .orderBy(mobilePushOutbox.createdAt);

async function cleanup() {
  const ids = (
    await db.select({ id: mobileTokens.id }).from(mobileTokens).where(eq(mobileTokens.ownerLogin, OWNER))
  ).map((r) => r.id);
  if (ids.length) await db.delete(mobileTokens).where(inArray(mobileTokens.id, ids)); // cascades registrations + outbox
}

describe.skipIf(!run)('push SQL stores (integration)', () => {
  beforeEach(async () => {
    await cleanup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await getSql().end();
  });

  it('migration: both tables, the unique dedupe index, the partial due index and the batch index', async () => {
    const idx = await db.execute<{ indexname: string; indexdef: string }>(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'mobile_push_outbox'`,
    );
    const byName = new Map([...idx].map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('mobile_push_outbox_registration_dedupe_uq')).toMatch(
      /UNIQUE.*\(registration_id, dedupe_key\)/,
    );
    expect(byName.get('mobile_push_outbox_due_idx')).toMatch(
      /\(not_before\) WHERE \(\(sent_at IS NULL\) AND \(dead_at IS NULL\)\)/,
    );
    expect(byName.get('mobile_push_outbox_batch_idx')).toMatch(/\(batch_id\)/);
  });

  it('upsert is idempotent, bumps updatedAt only on change, and moves a token to the calling device', async () => {
    const a = await device();
    const first = await register(a.id, `fcm-shared-${OWNER}`);
    const again = await dbRegistrations.upsert(
      a.id,
      {
        fcmToken: `fcm-shared-${OWNER}`,
        platform: 'android',
        appVersion: '1.1.0',
        categories: ['files', 'notes'],
      },
      at(60_000),
    );
    expect(again).toMatchObject({ id: first.id, updatedAt: first.updatedAt, createdAt: first.createdAt });
    const changed = await dbRegistrations.upsert(
      a.id,
      { fcmToken: `fcm-shared-${OWNER}`, platform: 'android', appVersion: '1.1.0', categories: ['files'] },
      at(120_000),
    );
    expect(changed.updatedAt).toEqual(at(120_000));
    expect(changed.categories).toEqual(['files']);

    const b = await device();
    await register(b.id, `fcm-shared-${OWNER}`);
    expect(await dbRegistrations.getByTokenId(a.id)).toBeNull();
    expect((await dbRegistrations.getByTokenId(b.id))?.fcmToken).toBe(`fcm-shared-${OWNER}`);
  });

  it('revoking a device (dbStore.revoke) deletes its registration; pending rows cascade', async () => {
    const d = await device();
    const reg = await register(d.id);
    await enqueuePush([OWNER], file(1), { store: dbOutbox, config: enabled, now: t0 });
    expect(await rowsOf(reg.id)).toHaveLength(1);
    await dbStore.revoke(d.id, at(1000));
    expect(await dbRegistrations.getByTokenId(d.id)).toBeNull();
    expect(await rowsOf(reg.id)).toHaveLength(0);
  });

  it('enqueue: category filter, ON CONFLICT dedupe, and a slide that never moves not_before earlier', async () => {
    const files = await register((await device()).id, undefined, ['files'] as never);
    const notes = await register((await device()).id, undefined, ['notes'] as never);
    expect(await enqueuePush([OWNER], file(1), { store: dbOutbox, config: enabled, now: t0 })).toBe(1);
    expect(await enqueuePush([OWNER], file(1), { store: dbOutbox, config: enabled, now: at(1000) })).toBe(0);
    expect(await rowsOf(notes.id)).toHaveLength(0);
    const [r1] = await rowsOf(files.id);
    expect(r1?.notBefore).toEqual(at(COALESCE_DELAY_MS));

    await enqueuePush([OWNER], file(2), { store: dbOutbox, config: enabled, now: at(60_000) });
    expect((await rowsOf(files.id)).map((r) => r.notBefore)).toEqual([at(150_000), at(150_000)]);

    await db
      .update(mobilePushOutbox)
      .set({ notBefore: at(3_600_000) })
      .where(eq(mobilePushOutbox.id, r1?.id as string));
    await enqueuePush([OWNER], file(3), { store: dbOutbox, config: enabled, now: at(70_000) });
    const after = await rowsOf(files.id);
    expect(after[0]?.notBefore).toEqual(at(3_600_000));
    expect(after[2]?.notBefore).toEqual(at(160_000));
  });

  it('dispatch: freezes a batch, resends it unchanged on retry, holds late rows, marks by batch id', async () => {
    const reg = await register((await device()).id);
    const fake = fakeTransport();
    await enqueuePush([OWNER], file(1), { store: dbOutbox, config: enabled, now: t0 });
    await enqueuePush([OWNER], file(2), { store: dbOutbox, config: enabled, now: at(1000) });
    fake.script(reg.fcmToken, {
      ok: false,
      kind: 'retryable',
      errorCode: 'UNAVAILABLE',
      retryAfterMs: 300_000,
    });
    await dispatchDue(at(120_000), { store: dbOutbox, transport: fake, clock: () => at(120_000) });
    const frozen = fake.sent[0]?.data;
    expect(frozen).toMatchObject({ count: '2', fileId: 'doc-2' });

    await enqueuePush([OWNER], file(3), { store: dbOutbox, config: enabled, now: at(121_000) });
    const held = await dispatchDue(at(300_000), {
      store: dbOutbox,
      transport: fake,
      clock: () => at(300_000),
    });
    expect(held?.held).toBe(1);
    await dispatchDue(at(420_001), { store: dbOutbox, transport: fake, clock: () => at(420_001) });
    expect(fake.sent[1]?.data).toEqual(frozen);
    const rows = await rowsOf(reg.id);
    expect(rows.slice(0, 2).every((r) => r.sentAt && r.attempts === 1)).toBe(true);
    expect(rows[2]).toMatchObject({ sentAt: null, batchId: null });
    expect(backoffMs(1, 300_000)).toBe(300_000);
  });

  it('dispatch never sends to a revoked token, even if a registration were left behind', async () => {
    const d = await device();
    const reg = await register(d.id);
    await enqueuePush(
      [OWNER],
      noteSynthesized({ ...course, noteId: 'n', outcome: 'ready', noteUpdatedAt: t0 }),
      {
        store: dbOutbox,
        config: enabled,
        now: t0,
      },
    );
    await db.update(mobileTokens).set({ revokedAt: t0 }).where(eq(mobileTokens.id, d.id)); // soft revoke only
    const fake = fakeTransport();
    await dispatchDue(at(60_000), { store: dbOutbox, transport: fake, clock: () => at(60_000) });
    expect(fake.sent).toEqual([]);
    expect((await rowsOf(reg.id))[0]?.sentAt).toBeNull();
  });

  it('test push writes a terminal row the dispatcher never resends; purge drops old rows', async () => {
    const reg = await register((await device()).id);
    const fake = fakeTransport();
    const r = await sendTestPush(reg, { store: dbOutbox, transport: fake, now: t0 });
    expect(r.outcome).toBe('sent');
    const [row] = await rowsOf(reg.id);
    expect(row).toMatchObject({ batchId: r.eventId, dedupeKey: `push.test:${r.eventId}`, sentAt: t0 });
    await dispatchDue(at(60_000), { store: dbOutbox, transport: fake, clock: () => at(60_000) });
    expect(fake.sent).toHaveLength(1);
    expect(
      (await db.select().from(mobilePushRegistrations).where(eq(mobilePushRegistrations.id, reg.id)))[0]
        ?.lastSentAt,
    ).toEqual(t0);

    await dbOutbox.purge(at(1));
    expect(await rowsOf(reg.id)).toHaveLength(0);
  });
});
