import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { filePath } from '@/lib/files';
import { type FileFormat, resolveFile } from '@/lib/mcp/courses';
import { requireDevice } from '@/lib/mobile/device-auth';
import { etagFor, ifNoneMatchHits, ifRangeAllows, parseRange } from '@/lib/mobile/range';
import { fail } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

const FORMATS: readonly string[] = ['pdf', 'original', 'markdown'];

/** Streams a file's bytes with Range (206/416), a strong ETag and If-None-Match/If-Range support. */
export async function GET(req: Request, ctx: { params: Promise<{ course: string; fileId: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;

  const { course, fileId } = await ctx.params;
  const fmt = new URL(req.url).searchParams.get('format');
  if (fmt !== null && !FORMATS.includes(fmt)) {
    return fail('invalid_request', 'format must be one of pdf, original, markdown');
  }

  let file: Awaited<ReturnType<typeof resolveFile>>;
  try {
    file = await resolveFile(course, fileId, (fmt ?? 'pdf') as FileFormat);
  } catch (e) {
    return fail('not_found', e instanceof Error ? e.message : 'File not found');
  }

  const markdown = file.kind === 'markdown' ? Buffer.from(file.text ?? '', 'utf8') : null;
  let size = file.sizeBytes;
  let etag: string;
  let abs = '';
  if (markdown) {
    size = markdown.length;
    etag = `"${createHash('sha256').update(markdown).digest('hex').slice(0, 32)}"`;
  } else {
    abs = filePath(file.rel ?? '');
    const info = await stat(abs).catch(() => null);
    if (!info) return fail('not_found', 'File is missing on disk.');
    size = info.size;
    etag = etagFor(info.size, info.mtimeMs);
  }

  const base: Record<string, string> = {
    'content-type': markdown ? 'text/markdown; charset=utf-8' : file.mimeType,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'private, no-cache',
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
  if (markdown) return new Response(new Uint8Array(markdown.subarray(start, end + 1)), { status, headers });
  const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
  return new Response(stream, { status, headers });
}
