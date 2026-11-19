import { deleteThread, getThread } from '@/lib/chat';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail } from '@/lib/mobile/respond';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, ctx: { params: Promise<{ course: string; threadId: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course, threadId } = await ctx.params;
  const project = await getProjectBySlug(course);
  if (project?.kind !== 'course') return fail('not_found', 'Course not found');
  if (!(await getThread(project.id, threadId))) return fail('not_found', 'Thread not found');
  await deleteThread(project.id, threadId);
  return new Response(null, { status: 204 });
}
