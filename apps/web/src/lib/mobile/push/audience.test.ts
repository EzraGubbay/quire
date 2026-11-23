// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { type AudienceDeps, audienceForCourse } from './audience';

const deps = (project: { kind: string; status: string } | null): AudienceDeps => ({
  project: vi.fn(async () => project),
  registeredOwners: vi.fn(async () => ['local', 'other']),
});

describe('audienceForCourse', () => {
  it('an active course reaches every owner with an active registration', async () => {
    expect(await audienceForCourse('p', deps({ kind: 'course', status: 'active' }))).toEqual([
      'local',
      'other',
    ]);
  });

  it.each([
    ['an archived course', { kind: 'course', status: 'archived' }],
    ['a research project', { kind: 'research', status: 'active' }],
    ['an unknown project', null],
  ])('%s reaches nobody', async (_, project) => {
    const d = deps(project);
    expect(await audienceForCourse('p', d)).toEqual([]);
    expect(d.registeredOwners).not.toHaveBeenCalled();
  });
});
