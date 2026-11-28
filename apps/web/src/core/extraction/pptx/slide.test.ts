// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  br,
  fld,
  graphicFrame,
  group,
  EMU_PER_INCH as IN,
  math,
  para,
  pic,
  run,
  sp,
  type TinyBox,
  type TinyPptxOptions,
  table,
  tinyPptx,
} from '@/lib/testing/tiny-pptx';
import { PptxError } from './errors';
import { openPptx, type PptxPackage, type SlideRef } from './presentation';
import { noFlags, readSlide } from './slide';

const bx = (x: number, y: number, cx = IN, cy = IN / 2): TinyBox => ({ x, y, cx, cy });
const read = (shapes: string[], opts?: TinyPptxOptions) => {
  const pkg = openPptx(tinyPptx([{ shapes }], opts));
  return readSlide(pkg, pkg.slides[0] as SlideRef);
};
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const rawSlide = (inner: string, attrs = ''): string =>
  `<p:sld ${NS}${attrs}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;
const layoutXml = (shapes: string[]): string =>
  `<p:sldLayout ${NS}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sldLayout>`;
const errOf = (fn: () => unknown): PptxError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PptxError);
    return e as PptxError;
  }
  throw new Error('expected a PptxError');
};
const tc = (paras: string[], attrs = ''): string =>
  `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${paras.map((p) => para(p)).join('')}</a:txBody></a:tc>`;
const tr = (cells: string[]): string => `<a:tr h="370840">${cells.join('')}</a:tr>`;
const tableFrame = (rows: string[], b: TinyBox): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.cx}" cy="${b.cy}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid/>${rows.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

describe('paragraph text', () => {
  it('S1 keeps mixed Hebrew and English runs in logical order', () => {
    const r = read([
      sp([para([run('האלגוריתם '), run('PageRank'), run(' רץ בזמן '), run('O(n)')], { rtl: true })], {
        box: bx(0, 0),
      }),
    ]);
    expect(r.text).toBe('האלגוריתם PageRank רץ בזמן O(n)');
  });

  it('S2 joins split runs without separators', () => {
    expect(read([sp([para([run('1'), run('0')])], { box: bx(0, 0) })]).text).toBe('10');
  });

  it('S3 rejoins a word split across runs and keeps a space run', () => {
    expect(read([sp([para([run('Pa'), run('geRank')])], { box: bx(0, 0) })]).text).toBe('PageRank');
    expect(read([sp([para([run('hello'), run(' '), run('world')])], { box: bx(0, 0) })]).text).toBe(
      'hello world',
    );
  });

  it('S4 keeps a syntax-coloured code line verbatim', () => {
    const line = 'void PageRank(Graph* g, int n, float* rank)';
    const runs = (line.match(/.{1,4}/g) ?? []).map((t) => run(t));
    expect(runs.length).toBeGreaterThanOrEqual(10);
    expect(read([sp([para(runs)], { box: bx(0, 0) })]).text).toBe(line);
  });

  it('S5 keeps code lines and their indentation', () => {
    const r = read([sp([para('int *p;'), para('char c;'), para('    return 0;')], { box: bx(0, 0) })]);
    expect(r.text).toBe('int *p;\nchar c;\n    return 0;');
  });

  it('S6 turns a:br, vertical tab and CRLF into newlines', () => {
    expect(read([sp([para([run('a'), br(), run('b')])], { box: bx(0, 0) })]).text).toBe('a\nb');
    expect(read([sp([para([run('a\u000Bb')])], { box: bx(0, 0) })]).text).toBe('a\nb');
    const crlf = read([sp([para([run('a\r\nb')])], { box: bx(0, 0) })]).text;
    expect(crlf).toBe('a\nb');
    expect(crlf).not.toContain('\r');
  });

  it('S7 drops the slide-number field but keeps other fields', () => {
    expect(read([sp([para([run('Page '), fld('slidenum', '7'), run('end')])], { box: bx(0, 0) })]).text).toBe(
      'Page end',
    );
    expect(read([sp([para([fld('datetime1', '1/1/2026')])], { box: bx(0, 0) })]).text).toBe('1/1/2026');
  });

  it('S8 skips slide number, footer and date placeholders', () => {
    const r = read([
      sp([para('N')], { ph: { type: 'sldNum', idx: 4 } }),
      sp([para('F')], { ph: { type: 'ftr', idx: 3 } }),
      sp([para('D')], { ph: { type: 'dt', idx: 2 } }),
      sp([para('Body text')], { box: bx(0, 0) }),
    ]);
    expect(r.text).toBe('Body text');
  });

  it('S9 ignores hidden shapes, text and pictures', () => {
    const r = read([
      sp([para('secret')], { box: bx(0, 0), hidden: true }),
      pic(bx(0, 0)).replace('name="Picture"', 'name="Picture" hidden="1"'),
      sp([para('shown')], { box: bx(0, IN) }),
    ]);
    expect(r.text).toBe('shown');
    expect(r.flags.picture).toBe(false);
  });

  it('S10 replaces an equation with a placeholder and flags it', () => {
    const r = read([sp([para([run('T = '), math('FALLBACK'), run('.')])], { box: bx(0, 0) })]);
    expect(r.text).toBe('T = [math].');
    expect(r.flags.math).toBe(true);
    expect(r.text).not.toContain('FALLBACK');
  });

  it('S11 strips bidi controls and the BOM, keeps ZWJ', () => {
    expect(read([sp([para([run('a\u200Fb\uFEFFc\u202Bd\u202C')])], { box: bx(0, 0) })]).text).toBe('abcd');
    expect(read([sp([para([run('x\u200Dy')])], { box: bx(0, 0) })]).text).toBe('x\u200Dy');
  });

  it('S12 keeps markup characters and joins CDATA parts', () => {
    expect(read([sp([para([run('a < b && c')])], { box: bx(0, 0) })]).text).toBe('a < b && c');
    const cdata = '<a:p><a:r><a:t>x<![CDATA[<y]]>z</a:t></a:r></a:p>';
    expect(read([sp([cdata], { box: bx(0, 0) })]).text).toBe('x<yz');
  });

  it('S13 flags pictures on the slide, not in the layout', () => {
    expect(read([pic(bx(0, 0))]).flags.picture).toBe(true);
    const r = read([sp([para('t')], { box: bx(0, 0) })], { layout: layoutXml([pic(bx(0, 0))]) });
    expect(r.flags.picture).toBe(false);
  });

  it('S14 gives empty text for a hidden slide without parsing it', () => {
    const xml = `<p:sld ${NS} show="0"><<<not xml`;
    const pkg = openPptx(tinyPptx([{ xml }]));
    const ref = pkg.slides[0] as SlideRef;
    expect(ref.hidden).toBe(true);
    expect(readSlide(pkg, ref)).toEqual({ text: '', flags: noFlags() });
  });

  it('S32 uses a single-line title and keeps the break in the text', () => {
    const r = read([
      sp([para([run('Intro'), br(), run('Part 2')])], { ph: { type: 'title' }, box: bx(0, 0) }),
    ]);
    expect(r.title).toBe('Intro Part 2');
    expect(r.text.startsWith('Intro\nPart 2')).toBe(true);
  });
});

describe('reading order', () => {
  it('S15 puts the title first even when it sits lower', () => {
    const r = read([
      sp([para('Body')], { box: bx(0, IN) }),
      sp([para('Title')], { ph: { type: 'title' }, box: bx(0, 3 * IN) }),
    ]);
    expect(r.text).toBe('Title\n\nBody');
    expect(r.title).toBe('Title');
  });

  it('S16 treats boxes with nearly equal tops as one row, left first', () => {
    const r = read([
      sp([para('R')], { box: bx(6 * IN, IN) }),
      sp([para('L')], { box: bx(IN, IN + Math.round(0.02 * 6858000)) }),
    ]);
    expect(r.text).toBe('L\n\nR');
  });

  it('S17 puts a clearly higher box first even when it is on the right', () => {
    const r = read([
      sp([para('lower left')], { box: bx(IN, IN + Math.round(0.04 * 6858000)) }),
      sp([para('upper right')], { box: bx(6 * IN, IN) }),
    ]);
    expect(r.text).toBe('upper right\n\nlower left');
  });

  it('S18 orders RTL rows right to left and LTR rows left to right', () => {
    const he = (t: string, x: number, rtl: boolean) => sp([para(t, { rtl })], { box: bx(x, IN) });
    expect(read([he('שמאל', IN, true), he('ימין', 6 * IN, true)]).text).toBe('ימין\n\nשמאל');
    expect(read([he('שמאל', IN, false), he('ימין', 6 * IN, false)]).text).toBe('ימין\n\nשמאל');
    const mixed = read([he('שמאל', IN, false), sp([para('right')], { box: bx(6 * IN, IN) })]);
    expect(mixed.text).toBe('שמאל\n\nright');
  });

  it('S19 gives a box-less placeholder its layout position', () => {
    const r = read([
      sp([para('body')], { ph: { idx: 1 } }),
      sp([para('top')], { box: bx(IN, IN / 2) }),
      sp([para('bottom')], { box: bx(IN, 6.5 * IN) }),
    ]);
    expect(r.text).toBe('top\n\nbody\n\nbottom');
    expect(r.text).not.toContain('Placeholder text');
  });

  it('S19b falls back to the master box when the layout placeholder has none', () => {
    const layout = layoutXml([sp([para('Layout text')], { ph: { idx: 1 } })]);
    const r = read(
      [
        sp([para('body')], { ph: { idx: 1 } }),
        sp([para('top')], { box: bx(IN, IN / 2) }),
        sp([para('bottom')], { box: bx(IN, 6.5 * IN) }),
      ],
      { layout },
    );
    expect(r.text).toBe('top\n\nbody\n\nbottom');
    expect(r.text).not.toContain('Layout text');
  });

  it('S20 places a group by its own offset', () => {
    const g = group([sp([para('in group')], { box: { x: 0, y: 0, cx: IN, cy: IN / 2 } })], {
      off: [0, 5 * IN],
      ext: [2 * IN, IN],
      chOff: [0, 0],
      chExt: [2 * IN, IN],
    });
    expect(read([g, sp([para('free')], { box: bx(0, 3 * IN) })]).text).toBe('free\n\nin group');
  });

  it('S21 scales child coordinates by the group extent ratio', () => {
    const g = group([sp([para('R')], { box: bx(2 * IN, 0) }), sp([para('L')], { box: bx(0, IN / 2) })], {
      off: [0, 0],
      ext: [IN, IN],
      chOff: [0, 0],
      chExt: [4 * IN, 4 * IN],
    });
    expect(read([g]).text).toBe('L\nR');
  });

  it('S22 composes the scale of nested groups', () => {
    const dims = {
      off: [0, 0] as [number, number],
      ext: [5 * IN, 3 * IN] as [number, number],
      chOff: [0, 0] as [number, number],
      chExt: [10 * IN, 6 * IN] as [number, number],
    };
    const inner = group(
      [sp([para('A')], { box: bx(4 * IN, 0) }), sp([para('B')], { box: bx(0, 0.8 * IN) })],
      dims,
    );
    expect(read([group([inner], dims)]).text).toBe('B\nA');
  });
});

describe('tables, frames and alternate content', () => {
  it('S23 reads a table as pipe-separated rows', () => {
    const r = read([
      table(
        [
          ['a', 'b', 'c'],
          ['1', '2', '3'],
        ],
        bx(0, 0),
      ),
    ]);
    expect(r.text).toBe('a | b | c\n1 | 2 | 3');
    expect(r.flags.table).toBe(true);
  });

  it('S24 skips merge continuations and keeps empty cells and multi-paragraph cells', () => {
    const rows = [
      tr([tc(['x'], ' gridSpan="2"'), tc([''], ' hMerge="1"'), tc(['z'])]),
      tr([tc(['p']), tc([''], ' vMerge="1"'), tc(['q'])]),
      tr([tc(['x']), tc(['']), tc(['z'])]),
      tr([tc(['one', 'two']), tc(['end'])]),
      tr([tc(['']), tc([''])]),
    ];
    expect(read([tableFrame(rows, bx(0, 0))]).text).toBe('x | z\np | q\nx |  | z\none two | end');
  });

  it('S25 orders a table by its p:xfrm', () => {
    const r = read([table([['t']], bx(0, 4 * IN)), sp([para('text')], { box: bx(0, IN) })]);
    expect(r.text).toBe('text\n\nt');
  });

  it('S26 flags charts and SmartArt without text', () => {
    const r = read([graphicFrame('chart', bx(0, 0)), graphicFrame('diagram', bx(0, IN))]);
    expect(r.text).toBe('');
    expect(r.flags.chart).toBe(true);
    expect(r.flags.smartArt).toBe(true);
  });

  it('S27 uses the known Choice and never also the Fallback', () => {
    const alt = `<mc:AlternateContent><mc:Choice Requires="a14">${sp([para([run('E = '), math()])], { box: bx(0, 0) })}</mc:Choice><mc:Fallback>${pic(bx(0, 0))}</mc:Fallback></mc:AlternateContent>`;
    const r = read([alt]);
    expect(r.text).toBe('E = [math]');
    expect(r.flags.math).toBe(true);
    expect(r.flags.picture).toBe(false);
  });

  it('S28 falls back when a Choice needs an unknown namespace', () => {
    const alt = (req: string) =>
      `<mc:AlternateContent><mc:Choice Requires="${req}">${sp([para('A')], { box: bx(0, 0) })}</mc:Choice><mc:Fallback>${sp([para('B')], { box: bx(0, 0) })}</mc:Fallback></mc:AlternateContent>`;
    expect(read([alt('xyz')]).text).toBe('B');
    expect(read([alt('a14 xyz')]).text).toBe('B');
  });

  it('S29 reads nothing when no branch applies', () => {
    const alt = `<mc:AlternateContent><mc:Choice Requires="xyz">${sp([para('A')], { box: bx(0, 0) })}</mc:Choice></mc:AlternateContent>`;
    expect(read([alt]).text).toBe('');
  });
});

describe('defence in depth', () => {
  it('S30 rejects a hidden-state mismatch and a wrong root element', () => {
    const pkg = openPptx(tinyPptx([{ xml: rawSlide('', ' show="0"') }]));
    const hiddenRef = pkg.slides[0] as SlideRef;
    expect(hiddenRef.hidden).toBe(true);
    const e1 = errOf(() => readSlide(pkg, { ...hiddenRef, hidden: false }));
    expect([e1.code, e1.part]).toEqual(['unsupported', 'ppt/slides/slide1.xml']);

    const real = openPptx(tinyPptx([{}]));
    const layoutRoot = real.part('ppt/slideLayouts/slideLayout1.xml');
    const wrapped: PptxPackage = { ...real, part: () => layoutRoot };
    const e2 = errOf(() => readSlide(wrapped, real.slides[0] as SlideRef));
    expect([e2.code, e2.part]).toEqual(['unsupported', 'ppt/slides/slide1.xml']);
  });

  it('S31 reads an empty slide without a shape tree', () => {
    const pkg = openPptx(tinyPptx([{ xml: `<p:sld ${NS}><p:cSld/></p:sld>` }]));
    expect(readSlide(pkg, pkg.slides[0] as SlideRef)).toEqual({ text: '', flags: noFlags() });
  });
});
