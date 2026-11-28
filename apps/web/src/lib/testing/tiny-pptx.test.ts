// @vitest-environment node
import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { decodePart, parseXml, path } from '@/core/extraction/pptx/xml';
import { readZip } from '@/core/extraction/pptx/zip';
import { escapeXml, math, para, pic, run, sp, table, tinyPptx } from './tiny-pptx';

const BOX = { x: 0, y: 0, cx: 100, cy: 100 };

describe('tinyPptx', () => {
  it('T1 is byte-for-byte deterministic', () => {
    const make = () => tinyPptx([{ shapes: [sp([para('hi')], { box: BOX })] }, { shapes: [], show: false }]);
    expect(make()).toEqual(make());
  });

  it('T2 writes the expected parts, all readable, and every XML part is well-formed', () => {
    const bytes = tinyPptx([
      {
        shapes: [sp([para(['a', math('f')])], { box: BOX }), pic(BOX), table([['a', 'b']], BOX)],
      },
    ]);
    const m = readZip(bytes, () => true);
    expect([...m.keys()].sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'ppt/_rels/presentation.xml.rels',
        'ppt/presentation.xml',
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/slides/_rels/slide1.xml.rels',
        'ppt/slides/slide1.xml',
      ].sort(),
    );
    for (const [name, data] of m) {
      expect(XMLValidator.validate(new TextDecoder().decode(data)), name).toBe(true);
    }
  });

  it('T3 escapes text so it stays well-formed and round-trips', () => {
    const text = 'a<b & "c"';
    expect(escapeXml(text)).toBe('a&lt;b &amp; &quot;c&quot;');
    const xml = `<a:p xmlns:a="x">${run(text)}</a:p>`;
    expect(path(parseXml(xml, 'p'), 'a:r', 'a:t')?.children[0]?.text).toBe(text);
    const bytes = tinyPptx([{ shapes: [sp([para(text)])] }]);
    const slide = readZip(bytes, (n) => n === 'ppt/slides/slide1.xml').get(
      'ppt/slides/slide1.xml',
    ) as Uint8Array;
    expect(XMLValidator.validate(decodePart(slide, 'slide'))).toBe(true);
  });
});
