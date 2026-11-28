import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CourseIntegritySummary } from '@/lib/session-integrity';
import { SessionCheckSummary } from './session-check-summary';

const course = (slug: string, over: Partial<CourseIntegritySummary> = {}): CourseIntegritySummary => ({
  projectId: slug,
  slug,
  name: `Course ${slug}`,
  archived: false,
  href: `/c/${slug}/settings#session-check`,
  problems: 0,
  notices: 0,
  duplicates: 0,
  ...over,
});

describe('SessionCheckSummary', () => {
  it('says so when every course is clean', () => {
    render(<SessionCheckSummary courses={[course('a'), course('b')]} />);
    expect(screen.getByTestId('session-check-summary-empty').textContent).toBe(
      'No issues found in 2 courses.',
    );
    expect(screen.queryAllByTestId('session-check-course')).toEqual([]);
  });

  it('lists only courses with issues, links them, and tags archived ones', () => {
    render(
      <SessionCheckSummary
        courses={[
          course('a', { problems: 3, duplicates: 1, notices: 2 }),
          course('b', { notices: 1, archived: true }),
          course('c'),
        ]}
      />,
    );
    const rows = screen.getAllByTestId('session-check-course');
    expect(rows.map((r) => r.getAttribute('data-slug'))).toEqual(['a', 'b']);
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/c/a/settings#session-check');
    expect(rows[0]?.textContent).toBe('Course a312');
    expect(rows[1]?.textContent).toContain('Course b (archived)');
    expect(screen.getByTestId('session-check-summary').textContent).toContain(
      '1 other course has no issues.',
    );
  });
});
