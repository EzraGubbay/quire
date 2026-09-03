'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createMarkdownDocument } from '@/lib/documents';
import { createNote, deleteNote, getNote, resolveTarget, syncLinks, updateNote } from '@/lib/notes';
import { getProjectBySlug } from '@/lib/projects';

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

export interface ActionState {
  error?: string;
  ok?: boolean;
}

const createSchema = z.object({ slug: z.string().min(1), title: z.string().trim().min(1).max(200) });

export async function createNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse({ slug: formData.get('slug'), title: formData.get('title') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  const note = await createNote(project.id, parsed.data.title);
  revalidatePath(`/p/${parsed.data.slug}/notes`);
  redirect(`/p/${parsed.data.slug}/notes/${note.slug}?edit=1`);
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(2_000_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
});

export async function updateNoteAction(
  slug: string,
  id: string,
  patch: z.input<typeof patchSchema>,
): Promise<ActionState & { noteSlug?: string }> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(slug);
  const row = await updateNote(project.id, id, parsed.data);
  if (!row) return { error: 'Note not found' };
  revalidatePath(`/p/${slug}/notes`);
  revalidatePath(`/p/${slug}/notes/${row.slug}`);
  return { ok: true, noteSlug: row.slug };
}

export async function deleteNoteAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteNote(project.id, id);
  revalidatePath(`/p/${slug}/notes`);
  redirect(`/p/${slug}/notes`);
}

/** Follows a [[wiki link]]: opens the note or document it names, creating an empty note when nothing matches. */
export async function followWikiLinkAction(slug: string, name: string): Promise<void> {
  const project = await projectOr404(slug);
  const target = await resolveTarget(project.id, name);
  if (target?.kind === 'document') redirect(`/p/${slug}/documents/${target.id}`);
  if (target?.kind === 'note') {
    const note = await getNote(project.id, target.id);
    redirect(`/p/${slug}/notes/${note?.slug ?? target.id}`);
  }
  const note = await createNote(project.id, name);
  revalidatePath(`/p/${slug}/notes`);
  redirect(`/p/${slug}/notes/${note.slug}?edit=1`);
}

/** Turns a note into a Markdown document (same body), deleting the note. */
export async function promoteNoteAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  const note = await getNote(project.id, id);
  if (!note) throw new Error('note not found');
  const doc = await createMarkdownDocument(project.id, note.title, note.body, null);
  await syncLinks(project.id, 'document', doc.id, note.body);
  await deleteNote(project.id, id);
  revalidatePath(`/p/${slug}/notes`);
  revalidatePath(`/p/${slug}/documents`);
  redirect(`/p/${slug}/documents/${doc.id}`);
}
