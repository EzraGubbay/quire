// Test-only: the synthetic PDF the extraction tests read, with the exact text each page should yield. It
// reproduces, with made-up content, the layouts that broke get_file: a TeX-style Hebrew page (runs painted
// left to right, math in fonts of its own), a Word-style Hebrew page (runs painted in logical order, words
// and numbers split across runs, an embedded image), an English page with formulas, and a figure-only page.
import {
  glyphsWidth,
  logicalRow,
  type RowPart,
  type TinyPage,
  type TinyRun,
  tinyPdf,
  visualRow,
} from './tiny-pdf';

const he = (text: string, gap = 0): RowPart => ({ font: 'hebrew', text, gap, rtl: true });
const heBold = (text: string, gap = 0): RowPart => ({ font: 'hebrew-bold', text, gap, rtl: true });
const lat = (text: string, gap = 0): RowPart => ({ font: 'latin', text, gap });
const mi = (text: string, gap = 0): RowPart => ({ font: 'math-italic', text, gap });
const mr = (text: string, gap = 0): RowPart => ({ font: 'math-roman', text, gap });
const sub = (p: RowPart): RowPart => ({ ...p, size: 7, rise: -1.5 });
const sup = (p: RowPart): RowPart => ({ ...p, size: 7, rise: 4 });

const RIGHT = 500;
const width = (parts: RowPart[], size: number) =>
  parts.reduce((w, p) => w + (p.gap ?? 0) + glyphsWidth(p.text, p.size ?? size), 0);
/** A TeX row set flush right (a right-to-left paragraph line), parts in visual order. */
const flushRight = (y: number, parts: RowPart[]) => visualRow(RIGHT - width(parts, 10), y, 10, parts);

/** TeX-style Hebrew: every row is painted left to right. */
const texPage: TinyPage = {
  runs: [
    ...flushRight(780, [heBold('-שלמות'), lat('NP'), heBold('תרגיל 2 – רדוקציות ו־')]),
    ...flushRight(760, [he('יום רביעי, 25.11.2026, עד השעה 23:59.'), heBold('מועד ההגשה:', 4)]),
    ...flushRight(740, [
      he('מילה באורך סופי כלשהו'),
      mi('T', 3),
      mr('=', 3),
      mi('t', 3),
      sub(mr('1')),
      mr('···', 2),
      mi('t', 2),
      sub(mi('n')),
      he('תהי', 3),
    ]),
    ...flushRight(720, [
      he(', האם הבעיה קשה?'),
      mi('P'),
      mr('̸', 3),
      mr('='),
      mi('NP', 3),
      he('תחת ההנחה כי', 3),
    ]),
    // TeX paints bracket shapes: the "(" glyph left of the Latin words closes the Hebrew parenthesis.
    ...flushRight(700, [heBold('('), lat('Graph Coloring'), heBold('ב. צביעת גרף )')]),
    ...flushRight(680, [
      he('.'),
      mi('T'),
      he('את אורך המילה', 3),
      lat('Len', 3),
      mr('('),
      mi('T'),
      mr(')'),
      he('נסמן ב־'),
    ]),
    // A centred display formula: left-to-right even though the page is Hebrew.
    ...visualRow(200, 650, 10, [
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
  ],
};

const word = (font: string, text: string, gap = 0): RowPart => ({ font, text, gap, rtl: font === 'david' });
/** Word-style Hebrew: runs in logical order, right to left, split at arbitrary places. */
const wordPage: TinyPage = {
  runs: [
    ...logicalRow(RIGHT, 780, 12, [
      word('david', 'הקורס'),
      word('david', 'מ', 3),
      word('david', 'שלב בין'),
      word('times', ':'),
    ]),
    ...logicalRow(RIGHT, 760, 12, [
      word('times', '•'),
      word('times', 'first deadline', 12),
      { font: 'david', text: '-', gap: 3 },
      {
        gap: 3,
        ltrGroup: [
          { font: 'david', text: '2' },
          { font: 'david', text: '9' },
          { font: 'david', text: '.' },
          { font: 'david', text: '11' },
        ],
      },
    ]),
    ...logicalRow(RIGHT, 740, 12, [
      word('david', 'הציון'),
      // Word stores the logical bracket: this "(" opens the parenthesis although it is painted on the right.
      { font: 'david', text: '( סונוב ללוכ ,' },
      word('times', 'bonus'),
      { font: 'david', text: '.)' },
    ]),
    ...logicalRow(RIGHT, 720, 12, [
      word('david', 'שלב'),
      { font: 'david', text: '9', gap: 3 },
      { font: 'david', text: ':' },
      word('times', 'testing', 3),
    ]),
    ...logicalRow(RIGHT, 700, 12, [
      word('david', 'עד יום שני 16 בנובמב'),
      word('david', 'ר'),
      word('david', 'בשעה 10:30', 3),
    ]),
  ],
  image: { x: 100, y: 300, width: 240, height: 180 },
};

/**
 * A two-row display as TeX paints it: a big operator hanging from above the baseline with its limit set
 * underneath, then a row that starts with a stacked inline fraction.
 */
const display = (y: number): TinyRun[] => {
  const head = visualRow(150, y, 10, [
    lat('SS'),
    sub(lat('half')),
    mr('=', 3),
    mr('{', 3),
    mi('I'),
    mr('⊆', 3),
    mr('[', 3),
    mi('n'),
    mr(']'),
    mr(':', 2),
  ]);
  const last = head[head.length - 1] as TinyRun;
  const sumX = last.x + glyphsWidth(last.glyphs, last.size) + 5;
  return [
    ...head,
    { font: 'math-extension', size: 10, x: sumX, y: y + 9.5, glyphs: '∑' },
    { font: 'math-italic', size: 7, x: sumX - 2, y: y - 13, glyphs: 'i' },
    { font: 'math-roman', size: 7, x: sumX + 1.5, y: y - 13, glyphs: '∈' },
    { font: 'math-italic', size: 7, x: sumX + 5, y: y - 13, glyphs: 'I' },
    ...visualRow(sumX + 10, y, 10, [mi('a'), sub(mi('i')), mr('=', 3), mi('b', 3), mi(',')]),
    { font: 'math-italic', size: 7, x: 180, y: y - 25.7, glyphs: 'n' },
    { font: 'math-roman', size: 7, x: 180, y: y - 33.8, glyphs: '2' },
    ...visualRow(187, y - 30, 10, [mr('≤'), mr('|', 3), mi('I'), mr('|'), mr('}'), mi('.')]),
  ];
};

/** English with inline and display math (TeX: every font change is a separate run). */
const mathPage: TinyPage = {
  runs: [
    ...visualRow(72, 780, 10, [
      lat('Achieve a time complexity of'),
      mi('O', 3),
      mr('(log'),
      mi('n', 2),
      mr(')'),
      lat('.'),
    ]),
    ...visualRow(72, 760, 10, [
      lat('Assume'),
      mi('A', 3),
      mr('['),
      mi('i'),
      mr(']'),
      mr('>', 3),
      mr('0', 3),
      lat('for every', 6),
      mi('i', 3),
      lat('.'),
    ]),
    ...display(720),
    ...display(650),
  ],
};

/** A slide that is one picture with a caption. */
const figurePage: TinyPage = {
  runs: visualRow(72, 780, 10, [lat('Fig. 1')]),
  image: { x: 60, y: 200, width: 480, height: 500 },
};

export const samplePdf = (): Uint8Array => tinyPdf([texPage, wordPage, mathPage, figurePage]);

/** What a correct extractor returns for each page of samplePdf(). */
export const SAMPLE_TEXT = [
  [
    'תרגיל 2 – רדוקציות ו־NP-שלמות',
    'מועד ההגשה: יום רביעי, 25.11.2026, עד השעה 23:59.',
    'תהי T = t_1 ··· t_n מילה באורך סופי כלשהו',
    'תחת ההנחה כי P ≠ NP, האם הבעיה קשה?',
    'ב. צביעת גרף (Graph Coloring)',
    'נסמן ב־Len(T) את אורך המילה T.',
    'LEN = {T ∈ Σ^∗}.',
  ].join('\n'),
  [
    'הקורס משלב בין:',
    '• first deadline - 29.11',
    'הציון, כולל בונוס (bonus).',
    'שלב 9: testing',
    'עד יום שני 16 בנובמבר בשעה 10:30',
  ].join('\n'),
  [
    'Achieve a time complexity of O(log n).',
    'Assume A[i] > 0 for every i.',
    'SS_{half} = {I ⊆ [n] : ∑_{i∈I} a_i = b,',
    'n/2 ≤ |I|}.',
    'SS_{half} = {I ⊆ [n] : ∑_{i∈I} a_i = b,',
    'n/2 ≤ |I|}.',
  ].join('\n'),
  'Fig. 1',
];
