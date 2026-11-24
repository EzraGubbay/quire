// The Lemida engine: a poll loop that picks up commands the Quire panel queues, plus a passive session
// probe. Ported from tools/lemida-agent/src/agent.js; the Playwright calls are now Electron ones (see
// lemida-session.ts) and the `for(;;)` + sleep loop is re-homed onto a self-rescheduling timer so it
// coexists with the Electron event loop and stops cleanly on quit.
import path from 'node:path';
import { app } from 'electron';
import {
  initSessionCookies,
  isSignInInProgress,
  LOGIN_TIMEOUT_MS,
  openLogin,
  probe,
  SessionExpired,
  type SessionStatus,
  type SyncCourse,
  syncCourse,
} from './lemida-session';
import { autoSyncDue, runWithHeartbeat } from './lifecycle';
import { type LemidaCommand, type LemidaCourse, type NextCommandResponse, QuireClient } from './quire';
import { SeenStore } from './seen';
import { SyncLog } from './sync-log';
import { runSync as runSyncCourses, type SyncReport, safeUpload, summariseSync } from './sync-run';

const POLL_MS = Number(process.env.LEMIDA_POLL_MS ?? 5000);
const PROBE_MS = Number(process.env.LEMIDA_PROBE_MS ?? 3_600_000);
const HEARTBEAT_MS = 30_000;
const SYNC_DEADLINE_MS = Number(process.env.LEMIDA_SYNC_DEADLINE_MS ?? 3_600_000);

/** Per-kind watchdog: how long a command may run before the engine gives up on it. */
function commandDeadlineMs(kind: LemidaCommand['kind']): number {
  if (kind === 'open_login') return LOGIN_TIMEOUT_MS + 2 * 60_000;
  if (kind === 'probe') return 2 * 60_000;
  return SYNC_DEADLINE_MS;
}

export interface LemidaStatus {
  sessionStatus: SessionStatus;
  lastSyncSummary?: string;
  at: string;
}

export interface EngineOptions {
  quireUrl: string;
  /** Pushes status to the renderer (wired by main to mainWindow.webContents.send('lemida:status', …)). */
  emit?: (status: LemidaStatus) => void;
  /** Interval between automatic syncs while signed in, in ms; 0/undefined disables. */
  autoSyncMs?: number;
}

export class LemidaEngine {
  private readonly client: QuireClient;
  private readonly seen: SeenStore;
  private readonly log: SyncLog;
  private readonly emit: (status: LemidaStatus) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastProbe = 0;
  /** The command in flight (for quit cleanup) and the engine's last known session status / sync times. */
  private current: { id: string; kind: LemidaCommand['kind'] } | null = null;
  private sessionStatus: SessionStatus = 'unknown';
  private lastSyncEndedAt = 0;
  private lastAutoRequestAt = 0;
  private readonly autoSyncMs: number;

  constructor(opts: EngineOptions) {
    this.client = new QuireClient(opts.quireUrl);
    this.log = new SyncLog(path.join(app.getPath('userData'), 'logs'));
    this.seen = new SeenStore(path.join(app.getPath('userData'), 'lemida-seen.json'), (m) =>
      this.log.line(m),
    );
    this.emit = opts.emit ?? (() => {});
    this.autoSyncMs = opts.autoSyncMs ?? 0;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.seen.load().catch(() => {});
    // The one and only cookie restore of this launch (probe/sync/sign-in never restore). Names and counts only.
    const r = await initSessionCookies().catch((err: Error) => {
      console.error(`[lemida] cookie init failed: ${err.message}`);
      return null;
    });
    if (r) {
      console.log(
        `[lemida] cookies: restored ${r.restored.length}${r.restored.length ? ` (${r.restored.join(', ')})` : ''}, removed ${r.deduped} duplicate domain copies${r.migrated ? ', migrated plaintext file' : ''}`,
      );
    }
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
        await this.runCommand(payload.command, payload);
      } else if (!isSignInInProgress() && Date.now() - this.lastProbe > PROBE_MS) {
        this.lastProbe = Date.now();
        const status = await probe().catch((): SessionStatus => 'expired');
        await this.client.postState({ sessionStatus: status }).catch(() => {});
        this.pushStatus(status);
        console.log(`[lemida] passive probe → ${status}`);
      } else if (
        autoSyncDue({
          intervalMs: this.autoSyncMs,
          sessionStatus: this.sessionStatus,
          signInInProgress: isSignInInProgress(),
          now: Date.now(),
          lastSyncEndedAt: this.lastSyncEndedAt,
          lastAutoRequestAt: this.lastAutoRequestAt,
        })
      ) {
        await this.requestAutoSync('auto-timer');
      }
    } catch (err) {
      console.error(`[lemida] loop error: ${(err as Error).message}`);
    }
    this.scheduleNext();
  }

  /**
   * Ask the server to queue a sync (it coalesces with any queued/running sync and does nothing with no enabled
   * mappings), so an automatic sync gets the same lease / watchdog / panel status as a manual one. Failures
   * (offline, an old server without the route) are logged and retried no sooner than the next interval.
   */
  private async requestAutoSync(trigger: 'auto-sign-in' | 'auto-timer'): Promise<void> {
    this.lastAutoRequestAt = Date.now();
    try {
      const r = await this.client.enqueueSync(trigger);
      console.log(`[lemida] auto-sync (${trigger}) → ${r.created ? 'queued' : (r.reason ?? 'not queued')}`);
    } catch (err) {
      console.error(`[lemida] auto-sync (${trigger}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Run one command under a lease heartbeat and a per-kind watchdog. Heartbeats prove the app is alive (the server
   * reaps the row if they stop: quit, crash, sleep); the watchdog proves the command makes progress (a hang inside a
   * live app). Known limitation: an abandoned operation may still finish in the background; the server then ignores
   * its completion because the row is no longer running (`applied: false`).
   */
  private async runCommand(cmd: LemidaCommand, payload: NextCommandResponse): Promise<void> {
    this.current = { id: cmd.id, kind: cmd.kind };
    const deadlineMs = commandDeadlineMs(cmd.kind);
    let beating = true;
    try {
      const r = await runWithHeartbeat({
        run: () => this.handle(cmd, payload),
        beat: () => {
          if (!beating) return;
          // An old server without the route 404s: harmless, the legacy lease applies.
          void this.client
            .heartbeatCommand(cmd.id)
            .then((r) => {
              if (r && r.active === false && beating) {
                beating = false;
                console.warn(
                  `[lemida] server no longer sees command ${cmd.kind} as running; stopped heartbeating`,
                );
              }
            })
            .catch(() => {});
        },
        intervalMs: HEARTBEAT_MS,
        deadlineMs,
      });
      if (r.kind === 'timeout') {
        const mins = Math.round(deadlineMs / 60_000);
        console.error(`[lemida] command ${cmd.kind} timed out after ${mins} min`);
        await this.client
          .completeCommand(cmd.id, 'error', {
            reason: 'engine_timeout',
            message: `Timed out on the Mac after ${mins} min`,
          })
          .catch(() => {});
      }
    } finally {
      if (cmd.kind === 'sync') this.lastSyncEndedAt = Date.now();
      this.current = null;
    }
  }

  /** True while a command is running; main only delays quit (to fail it as `app_quit`) in that case. */
  hasCommandInFlight(): boolean {
    return this.current !== null;
  }

  /**
   * Stop polling and, if a command is in flight, fail it as `app_quit` (within `timeoutMs`) so the panel does not
   * show it as running until the lease lapses. Called from main's before-quit.
   */
  async shutdown(timeoutMs = 1500): Promise<void> {
    this.stop();
    const cur = this.current;
    if (!cur) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.client
        .completeCommand(cur.id, 'error', {
          reason: 'app_quit',
          message: 'The Quire desktop app quit while this was running.',
        })
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async handle(cmd: LemidaCommand, payload: NextCommandResponse): Promise<void> {
    try {
      if (cmd.kind === 'open_login') {
        const { status, outcome } = await openLogin({ onHeartbeat: () => this.heartbeat() });
        if (outcome === 'busy') {
          // Another sign-in owns the window: leave the session status alone.
          await this.client.completeCommand(cmd.id, 'done', {
            outcome,
            message: 'A sign-in window is already open',
          });
        } else if (outcome === 'timeout') {
          await this.client.postState({ sessionStatus: status });
          await this.client.completeCommand(cmd.id, 'error', {
            message: `Sign-in window timed out after ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} min`,
            outcome,
          });
          this.pushStatus(status);
        } else {
          await this.client.postState({ sessionStatus: status });
          await this.client.completeCommand(cmd.id, 'done', {
            sessionStatus: status,
            outcome,
            ...(outcome === 'closed' ? { message: 'Sign-in window was closed before finishing' } : {}),
          });
          this.pushStatus(status);
        }
        if (outcome === 'signed-in' || outcome === 'already-signed-in')
          await this.requestAutoSync('auto-sign-in');
        console.log(`[lemida] login → ${status} (${outcome})`);
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
        this.pushStatus(status ?? this.sessionStatus, summary);
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
          onLoaded: opts.onLoaded,
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
      const { status, outcome } = await openLogin({ onHeartbeat: () => this.heartbeat() });
      if (outcome !== 'busy') {
        await this.client.postState({ sessionStatus: status }).catch(() => {});
        this.pushStatus(status);
      }
      if (outcome === 'signed-in' || outcome === 'already-signed-in')
        void this.requestAutoSync('auto-sign-in');
      return status === 'valid' ? { ok: true } : { ok: false, reason: outcome === 'busy' ? 'busy' : status };
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
    this.sessionStatus = sessionStatus;
    try {
      this.emit({ sessionStatus, lastSyncSummary, at: new Date().toISOString() });
    } catch {
      // A dead renderer shouldn't break the loop.
    }
  }
}
