// Whole-sync orchestration: per-course isolation (one failing course never aborts the rest), upload-result
// classification, and the one-line summary. Pure and Electron-free; the engine injects `syncCourse`.
import { NotEnrolled, SessionExpired } from './errors';
import { type CourseStats, emptyStats, type UploadOutcome } from './reconcile';

const SUMMARY_MAX = 480; // the state route caps lastSyncSummary at 500

export interface CourseLike {
  slug: string;
  label?: string;
}

export interface CourseReport {
  label: string;
  slug: string;
  ok: boolean;
  /** True when the course page loaded signed in as an enrolled student. */
  loaded: boolean;
  stats?: CourseStats;
  reason?: string;
}

export interface SyncReport {
  full: boolean;
  courses: CourseReport[];
  totals: CourseStats;
  sessionExpired?: string;
}

export interface RunSyncDeps<C extends CourseLike> {
  syncCourse: (course: C, opts: { full: boolean; onLoaded: () => void }) => Promise<CourseStats>;
  log: (msg: string) => void;
  full: boolean;
}

function describe(stats: CourseStats): string {
  return (
    `activities=${stats.activities} downloaded=${stats.downloaded} new=${stats.imported} review=${stats.review} ` +
    `alreadyHad=${stats.alreadyHad} unchanged=${stats.unchanged} downloadFailed=${stats.downloadFailed} ` +
    `uploadFailed=${stats.uploadFailed}`
  );
}

function addStats(into: CourseStats, s: CourseStats): void {
  into.activities += s.activities;
  into.downloaded += s.downloaded;
  into.imported += s.imported;
  into.review += s.review;
  into.alreadyHad += s.alreadyHad;
  into.unchanged += s.unchanged;
  into.downloadFailed += s.downloadFailed;
  into.uploadFailed += s.uploadFailed;
  into.failures.push(...s.failures);
}

export async function runSync<C extends CourseLike>(courses: C[], deps: RunSyncDeps<C>): Promise<SyncReport> {
  const { syncCourse, log, full } = deps;
  const report: SyncReport = { full, courses: [], totals: emptyStats() };
  for (let i = 0; i < courses.length; i++) {
    const course = courses[i] as C;
    const label = course.label || course.slug;
    log(`course ${label} (${course.slug}) start`);
    let loaded = false;
    try {
      const stats = await syncCourse(course, { full, onLoaded: () => (loaded = true) });
      addStats(report.totals, stats);
      report.courses.push({ label, slug: course.slug, ok: true, loaded: true, stats });
      log(`course ${label} done: ${describe(stats)}`);
    } catch (err) {
      if (err instanceof SessionExpired) {
        report.sessionExpired = err.message;
        report.courses.push({ label, slug: course.slug, ok: false, loaded: false, reason: 'signed out' });
        log(`course ${label} FAILED: signed out (${err.message})`);
        for (const rest of courses.slice(i + 1)) {
          report.courses.push({
            label: rest.label || rest.slug,
            slug: rest.slug,
            ok: false,
            loaded: false,
            reason: 'skipped (signed out)',
          });
        }
        break;
      }
      const reason = err instanceof NotEnrolled ? 'not enrolled' : (err as Error).message.slice(0, 80);
      report.courses.push({ label, slug: course.slug, ok: false, loaded, reason });
      log(`course ${label} FAILED: ${reason}`);
    }
  }
  return report;
}

export function summariseSync(report: SyncReport): string {
  const t = report.totals;
  const segs: string[] = [];
  const downloaded = t.imported + t.review + t.alreadyHad;
  if (downloaded > 0) {
    const parts: string[] = [];
    if (t.imported) parts.push(`${t.imported} new`);
    if (t.review) parts.push(`${t.review} to review`);
    if (t.alreadyHad) parts.push(`${t.alreadyHad} already had`);
    segs.push(`${downloaded} downloaded (${parts.join(', ')})`);
  }
  const failed = t.downloadFailed + t.uploadFailed;
  if (failed > 0) {
    const parts: string[] = [];
    if (t.downloadFailed) parts.push(`${t.downloadFailed} download`);
    if (t.uploadFailed) parts.push(`${t.uploadFailed} upload`);
    segs.push(`${failed} failed (${parts.join(', ')})`);
  }
  const failedCourses = report.courses
    .filter((c) => !c.ok)
    .map((c) => `${c.label} (${c.reason ?? 'failed'})`);
  const stopped = report.sessionExpired ? 'stopped: signed out of Lemida' : '';
  if (failedCourses.length > 0) {
    const fixed = [...segs, ...(stopped ? [stopped] : [])].join(' · ');
    const budget = SUMMARY_MAX - (fixed ? fixed.length + 3 : 0);
    let text = '';
    for (let k = failedCourses.length; k >= 0; k--) {
      const shown = failedCourses.slice(0, k);
      if (k < failedCourses.length) shown.push(`+${failedCourses.length - k} more`);
      text = `courses failed: ${shown.join(', ')}`;
      if (text.length <= budget) break;
    }
    segs.push(text);
  }
  if (stopped) segs.push(stopped);
  if (segs.length === 0) return `nothing new (${t.activities} activities checked)`;
  return segs.join(' · ').slice(0, SUMMARY_MAX);
}

// --- upload result classification --------------------------------------------------------------------

export interface ImportLike {
  status: string;
  duplicate?: boolean;
  error?: string | null;
  [k: string]: unknown;
}

/**
 * Whether the server accepted an upload. "Already have it" is `duplicate === true` (a duplicate hit returns
 * the existing row's status, which may be imported / needs_review / duplicate), or a plain imported /
 * needs_review. `status === 'error'` is a failure whatever else the body says.
 */
export function classifyImport(res: ImportLike): UploadOutcome {
  if (res.status === 'error') {
    return { ok: false, error: res.error ? `server import error: ${res.error}` : 'server import error' };
  }
  if (res.duplicate === true || res.status === 'duplicate') {
    const status = res.status === 'needs_review' || res.status === 'imported' ? res.status : 'duplicate';
    return { ok: true, status, duplicate: true };
  }
  if (res.status === 'imported' || res.status === 'needs_review') {
    return { ok: true, status: res.status, duplicate: false };
  }
  return { ok: false, error: `unexpected import status "${res.status}"` };
}

/** Run an import call and classify it; a throw (non-2xx, network) becomes a failed outcome. */
export async function safeUpload(importFn: () => Promise<ImportLike>): Promise<UploadOutcome> {
  try {
    return classifyImport(await importFn());
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}
