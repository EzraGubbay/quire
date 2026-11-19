import { requireDevice } from '@/lib/mobile/device-auth';
import { toNote } from '@/lib/mobile/notes';
import { fail, ok } from '@/lib/mobile/respond';
import { getNote } from '@/lib/notes';
import { getProjectBySlug } from '@/lib/projects';
import { noteContexts } from '../context';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read-only: only GET is exported, so Next answers every other verb with 405.
export async function GET(req: Request, { params }: { params: Promise<{ course: string; noteId: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course, noteId } = await params;
  const project = await getProjectBySlug(course);
  if (project?.kind !== 'course') return fail('not_found', 'No such course');
  const note = UUID.test(noteId) ? await getNote(project.id, noteId) : undefined;
  if (!note) return fail('not_found', 'No such note');
  const ctx = await noteContexts(project.id, [note]);
  return ok(toNote(note, ctx.get(note.id)));
}
