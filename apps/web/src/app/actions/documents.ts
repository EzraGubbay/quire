'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { Document } from '@/db/schema';
import {
  attachPdf,
  createFolder,
  createMarkdownDocument,
  createPaperStub,
  createPdfDocument,
  deleteDocument,
  deleteFolder,
  moveDocument,
  renameFolder,
  updateDocument,
} from '@/lib/documents';
import { downloadPdf, type PaperMeta, parseReference, resolveReference } from '@/lib/ingest';
import { getProjectBySlug } from '@/lib/projects';

export interface ActionState {
  error?: string;
  ok?: boolean;
}

const MAX_PDF_BYTES = 80 * 1024 * 1024;

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

const optionalUuid = z
  .string()
  .uuid()
  .or(z.literal(''))
  .transform((v) => (v === '' ? null : v));

export async function uploadPdfAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get('slug') ?? '');
  const folderId = optionalUuid.safeParse(formData.get('folderId') ?? '');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PDF file.' };
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')
    return { error: 'Only PDF files are accepted here.' };
  if (file.size > MAX_PDF_BYTES) return { error: 'PDF is larger than 80 MB.' };
  const project = await projectOr404(slug);
  const data = new Uint8Array(await file.arrayBuffer());
  let doc: Awaited<ReturnType<typeof createPdfDocument>>;
  try {
    doc = await createPdfDocument(project.id, {
      fileName: file.name,
      data,
      folderId: folderId.success ? folderId.data : null,
    });
  } catch (err) {
    return { error: `Could not read that PDF: ${(err as Error).message}` };
  }
  revalidatePath(`/p/${slug}/documents`);
  redirect(`/p/${slug}/documents/${doc.id}`);
}

const markdownSchema = z.object({
  slug: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  folderId: optionalUuid,
});

export async function createMarkdownAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = markdownSchema.safeParse({
    slug: formData.get('slug'),
    title: formData.get('title'),
    folderId: formData.get('folderId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  const doc = await createMarkdownDocument(
    project.id,
    parsed.data.title,
    `# ${parsed.data.title}\n\n`,
    parsed.data.folderId,
  );
  revalidatePath(`/p/${parsed.data.slug}/documents`);
  redirect(`/p/${parsed.data.slug}/documents/${doc.id}`);
}

const folderSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  parentId: optionalUuid,
});

export async function createFolderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = folderSchema.safeParse({
    slug: formData.get('slug'),
    name: formData.get('name'),
    parentId: formData.get('parentId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  await createFolder(project.id, parsed.data.name, parsed.data.parentId);
  revalidatePath(`/p/${parsed.data.slug}/documents`);
  return { ok: true };
}

export async function renameFolderAction(slug: string, folderId: string, name: string): Promise<void> {
  const project = await projectOr404(slug);
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  await renameFolder(project.id, folderId, clean);
  revalidatePath(`/p/${slug}/documents`);
}

export async function deleteFolderAction(slug: string, folderId: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteFolder(project.id, folderId);
  revalidatePath(`/p/${slug}/documents`);
}

export async function moveDocumentAction(
  slug: string,
  documentId: string,
  folderId: string | null,
): Promise<void> {
  const project = await projectOr404(slug);
  await moveDocument(project.id, documentId, folderId);
  revalidatePath(`/p/${slug}/documents`);
}

export async function deleteDocumentAction(slug: string, documentId: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteDocument(project.id, documentId);
  revalidatePath(`/p/${slug}/documents`);
  redirect(`/p/${slug}/documents`);
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  authors: z.array(z.string().trim().min(1)).optional(),
  year: z.number().int().min(1000).max(2100).nullable().optional(),
  abstract: z.string().max(10000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
  readingStatus: z.enum(['unread', 'reading', 'done']).optional(),
  lastPage: z.number().int().min(1).optional(),
  progress: z.number().min(0).max(1).optional(),
  markdownBody: z.string().max(2_000_000).optional(),
});

export async function updateDocumentAction(
  slug: string,
  documentId: string,
  patch: z.input<typeof patchSchema>,
): Promise<ActionState> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(slug);
  await updateDocument(project.id, documentId, parsed.data);
  revalidatePath(`/p/${slug}/documents/${documentId}`);
  return { ok: true };
}

const importSchema = z.object({
  slug: z.string().min(1),
  reference: z.string().trim().min(1).max(2000),
  folderId: optionalUuid,
});

/** Paste an arXiv id/URL, a DOI, or a direct PDF link: resolves metadata, downloads the PDF when one is known. */
export async function importReferenceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = importSchema.safeParse({
    slug: formData.get('slug'),
    reference: formData.get('reference'),
    folderId: formData.get('folderId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const { slug, reference, folderId } = parsed.data;
  const ref = parseReference(reference);
  if (!ref) return { error: 'That does not look like an arXiv id, a DOI, or a link.' };
  const project = await projectOr404(slug);
  let meta: PaperMeta;
  try {
    meta = await resolveReference(ref);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const base = {
    folderId,
    sourceUrl: meta.sourceUrl ?? null,
    arxivId: meta.arxivId ?? null,
    doi: meta.doi ?? null,
    meta: { title: meta.title, authors: meta.authors, year: meta.year, abstract: meta.abstract },
  };
  let doc: Document;
  if (meta.pdfUrl) {
    try {
      const { data, fileName } = await downloadPdf(meta.pdfUrl);
      doc = await createPdfDocument(project.id, { ...base, fileName, data });
    } catch (err) {
      if (ref.kind === 'url') return { error: (err as Error).message };
      // Metadata is still worth keeping; the PDF can be attached by hand.
      doc = await createPaperStub(project.id, base);
    }
  } else {
    doc = await createPaperStub(project.id, base);
  }
  revalidatePath(`/p/${slug}/documents`);
  redirect(`/p/${slug}/documents/${doc.id}`);
}

/** Upload a PDF into a paper record that has metadata but no file yet. */
export async function attachPdfAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get('slug') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PDF file.' };
  if (file.size > MAX_PDF_BYTES) return { error: 'PDF is larger than 80 MB.' };
  const project = await projectOr404(slug);
  try {
    await attachPdf(project.id, documentId, new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    return { error: `Could not read that PDF: ${(err as Error).message}` };
  }
  revalidatePath(`/p/${slug}/documents/${documentId}`);
  return { ok: true };
}
