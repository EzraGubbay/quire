// Push triggers (ADR 0003 §1): the event-side seam that import and synthesis call. Each `notify*` is
// fire-and-forget: it does no work synchronously, never rejects, and logs failures by error class only, so push can
// never fail or slow its caller. With push disabled it returns before any lookup. homework.due lives in deadlines.ts.
import type { LemidaFileStatus } from '@quire/shared';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { audienceForCourse, dbAudience } from './audience';
import { type PushConfig, pushConfig } from './config';
import { filesAdded, noteSynthesized, type PushEvent } from './events';
import { enqueuePush, errTag } from './outbox';

/** What the audience and payload need to know about a project. */
export interface CourseRef {
  slug: string;
  kind: string;
  status: string;
}

export interface TriggerDeps {
  config: () => PushConfig;
  course(projectId: string): Promise<CourseRef | null>;
  /** Owners with an active registration (the audience module's seam). */
  registeredOwners(): Promise<string[]>;
  enqueue(audience: readonly string[], event: PushEvent, now: Date): Promise<number>;
  now(): Date;
}

export const dbTriggerDeps: TriggerDeps = {
  config: () => pushConfig(),
  async course(projectId) {
    const [p] = await db
      .select({ slug: projects.slug, kind: projects.kind, status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return p ?? null;
  },
  registeredOwners: () => dbAudience.registeredOwners(),
  enqueue: (audience, event, now) => enqueuePush(audience, event, { now }),
  now: () => new Date(),
};

/** The parts of an `ImportResult` (lib/lemida/import.ts) the trigger reads. */
export interface ImportOutcome {
  status: LemidaFileStatus;
  duplicate: boolean;
  lemidaFileId: string;
  placement: { documentId?: string; sessionId?: string; assignmentId?: string };
}

/**
 * Pure: the files.added event for one import, or null when it must not notify. Only a placed, non-duplicate import
 * whose status is `imported` or `needs_review` notifies; `fileId` is the placement's `documents.id`.
 */
export function filesAddedFor(course: { id: string; slug: string }, r: ImportOutcome): PushEvent | null {
  const fileId = r.placement.documentId;
  if (r.duplicate || !fileId || (r.status !== 'imported' && r.status !== 'needs_review')) return null;
  return filesAdded({ courseSlug: course.slug, courseId: course.id, fileId, lemidaFileId: r.lemidaFileId });
}

/** Run `task` after the caller's current turn; never rejects, logs the error class only. */
function fire(name: string, task: () => Promise<unknown>): Promise<void> {
  return Promise.resolve()
    .then(task)
    .then(
      () => undefined,
      (e) => console.warn(`[push] ${name} trigger failed (${errTag(e)})`),
    );
}

/** Enqueue `build(course)` for the course's audience; archived and non-course projects reach nobody. */
async function toCourse(
  projectId: string,
  build: (course: { id: string; slug: string }) => PushEvent | null,
  deps: TriggerDeps,
): Promise<number> {
  if (!deps.config().enabled) return 0;
  const course = await deps.course(projectId);
  const owners = await audienceForCourse(projectId, {
    project: async () => course,
    registeredOwners: deps.registeredOwners,
  });
  if (!course || owners.length === 0) return 0;
  const event = build({ id: projectId, slug: course.slug });
  return event ? deps.enqueue(owners, event, deps.now()) : 0;
}

/** files.added for one Lemida import (call after the final `recordFile`). Coalesced per course by the outbox. */
export function notifyFilesAdded(
  projectId: string,
  result: ImportOutcome,
  deps: TriggerDeps = dbTriggerDeps,
): Promise<void> {
  return fire('files.added', async () => {
    if (!filesAddedFor({ id: projectId, slug: '' }, result)) return; // decided before any lookup
    await toCourse(projectId, (course) => filesAddedFor(course, result), deps);
  });
}

/** note.synthesized for one synthesis run; `note` is the row as written (its `updatedAt` makes each run distinct). */
export function notifyNoteSynthesized(
  projectId: string,
  note: { id: string; updatedAt: Date },
  outcome: 'ready' | 'failed',
  deps: TriggerDeps = dbTriggerDeps,
): Promise<void> {
  return fire('note.synthesized', () =>
    toCourse(
      projectId,
      (course) =>
        noteSynthesized({
          courseSlug: course.slug,
          courseId: course.id,
          noteId: note.id,
          outcome,
          noteUpdatedAt: note.updatedAt,
        }),
      deps,
    ),
  );
}
