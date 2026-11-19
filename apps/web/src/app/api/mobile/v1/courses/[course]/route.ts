import { loadCourseDetail } from '@/lib/mobile/courses';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ course: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course } = await ctx.params;
  const detail = await loadCourseDetail(course);
  return detail ? ok(detail) : fail('not_found', 'Course not found');
}
