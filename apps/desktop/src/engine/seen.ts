// On-disk records of files the Quire server has accepted, per course and activity (v2). Replaces the v1
// "activity href was visited" set, which was poisoned (activities visited but nothing imported) and could not
// notice new files in a folder or files replaced in place. An unversioned (v1) file is discarded once.
// Lives under app.getPath('userData') in the desktop app. No Electron imports: testable under node:test.
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export interface FileRecord {
  sha256: string;
  etag?: string;
  at: string;
}
export interface ActivityRecord {
  files: Record<string /* fileUrl */, FileRecord>;
}
export type CourseRecords = Record<string /* activity href */, ActivityRecord>;
export interface SeenFileV2 {
  version: 2;
  courses: Record<string /* course lemidaUrl */, CourseRecords>;
}

export class SeenStore {
  private readonly file: string;
  private readonly log: (msg: string) => void;
  private data: SeenFileV2 = { version: 2, courses: {} };

  constructor(file: string, log: (msg: string) => void = () => {}) {
    this.file = file;
    this.log = log;
  }

  async load(): Promise<void> {
    this.data = { version: 2, courses: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // missing or corrupt: start empty
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { version?: unknown }).version === 2 &&
      typeof (parsed as { courses?: unknown }).courses === 'object' &&
      (parsed as { courses?: unknown }).courses !== null
    ) {
      this.data = parsed as SeenFileV2;
      return;
    }
    if (parsed && typeof parsed === 'object') {
      const courses = Object.values(parsed as Record<string, unknown>);
      const activities = courses.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
      this.log(`seen cache v1 discarded (${courses.length} courses, ${activities} activities)`);
    }
  }

  /** Live mutable records for one course (owned by the store). */
  course(key: string): CourseRecords {
    let c = this.data.courses[key];
    if (!c) {
      c = {};
      this.data.courses[key] = c;
    }
    return c;
  }

  recordFile(courseKey: string, activityHref: string, fileUrl: string, rec: FileRecord): void {
    const course = this.course(courseKey);
    let act = course[activityHref];
    if (!act) {
      act = { files: {} };
      course[activityHref] = act;
    }
    act.files[fileUrl] = rec;
  }

  private saving: Promise<void> = Promise.resolve();

  /**
   * Atomic whole-file write. Errors are swallowed but logged. Saves are serialized (they share one tmp file, so
   * overlapping writes could interleave), and each serializes `data` when its turn comes, so the last call wins.
   */
  save(): Promise<void> {
    const run = this.saving.then(() => this.write());
    this.saving = run;
    return run;
  }

  private async write(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.file);
    } catch (err) {
      this.log(`seen cache save failed: ${(err as Error).message}`);
    }
  }
}
