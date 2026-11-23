// POST /api/mobile/v1/push/test — send `push.test` to the calling device synchronously (QMOB-E8-S2a).
import { pushRoutes } from '@/lib/mobile/push/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return pushRoutes.sendTest(req);
}
