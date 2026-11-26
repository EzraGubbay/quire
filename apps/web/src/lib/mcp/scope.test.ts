import { afterEach, describe, expect, it, vi } from 'vitest';

const KID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const research = { id: KID, slug: 'kairos', name: 'KAIROS', kind: 'research' };
const course = { id: CID, slug: 'parallel', name: 'Parallel', kind: 'course' };
vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async (s: string) => [research, course].find((p) => p.slug === s)),
  getProjectById: vi.fn(async (id: string) => [research, course].find((p) => p.id === id)),
}));
const { COURSE_SCOPE, RESEARCH_SCOPE, resolveProjectIn, scopeOf } = await import('./scope');

afterEach(() => {
  delete process.env.MCP_WRITE_ENABLED;
  delete process.env.MCP_RESEARCH_WRITE_ENABLED;
});

describe('resolveProjectIn', () => {
  it('resolves a project of the scope kind by slug and by UUID', async () => {
    expect(await resolveProjectIn(COURSE_SCOPE, 'parallel')).toBe(course);
    expect(await resolveProjectIn(COURSE_SCOPE, CID)).toBe(course);
    expect(await resolveProjectIn(RESEARCH_SCOPE, 'kairos')).toBe(research);
    expect(await resolveProjectIn(RESEARCH_SCOPE, KID)).toBe(research);
  });
  it('refuses the other kind by slug and by UUID', async () => {
    expect(await resolveProjectIn(COURSE_SCOPE, 'kairos')).toBeUndefined();
    expect(await resolveProjectIn(COURSE_SCOPE, KID)).toBeUndefined();
    expect(await resolveProjectIn(RESEARCH_SCOPE, 'parallel')).toBeUndefined();
    expect(await resolveProjectIn(RESEARCH_SCOPE, CID)).toBeUndefined();
  });
  it('returns undefined for an unknown ref', async () => {
    expect(await resolveProjectIn(RESEARCH_SCOPE, 'nope')).toBeUndefined();
  });
  it('scopeOf maps kinds', () => {
    expect(scopeOf('course')).toBe(COURSE_SCOPE);
    expect(scopeOf('research')).toBe(RESEARCH_SCOPE);
  });
});

describe('writeEnabled flags are independent', () => {
  it('default on', () => {
    expect(COURSE_SCOPE.writeEnabled()).toBe(true);
    expect(RESEARCH_SCOPE.writeEnabled()).toBe(true);
  });
  it('MCP_WRITE_ENABLED=false only disables courses', () => {
    process.env.MCP_WRITE_ENABLED = 'false';
    expect(COURSE_SCOPE.writeEnabled()).toBe(false);
    expect(RESEARCH_SCOPE.writeEnabled()).toBe(true);
  });
  it('MCP_RESEARCH_WRITE_ENABLED=off only disables research', () => {
    process.env.MCP_RESEARCH_WRITE_ENABLED = 'off';
    expect(RESEARCH_SCOPE.writeEnabled()).toBe(false);
    expect(COURSE_SCOPE.writeEnabled()).toBe(true);
  });
});
