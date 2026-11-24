// Lease proof-of-life: the engine posts here every ~30 s while a command runs.
import { json } from '@/lib/api';
import { heartbeatCommand } from '@/lib/lemida/commands';
import { saveLemidaState } from '@/lib/lemida/state';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await saveLemidaState({ agentSeenAt: new Date().toISOString() });
  const active = await heartbeatCommand(id);
  return json({ ok: true, active });
}
