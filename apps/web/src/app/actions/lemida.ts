'use server';

import { LEMIDA_KINDS, type LemidaKind } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { enqueueCommand } from '@/lib/lemida/commands';
import { deleteMapping, mapCourse, setMappingEnabled } from '@/lib/lemida/courses';
import { dismissReview, resolveReview } from '@/lib/lemida/files';

const PANEL = '/courses/lemida';

export async function enqueueSignInAction(): Promise<void> {
  await enqueueCommand('open_login');
  revalidatePath(PANEL);
}

export async function enqueueProbeAction(): Promise<void> {
  await enqueueCommand('probe');
  revalidatePath(PANEL);
}

export async function enqueueSyncAction(): Promise<void> {
  await enqueueCommand('sync');
  revalidatePath(PANEL);
}

export async function mapCourseAction(
  projectId: string,
  lemidaUrl: string,
  label = '',
): Promise<{ error?: string; ok?: boolean }> {
  const url = lemidaUrl.trim();
  if (!/^https?:\/\//i.test(url)) return { error: 'Enter the full Lemida course URL (https://…).' };
  await mapCourse(projectId, url, label.trim());
  revalidatePath(PANEL);
  return { ok: true };
}

export async function toggleCourseSyncAction(id: string, enabled: boolean): Promise<void> {
  await setMappingEnabled(id, enabled);
  revalidatePath(PANEL);
}

export async function deleteMappingAction(id: string): Promise<void> {
  await deleteMapping(id);
  revalidatePath(PANEL);
}

export async function resolveReviewAction(fileId: string, kind: LemidaKind): Promise<void> {
  if (!LEMIDA_KINDS.includes(kind)) return;
  await resolveReview(fileId, kind);
  revalidatePath(PANEL);
}

export async function dismissReviewAction(fileId: string): Promise<void> {
  await dismissReview(fileId);
  revalidatePath(PANEL);
}
