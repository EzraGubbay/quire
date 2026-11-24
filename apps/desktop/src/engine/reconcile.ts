// The per-activity reconcile step of a course sync: collect an activity's files, upload them, and record ONLY
// what the Quire server accepted. A file whose upload threw, or whose reply was an error, is left unrecorded
// so the next sync retries it. Records are persisted after every activity so progress survives a later
// exception. Pure and Electron-free (type-only imports) so it is testable under node:test.
import type { ActivityFailure, ActivityResult, Download } from './downloads';
import type { Resource } from './moodle';
import type { CourseRecords, FileRecord } from './seen';

export type UploadOutcome =
  | { ok: true; status: 'imported' | 'needs_review' | 'duplicate'; duplicate: boolean }
  | { ok: false; error: string };

export interface CourseStats {
  activities: number;
  downloaded: number;
  imported: number;
  review: number;
  alreadyHad: number;
  unchanged: number;
  downloadFailed: number;
  uploadFailed: number;
  failures: ActivityFailure[];
}

export interface ReconcileDeps {
  collect: (resource: Resource) => Promise<ActivityResult>;
  upload: (download: Download, resource: Resource) => Promise<UploadOutcome>;
  recordFile: (activityHref: string, fileUrl: string, rec: FileRecord) => void;
  persist: () => Promise<void>;
  log: (msg: string) => void;
}

export function emptyStats(): CourseStats {
  return {
    activities: 0,
    downloaded: 0,
    imported: 0,
    review: 0,
    alreadyHad: 0,
    unchanged: 0,
    downloadFailed: 0,
    uploadFailed: 0,
    failures: [],
  };
}

export async function reconcileResources(
  resources: Resource[],
  _opts: { records: CourseRecords; full: boolean },
  { collect, upload, recordFile, persist, log }: ReconcileDeps,
): Promise<CourseStats> {
  const stats = emptyStats();
  stats.activities = resources.length;
  for (const resource of resources) {
    const result = await collect(resource);
    for (const dl of result.files) {
      stats.downloaded++;
      const out = await upload(dl, resource);
      if (!out.ok) {
        stats.uploadFailed++;
        log(`upload ${dl.name} FAILED: ${out.error}`);
        continue; // not recorded: retried next sync
      }
      recordFile(resource.href, dl.fileUrl, {
        sha256: dl.sha256,
        etag: dl.etag,
        at: new Date().toISOString(),
      });
      if (out.duplicate || out.status === 'duplicate') stats.alreadyHad++;
      else if (out.status === 'needs_review') stats.review++;
      else stats.imported++;
      log(`upload ${dl.name} → ${out.status}${out.duplicate ? ' duplicate' : ''}`);
    }
    for (const u of result.unchanged) {
      recordFile(resource.href, u.fileUrl, {
        sha256: u.sha256 ?? '',
        etag: u.etag,
        at: new Date().toISOString(),
      });
      stats.unchanged++;
    }
    stats.downloadFailed += result.failures.length;
    stats.failures.push(...result.failures);
    await persist();
  }
  return stats;
}
