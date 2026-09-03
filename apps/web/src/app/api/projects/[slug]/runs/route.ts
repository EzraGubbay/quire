import { RUN_STATUSES } from '@quire/shared';
import { z } from 'zod';
import { apiError, json, projectFromSlug, readJson } from '@/lib/api';
import { createRun, ensureExperiment } from '@/lib/experiments';

export const dynamic = 'force-dynamic';

const schema = z.object({
  experiment: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(RUN_STATUSES).default('running'),
  description: z.string().max(5000).optional(),
});

/** POST /api/projects/:slug/runs — start a run (creates the experiment on first use). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  const experiment = await ensureExperiment(project.id, body.data.experiment, body.data.description ?? '');
  const run = await createRun(experiment.id, {
    name: body.data.name,
    params: body.data.params,
    status: body.data.status,
  });
  return json(
    {
      id: run.id,
      name: run.name,
      experimentId: experiment.id,
      url: `/p/${slug}/experiments/${experiment.id}/runs/${run.id}`,
    },
    201,
  );
}
