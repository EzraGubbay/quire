import { z } from 'zod';
import { apiError, json, projectFromSlug, readJson } from '@/lib/api';
import { getMetrics, getRun, logMetrics } from '@/lib/experiments';

export const dynamic = 'force-dynamic';

const point = z.object({
  key: z.string().min(1).max(100),
  value: z.number(),
  step: z.number().int().optional(),
  ts: z.string().datetime().optional(),
});
/** Accepts either a list of points or a flat {key: value} object plus an optional step. */
const schema = z.union([
  z.object({ points: z.array(point).min(1).max(1000) }),
  z.object({ metrics: z.record(z.string(), z.number()), step: z.number().int().optional() }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (!(await getRun(project.id, runId))) return apiError('run not found', 404);
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  const d = body.data;
  const points: { key: string; value: number; step?: number; ts?: Date }[] =
    'points' in d
      ? d.points.map((p) => ({
          key: p.key,
          value: p.value,
          ...(p.step !== undefined ? { step: p.step } : {}),
          ...(p.ts ? { ts: new Date(p.ts) } : {}),
        }))
      : Object.entries(d.metrics).map(([key, value]) => ({
          key,
          value,
          ...(d.step !== undefined ? { step: d.step } : {}),
        }));
  await logMetrics(runId, points);
  return json({ ok: true, logged: points.length });
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (!(await getRun(project.id, runId))) return apiError('run not found', 404);
  return json(await getMetrics(runId));
}
