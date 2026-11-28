// Test-only: a synthetic course and a synthetic research project for the MCP golden transcripts. Everything
// here is made up (public repo): tiny generated PDFs, invented titles, example.org URLs. Import this module
// only after FILES_DIR is set (it loads lib/files through lib/documents), and run it only against a throwaway
// database, never one that holds real data.
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { documents, notes, type Project, projects, sources } from '@/db/schema';
import {
  builtinFolder,
  createDeckDocument,
  createFolder,
  createMarkdownDocument,
  createPaperStub,
  createPdfDocument,
  updateDocument,
} from '@/lib/documents';
import { createAssignment, updateAssignment } from '@/lib/homework';
import { createNote } from '@/lib/notes';
import { createCourse, createProject } from '@/lib/projects';
import { createSession } from '@/lib/sessions';
import { createSource } from '@/lib/sources';
import { samplePdf } from './sample-pdf';
import { type TinyRun, tinyPdf } from './tiny-pdf';

/** 12 pages of Latin text, long enough that a whole-file read exceeds the MCP text budget. */
export function longPdf(): Uint8Array {
  const pages = Array.from({ length: 12 }, (_, p) => ({
    runs: Array.from(
      { length: 40 },
      (_, r): TinyRun => ({
        font: 'body',
        size: 10,
        x: 50,
        y: 800 - 18 * r,
        glyphs: `Page ${p + 1} line ${r + 1}: the quick brown fox jumps over the lazy dog`,
      }),
    ),
  }));
  return tinyPdf(pages);
}

export interface GoldenSeed {
  run: string;
  course: Project;
  research: Project;
  /** Entity name to uuid, for the normalizer. */
  ids: Record<string, string>;
  /** Deletes both projects (everything cascades). */
  cleanup(): Promise<void>;
}

const MD_EXAM = '# Practice exam 2025\n\n1. Prove that the sum of two even numbers is even.\n';
const MD_SHEET = '# HW 1\n\n1. Synthetic exercise.\n';
const MD_CHEAT = '## סיכום\n\nנוסחה: $\\sum_{i=1}^{n} i = n(n+1)/2$\n';

export async function seedGolden(run: string): Promise<GoldenSeed> {
  const ids: Record<string, string> = {};
  const order: { table: 'documents' | 'notes' | 'sources'; id: string }[] = [];
  const track = <T extends { id: string }>(
    name: string,
    table: 'documents' | 'notes' | 'sources',
    row: T,
  ): T => {
    ids[name] = row.id;
    order.push({ table, id: row.id });
    return row;
  };

  const course = await createCourse({
    name: `Golden Course ${run}`,
    description: 'Synthetic course for MCP goldens',
    type: 'mixed',
    code: 'GC101',
    semester: '2026A',
    links: [],
  });
  ids.course = course.id;
  const cid = course.id;

  const lecture1 = await createSession(cid, { kind: 'lecture', number: 1, title: 'Intro' });
  const recitation1 = await createSession(cid, { kind: 'recitation', number: 1, title: 'Warm-up' });
  ids.lecture1 = lecture1.id;
  ids.recitation1 = recitation1.id;

  track(
    'lecture-deck',
    'documents',
    await createDeckDocument(cid, {
      fileName: 'lecture-1.pdf',
      data: samplePdf(),
      sessionId: lecture1.id,
      title: 'Lecture 1 slides',
    }),
  );
  track(
    'recitation-deck',
    'documents',
    await createDeckDocument(cid, {
      fileName: 'recitation-1.pdf',
      data: tinyPdf([
        { runs: [{ font: 'body', size: 10, x: 50, y: 780, glyphs: 'Recitation one warm-up' }] },
      ]),
      sessionId: recitation1.id,
      title: 'Recitation 1',
    }),
  );
  // No GOTENBERG_URL: the original is kept, there is no PDF rendering, and conversionError is set.
  track(
    'pptx-deck',
    'documents',
    await createDeckDocument(cid, {
      fileName: 'lecture-2.pptx',
      data: new TextEncoder().encode('synthetic pptx bytes'),
      title: 'Lecture 2 deck',
    }),
  );

  const practice = await builtinFolder(cid, 'practice_exams');
  const raw = await builtinFolder(cid, 'raw');
  if (!practice || !raw) throw new Error('builtin folders missing');
  ids['practice-folder'] = practice.id;
  ids['raw-folder'] = raw.id;
  track('exam', 'documents', await createMarkdownDocument(cid, 'Practice exam 2025', MD_EXAM, practice.id));

  const sheet = track(
    'homework-sheet',
    'documents',
    await createMarkdownDocument(cid, 'HW 1', MD_SHEET, null),
  );
  const hw1 = await createAssignment(cid, { number: 1, title: 'HW 1' });
  ids.hw1 = hw1.id;
  await updateAssignment(cid, hw1.id, { sheetDocumentId: sheet.id });

  const material = await createFolder(cid, 'Course material', null, 'documents');
  ids['course-material'] = material.id;
  track(
    'book',
    'documents',
    await createPdfDocument(cid, {
      fileName: 'book.pdf',
      data: longPdf(),
      folderId: material.id,
      meta: { title: 'Course book' },
    }),
  );
  track(
    'course-paper',
    'documents',
    await createPaperStub(cid, { arxivId: '2401.01234', meta: { title: 'Referenced paper' } }),
  );
  track('cheatsheet', 'documents', await createMarkdownDocument(cid, 'Cheat sheet', MD_CHEAT, null));
  track(
    'course-note',
    'notes',
    await createNote(cid, 'Lecture 1 notes', 'synthetic', { folderId: raw.id, sessionId: lecture1.id }),
  );

  const research = await createProject({
    name: `Golden Research ${run}`,
    description: 'Synthetic research project for MCP goldens',
  });
  ids.research = research.id;
  const rid = research.id;
  const papers = await createFolder(rid, 'Papers', null, 'documents');
  const reading = await createFolder(rid, 'Reading notes', null, 'notes');
  ids.papers = papers.id;
  ids.reading = reading.id;

  const paper = track(
    'paper',
    'documents',
    await createPdfDocument(rid, {
      fileName: 'paper.pdf',
      data: samplePdf(),
      folderId: papers.id,
      arxivId: '2401.01234',
      doi: '10.1000/golden',
      sourceUrl: 'https://arxiv.org/abs/2401.01234',
      meta: {
        title: 'A Synthetic Paper',
        authors: ['A. Author', 'B. Author'],
        year: 2024,
        abstract: 'Synthetic abstract.',
      },
    }),
  );
  await updateDocument(rid, paper.id, { tags: ['golden'] });
  track(
    'stub',
    'documents',
    await createPaperStub(rid, { doi: '10.1000/stub', meta: { title: 'Stub paper' } }),
  );
  track('method', 'documents', await createMarkdownDocument(rid, 'Method', 'Hebrew + $x^2$ body', null));
  track(
    'note',
    'notes',
    await createNote(rid, 'Reading log', '# log\n\nsynthetic', { folderId: reading.id }),
  );
  track(
    'source',
    'sources',
    await createSource(rid, {
      type: 'web',
      url: 'https://example.org/golden',
      title: 'Example source',
      description: 'Synthetic description',
      tags: ['golden'],
    }),
  );

  // Pin updatedAt in a fixed order, so every `updatedAt desc` listing is independent of timing.
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000);
  let i = 0;
  for (const { table, id } of order) {
    const t = table === 'documents' ? documents : table === 'notes' ? notes : sources;
    await db
      .update(t)
      .set({ updatedAt: at(i++) })
      .where(eq(t.id, id));
  }
  await db
    .update(projects)
    .set({ updatedAt: at(i++) })
    .where(eq(projects.id, cid));
  await db
    .update(projects)
    .set({ updatedAt: at(i++) })
    .where(eq(projects.id, rid));

  return {
    run,
    course,
    research,
    ids,
    cleanup: async () => {
      await db.delete(projects).where(inArray(projects.id, [cid, rid]));
    },
  };
}
