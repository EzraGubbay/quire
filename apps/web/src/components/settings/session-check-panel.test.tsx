import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ANOMALY_KINDS,
  type SessionAnomaly,
  type SessionIntegrityReport,
  type SessionRef,
} from '@/core/sessions/integrity';
import { SessionCheckPanel } from './session-check-panel';

const ref = (id: string, kind: 'lecture' | 'recitation', number: number, title = ''): SessionRef => ({
  id,
  kind,
  number,
  title,
  displayTitle: `${kind === 'lecture' ? 'Lecture' : 'Recitation'} ${number}${title ? ` — ${title}` : ''}`,
  documentCount: 2,
  hasNoteText: true,
});
const doc = (id: string, title: string, originalName: string | null = null) => ({
  id,
  title,
  originalName,
  name: originalName ?? title,
  nameSource: originalName === null ? ('title' as const) : ('file' as const),
});
const L3 = ref('s3', 'lecture', 3, 'Sync');
const L5 = ref('s5', 'lecture', 5, 'Other');
const R2 = ref('r2', 'recitation', 2, 'Graphs');

const anomalies: SessionAnomaly[] = [
  {
    id: 'duplicate_number:lecture:3',
    kind: 'duplicate_number',
    severity: 'problem',
    sessionKind: 'lecture',
    number: 3,
    sessions: [L3, ref('s3b', 'lecture', 3)],
  },
  {
    id: 'file_number_mismatch:d1',
    kind: 'file_number_mismatch',
    severity: 'problem',
    document: doc('d1', 'Lecture 3 — Sync'),
    session: L5,
    fileKind: 'lecture',
    fileNumber: 3,
    candidates: [L3],
  },
  {
    id: 'title_from_other_file:d1',
    kind: 'title_from_other_file',
    severity: 'problem',
    variant: 'other_session',
    document: doc('d1', 'Lecture 3 — Sync'),
    session: L5,
    sources: [L3],
  },
  {
    id: 'unnumbered_deck:d2',
    kind: 'unnumbered_deck',
    severity: 'problem',
    document: doc('d2', 'Recitation 2 - Graphs'),
    signal: 'name',
    parsedKind: 'recitation',
    parsedNumber: 2,
    candidates: [R2],
  },
  { id: 'empty_session:s5', kind: 'empty_session', severity: 'notice', session: L5 },
];
const report = (list: SessionAnomaly[]): SessionIntegrityReport => ({
  anomalies: list,
  counts: Object.fromEntries(
    ANOMALY_KINDS.map((k) => [k, list.filter((a) => a.kind === k).length]),
  ) as SessionIntegrityReport['counts'],
  problems: list.filter((a) => a.severity === 'problem').length,
  notices: list.filter((a) => a.severity === 'notice').length,
});

describe('SessionCheckPanel', () => {
  it('says so when there is nothing to report', () => {
    render(<SessionCheckPanel report={report([])} base="/c/x" />);
    expect(screen.getByTestId('session-check-empty').textContent).toBe('No issues found.');
  });

  it('renders one group per kind, in report order, with an id on each item', () => {
    render(<SessionCheckPanel report={report(anomalies)} base="/c/x" />);
    const groups = screen.getAllByTestId('session-check-group');
    expect(groups.map((g) => g.getAttribute('data-kind'))).toEqual([...ANOMALY_KINDS]);
    expect(screen.getAllByTestId('session-anomaly').map((i) => i.getAttribute('data-anomaly-id'))).toEqual(
      anomalies.map((a) => a.id),
    );
    expect(screen.getByTestId('session-check-counts').textContent).toBe('4 problems · 1 notice');
  });

  it('words the mismatch and duplicate evidence', () => {
    render(<SessionCheckPanel report={report(anomalies)} base="/c/x" />);
    const items = screen.getAllByTestId('session-anomaly');
    expect(items[0]?.textContent).toContain('Lecture 3 appears 2 times.');
    expect(items[1]?.textContent).toBe(
      'Title "Lecture 3 — Sync" names Lecture 3, but it is in Lecture 5 — Other. Lecture 3: Lecture 3 — Sync',
    );
    expect(items[2]?.textContent).toBe(
      '"Lecture 3 — Sync" is in Lecture 5 — Other, but that is the title of Lecture 3 — Sync.',
    );
  });

  it('links sessions and documents under the base', () => {
    render(<SessionCheckPanel report={report(anomalies)} base="/c/x" />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/c/x/lectures/s3');
    expect(hrefs).toContain('/c/x/documents/d1');
    expect(hrefs).toContain('/c/x/recitations/r2');
  });

  it('has no buttons', () => {
    render(<SessionCheckPanel report={report(anomalies)} base="/c/x" />);
    expect(within(screen.getByTestId('session-check')).queryAllByRole('button')).toEqual([]);
  });
});
