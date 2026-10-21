'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { z } from 'zod';
import type { Note } from '@/db/schema';
import { indexOwner, removeOwner } from '@/lib/ai/index';
import { BudgetError } from '@/lib/ai/ledger';
import {
  estimateSynthesis,
  runSynthesis,
  type SynthesisEstimate,
  setSynthesizedFrom,
  startSynthesis,
  synthesizedFrom,
} from '@/lib/ai/synthesis';
import { createFolder, createMarkdownDocument, getDocument } from '@/lib/documents';
import {
  createNote,
  deleteNote,
  getNote,
  moveNote,
  resolveTarget,
  splitWikiName,
  syncLinks,
  updateNote,
} from '@/lib/notes';
import { getProjectBySlug, projectBase } from '@/lib/projects';

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

export interface ActionState {
  error?: string;
  ok?: boolean;
}

const optionalUuid = z
  .string()
  .uuid()
  .or(z.literal(''))
  .transform((v) => (v === '' ? null : v));

const createSchema = z.object({
  slug: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  folderId: optionalUuid.optional(),
});

export async function createNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse({
    slug: formData.get('slug'),
    title: formData.get('title'),
    folderId: formData.get('folderId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  const note = await createNote(project.id, parsed.data.title, '', {
    folderId: parsed.data.folderId ?? null,
  });
  after(() => indexOwner(project.id, 'note', note.id).catch(() => {}));
  revalidatePath(`${projectBase(project)}/notes`);
  redirect(`${projectBase(project)}/notes/${note.slug}?edit=1`);
}

const folderSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  parentId: optionalUuid,
});

export async function createNoteFolderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = folderSchema.safeParse({
    slug: formData.get('slug'),
    name: formData.get('name'),
    parentId: formData.get('parentId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  await createFolder(project.id, parsed.data.name, parsed.data.parentId, 'notes');
  revalidatePath(`${projectBase(project)}/notes`);
  return { ok: true };
}

export async function moveNoteAction(slug: string, noteId: string, folderId: string | null): Promise<void> {
  const project = await projectOr404(slug);
  await moveNote(project.id, noteId, folderId);
  revalidatePath(`${projectBase(project)}/notes`);
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(2_000_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
});

/** When the note last changed (ISO string), for live read views polling from another device. */
export async function noteVersionAction(slug: string, id: string): Promise<string | null> {
  const project = await getProjectBySlug(slug);
  if (!project) return null;
  const note = await getNote(project.id, id);
  return note ? note.updatedAt.toISOString() : null;
}

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
  after(() => indexOwner(project.id, 'note', id).catch(() => {}));
  revalidatePath(`${projectBase(project)}/notes`);
  revalidatePath(`${projectBase(project)}/notes/${row.slug}`);
  return { ok: true, noteSlug: row.slug };
}

export async function deleteNoteAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteNote(project.id, id);
  await removeOwner(project.id, 'note', id);
  revalidatePath(`${projectBase(project)}/notes`);
  redirect(`${projectBase(project)}/notes`);
}

/**
 * Follows a [[wiki link]]: opens the note or document it names, creating an empty note when nothing matches.
 * `Name#14` opens a document at page 14; `Name#heading` jumps to that heading in a note.
 */
export async function followWikiLinkAction(slug: string, raw: string): Promise<void> {
  const project = await projectOr404(slug);
  const base = projectBase(project);
  const { name, anchor } = splitWikiName(raw);
  const target = await resolveTarget(project.id, name);
  if (target?.kind === 'document') {
    const page = anchor && /^\d+$/.test(anchor) ? `?page=${anchor}` : '';
    redirect(`${base}/documents/${target.id}${page}`);
  }
  if (target?.kind === 'note') {
    const note = await getNote(project.id, target.id);
    const hash =
      anchor && !/^\d+$/.test(anchor)
        ? `#${encodeURIComponent(anchor.toLowerCase().replace(/\s+/g, '-'))}`
        : '';
    redirect(`${base}/notes/${note?.slug ?? target.id}${hash}`);
  }
  if (target?.kind === 'source') redirect(`${base}/sources`);
  const note = await createNote(project.id, name);
  revalidatePath(`${base}/notes`);
  redirect(`${base}/notes/${note.slug}?edit=1`);
}

/** Turns a note into a Markdown document (same body), deleting the note. */
export async function promoteNoteAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  const note = await getNote(project.id, id);
  if (!note) throw new Error('note not found');
  const doc = await createMarkdownDocument(project.id, note.title, note.body, null);
  await syncLinks(project.id, 'document', doc.id, note.body);
  await deleteNote(project.id, id);
  await removeOwner(project.id, 'note', id);
  after(() => indexOwner(project.id, 'document', doc.id).catch(() => {}));
  revalidatePath(`${projectBase(project)}/notes`);
  revalidatePath(`${projectBase(project)}/documents`);
  redirect(`${projectBase(project)}/documents/${doc.id}`);
}

export async function estimateSynthesisAction(slug: string, rawNoteId: string): Promise<SynthesisEstimate> {
  const project = await projectOr404(slug);
  return estimateSynthesis(project.id, rawNoteId);
}

/** Creates the synthesized note at once (generating) and runs the model after the response. */
export async function synthesizeAction(
  slug: string,
  rawNoteId: string,
  title: string,
): Promise<ActionState & { noteSlug?: string }> {
  const clean = title.trim().slice(0, 200);
  if (!clean) return { error: 'Give the synthesized note a title.' };
  const project = await projectOr404(slug);
  let target: Note;
  try {
    target = await startSynthesis(project.id, rawNoteId, clean);
  } catch (err) {
    return { error: err instanceof BudgetError ? err.message : (err as Error).message };
  }
  after(() => runSynthesis(project.id, target.id));
  revalidatePath(`${projectBase(project)}/notes`);
  return { ok: true, noteSlug: target.slug };
}

/** Re-runs a failed synthesis into the same note (keeps the title). */
export async function retrySynthesisAction(slug: string, noteId: string): Promise<ActionState> {
  const project = await projectOr404(slug);
  const raw = await synthesizedFrom(project.id, noteId);
  if (!raw) return { error: 'This note has no source note to synthesize from.' };
  try {
    const est = await estimateSynthesis(project.id, raw.id);
    const { assertBudget } = await import('@/lib/ai/ledger');
    await assertBudget(est.costUsd);
  } catch (err) {
    return { error: (err as Error).message };
  }
  await updateNote(project.id, noteId, { status: 'generating', error: null });
  after(() => runSynthesis(project.id, noteId));
  revalidatePath(`${projectBase(project)}/notes`);
  return { ok: true };
}

/** Hand-written synthesized notes can point at the raw note they came from. */
export async function setSynthesizedFromAction(
  slug: string,
  noteId: string,
  rawNoteId: string | null,
): Promise<void> {
  const project = await projectOr404(slug);
  await setSynthesizedFrom(project.id, noteId, rawNoteId);
  revalidatePath(`${projectBase(project)}/notes`, 'layout');
}

/** Open a document at a page (slide citations). */
export async function openDocumentPageAction(slug: string, documentId: string, page: number): Promise<void> {
  const project = await projectOr404(slug);
  const doc = await getDocument(project.id, documentId);
  if (!doc) return;
  redirect(`${projectBase(project)}/documents/${doc.id}?page=${page}`);
}
