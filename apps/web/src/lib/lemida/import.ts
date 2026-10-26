// Takes a file the agent downloaded from Lemida and places it in the right course/tab — deterministically,
// with no LLM. Dedupes by content hash (against prior Lemida pulls AND hand-uploaded decks), classifies,
// creates the document (reusing the deck/PDF import path), and records a lemida_files row that doubles as
// the review queue and the Phase-2 training log.
import type { LemidaFileStatus, LemidaKind } from '@quire/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { after } from 'next/server';
import { db } from '@/db/client';
import { assignments, documents, type Folder, type LemidaFile, lemidaFiles, type Project } from '@/db/schema';
import { indexOwner } from '@/lib/ai/index';
import { builtinFolder, createDeckDocument, createFolder, listFolders } from '@/lib/documents';
import { readStoredFile, sha256 } from '@/lib/files';
import { createAssignment, nextAssignmentNumber, updateAssignment } from '@/lib/homework';
import { attachDocumentToSession, createSession, listSessions, sessionTitle } from '@/lib/sessions';
import { classifyLemidaFile, cleanTitle } from './classify';

export interface ImportMeta {
  fileName: string;
  sourceUrl?: string;
  sectionTitle?: string;
  moduleType?: string;
  contentType?: string;
  firstPageSnippet?: string;
  /** The lemida_courses.id this file came from, when the agent crawled a mapped course. */
  mappingId?: string | null;
}

export interface ImportResult {
  status: LemidaFileStatus;
  lemidaFileId: string;
  detectedKind: LemidaKind;
  placement: { documentId?: string; sessionId?: string; assignmentId?: string };
  needsReview: boolean;
  duplicate: boolean;
}

/** Schedule background indexing, tolerating being called outside a request (e.g. a test). */
function indexLater(projectId: string, id: string): void {
  try {
    after(() => indexOwner(projectId, 'document', id).catch(() => {}));
  } catch {
    // No request context (unit test); skip indexing.
  }
}

/** A document's source bytes live at its original upload (pptx) or its PDF; used for hash backfill. */
const sourceRel = (d: { originalPath: string | null; filePath: string | null }): string | null =>
  d.originalPath ?? d.filePath;

/**
 * Backfill content_hash for a project's documents that lack one, so a download can be recognised as a
 * copy of a deck the user added by hand. Idempotent and cheap after the first run (few rows remain).
 */
async function backfillHashes(projectId: string): Promise<void> {
  const rows = await db
    .select({ id: documents.id, originalPath: documents.originalPath, filePath: documents.filePath })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), isNull(documents.contentHash)));
  for (const r of rows) {
    const rel = sourceRel(r);
    if (!rel) continue;
    try {
      const buf = await readStoredFile(rel);
      await db
        .update(documents)
        .set({ contentHash: sha256(buf) })
        .where(eq(documents.id, r.id));
    } catch {
      // File missing on disk; leave the hash null and move on.
    }
  }
}

async function ensureFolder(projectId: string, name: string): Promise<Folder> {
  const existing = (await listFolders(projectId, 'documents')).find((f) => f.name === name && !f.parentId);
  return existing ?? createFolder(projectId, name, null, 'documents');
}

/** Find the session with this kind and number, or create it. */
async function findOrCreateSession(
  projectId: string,
  kind: 'lecture' | 'recitation',
  number: number | undefined,
  title: string | undefined,
) {
  const all = await listSessions(projectId, kind);
  if (number !== undefined) {
    const match = all.find((s) => s.number === number);
    if (match) return match;
  }
  return createSession(projectId, { kind, number, title: title ?? '' });
}

async function findOrCreateAssignment(projectId: string, number: number, title: string) {
  const [existing] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.projectId, projectId), eq(assignments.number, number)))
    .limit(1);
  if (existing) return existing;
  return createAssignment(projectId, { number, title });
}

const HW_NUM = /(?:תרגיל\s*בית|שיעור[יe]?\s*בית|מטלה|homework|assignment|\bhw|\bps|\bex)\D{0,6}(\d{1,3})/i;
/** A homework number from the file name; the first integer as a fallback. */
export function homeworkNumber(fileName: string): number | undefined {
  const m = fileName.match(HW_NUM) ?? fileName.match(/(\d{1,3})/);
  return m?.[1] ? Number(m[1]) : undefined;
}

const DUE = /(?:להגש[הת]|הגשה|due|deadline)[^0-9]{0,12}(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/i;
/** A due date mentioned on the first page ("להגשה עד 12.11"), interpreted as this academic year. */
export function parseDueDate(snippet: string | undefined, now = new Date()): Date | null {
  if (!snippet) return null;
  const m = snippet.match(DUE);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // No explicit year and the date already passed this year ⇒ it means next year.
  const d = new Date(year, month - 1, day, 23, 59);
  if (!m[3] && d.getTime() < now.getTime() - 7 * 86_400_000) d.setFullYear(year + 1);
  return d;
}

export async function importLemidaFile(
  project: Project,
  meta: ImportMeta,
  data: Uint8Array,
): Promise<ImportResult> {
  const hash = sha256(data);

  // 1. Already pulled this exact file (per project).
  const [prior] = await db
    .select()
    .from(lemidaFiles)
    .where(and(eq(lemidaFiles.projectId, project.id), eq(lemidaFiles.sha256, hash)))
    .limit(1);
  if (prior && prior.status !== 'error') return asResult(prior, true);

  // 2. Same bytes as a document already in the course (e.g. a hand-uploaded deck).
  await backfillHashes(project.id);
  const [twin] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.projectId, project.id), eq(documents.contentHash, hash)))
    .limit(1);

  const cls = classifyLemidaFile({
    fileName: meta.fileName,
    sectionTitle: meta.sectionTitle,
    moduleType: meta.moduleType,
    firstPageSnippet: meta.firstPageSnippet,
  });

  if (twin) {
    const row = await recordFile(project.id, meta, hash, data.byteLength, cls, 'duplicate', {
      documentId: twin.id,
    });
    return asResult(row, true);
  }

  // 3. Place it.
  const placement: ImportResult['placement'] = {};
  let status: LemidaFileStatus = 'imported';
  const title = cls.title ?? cleanTitle(meta.fileName);

  try {
    if (cls.kind === 'lecture' || cls.kind === 'recitation') {
      const session = await findOrCreateSession(project.id, cls.kind, cls.number, cls.title);
      const doc = await createDeckDocument(project.id, {
        fileName: meta.fileName,
        data,
        sessionId: session.id,
        title: cls.title ? sessionTitle(session) : undefined,
      });
      await setHash(doc.id, hash);
      placement.sessionId = session.id;
      placement.documentId = doc.id;
      if (doc.filePath) indexLater(project.id, doc.id);
    } else if (cls.kind === 'homework') {
      const folder = await ensureFolder(project.id, 'Homework');
      const doc = await createDeckDocument(project.id, {
        fileName: meta.fileName,
        data,
        folderId: folder.id,
        title,
      });
      await setHash(doc.id, hash);
      const number = homeworkNumber(meta.fileName) ?? (await nextAssignmentNumber(project.id));
      const assignment = await findOrCreateAssignment(project.id, number, title);
      const due = parseDueDate(meta.firstPageSnippet);
      await updateAssignment(project.id, assignment.id, {
        sheetDocumentId: assignment.sheetDocumentId ?? doc.id,
        ...(due && !assignment.dueAt ? { dueAt: due } : {}),
      });
      placement.assignmentId = assignment.id;
      placement.documentId = doc.id;
      if (doc.filePath) indexLater(project.id, doc.id);
    } else if (cls.kind === 'exam') {
      const folder =
        (await builtinFolder(project.id, 'practice_exams')) ??
        (await ensureFolder(project.id, 'Practice Exams'));
      const doc = await createDeckDocument(project.id, {
        fileName: meta.fileName,
        data,
        folderId: folder.id,
        title,
      });
      await setHash(doc.id, hash);
      placement.documentId = doc.id;
      if (doc.filePath) indexLater(project.id, doc.id);
    } else {
      // book / other / unknown → Documents (a "Course material" folder for book, root otherwise).
      const folderId = cls.kind === 'book' ? (await ensureFolder(project.id, 'Course material')).id : null;
      const doc = await createDeckDocument(project.id, { fileName: meta.fileName, data, folderId, title });
      await setHash(doc.id, hash);
      placement.documentId = doc.id;
      if (doc.filePath) indexLater(project.id, doc.id);
      if (cls.kind === 'unknown') status = 'needs_review';
    }
  } catch (err) {
    const row = await recordFile(
      project.id,
      meta,
      hash,
      data.byteLength,
      cls,
      'error',
      placement,
      (err as Error).message,
    );
    return asResult(row, false);
  }

  const row = await recordFile(project.id, meta, hash, data.byteLength, cls, status, placement);
  return asResult(row, false);
}

async function setHash(documentId: string, hash: string): Promise<void> {
  await db.update(documents).set({ contentHash: hash }).where(eq(documents.id, documentId));
}

async function recordFile(
  projectId: string,
  meta: ImportMeta,
  hash: string,
  size: number,
  cls: ReturnType<typeof classifyLemidaFile>,
  status: LemidaFileStatus,
  placement: ImportResult['placement'],
  error?: string,
): Promise<LemidaFile> {
  const [row] = await db
    .insert(lemidaFiles)
    .values({
      projectId,
      lemidaCourseId: meta.mappingId ?? null,
      sourceUrl: meta.sourceUrl ?? '',
      fileName: meta.fileName,
      sha256: hash,
      contentType: meta.contentType ?? 'application/octet-stream',
      size,
      sectionTitle: meta.sectionTitle ?? '',
      moduleType: meta.moduleType ?? '',
      detectedKind: cls.kind,
      confidence: cls.confidence,
      rule: cls.rule,
      placement,
      status,
      error: error ?? null,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

const asResult = (row: LemidaFile, duplicate: boolean): ImportResult => ({
  status: row.status,
  lemidaFileId: row.id,
  detectedKind: row.detectedKind,
  placement: row.placement,
  needsReview: row.status === 'needs_review',
  duplicate,
});
