// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EMU_PER_INCH as IN, para, run, sp, tinyPptx } from '@/lib/testing/tiny-pptx';
import { PptxError } from './errors';
import { PPTX_EXTRACTOR, PPTX_READER_VERSION, pptxSlides, readPptx } from './index';
import { openPptx, type PptxPackage, type SlideRef } from './presentation';
import { type LayoutCache, MAX_CACHED_LAYOUTS, readSlide } from './slide';
import type { XNode } from './xml';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const box = (x: number, y: number) => ({ x, y, cx: IN, cy: IN / 2 });
const bodyPh = (text: string) => sp([para(text)], { ph: { idx: 1 } });

/** Wraps a package so tests can see which parts were parsed, how many were live at once, and the first object. */
function track(pkg: PptxPackage) {
  const live = new Set<string>();
  const called: string[] = [];
  const first = new Map<string, XNode>();
  let max = 0;
  const wrapped: PptxPackage = {
    ...pkg,
    part(name) {
      const node = pkg.part(name);
      called.push(name);
      if (!first.has(name)) first.set(name, node);
      live.add(name);
      max = Math.max(max, live.size);
      return node;
    },
    release(name) {
      live.delete(name);
      pkg.release(name);
    },
  };
  return { wrapped, live, called, first, max: () => max };
}

describe('readPptx', () => {
  it('exports the extractor identity', () => {
    expect([PPTX_EXTRACTOR, PPTX_READER_VERSION]).toEqual(['pptx-v1', 1]);
  });

  it('I1 lists hidden slides with empty text and keeps page numbers', () => {
    const r = readPptx(
      tinyPptx([
        { shapes: [sp([para('one')], { box: box(0, 0) })] },
        { shapes: [sp([para('two')], { box: box(0, 0) })], show: false },
        { shapes: [sp([para('three')], { box: box(0, 0) })] },
      ]),
    );
    expect(r.slides).toHaveLength(3);
    const [, hidden, third] = r.slides;
    expect([hidden?.hidden, hidden?.page, hidden?.text]).toEqual([true, null, '']);
    expect([third?.page, third?.text]).toEqual([2, 'three']);
    expect([r.visibleCount, r.hiddenCount]).toEqual([2, 1]);
  });

  it('I2 joins title and body', () => {
    const r = readPptx(
      tinyPptx([
        {
          shapes: [
            sp([para('Body')], { box: box(0, 2 * IN) }),
            sp([para('Head')], { ph: { type: 'title' }, box: box(0, 5 * IN) }),
          ],
        },
      ]),
    );
    expect(r.slides[0]?.title).toBe('Head');
    expect(r.slides[0]?.text).toBe('Head\n\nBody');
  });

  it('I3 throws a typed error for a malformed visible slide', () => {
    const bytes = tinyPptx([{}, {}], { extra: { 'ppt/slides/slide2.xml': `<p:sld ${NS}><p:cSld>` } });
    try {
      readPptx(bytes);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PptxError);
      expect([(e as PptxError).code, (e as PptxError).part]).toEqual([
        'malformed_xml',
        'ppt/slides/slide2.xml',
      ]);
    }
  });

  it('I4 never parses a hidden slide, even a malformed one', () => {
    const bytes = tinyPptx([{}, {}], {
      extra: { 'ppt/slides/slide2.xml': `<p:sld ${NS} show="0"><<<garbage` },
    });
    expect(readPptx(bytes).slides[1]).toMatchObject({ hidden: true, text: '' });
    const t = track(openPptx(bytes));
    [...pptxSlides(t.wrapped)];
    expect(t.called).not.toContain('ppt/slides/slide2.xml');
  });

  it('I5 always has the five boolean flags', () => {
    const r = readPptx(tinyPptx([{}, { show: false }]));
    for (const s of r.slides) {
      expect(Object.keys(s.flags).sort()).toEqual(['chart', 'math', 'picture', 'smartArt', 'table']);
      expect(Object.values(s.flags).every((v) => typeof v === 'boolean')).toBe(true);
    }
  });

  it('I6 keeps at most two parsed parts alive and releases every slide', () => {
    const slides = Array.from({ length: 20 }, (_, i) => ({ shapes: [bodyPh(`s${i}`)] }));
    const t = track(openPptx(tinyPptx(slides)));
    const out = [...pptxSlides(t.wrapped)];
    expect(out.map((s) => s.text)).toEqual(slides.map((_, i) => `s${i}`));
    expect(t.max()).toBeLessThanOrEqual(2);
    expect(t.live.size).toBe(0);
    const again = t.wrapped.part('ppt/slides/slide1.xml');
    expect(again).not.toBe(t.first.get('ppt/slides/slide1.xml'));
  });

  it('I7 bounds the layout cache and still orders by each layout', () => {
    const N = 40;
    const rels = (k: number) =>
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${k}.xml"/></Relationships>`;
    const layoutRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
    const extra: Record<string, string> = {};
    for (let k = 1; k <= N; k++) {
      const y = k % 2 === 0 ? IN : 5 * IN;
      extra[`ppt/slideLayouts/slideLayout${k}.xml`] =
        `<p:sldLayout ${NS}><p:cSld><p:spTree>${sp([para('Layout text')], { ph: { idx: 1 }, box: { x: 0, y, cx: IN, cy: IN } })}</p:spTree></p:cSld></p:sldLayout>`;
      extra[`ppt/slideLayouts/_rels/slideLayout${k}.xml.rels`] = layoutRels;
      extra[`ppt/slides/_rels/slide${k}.xml.rels`] = rels(k);
    }
    const slides = Array.from({ length: N }, () => ({
      shapes: [bodyPh('body'), sp([para('free')], { box: box(0, 3 * IN) })],
    }));
    const pkg = openPptx(tinyPptx(slides, { extra }));
    const cache: LayoutCache = new Map();
    pkg.slides.forEach((ref: SlideRef, i) => {
      const k = i + 1;
      const r = readSlide(pkg, ref, cache);
      expect(r.text).toBe(k % 2 === 0 ? 'body\n\nfree' : 'free\n\nbody');
      expect(cache.size).toBeLessThanOrEqual(MAX_CACHED_LAYOUTS);
    });
  });

  it('I8 reads a large deck quickly', { timeout: 30_000 }, () => {
    const slides = Array.from({ length: 150 }, () => {
      const shapes = Array.from({ length: 40 }, (_, j) =>
        sp([para([run('שלום '), run(`word ${j} `), run('O(n)')], { rtl: j % 2 === 0 })], {
          box: box((j % 8) * IN, Math.floor(j / 8) * IN),
        }),
      );
      return { shapes };
    });
    const extra: Record<string, Uint8Array> = {};
    for (let i = 1; i <= 150; i++) extra[`ppt/media/image${i}.png`] = new Uint8Array(200 * 1024);
    const bytes = tinyPptx(slides, { extra });
    const t0 = performance.now();
    const r = readPptx(bytes);
    const ms = performance.now() - t0;
    expect(r.slides).toHaveLength(150);
    expect(ms).toBeLessThan(4000);
    const g = (globalThis as { gc?: () => void }).gc;
    if (g) {
      g();
      expect(process.memoryUsage().heapUsed).toBeLessThan(512 * 1024 * 1024);
    }
  });

  it('I9 parses lazily, one slide per next() call', () => {
    const t = track(openPptx(tinyPptx([{ shapes: [bodyPh('a')] }, { shapes: [bodyPh('b')] }])));
    const it = pptxSlides(t.wrapped);
    expect(it.next().value?.text).toBe('a');
    expect(new Set(t.called)).toEqual(
      new Set(['ppt/slides/slide1.xml', 'ppt/slideLayouts/slideLayout1.xml']),
    );
    expect(t.live.size).toBe(0);
  });
});
