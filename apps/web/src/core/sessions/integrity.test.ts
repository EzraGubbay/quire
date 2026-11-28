import { describe, expect, it } from 'vitest';
import {
  ANOMALY_KINDS,
  findSessionAnomalies,
  type IntegrityDocument,
  type IntegritySession,
  type SessionAnomaly,
} from './integrity';

let n = 0;
function ses(p: Partial<IntegritySession> & Pick<IntegritySession, 'id' | 'number'>): IntegritySession {
  const kind = p.kind ?? 'lecture';
  const title = p.title ?? '';
  const label = kind === 'lecture' ? 'Lecture' : 'Recitation';
  n += 1;
  return {
    kind,
    title,
    displayTitle: `${label} ${p.number}${title ? ` — ${title}` : ''}`,
    createdAt: new Date(2026, 0, 1, 0, 0, n),
    hasNoteText: false,
    ...p,
  };
}
function doc(p: Partial<IntegrityDocument> & Pick<IntegrityDocument, 'id'>): IntegrityDocument {
  return { kind: 'pdf', title: p.id, originalName: null, sessionId: null, ...p };
}
const kinds = (list: SessionAnomaly[]) => list.map((a) => a.kind);
const ofKind = <K extends SessionAnomaly['kind']>(list: SessionAnomaly[], k: K) =>
  list.filter((a): a is Extract<SessionAnomaly, { kind: K }> => a.kind === k);

describe('findSessionAnomalies', () => {
  it('reports nothing for a clean course', () => {
    const r = findSessionAnomalies({
      sessions: [ses({ id: 'L1', number: 1, title: 'Threads', hasNoteText: true })],
      documents: [
        doc({
          id: 'a',
          title: 'Lecture 1 — Threads',
          originalName: 'Lecture 1 - Threads.pptx',
          sessionId: 'L1',
        }),
      ],
    });
    expect(r.anomalies).toEqual([]);
    expect(Object.values(r.counts).every((c) => c === 0)).toBe(true);
    expect(r.problems + r.notices).toBe(0);
  });

  describe('duplicate_number', () => {
    const has = { hasNoteText: true };
    it('groups two sessions oldest first', () => {
      const a = ses({ id: 'x2', number: 3, ...has });
      const b = ses({ id: 'x1', number: 3, ...has });
      const r = findSessionAnomalies({ sessions: [b, a], documents: [] });
      const [d] = ofKind(r.anomalies, 'duplicate_number');
      expect(r.counts.duplicate_number).toBe(1);
      expect(d?.id).toBe('duplicate_number:lecture:3');
      expect(d?.sessions.map((s) => s.id)).toEqual(['x2', 'x1']);
    });
    it('ignores a lecture and a recitation with the same number', () => {
      const r = findSessionAnomalies({
        sessions: [
          ses({ id: 'a', number: 3, ...has }),
          ses({ id: 'b', number: 3, kind: 'recitation', ...has }),
        ],
        documents: [],
      });
      expect(r.counts.duplicate_number).toBe(0);
    });
    it('keeps three sessions in one anomaly', () => {
      const r = findSessionAnomalies({
        sessions: ['a', 'b', 'c'].map((id) => ses({ id, number: 3, ...has })),
        documents: [],
      });
      expect(ofKind(r.anomalies, 'duplicate_number')).toHaveLength(1);
      expect(ofKind(r.anomalies, 'duplicate_number')[0]?.sessions).toHaveLength(3);
    });
  });

  describe('file_number_mismatch', () => {
    const base = [ses({ id: 'L3', number: 3, title: 'Locks' }), ses({ id: 'L5', number: 5, title: 'Other' })];
    it('flags a file name for another number, with candidates', () => {
      const r = findSessionAnomalies({
        sessions: base,
        documents: [
          doc({ id: 'd', originalName: 'Lecture 3 - Locks.pptx', title: 'Locks', sessionId: 'L5' }),
        ],
      });
      const [m] = ofKind(r.anomalies, 'file_number_mismatch');
      expect(m).toMatchObject({ id: 'file_number_mismatch:d', fileNumber: 3, fileKind: 'lecture' });
      expect(m?.document.nameSource).toBe('file');
      expect(m?.candidates.map((c) => c.id)).toEqual(['L3']);
    });
    it('reads the title when there is no file name', () => {
      const r = findSessionAnomalies({
        sessions: base,
        documents: [doc({ id: 'd', title: 'Lecture 3 — Sync', sessionId: 'L5' })],
      });
      expect(ofKind(r.anomalies, 'file_number_mismatch')[0]?.document.nameSource).toBe('title');
    });
    it('flags a different kind', () => {
      const r = findSessionAnomalies({
        sessions: [ses({ id: 'L3', number: 3 })],
        documents: [doc({ id: 'd', originalName: 'Recitation 3.pdf', sessionId: 'L3' })],
      });
      expect(ofKind(r.anomalies, 'file_number_mismatch')[0]?.fileKind).toBe('recitation');
    });
    it.each(['07 Memory models.pdf', 'Course overview.pdf'])(
      'ignores %s (no bound number)',
      (originalName) => {
        const r = findSessionAnomalies({
          sessions: base,
          documents: [doc({ id: 'd', originalName, sessionId: 'L5' })],
        });
        expect(r.counts.file_number_mismatch).toBe(0);
      },
    );
  });

  describe('title_from_other_file', () => {
    const sync = ses({ id: 'L3', number: 3, title: 'Sync' });
    it('flags a title that belongs to another session', () => {
      const r = findSessionAnomalies({
        sessions: [sync, ses({ id: 'L5', number: 5, title: 'Other' })],
        documents: [doc({ id: 'd', title: 'Lecture 3 — Sync', sessionId: 'L5' })],
      });
      const [t] = ofKind(r.anomalies, 'title_from_other_file');
      expect(t).toMatchObject({ variant: 'other_session', id: 'title_from_other_file:d' });
      expect(t?.sources.map((s) => s.id)).toEqual(['L3']);
    });
    it('does not flag twins with equal titles', () => {
      const r = findSessionAnomalies({
        sessions: [sync, ses({ id: 'L3b', number: 3, title: 'Sync' })],
        documents: [doc({ id: 'd', title: 'Lecture 3 — Sync', sessionId: 'L3b' })],
      });
      expect(r.counts.title_from_other_file).toBe(0);
    });
    it('does not flag an unattached document', () => {
      const r = findSessionAnomalies({
        sessions: [sync],
        documents: [doc({ id: 'd', title: 'Lecture 3 — Sync' })],
      });
      expect(r.counts.title_from_other_file).toBe(0);
    });
    it('matches despite case and spacing', () => {
      const r = findSessionAnomalies({
        sessions: [sync, ses({ id: 'L5', number: 5 })],
        documents: [doc({ id: 'd', title: '  lecture 3  —   SYNC ', sessionId: 'L5' })],
      });
      expect(r.counts.title_from_other_file).toBe(1);
    });
    it('flags only the file whose name disagrees with the session title', () => {
      const L4 = ses({ id: 'L4', number: 4, title: 'Paging' });
      const docs = [
        doc({
          id: 'c1',
          title: 'Lecture 4 — Paging',
          originalName: 'Lecture 4 - Paging.pptx',
          sessionId: 'L4',
        }),
        doc({ id: 'c2', title: 'Lecture 4 — Paging', originalName: 'Lecture 4 - TLB.pptx', sessionId: 'L4' }),
      ];
      const r = findSessionAnomalies({ sessions: [L4], documents: docs });
      const found = ofKind(r.anomalies, 'title_from_other_file');
      expect(found.map((t) => t.document.id)).toEqual(['c2']);
      expect(found[0]).toMatchObject({ variant: 'own_session', fileTitle: 'TLB' });
      const alone = findSessionAnomalies({ sessions: [L4], documents: docs.slice(1) });
      expect(alone.counts.title_from_other_file).toBe(0);
    });
  });

  describe('unnumbered_deck', () => {
    const R2 = ses({ id: 'R2', number: 2, kind: 'recitation', hasNoteText: true });
    it('flags a named deck as a problem with candidates', () => {
      const r = findSessionAnomalies({
        sessions: [R2],
        documents: [doc({ id: 'd', title: 'Recitation 2 - Graphs' })],
      });
      const [u] = ofKind(r.anomalies, 'unnumbered_deck');
      expect(u).toMatchObject({
        signal: 'name',
        parsedKind: 'recitation',
        parsedNumber: 2,
        severity: 'problem',
      });
      expect(u?.candidates.map((c) => c.id)).toEqual(['R2']);
    });
    it('flags a deck only Lemida filed', () => {
      const r = findSessionAnomalies({
        sessions: [],
        documents: [
          doc({
            id: 'd',
            title: 'Course overview',
            lemida: { kind: 'lecture', sectionTitle: 'הרצאות', fileName: 'x.pdf' },
          }),
        ],
      });
      const [u] = ofKind(r.anomalies, 'unnumbered_deck');
      expect(u).toMatchObject({ signal: 'lemida', parsedKind: 'lecture', severity: 'problem' });
      expect(u?.parsedNumber).toBeUndefined();
    });
    it('makes a name with no number and no Lemida a notice', () => {
      const r = findSessionAnomalies({
        sessions: [],
        documents: [doc({ id: 'd', title: 'Lecture notes summary' })],
      });
      expect(ofKind(r.anomalies, 'unnumbered_deck')[0]).toMatchObject({ severity: 'notice', signal: 'name' });
      expect(r.notices).toBe(1);
    });
    it('reports both signals', () => {
      const r = findSessionAnomalies({
        sessions: [],
        documents: [
          doc({
            id: 'd',
            title: 'Lecture 4',
            lemida: { kind: 'lecture', sectionTitle: 's', fileName: 'x.pdf' },
          }),
        ],
      });
      expect(ofKind(r.anomalies, 'unnumbered_deck')[0]?.signal).toBe('both');
    });
    it.each([
      ['assignment', doc({ id: 'd', title: 'Lecture 9 - sheet', role: 'assignment' })],
      ['exam', doc({ id: 'd', title: 'Lecture 8 - exam', role: 'exam' })],
      ['markdown', doc({ id: 'd', title: 'Lecture 7 - notes', kind: 'markdown' })],
      ['no signal', doc({ id: 'd', title: 'Misc handout' })],
    ])('excludes %s', (_label, d) => {
      expect(findSessionAnomalies({ sessions: [], documents: [d] }).counts.unnumbered_deck).toBe(0);
    });
  });

  describe('empty_session', () => {
    it('flags no docs and no note', () => {
      const r = findSessionAnomalies({ sessions: [ses({ id: 'a', number: 1 })], documents: [] });
      expect(ofKind(r.anomalies, 'empty_session')[0]).toMatchObject({
        id: 'empty_session:a',
        severity: 'notice',
      });
    });
    it('does not flag a session with note text', () => {
      const r = findSessionAnomalies({
        sessions: [ses({ id: 'a', number: 1, hasNoteText: true })],
        documents: [],
      });
      expect(r.counts.empty_session).toBe(0);
    });
    it('does not flag a session with a doc but no note', () => {
      const r = findSessionAnomalies({
        sessions: [ses({ id: 'a', number: 1 })],
        documents: [doc({ id: 'd', sessionId: 'a' })],
      });
      expect(r.counts.empty_session).toBe(0);
    });
  });

  describe('combos and invariants', () => {
    const e2e = (): { sessions: IntegritySession[]; documents: IntegrityDocument[] } => ({
      sessions: [
        ses({ id: 'L1', number: 1, title: 'sample' }),
        ses({ id: 'L1b', number: 1 }),
        ses({ id: 'L5', number: 5 }),
      ],
      documents: [doc({ id: 'p', title: 'Lecture 1 — sample', sessionId: 'L5' })],
    });
    it('reports a moved deck in several groups', () => {
      const r = findSessionAnomalies(e2e());
      expect(r.counts).toEqual({
        duplicate_number: 1,
        file_number_mismatch: 1,
        title_from_other_file: 1,
        unnumbered_deck: 0,
        empty_session: 2,
      });
      expect([r.problems, r.notices]).toEqual([3, 2]);
    });
    it('reports a duplicate twin that is also empty', () => {
      const r = findSessionAnomalies({
        sessions: [ses({ id: 'a', number: 2, hasNoteText: true }), ses({ id: 'b', number: 2 })],
        documents: [],
      });
      expect(kinds(r.anomalies)).toEqual(['duplicate_number', 'empty_session']);
    });
    it('has unique ids and counts that agree with the list', () => {
      const input = e2e();
      input.documents.push(doc({ id: 'u', title: 'Recitation 2 - Graphs' }));
      const r = findSessionAnomalies(input);
      const ids = r.anomalies.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const k of ANOMALY_KINDS) expect(r.counts[k]).toBe(r.anomalies.filter((a) => a.kind === k).length);
      expect(r.problems + r.notices).toBe(r.anomalies.length);
    });
    it('is deterministic under input order', () => {
      const input = e2e();
      input.documents.push(
        doc({ id: 'u', title: 'Recitation 2 - Graphs' }),
        doc({ id: 'v', title: 'Lecture 4 - Heaps' }),
      );
      const shuffled = { sessions: [...input.sessions].reverse(), documents: [...input.documents].reverse() };
      expect(findSessionAnomalies(shuffled)).toEqual(findSessionAnomalies(input));
    });
    it('sees through bidi marks written as escapes', () => {
      const r = findSessionAnomalies({
        sessions: [ses({ id: 'L3', number: 3 }), ses({ id: 'L5', number: 5 })],
        documents: [doc({ id: 'd', originalName: 'Lecture\u200f 3.pptx', sessionId: 'L5' })],
      });
      expect(ofKind(r.anomalies, 'file_number_mismatch')[0]?.candidates.map((c) => c.id)).toEqual(['L3']);
    });
  });
});
