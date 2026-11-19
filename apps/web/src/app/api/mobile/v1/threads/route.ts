import { listRecentCourseThreads } from '@/lib/chat';
import { toThread } from '@/lib/mobile/chat';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const raw = new URL(req.url).searchParams.get('limit');
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return fail('invalid_request', 'limit must be an integer between 1 and 100');
  const rows = await listRecentCourseThreads(limit);
  return ok(rows.map((r) => toThread(r.thread, r.courseSlug)));
}
