import { z } from 'zod';
import { apiError, json, projectFromSlug, readJson } from '@/lib/api';
import { getRun, logMetrics, updateRun } from '@/lib/experiments';

export const dynamic = 'force-dynamic';

const schema = z.object({
  status: z.enum(['done', 'failed']).default('done'),
  metrics: z.record(z.string(), z.number()).optional(),
  notes: z.string().max(20000).optional(),
});

/** POST /finish — marks the run done or failed, with optional final metrics. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (!(await getRun(project.id, runId))) return apiError('run not found', 404);
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  if (body.data.metrics)
    await logMetrics(
      runId,
      Object.entries(body.data.metrics).map(([key, value]) => ({ key, value })),
    );
  const run = await updateRun(runId, {
    status: body.data.status,
    ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
  });
  return json(run);
}
