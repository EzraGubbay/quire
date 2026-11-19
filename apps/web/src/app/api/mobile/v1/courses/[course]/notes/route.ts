import { requireDevice } from '@/lib/mobile/device-auth';
import { toNoteSummary } from '@/lib/mobile/notes';
import { fail, ok } from '@/lib/mobile/respond';
import { listNotes } from '@/lib/notes';
import { getProjectBySlug } from '@/lib/projects';
import { noteContexts } from './context';

export const dynamic = 'force-dynamic';

// Read-only: only GET is exported, so Next answers every other verb with 405.
export async function GET(req: Request, { params }: { params: Promise<{ course: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course } = await params;
  const project = await getProjectBySlug(course);
  if (project?.kind !== 'course') return fail('not_found', 'No such course');
  const rows = await listNotes(project.id);
  const ctx = await noteContexts(project.id, rows);
  return ok(rows.map((n) => toNoteSummary(n, ctx.get(n.id))));
}
