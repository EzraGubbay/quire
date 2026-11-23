// @vitest-environment node
// scanDeadlines' SQL candidate query and the full scan against a real, migrated Postgres. Opt-in, like
// db.integration.test.ts:
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run src/lib/mobile/push/deadlines.db
// Every row it creates belongs to run-unique projects/owners and is deleted afterwards; it never truncates.
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSql } from '@/db/client';
import { assignments, mobilePushOutbox, mobileTokens, projects } from '@/db/schema';
import type { PushConfig } from './config';
import { dbDeadlineDeps, scanDeadlines } from './deadlines';
import { dbOutbox, enqueuePush } from './outbox';
import { dbRegistrations } from './registrations';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const OWNER = `push-dl-${RUN}`;
const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const H = 60 * 60 * 1000;
const at = (ms: number) => new Date(now.getTime() + ms);
const projectIds: string[] = [];

async function project(kind: 'course' | 'research', status: 'active' | 'archived') {
  const [p] = await db
    .insert(projects)
    .values({ slug: `push-dl-${RUN}-${projectIds.length}`, name: 'it', kind, status })
    .returning();
  if (!p) throw new Error('no project');
  projectIds.push(p.id);
  return p;
}
async function assignment(
  projectId: string,
  number: number,
  dueAt: Date | null,
  status: 'not_started' | 'in_progress' | 'submitted' | 'graded' = 'not_started',
) {
  const [a] = await db
    .insert(assignments)
    .values({ projectId, number, title: `hw ${number}`, dueAt, status })
    .returning();
  if (!a) throw new Error('no assignment');
  return a;
}

async function cleanup() {
  const tokens = (
    await db.select({ id: mobileTokens.id }).from(mobileTokens).where(eq(mobileTokens.ownerLogin, OWNER))
  ).map((r) => r.id);
  if (tokens.length) await db.delete(mobileTokens).where(inArray(mobileTokens.id, tokens)); // cascades push rows
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades assignments
}

// Only this run's projects: the shared candidate query also sees whatever else is in the database.
const ours = async (from: Date, to: Date) =>
  (await dbDeadlineDeps.candidates(from, to)).filter((c) => projectIds.includes(c.projectId));

describe.skipIf(!run)('scanDeadlines (integration)', () => {
  beforeEach(async () => {
    await cleanup();
    projectIds.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(async () => {
    await cleanup();
    await getSql().end();
  });

  it('candidates: (now, now + 24 h], open statuses, active course projects only', async () => {
    const course = await project('course', 'active');
    const archived = await project('course', 'archived');
    const research = await project('research', 'active');
    const due12 = await assignment(course.id, 1, at(12 * H));
    const due24 = await assignment(course.id, 2, at(24 * H), 'in_progress');
    await assignment(course.id, 3, at(24 * H + 1000));
    await assignment(course.id, 4, now);
    await assignment(course.id, 5, at(-H));
    await assignment(course.id, 6, null);
    await assignment(course.id, 7, at(2 * H), 'submitted');
    await assignment(course.id, 8, at(2 * H), 'graded');
    await assignment(archived.id, 1, at(2 * H));
    await assignment(research.id, 1, at(2 * H));

    const got = await ours(now, at(24 * H));
    expect(got.map((c) => c.id).sort()).toEqual([due12.id, due24.id].sort());
    expect(got.find((c) => c.id === due12.id)).toMatchObject({
      projectId: course.id,
      number: 1,
      dueAt: at(12 * H),
      status: 'not_started',
      sheetDocumentId: null,
      course: { slug: course.slug, kind: 'course', status: 'active' },
    });
  });

  it('the scan enqueues once per deadline and re-arms when the deadline moves', async () => {
    const course = await project('course', 'active');
    const hw = await assignment(course.id, 4, at(6 * H));
    const [token] = await db
      .insert(mobileTokens)
      .values({ ownerLogin: OWNER, deviceName: 'it', tokenHash: randomUUID() })
      .returning();
    const reg = await dbRegistrations.upsert(
      token?.id as string,
      { fcmToken: `fcm-${RUN}`, platform: 'android', appVersion: null, categories: ['deadlines'] },
      now,
    );
    const deps = {
      ...dbDeadlineDeps,
      config: enabled,
      candidates: ours,
      registeredOwners: async () => [OWNER],
      enqueue: (a: readonly string[], e: Parameters<typeof enqueuePush>[1], t: Date) =>
        enqueuePush(a, e, { store: dbOutbox, config: enabled, now: t }),
    };
    const rows = () =>
      db
        .select()
        .from(mobilePushOutbox)
        .where(eq(mobilePushOutbox.registrationId, reg.id))
        .orderBy(mobilePushOutbox.createdAt);

    expect(await scanDeadlines(now, deps)).toBe(1);
    expect(await scanDeadlines(at(10 * 60 * 1000), deps)).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({
      type: 'homework.due',
      priority: 'HIGH',
      dedupeKey: `homework.due:${hw.id}:${at(6 * H).getTime() / 1000}`,
      expiresAt: at(6 * H),
    });

    await db
      .update(assignments)
      .set({ dueAt: at(8 * H) })
      .where(eq(assignments.id, hw.id));
    expect(await scanDeadlines(at(11 * 60 * 1000), deps)).toBe(1);
    expect((await rows()).map((r) => r.data.dueAt)).toEqual([
      at(6 * H).toISOString(),
      at(8 * H).toISOString(),
    ]);
  });
});
