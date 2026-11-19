import { describe, expect, it } from 'vitest';
import type { Note as NoteRow } from '@/db/schema';
import { toNote, toNoteSummary } from './notes';
import { Note, NoteSummary } from './schema';

const row = {
  id: '0d6f6c3e-4f5a-4b0b-8f0e-9a6b1d2c3e4f',
  projectId: 'p1',
  title: 'Lecture 3 notes',
  slug: 'lecture-3-notes',
  body: 'See [[Lecture 2]] and $e^{i\\pi}+1=0$.\n',
  tags: [],
  folderId: null,
  sessionId: null,
  status: 'ready',
  error: null,
  createdAt: new Date('2026-11-01T08:00:00Z'),
  updatedAt: new Date('2026-11-02T12:00:00Z'),
} as NoteRow;

describe('toNoteSummary', () => {
  it('maps metadata and omits folder/session when absent', () => {
    const s = toNoteSummary(row);
    expect(s).toEqual({
      id: row.id,
      slug: 'lecture-3-notes',
      title: 'Lecture 3 notes',
      updatedAt: '2026-11-02T12:00:00.000Z',
    });
    expect('folder' in s).toBe(false);
    expect('session' in s).toBe(false);
    expect(NoteSummary.safeParse(s).success).toBe(true);
  });

  it('includes folder name and session kind/number when given', () => {
    const s = toNoteSummary(row, { folder: 'Week 3', session: { kind: 'lecture', number: 3 } });
    expect(s.folder).toBe('Week 3');
    expect(s.session).toEqual({ kind: 'lecture', number: 3 });
    expect(NoteSummary.safeParse(s).success).toBe(true);
  });

  it('does not leak internal fields', () => {
    expect(Object.keys(toNoteSummary(row)).sort()).toEqual(['id', 'slug', 'title', 'updatedAt']);
  });
});

describe('toNote', () => {
  it('adds the raw markdown with wiki-links and LaTeX untouched', () => {
    const n = toNote(row);
    expect(n.markdown).toBe(row.body);
    expect(n.markdown).toContain('[[Lecture 2]]');
    expect(n.markdown).toContain('$e^{i\\pi}+1=0$');
    expect(Note.safeParse(n).success).toBe(true);
  });
});
