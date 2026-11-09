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
import type { Resource } from './moodle';
import { type LemidaCommand, type LemidaCourse, type NextCommandResponse, QuireClient } from './quire';
import { SeenStore } from './seen';

const POLL_MS = Number(process.env.LEMIDA_POLL_MS ?? 5000);
const PROBE_MS = Number(process.env.LEMIDA_PROBE_MS ?? 3_600_000);

interface Tally {
  imported: number;
  needs_review: number;
  duplicate: number;
  error: number;
}

function summarise(tally: Tally): string {
  const parts: string[] = [];
  if (tally.imported) parts.push(`${tally.imported} imported`);
  if (tally.needs_review) parts.push(`${tally.needs_review} to review`);
  if (tally.duplicate) parts.push(`${tally.duplicate} already had`);
  if (tally.error) parts.push(`${tally.error} failed`);
  return parts.join(', ') || 'nothing new';
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
}

export class LemidaEngine {
  private readonly client: QuireClient;
  private readonly seen: SeenStore;
  private readonly emit: (status: LemidaStatus) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastProbe = 0;

  constructor(opts: EngineOptions) {
    this.client = new QuireClient(opts.quireUrl);
    this.seen = new SeenStore(path.join(app.getPath('userData'), 'lemida-seen.json'));
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
        const summary = await this.runSync(payload.courses ?? []);
        const at = new Date().toISOString();
        await this.client.postState({ sessionStatus: 'valid', lastSyncSummary: summary, lastSyncAt: at });
        await this.client.completeCommand(cmd.id, 'done', { summary });
        this.pushStatus('valid', summary);
        console.log(`[lemida] sync → ${summary}`);
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

  /** Crawl every mapped course and upload each new file. Returns a one-line summary. */
  private async runSync(courses: LemidaCourse[]): Promise<string> {
    const tally: Tally = { imported: 0, needs_review: 0, duplicate: 0, error: 0 };
    for (const course of courses) {
      const key = course.lemidaUrl;
      const seen = this.seen.for(key);
      const sc: SyncCourse = {
        slug: course.slug,
        lemidaUrl: course.lemidaUrl,
        mappingId: course.mappingId,
        label: course.label,
      };
      const onFile = async (
        dl: { name: string; bytes: ArrayBuffer; contentType: string; sourceUrl: string },
        resource: Resource,
      ) => {
        try {
          const res = await this.client.importFile(course.slug, {
            fileName: dl.name,
            bytes: dl.bytes,
            contentType: dl.contentType,
            sourceUrl: dl.sourceUrl,
            sectionTitle: resource.sectionTitle,
            moduleType: resource.moduleType,
            mappingId: course.mappingId,
          });
          if (res.status in tally) tally[res.status as keyof Tally] += 1;
        } catch (err) {
          tally.error += 1;
          console.error(`[lemida] import failed (${dl.name}): ${(err as Error).message}`);
        }
      };
      console.log(`[lemida] → ${course.label} (${course.slug})`);
      const stats = await syncCourse(sc, onFile, { seen });
      await this.seen.save(key, seen);
      console.log(
        `[lemida]   ${stats.resources} activities, ${stats.downloaded} files, ${stats.skipped} skipped`,
      );
    }
    return summarise(tally);
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
