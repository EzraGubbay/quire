// Review queue (files the deterministic rules couldn't place confidently) and the one-click re-file that
// resolves them. Re-filing moves the already-created document; it never re-downloads. Each resolution also
// records corrected_kind — the label Phase 2's learning loop reads.
import type { LemidaKind } from '@quire/shared';
import { and, desc, eq } from 'drizzle-orm';
import { after } from 'next/server';
import { db } from '@/db/client';
import { assignments, type LemidaFile, lemidaFiles, type Project, projects } from '@/db/schema';
import { indexOwner } from '@/lib/ai/index';
import { builtinFolder, createFolder, listFolders, moveDocument } from '@/lib/documents';
import { createAssignment, nextAssignmentNumber, updateAssignment } from '@/lib/homework';
import { attachDocumentToSession, createSession, listSessions } from '@/lib/sessions';
import { classifyLemidaFile, cleanTitle } from './classify';
import { homeworkNumber } from './import';

export interface ReviewItem extends LemidaFile {
  project: Project;
}

/** Files awaiting a human type decision, newest first. */
export async function listReviewQueue(): Promise<ReviewItem[]> {
  const rows = await db
    .select({ f: lemidaFiles, p: projects })
    .from(lemidaFiles)
    .innerJoin(projects, eq(lemidaFiles.projectId, projects.id))
    .where(eq(lemidaFiles.status, 'needs_review'))
    .orderBy(desc(lemidaFiles.createdAt));
  return rows.map((r) => ({ ...r.f, project: r.p }));
}

/** Recently handled files (imported/duplicate/error), for the panel's activity list. */
export async function recentFiles(limit = 20): Promise<ReviewItem[]> {
  const rows = await db
    .select({ f: lemidaFiles, p: projects })
    .from(lemidaFiles)
    .innerJoin(projects, eq(lemidaFiles.projectId, projects.id))
    .orderBy(desc(lemidaFiles.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.f, project: r.p }));
}

export async function getLemidaFile(id: string): Promise<LemidaFile | undefined> {
  const [row] = await db.select().from(lemidaFiles).where(eq(lemidaFiles.id, id)).limit(1);
  return row;
}

async function ensureFolder(projectId: string, name: string) {
  const existing = (await listFolders(projectId, 'documents')).find((f) => f.name === name && !f.parentId);
  return existing ?? createFolder(projectId, name, null, 'documents');
}

async function findOrCreateAssignment(projectId: string, fileName: string) {
  const number = homeworkNumber(fileName) ?? (await nextAssignmentNumber(projectId));
  const [existing] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.projectId, projectId), eq(assignments.number, number)))
    .limit(1);
  return existing ?? createAssignment(projectId, { number, title: cleanTitle(fileName) });
}

/**
 * Re-file a reviewed document as `kind`. The document already exists (it was placed in Documents when
 * imported as unknown); this moves it to the right place and records the correction.
 */
export async function resolveReview(fileId: string, kind: LemidaKind): Promise<void> {
  const file = await getLemidaFile(fileId);
  if (!file) return;
  const projectId = file.projectId;
  const docId = file.placement?.documentId;
  const placement = { ...file.placement };

  if (docId) {
    if (kind === 'lecture' || kind === 'recitation') {
      const cls = classifyLemidaFile({ fileName: file.fileName });
      const all = await listSessions(projectId, kind);
      const session =
        (cls.number !== undefined && all.find((s) => s.number === cls.number)) ||
        (await createSession(projectId, { kind, number: cls.number, title: cls.title ?? '' }));
      await moveDocument(projectId, docId, null);
      await attachDocumentToSession(projectId, docId, session.id);
      placement.sessionId = session.id;
    } else if (kind === 'homework') {
      const folder = await ensureFolder(projectId, 'Homework');
      await moveDocument(projectId, docId, folder.id);
      await attachDocumentToSession(projectId, docId, null);
      const assignment = await findOrCreateAssignment(projectId, file.fileName);
      await updateAssignment(projectId, assignment.id, {
        sheetDocumentId: assignment.sheetDocumentId ?? docId,
      });
      placement.assignmentId = assignment.id;
    } else if (kind === 'exam') {
      const folder =
        (await builtinFolder(projectId, 'practice_exams')) ??
        (await ensureFolder(projectId, 'Practice Exams'));
      await moveDocument(projectId, docId, folder.id);
      await attachDocumentToSession(projectId, docId, null);
    } else if (kind === 'book') {
      const folder = await ensureFolder(projectId, 'Course material');
      await moveDocument(projectId, docId, folder.id);
      await attachDocumentToSession(projectId, docId, null);
    } else {
      // other / document: leave in Documents root, detached from any session.
      await moveDocument(projectId, docId, null);
      await attachDocumentToSession(projectId, docId, null);
    }
    try {
      after(() => indexOwner(projectId, 'document', docId).catch(() => {}));
    } catch {
      // no request context
    }
  }

  await db
    .update(lemidaFiles)
    .set({ status: 'imported', detectedKind: kind, correctedKind: kind, placement, updatedAt: new Date() })
    .where(eq(lemidaFiles.id, fileId));
}

/** Drop a reviewed file without filing it (keeps the document, clears it from the queue). */
export async function dismissReview(fileId: string): Promise<void> {
  const file = await getLemidaFile(fileId);
  if (!file) return;
  await db
    .update(lemidaFiles)
    .set({ status: 'imported', correctedKind: 'other', updatedAt: new Date() })
    .where(eq(lemidaFiles.id, fileId));
}
