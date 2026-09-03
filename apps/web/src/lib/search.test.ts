import { excerpt } from './search';

describe('excerpt', () => {
  it('windows around the first match', () => {
    const text = `${'a '.repeat(100)}needle in the haystack ${'b '.repeat(100)}`;
    const out = excerpt(text, 'needle', 60);
    expect(out).toContain('needle');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(64);
  });
  it('falls back to the head when there is no match', () => {
    expect(excerpt('short text', 'zzz')).toBe('short text');
  });
});
