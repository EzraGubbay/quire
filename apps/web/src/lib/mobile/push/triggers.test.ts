// @vitest-environment node
// The trigger decisions (ADR 0003 §1): which imports and syntheses enqueue, with what payload, for whom, and that a
// trigger can never fail or slow its caller. The call sites themselves are covered in lemida/import.push.test.ts and
// ai/synthesis.push.test.ts.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { PushConfig } from './config';
import { PushPayload, pushFixtureName, wireData } from './events';
import { memoryPushStore } from './memory-store';
import { enqueuePush } from './outbox';
import {
  type CourseRef,
  filesAddedFor,
  type ImportOutcome,
  notifyFilesAdded,
  notifyNoteSynthesized,
  type TriggerDeps,
} from './triggers';

const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const disabled = (): PushConfig => ({ enabled: false, reason: 'missing' });
const t0 = new Date('2026-11-24T09:00:00.000Z');
const COURSE_ID = '3f0b1c7e-2a7d-4d8e-9b1a-6c5e4f3a2b10';
const activeCourse: CourseRef = { slug: 'signals', kind: 'course', status: 'active' };

const imported = (over: Partial<ImportOutcome> = {}): ImportOutcome => ({
  status: 'imported',
  duplicate: false,
  lemidaFileId: 'lf-1',
  placement: { documentId: 'doc-1', sessionId: 'sess-1' },
  ...over,
});

let m: ReturnType<typeof memoryPushStore>;
let deps: TriggerDeps;
let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  m = memoryPushStore();
  const d = m.addDevice('local');
  await m.registrations.upsert(
    d.id,
    {
      fcmToken: 'fcm-A',
      platform: 'android',
      appVersion: '1.1.0',
      categories: ['files', 'deadlines', 'notes'],
    },
    t0,
  );
  deps = {
    config: enabled,
    course: vi.fn(async () => activeCourse),
    registeredOwners: vi.fn(async () => ['local']),
    enqueue: vi.fn((audience, event, now) =>
      enqueuePush(audience, event, { store: m.outbox, config: enabled, now }),
    ),
    now: () => t0,
  };
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('filesAddedFor (the enqueue decision)', () => {
  const course = { id: COURSE_ID, slug: 'signals' };

  it('fileId is the placement document id; dedupe and group keys per ADR §1', () => {
    expect(filesAddedFor(course, imported())).toMatchObject({
      type: 'files.added',
      dedupeKey: 'files.added:lf-1',
      groupKey: `files:${COURSE_ID}`,
      data: { course: 'signals', courseId: COURSE_ID, fileId: 'doc-1', count: '1' },
    });
  });

  it('needs_review still notifies as a new file', () => {
    expect(filesAddedFor(course, imported({ status: 'needs_review' }))?.data.fileId).toBe('doc-1');
  });

  it.each([
    ['a duplicate import', imported({ duplicate: true, status: 'imported' })],
    ['a duplicate-status row', imported({ status: 'duplicate' })],
    ['a failed import', imported({ status: 'error' })],
    ['an import without a document', imported({ placement: { sessionId: 's' } })],
  ])('%s enqueues nothing', (_, r) => {
    expect(filesAddedFor(course, r)).toBeNull();
  });
});

describe('notifyFilesAdded', () => {
  it('enqueues one files.added row per matching device', async () => {
    await notifyFilesAdded(COURSE_ID, imported(), deps);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({
      type: 'files.added',
      dedupeKey: 'files.added:lf-1',
      groupKey: `files:${COURSE_ID}`,
      data: { fileId: 'doc-1', courseId: COURSE_ID, course: 'signals' },
    });
  });

  it('a duplicate import enqueues nothing and touches no store', async () => {
    await notifyFilesAdded(COURSE_ID, imported({ duplicate: true }), deps);
    expect(m.rows).toEqual([]);
    expect(deps.course).not.toHaveBeenCalled();
  });

  it('re-running the same import (same lemida file) does not enqueue twice', async () => {
    await notifyFilesAdded(COURSE_ID, imported(), deps);
    await notifyFilesAdded(COURSE_ID, imported(), deps);
    expect(m.rows).toHaveLength(1);
  });

  it.each([
    ['an archived course', { slug: 'old', kind: 'course', status: 'archived' }],
    ['a research project', { slug: 'thesis', kind: 'research', status: 'active' }],
    ['a project that no longer exists', null],
  ])('%s enqueues nothing', async (_, course) => {
    deps.course = vi.fn(async () => course);
    await notifyFilesAdded(COURSE_ID, imported(), deps);
    await notifyNoteSynthesized(COURSE_ID, { id: 'n-1', updatedAt: t0 }, 'ready', deps);
    expect(m.rows).toEqual([]);
    expect(deps.registeredOwners).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('is a no-op with push disabled: no lookups, no rows', async () => {
    deps.config = disabled;
    await notifyFilesAdded(COURSE_ID, imported(), deps);
    await notifyNoteSynthesized(COURSE_ID, { id: 'n-1', updatedAt: t0 }, 'failed', deps);
    expect(deps.course).not.toHaveBeenCalled();
    expect(m.rows).toEqual([]);
  });
});

describe('notifyNoteSynthesized', () => {
  it.each(['ready', 'failed'] as const)('enqueues %s with a per-run dedupe key', async (outcome) => {
    const updatedAt = new Date('2026-11-24T09:05:00.123Z');
    await notifyNoteSynthesized(COURSE_ID, { id: 'n-1', updatedAt }, outcome, deps);
    expect(m.rows[0]).toMatchObject({
      type: 'note.synthesized',
      groupKey: null,
      dedupeKey: `note.synthesized:n-1:${outcome}:${updatedAt.getTime()}`,
      data: { noteId: 'n-1', outcome, course: 'signals', courseId: COURSE_ID },
    });
  });

  it('a retried synthesis (new updatedAt) notifies again', async () => {
    await notifyNoteSynthesized(COURSE_ID, { id: 'n-1', updatedAt: t0 }, 'failed', deps);
    await notifyNoteSynthesized(
      COURSE_ID,
      { id: 'n-1', updatedAt: new Date(t0.getTime() + 1) },
      'failed',
      deps,
    );
    expect(m.rows).toHaveLength(2);
  });
});

describe('a trigger never fails or slows its caller', () => {
  it('does no work synchronously: the caller continues before any lookup', () => {
    void notifyFilesAdded(COURSE_ID, imported(), deps);
    expect(deps.course).not.toHaveBeenCalled();
  });

  it('swallows a failing lookup and logs the error class only', async () => {
    deps.course = async () => {
      throw Object.assign(new Error('relation "projects" (slug)=(SECRET-course)'), { code: '42P01' });
    };
    await expect(notifyFilesAdded(COURSE_ID, imported(), deps)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[push] files.added trigger failed (42P01)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  it('swallows a throwing config and a rejecting enqueue', async () => {
    deps.config = () => {
      throw new TypeError('boom SECRET');
    };
    await expect(
      notifyNoteSynthesized(COURSE_ID, { id: 'n', updatedAt: t0 }, 'ready', deps),
    ).resolves.toBeUndefined();
    deps.config = enabled;
    deps.enqueue = async () => {
      throw new RangeError('fcm-A');
    };
    await expect(notifyFilesAdded(COURSE_ID, imported(), deps)).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[push] note.synthesized trigger failed (TypeError)',
      '[push] files.added trigger failed (RangeError)',
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|fcm-A/);
  });
});

describe('payloads match the push.*.json contract fixtures', () => {
  const fixture = (type: string) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../../../../../docs/api/fixtures/mobile-v1/${pushFixtureName(type as never)}`,
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, string>;

  it.each([
    ['files.added', () => notifyFilesAdded(COURSE_ID, imported(), deps)],
    ['note.synthesized', () => notifyNoteSynthesized(COURSE_ID, { id: 'n-1', updatedAt: t0 }, 'ready', deps)],
  ])('%s: the wire map decodes and has exactly the fixture keys', async (type, fire) => {
    await fire();
    const row = m.rows[0];
    if (!row) throw new Error('nothing enqueued');
    const wire = wireData(row.data, { eventId: '7a1c2f0e-5b7d-4c2a-9a51-0f3e6d1b2c44', count: 1 });
    expect(PushPayload.parse(wire).type).toBe(type);
    expect(Object.keys(wire).sort()).toEqual(Object.keys(fixture(type)).sort());
    expect(Object.values(wire).every((v) => typeof v === 'string')).toBe(true);
  });
});
