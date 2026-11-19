import { loadCourseFiles } from '@/lib/mobile/courses';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ course: string; fileId: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course, fileId } = await ctx.params;
  const file = (await loadCourseFiles(course))?.find((f) => f.fileId === fileId);
  return file ? ok(file) : fail('not_found', 'File not found');
}
