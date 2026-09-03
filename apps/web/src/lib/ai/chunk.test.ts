import { chunkText } from './chunk';
import { costFor } from './settings';

describe('chunkText', () => {
  it('keeps short text as one chunk and splits long text with overlap', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
    const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'lorem ipsum '.repeat(30)}`).join(
      '\n\n',
    );
    const chunks = chunkText(paras, 200, 20);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200 * 4 * 1.5 + 200);
    expect(chunks[1]?.startsWith(chunks[0]?.slice(-40) ?? '')).toBe(false);
    expect(chunks.join(' ')).toContain('Paragraph 39');
  });
  it('returns nothing for blank input', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
  });
});

describe('costFor', () => {
  const prices = { 'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 } };
  it('prices uncached, cached, and output tokens per million', () => {
    expect(costFor(prices, 'gpt-5.6-sol', { input: 1_000_000, cached: 0, output: 0 })).toBeCloseTo(4);
    expect(
      costFor(prices, 'gpt-5.6-sol', { input: 1_000_000, cached: 500_000, output: 100_000 }),
    ).toBeCloseTo(2 + 0.2 + 2);
    expect(costFor(prices, 'gpt-5.6-sol-2026-09', { input: 1_000_000, cached: 0, output: 0 })).toBeCloseTo(4);
    expect(costFor(prices, 'unknown', { input: 1_000_000, cached: 0, output: 0 })).toBe(0);
  });
});
