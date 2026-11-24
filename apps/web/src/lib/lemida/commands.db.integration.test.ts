// @vitest-environment node
// The command lease / expiry SQL against a real, migrated Postgres. Opt-in so `pnpm test` never needs a database:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run db.integration
// Rows it seeds are tagged payload.itRun and deleted afterwards; rows created by enqueue* are deleted by id.
// NOTE: reapStaleCommands is global, so run this only against a disposable or local database, never prod.
import { randomUUID } from 'node:crypto';
import type { LemidaCommandKind, LemidaCommandStatus } from '@quire/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, getSql } from '@/db/client';
import { lemidaCommands, lemidaCourses, projects } from '@/db/schema';
import {
  claimNextCommand,
  commandOverview,
  completeCommand,
  enqueueCommand,
  enqueueIfIdle,
  heartbeatCommand,
  reapStaleCommands,
} from './commands';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID();
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const MIN = 60_000;
const ago = (ms: number) => new Date(now.getTime() - ms);
type Row = typeof lemidaCommands.$inferSelect;

async function seed(o: {
  kind?: LemidaCommandKind;
  status: LemidaCommandStatus;
  updatedAt: Date;
  heartbeatAt?: Date | null;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): Promise<Row> {
  const [row] = await db
    .insert(lemidaCommands)
    .values({
      kind: o.kind ?? 'probe',
      status: o.status,
      payload: { itRun: RUN, ...o.payload },
      result: o.result ?? {},
      heartbeatAt: o.heartbeatAt ?? null,
      createdAt: o.updatedAt,
      updatedAt: o.updatedAt,
    })
    .returning();
  return row as Row;
}
const get = async (id: string): Promise<Row> =>
  (await db.select().from(lemidaCommands).where(eq(lemidaCommands.id, id)))[0] as Row;
const drop = (id: string) => db.delete(lemidaCommands).where(eq(lemidaCommands.id, id));

async function cleanup() {
  await db.delete(lemidaCommands).where(sql`${lemidaCommands.payload}->>'itRun' = ${RUN}`);
}

describe.skipIf(!run)('lemida command lease (integration)', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await getSql().end();
  });

  it('migration: heartbeat_at column exists', async () => {
    const cols = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'lemida_commands' AND column_name = 'heartbeat_at'`,
    );
    expect([...cols]).toHaveLength(1);
  });

  it('reaps a leased running row whose heartbeat lapsed, keeps a fresh one', async () => {
    const dead = await seed({ status: 'running', updatedAt: ago(10 * MIN), heartbeatAt: ago(3 * MIN) });
    const live = await seed({ status: 'running', updatedAt: ago(10 * MIN), heartbeatAt: ago(30_000) });
    const r = await reapStaleCommands(now);
    expect(r.leaseExpired).toContain(dead.id);
    expect(r.leaseExpired).not.toContain(live.id);
    const d = await get(dead.id);
    expect(d.status).toBe('error');
    expect(d.result.reason).toBe('lease_expired');
    expect((await get(live.id)).status).toBe('running');
  });

  it('regression bug 4: a legacy (no heartbeat) running row is reaped after 30 min, not at 10', async () => {
    const old = await seed({ status: 'running', updatedAt: ago(31 * MIN) });
    const recent = await seed({ status: 'running', updatedAt: ago(10 * MIN) });
    await reapStaleCommands(now);
    expect((await get(old.id)).result.reason).toBe('lease_expired');
    expect((await get(recent.id)).status).toBe('running');
  });

  it('regression bug 13: stale pending expires only when nothing is running', async () => {
    const stale = await seed({ status: 'pending', updatedAt: ago(11 * MIN) });
    const fresh = await seed({ status: 'pending', updatedAt: ago(5 * MIN) });
    await reapStaleCommands(now);
    const s = await get(stale.id);
    expect(s.status).toBe('error');
    expect(s.result.reason).toBe('expired');
    expect((await get(fresh.id)).status).toBe('pending');

    const stale2 = await seed({ status: 'pending', updatedAt: ago(11 * MIN) });
    await seed({ status: 'running', updatedAt: ago(5 * MIN), heartbeatAt: ago(10_000) });
    await reapStaleCommands(now);
    expect((await get(stale2.id)).status).toBe('pending');
  });

  it('claimNextCommand sets heartbeat_at only when leased', async () => {
    const a = await seed({ status: 'pending', updatedAt: ago(1 * MIN) });
    const claimedA = await claimNextCommand({ leased: true }, now);
    expect(claimedA?.id).toBe(a.id);
    expect(claimedA?.status).toBe('running');
    expect(claimedA?.heartbeatAt?.getTime()).toBe(now.getTime());
    await drop(a.id);

    const b = await seed({ status: 'pending', updatedAt: ago(1 * MIN) });
    const claimedB = await claimNextCommand({ leased: false }, now);
    expect(claimedB?.id).toBe(b.id);
    expect(claimedB?.heartbeatAt).toBeNull();
  });

  it('heartbeatCommand advances heartbeat_at but not updated_at; false when not running', async () => {
    const r = await seed({ status: 'running', updatedAt: ago(5 * MIN), heartbeatAt: ago(1 * MIN) });
    expect(await heartbeatCommand(r.id, now)).toBe(true);
    const after = await get(r.id);
    expect(after.heartbeatAt?.getTime()).toBe(now.getTime());
    expect(after.updatedAt.getTime()).toBe(r.updatedAt.getTime());
    const e = await seed({ status: 'error', updatedAt: ago(5 * MIN) });
    expect(await heartbeatCommand(e.id, now)).toBe(false);
  });

  it('completeCommand is guarded', async () => {
    const running = await seed({ status: 'running', updatedAt: ago(1 * MIN) });
    expect(await completeCommand(running.id, 'done', { ok: 1 }, now)).toBe(true);

    const lease = await seed({ status: 'error', updatedAt: ago(1 * MIN), result: { reason: 'lease_expired' } });
    expect(await completeCommand(lease.id, 'done', { late: true }, now)).toBe(true);
    expect((await get(lease.id)).status).toBe('done');

    const expired = await seed({ status: 'error', updatedAt: ago(1 * MIN), result: { reason: 'expired' } });
    expect(await completeCommand(expired.id, 'done', {}, now)).toBe(false);
    expect((await get(expired.id)).status).toBe('error');

    const done = await seed({ status: 'done', updatedAt: ago(1 * MIN), result: { keep: 1 } });
    expect(await completeCommand(done.id, 'error', { x: 1 }, now)).toBe(false);
    expect((await get(done.id)).result).toEqual({ keep: 1 });

    const timeout = await seed({ status: 'error', updatedAt: ago(1 * MIN), result: { reason: 'engine_timeout' } });
    expect(await completeCommand(timeout.id, 'done', {}, now)).toBe(false);
  });

  it('enqueueIfIdle never clobbers a pending/running sync; inserts when idle', async () => {
    const pending = await seed({ kind: 'sync', status: 'pending', updatedAt: ago(1 * MIN), payload: { full: true } });
    const r1 = await enqueueIfIdle('sync', { trigger: 'auto-timer' }, now);
    expect(r1.created).toBe(false);
    expect((await get(pending.id)).payload.full).toBe(true);
    await drop(pending.id);

    const running = await seed({ kind: 'sync', status: 'running', updatedAt: ago(1 * MIN), heartbeatAt: ago(5_000) });
    expect((await enqueueIfIdle('sync', { trigger: 'auto-timer' }, now)).created).toBe(false);
    await drop(running.id);

    const [project] = await db
      .insert(projects)
      .values({ slug: `cmd-it-${RUN}`, name: 'cmd it', kind: 'course' })
      .returning();
    const projectId = (project as { id: string }).id;
    try {
      await db
        .insert(lemidaCourses)
        .values({ projectId, lemidaUrl: 'https://lemida.biu.ac.il/course/view.php?id=1' });
      const r3 = await enqueueIfIdle('sync', { trigger: 'auto-timer' }, now);
      expect(r3.created).toBe(true);
      expect(r3.command?.payload).toEqual({ trigger: 'auto-timer' });
      if (r3.command) await drop(r3.command.id);
    } finally {
      await db.delete(projects).where(eq(projects.id, projectId)); // cascades the mapping
    }
  });

  it('regression bug 13 (coalescing): a 3-day-old pending probe expires and a new one is created; a recent one is reused and bumped', async () => {
    const old = await seed({ status: 'pending', updatedAt: ago(3 * 24 * 60 * MIN) });
    const fresh = await enqueueCommand('probe', {}, now);
    expect(fresh.id).not.toBe(old.id);
    expect((await get(old.id)).result.reason).toBe('expired');
    await drop(fresh.id);

    const recent = await seed({ status: 'pending', updatedAt: ago(2 * MIN) });
    const reused = await enqueueCommand('probe', {}, now);
    expect(reused.id).toBe(recent.id);
    expect(reused.updatedAt.getTime()).toBe(now.getTime());
  });

  it('commandOverview: running beats pending for current; last is the newest finished', async () => {
    await seed({ status: 'pending', updatedAt: ago(4 * MIN), kind: 'sync' });
    const running = await seed({ status: 'running', updatedAt: ago(3 * MIN), heartbeatAt: ago(1_000) });
    await seed({ status: 'done', updatedAt: ago(20 * MIN) });
    const newest = await seed({ status: 'error', updatedAt: ago(10 * MIN), result: { message: 'boom' } });
    const o = await commandOverview();
    expect(o.current?.id).toBe(running.id);
    expect(o.last?.id).toBe(newest.id);
  });
});
