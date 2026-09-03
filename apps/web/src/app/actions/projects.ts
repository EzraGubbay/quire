'use server';

import { projectCreateSchema } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createProject, setProjectStatus } from '@/lib/projects';

export interface ActionState {
  error?: string;
}

export async function createProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = projectCreateSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await createProject(parsed.data);
  revalidatePath('/');
  redirect(`/p/${project.slug}/overview`);
}

export async function archiveProjectAction(id: string): Promise<void> {
  await setProjectStatus(id, 'archived');
  revalidatePath('/');
  redirect('/');
}
