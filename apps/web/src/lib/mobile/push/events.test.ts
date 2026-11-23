// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  filesAdded,
  homeworkDue,
  noteSynthesized,
  type PUSH_TYPES,
  PushPayload,
  pushFixtureName,
  pushFixtures,
  pushTest,
  wireData,
} from './events';

const course = { courseSlug: 'signals', courseId: 'c-1' };
const now = new Date('2026-11-24T09:00:00.000Z');

describe('event builders (ADR 0003 §1–§2)', () => {
  it('files.added: files category, coalesced per course, NORMAL / 7 days', () => {
    const e = filesAdded({ ...course, fileId: 'doc-1', lemidaFileId: 'lf-9' });
    expect(e).toEqual({
      type: 'files.added',
      category: 'files',
      dedupeKey: 'files.added:lf-9',
      groupKey: 'files:c-1',
      data: { v: '1', type: 'files.added', course: 'signals', courseId: 'c-1', fileId: 'doc-1', count: '1' },
      priority: 'NORMAL',
      ttlSeconds: 604_800,
    });
  });

  it('homework.due: deadlines, HIGH, TTL until dueAt (max 24 h), dedupe re-arms when dueAt moves', () => {
    const dueAt = new Date('2026-11-24T21:00:00.000Z');
    const e = homeworkDue({ ...course, assignmentId: 'a-1', number: 3, dueAt, fileId: 'sheet-1', now });
    expect(e).toMatchObject({
      type: 'homework.due',
      category: 'deadlines',
      groupKey: null,
      priority: 'HIGH',
      ttlSeconds: 12 * 3600,
      dedupeKey: `homework.due:a-1:${dueAt.getTime() / 1000}`,
    });
    expect(e.data).toEqual({
      v: '1',
      type: 'homework.due',
      course: 'signals',
      courseId: 'c-1',
      assignmentId: 'a-1',
      number: '3',
      dueAt: '2026-11-24T21:00:00.000Z',
      fileId: 'sheet-1',
    });
    const moved = homeworkDue({
      ...course,
      assignmentId: 'a-1',
      number: 3,
      dueAt: new Date(dueAt.getTime() + 3600e3),
      now,
    });
    expect(moved.dedupeKey).not.toBe(e.dedupeKey);
    expect(moved.data).not.toHaveProperty('fileId');
    const far = homeworkDue({
      ...course,
      assignmentId: 'a',
      number: 1,
      dueAt: new Date(now.getTime() + 3 * 86400e3),
      now,
    });
    expect(far.ttlSeconds).toBe(86_400);
  });

  it('note.synthesized: notes, NORMAL / 24 h, each run distinct', () => {
    const e = noteSynthesized({ ...course, noteId: 'n-1', outcome: 'failed', noteUpdatedAt: now });
    expect(e).toMatchObject({
      type: 'note.synthesized',
      category: 'notes',
      groupKey: null,
      priority: 'NORMAL',
      ttlSeconds: 86_400,
      dedupeKey: `note.synthesized:n-1:failed:${now.getTime()}`,
    });
    expect(e.data).toEqual({
      v: '1',
      type: 'note.synthesized',
      course: 'signals',
      courseId: 'c-1',
      noteId: 'n-1',
      outcome: 'failed',
    });
  });

  it('push.test: no category, HIGH / 5 min, collapses, dedupe on eventId', () => {
    expect(pushTest({ eventId: 'e-1' })).toEqual({
      type: 'push.test',
      category: null,
      dedupeKey: 'push.test:e-1',
      groupKey: null,
      data: { v: '1', type: 'push.test' },
      priority: 'HIGH',
      ttlSeconds: 300,
      collapseKey: 'push.test',
    });
  });

  it('payloads carry ids only, every value a string', () => {
    const events = [
      filesAdded({ ...course, fileId: 'd', lemidaFileId: 'l' }),
      homeworkDue({ ...course, assignmentId: 'a', number: 1, dueAt: new Date(now.getTime() + 1e6), now }),
      noteSynthesized({ ...course, noteId: 'n', outcome: 'ready', noteUpdatedAt: now }),
      pushTest({ eventId: 'e' }),
    ];
    for (const e of events) for (const v of Object.values(e.data)) expect(typeof v).toBe('string');
  });
});

describe('wireData', () => {
  it('sets eventId = batch id; files.added gets the batch count and keeps the newest fileId', () => {
    const newest = filesAdded({ ...course, fileId: 'doc-newest', lemidaFileId: 'l' }).data;
    expect(wireData(newest, { eventId: 'b-1', count: 5 })).toMatchObject({
      eventId: 'b-1',
      count: '5',
      fileId: 'doc-newest',
    });
  });
  it('adds no count to other types', () => {
    expect(wireData(pushTest({ eventId: 'x' }).data, { eventId: 'b', count: 1 })).toEqual({
      v: '1',
      type: 'push.test',
      eventId: 'b',
    });
  });
});

describe('push fixtures', () => {
  it('one fixture per type, each a valid wire payload', () => {
    const fx = pushFixtures();
    expect([...fx.keys()].sort()).toEqual(
      [
        'push.files.added.json',
        'push.homework.due.json',
        'push.note.synthesized.json',
        'push.test.json',
      ].sort(),
    );
    for (const [name, data] of fx) {
      const r = PushPayload.safeParse(data);
      expect(r.success, `${name}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(pushFixtureName(data.type as (typeof PUSH_TYPES)[number])).toBe(name);
    }
  });
});
