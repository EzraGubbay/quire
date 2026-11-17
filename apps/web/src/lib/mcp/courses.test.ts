import type { Document, Session } from '@/db/schema';
import { type LabelContext, labelDocument } from './courses';

const now = new Date();

function doc(over: Partial<Document> = {}): Document {
  return {
    id: 'd1',
    projectId: 'p1',
    folderId: null,
    kind: 'pdf',
    title: 'Doc',
    authors: [],
    year: null,
    abstract: '',
    sourceUrl: null,
    arxivId: null,
    doi: null,
    filePath: 'p1/d1.pdf',
    fileSize: 100,
    pageCount: 1,
    markdownBody: null,
    readingStatus: 'unread',
    lastPage: 1,
    progress: 0,
    tags: [],
    sessionId: null,
    originalPath: null,
    originalName: null,
    contentHash: null,
    conversionError: null,
    examMeta: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    projectId: 'p1',
    kind: 'lecture',
    number: 2,
    title: 'SIMD',
    date: '2026-10-19',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function ctx(over: Partial<LabelContext> = {}): LabelContext {
  return {
    sessionsById: new Map(),
    practiceExamFolderId: null,
    homeworkDocIds: new Set(),
    folderNameById: new Map(),
    lemidaByDocId: new Map(),
    ...over,
  };
}

describe('labelDocument', () => {
  it('labels a deck on a session as its kind, with the session title', () => {
    const s = session({ id: 's1', kind: 'lecture', number: 2, title: 'SIMD' });
    const out = labelDocument(doc({ sessionId: 's1' }), ctx({ sessionsById: new Map([['s1', s]]) }));
    expect(out).toEqual({ type: 'lecture', session: { number: 2, title: 'Lecture 2 — SIMD' } });
  });

  it('labels a recitation deck', () => {
    const s = session({ id: 'r1', kind: 'recitation', number: 5, title: 'OpenMP' });
    const out = labelDocument(doc({ sessionId: 'r1' }), ctx({ sessionsById: new Map([['r1', s]]) }));
    expect(out).toEqual({ type: 'recitation', session: { number: 5, title: 'Recitation 5 — OpenMP' } });
  });

  it('labels a document in the practice-exams folder as exam', () => {
    const out = labelDocument(
      doc({ folderId: 'fx' }),
      ctx({ practiceExamFolderId: 'fx', folderNameById: new Map([['fx', 'Practice Exams']]) }),
    );
    expect(out).toEqual({ type: 'exam', folder: 'Practice Exams' });
  });

  it('labels an assignment sheet doc as homework', () => {
    const out = labelDocument(doc({ id: 'hw' }), ctx({ homeworkDocIds: new Set(['hw']) }));
    expect(out.type).toBe('homework');
  });

  it('labels a doc in a "Homework" folder as homework', () => {
    const out = labelDocument(
      doc({ folderId: 'fh' }),
      ctx({ folderNameById: new Map([['fh', 'Homework']]) }),
    );
    expect(out).toEqual({ type: 'homework', folder: 'Homework' });
  });

  it('labels a doc in "Course material" as book', () => {
    const out = labelDocument(
      doc({ folderId: 'fc' }),
      ctx({ folderNameById: new Map([['fc', 'Course material']]) }),
    );
    expect(out).toEqual({ type: 'book', folder: 'Course material' });
  });

  it('uses a confident Lemida label when placement is ambiguous', () => {
    const out = labelDocument(doc({ id: 'x' }), ctx({ lemidaByDocId: new Map([['x', 'lecture']]) }));
    expect(out.type).toBe('lecture');
  });

  it('ignores an unknown/other Lemida label and falls through', () => {
    const paper = labelDocument(
      doc({ id: 'x', arxivId: '2501.00001' }),
      ctx({ lemidaByDocId: new Map([['x', 'unknown']]) }),
    );
    expect(paper.type).toBe('paper');
    const other = labelDocument(doc({ id: 'y' }), ctx({ lemidaByDocId: new Map([['y', 'other']]) }));
    expect(other.type).toBe('other');
  });

  it('lets session placement win over a conflicting Lemida label', () => {
    const s = session({ id: 's9', kind: 'recitation', number: 1, title: '' });
    const out = labelDocument(
      doc({ sessionId: 's9', id: 'z' }),
      ctx({ sessionsById: new Map([['s9', s]]), lemidaByDocId: new Map([['z', 'homework']]) }),
    );
    expect(out.type).toBe('recitation');
  });

  it('labels arxiv/doi/sourceUrl as paper, else other', () => {
    expect(labelDocument(doc({ doi: '10.1/x' }), ctx()).type).toBe('paper');
    expect(labelDocument(doc(), ctx()).type).toBe('other');
  });
});
