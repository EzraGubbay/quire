// Pure HTTP Range / ETag helpers for the mobile file-content endpoint (RFC 9110 §13, §14).

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
