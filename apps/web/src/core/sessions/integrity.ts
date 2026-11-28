/**
 * Session integrity report: finds sessions and decks whose numbers, file names or titles disagree.
 *
 * Pure on purpose: it lives in core, so it takes plain data for one course and imports nothing but
 * shared types and sibling core files. It never reads or writes anything.
 *
 * The name a document is checked by is `originalName ?? title` (`nameSource` says which). A PDF stores
 * no file name, so its title is the only name it has.
 *
 * Kinds, in report order:
 * - `duplicate_number`: two or more sessions share the same (kind, number).
 * - `file_number_mismatch`: an attached document whose name binds a number to a kind word and
 *   `checkAttach` says it does not match its own session.
 * - `title_from_other_file`: an attached document that carries a session title that is not its own.
 *   `other_session`: its title equals the displayed title of another session and not of its own.
 *   `own_session`: its title equals its own session's displayed title, but its file name says
 *   something else and the session holds other documents, so the session title came from another file.
 * - `unnumbered_deck`: a PDF that is in no session although its name, or the Lemida import that filed it,
 *   says it is a lecture or recitation. It covers every unattached deck that names a session, numbered
 *   or not. Homework sheets, returned work and exams are never reported.
 * - `empty_session`: a session with no documents and no note text. Often fine (planned ahead), so
 *   it is a notice.
 *
 * Kinds are reported independently: one document can be both a mismatch and a title copy.
 */
import type { DocumentKind, SessionKind } from '@quire/shared';
import { checkAttach } from './attach';
import { parseSessionName } from './naming';

export const ANOMALY_KINDS = [
  'duplicate_number',
  'file_number_mismatch',
  'title_from_other_file',
  'unnumbered_deck',
  'empty_session',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export type AnomalySeverity = 'problem' | 'notice';

export interface IntegritySession {
  id: string;
  kind: SessionKind;
  number: number;
  title: string;
  /** "Lecture 2 — SIMD": how the app shows it, and what older code wrote into deck titles. */
  displayTitle: string;
  createdAt: Date;
  /** A note tied to this session has non-whitespace text. */
  hasNoteText: boolean;
}

export interface IntegrityDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  originalName: string | null;
  sessionId: string | null;
  /** Homework sheet or return, or practice exam: never reported as a deck without a session. */
  role?: 'assignment' | 'exam';
  /** Latest imported Lemida row that filed this document as a lecture or recitation. */
  lemida?: { kind: SessionKind; sectionTitle: string; fileName: string };
}

export interface IntegrityInput {
  sessions: IntegritySession[];
  documents: IntegrityDocument[];
}

export interface SessionRef {
  id: string;
  kind: SessionKind;
  number: number;
  title: string;
  displayTitle: string;
  documentCount: number;
  hasNoteText: boolean;
}

export interface DocumentRef {
  id: string;
  title: string;
  originalName: string | null;
  /** The name the checks read: originalName ?? title. */
  name: string;
  nameSource: 'file' | 'title';
}

export type SessionAnomaly =
  | {
      id: string;
      kind: 'duplicate_number';
      severity: 'problem';
      sessionKind: SessionKind;
      number: number;
      /** Oldest first. */
      sessions: SessionRef[];
    }
  | {
      id: string;
      kind: 'file_number_mismatch';
      severity: 'problem';
      document: DocumentRef;
      session: SessionRef;
      fileKind: SessionKind;
      fileNumber: number;
      /** Sessions matching the name's kind and number. */
      candidates: SessionRef[];
    }
  | {
      id: string;
      kind: 'title_from_other_file';
      severity: 'problem';
      variant: 'other_session' | 'own_session';
      document: DocumentRef;
      session: SessionRef;
      /** other_session: the sessions whose title the document carries; own_session: its own session. */
      sources: SessionRef[];
      /** own_session: the title its file name gives. */
      fileTitle?: string;
    }
  | {
      id: string;
      kind: 'unnumbered_deck';
      severity: AnomalySeverity;
      document: DocumentRef;
      signal: 'name' | 'lemida' | 'both';
      parsedKind: SessionKind;
      parsedNumber?: number;
      lemida?: { kind: SessionKind; sectionTitle: string };
      candidates: SessionRef[];
    }
  | { id: string; kind: 'empty_session'; severity: 'notice'; session: SessionRef };

export interface SessionIntegrityReport {
  anomalies: SessionAnomaly[];
  counts: Record<AnomalyKind, number>;
  problems: number;
  notices: number;
}

/** Case, spacing and Unicode-form insensitive; dashes stay exact. */
const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Code-point order, so the result never depends on the host locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const bySessionAge = (a: IntegritySession, b: IntegritySession): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || cmp(a.id, b.id);

const byTitleThenId = (a: { document: DocumentRef }, b: { document: DocumentRef }): number =>
  cmp(a.document.title, b.document.title) || cmp(a.document.id, b.document.id);

/** Pure: reads one course's sessions and documents, never the database. */
export function findSessionAnomalies(input: IntegrityInput): SessionIntegrityReport {
  const sessions = [...input.sessions].sort(bySessionAge);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const docCount = new Map<string, number>();
  for (const d of input.documents) {
    if (d.sessionId && sessionById.has(d.sessionId))
      docCount.set(d.sessionId, (docCount.get(d.sessionId) ?? 0) + 1);
  }

  const ref = (s: IntegritySession): SessionRef => ({
    id: s.id,
    kind: s.kind,
    number: s.number,
    title: s.title,
    displayTitle: s.displayTitle,
    documentCount: docCount.get(s.id) ?? 0,
    hasNoteText: s.hasNoteText,
  });
  const docRef = (d: IntegrityDocument): DocumentRef => ({
    id: d.id,
    title: d.title,
    originalName: d.originalName,
    name: d.originalName ?? d.title,
    nameSource: d.originalName === null ? 'title' : 'file',
  });
  const matching = (kind: SessionKind, number: number | undefined): SessionRef[] =>
    number === undefined ? [] : sessions.filter((s) => s.kind === kind && s.number === number).map(ref);

  const duplicates: SessionAnomaly[] = [];
  const mismatches: SessionAnomaly[] = [];
  const titles: SessionAnomaly[] = [];
  const unnumbered: SessionAnomaly[] = [];
  const empties: SessionAnomaly[] = [];

  // duplicate_number
  const groups = new Map<string, IntegritySession[]>();
  for (const s of sessions) {
    const key = `${s.kind}:${s.number}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [key, group] of groups) {
    const first = group[0];
    if (group.length < 2 || !first) continue;
    duplicates.push({
      id: `duplicate_number:${key}`,
      kind: 'duplicate_number',
      severity: 'problem',
      sessionKind: first.kind,
      number: first.number,
      sessions: group.map(ref),
    });
  }
  duplicates.sort((a, b) =>
    a.kind === 'duplicate_number' && b.kind === 'duplicate_number'
      ? cmp(a.sessionKind, b.sessionKind) || a.number - b.number
      : 0,
  );

  for (const d of input.documents) {
    const own = d.sessionId ? sessionById.get(d.sessionId) : undefined;
    const document = docRef(d);

    if (own) {
      // file_number_mismatch
      const check = checkAttach(own, document.name);
      if (!check.ok) {
        const fileKind = check.fileKind ?? own.kind;
        mismatches.push({
          id: `file_number_mismatch:${d.id}`,
          kind: 'file_number_mismatch',
          severity: 'problem',
          document,
          session: ref(own),
          fileKind,
          fileNumber: check.fileNumber,
          candidates: matching(fileKind, check.fileNumber),
        });
      }

      // title_from_other_file
      const docTitle = norm(d.title);
      const ownTitle = norm(own.displayTitle);
      if (docTitle !== ownTitle) {
        const sources = sessions.filter((s) => s.id !== own.id && norm(s.displayTitle) === docTitle);
        if (sources.length > 0) {
          titles.push({
            id: `title_from_other_file:${d.id}`,
            kind: 'title_from_other_file',
            severity: 'problem',
            variant: 'other_session',
            document,
            session: ref(own),
            sources: sources.map(ref),
          });
        }
      } else if (d.originalName !== null && (docCount.get(own.id) ?? 0) > 1) {
        const fileTitle = parseSessionName(d.originalName)?.title ?? '';
        if (fileTitle !== '' && norm(fileTitle) !== norm(own.title)) {
          titles.push({
            id: `title_from_other_file:${d.id}`,
            kind: 'title_from_other_file',
            severity: 'problem',
            variant: 'own_session',
            document,
            session: ref(own),
            sources: [ref(own)],
            fileTitle,
          });
        }
      }
      continue;
    }

    // unnumbered_deck: only a PDF that is in no session, and is not homework or an exam.
    if (d.sessionId !== null || d.kind !== 'pdf' || d.role) continue;
    const parsed = parseSessionName(document.name);
    if (!parsed && !d.lemida) continue;
    const signal = parsed && d.lemida ? 'both' : parsed ? 'name' : 'lemida';
    const parsedKind = parsed?.kind ?? d.lemida?.kind;
    if (!parsedKind) continue;
    const parsedNumber = parsed?.number;
    unnumbered.push({
      id: `unnumbered_deck:${d.id}`,
      kind: 'unnumbered_deck',
      severity: parsedNumber !== undefined || d.lemida ? 'problem' : 'notice',
      document,
      signal,
      parsedKind,
      ...(parsedNumber === undefined ? {} : { parsedNumber }),
      ...(d.lemida ? { lemida: { kind: d.lemida.kind, sectionTitle: d.lemida.sectionTitle } } : {}),
      candidates: matching(parsedKind, parsedNumber),
    });
  }
  for (const list of [mismatches, titles, unnumbered]) {
    list.sort((a, b) => ('document' in a && 'document' in b ? byTitleThenId(a, b) : 0));
  }

  // empty_session
  for (const s of sessions) {
    if ((docCount.get(s.id) ?? 0) === 0 && !s.hasNoteText) {
      empties.push({
        id: `empty_session:${s.id}`,
        kind: 'empty_session',
        severity: 'notice',
        session: ref(s),
      });
    }
  }
  // `sessions` is already oldest first; a stable sort by (kind, number) finishes the order.
  empties.sort((a, b) =>
    a.kind === 'empty_session' && b.kind === 'empty_session'
      ? cmp(a.session.kind, b.session.kind) || a.session.number - b.session.number
      : 0,
  );

  const anomalies = [...duplicates, ...mismatches, ...titles, ...unnumbered, ...empties];
  const counts = Object.fromEntries(ANOMALY_KINDS.map((k) => [k, 0])) as Record<AnomalyKind, number>;
  for (const a of anomalies) counts[a.kind] += 1;
  const problems = anomalies.filter((a) => a.severity === 'problem').length;
  return { anomalies, counts, problems, notices: anomalies.length - problems };
}
