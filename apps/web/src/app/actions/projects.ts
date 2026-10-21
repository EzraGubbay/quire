'use server';

import { courseCreateSchema, parseCourseLinks, projectCreateSchema, projectMetaSchema } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createCourse,
  createProject,
  getProjectById,
  homeFor,
  projectBase,
  setProjectStatus,
  updateProject,
} from '@/lib/projects';

export interface ActionState {
  error?: string;
  ok?: boolean;
}

export async function createProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = projectCreateSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await createProject(parsed.data);
  revalidatePath('/research');
  redirect(`${projectBase(project)}/overview`);
}

export async function createCourseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = courseCreateSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
    type: formData.get('type') ?? 'mixed',
    code: formData.get('code') ?? '',
    semester: formData.get('semester') ?? '',
    links: parseCourseLinks(String(formData.get('links') ?? '')),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const course = await createCourse(parsed.data);
  revalidatePath('/courses');
  redirect(`${projectBase(course)}/overview`);
}

/** Archive or restore. Purely a list filter: the workspace stays reachable by URL and editable. */
export async function setProjectStatusAction(id: string, status: 'active' | 'archived'): Promise<void> {
  const project = await getProjectById(id);
  if (!project) return;
  await setProjectStatus(id, status);
  revalidatePath(homeFor(project.kind));
  revalidatePath('/');
}

export async function updateCourseMetaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get('id') ?? '');
  const project = await getProjectById(id);
  if (!project) return { error: 'Course not found' };
  const meta = projectMetaSchema.safeParse({
    type: formData.get('type') ?? 'mixed',
    code: formData.get('code') ?? '',
    semester: formData.get('semester') ?? '',
    links: parseCourseLinks(String(formData.get('links') ?? '')),
  });
  if (!meta.success) return { error: meta.error.issues[0]?.message ?? 'Invalid input' };
  const name = String(formData.get('name') ?? project.name).trim() || project.name;
  const description = String(formData.get('description') ?? project.description).trim();
  await updateProject(id, {
    name: name.slice(0, 120),
    description: description.slice(0, 2000),
    meta: meta.data,
  });
  revalidatePath(projectBase(project), 'layout');
  revalidatePath(homeFor(project.kind));
  return { ok: true };
}

/** Kept for callers that still want the old redirecting behaviour. */
export async function archiveProjectAction(id: string): Promise<void> {
  await setProjectStatusAction(id, 'archived');
  redirect('/');
}
