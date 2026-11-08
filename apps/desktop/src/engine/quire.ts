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
      throw new Error(`${method} ${pathname} → ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  /** The next queued command, or { command: null }. For sync it also carries the mapped courses. */
  nextCommand(): Promise<NextCommandResponse> {
    return this.json<NextCommandResponse>('GET', '/api/lemida/commands');
  }

  /** Enabled course mappings, for a one-off `sync` run. */
  listCourses(): Promise<{ courses: LemidaCourse[] }> {
    return this.json('GET', '/api/lemida/courses');
  }

  completeCommand(
    id: string,
    status: 'done' | 'error',
    result: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.json('POST', `/api/lemida/commands/${id}`, { status, result });
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
