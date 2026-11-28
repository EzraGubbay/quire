// @vitest-environment node
import type { SessionKind } from '@quire/shared';
import { describe, expect, it } from 'vitest';
import { parseSessionName, type SessionName } from './naming';

const L = (number: number | undefined, title: string): SessionName => ({
  kind: 'lecture' as SessionKind,
  number,
  title,
});
const R = (number: number | undefined, title: string): SessionName => ({
  kind: 'recitation' as SessionKind,
  number,
  title,
});

const CASES: [label: string, input: string, expected: SessionName | null][] = [
  ['existing: lecture with term', 'Lecture 1 - Intro - A 2027.pptx', L(1, 'Intro')],
  ['existing: lecture SIMD', 'Lecture 2 - SIMD - A 2027.pptx', L(2, 'SIMD')],
  ['existing: recitation colon', 'Recitation 3: Threads.pdf', R(3, 'Threads')],
  ['existing: tirgul underscores', 'tirgul_4_openmp.pdf', R(4, 'openmp')],
  ['existing: hebrew recitation', 'תרגול 5 - MPI.pdf', R(5, 'MPI')],
  ['existing: no kind word', 'Course overview.pdf', null],
  ['existing: bare leading number', '07 Memory models.pdf', null],
  ['glitch: kind glued to number', 'ABC Lecture3.pptx', L(3, 'ABC')],
  ['glitch: prefix before kind', 'ABC Lecture 3 - Locks.pptx', L(3, 'ABC - Locks')],
  ['glitch: dashes only', 'ABC-Lecture3-Locks.pdf', L(3, 'ABC - Locks')],
  ['glitch: hebrew week then lecture', 'שבוע 2 - הרצאה 3.pdf', L(3, 'שבוע 2')],
  ['glitch: hebrew week no dash', 'שבוע 2 הרצאה 3.pdf', L(3, 'שבוע 2')],
  ['glitch: lecture then week', 'הרצאה 3 - שבוע 2.pdf', L(3, 'שבוע 2')],
  ['glitch: week, lecture without number', 'שבוע 2 - הרצאה.pdf', L(undefined, 'שבוע 2')],
  ['glitch: english week', 'Week 2 Lecture 3.pdf', L(3, 'Week 2')],
  ['glitch: W2', 'W2 - Lecture 3.pdf', L(3, 'W2')],
  ['glitch: lecture dash week', 'Lecture - Week 2.pdf', L(undefined, 'Week 2')],
  ['glitch: week only', 'Week 2.pdf', null],
  ['ambiguous: number before kind', '3 הרצאה.pdf', L(undefined, '3')],
  ['glued number', 'Lecture3.pdf', L(3, '')],
  ['abbreviation with dot', 'Lec. 3 - Caches.pdf', L(3, 'Caches')],
  ['dot number keeps number', 'Lec.3', L(3, '')],
  ['lect underscores', 'lect_12_final.pdf', L(12, 'final')],
  ['hebrew glued number', 'הרצאה3.pdf', L(3, '')],
  ['hebrew number marker', 'הרצאה מספר 3.pdf', L(3, '')],
  ['english number marker', 'Lecture no. 4 - Heaps.pdf', L(4, 'Heaps')],
  ['hash number', 'Lecture #9.pdf', L(9, '')],
  ['leading zero', 'Lecture 03 - Intro.pdf', L(3, 'Intro')],
  ['hebrew semester without year', 'Lecture 1 - Intro - סמסטר א.pdf', L(1, 'Intro')],
  ['hebrew semester with year', 'Lecture 1 - Intro - סמסטר א 2027.pdf', L(1, 'Intro')],
  ['hebrew recitation semester', 'תרגול 2 - סמסטר ב 2026.pdf', R(2, '')],
  ['parenthesised term', 'Lecture 1 - Intro (B 2026).pdf', L(1, 'Intro')],
  ['season term', 'Lecture 2 - SIMD - spring 2027.pptx', L(2, 'SIMD')],
  ['year-then-letter term', 'Lecture 5 2027A.pdf', L(5, '')],
  ['year in title is not a term', 'Lecture 3 - Data 2027.pdf', L(3, 'Data 2027')],
  ['no number', 'Lecture.pdf', L(undefined, '')],
  ['no number with title', 'Lecture - Intro.pdf', L(undefined, 'Intro')],
  ['kind word after a prefix', 'Electrical Lecture.pdf', L(undefined, 'Electrical')],
  ['boundary: lecturer', 'Lecturer notes 3.pdf', null],
  ['boundary: plural', 'Lectures 1-3.pdf', null],
  ['boundary: selection', 'Selection sort.pdf', null],
  ['boundary: recursion', 'Recursion.pdf', null],
  ['boundary: index', 'Index 3.pdf', null],
  ['abbreviation mid-name without number', 'Intro rec.pdf', null],
  ['abbreviation mid-name with number', 'Intro rec 2.pdf', R(2, 'Intro')],
  ['lec abbreviation mid-name', 'ABC lec 3.pdf', L(3, 'ABC')],
  ['ex abbreviation', 'Ex 2.pdf', R(2, '')],
  ['ex glued', 'ex2.pdf', R(2, '')],
  ['tut abbreviation', 'Tut 6.pdf', R(6, '')],
  ['hebrew exercise with maqaf title', 'תרגיל 2 – רדוקציות ו־NP-שלמות.pdf', R(2, 'רדוקציות ו־NP-שלמות')],
  ['homework is not a recitation', 'תרגיל בית 3.pdf', null],
  ['alternate hebrew spelling', 'תירגול 7.pdf', R(7, '')],
  ['mixed hebrew kind', 'ABC הרצאה 3 - Locks.pdf', L(3, 'ABC - Locks')],
  ['two numbered lectures', 'Lecture 2 - Lecture 3.pdf', L(2, 'Lecture 3')],
  ['two kinds, first numbered', 'Recitation 3 Lecture 4.pdf', R(3, 'Lecture 4')],
  ['two kinds, second numbered', 'Lecture Recitation 3.pdf', R(3, 'Lecture')],
  ['range keeps first number', 'Lecture 3-4.pdf', L(3, '4')],
  ['four digits are not a number', 'Lecture 1000.pdf', L(undefined, '1000')],
  ['year is not a number', 'Lecture 2027.pdf', L(undefined, '2027')],
  ['digit then letter is not a number', 'Lecture 3a.pdf', L(undefined, '3a')],
  ['fullwidth digit is not a number', 'Lecture ３.pdf', L(undefined, '３')],
  ['trailing emoji', 'Lecture 3 \u{1F680}.pdf', L(3, '\u{1F680}')],
  ['leading emoji', '\u{1F680} Lecture 3.pdf', L(3, '\u{1F680}')],
  ['uppercase extension', 'Lecture 3.PPTX', L(3, '')],
  ['bidi marks stripped', '‏הרצאה 3‏.pdf', L(3, '')],
  ['parenthesised suffix kept', 'Lecture 3 (v2).pdf', L(3, '(v2)')],
  ['whitespace runs', 'Lecture  3   -   Intro.pdf', L(3, 'Intro')],
  ['tab separator', 'lecture\t3.pdf', L(3, '')],
  ['empty string', '', null],
  ['whitespace only', '   ', null],
  ['extension only', '.pdf', null],
];

describe('parseSessionName', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(parseSessionName(input)).toEqual(expected);
  });

  it('stays fast and bounded on huge input', () => {
    const t0 = performance.now();
    expect(parseSessionName(`${'a '.repeat(50000)}Lecture 3`)).toBeNull();
    expect(parseSessionName(`Lecture 3 ${'x'.repeat(100000)}`)).toEqual(L(3, 'x'.repeat(502)));
    expect(parseSessionName(`Lecture 3 ${'- '.repeat(5000)}A 2027`)).toEqual(L(3, ''));
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
