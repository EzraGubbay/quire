// The agent reports a command's outcome here (and heartbeats by doing so).
import { z } from 'zod';
import { json, readJson } from '@/lib/api';
import { completeCommand } from '@/lib/lemida/commands';
import { saveLemidaState } from '@/lib/lemida/state';

export const dynamic = 'force-dynamic';

const schema = z.object({
  status: z.enum(['done', 'error']),
  result: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await saveLemidaState({ agentSeenAt: new Date().toISOString() });
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  await completeCommand(id, body.data.status, body.data.result);
  return json({ ok: true });
}
