'use server';

import { SESSION_KINDS, type SessionKind } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { z } from 'zod';
import type { Note } from '@/db/schema';
import { indexOwner } from '@/lib/ai/index';
import { builtinFolder, createDeckDocument } from '@/lib/documents';
import { createNote, getNote, sessionNote, updateNote } from '@/lib/notes';
import { getProjectBySlug, projectBase } from '@/lib/projects';
import {
  attachDocumentToSession,
  createSession,
  deleteSession,
  getSession,
  parseSessionFilename,
  SESSION_LABEL,
  sessionTitle,
  updateSession,
} from '@/lib/sessions';

export interface ActionState {
  error?: string;
  ok?: boolean;
  created?: number;
}

const MAX_DECK_BYTES = 200 * 1024 * 1024;
const DECK_EXT = /\.(pdf|pptx?|key|odp)$/i;

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

const kindSchema = z.enum(SESSION_KINDS);
const todayIso = () => new Date().toISOString().slice(0, 10);

const createSchema = z.object({
  slug: z.string().min(1),
  kind: kindSchema,
  number: z.coerce.number().int().min(0).max(999).optional(),
  title: z.string().trim().max(200).default(''),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(''))
    .default(''),
});

export async function createSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse({
    slug: formData.get('slug'),
    kind: formData.get('kind'),
    number: formData.get('number') || undefined,
    title: formData.get('title') ?? '',
    date: formData.get('date') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  const s = await createSession(project.id, {
    kind: parsed.data.kind,
    number: parsed.data.number,
    title: parsed.data.title,
    date: parsed.data.date || todayIso(),
  });
  const tab = parsed.data.kind === 'lecture' ? 'lectures' : 'recitations';
  revalidatePath(`${projectBase(project)}/${tab}`);
  redirect(`${projectBase(project)}/${tab}/${s.id}`);
}

/**
 * Drop one or many files on the Lectures/Recitations tab. Each file becomes a session (number and title parsed from
 * its name, date today) with the file attached; `sessionId` attaches every file to an existing session instead.
 */
export async function dropSessionFilesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get('slug') ?? '');
  const kind = kindSchema.safeParse(formData.get('kind'));
  if (!kind.success) return { error: 'Unknown session kind' };
  const sessionId = String(formData.get('sessionId') ?? '') || null;
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { error: 'Drop a PDF or PowerPoint file.' };
  for (const f of files) {
    if (!DECK_EXT.test(f.name)) return { error: `${f.name}: only PDF, PPTX, KEY or ODP files are accepted.` };
    if (f.size > MAX_DECK_BYTES) return { error: `${f.name} is larger than 200 MB.` };
  }
  const project = await projectOr404(slug);
  const base = projectBase(project);
  let created = 0;
  let firstId: string | null = null;
  // Larger numbers first so "Lecture 10" and "Lecture 2" dropped together land in order either way.
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of sorted) {
    const data = new Uint8Array(await file.arrayBuffer());
    let target = sessionId;
    let title: string | undefined;
    if (!target) {
      const parsed = parseSessionFilename(file.name);
      const s = await createSession(project.id, {
        kind: kind.data,
        number: parsed.number,
        title: parsed.title,
        date: todayIso(),
      });
      target = s.id;
      title = sessionTitle(s);
      created++;
      firstId ??= s.id;
    }
    let doc: Awaited<ReturnType<typeof createDeckDocument>>;
    try {
      doc = await createDeckDocument(project.id, { fileName: file.name, data, sessionId: target, title });
    } catch (err) {
      return { error: `${file.name}: ${(err as Error).message}`, created };
    }
    if (doc.filePath) after(() => indexOwner(project.id, 'document', doc.id).catch(() => {}));
  }
  const tab = kind.data === 'lecture' ? 'lectures' : 'recitations';
  revalidatePath(`${base}/${tab}`);
  revalidatePath(`${base}/documents`);
  if (sessionId) revalidatePath(`${base}/${tab}/${sessionId}`);
  if (created === 1 && firstId && files.length === 1) redirect(`${base}/${tab}/${firstId}`);
  return { ok: true, created };
}

const patchSchema = z.object({
  number: z.number().int().min(0).max(999).optional(),
  title: z.string().trim().max(200).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export async function updateSessionAction(
  slug: string,
  id: string,
  patch: z.input<typeof patchSchema>,
): Promise<ActionState> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(slug);
  const s = await getSession(project.id, id);
  if (!s) return { error: 'Not found' };
  await updateSession(project.id, id, parsed.data);
  const tab = s.kind === 'lecture' ? 'lectures' : 'recitations';
  revalidatePath(`${projectBase(project)}/${tab}`);
  revalidatePath(`${projectBase(project)}/${tab}/${id}`);
  return { ok: true };
}

export async function deleteSessionAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  const s = await getSession(project.id, id);
  if (!s) return;
  await deleteSession(project.id, id);
  const tab = s.kind === 'lecture' ? 'lectures' : 'recitations';
  revalidatePath(`${projectBase(project)}/${tab}`);
  redirect(`${projectBase(project)}/${tab}`);
}

export async function attachToSessionAction(slug: string, documentId: string, sessionId: string | null) {
  const project = await projectOr404(slug);
  await attachDocumentToSession(project.id, documentId, sessionId);
  revalidatePath(`${projectBase(project)}/lectures`);
  revalidatePath(`${projectBase(project)}/recitations`);
  revalidatePath(`${projectBase(project)}/documents`);
}

/** The raw note taken in a session, created in the Raw folder on first use. */
export async function sessionNoteAction(slug: string, sessionId: string): Promise<Note> {
  const project = await projectOr404(slug);
  const existing = await sessionNote(project.id, sessionId);
  if (existing) return existing;
  const s = await getSession(project.id, sessionId);
  if (!s) throw new Error('session not found');
  const raw = await builtinFolder(project.id, 'raw');
  const title = `${SESSION_LABEL[s.kind].one} ${s.number}${s.title ? ` — ${s.title}` : ''} notes`;
  const note = await createNote(project.id, title, '', { folderId: raw?.id ?? null, sessionId });
  revalidatePath(`${projectBase(project)}/notes`);
  return note;
}

/** Autosave from the lecture page: body only, no slug change, no redirect. */
export async function saveSessionNoteAction(
  slug: string,
  noteId: string,
  body: string,
): Promise<ActionState> {
  const project = await projectOr404(slug);
  const note = await getNote(project.id, noteId);
  if (!note) return { error: 'Note not found' };
  await updateNote(project.id, noteId, { body });
  after(() => indexOwner(project.id, 'note', noteId).catch(() => {}));
  return { ok: true };
}

export type { SessionKind };
