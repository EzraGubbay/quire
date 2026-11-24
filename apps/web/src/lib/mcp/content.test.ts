import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/documents', () => ({ getDocument: vi.fn(), getDocumentPages: vi.fn() }));
vi.mock('@/lib/files', () => ({ readStoredFile: vi.fn() }));
vi.mock('@/lib/pdf', () => ({ extractPdf: vi.fn() }));
vi.mock('@/lib/slides', () => ({ renderPages: vi.fn() }));
vi.mock('./courses', () => ({ resolveCourse: vi.fn() }));

const { buildTextResult, formatRanges, parsePageSpec, SPARSE_CHARS } = await import('./content');

describe('parsePageSpec', () => {
  it('defaults to every page', () => {
    expect(parsePageSpec(undefined, 4)).toEqual([1, 2, 3, 4]);
    expect(parsePageSpec('  ', 2)).toEqual([1, 2]);
  });
  it('parses singles, ranges, lists and open ends, sorted and de-duplicated', () => {
    expect(parsePageSpec('3', 9)).toEqual([3]);
    expect(parsePageSpec('2-4', 9)).toEqual([2, 3, 4]);
    expect(parsePageSpec('7, 1-2 ,2', 9)).toEqual([1, 2, 7]);
    expect(parsePageSpec('8-', 9)).toEqual([8, 9]);
  });
  it('clamps to the document and rejects nonsense', () => {
    expect(parsePageSpec('4-99', 5)).toEqual([4, 5]);
    expect(() => parsePageSpec('9', 5)).toThrow(/5 page/);
    expect(() => parsePageSpec('0', 5)).toThrow(/Bad page range/);
    expect(() => parsePageSpec('5-2', 5)).toThrow(/Bad page range/);
    expect(() => parsePageSpec('one', 5)).toThrow(/Bad page range/);
  });
  it('returns nothing for an empty document', () => {
    expect(parsePageSpec(undefined, 0)).toEqual([]);
  });
});

describe('formatRanges', () => {
  it('compresses runs and round-trips through parsePageSpec', () => {
    const pages = [1, 2, 3, 7, 9, 10];
    expect(formatRanges(pages)).toBe('1-3,7,9-10');
    expect(parsePageSpec(formatRanges(pages), 10)).toEqual(pages);
    expect(formatRanges([])).toBe('');
  });
});

describe('buildTextResult', () => {
  const words = (n: number) => `${'lorem ipsum '.repeat(n)}`.trim();
  const base = { title: 'Project: Waze', courseName: 'Parallel Systems', pageCount: 5 };

  it('lays out every page with markers when it fits', () => {
    const r = buildTextResult({
      ...base,
      pageTexts: (n) => `text of page ${n} ${words(5)}`,
      wanted: [1, 2, 3, 4, 5],
    });
    expect(r.shown).toEqual([1, 2, 3, 4, 5]);
    expect(r.remaining).toEqual([]);
    expect(r.text).toContain('# Project: Waze');
    expect(r.text).toContain('5 pages · showing pages 1-5');
    for (const n of [1, 2, 3, 4, 5]) expect(r.text).toContain(`--- Page ${n} ---\ntext of page ${n}`);
    expect(r.text).not.toContain('More pages');
  });

  it('stops at the budget and says how to continue', () => {
    const r = buildTextResult({
      ...base,
      pageTexts: () => 'x'.repeat(400),
      wanted: [1, 2, 3, 4, 5],
      budget: 1000,
    });
    expect(r.shown).toEqual([1, 2]);
    expect(r.remaining).toEqual([3, 4, 5]);
    expect(r.text).toContain('pages="3-5"');
    expect(r.text.length).toBeLessThan(1300);
  });

  it('cuts a single page larger than the budget instead of returning nothing', () => {
    const r = buildTextResult({ ...base, pageTexts: () => 'y'.repeat(5000), wanted: [2, 3], budget: 1000 });
    expect(r.shown).toEqual([2]);
    expect(r.remaining).toEqual([3]);
    expect(r.text).toContain('page 2 cut at 1000 characters');
  });

  it('flags figure-only pages and points at get_page_images', () => {
    const texts: Record<number, string> = { 1: words(20), 2: '', 3: 'Fig. 1', 4: words(20) };
    const r = buildTextResult({
      ...base,
      pageCount: 4,
      pageTexts: (n) => texts[n] ?? '',
      wanted: [1, 2, 3, 4],
    });
    expect(r.sparse).toEqual([2, 3]);
    expect('Fig. 1'.length).toBeLessThan(SPARSE_CHARS);
    expect(r.text).toContain('--- Page 2 ---\n[no extractable text on this page]');
    expect(r.text).toContain('get_page_images with pages="2-3"');
  });

  it('keeps Hebrew text intact', () => {
    const r = buildTextResult({
      ...base,
      pageCount: 1,
      pageTexts: () => 'תרגיל 1: מערכות מקביליות — הגשה עד יום ראשון',
      wanted: [1],
    });
    expect(r.text).toContain('תרגיל 1: מערכות מקביליות');
  });
});
