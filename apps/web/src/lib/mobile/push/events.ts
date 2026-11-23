// Pure push event builders (ADR 0003 §1–§2). Each returns the outbox shape of one event: category, dedupe and group
// keys, the FCM data map (ids only, every value a string), priority and TTL. `wireData` adds the per-batch fields
// (eventId, and count/fileId for files.added) at send time. Pure zod, no server/db imports: the contract fixtures
// (`push.<type>.json`) are generated from these builders.
import { z } from 'zod';

/** Payload version carried as `v`; the app drops unknown versions. */
export const PUSH_PAYLOAD_VERSION = '1';

/** User-facing toggles; the server filters by them (ADR §3.4). `push.test` has none (always on). */
export const PUSH_CATEGORIES = ['files', 'deadlines', 'notes'] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export const PUSH_TYPES = ['files.added', 'homework.due', 'note.synthesized', 'push.test'] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export type PushPriority = 'HIGH' | 'NORMAL';

export interface PushEvent {
  type: PushType;
  category: PushCategory | null;
  dedupeKey: string;
  /** Coalescing group (`files:{courseId}`); null for events that are always their own batch. */
  groupKey: string | null;
  /** FCM data map without `eventId` (set per batch). */
  data: Record<string, string>;
  priority: PushPriority;
  ttlSeconds: number;
  collapseKey?: string;
}

const DAY = 24 * 60 * 60;

/** A new course file pulled from Lemida. `fileId` is `documents.id` (the import's `placement.documentId`). */
export function filesAdded(i: {
  courseSlug: string;
  courseId: string;
  fileId: string;
  lemidaFileId: string;
}): PushEvent {
  return {
    type: 'files.added',
    category: 'files',
    dedupeKey: `files.added:${i.lemidaFileId}`,
    groupKey: `files:${i.courseId}`,
    data: {
      v: PUSH_PAYLOAD_VERSION,
      type: 'files.added',
      course: i.courseSlug,
      courseId: i.courseId,
      fileId: i.fileId,
      count: '1',
    },
    priority: 'NORMAL',
    ttlSeconds: 7 * DAY,
  };
}

/** Homework due within 24 h. TTL runs until `dueAt` (at most 24 h); a moved deadline gets a new dedupe key. */
export function homeworkDue(i: {
  courseSlug: string;
  courseId: string;
  assignmentId: string;
  number: number | string;
  dueAt: Date;
  /** The sheet document (`assignments.sheet_document_id`), omitted when null. */
  fileId?: string | null;
  now: Date;
}): PushEvent {
  const untilDue = Math.floor((i.dueAt.getTime() - i.now.getTime()) / 1000);
  return {
    type: 'homework.due',
    category: 'deadlines',
    dedupeKey: `homework.due:${i.assignmentId}:${Math.floor(i.dueAt.getTime() / 1000)}`,
    groupKey: null,
    data: {
      v: PUSH_PAYLOAD_VERSION,
      type: 'homework.due',
      course: i.courseSlug,
      courseId: i.courseId,
      assignmentId: i.assignmentId,
      number: String(i.number),
      dueAt: i.dueAt.toISOString(),
      ...(i.fileId ? { fileId: i.fileId } : {}),
    },
    priority: 'HIGH',
    ttlSeconds: Math.max(0, Math.min(DAY, untilDue)),
  };
}

/** A synthesized study note finished (`ready`) or failed. Each run is distinct via the note's `updatedAt`. */
export function noteSynthesized(i: {
  courseSlug: string;
  courseId: string;
  noteId: string;
  outcome: 'ready' | 'failed';
  noteUpdatedAt: Date;
}): PushEvent {
  return {
    type: 'note.synthesized',
    category: 'notes',
    dedupeKey: `note.synthesized:${i.noteId}:${i.outcome}:${i.noteUpdatedAt.getTime()}`,
    groupKey: null,
    data: {
      v: PUSH_PAYLOAD_VERSION,
      type: 'note.synthesized',
      course: i.courseSlug,
      courseId: i.courseId,
      noteId: i.noteId,
      outcome: i.outcome,
    },
    priority: 'NORMAL',
    ttlSeconds: DAY,
  };
}

/** `POST /push/test`: sent synchronously to the calling device; no category, collapses on the device. */
export function pushTest(i: { eventId: string }): PushEvent {
  return {
    type: 'push.test',
    category: null,
    dedupeKey: `push.test:${i.eventId}`,
    groupKey: null,
    data: { v: PUSH_PAYLOAD_VERSION, type: 'push.test' },
    priority: 'HIGH',
    ttlSeconds: 5 * 60,
    collapseKey: 'push.test',
  };
}

/**
 * The data map exactly as sent for one frozen batch: `eventId = batch_id`. For `files.added`, `count` is the
 * batch size and `fileId` the newest row's document; `newest` is that row's stored data.
 */
export function wireData(newest: Record<string, string>, batch: { eventId: string; count: number }) {
  const out: Record<string, string> = { ...newest, eventId: batch.eventId };
  if (newest.type === 'files.added') out.count = String(batch.count);
  return out;
}

// ── Wire schemas (what the app decodes) ─────────────────────────────────────────────────────────────

const Str = z.string().min(1);
const common = { v: z.literal(PUSH_PAYLOAD_VERSION), eventId: Str };

export const PushPayload = z.discriminatedUnion('type', [
  z.strictObject({
    ...common,
    type: z.literal('files.added'),
    course: Str,
    courseId: Str,
    fileId: Str,
    count: z.string().regex(/^[1-9]\d*$/),
  }),
  z.strictObject({
    ...common,
    type: z.literal('homework.due'),
    course: Str,
    courseId: Str,
    assignmentId: Str,
    number: Str,
    dueAt: z.iso.datetime(),
    fileId: Str.optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('note.synthesized'),
    course: Str,
    courseId: Str,
    noteId: Str,
    outcome: z.enum(['ready', 'failed']),
  }),
  z.strictObject({ ...common, type: z.literal('push.test') }),
]);
export type PushPayload = z.infer<typeof PushPayload>;

// ── Contract fixtures: one `push.<type>.json` per event type, built from the builders above ─────────

const FX = {
  now: new Date('2026-11-24T09:00:00.000Z'),
  courseSlug: 'signals-and-systems',
  courseId: '3f0b1c7e-2a7d-4d8e-9b1a-6c5e4f3a2b10',
  fileId: '9c4e2b1a-7d3f-4a6b-8e2c-1f0a9b8c7d6e',
  eventId: '7a1c2f0e-5b7d-4c2a-9a51-0f3e6d1b2c44',
};

/** `push.<type>.json`; `push.test` is already prefixed, so its fixture is `push.test.json`. */
export const pushFixtureName = (type: PushType) => `${type.startsWith('push.') ? type : `push.${type}`}.json`;

/** @returns fixture file name → the FCM `data` map exactly as sent, for every push type. */
export function pushFixtures(): Map<string, Record<string, string>> {
  const events: PushEvent[] = [
    filesAdded({
      courseSlug: FX.courseSlug,
      courseId: FX.courseId,
      fileId: FX.fileId,
      lemidaFileId: '5b2d7e1c-0a9f-4c3e-8d6b-2f1a0e9d8c7b',
    }),
    homeworkDue({
      courseSlug: FX.courseSlug,
      courseId: FX.courseId,
      assignmentId: '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b',
      number: 3,
      dueAt: new Date('2026-11-24T21:59:00.000Z'),
      fileId: FX.fileId,
      now: FX.now,
    }),
    noteSynthesized({
      courseSlug: FX.courseSlug,
      courseId: FX.courseId,
      noteId: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
      outcome: 'ready',
      noteUpdatedAt: FX.now,
    }),
    pushTest({ eventId: FX.eventId }),
  ];
  const out = new Map<string, Record<string, string>>();
  for (const e of events)
    out.set(pushFixtureName(e.type), wireData(e.data, { eventId: FX.eventId, count: 1 }));
  return out;
}
