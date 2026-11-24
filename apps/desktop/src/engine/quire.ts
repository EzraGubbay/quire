// Thin client for Quire's Lemida API, ported from tools/lemida-agent/src/quire.js.
//
// Auth model (decided): instead of a bearer key, every request goes through the DEFAULT session's
// `fetch`, so the GitHub/NextAuth cookie the main window signed in with is sent automatically. No secret
// is stored in the desktop app. The engine therefore only reaches the API while the Quire window is
// signed in — which it is, to use the app. The proxy accepts a valid session cookie on /api/* equally
// to the bearer key.
import { session } from 'electron';

export interface LemidaCourse {
  mappingId: string;
  slug: string;
  lemidaUrl: string;
  lemidaCourseId: string | null;
  label: string;
}

export interface LemidaCommand {
  id: string;
  kind: 'open_login' | 'probe' | 'sync';
  payload: Record<string, unknown>;
}

export interface NextCommandResponse {
  command: LemidaCommand | null;
  courses?: LemidaCourse[];
}

export interface StatePatch {
  sessionStatus?: 'unknown' | 'valid' | 'expired';
  lastSyncSummary?: string;
  lastSyncAt?: string;
}

export interface ImportArgs {
  fileName: string;
  bytes: ArrayBuffer;
  contentType: string;
  sourceUrl?: string;
  sectionTitle?: string;
  moduleType?: string;
  mappingId?: string;
}

/** The import route returns the placement result; we only read `status` for the sync tally. */
export interface ImportResult {
  status: string;
  [k: string]: unknown;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class QuireClient {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async json<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await session.defaultSession.fetch(`${this.base}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(`${method} ${pathname} → ${res.status} ${text}`, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * The next queued command, or { command: null }. For sync it also carries the mapped courses. `lease=1` tells
   * the server we heartbeat, so a claimed command gets the short lease (an old server just ignores the flag).
   */
  nextCommand(): Promise<NextCommandResponse> {
    return this.json<NextCommandResponse>('GET', '/api/lemida/commands?lease=1');
  }

  /** Lease proof-of-life while a command runs. `active: false` means the server no longer sees it as running. */
  heartbeatCommand(id: string): Promise<{ active: boolean }> {
    return this.json('POST', `/api/lemida/commands/${id}/heartbeat`);
  }

  /** Ask the server to queue an automatic sync (it refuses if one is already queued/running or nothing is mapped). */
  enqueueSync(
    trigger: 'auto-sign-in' | 'auto-timer',
  ): Promise<{ created: boolean; reason?: string; id: string | null }> {
    return this.json('POST', '/api/lemida/commands', { kind: 'sync', trigger });
  }

  /** Enabled course mappings, for a one-off `sync` run. */
  listCourses(): Promise<{ courses: LemidaCourse[] }> {
    return this.json('GET', '/api/lemida/courses');
  }

  /** Report an outcome. Retries 3x (1 s, 3 s) on a network error or 5xx; if all fail the server's lease cleans up. */
  async completeCommand(
    id: string,
    status: 'done' | 'error',
    result: Record<string, unknown> = {},
  ): Promise<unknown> {
    const backoff = [1000, 3000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.json('POST', `/api/lemida/commands/${id}`, { status, result });
      } catch (err) {
        const code = err instanceof HttpError ? err.status : 0;
        const retryable = code === 0 || code >= 500;
        const wait = backoff[attempt];
        if (!retryable || wait === undefined) throw err;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  postState(patch: StatePatch): Promise<unknown> {
    return this.json('POST', '/api/lemida/state', patch);
  }

  /** Upload one downloaded file to a course; the server hashes, dedupes, classifies and places it. */
  async importFile(slug: string, args: ImportArgs): Promise<ImportResult> {
    const { fileName, bytes, contentType, sourceUrl, sectionTitle, moduleType, mappingId } = args;
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), fileName);
    form.set('fileName', fileName);
    if (sourceUrl) form.set('sourceUrl', sourceUrl);
    if (sectionTitle) form.set('sectionTitle', sectionTitle);
    if (moduleType) form.set('moduleType', moduleType);
    if (mappingId) form.set('mappingId', mappingId);
    const res = await session.defaultSession.fetch(`${this.base}/api/projects/${slug}/lemida/import`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`import ${slug} → ${res.status} ${text}`);
    }
    return (await res.json()) as ImportResult;
  }
}
