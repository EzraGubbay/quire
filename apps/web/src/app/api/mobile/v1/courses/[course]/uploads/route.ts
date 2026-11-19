// POST /api/mobile/v1/courses/{course}/uploads — raw PDF body, idempotent, processed in after() (QMOB-E1-S8).
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { indexOwner } from '@/lib/ai/index';
import { createDeckDocument } from '@/lib/documents';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';
import type { UploadJob } from '@/lib/mobile/schema';
import { readIdempotencyKey, readRawPdf, runUploadJob, toUploadJob } from '@/lib/mobile/uploads';
import { createOrGetJob, jobStore } from '@/lib/mobile/uploads-store';
import { getProjectBySlug, projectBase } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ course: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course } = await ctx.params;
  const project = await getProjectBySlug(course);
  if (project?.kind !== 'course') return fail('not_found', 'Course not found');
  const key = readIdempotencyKey(req);
  if (!key) return fail('invalid_request', 'Idempotency-Key header is required');
  const read = await readRawPdf(req);
  if (!read.ok) return fail('invalid_request', read.message, read.code === 'too_large' ? 413 : 400);

  const { job, created } = await createOrGetJob(a.principal.login, project.id, key, read.bytes);
  if (created) {
    after(() =>
      runUploadJob(job.id, project.id, read.bytes, {
        ...jobStore,
        createDoc: createDeckDocument,
        index: indexOwner,
        revalidate: () => revalidatePath(`${projectBase(project)}/documents`),
      }),
    );
  }
  return ok(toUploadJob({ ...job, status: job.status as UploadJob['status'] }), 202);
}
