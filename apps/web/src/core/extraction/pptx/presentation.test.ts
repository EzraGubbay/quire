// @vitest-environment node
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { para, slideXml, sp, tinyPptx } from '@/lib/testing/tiny-pptx';
import { PptxError } from './errors';
import { openPptx } from './presentation';

const three = [{}, {}, {}];
const codeOf = (fn: () => unknown): PptxError | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PptxError);
    return e as PptxError;
  }
  return undefined;
};

describe('openPptx', () => {
  it('P1 lists slides in order with pages and parts', () => {
    const pkg = openPptx(tinyPptx(three));
    expect(pkg.slides.map((s) => [s.index, s.page, s.part])).toEqual([
      [1, 1, 'ppt/slides/slide1.xml'],
      [2, 2, 'ppt/slides/slide2.xml'],
      [3, 3, 'ppt/slides/slide3.xml'],
    ]);
  });

  it('P2 follows sldIdLst, not file numbers', () => {
    const pkg = openPptx(tinyPptx(three, { order: [3, 1, 2] }));
    expect(pkg.slides.map((s) => s.part)).toEqual([
      'ppt/slides/slide3.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
    ]);
  });

  it('P3 marks hidden slides (show="0" and show="false") and numbers only visible pages', () => {
    const pkg = openPptx(tinyPptx([{}, { show: false }, {}]));
    expect(pkg.slides.map((s) => [s.hidden, s.page])).toEqual([
      [false, 1],
      [true, null],
      [false, 2],
    ]);
    expect([pkg.visibleCount, pkg.hiddenCount]).toEqual([2, 1]);
    const xml = slideXml([]).replace('<p:sld ', '<p:sld show="false" ');
    const pkg2 = openPptx(tinyPptx([{ xml }, {}]));
    expect(pkg2.slides.map((s) => s.hidden)).toEqual([true, false]);
    expect(pkg2.slides[1]?.page).toBe(1);
  });

  it('P4 reads the slide size, defaulting when absent', () => {
    expect(openPptx(tinyPptx([{}], { slideSize: { cx: 12192000, cy: 6858000 } })).slideSize).toEqual({
      cx: 12192000,
      cy: 6858000,
    });
    expect(openPptx(tinyPptx([{}], { slideSize: null })).slideSize).toEqual({ cx: 9144000, cy: 6858000 });
  });

  it('P5 resolves absolute targets', () => {
    const pkg = openPptx(tinyPptx(three, { absoluteTargets: true }));
    expect(pkg.slides.map((s) => s.part)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
    ]);
  });

  it('P6 reports a relationship to a part that is not in the zip', () => {
    const err = codeOf(() => openPptx(tinyPptx(three, { omit: ['ppt/slides/slide2.xml'] })));
    expect(err?.code).toBe('missing_part');
    expect(err?.part).toBe('ppt/slides/slide2.xml');
  });

  it('P7 rejects a zip that is not a presentation', () => {
    const docx = zipSync({
      'word/document.xml': strToU8('<w:document/>'),
      '[Content_Types].xml': strToU8('<Types/>'),
    });
    expect(codeOf(() => openPptx(docx))?.code).toBe('not_pptx');
  });

  it('P8 rejects non-canonical namespace prefixes', () => {
    const presentation =
      '<x:presentation xmlns:x="http://schemas.openxmlformats.org/presentationml/2006/main"/>';
    const err = codeOf(() => openPptx(tinyPptx([{}], { extra: { 'ppt/presentation.xml': presentation } })));
    expect(err?.code).toBe('unsupported');
  });

  it('P9 resolves relative rels, drops external ones and caches parts', () => {
    const pkg = openPptx(tinyPptx([{}]));
    const slide = pkg.slides[0];
    expect(slide).toBeDefined();
    const layout = pkg.relOfType('ppt/slides/slide1.xml', '/slideLayout');
    expect(layout?.target).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(pkg.relOfType('ppt/slideLayouts/slideLayout1.xml', '/slideMaster')?.target).toBe(
      'ppt/slideMasters/slideMaster1.xml',
    );
    expect([...pkg.rels('ppt/presentation.xml').values()].some((r) => r.target.includes('example'))).toBe(
      false,
    );
    expect(pkg.rels('ppt/slideMasters/slideMaster1.xml').size).toBe(0);
    expect(pkg.part('ppt/slides/slide1.xml')).toBe(pkg.part('ppt/slides/slide1.xml'));
    expect(codeOf(() => pkg.part('ppt/slides/nope.xml'))?.code).toBe('missing_part');
  });

  it('P10 accepts an empty slide list', () => {
    const pkg = openPptx(tinyPptx([]));
    expect(pkg.slides).toEqual([]);
    expect([pkg.visibleCount, pkg.hiddenCount]).toEqual([0, 0]);
  });

  it('validates every slide part up front', () => {
    const bad = tinyPptx([{}, {}], { extra: { 'ppt/slides/slide2.xml': '<p:sld><p:cSld>' } });
    const err = codeOf(() => openPptx(bad));
    expect(err?.code).toBe('malformed_xml');
    expect(err?.part).toBe('ppt/slides/slide2.xml');
  });
});
