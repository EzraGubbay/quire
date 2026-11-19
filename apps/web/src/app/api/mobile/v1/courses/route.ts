import { loadCourses } from '@/lib/mobile/courses';
import { requireDevice } from '@/lib/mobile/device-auth';
import { ok } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  return ok(await loadCourses());
}
