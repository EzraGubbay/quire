import { describe, expect, it } from 'vitest';
import {
  fixDashRuns,
  layoutPage,
  MATH_HEAVY_SCORE,
  type PdfTextItem,
  type Seq,
  visualToLogical,
} from './pdf-layout';

// Hand-built pdf.js text items: `str` is what pdf.js returns for the item (logical order inside it), the
// geometry is what the page had. Every glyph is half an em wide.
type Opts = { gap?: number; rtl?: boolean; font?: string; size?: number; rise?: number };
type Part = [text: string, opts?: Opts];
const SIZE = 10;
const widthOf = (text: string, size: number) =>
  Array.from(text).filter((c) => !/\p{M}/u.test(c)).length * 0.5 * size;
const item = (text: string, x: number, y: number, o: Opts): PdfTextItem => ({
  str: text,
  rtl: o.rtl ?? false,
  x,
  y: y + (o.rise ?? 0),
  width: widthOf(text, o.size ?? SIZE),
  fontSize: o.size ?? SIZE,
  fontName: o.font ?? (o.rtl ? 'hebrew' : 'latin'),
  eol: false,
});
const endLine = (items: PdfTextItem[]): PdfTextItem[] =>
  items.map((it, i) => (i === items.length - 1 ? { ...it, eol: true } : it));

/** A line painted left to right from `x`: content order is visual order (TeX). */
function painted(y: number, x: number, parts: Part[]): PdfTextItem[] {
  let pen = x;
  return endLine(
    parts.map(([text, o = {}]) => {
      pen += o.gap ?? 0;
      const it = item(text, pen, y, o);
      pen += it.width;
      return it;
    }),
  );
}

/** A right-to-left line written in logical order from the right edge `x` (Word). */
function written(y: number, x: number, parts: (Part | { ltr: Part[]; gap?: number })[]): PdfTextItem[] {
  let pen = x;
  const out: PdfTextItem[] = [];
  for (const p of parts) {
    const group: Part[] = Array.isArray(p) ? [p] : p.ltr;
    const gap = Array.isArray(p) ? (p[1]?.gap ?? 0) : (p.gap ?? 0);
    const total = group.reduce((w, [text, o = {}]) => w + widthOf(text, o.size ?? SIZE), 0);
    pen -= gap + total;
    let at = pen;
    for (const [text, o = {}] of group) {
      const it = item(text, at, y, o);
      out.push(it);
      at += it.width;
    }
  }
  return endLine(out);
}

const he = (text: string, gap = 0): Part => [text, { rtl: true, gap }];
const lat = (text: string, gap = 0): Part => [text, { gap }];
const mi = (text: string, gap = 0): Part => [text, { font: 'math-italic', gap }];
const mr = (text: string, gap = 0): Part => [text, { font: 'math-roman', gap }];
const sub = ([text, o = {}]: Part): Part => [text, { ...o, size: 7, rise: -1.5 }];
const sup = ([text, o = {}]: Part): Part => [text, { ...o, size: 7, rise: 4 }];
const text = (items: PdfTextItem[]) => layoutPage(items).text;

describe('layoutPage: word gaps', () => {
  it('joins items that touch and separates items with a gap', () => {
    const line = painted(700, 72, [
      lat('Assume'),
      mi('A', 3),
      mr('['),
      mi('i'),
      mr(']'),
      mr('>', 3),
      mr('0', 3),
    ]);
    expect(text(line)).toBe('Assume A[i] > 0');
  });

  it('keeps a number written digit by digit in one piece', () => {
    const line = painted(700, 72, [
      lat('due'),
      mr('2', 3),
      mr('9'),
      mr('.'),
      mr('11'),
      lat('at', 3),
      mr('10', 3),
      mr(':'),
      mr('30'),
    ]);
    expect(text(line)).toBe('due 29.11 at 10:30');
  });

  it('ignores an italic-correction gap before a bracket but keeps a thin space between words', () => {
    // 1.8 pt at 10 pt is 0.18 em: a space between letters, not before a closing bracket.
    expect(text(painted(700, 72, [lat('Len'), mr('('), mi('T'), mr(')', 1.8), mi('k', 1.8)]))).toBe(
      'Len(T) k',
    );
    // 1.4 pt (0.14 em) is never a space.
    expect(text(painted(700, 72, [mi('T'), mi('x', 1.4)]))).toBe('Tx');
  });

  it("ignores pdf.js's own whitespace items and trusts the geometry", () => {
    const [a, b] = painted(700, 72, [mi('t'), sub(mr('1'))]) as [PdfTextItem, PdfTextItem];
    const space: PdfTextItem = { ...a, str: ' ', x: a.x + a.width, width: 0 };
    expect(text([a, space, b])).toBe('t_1');
  });

  it('keeps English lines, their order and their hyphenation', () => {
    const page = [
      ...painted(700, 72, [lat('The table lists the measured run-')]),
      ...painted(686, 72, [lat('time, and the columns represent'), mi('n', 3), lat('threads.', 3)]),
      ...painted(672, 72, [lat('Second paragraph.')]),
    ];
    expect(text(page)).toBe(
      'The table lists the measured run-\ntime, and the columns represent n threads.\nSecond paragraph.',
    );
    expect(layoutPage(page).mathScore).toBe(0);
  });

  it('keeps content order across columns (a line break is never undone by geometry alone)', () => {
    const page = [
      ...painted(700, 72, [lat('left column, first line')]),
      ...painted(686, 72, [lat('left column, second line')]),
      ...painted(700, 320, [lat('right column, first line')]),
    ];
    expect(text(page)).toBe('left column, first line\nleft column, second line\nright column, first line');
  });
});

describe('layoutPage: right-to-left lines painted left to right (TeX)', () => {
  it('puts the runs of a Hebrew line in logical order', () => {
    // pdf.js returns the dash and the number of the last run in visual order ("– 2"): see fixDashRuns.
    const title = painted(780, 200, [he('-שלמות'), lat('NP'), he('תרגיל – 2 רדוקציות ו־')]);
    expect(text(title)).toBe('תרגיל 2 – רדוקציות ו־NP-שלמות');
  });

  it('starts the line with the label that is painted last', () => {
    const line = painted(760, 150, [he('יום רביעי, 25.11.2026, עד השעה 23:59.'), he('מועד ההגשה:', 4)]);
    expect(text(line)).toBe('מועד ההגשה: יום רביעי, 25.11.2026, עד השעה 23:59.');
  });

  it('keeps inline math as a left-to-right island, punctuation included', () => {
    const page = [
      ...painted(740, 100, [
        ['.', { font: 'hebrew' }],
        mi('T'),
        he('את אורך המילה', 3),
        lat('Len', 3),
        mr('('),
        mi('T'),
        mr(')', 1.4),
        he(', בלי קשר לתוכן. נסמן ב־'),
        mi('T'),
        he('אותיות מ־', 1.4),
      ]),
      ...painted(720, 180, [
        he('. נגדיר את הבעיה:'),
        mi('k'),
        mr('∈', 3),
        mr('N', 3),
        he('ו־'),
        mr('{', 3),
        mr('−'),
        mr('1'),
        mi(','),
        mr('0', 2),
        mr('}'),
        he('אוסף מעל', 3),
      ]),
    ];
    expect(text(page)).toBe(
      'אותיות מ־T, בלי קשר לתוכן. נסמן ב־Len(T) את אורך המילה T.\n' +
        'אוסף מעל {−1, 0} ו־k ∈ N. נגדיר את הבעיה:',
    );
  });

  it('mirrors brackets when the PDF stores their shapes', () => {
    // The "(" glyph painted left of the Latin words closes the Hebrew parenthesis; pdf.js keeps the shapes.
    const page = [
      ...painted(720, 150, [he('נגדיר שתי בעיות חדשות:')]),
      ...painted(700, 150, [['(', { font: 'hebrew' }], lat('Graph Coloring'), he('ב. צביעת גרף )')]),
    ];
    expect(text(page)).toBe('נגדיר שתי בעיות חדשות:\nב. צביעת גרף (Graph Coloring)');
  });

  it('reads a centred display formula left to right on a Hebrew page', () => {
    const page = [
      ...painted(760, 100, [he('נגדיר את בעיית ההכרעה הבאה, שהיא בעיה קשה מאוד לכל הדעות:')]),
      ...painted(730, 180, [
        lat('LEN'),
        mr('=', 3),
        mr('{', 3),
        mi('T'),
        mr('∈', 3),
        mr('Σ', 3),
        sup(mr('∗')),
        mr('}'),
        mi('.'),
      ]),
      // A display row that ends with Hebrew: the closing "}." painted at its right end stays at the end.
      ...painted(700, 150, [he('באורך זוגי'), lat('word', 3), he('קיימת מילה', 3), mr('}'), mi('.')]),
    ];
    expect(text(page)).toBe(
      'נגדיר את בעיית ההכרעה הבאה, שהיא בעיה קשה מאוד לכל הדעות:\n' +
        'LEN = {T ∈ Σ^∗}.\n' +
        'קיימת מילה word באורך זוגי}.',
    );
  });

  it('leaves a Hebrew word inside an English line where it is', () => {
    const page = painted(700, 72, [
      lat('The word'),
      he('שלום', 3),
      lat('means peace and', 3),
      he('תודה', 3),
      lat('means thanks.', 3),
    ]);
    expect(text(page)).toBe('The word שלום means peace and תודה means thanks.');
  });
});

describe('layoutPage: right-to-left lines written in logical order (Word)', () => {
  const page = [
    ...written(780, 500, [he('הקורס'), he('מ', 3), he('שלב בין'), [':', { font: 'times' }]]),
    ...written(760, 500, [
      ['•', { font: 'symbol' }],
      ['first deadline', { font: 'times', gap: 12 }],
      ['-', { font: 'hebrew', gap: 3 }],
      {
        gap: 3,
        ltr: [
          ['2', { font: 'hebrew' }],
          ['9', { font: 'hebrew' }],
          ['.', { font: 'hebrew' }],
          ['11', { font: 'hebrew' }],
        ],
      },
    ]),
    // Word stores the logical bracket; the neutral-only run ".)" is painted "." first.
    ...written(740, 500, [
      he('הציון'),
      he(', כולל בונוס ('),
      ['bonus', { font: 'times' }],
      ['.)', { font: 'hebrew' }],
    ]),
    ...written(720, 500, [
      he('שלב'),
      ['9', { font: 'hebrew', gap: 3 }],
      [':', { font: 'hebrew' }],
      ['testing', { font: 'times', gap: 3 }],
    ]),
    ...written(700, 500, [he('עד יום שני 16 בנובמב'), he('ר'), he('בשעה 10:30', 3)]),
    ...written(680, 500, [
      he('תיעוד'),
      ['(', { font: 'hebrew', gap: 3 }],
      he('קצר'),
      [')', { font: 'hebrew' }],
      he('של הקוד', 3),
    ]),
  ];
  const lines = text(page).split('\n');

  it('rejoins a word split across runs', () => {
    expect(lines[0]).toBe('הקורס משלב בין:');
    expect(lines[4]).toBe('עד יום שני 16 בנובמבר בשעה 10:30');
  });

  it('rejoins a number split across runs', () => {
    expect(lines[1]).toBe('• first deadline - 29.11');
  });

  it('keeps logical brackets and puts a neutral-only run in logical order', () => {
    expect(lines[2]).toBe('הציון, כולל בונוס (bonus).');
    expect(lines[5]).toBe('תיעוד (קצר) של הקוד');
  });

  it('keeps the written order where the painted order is ambiguous', () => {
    // Painted left to right this is "testing :9 שלב": only the content order says the 9 comes first.
    expect(lines[3]).toBe('שלב 9: testing');
  });
});

describe('layoutPage: math', () => {
  it('composes an overlaid combining mark with the character it covers', () => {
    const [p, eq, np] = painted(700, 72, [mi('P'), mr('=', 4), mi('NP', 3)]) as [
      PdfTextItem,
      PdfTextItem,
      PdfTextItem,
    ];
    // TeX's \not: a zero-width U+0338 item painted just before the "=".
    const slash: PdfTextItem = { ...eq, str: '̸', width: 0 };
    expect(text([p, slash, eq, np])).toBe('P ≠ NP');
    expect(text([p, slash, eq, np])).not.toMatch(/\p{M}/u);
    // …also when pdf.js merged the mark and the "=" into one item.
    expect(text([p, { ...eq, str: '̸=' }, np])).toBe('P ≠ NP');
  });

  it('marks sub- and superscripts', () => {
    const line = painted(700, 72, [
      mi('T'),
      mr('=', 3),
      mi('t', 3),
      sub(mr('1')),
      mr('···', 2),
      mi('t', 2),
      sub(mi('n')),
      mr('Σ', 6),
      sup(mr('∗')),
      lat('SS', 6),
      sub(lat('half')),
      mi('x', 6),
      sub(mi('i')),
      sup(mr('2')),
    ]);
    expect(text(line)).toBe('T = t_1 ··· t_n Σ^∗ SS_{half} x_i^2');
  });

  it('rebuilds a display that pdf.js splits at a stacked delimiter, a limit and inline fractions', () => {
    // Geometry of a real TeX set-builder display (10.9 pt, scripts 8 pt), with pdf.js's line breaks.
    const i = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontSize = 10.9,
      eol = false,
    ): PdfTextItem => ({
      str,
      rtl: false,
      x,
      y,
      width,
      fontSize,
      fontName: fontSize < 10 ? 'script' : 'math',
      eol,
    });
    const display = [
      i('XS', 169.7, 340.2, 12.1),
      i('max', 181.9, 338.4, 12.3, 8),
      i('=', 197.7, 340.2, 8.5),
      i('{', 209.2, 349.1, 6.4),
      i('((', 215.5, 340.2, 8.5),
      i('c', 224.0, 340.2, 5.8),
      i('1', 229.8, 338.6, 4.2, 8),
      i(', . . . , c', 234.5, 340.2, 30.0),
      i('k', 264.5, 338.6, 5.1, 8),
      i(')', 270.2, 340.2, 4.2),
      i(', d', 274.4, 340.2, 9.5),
      i(')', 283.9, 340.2, 4.2),
      i('∣', 294.2, 349.5, 3.6, 10.9, true),
      i('∣', 294.2, 342.9, 3.6),
      i('∃', 300.9, 340.2, 6.1),
      i('J', 307.0, 340.2, 4.8),
      i('⊆', 315.6, 340.2, 8.5),
      i('[', 327.2, 340.2, 3.0),
      i('k', 330.2, 340.2, 6.5),
      i('] :', 336.7, 340.2, 9.1),
      i('∑', 351.9, 350.6, 15.8),
      i('', 353.4, 327.0, 0, 8, true),
      i('j', 353.4, 327.0, 2.9, 8),
      i('∈', 356.3, 327.0, 5.6, 8),
      i('J', 361.9, 327.0, 3.7, 8),
      i('', 369.5, 340.2, 0, 10.9, true),
      i('c', 369.5, 340.2, 5.8),
      i('j', 375.3, 338.6, 2.9, 8),
      i('=', 381.7, 340.2, 8.5),
      i('d,', 393.2, 340.2, 7.7),
      i('', 302.1, 318.2, 0, 8, true),
      i('k', 302.1, 318.2, 5.1, 8),
      i('', 302.5, 310.1, 0, 8, true),
      i('3', 302.5, 310.1, 4.2, 8),
      i('−', 310.9, 313.9, 8.5),
      i('100', 321.8, 313.9, 16.4),
      i('≤ |', 341.2, 313.9, 14.5),
      i('J', 355.7, 313.9, 4.8),
      i('| ≤', 361.4, 313.9, 14.5),
      i('k', 380.1, 318.2, 5.1, 8),
      i('', 380.6, 310.1, 0, 8, true),
      i('3', 380.6, 310.1, 4.2, 8),
      i('+ 100', 388.9, 313.9, 27.3),
      i('}', 416.2, 322.7, 6.4),
      i('.', 422.5, 313.9, 3.0, 10.9, true),
    ];
    const page = layoutPage(display);
    expect(page.text).toBe(
      'XS_{max} = {((c_1, . . . , c_k), d) ∣ ∃J ⊆ [k] : ∑_{j∈J} c_j = d,\nk/3 − 100 ≤ |J| ≤ k/3 + 100}.',
    );
    expect(page.mathScore).toBeGreaterThanOrEqual(MATH_HEAVY_SCORE);
  });

  it('does not call a page with a little inline math math-heavy', () => {
    const page = layoutPage(
      painted(700, 72, [
        lat('for every'),
        mi('i', 3),
        mr('∈', 3),
        mr('{1, . . . ,', 3),
        mi('n', 3),
        mr('}'),
        lat('and a 3×3 table', 3),
        sub(mr('1')),
      ]),
    );
    expect(page.mathScore).toBeLessThan(MATH_HEAVY_SCORE);
  });
});

describe('visualToLogical', () => {
  const R = (t: string): Seq => ({ text: t, cls: 'R', letters: Array.from(t).length });
  const L = (t: string): Seq => ({ text: t, cls: 'L', letters: Array.from(t).length });
  const EN = (t: string): Seq => ({ text: t, cls: 'EN' });
  const N = (t: string): Seq => ({ text: t, cls: 'N' });
  const cue = (t: string): Seq => ({ text: t, cls: 'L', cue: true });
  const sp = N(' ');
  const join = (seq: Seq[], base: 'L' | 'R') =>
    visualToLogical(seq, base)
      .map((p) => p.text)
      .join('');

  it('reverses the runs of a right-to-left line and keeps left-to-right runs intact', () => {
    expect(join([R('ג'), sp, L('abc'), sp, L('def'), sp, R('ב'), sp, R('א')], 'R')).toBe('א ב abc def ג');
  });

  it('keeps a number in one piece and two numbers as two runs', () => {
    expect(join([R('ב'), sp, EN('29'), N('.'), EN('11'), sp, R('א')], 'R')).toBe('א 29.11 ב');
    // A time range is displayed end-first in a right-to-left line.
    expect(join([EN('12:00'), sp, N('-'), sp, EN('10:30'), sp, R('א')], 'R')).toBe('א 10:30 - 12:00');
  });

  it('lets a number continue the left-to-right text before it', () => {
    expect(join([R('ב'), sp, L('Lecture'), sp, EN('5'), sp, R('א')], 'R')).toBe('א Lecture 5 ב');
  });

  it('resolves neutrals by their neighbours and reverses neutral-only tokens at a right-to-left level', () => {
    expect(join([N('.)'), L('bonus'), R('בונוס ('), R('כולל ')], 'R')).toBe('כולל בונוס (bonus).');
    const pieces = visualToLogical([N('('), L('Set'), R('קבוצה )')], 'R');
    expect(pieces.map((p) => [p.text, p.r])).toEqual([
      ['קבוצה )', true],
      ['Set', false],
      ['(', true],
    ]);
  });

  it('keeps a font-only closing tail at the end of a right-to-left line', () => {
    expect(join([R('ב'), sp, L('word'), sp, R('א'), cue('}'), cue('.')], 'R')).toBe('א word ב}.');
    // …but not when it closes left-to-right text that starts the line.
    expect(join([R('ב'), sp, cue('('), L('S'), cue(')')], 'R')).toBe('(S) ב');
  });

  it('treats a right-to-left phrase inside a left-to-right line as one embedding', () => {
    expect(
      join([L('A'), sp, cue('='), sp, R('שורות המטריצה'), sp, L('on'), sp, R('קיימת סדרה'), cue('}')], 'L'),
    ).toBe('A = קיימת סדרה on שורות המטריצה}');
    // Two separate Hebrew words in an English sentence stay where they are.
    expect(join([L('word'), sp, R('שלום'), sp, L('and the other'), sp, R('תודה'), sp, L('end')], 'L')).toBe(
      'word שלום and the other תודה end',
    );
  });
});

describe('fixDashRuns', () => {
  it('puts a number back before the dash pdf.js glued it to', () => {
    expect(fixDashRuns('תרגיל – 2 רדוקציות ו־')).toBe('תרגיל 2 – רדוקציות ו־');
    expect(fixDashRuns('שאלה – 12 כותרת')).toBe('שאלה 12 – כותרת');
  });

  it('restores number ranges', () => {
    expect(fixDashRuns('עמודים 7–5')).toBe('עמודים 5–7');
    expect(fixDashRuns('בשנים – 2020 2021')).toBe('בשנים 2020 – 2021');
  });

  it('leaves everything else alone', () => {
    expect(fixDashRuns('שאלה 1 – כותרת')).toBe('שאלה 1 – כותרת');
    expect(fixDashRuns('תת־קבוצה 3-2')).toBe('תת־קבוצה 3-2');
    expect(fixDashRuns('ללא מקף 25.11.2026')).toBe('ללא מקף 25.11.2026');
    expect(fixDashRuns('מקף — בלי מספר')).toBe('מקף — בלי מספר');
  });
});
