import type { BuiltinFolder, FolderScope } from '@quire/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Document, documentPages, documents, type Folder, folders, notes } from '@/db/schema';
import { ConvertUnavailable, officeToPdf } from './convert';
import { removeStoredFile, storeFile } from './files';
import { extractPdf, guessTitle } from './pdf';

export async function listFolders(projectId: string, scope: FolderScope = 'documents'): Promise<Folder[]> {
  return db
    .select()
    .from(folders)
    .where(and(eq(folders.projectId, projectId), eq(folders.scope, scope)))
    .orderBy(asc(folders.position), asc(folders.name));
}

/** The course's builtin folder of that kind (Raw, Synthesized, Practice Exams), if it exists. */
export async function builtinFolder(projectId: string, builtin: BuiltinFolder): Promise<Folder | undefined> {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.projectId, projectId), eq(folders.builtin, builtin)))
    .limit(1);
  return row;
}

export async function listDocuments(projectId: string): Promise<Document[]> {
  return db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(desc(documents.updatedAt));
}

export async function getDocument(projectId: string, id: string): Promise<Document | undefined> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
    .limit(1);
  return rows[0];
}

export async function getDocumentPages(documentId: string): Promise<{ pageNo: number; text: string }[]> {
  return db
    .select({ pageNo: documentPages.pageNo, text: documentPages.text })
    .from(documentPages)
    .where(eq(documentPages.documentId, documentId))
    .orderBy(asc(documentPages.pageNo));
}

export async function createFolder(
  projectId: string,
  name: string,
  parentId: string | null,
  scope: FolderScope = 'documents',
): Promise<Folder> {
  const [row] = await db.insert(folders).values({ projectId, name, parentId, scope }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function renameFolder(projectId: string, id: string, name: string): Promise<void> {
  await db
    .update(folders)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(folders.id, id), eq(folders.projectId, projectId)));
}

/** Deletes a folder; its documents or notes and its subfolders move to its parent. Builtin folders stay. */
export async function deleteFolder(projectId: string, id: string): Promise<void> {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.projectId, projectId)));
  if (!folder || folder.builtin) return;
  if (folder.scope === 'notes')
    await db.update(notes).set({ folderId: folder.parentId }).where(eq(notes.folderId, id));
  else await db.update(documents).set({ folderId: folder.parentId }).where(eq(documents.folderId, id));
  await db.update(folders).set({ parentId: folder.parentId }).where(eq(folders.parentId, id));
  await db.delete(folders).where(eq(folders.id, id));
}

export async function moveDocument(projectId: string, id: string, folderId: string | null): Promise<void> {
  await db
    .update(documents)
    .set({ folderId, updatedAt: new Date() })
    .where(and(eq(documents.id, id), eq(documents.projectId, projectId)));
}

export interface PdfUpload {
  fileName: string;
  data: Uint8Array;
  folderId?: string | null;
  sourceUrl?: string | null;
  arxivId?: string | null;
  doi?: string | null;
  /** Metadata known before extraction (arXiv/DOI lookups); overrides PDF-derived values. */
  meta?: { title?: string; authors?: string[]; year?: number | null; abstract?: string };
}

/** Stores the PDF, extracts page text, and creates the document row. */
export async function createPdfDocument(projectId: string, upload: PdfUpload): Promise<Document> {
  const extracted = await extractPdf(upload.data);
  const baseName =
    upload.fileName
      .replace(/\.pdf$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Untitled';
  const title = upload.meta?.title ?? extracted.title ?? guessTitle(extracted.pages[0] ?? '', baseName);
  const authors = upload.meta?.authors ?? (extracted.author ? [extracted.author] : []);
  const [row] = await db
    .insert(documents)
    .values({
      projectId,
      folderId: upload.folderId ?? null,
      kind: 'pdf',
      title,
      authors,
      year: upload.meta?.year ?? null,
      abstract: upload.meta?.abstract ?? '',
      sourceUrl: upload.sourceUrl ?? null,
      arxivId: upload.arxivId ?? null,
      doi: upload.doi ?? null,
      fileSize: upload.data.byteLength,
      pageCount: extracted.pageCount,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  const rel = await storeFile(projectId, row.id, 'pdf', upload.data);
  await db.update(documents).set({ filePath: rel }).where(eq(documents.id, row.id));
  if (extracted.pages.length > 0) {
    await db
      .insert(documentPages)
      .values(extracted.pages.map((text, i) => ({ documentId: row.id, pageNo: i + 1, text })));
  }
  return { ...row, filePath: rel };
}

export interface DeckUpload {
  fileName: string;
  data: Uint8Array;
  sessionId?: string | null;
  folderId?: string | null;
  title?: string;
}

const isPdfName = (name: string) => /\.pdf$/i.test(name);

/**
 * A lecture deck: PDFs are stored as-is; .pptx/.key/.odp files keep the original and get a PDF rendering through
 * the conversion service. Without it (or on failure) the document is created without a file, with the reason in
 * conversion_error, and the viewer offers "Add rendering" (a PDF exported from PowerPoint).
 */
export async function createDeckDocument(projectId: string, upload: DeckUpload): Promise<Document> {
  if (isPdfName(upload.fileName)) {
    const doc = await createPdfDocument(projectId, {
      fileName: upload.fileName,
      data: upload.data,
      folderId: upload.folderId ?? null,
      meta: upload.title ? { title: upload.title } : undefined,
    });
    if (upload.sessionId) {
      await db.update(documents).set({ sessionId: upload.sessionId }).where(eq(documents.id, doc.id));
    }
    return { ...doc, sessionId: upload.sessionId ?? null };
  }
  const title =
    upload.title ??
    upload.fileName
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .replace(/[_-]+/g, ' ')
      .trim();
  const [row] = await db
    .insert(documents)
    .values({
      projectId,
      folderId: upload.folderId ?? null,
      sessionId: upload.sessionId ?? null,
      kind: 'pdf',
      title: title || 'Untitled deck',
      originalName: upload.fileName,
      fileSize: upload.data.byteLength,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  const ext = upload.fileName.split('.').pop()?.toLowerCase() || 'pptx';
  const originalPath = await storeFile(projectId, `${row.id}.original`, ext, upload.data);
  await db.update(documents).set({ originalPath }).where(eq(documents.id, row.id));
  try {
    const pdf = await officeToPdf(upload.data, upload.fileName);
    await attachPdf(projectId, row.id, pdf);
    return { ...row, originalPath, filePath: `${projectId}/${row.id}.pdf` };
  } catch (err) {
    const message =
      err instanceof ConvertUnavailable
        ? 'No conversion service: export the deck to PDF from PowerPoint and add it as the rendering.'
        : `Conversion failed: ${(err as Error).message}`;
    await db.update(documents).set({ conversionError: message }).where(eq(documents.id, row.id));
    return { ...row, originalPath, conversionError: message };
  }
}

/** A paper we know about (metadata from arXiv/Crossref) whose PDF is not available yet. */
export async function createPaperStub(
  projectId: string,
  input: Pick<PdfUpload, 'folderId' | 'sourceUrl' | 'arxivId' | 'doi' | 'meta'>,
): Promise<Document> {
  const [row] = await db
    .insert(documents)
    .values({
      projectId,
      folderId: input.folderId ?? null,
      kind: 'pdf',
      title: input.meta?.title ?? input.doi ?? input.arxivId ?? 'Untitled paper',
      authors: input.meta?.authors ?? [],
      year: input.meta?.year ?? null,
      abstract: input.meta?.abstract ?? '',
      sourceUrl: input.sourceUrl ?? null,
      arxivId: input.arxivId ?? null,
      doi: input.doi ?? null,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Stores a PDF for an existing stub and extracts its text. Keeps the metadata already on the row. */
export async function attachPdf(projectId: string, id: string, data: Uint8Array): Promise<void> {
  const doc = await getDocument(projectId, id);
  if (!doc || doc.kind !== 'pdf') throw new Error('document not found');
  const extracted = await extractPdf(data);
  const rel = await storeFile(projectId, id, 'pdf', data);
  await db.delete(documentPages).where(eq(documentPages.documentId, id));
  if (extracted.pages.length > 0) {
    await db
      .insert(documentPages)
      .values(extracted.pages.map((text, i) => ({ documentId: id, pageNo: i + 1, text })));
  }
  await db
    .update(documents)
    .set({
      filePath: rel,
      fileSize: data.byteLength,
      pageCount: extracted.pageCount,
      conversionError: null,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, id));
}

export async function createMarkdownDocument(
  projectId: string,
  title: string,
  body: string,
  folderId: string | null,
): Promise<Document> {
  const [row] = await db
    .insert(documents)
    .values({ projectId, folderId, kind: 'markdown', title, markdownBody: body })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function updateDocument(
  projectId: string,
  id: string,
  patch: Partial<
    Pick<
      Document,
      | 'title'
      | 'authors'
      | 'year'
      | 'abstract'
      | 'tags'
      | 'readingStatus'
      | 'lastPage'
      | 'progress'
      | 'markdownBody'
      | 'folderId'
      | 'sessionId'
      | 'examMeta'
    >
  >,
): Promise<void> {
  await db
    .update(documents)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(documents.id, id), eq(documents.projectId, projectId)));
}

export async function deleteDocument(projectId: string, id: string): Promise<void> {
  const doc = await getDocument(projectId, id);
  if (!doc) return;
  await db.delete(documents).where(eq(documents.id, id));
  await removeStoredFile(doc.filePath);
  await removeStoredFile(doc.originalPath);
}

/** Documents in the course's Practice Exams folder, with those used as solutions marked. */
export async function listPracticeExams(
  projectId: string,
): Promise<{ exams: Document[]; folderId: string | null }> {
  const folder = await builtinFolder(projectId, 'practice_exams');
  if (!folder) return { exams: [], folderId: null };
  const exams = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.folderId, folder.id)))
    .orderBy(asc(documents.title));
  return { exams, folderId: folder.id };
}

export async function countDocuments(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.projectId, projectId));
  return row?.n ?? 0;
}
