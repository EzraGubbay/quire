// PUT/GET/DELETE /api/mobile/v1/push/registration — the calling device's FCM registration (QMOB-E8-S2a).
import { pushRoutes } from '@/lib/mobile/push/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  return pushRoutes.putRegistration(req);
}

export async function GET(req: Request) {
  return pushRoutes.getRegistration(req);
}

export async function DELETE(req: Request) {
  return pushRoutes.deleteRegistration(req);
}
