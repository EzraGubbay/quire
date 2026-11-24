// Per-activity collection: resource / folder / assignment logic over an injected `get()`, so it is testable
// without Electron. Every request is classified and logged; a login or bot bounce throws SessionExpired;
// every other failure is returned (never silently dropped as "no file").
import { createHash } from 'node:crypto';
import { SessionExpired } from './errors';
import {
  classifyResponse,
  formatRequestLog,
  type Outcome,
  type OutcomeKind,
  type RawResponse,
} from './fetch-outcome';
import { filenameFrom, parsePluginfileLinks, parseResourceWorkaround, type Resource } from './moodle';
import type { ActivityRecord } from './seen';

export interface Download {
  name: string;
  bytes: ArrayBuffer;
  contentType: string;
  /** Final URL after redirects (from net.request hops). */
  sourceUrl: string;
  /** The link we requested; the key of the file's record. */
  fileUrl: string;
  etag?: string;
  sha256: string;
}

export interface ActivityFailure {
  url: string;
  outcome: OutcomeKind;
  status?: number;
  detail: string;
}

export interface UnchangedFile {
  fileUrl: string;
  etag?: string;
  sha256?: string;
}

export interface ActivityResult {
  files: Download[];
  unchanged: UnchangedFile[];
  failures: ActivityFailure[];
}

export type GetFn = (url: string, opts: { ifNoneMatch?: string }) => Promise<RawResponse>;

export interface CollectContext {
  get: GetFn;
  records: ActivityRecord | undefined;
  full: boolean;
  log: (msg: string) => void;
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export async function collectActivity(resource: Resource, ctx: CollectContext): Promise<ActivityResult> {
  const { get, records, full, log } = ctx;
  const result: ActivityResult = { files: [], unchanged: [], failures: [] };

  async function request(
    url: string,
    expect: 'file' | 'page',
    ifNoneMatch?: string,
  ): Promise<{ raw: RawResponse; outcome: Outcome }> {
    const raw = await get(url, ifNoneMatch ? { ifNoneMatch } : {});
    let outcome = classifyResponse(raw, expect, resource.moduleType);
    // An embed page that carries a file link is expected, not a failure: log it distinctly.
    if (
      outcome.kind === 'html_no_link' &&
      resource.moduleType === 'mod_resource' &&
      outcome.html !== undefined &&
      parseResourceWorkaround(outcome.html, raw.finalUrl || url)
    ) {
      outcome = { ...outcome, kind: 'resource_page', detail: 'resource embed page with a file link' };
    }
    log(formatRequestLog(resource.href, raw, outcome));
    if (outcome.kind === 'login_page' || outcome.kind === 'bot_page') {
      throw new SessionExpired(raw.finalUrl || url);
    }
    return { raw, outcome };
  }

  const fail = (url: string, outcome: Outcome, detail = outcome.detail): void => {
    result.failures.push({ url, outcome: outcome.kind, status: outcome.status, detail });
  };

  /** Fetch one file link (conditional when we hold its etag) and sort the answer into the result. */
  async function fetchFile(link: string, recordKey: string, etag: string | undefined): Promise<void> {
    const sendEtag = full ? undefined : etag;
    const { raw, outcome } = await request(link, 'file', sendEtag);
    const rec = records?.files[recordKey];
    if (outcome.kind === 'not_modified') {
      result.unchanged.push({ fileUrl: recordKey, etag: rec?.etag ?? etag, sha256: rec?.sha256 });
      return;
    }
    if (outcome.kind !== 'file' || !raw.body) {
      fail(link, outcome);
      return;
    }
    const sha256 = createHash('sha256').update(raw.body).digest('hex');
    const newEtag = raw.headers.etag || undefined;
    if (!full && records && Object.values(records.files).some((r) => r.sha256 === sha256)) {
      result.unchanged.push({ fileUrl: link, etag: newEtag, sha256 });
      return;
    }
    const finalUrl = raw.finalUrl || link;
    result.files.push({
      name: filenameFrom(finalUrl, raw.headers['content-disposition']),
      bytes: toArrayBuffer(raw.body),
      contentType: raw.headers['content-type'] ?? '',
      sourceUrl: finalUrl,
      fileUrl: link,
      etag: newEtag,
      sha256,
    });
  }

  if (resource.moduleType === 'mod_resource') {
    // Conditional request with the etag of the most recently recorded file for this activity.
    let latestKey: string | undefined;
    if (!full && records) {
      let best = '';
      for (const [k, r] of Object.entries(records.files)) {
        if (r.at >= best) {
          best = r.at;
          latestKey = k;
        }
      }
    }
    const latestEtag = latestKey ? records?.files[latestKey]?.etag : undefined;
    const { raw, outcome } = await request(resource.href, 'file', latestEtag);
    if (outcome.kind === 'not_modified') {
      const rec = latestKey ? records?.files[latestKey] : undefined;
      result.unchanged.push({ fileUrl: latestKey ?? resource.href, etag: rec?.etag, sha256: rec?.sha256 });
      return result;
    }
    if (outcome.kind === 'file' && raw.body) {
      const sha256 = createHash('sha256').update(raw.body).digest('hex');
      const newEtag = raw.headers.etag || undefined;
      if (!full && records && Object.values(records.files).some((r) => r.sha256 === sha256)) {
        result.unchanged.push({ fileUrl: resource.href, etag: newEtag, sha256 });
        return result;
      }
      const finalUrl = raw.finalUrl || resource.href;
      result.files.push({
        name: filenameFrom(finalUrl, raw.headers['content-disposition']),
        bytes: toArrayBuffer(raw.body),
        contentType: raw.headers['content-type'] ?? '',
        sourceUrl: finalUrl,
        fileUrl: resource.href,
        etag: newEtag,
        sha256,
      });
      return result;
    }
    if ((outcome.kind === 'html_no_link' || outcome.kind === 'resource_page') && outcome.html !== undefined) {
      const link = parseResourceWorkaround(outcome.html, raw.finalUrl || resource.href);
      if (!link) {
        fail(resource.href, outcome, 'resource page has no file link');
        return result;
      }
      await fetchFile(link, link, records?.files[link]?.etag);
      return result;
    }
    fail(resource.href, outcome);
    return result;
  }

  // mod_folder / mod_assign: read the page, then every pluginfile link on it.
  const { raw, outcome } = await request(resource.href, 'page');
  if (outcome.kind !== 'page') {
    fail(resource.href, outcome);
    return result;
  }
  const links = parsePluginfileLinks(outcome.html ?? '', raw.finalUrl || resource.href);
  for (const link of links) {
    await fetchFile(link, link, records?.files[link]?.etag);
  }
  return result;
}
