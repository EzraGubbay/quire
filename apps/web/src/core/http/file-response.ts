// HTTP file responses shared by every byte route: Range (206/416), a strong ETag, If-None-Match (304),
// If-Range (strong-only) and an RFC 5987 `filename*` Content-Disposition (RFC 9110 §13, §14).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export type RangeResult =
  | { kind: 'none' } // no/ignored Range header → serve the full body with 200
  | { kind: 'range'; start: number; end: number } // inclusive byte offsets → 206
  | { kind: 'unsatisfiable' }; // → 416

/** Parse a `Range` header against a representation of `size` bytes. Malformed, non-`bytes` and multi-range headers are ignored. */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'none' };
  const a = m[1] as string;
  const b = m[2] as string;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Number(b);
  if (b !== '' && end < start) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

/** Strong validator derived from size + mtime. */
export const etagFor = (size: number, mtimeMs: number): string =>
  `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

/** `If-None-Match` uses weak comparison: true when the request should get a 304. */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

/** `If-Range`: only a matching strong ETag keeps the range; a stale/weak/date validator means send the full body. */
export function ifRangeAllows(header: string | null, etag: string): boolean {
  if (!header) return true;
  return header.trim() === etag;
}

/** Strong validator for an in-memory body: the first 128 bits of its SHA-256, hex, quoted. */
export const contentEtag = (bytes: Uint8Array): string =>
  `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;

/** `inline|attachment; filename*=UTF-8''<pct-encoded>`. Throws URIError on a lone surrogate (known bug, #108). */
export const contentDisposition = (disposition: 'inline' | 'attachment', fileName: string): string =>
  `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`;

/** A file the caller has already stat'ed, or an in-memory body. */
export type FileBody = { absPath: string; size: number; mtimeMs: number } | { bytes: Uint8Array };

export type RespondWithFileOptions = {
  req: Request;
  body: FileBody;
  contentType: string;
  /** Unencoded display name including extension; encoded here. */
  fileName: string;
  disposition: 'inline' | 'attachment';
  /** Defaults to `private, no-cache` (always revalidate against the ETag). */
  cacheControl?: string;
  /** Defaults to etagFor(size, mtimeMs) for a file, contentEtag(bytes) for an in-memory body. */
  etag?: string;
};

/** Full (200), partial (206), unsatisfiable (416) or not-modified (304) response for one file. */
export function respondWithFile(o: RespondWithFileOptions): Response {
  const { req, body } = o;
  const size = 'bytes' in body ? body.bytes.length : body.size;
  const etag = o.etag ?? ('bytes' in body ? contentEtag(body.bytes) : etagFor(body.size, body.mtimeMs));
  const base: Record<string, string> = {
    'content-type': o.contentType,
    'content-disposition': contentDisposition(o.disposition, o.fileName),
    'accept-ranges': 'bytes',
    etag,
    'cache-control': o.cacheControl ?? 'private, no-cache',
  };

  if (ifNoneMatchHits(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: base });
  }

  const range = ifRangeAllows(req.headers.get('if-range'), etag)
    ? parseRange(req.headers.get('range'), size)
    : ({ kind: 'none' } as const);

  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
  }

  const [start, end, status] = range.kind === 'range' ? [range.start, range.end, 206] : [0, size - 1, 200];
  const length = size === 0 ? 0 : end - start + 1;
  const headers = {
    ...base,
    'content-length': String(length),
    ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  };
  if (length === 0) return new Response(null, { status, headers });
  if ('bytes' in body)
    return new Response(new Uint8Array(body.bytes.subarray(start, end + 1)), { status, headers });
  const stream = Readable.toWeb(createReadStream(body.absPath, { start, end })) as ReadableStream;
  return new Response(stream, { status, headers });
}
