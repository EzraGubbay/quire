// The Lemida engine: a poll loop that picks up commands the Quire panel queues, plus a passive session
// probe. Ported from tools/lemida-agent/src/agent.js; the Playwright calls are now Electron ones (see
// lemida-session.ts) and the `for(;;)` + sleep loop is re-homed onto a self-rescheduling timer so it
// coexists with the Electron event loop and stops cleanly on quit.
import path from 'node:path';
import { app } from 'electron';
import {
  isSignInInProgress,
  openLogin,
  probe,
  SessionExpired,
  type SessionStatus,
  type SyncCourse,
  syncCourse,
} from './lemida-session';
import { type LemidaCommand, type LemidaCourse, type NextCommandResponse, QuireClient } from './quire';
import { SeenStore } from './seen';
import { SyncLog } from './sync-log';
import { runSync as runSyncCourses, type SyncReport, safeUpload, summariseSync } from './sync-run';

const POLL_MS = Number(process.env.LEMIDA_POLL_MS ?? 5000);
const PROBE_MS = Number(process.env.LEMIDA_PROBE_MS ?? 3_600_000);

export interface LemidaStatus {
  sessionStatus: SessionStatus;
  lastSyncSummary?: string;
  at: string;
}

export interface EngineOptions {
  quireUrl: string;
  /** Pushes status to the renderer (wired by main to mainWindow.webContents.send('lemida:status', …)). */
  emit?: (status: LemidaStatus) => void;
}

export class LemidaEngine {
  private readonly client: QuireClient;
  private readonly seen: SeenStore;
  private readonly log: SyncLog;
  private readonly emit: (status: LemidaStatus) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastProbe = 0;

  constructor(opts: EngineOptions) {
    this.client = new QuireClient(opts.quireUrl);
    this.log = new SyncLog(path.join(app.getPath('userData'), 'logs'));
    this.seen = new SeenStore(path.join(app.getPath('userData'), 'lemida-seen.json'), (m) =>
      this.log.line(m),
    );
    this.emit = opts.emit ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.seen.load().catch(() => {});
    console.log(`[lemida] engine watching (poll ${POLL_MS}ms, probe ${PROBE_MS}ms)`);
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(ms: number = POLL_MS): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const payload = await this.client.nextCommand();
      if (payload.command) {
        await this.handle(payload.command, payload);
      } else if (!isSignInInProgress() && Date.now() - this.lastProbe > PROBE_MS) {
        this.lastProbe = Date.now();
        const status = await probe().catch((): SessionStatus => 'expired');
        await this.client.postState({ sessionStatus: status }).catch(() => {});
        this.pushStatus(status);
        console.log(`[lemida] passive probe → ${status}`);
      }
    } catch (err) {
      console.error(`[lemida] loop error: ${(err as Error).message}`);
    }
    this.scheduleNext();
  }

  private async handle(cmd: LemidaCommand, payload: NextCommandResponse): Promise<void> {
    try {
      if (cmd.kind === 'open_login') {
        const status = await openLogin({ onHeartbeat: () => this.heartbeat() });
        await this.client.postState({ sessionStatus: status });
        await this.client.completeCommand(cmd.id, 'done', { sessionStatus: status });
        this.pushStatus(status);
        console.log(`[lemida] login → ${status}`);
      } else if (cmd.kind === 'probe') {
        const status = await probe();
        await this.client.postState({ sessionStatus: status });
        await this.client.completeCommand(cmd.id, 'done', { sessionStatus: status });
        this.pushStatus(status);
        console.log(`[lemida] probe → ${status}`);
      } else if (cmd.kind === 'sync') {
        const full = cmd.payload?.full === true;
        const courses = payload.courses ?? [];
        this.log.line(`sync start full=${full} courses=${courses.length}`);
        const report = await this.runSync(courses, full);
        const summary = summariseSync(report);
        const at = new Date().toISOString();
        const status: SessionStatus | undefined = report.sessionExpired
          ? 'expired'
          : report.courses.some((c) => c.loaded)
            ? 'valid'
            : undefined;
        await this.client.postState({
          ...(status ? { sessionStatus: status } : {}),
          lastSyncSummary: summary,
          lastSyncAt: at,
        });
        const failedCourses = report.courses
          .filter((c) => !c.ok)
          .map((c) => ({ label: c.label, reason: c.reason }));
        const allFailed = report.courses.length > 0 && failedCourses.length === report.courses.length;
        const isError = Boolean(report.sessionExpired) || allFailed;
        await this.client.completeCommand(cmd.id, isError ? 'error' : 'done', {
          summary,
          downloaded: report.totals.imported + report.totals.review + report.totals.alreadyHad,
          failed: report.totals.downloadFailed + report.totals.uploadFailed,
          failedCourses,
          ...(isError ? { message: summary } : {}),
        });
        this.pushStatus(status ?? 'unknown', summary);
        this.log.line(`sync done: ${summary}`);
      }
    } catch (err) {
      const expired = err instanceof SessionExpired;
      if (expired) {
        await this.client.postState({ sessionStatus: 'expired' }).catch(() => {});
        this.pushStatus('expired');
      }
      await this.client.completeCommand(cmd.id, 'error', { message: (err as Error).message }).catch(() => {});
      console.error(`[lemida] command ${cmd.kind} failed: ${(err as Error).message}`);
    }
  }

  /** Crawl every mapped course and upload each new or changed file. Each course is isolated. */
  private runSync(courses: LemidaCourse[], full: boolean): Promise<SyncReport> {
    const log = (msg: string): void => this.log.line(msg);
    return runSyncCourses(courses, {
      full,
      log,
      syncCourse: (course, opts) => {
        const key = course.lemidaUrl;
        const sc: SyncCourse = {
          slug: course.slug,
          lemidaUrl: course.lemidaUrl,
          mappingId: course.mappingId,
          label: course.label,
        };
        return syncCourse(sc, {
          records: this.seen.course(key),
          full: opts.full,
          log,
          recordFile: (href, fileUrl, rec) => this.seen.recordFile(key, href, fileUrl, rec),
          persist: () => this.seen.save(),
          upload: (dl, resource) =>
            safeUpload(() =>
              this.client.importFile(course.slug, {
                fileName: dl.name,
                bytes: dl.bytes,
                contentType: dl.contentType,
                sourceUrl: dl.sourceUrl,
                sectionTitle: resource.sectionTitle,
                moduleType: resource.moduleType,
                mappingId: course.mappingId,
              }),
            ),
        });
      },
    });
  }

  /** Entry point for the native menu / preload IPC: open the embedded sign-in window directly. */
  async signIn(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const status = await openLogin({ onHeartbeat: () => this.heartbeat() });
      await this.client.postState({ sessionStatus: status }).catch(() => {});
      this.pushStatus(status);
      return status === 'valid' ? { ok: true } : { ok: false, reason: status };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /** Touch the agent heartbeat (updates `agentSeenAt`) without changing the session status. Used to keep the
   *  panel's "agent online" fresh while a long sign-in window is open and the poll loop is parked. */
  private heartbeat(): void {
    void this.client.postState({}).catch(() => {});
  }

  private pushStatus(sessionStatus: SessionStatus, lastSyncSummary?: string): void {
    try {
      this.emit({ sessionStatus, lastSyncSummary, at: new Date().toISOString() });
    } catch {
      // A dead renderer shouldn't break the loop.
    }
  }
}
