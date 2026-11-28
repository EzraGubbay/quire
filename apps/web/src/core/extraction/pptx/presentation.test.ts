// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { slideXml, tinyPptx, zipBytes } from '@/lib/testing/tiny-pptx';
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
    const docx = zipBytes({ 'word/document.xml': '<w:document/>', '[Content_Types].xml': '<Types/>' });
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

  it('reads hidden state without parsing slides, and parses a slide only on demand', () => {
    const bad = tinyPptx([{}, {}], { extra: { 'ppt/slides/slide2.xml': '<p:sld><p:cSld>' } });
    const pkg = openPptx(bad);
    expect(pkg.slides).toHaveLength(2);
    const err = codeOf(() => pkg.part('ppt/slides/slide2.xml'));
    expect(err?.code).toBe('malformed_xml');
    expect(err?.part).toBe('ppt/slides/slide2.xml');
  });

  it('rejects a slide whose root is not p:sld', () => {
    const odd = '<x:sld xmlns:x="http://schemas.openxmlformats.org/presentationml/2006/main"/>';
    expect(codeOf(() => openPptx(tinyPptx([{ xml: odd }])))?.code).toBe('unsupported');
  });

  it('release drops a cached part so it is parsed again', () => {
    const pkg = openPptx(tinyPptx([{}]));
    const first = pkg.part('ppt/slides/slide1.xml');
    pkg.release('ppt/slides/slide1.xml');
    expect(pkg.part('ppt/slides/slide1.xml')).not.toBe(first);
  });

  it('skips a relationship that escapes the package instead of failing the deck', () => {
    const rels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://x/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rIdM" Type="http://x/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      '<Relationship Id="rIdBad" Type="http://x/image" Target="../../../outside.png"/></Relationships>';
    const pkg = openPptx(tinyPptx([{}], { extra: { 'ppt/_rels/presentation.xml.rels': rels } }));
    expect(pkg.slides).toHaveLength(1);
    expect(pkg.rels('ppt/presentation.xml').has('rIdBad')).toBe(false);
  });
});
