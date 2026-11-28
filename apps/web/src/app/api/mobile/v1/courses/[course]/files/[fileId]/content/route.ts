import { stat } from 'node:fs/promises';
import { respondWithFile } from '@/core/http/file-response';
import { filePath } from '@/lib/files';
import { type FileFormat, resolveFile } from '@/lib/mcp/courses';
import { COURSE_SCOPE } from '@/lib/mcp/scope';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

const FORMATS: readonly string[] = ['pdf', 'original', 'markdown'];

/** Streams a file's bytes via respondWithFile (Range, strong ETag, If-None-Match/If-Range). */
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
    file = await resolveFile(course, fileId, (fmt ?? 'pdf') as FileFormat, COURSE_SCOPE);
  } catch (e) {
    return fail('not_found', e instanceof Error ? e.message : 'File not found');
  }

  if (file.kind === 'markdown') {
    return respondWithFile({
      req,
      body: { bytes: Buffer.from(file.text ?? '', 'utf8') },
      contentType: 'text/markdown; charset=utf-8',
      fileName: file.filename,
      disposition: 'inline',
      cacheControl: 'private, no-cache',
    });
  }
  const abs = filePath(file.rel ?? '');
  const info = await stat(abs).catch(() => null);
  if (!info) return fail('not_found', 'File is missing on disk.');
  return respondWithFile({
    req,
    body: { absPath: abs, size: info.size, mtimeMs: info.mtimeMs },
    contentType: file.mimeType,
    fileName: file.filename,
    disposition: 'inline',
    cacheControl: 'private, no-cache',
  });
}
