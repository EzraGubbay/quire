import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { assignmentFiles, assignments } from '@/db/schema';
import { filePath } from '@/lib/files';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/** Downloads a submitted homework file. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; assignmentId: string; fileId: string }> },
) {
  const { slug, assignmentId, fileId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const [row] = await db
    .select({ f: assignmentFiles })
    .from(assignmentFiles)
    .innerJoin(assignments, eq(assignments.id, assignmentFiles.assignmentId))
    .where(
      and(
        eq(assignments.projectId, project.id),
        eq(assignments.id, assignmentId),
        eq(assignmentFiles.id, fileId),
      ),
    )
    .limit(1);
  if (!row?.f.filePath) return new Response('Not found', { status: 404 });
  const abs = filePath(row.f.filePath);
  const info = await stat(abs).catch(() => null);
  if (!info) return new Response('File missing', { status: 404 });
  return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
    headers: {
      'content-type': row.f.contentType,
      'content-length': String(info.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.f.name)}`,
      'cache-control': 'private, max-age=3600',
    },
  });
}
