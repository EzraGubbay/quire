// POST /api/mobile/v1/courses/{course}/uploads — raw PDF or Markdown body (?kind=document|note, ?name=), idempotent,
// processed in after() (QMOB-E1-S8; Markdown + kind in API 1.2.0).
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { indexOwner } from '@/lib/ai/index';
import { createDeckDocument, createMarkdownDocument } from '@/lib/documents';
import { resolveCourse } from '@/lib/mcp/courses';
import { requireDevice } from '@/lib/mobile/device-auth';
import { fail, ok } from '@/lib/mobile/respond';
import type { UploadJob } from '@/lib/mobile/schema';
import {
  decodeMarkdown,
  readIdempotencyKey,
  readUpload,
  runUploadJob,
  toUploadJob,
} from '@/lib/mobile/uploads';
import { createOrGetJob, jobStore } from '@/lib/mobile/uploads-store';
import { createNote } from '@/lib/notes';
import { projectBase } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ course: string }> }) {
  const a = await requireDevice(req);
  if ('response' in a) return a.response;
  const { course } = await ctx.params;
  const project = await resolveCourse(course);
  if (project?.kind !== 'course') return fail('not_found', 'Course not found');
  const key = readIdempotencyKey(req);
  if (!key) return fail('invalid_request', 'Idempotency-Key header is required');
  const read = await readUpload(req);
  if (!read.ok) return fail('invalid_request', read.message, read.code === 'too_large' ? 413 : 400);
  if (read.format === 'markdown' && decodeMarkdown(read.bytes) === null)
    return fail('invalid_request', 'Markdown must be UTF-8 text');

  const { job, created } = await createOrGetJob(a.principal.login, project.id, key, {
    bytes: read.bytes,
    target: read.target,
    contentType: read.format === 'pdf' ? 'application/pdf' : 'text/markdown',
    fileName: read.fileName,
  });
  if (created) {
    after(() =>
      runUploadJob(
        {
          id: job.id,
          projectId: project.id,
          target: read.target,
          format: read.format,
          fileName: read.fileName,
          data: read.bytes,
        },
        {
          ...jobStore,
          createDoc: createDeckDocument,
          createMarkdownDoc: (p, title, body) => createMarkdownDocument(p, title, body, null),
          createNote: (p, title, body) => createNote(p, title, body),
          index: indexOwner,
          revalidate: (target) =>
            revalidatePath(`${projectBase(project)}/${target === 'note' ? 'notes' : 'documents'}`),
        },
      ),
    );
  }
  return ok(toUploadJob({ ...job, status: job.status as UploadJob['status'] }), 202);
}
