import NextLink from 'next/link';
import type { CourseIntegritySummary } from '@/lib/session-integrity';
import s from './settings.module.css';

/** Per-course totals from the Session check, linking to each course's panel. Read-only. */
export function SessionCheckSummary({ courses }: { courses: CourseIntegritySummary[] }) {
  const withIssues = courses.filter((c) => c.problems + c.notices > 0);
  const clean = courses.length - withIssues.length;
  return (
    <section className={s.section} data-testid="session-check-summary">
      <h2 className={s.h2}>Session check</h2>
      <p className={s.help}>
        Per course: problems (duplicate numbers, names or titles that point at another session, decks without
        a session) and notices (empty sessions). Open a course to see the evidence.
      </p>
      {withIssues.length === 0 ? (
        <p className={s.help} data-testid="session-check-summary-empty">
          No issues found in {courses.length} {courses.length === 1 ? 'course' : 'courses'}.
        </p>
      ) : (
        <>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Course</th>
                <th>Problems</th>
                <th>Duplicates</th>
                <th>Notices</th>
              </tr>
            </thead>
            <tbody>
              {withIssues.map((c) => (
                <tr key={c.projectId} data-testid="session-check-course" data-slug={c.slug}>
                  <td>
                    <NextLink href={c.href}>{c.name}</NextLink>
                    {c.archived && ' (archived)'}
                  </td>
                  <td>{c.problems}</td>
                  <td>{c.duplicates}</td>
                  <td>{c.notices}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clean > 0 && (
            <p className={s.help}>
              {clean} other {clean === 1 ? 'course has' : 'courses have'} no issues.
            </p>
          )}
        </>
      )}
    </section>
  );
}
