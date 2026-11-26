// DB job store for the mobile upload endpoint (QMOB-E1-S8). Pure helpers live in uploads.ts.
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type MobileUploadJob, mobileUploadJobs } from '@/db/schema';
import type { RunDeps } from './uploads';

/** Inserts a queued job, or returns the existing one for the same (owner, course, key). */
export async function createOrGetJob(
  ownerLogin: string,
  courseId: string,
  idempotencyKey: string,
  upload: { bytes: Uint8Array; target: 'document' | 'note'; contentType: string; fileName: string },
): Promise<{ job: MobileUploadJob; created: boolean }> {
  const [inserted] = await db
    .insert(mobileUploadJobs)
    .values({
      ownerLogin,
      courseId,
      idempotencyKey,
      data: Buffer.from(upload.bytes),
      target: upload.target,
      contentType: upload.contentType,
      fileName: upload.fileName,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { job: inserted, created: true };
  const [existing] = await db
    .select()
    .from(mobileUploadJobs)
    .where(
      and(
        eq(mobileUploadJobs.ownerLogin, ownerLogin),
        eq(mobileUploadJobs.courseId, courseId),
        eq(mobileUploadJobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('Upload job vanished after conflict');
  return { job: existing, created: false };
}

/** A job readable only by the principal that created it. */
export async function getOwnedJob(ownerLogin: string, id: string): Promise<MobileUploadJob | null> {
  const [row] = await db
    .select()
    .from(mobileUploadJobs)
    .where(and(eq(mobileUploadJobs.id, id), eq(mobileUploadJobs.ownerLogin, ownerLogin)))
    .limit(1);
  return row ?? null;
}

const patch = (id: string, set: Partial<MobileUploadJob>) =>
  db
    .update(mobileUploadJobs)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(mobileUploadJobs.id, id))
    .then(() => {});

export const jobStore: Pick<RunDeps, 'setProcessing' | 'setDone' | 'setFailed'> = {
  setProcessing: (id) => patch(id, { status: 'processing' }),
  setDone: (id, { fileId, noteId }) =>
    patch(id, { status: 'done', fileId: fileId ?? null, noteId: noteId ?? null, data: null }),
  setFailed: (id, error) => patch(id, { status: 'failed', error, data: null }),
};
