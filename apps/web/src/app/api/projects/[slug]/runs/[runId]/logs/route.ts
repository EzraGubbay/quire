import { z } from 'zod';
import { apiError, json, projectFromSlug, readJson } from '@/lib/api';
import { appendLogs, getRun } from '@/lib/experiments';

export const dynamic = 'force-dynamic';

const schema = z.object({
  lines: z
    .array(
      z.object({
        level: z.string().max(16).optional(),
        message: z.string().max(10000),
        ts: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const { slug, runId } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (!(await getRun(project.id, runId))) return apiError('run not found', 404);
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  await appendLogs(
    runId,
    body.data.lines.map((l) => ({
      ...(l.level ? { level: l.level } : {}),
      message: l.message,
      ...(l.ts ? { ts: new Date(l.ts) } : {}),
    })),
  );
  return json({ ok: true, appended: body.data.lines.length });
}
