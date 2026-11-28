import { describe, expect, it } from 'vitest';
import {
  cleanPdfText,
  extractPdf,
  FIGURE_MIN_COVERAGE,
  hasPaintOps,
  imageCoverage,
  layoutItems,
  openPdfAnalyzer,
} from './pdf';
import { SAMPLE_TEXT, samplePdf } from './testing/sample-pdf';

describe('cleanPdfText', () => {
  it('strips NUL bytes that Postgres text cannot store', () => {
    expect(cleanPdfText('f (\u0000 I, Drive\u0000)')).toBe('f ( I, Drive)');
  });

  it('strips other C0/C1 control characters but keeps tab and newline', () => {
    expect(cleanPdfText('a\u0007b\u001Fc\u007Fd\u0085e')).toBe('abcde');
    expect(cleanPdfText('line1\ncol\tcol')).toBe('line1\ncol\tcol');
  });

  it('removes unpaired surrogates', () => {
    expect(cleanPdfText('x\uD800y')).toBe('xy');
    expect(cleanPdfText('x\uDC00y')).toBe('xy');
  });

  it('keeps valid surrogate pairs (astral characters)', () => {
    // U+1D538 MATHEMATICAL DOUBLE-STRUCK CAPITAL A and an emoji.
    expect(cleanPdfText('set \u{1D538} and \u{1F600}')).toBe('set \u{1D538} and \u{1F600}');
  });

  it('leaves ordinary math unicode untouched', () => {
    expect(cleanPdfText('Π = ⟨ P, A, I, G ⟩, S ⊆ C')).toBe('Π = ⟨ P, A, I, G ⟩, S ⊆ C');
  });
});

// A stand-in for pdfjs.OPS: only the identities matter to imageCoverage.
const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  paintImageXObject: 4,
  paintFormXObjectBegin: 5,
  paintFormXObjectEnd: 6,
  constructPath: 7,
  stroke: 8,
  fill: 9,
  endPath: 10,
  paintInlineImageXObject: 11,
  showText: 12,
};
const A4 = 595 * 842;
type Op = [fn: number, args?: unknown[]];
const coverage = (ops: Op[]) =>
  imageCoverage(
    ops.map(([fn]) => fn),
    ops.map(([, args]) => args ?? null),
    OPS,
    A4,
  );

describe('imageCoverage', () => {
  it('is 0 for a page of text and clip paths', () => {
    expect(
      coverage([[OPS.save], [OPS.constructPath, [OPS.endPath]], [OPS.showText, ['x']], [OPS.restore]]),
    ).toBe(0);
  });

  it('measures an image by the transform it is painted with', () => {
    const drawn = coverage([
      [OPS.save],
      [OPS.transform, [240, 0, 0, 180, 100, 300]],
      [OPS.paintImageXObject, ['img_p0_1', 724, 724]],
      [OPS.restore],
    ]);
    expect(drawn).toBeCloseTo((240 * 180) / A4, 10);
    expect(drawn).toBeGreaterThanOrEqual(FIGURE_MIN_COVERAGE);
  });

  it('follows nested transforms, restores and inline images', () => {
    const drawn = coverage([
      [OPS.transform, [0.5, 0, 0, 0.5, 0, 0]],
      [OPS.save],
      [OPS.transform, [200, 0, 0, 100, 0, 0]],
      [OPS.paintInlineImageXObject, [{}]],
      [OPS.restore],
      [OPS.save],
      [OPS.transform, [0, 40, -40, 0, 0, 0]],
      [OPS.paintImageXObject, ['img_p0_2', 10, 10]],
      [OPS.restore],
    ]);
    expect(drawn).toBeCloseTo((100 * 50 + 20 * 20) / A4, 10);
  });

  it('ignores an icon-sized image', () => {
    const drawn = coverage([
      [OPS.save],
      [OPS.transform, [24, 0, 0, 24, 40, 780]],
      [OPS.paintImageXObject, ['icon', 48, 48]],
      [OPS.restore],
    ]);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(FIGURE_MIN_COVERAGE);
  });

  it('counts a drawn form XObject (an included vector figure) but not a text-only or page-sized one', () => {
    const paths = Array.from({ length: 6 }, (): Op => [OPS.constructPath, [OPS.stroke]]);
    const figure = coverage([
      [
        OPS.paintFormXObjectBegin,
        [
          [1, 0, 0, 1, 100, 300],
          [0, 0, 300, 200],
        ],
      ],
      ...paths,
      [OPS.paintFormXObjectEnd],
    ]);
    expect(figure).toBeCloseTo((300 * 200) / A4, 10);
    const textBox = coverage([
      [OPS.paintFormXObjectBegin, [null, [0, 0, 300, 200]]],
      [OPS.showText, ['x']],
      [OPS.paintFormXObjectEnd],
    ]);
    expect(textBox).toBe(0);
    const wrapper = coverage([
      [OPS.paintFormXObjectBegin, [null, [0, 0, 595, 842]]],
      ...paths,
      [OPS.paintFormXObjectEnd],
    ]);
    expect(wrapper).toBe(0);
  });

  it('restores the transform after a form, and never exceeds the page', () => {
    const drawn = coverage([
      [
        OPS.paintFormXObjectBegin,
        [
          [10, 0, 0, 10, 0, 0],
          [0, 0, 1, 1],
        ],
      ],
      [OPS.paintFormXObjectEnd],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ['a', 1, 1]],
    ]);
    expect(drawn).toBeCloseTo(10000 / A4, 10);
    expect(
      coverage([
        [OPS.transform, [5000, 0, 0, 5000, 0, 0]],
        [OPS.paintImageXObject, ['a', 1, 1]],
      ]),
    ).toBe(1);
  });
});

describe('extraction through pdf.js (synthetic PDF: Hebrew TeX page, Hebrew Word page, math page, figure page)', () => {
  it('extractPdf returns every page in reading order with real word gaps', async () => {
    const pdf = await extractPdf(samplePdf());
    expect(pdf.pageCount).toBe(4);
    expect(pdf.pages).toEqual(SAMPLE_TEXT);
  });

  it('openPdfAnalyzer flags the pages that have an embedded image or heavy math', async () => {
    const analyzer = await openPdfAnalyzer(samplePdf(), 40);
    try {
      expect(analyzer.pageCount).toBe(4);
      const pages = [];
      for (let n = 1; n <= 4; n++) pages.push(await analyzer.page(n));
      expect(pages.map((p) => p.text)).toEqual(SAMPLE_TEXT);
      // Page 2 has text and an image. Page 4's image is not looked at: with under 40 characters the page is
      // already a figure page by its emptiness.
      expect(pages.map((p) => p.figure)).toEqual([false, true, false, false]);
      expect(pages.map((p) => p.math)).toEqual([false, false, true, false]);
    } finally {
      await analyzer.close();
    }
  });

  it('looks at the images of a short page when no minimum is given', async () => {
    const analyzer = await openPdfAnalyzer(samplePdf());
    try {
      expect((await analyzer.page(4)).figure).toBe(true);
    } finally {
      await analyzer.close();
    }
  });

  it('builds the same bytes every time', () => {
    expect(Buffer.from(samplePdf()).equals(Buffer.from(samplePdf()))).toBe(true);
  });
});

describe('layoutItems', () => {
  it('falls back to the plain join for a page of rotated text', () => {
    const rotated = (str: string, y: number, hasEOL: boolean) => ({
      str,
      dir: 'ltr',
      transform: [0, 10, -10, 0, 50, y],
      width: 20,
      fontName: 'f',
      hasEOL,
    });
    const items = [rotated('side', 100, false), rotated('ways', 130, true), rotated('text', 100, false)];
    expect(layoutItems(items).text).toBe('side ways\ntext');
  });

  it('strips characters Postgres cannot store', () => {
    const upright = (str: string, x: number) => ({
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, 700],
      width: str.length * 5,
      fontName: 'f',
      hasEOL: false,
    });
    expect(layoutItems([upright('f(\u0000x', 72), upright(')', 92)]).text).toBe('f(x)');
  });
});

describe('hasPaintOps', () => {
  const OPS2 = { ...OPS, beginText: 20, setFont: 21, endText: 22, shadingFill: 23 };
  const paints = (ops: Op[]) =>
    hasPaintOps(
      ops.map(([fn]) => fn),
      ops.map(([, args]) => args ?? null),
      OPS2,
    );

  it('is false for an empty list', () => {
    expect(paints([])).toBe(false);
  });

  it('is true for shown text', () => {
    expect(paints([[OPS2.beginText], [OPS2.setFont], [OPS2.showText, ['x']], [OPS2.endText]])).toBe(true);
  });

  it('is true for a filled path', () => {
    expect(paints([[OPS2.constructPath, [OPS2.fill]]])).toBe(true);
  });

  it('is false for a clip-only path', () => {
    expect(paints([[OPS2.save], [OPS2.constructPath, [OPS2.endPath]], [OPS2.restore]])).toBe(false);
  });

  it('is true for an image', () => {
    expect(paints([[OPS2.paintImageXObject]])).toBe(true);
  });
});
