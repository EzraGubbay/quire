// homework.due (ADR 0003 §1): the scheduler's 10-minute scan. Assignments due in (now, now + 24 h] that are still
// open (not_started | in_progress), in active course projects, get one reminder per deadline: the dedupe key carries
// the due time, so a second scan enqueues nothing and a moved deadline re-arms. HIGH priority, TTL until due.
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { assignments, projects } from '@/db/schema';
import { audienceForCourse, courseCanNotify, dbAudience } from './audience';
import { type PushConfig, pushConfig } from './config';
import { homeworkDue, type PushEvent } from './events';
import { enqueuePush } from './outbox';

export const DEADLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = ['not_started', 'in_progress'] as const;

export interface DeadlineCandidate {
  id: string;
  projectId: string;
  number: number;
  dueAt: Date | null;
  status: string;
  sheetDocumentId: string | null;
  course: { slug: string; kind: string; status: string };
}

export interface DeadlineDeps {
  config: () => PushConfig;
  /** Open assignments due in (from, to] in active course projects. */
  candidates(from: Date, to: Date): Promise<DeadlineCandidate[]>;
  registeredOwners(): Promise<string[]>;
  enqueue(audience: readonly string[], event: PushEvent, now: Date): Promise<number>;
}

export const dbDeadlineDeps: DeadlineDeps = {
  config: () => pushConfig(),
  async candidates(from, to) {
    const rows = await db
      .select({
        id: assignments.id,
        projectId: assignments.projectId,
        number: assignments.number,
        dueAt: assignments.dueAt,
        status: assignments.status,
        sheetDocumentId: assignments.sheetDocumentId,
        slug: projects.slug,
        kind: projects.kind,
        projectStatus: projects.status,
      })
      .from(assignments)
      .innerJoin(projects, eq(projects.id, assignments.projectId))
      .where(
        and(
          eq(projects.kind, 'course'),
          eq(projects.status, 'active'),
          inArray(assignments.status, [...OPEN_STATUSES]),
          gt(assignments.dueAt, from),
          lte(assignments.dueAt, to),
        ),
      );
    return rows.map(({ slug, kind, projectStatus, ...a }) => ({
      ...a,
      course: { slug, kind, status: projectStatus },
    }));
  },
  registeredOwners: () => dbAudience.registeredOwners(),
  enqueue: (audience, event, now) => enqueuePush(audience, event, { now }),
};

/** The same rule the SQL applies, re-checked per row: open, due in (now, now + 24 h], active course. */
export function remindable(a: DeadlineCandidate, now: Date): boolean {
  if (!a.dueAt || !(OPEN_STATUSES as readonly string[]).includes(a.status)) return false;
  const until = a.dueAt.getTime() - now.getTime();
  return until > 0 && until <= DEADLINE_WINDOW_MS && courseCanNotify(a.course);
}

/** One scan; returns the rows enqueued. A no-op (no query) when push is disabled. */
export async function scanDeadlines(
  now: Date = new Date(),
  deps: DeadlineDeps = dbDeadlineDeps,
): Promise<number> {
  if (!deps.config().enabled) return 0;
  const due = (await deps.candidates(now, new Date(now.getTime() + DEADLINE_WINDOW_MS))).filter((a) =>
    remindable(a, now),
  );
  if (due.length === 0) return 0;
  let owners: Promise<string[]> | undefined;
  const registeredOwners = () => (owners ??= deps.registeredOwners()); // once per scan
  let enqueued = 0;
  for (const a of due) {
    const audience = await audienceForCourse(a.projectId, {
      project: async () => a.course,
      registeredOwners,
    });
    if (audience.length === 0 || !a.dueAt) continue;
    enqueued += await deps.enqueue(
      audience,
      homeworkDue({
        courseSlug: a.course.slug,
        courseId: a.projectId,
        assignmentId: a.id,
        number: a.number,
        dueAt: a.dueAt,
        fileId: a.sheetDocumentId,
        now,
      }),
      now,
    );
  }
  return enqueued;
}
