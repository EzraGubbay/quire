import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { apiError, projectFromSlug } from '@/lib/api';
import { getArtifact, getRun } from '@/lib/experiments';
import { filePath } from '@/lib/files';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; artifactId: string }> }) {
  const { slug, artifactId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  const art = await getArtifact(artifactId);
  if (!art || !(await getRun(project.id, art.runId))) return apiError('artifact not found', 404);
  const abs = filePath(art.filePath);
  const info = await stat(abs).catch(() => null);
  if (!info) return apiError('file missing', 404);
  return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
    headers: {
      'content-type': art.contentType,
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${encodeURIComponent(art.name)}"`,
    },
  });
}
