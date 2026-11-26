// Minimal Google Drive v3 REST client (plain fetch). Only www.googleapis.com is ever called, always with a
// fixed base and an encoded file id: no SSRF surface. Reads only (the service account is a Viewer). Logs and
// errors carry nothing from Drive response bodies.
import type { EnabledDriveConfig } from './config';
import { DRIVE_ID_RE } from './config';
import { DriveError, networkError, serviceTokenSource, type TokenSource } from './google-auth';

const API = 'https://www.googleapis.com/drive/v3';
export const GDOC_MIME = 'application/vnd.google-apps.document';
const META_FIELDS = 'id,name,mimeType,size,parents,trashed,sha256Checksum,createdTime';
const META_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 5;

export interface DriveMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  parents?: string[];
  trashed?: boolean;
  sha256Checksum?: string;
  createdTime?: string;
}

export type DriveKind = 'pdf' | 'markdown' | 'gdoc' | 'unsupported';

/** A bare Drive id, or the id inside a drive.google.com / docs.google.com link. Anything else throws. */
export function parseDriveFileId(input: string): string {
  const s = input.trim();
  if (DRIVE_ID_RE.test(s)) return s;
  let url: URL | null = null;
  try {
    url = new URL(s);
  } catch {
    url = null;
  }
  if (url && url.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(url.hostname)) {
    const m = /\/(?:file|document)\/d\/([^/?#]+)/.exec(url.pathname);
    const id = m?.[1] ?? url.searchParams.get('id');
    if (id && DRIVE_ID_RE.test(id)) return id;
  }
  throw new Error(
    'fileId must be a Google Drive file id or a drive.google.com / docs.google.com link to the file.',
  );
}

const MD_NAME = /\.(md|markdown)$/i;
export function classifyDriveFile(m: Pick<DriveMeta, 'mimeType' | 'name'>): DriveKind {
  const t = m.mimeType.toLowerCase();
  if (t === 'application/pdf') return 'pdf';
  if (t === 'application/octet-stream' && /\.pdf$/i.test(m.name)) return 'pdf';
  if (t === 'text/markdown' || t === 'text/x-markdown') return 'markdown';
  if ((t === 'text/plain' || t === 'application/octet-stream') && MD_NAME.test(m.name)) return 'markdown';
  if (t === GDOC_MIME) return 'gdoc';
  return 'unsupported';
}

type Fetch = typeof globalThis.fetch;

export interface DriveClient {
  getMeta(fileId: string): Promise<DriveMeta>;
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
  exportMarkdown(fileId: string, maxBytes: number): Promise<Uint8Array>;
  listInbox(): Promise<DriveMeta[]>;
}

function toMeta(raw: unknown): DriveMeta {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== 'string') throw new DriveError('BAD_RESPONSE');
  const size = typeof r.size === 'string' || typeof r.size === 'number' ? Number(r.size) : undefined;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '',
    mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
    size: size !== undefined && Number.isFinite(size) ? size : undefined,
    parents: Array.isArray(r.parents)
      ? r.parents.filter((p): p is string => typeof p === 'string')
      : undefined,
    trashed: r.trashed === true,
    sha256Checksum: typeof r.sha256Checksum === 'string' ? r.sha256Checksum.toLowerCase() : undefined,
    createdTime: typeof r.createdTime === 'string' ? r.createdTime : undefined,
  };
}

export function driveClient(
  config: Pick<EnabledDriveConfig, 'clientEmail' | 'privateKey' | 'inboxFolderId'>,
  opts: { fetch?: Fetch; now?: () => number; tokens?: TokenSource } = {},
): DriveClient {
  const doFetch: Fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const tokens = opts.tokens ?? serviceTokenSource(config, { fetch: opts.fetch, now: opts.now });

  /** One authorised GET; a 401 clears the cached token and retries once. Non-2xx statuses throw. */
  async function get(url: string, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await tokens.getToken();
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw networkError(e);
      }
      if (res.ok) return res;
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        tokens.clear();
        continue;
      }
      let reason = '';
      if (res.status === 403) {
        const j = (await res.json().catch(() => null)) as {
          error?: { errors?: { reason?: string }[]; status?: string };
        } | null;
        reason = j?.error?.errors?.[0]?.reason ?? '';
      } else {
        await res.body?.cancel().catch(() => {});
      }
      if (res.status === 401) throw new DriveError('AUTH_REJECTED');
      if (res.status === 404) throw new DriveError('NOT_VISIBLE');
      if (res.status === 403) {
        if (reason === 'exportSizeLimitExceeded') throw new DriveError('EXPORT_TOO_LARGE');
        if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
          throw new DriveError('UNAVAILABLE');
        throw new DriveError('NOT_VISIBLE');
      }
      if (res.status === 429 || res.status >= 500) throw new DriveError('UNAVAILABLE');
      throw new DriveError('BAD_RESPONSE');
    }
  }

  async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new DriveError('TOO_LARGE');
    }
    if (!res.body) throw new DriveError('BAD_RESPONSE');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new DriveError('TOO_LARGE');
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof DriveError) throw e;
      throw networkError(e);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  const fileUrl = (id: string, suffix = '') => `${API}/files/${encodeURIComponent(id)}${suffix}`;

  return {
    async getMeta(fileId) {
      const qs = new URLSearchParams({ fields: META_FIELDS, supportsAllDrives: 'true' });
      const res = await get(`${fileUrl(fileId)}?${qs}`, META_TIMEOUT_MS);
      return toMeta(await res.json().catch(() => null));
    },
    async download(fileId, maxBytes) {
      const qs = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
      return readCapped(await get(`${fileUrl(fileId)}?${qs}`, DOWNLOAD_TIMEOUT_MS), maxBytes);
    },
    async exportMarkdown(fileId, maxBytes) {
      const qs = new URLSearchParams({ mimeType: 'text/markdown' });
      return readCapped(await get(`${fileUrl(fileId, '/export')}?${qs}`, DOWNLOAD_TIMEOUT_MS), maxBytes);
    },
    async listInbox() {
      const out: DriveMeta[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const qs = new URLSearchParams({
          q: `'${config.inboxFolderId}' in parents and trashed=false`,
          fields: `nextPageToken,files(${META_FIELDS})`,
          orderBy: 'createdTime',
          pageSize: '100',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        if (pageToken) qs.set('pageToken', pageToken);
        const res = await get(`${API}/files?${qs}`, META_TIMEOUT_MS);
        const j = (await res.json().catch(() => null)) as {
          files?: unknown[];
          nextPageToken?: string;
        } | null;
        for (const f of j?.files ?? []) out.push(toMeta(f));
        pageToken = j?.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    },
  };
}
