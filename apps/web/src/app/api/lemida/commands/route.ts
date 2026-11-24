// The Mac agent long-polls this to pick up the next command the panel queued. Claiming is atomic.
import { z } from 'zod';
import { json, readJson } from '@/lib/api';
import { claimNextCommand, enqueueIfIdle, reapStaleCommands } from '@/lib/lemida/commands';
import { enabledMappings } from '@/lib/lemida/courses';
import { saveLemidaState } from '@/lib/lemida/state';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  await saveLemidaState({ agentSeenAt: new Date().toISOString() });
  await reapStaleCommands();
  // ?lease=1: the caller will heartbeat, so it gets the short lease. Legacy callers get the long one.
  const leased = new URL(req.url).searchParams.get('lease') === '1';
  const cmd = await claimNextCommand({ leased });
  if (!cmd) return json({ command: null });
  const body: Record<string, unknown> = {
    command: { id: cmd.id, kind: cmd.kind, payload: cmd.payload },
  };
  if (cmd.kind === 'sync') {
    const mappings = await enabledMappings();
    body.courses = mappings.map((m) => ({
      mappingId: m.id,
      slug: m.project.slug,
      lemidaUrl: m.lemidaUrl,
      lemidaCourseId: m.lemidaCourseId,
      label: m.label || m.project.name,
    }));
  }
  return json(body);
}

const enqueueSchema = z.object({
  kind: z.literal('sync'),
  trigger: z.enum(['auto-sign-in', 'auto-timer']),
});

/** The engine's auto-sync: queue a sync unless one is already waiting/running (or nothing is mapped). */
export async function POST(req: Request) {
  const body = await readJson(req, enqueueSchema);
  if (!body.ok) return body.res;
  await saveLemidaState({ agentSeenAt: new Date().toISOString() });
  const { command, created, reason } = await enqueueIfIdle('sync', { trigger: body.data.trigger });
  return json({ created, reason, id: command?.id ?? null });
}
