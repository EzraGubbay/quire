// Single-use, short-lived upload links: the server-side capability behind create_upload_link and
// PUT /api/upload-links/<token>. A link is bound (course, section, filename, folder, type, size cap) when it is
// minted, so the PUT can carry nothing but file bytes. Only sha256(token) is stored: the raw token is never
// kept or logged. State is in-process (production is one Node process; a restart just answers 410 and the
// client mints a new link). It lives on globalThis because Next can bundle the /mcp route and the PUT route
// as separate module instances that must share it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

export const linkConfig = () => ({
  ttlMs: num(process.env.MCP_UPLOAD_LINK_TTL_MS, 10 * 60 * 1000),
  maxOpen: num(process.env.MCP_UPLOAD_LINK_MAX_OPEN, 50),
  // 95 MB: Cloudflare's edge limit is 100 MB per request and the body carries a little overhead.
  maxPdfBytes: num(process.env.MCP_UPLOAD_LINK_MAX_PDF_BYTES, 95 * 1024 * 1024),
  maxMarkdownBytes: num(process.env.MCP_UPLOAD_LINK_MAX_MD_BYTES, 2 * 1024 * 1024),
  deadlineMs: num(process.env.MCP_UPLOAD_LINK_DEADLINE_MS, 90_000),
});

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STATUSES = 500;

export interface LinkBinding {
  projectId: string;
  section: 'notes' | 'documents';
  kind: 'pdf' | 'markdown';
  filename: string;
  title?: string;
  folderId: string | null;
  folderName: string | null;
  contentType: string;
  maxBytes: number;
}
export interface Link extends LinkBinding {
  uploadId: string;
  expiresAt: number;
}
export type UploadState = 'pending' | 'processing' | 'created' | 'duplicate' | 'failed' | 'expired';
export interface UploadStatus {
  uploadId: string;
  state: UploadState;
  updatedAt: number;
  expiresAt?: number;
  /** The ingestion result once finished (ids, openUrl, …). */
  result?: Record<string, unknown>;
  error?: string;
}

interface Store {
  links: Map<string, Link>;
  statuses: Map<string, UploadStatus>;
}
const g = globalThis as unknown as { __quireMcpUploadLinks?: Store };
const store = (): Store => {
  g.__quireMcpUploadLinks ??= { links: new Map(), statuses: new Map() };
  return g.__quireMcpUploadLinks;
};

let now: () => number = Date.now;
/** Test hook: inject a clock. */
export const setClock = (fn: (() => number) | null): void => {
  now = fn ?? Date.now;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function sweep(): void {
  const t = now();
  const { links, statuses } = store();
  for (const [h, l] of links) {
    if (l.expiresAt > t) continue;
    links.delete(h);
    const s = statuses.get(l.uploadId);
    if (s?.state === 'pending') statuses.set(l.uploadId, { ...s, state: 'expired', updatedAt: t });
  }
  for (const [id, s] of statuses) if (t - s.updatedAt > STATUS_TTL_MS) statuses.delete(id);
  while (statuses.size > MAX_STATUSES) {
    const oldest = statuses.keys().next().value;
    if (oldest === undefined) break;
    statuses.delete(oldest);
  }
}

export function createLink(binding: LinkBinding): { token: string; uploadId: string; expiresAt: Date } {
  sweep();
  const cfg = linkConfig();
  const { links, statuses } = store();
  if (links.size >= cfg.maxOpen) {
    throw new Error('Too many open upload links; wait for some to be used or to expire (10 minutes).');
  }
  const token = randomBytes(32).toString('base64url');
  const uploadId = randomUUID();
  const expiresAt = now() + cfg.ttlMs;
  links.set(hashToken(token), { ...binding, uploadId, expiresAt });
  statuses.set(uploadId, { uploadId, state: 'pending', updatedAt: now(), expiresAt });
  return { token, uploadId, expiresAt: new Date(expiresAt) };
}

/** Validates a link without consuming it (header problems must leave it usable). */
export function peekLink(token: string): Link | null {
  sweep();
  return store().links.get(hashToken(token)) ?? null;
}

/** Atomic delete-and-return: only one caller ever gets the link. */
export function claimLink(token: string): Link | null {
  sweep();
  const h = hashToken(token);
  const link = store().links.get(h);
  if (!link) return null;
  store().links.delete(h);
  return link;
}

export function setStatus(uploadId: string, patch: Partial<Omit<UploadStatus, 'uploadId'>>): void {
  const { statuses } = store();
  const cur = statuses.get(uploadId) ?? { uploadId, state: 'pending' as const, updatedAt: now() };
  statuses.set(uploadId, { ...cur, ...patch, updatedAt: now() });
}

export function getStatus(uploadId: string): UploadStatus | undefined {
  sweep();
  return store().statuses.get(uploadId);
}

/** Test hook: the raw store, to assert the token is never kept. */
export const __storeForTests = (): Store => store();
