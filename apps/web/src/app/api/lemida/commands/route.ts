// The Mac agent long-polls this to pick up the next command the panel queued. Claiming is atomic.
import { json } from '@/lib/api';
import { claimNextCommand } from '@/lib/lemida/commands';
import { enabledMappings } from '@/lib/lemida/courses';
import { saveLemidaState } from '@/lib/lemida/state';

export const dynamic = 'force-dynamic';

export async function GET() {
  await saveLemidaState({ agentSeenAt: new Date().toISOString() });
  const cmd = await claimNextCommand();
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
