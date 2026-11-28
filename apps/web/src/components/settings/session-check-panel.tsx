import NextLink from 'next/link';
import type { ReactNode } from 'react';
import {
  ANOMALY_KINDS,
  type AnomalyKind,
  type SessionAnomaly,
  type SessionIntegrityReport,
  type SessionRef,
} from '@/core/sessions/integrity';
import { SESSION_LABEL } from '@/lib/sessions';
import c from './session-check.module.css';
import s from './settings.module.css';

const GROUP_LABEL: Record<AnomalyKind, string> = {
  duplicate_number: 'Duplicate numbers',
  file_number_mismatch: 'Name points at another session',
  title_from_other_file: 'Title copied from another session',
  unnumbered_deck: 'Decks without a session',
  empty_session: 'Empty sessions',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Read-only report of sessions and decks whose numbers, file names or titles disagree. S4.4 adds the actions. */
export function SessionCheckPanel({ report, base }: { report: SessionIntegrityReport; base: string }) {
  const sessionHref = (r: SessionRef) =>
    `${base}/${r.kind === 'lecture' ? 'lectures' : 'recitations'}/${r.id}`;
  const sessionLink = (r: SessionRef) => <NextLink href={sessionHref(r)}>{r.displayTitle}</NextLink>;
  const sessionLinks = (list: SessionRef[]): ReactNode =>
    list.map((r, i) => (
      <span key={r.id}>
        {i > 0 && ', '}
        {sessionLink(r)}
      </span>
    ));
  const docLink = (id: string, text: string) => <NextLink href={`${base}/documents/${id}`}>{text}</NextLink>;
  const kindWord = (kind: SessionRef['kind'], number?: number) =>
    `${SESSION_LABEL[kind].one}${number === undefined ? '' : ` ${number}`}`;

  function evidence(a: SessionAnomaly): ReactNode {
    switch (a.kind) {
      case 'duplicate_number':
        return (
          <>
            {kindWord(a.sessionKind, a.number)} appears {a.sessions.length} times.
            <ul className={c.sub}>
              {a.sessions.map((r) => (
                <li key={r.id}>
                  {sessionLink(r)} · {plural(r.documentCount, 'file', 'files')} ·{' '}
                  {r.hasNoteText ? 'note' : 'no note'}
                </li>
              ))}
            </ul>
          </>
        );
      case 'file_number_mismatch':
        return (
          <>
            {a.document.nameSource === 'file' ? 'File' : 'Title'} "{docLink(a.document.id, a.document.name)}"
            names {kindWord(a.fileKind, a.fileNumber)}, but it is in {sessionLink(a.session)}.
            {a.candidates.length > 0 && (
              <>
                {' '}
                {kindWord(a.fileKind, a.fileNumber)}: {sessionLinks(a.candidates)}
              </>
            )}
          </>
        );
      case 'title_from_other_file':
        return a.variant === 'other_session' ? (
          <>
            "{docLink(a.document.id, a.document.title)}" is in {sessionLink(a.session)}, but that is the title
            of {sessionLinks(a.sources)}.
          </>
        ) : (
          <>
            "{docLink(a.document.id, a.document.title)}" carries its session's title; its file "
            {a.document.originalName}" says "{a.fileTitle}".
          </>
        );
      case 'unnumbered_deck':
        return (
          <>
            "{docLink(a.document.id, a.document.title)}" is not in any session.
            {a.signal !== 'lemida' && <> Its name says {kindWord(a.parsedKind, a.parsedNumber)}.</>}
            {a.lemida && (
              <>
                {' '}
                Lemida filed it as a {SESSION_LABEL[a.lemida.kind].one.toLowerCase()} (section "
                {a.lemida.sectionTitle}").
              </>
            )}
            {a.candidates.length > 0 && (
              <>
                {' '}
                {kindWord(a.parsedKind, a.parsedNumber)}: {sessionLinks(a.candidates)}
              </>
            )}
          </>
        );
      case 'empty_session':
        return <>{sessionLink(a.session)} has no files and no note text.</>;
    }
  }

  return (
    <section id="session-check" className={s.section} data-testid="session-check">
      <h2 className={s.h2}>Session check</h2>
      <p className={s.help}>
        Read-only. Lists sessions and decks whose numbers, file names or titles disagree. Nothing here changes
        your data.
      </p>
      {report.anomalies.length === 0 ? (
        <p className={s.help} data-testid="session-check-empty">
          No issues found.
        </p>
      ) : (
        <>
          <p className={c.counts} data-testid="session-check-counts">
            {plural(report.problems, 'problem', 'problems')} · {plural(report.notices, 'notice', 'notices')}
          </p>
          {ANOMALY_KINDS.map((kind) => {
            const items = report.anomalies.filter((a) => a.kind === kind);
            if (items.length === 0) return null;
            return (
              <div key={kind} className={c.group} data-testid="session-check-group" data-kind={kind}>
                <h3 className={s.h3}>
                  {GROUP_LABEL[kind]} ({items.length})
                </h3>
                {kind === 'empty_session' && (
                  <p className={s.help}>Often fine: a session planned ahead has no files yet.</p>
                )}
                <ul className={c.list}>
                  {items.map((a) => (
                    <li
                      key={a.id}
                      className={c.item}
                      data-testid="session-anomaly"
                      data-anomaly-id={a.id}
                      data-kind={a.kind}
                      data-severity={a.severity}
                    >
                      {evidence(a)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
