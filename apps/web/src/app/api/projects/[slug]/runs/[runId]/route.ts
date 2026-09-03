import { RUN_STATUSES } from '@quire/shared';
import { z } from 'zod';
import { apiError, json, projectFromSlug, readJson } from '@/lib/api';
import { getRun, updateRun } from '@/lib/experiments';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  const found = await getRun(project.id, runId);
  if (!found) return apiError('run not found', 404);
  return json({ ...found.run, experiment: found.experiment.name });
}

const patch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  notes: z.string().max(20000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (!(await getRun(project.id, runId))) return apiError('run not found', 404);
  const body = await readJson(req, patch);
  if (!body.ok) return body.res;
  const run = await updateRun(runId, body.data);
  return json(run);
}
