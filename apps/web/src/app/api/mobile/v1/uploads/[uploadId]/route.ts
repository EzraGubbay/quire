// GET /api/mobile/v1/uploads/{uploadId} — poll an upload job (QMOB-E1-S8; `kind`/`noteId` since 1.2.0). Owner-scoped.
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';
import type { UploadJob } from '@/lib/mobile/schema';
import { toUploadJob } from '@/lib/mobile/uploads';
import { getOwnedJob } from '@/lib/mobile/uploads-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { uploadId } = await ctx.params;
  const job = UUID.test(uploadId) ? await getOwnedJob(a.principal.login, uploadId) : null;
  if (!job) return fail('not_found', 'Upload not found');
  return ok(toUploadJob({ ...job, status: job.status as UploadJob['status'] }));
}
