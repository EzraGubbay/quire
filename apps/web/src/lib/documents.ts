import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Document, documentPages, documents, type Folder, folders } from '@/db/schema';
import { removeStoredFile, storeFile } from './files';
import { extractPdf, guessTitle } from './pdf';

export async function listFolders(projectId: string): Promise<Folder[]> {
  return db
    .select()
    .from(folders)
    .where(eq(folders.projectId, projectId))
    .orderBy(asc(folders.position), asc(folders.name));
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
): Promise<Folder> {
  const [row] = await db.insert(folders).values({ projectId, name, parentId }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function renameFolder(projectId: string, id: string, name: string): Promise<void> {
  await db
    .update(folders)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(folders.id, id), eq(folders.projectId, projectId)));
}

/** Deletes a folder; its documents and subfolders move to its parent. */
export async function deleteFolder(projectId: string, id: string): Promise<void> {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.projectId, projectId)));
  if (!folder) return;
  await db.update(documents).set({ folderId: folder.parentId }).where(eq(documents.folderId, id));
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
}

export async function countDocuments(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.projectId, projectId));
  return row?.n ?? 0;
}
