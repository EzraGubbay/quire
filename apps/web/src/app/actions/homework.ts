'use server';

import { ASSIGNMENT_STATUSES, QUESTION_STATUSES } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { z } from 'zod';
import { indexOwner } from '@/lib/ai/index';
import { createFolder, createPdfDocument, listFolders } from '@/lib/documents';
import { removeStoredFile } from '@/lib/files';
import {
  addQuestion,
  addSubmissionFile,
  createAssignment,
  deleteAssignment,
  deleteQuestion,
  getAssignment,
  removeSubmissionFile,
  updateAssignment,
  updateQuestion,
} from '@/lib/homework';
import { getProjectBySlug, projectBase } from '@/lib/projects';

export interface ActionState {
  error?: string;
  ok?: boolean;
}

const MAX_FILE = 100 * 1024 * 1024;

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

const createSchema = z.object({
  slug: z.string().min(1),
  number: z.coerce.number().int().min(0).max(999).optional(),
  title: z.string().trim().min(1).max(200),
  dueAt: z.string().optional(),
  questions: z.string().default(''),
});

/** `+ Assignment`: number, title, due date/time, and an optional first list of question labels (one per line). */
export async function createAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse({
    slug: formData.get('slug'),
    number: formData.get('number') || undefined,
    title: formData.get('title'),
    dueAt: formData.get('dueAt') ?? '',
    questions: formData.get('questions') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  const due = parsed.data.dueAt ? new Date(parsed.data.dueAt) : null;
  const questions = parsed.data.questions
    .split(/\r?\n|,/)
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 60);
  const a = await createAssignment(project.id, {
    number: parsed.data.number,
    title: parsed.data.title,
    dueAt: due && !Number.isNaN(due.getTime()) ? due : null,
    questions,
  });
  revalidatePath(`${projectBase(project)}/homework`);
  revalidatePath('/courses');
  redirect(`${projectBase(project)}/homework/${a.id}`);
}

const patchSchema = z.object({
  number: z.number().int().min(0).max(999).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  dueAt: z.string().nullable().optional(),
  status: z.enum(ASSIGNMENT_STATUSES).optional(),
  repoUrl: z.string().trim().max(500).nullable().optional(),
  score: z.number().min(0).nullable().optional(),
  maxScore: z.number().min(0).nullable().optional(),
  lostPoints: z.string().max(10000).optional(),
  notes: z.string().max(20000).optional(),
});

export async function updateAssignmentAction(
  slug: string,
  id: string,
  patch: z.input<typeof patchSchema>,
): Promise<ActionState> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(slug);
  const { dueAt, ...rest } = parsed.data;
  const values: Parameters<typeof updateAssignment>[2] = { ...rest };
  if (dueAt !== undefined) {
    const d = dueAt ? new Date(dueAt) : null;
    values.dueAt = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (rest.score != null && rest.status === undefined) values.status = 'graded';
  if (rest.repoUrl) {
    const a = await getAssignment(project.id, id);
    if (a && a.status === 'not_started') values.status = 'in_progress';
  }
  await updateAssignment(project.id, id, values);
  revalidatePath(`${projectBase(project)}/homework`);
  revalidatePath(`${projectBase(project)}/homework/${id}`);
  revalidatePath(`${projectBase(project)}/overview`);
  revalidatePath('/courses');
  return { ok: true };
}

export async function deleteAssignmentAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  const files = await deleteAssignment(project.id, id);
  for (const f of files) await removeStoredFile(f.filePath);
  revalidatePath(`${projectBase(project)}/homework`);
  redirect(`${projectBase(project)}/homework`);
}

export async function addQuestionAction(
  slug: string,
  assignmentId: string,
  label: string,
): Promise<ActionState> {
  const clean = label.trim().slice(0, 80);
  if (!clean) return { error: 'Give the question a label.' };
  const project = await projectOr404(slug);
  const a = await getAssignment(project.id, assignmentId);
  if (!a) return { error: 'Not found' };
  await addQuestion(assignmentId, clean);
  if (a.status === 'not_started' && a.questions.length === 0)
    await updateAssignment(project.id, assignmentId, { status: 'in_progress' });
  revalidatePath(`${projectBase(project)}/homework/${assignmentId}`);
  return { ok: true };
}

const qPatch = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  notes: z.string().max(20000).optional(),
});

export async function updateQuestionAction(
  slug: string,
  assignmentId: string,
  questionId: string,
  patch: z.input<typeof qPatch>,
) {
  const parsed = qPatch.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(slug);
  const a = await getAssignment(project.id, assignmentId);
  if (!a) return { error: 'Not found' };
  await updateQuestion(questionId, parsed.data);
  if (parsed.data.status && a.status === 'not_started')
    await updateAssignment(project.id, assignmentId, { status: 'in_progress' });
  revalidatePath(`${projectBase(project)}/homework/${assignmentId}`);
  revalidatePath(`${projectBase(project)}/homework`);
  return { ok: true };
}

export async function deleteQuestionAction(
  slug: string,
  assignmentId: string,
  questionId: string,
): Promise<void> {
  const project = await projectOr404(slug);
  await deleteQuestion(questionId);
  revalidatePath(`${projectBase(project)}/homework/${assignmentId}`);
}

/** Submission files (any type) are stored, not opened; PDFs for the sheet / returned paper go through documents. */
export async function uploadSubmissionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get('slug') ?? '');
  const assignmentId = String(formData.get('assignmentId') ?? '');
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { error: 'Choose a file.' };
  const project = await projectOr404(slug);
  const a = await getAssignment(project.id, assignmentId);
  if (!a) return { error: 'Not found' };
  for (const f of files) {
    if (f.size > MAX_FILE) return { error: `${f.name} is larger than 100 MB.` };
    await addSubmissionFile(project.id, assignmentId, {
      name: f.name,
      data: new Uint8Array(await f.arrayBuffer()),
      contentType: f.type || 'application/octet-stream',
    });
  }
  if (a.status === 'not_started' || a.status === 'in_progress')
    await updateAssignment(project.id, assignmentId, { status: 'submitted' });
  revalidatePath(`${projectBase(project)}/homework/${assignmentId}`);
  revalidatePath(`${projectBase(project)}/homework`);
  return { ok: true };
}

export async function removeSubmissionAction(
  slug: string,
  assignmentId: string,
  fileId: string,
): Promise<void> {
  const project = await projectOr404(slug);
  await removeSubmissionFile(fileId);
  revalidatePath(`${projectBase(project)}/homework/${assignmentId}`);
}

/** Attach the problem sheet or the returned, graded PDF: stored as a document (annotatable) in a Homework folder. */
export async function attachAssignmentPdfAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get('slug') ?? '');
  const assignmentId = String(formData.get('assignmentId') ?? '');
  const which = formData.get('which') === 'returned' ? 'returned' : 'sheet';
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PDF.' };
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')
    return { error: 'Only PDF files are accepted here.' };
  const project = await projectOr404(slug);
  const a = await getAssignment(project.id, assignmentId);
  if (!a) return { error: 'Not found' };
  const folders = await listFolders(project.id, 'documents');
  const folder =
    folders.find((f) => f.name === 'Homework' && !f.parentId) ??
    (await createFolder(project.id, 'Homework', null));
  let doc: Awaited<ReturnType<typeof createPdfDocument>>;
  try {
    doc = await createPdfDocument(project.id, {
      fileName: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      folderId: folder.id,
      meta: { title: `${which === 'sheet' ? 'Assignment' : 'Graded'} #${a.number}: ${a.title}` },
    });
  } catch (err) {
    return { error: `Could not read that PDF: ${(err as Error).message}` };
  }
  after(() => indexOwner(project.id, 'document', doc.id).catch(() => {}));
  await updateAssignment(
    project.id,
    assignmentId,
    which === 'sheet' ? { sheetDocumentId: doc.id } : { returnedDocumentId: doc.id },
  );
  revalidatePath(`${projectBase(project)}/homework/${assignmentId}`);
  revalidatePath(`${projectBase(project)}/documents`);
  return { ok: true };
}
