import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/db/schema';
import { type ProjectLookup, resolveProject } from './resolve';

const course = { id: '22222222-2222-4222-8222-222222222222', slug: 'algo', kind: 'course' } as Project;
const research = { id: '11111111-1111-4111-8111-111111111111', slug: 'kairos', kind: 'research' } as Project;
const all = [course, research];

function fakeLookup() {
  const byId = vi.fn(async (id: string) => all.find((p) => p.id === id));
  const bySlug = vi.fn(async (slug: string) => all.find((p) => p.slug === slug));
  const lookup: ProjectLookup = { byId, bySlug };
  return { lookup, byId, bySlug };
}

describe('resolveProject', () => {
  it('resolves a slug through bySlug only', async () => {
    const { lookup, byId, bySlug } = fakeLookup();
    expect(await resolveProject(lookup, 'course', 'algo')).toBe(course);
    expect(await resolveProject(lookup, 'research', 'kairos')).toBe(research);
    expect(bySlug).toHaveBeenCalledTimes(2);
    expect(byId).not.toHaveBeenCalled();
  });

  it('resolves a lower-case UUID through byId only', async () => {
    const { lookup, byId, bySlug } = fakeLookup();
    expect(await resolveProject(lookup, 'course', course.id)).toBe(course);
    expect(byId).toHaveBeenCalledWith(course.id);
    expect(bySlug).not.toHaveBeenCalled();
  });

  it('passes an upper-case UUID to byId unchanged', async () => {
    const byId = vi.fn(async () => course);
    const upper = course.id.toUpperCase();
    expect(await resolveProject({ byId, bySlug: vi.fn() }, 'course', upper)).toBe(course);
    expect(byId).toHaveBeenCalledWith(upper);
  });

  it('answers undefined for the other kind, by slug and by UUID, in both directions', async () => {
    const { lookup } = fakeLookup();
    expect(await resolveProject(lookup, 'course', 'kairos')).toBeUndefined();
    expect(await resolveProject(lookup, 'course', research.id)).toBeUndefined();
    expect(await resolveProject(lookup, 'research', 'algo')).toBeUndefined();
    expect(await resolveProject(lookup, 'research', course.id)).toBeUndefined();
  });

  it('answers undefined for an unknown reference', async () => {
    const { lookup } = fakeLookup();
    expect(await resolveProject(lookup, 'course', 'nope')).toBeUndefined();
    expect(await resolveProject(lookup, 'course', '99999999-9999-4999-8999-999999999999')).toBeUndefined();
  });

  it.each([
    ['one hex digit short', '2222222-2222-4222-8222-222222222222'],
    ['a non-hex digit', '2222222g-2222-4222-8222-222222222222'],
    ['braces', `{${course.id}}`],
    ['a trailing newline', `${course.id}\n`],
    ['empty', ''],
  ])('looks up a malformed id (%s) as a slug, never by id', async (_name, ref) => {
    const { lookup, byId, bySlug } = fakeLookup();
    expect(await resolveProject(lookup, 'course', ref)).toBeUndefined();
    expect(bySlug).toHaveBeenCalledWith(ref);
    expect(byId).not.toHaveBeenCalled();
  });

  it('does not fold the case of a slug', async () => {
    const { lookup, bySlug } = fakeLookup();
    expect(await resolveProject(lookup, 'course', 'Algo')).toBeUndefined();
    expect(bySlug).toHaveBeenCalledWith('Algo');
  });

  it('propagates a lookup failure', async () => {
    const lookup: ProjectLookup = {
      byId: vi.fn(),
      bySlug: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(resolveProject(lookup, 'course', 'algo')).rejects.toThrow('db down');
  });
});
