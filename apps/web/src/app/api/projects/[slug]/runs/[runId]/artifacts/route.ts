import { apiError, json, projectFromSlug } from '@/lib/api';
import { addArtifact, getRun } from '@/lib/experiments';

export const dynamic = 'force-dynamic';

const MAX = 200 * 1024 * 1024;

/** POST multipart form with a `file` field (and optional `name`). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (!(await getRun(project.id, runId))) return apiError('run not found', 404);
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File) || file.size === 0) return apiError('multipart field "file" is required');
  if (file.size > MAX) return apiError('artifact is larger than 200 MB', 413);
  const name = String(form?.get('name') ?? file.name ?? 'artifact');
  const row = await addArtifact(
    project.id,
    runId,
    name,
    file.type || 'application/octet-stream',
    new Uint8Array(await file.arrayBuffer()),
  );
  return json({ id: row.id, name: row.name, size: row.size }, 201);
}
