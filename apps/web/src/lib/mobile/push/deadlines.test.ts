// @vitest-environment node
// scanDeadlines (ADR 0003 §1): homework due within 24 h, for active courses only, once per deadline. The SQL
// candidate query is covered against Postgres in deadlines.db.integration.test.ts.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushConfig } from './config';
import { type DeadlineCandidate, type DeadlineDeps, remindable, scanDeadlines } from './deadlines';
import { PushPayload, wireData } from './events';
import { memoryPushStore } from './memory-store';
import { enqueuePush } from './outbox';

const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const now = new Date('2026-11-24T09:00:00.000Z');
const H = 60 * 60 * 1000;
const at = (ms: number) => new Date(now.getTime() + ms);
const activeCourse = { slug: 'signals', kind: 'course', status: 'active' };

const hw = (over: Partial<DeadlineCandidate> = {}): DeadlineCandidate => ({
  id: 'a-1',
  projectId: 'c-1',
  number: 3,
  dueAt: at(12 * H),
  status: 'not_started',
  sheetDocumentId: 'doc-sheet',
  course: activeCourse,
  ...over,
});

let m: ReturnType<typeof memoryPushStore>;
let list: DeadlineCandidate[];
let deps: DeadlineDeps;

beforeEach(async () => {
  m = memoryPushStore();
  const d = m.addDevice('local');
  await m.registrations.upsert(
    d.id,
    { fcmToken: 'fcm-A', platform: 'android', appVersion: '1.1.0', categories: ['deadlines'] },
    now,
  );
  list = [];
  deps = {
    config: enabled,
    candidates: vi.fn(async () => list),
    registeredOwners: vi.fn(async () => ['local']),
    enqueue: (audience, event, t) =>
      enqueuePush(audience, event, { store: m.outbox, config: enabled, now: t }),
  };
});
afterEach(() => vi.restoreAllMocks());

describe('remindable: the window and statuses', () => {
  it.each([
    ['due in 12 h', hw(), true],
    ['due exactly 24 h from now', hw({ dueAt: at(24 * H) }), true],
    ['due in 1 s', hw({ dueAt: at(1000) }), true],
    ['in progress', hw({ status: 'in_progress' }), true],
    ['due just past 24 h', hw({ dueAt: at(24 * H + 1) }), false],
    ['due right now', hw({ dueAt: now }), false],
    ['overdue', hw({ dueAt: at(-H) }), false],
    ['no due date', hw({ dueAt: null }), false],
    ['submitted', hw({ status: 'submitted' }), false],
    ['graded', hw({ status: 'graded' }), false],
    ['in an archived course', hw({ course: { ...activeCourse, status: 'archived' } }), false],
    ['in a research project', hw({ course: { ...activeCourse, kind: 'research' } }), false],
  ])('%s → %s', (_, a, expected) => {
    expect(remindable(a, now)).toBe(expected);
  });
});

describe('scanDeadlines', () => {
  it('asks for candidates in (now, now + 24 h]', async () => {
    await scanDeadlines(now, deps);
    expect(deps.candidates).toHaveBeenCalledWith(now, at(24 * H));
  });

  it('enqueues homework.due: HIGH, TTL until due, dedupe on assignment + due epoch seconds', async () => {
    list = [hw()];
    expect(await scanDeadlines(now, deps)).toBe(1);
    expect(m.rows[0]).toMatchObject({
      type: 'homework.due',
      priority: 'HIGH',
      groupKey: null,
      dedupeKey: `homework.due:a-1:${at(12 * H).getTime() / 1000}`,
      expiresAt: at(12 * H),
      data: {
        course: 'signals',
        courseId: 'c-1',
        assignmentId: 'a-1',
        number: '3',
        dueAt: at(12 * H).toISOString(),
        fileId: 'doc-sheet',
      },
    });
  });

  it('omits fileId when the assignment has no sheet', async () => {
    list = [hw({ sheetDocumentId: null })];
    await scanDeadlines(now, deps);
    expect(m.rows[0]?.data).not.toHaveProperty('fileId');
  });

  it('skips rows outside the window, finished work, archived courses and research projects', async () => {
    list = [
      hw({ id: 'late', dueAt: at(25 * H) }),
      hw({ id: 'past', dueAt: at(-H) }),
      hw({ id: 'done', status: 'submitted' }),
      hw({ id: 'archived', course: { ...activeCourse, status: 'archived' } }),
      hw({ id: 'research', course: { ...activeCourse, kind: 'research' } }),
      hw({ id: 'ok' }),
    ];
    expect(await scanDeadlines(now, deps)).toBe(1);
    expect(m.rows.map((r) => r.data.assignmentId)).toEqual(['ok']);
  });

  it('running the scan twice (10 min apart) enqueues once', async () => {
    list = [hw()];
    await scanDeadlines(now, deps);
    expect(await scanDeadlines(at(10 * 60 * 1000), deps)).toBe(0);
    expect(m.rows).toHaveLength(1);
  });

  it('moving the deadline re-arms the reminder', async () => {
    list = [hw()];
    await scanDeadlines(now, deps);
    list = [hw({ dueAt: at(20 * H) })];
    expect(await scanDeadlines(at(60_000), deps)).toBe(1);
    expect(m.rows.map((r) => r.data.dueAt)).toEqual([at(12 * H).toISOString(), at(20 * H).toISOString()]);
  });

  it('respects the deadlines category', async () => {
    m = memoryPushStore();
    const d = m.addDevice('local');
    await m.registrations.upsert(
      d.id,
      { fcmToken: 'fcm-B', platform: 'android', appVersion: null, categories: ['files', 'notes'] },
      now,
    );
    list = [hw()];
    expect(await scanDeadlines(now, deps)).toBe(0);
  });

  it('is a no-op with push disabled: no query at all', async () => {
    deps.config = () => ({ enabled: false, reason: 'missing' });
    list = [hw()];
    expect(await scanDeadlines(now, deps)).toBe(0);
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it('looks the audience up once per scan, and not at all when nothing is due', async () => {
    await scanDeadlines(now, deps);
    expect(deps.registeredOwners).not.toHaveBeenCalled();
    list = [hw({ id: 'a' }), hw({ id: 'b' })];
    await scanDeadlines(now, deps);
    expect(deps.registeredOwners).toHaveBeenCalledTimes(1);
  });

  it('the payload decodes and has exactly the push.homework.due.json keys', async () => {
    list = [hw()];
    await scanDeadlines(now, deps);
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../../../../docs/api/fixtures/mobile-v1/push.homework.due.json', import.meta.url),
        'utf8',
      ),
    );
    const wire = wireData(m.rows[0]?.data ?? {}, {
      eventId: '7a1c2f0e-5b7d-4c2a-9a51-0f3e6d1b2c44',
      count: 1,
    });
    expect(PushPayload.parse(wire).type).toBe('homework.due');
    expect(Object.keys(wire).sort()).toEqual(Object.keys(fixture).sort());
  });
});
