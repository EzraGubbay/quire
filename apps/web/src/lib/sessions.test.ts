import { attachWarning, parseSessionFilename, sessionFromFileName } from './sessions';

describe('parseSessionFilename', () => {
  it('parses the PP lecture decks', () => {
    expect(parseSessionFilename('Lecture 1 - Intro - A 2027.pptx')).toEqual({
      kind: 'lecture',
      number: 1,
      title: 'Intro',
    });
    expect(parseSessionFilename('Lecture 2 - SIMD - A 2027.pptx')).toEqual({
      kind: 'lecture',
      number: 2,
      title: 'SIMD',
    });
  });
  it('recognises recitations and tutorials', () => {
    expect(parseSessionFilename('Recitation 3: Threads.pdf')).toEqual({
      kind: 'recitation',
      number: 3,
      title: 'Threads',
    });
    expect(parseSessionFilename('tirgul_4_openmp.pdf')).toEqual({
      kind: 'recitation',
      number: 4,
      title: 'openmp',
    });
    expect(parseSessionFilename('תרגול 5 - MPI.pdf')).toEqual({
      kind: 'recitation',
      number: 5,
      title: 'MPI',
    });
  });
  it('falls back to the file name without a number', () => {
    expect(parseSessionFilename('Course overview.pdf')).toEqual({
      kind: undefined,
      number: undefined,
      title: 'Course overview',
    });
    expect(parseSessionFilename('07 Memory models.pdf')).toEqual({
      kind: undefined,
      number: 7,
      title: 'Memory models',
    });
  });
});

// Known legacy behavior, kept until callers move to parseSessionName.
describe('parseSessionFilename legacy behavior (callers switch to parseSessionName later)', () => {
  it.each([
    ['ABC Lecture3.pptx', { kind: undefined, number: undefined, title: 'ABC Lecture3' }],
    ['שבוע 2 - הרצאה 3.pdf', { kind: undefined, number: undefined, title: 'שבוע 2 - הרצאה 3' }],
    ['Week 2 Lecture 3.pdf', { kind: undefined, number: undefined, title: 'Week 2 Lecture 3' }],
    ['3 הרצאה.pdf', { kind: undefined, number: 3, title: 'הרצאה' }],
    ['Lec.3', { kind: 'lecture', number: undefined, title: '' }],
    ['תרגיל בית 3.pdf', { kind: 'recitation', number: undefined, title: 'בית 3' }],
    ['Lecture 1 - Intro - סמסטר א.pdf', { kind: 'lecture', number: 1, title: 'Intro - סמסטר א' }],
    ['Lecture 3 - Data 2027.pdf', { kind: 'lecture', number: 3, title: 'Dat' }],
  ])('%s', (input, expected) => {
    expect(parseSessionFilename(input)).toEqual(expected);
  });
});

describe('sessionFromFileName', () => {
  it.each([
    'Lecture 1 - Intro - A 2027.pptx',
    'Lecture 2 - SIMD - A 2027.pptx',
    'Recitation 3: Threads.pdf',
    'tirgul_4_openmp.pdf',
    '\u05EA\u05E8\u05D2\u05D5\u05DC 5 - MPI.pdf',
    'Course overview.pdf',
    '07 Memory models.pdf',
    '3 \u05D4\u05E8\u05E6\u05D0\u05D4.pdf',
    '\u05EA\u05E8\u05D2\u05D9\u05DC \u05D1\u05D9\u05EA 3.pdf',
    'sample.pdf',
    'misc-notes.pdf',
    'intro-to-ai.pdf',
  ])('same as the legacy parser: %s', (input) => {
    expect(sessionFromFileName(input)).toEqual(parseSessionFilename(input));
  });

  it.each([
    ['ABC Lecture3.pptx', { kind: 'lecture', number: 3, title: 'ABC' }],
    [
      '\u05E9\u05D1\u05D5\u05E2 2 - \u05D4\u05E8\u05E6\u05D0\u05D4 3.pdf',
      { kind: 'lecture', number: 3, title: '\u05E9\u05D1\u05D5\u05E2 2' },
    ],
    ['Week 2 Lecture 3.pdf', { kind: 'lecture', number: 3, title: 'Week 2' }],
    ['Lec.3', { kind: 'lecture', number: 3, title: '' }],
    ['\u05D4\u05E8\u05E6\u05D0\u05D4 \u05DE\u05E1 3.pdf', { kind: 'lecture', number: 3, title: '' }],
    ['\u05D4\u05E8\u05E6\u05D0\u05D4 \u05DE\u05E1\u05F3 3.pdf', { kind: 'lecture', number: 3, title: '' }],
    ['\u05D4\u05E8\u05E6\u05D0\u05D4 \u05DE\u05E1\u0027 3.pdf', { kind: 'lecture', number: 3, title: '' }],
    ['2026-11-03 Lecture 3.pdf', { kind: 'lecture', number: 3, title: '2026-11-03' }],
    ['03.11.2026 \u05D4\u05E8\u05E6\u05D0\u05D4 3.pdf', { kind: 'lecture', number: 3, title: '03.11.2026' }],
    ['\u200F\u05D4\u05E8\u05E6\u05D0\u05D4 3.pdf', { kind: 'lecture', number: 3, title: '' }],
    [
      'Lecture 1 - Intro - \u05E1\u05DE\u05E1\u05D8\u05E8 \u05D0.pdf',
      { kind: 'lecture', number: 1, title: 'Intro' },
    ],
    ['Lecture 3 - Data 2027.pdf', { kind: 'lecture', number: 3, title: 'Data 2027' }],
    ['Lecture 3, Intro.pdf', { kind: 'lecture', number: 3, title: 'Intro' }],
    ['Lecture 3 / Intro.pdf', { kind: 'lecture', number: 3, title: 'Intro' }],
    ['ABC, Lecture 3, Locks.pdf', { kind: 'lecture', number: 3, title: 'ABC Locks' }],
    ['07 Lecture 3.pdf', { kind: 'lecture', number: 3, title: '07' }],
  ])('v2 reads %s', (input, expected) => {
    expect(sessionFromFileName(input)).toEqual(expected);
  });

  it('falls back to the legacy parser when there is no kind-bound number', () => {
    expect(sessionFromFileName('Course overview.pdf')).toEqual({
      kind: undefined,
      number: undefined,
      title: 'Course overview',
    });
    expect(sessionFromFileName('07 Memory models.pdf')).toEqual({
      kind: undefined,
      number: 7,
      title: 'Memory models',
    });
  });
});

describe('attachWarning', () => {
  it('names the file and the session on a number mismatch', () => {
    expect(attachWarning({ kind: 'lecture', number: 5 }, 'Lecture 3.pdf')).toBe(
      '"Lecture 3.pdf" looks like Lecture 3, but it is attached to Lecture 5.',
    );
  });

  it('names the kinds on a kind mismatch', () => {
    expect(attachWarning({ kind: 'lecture', number: 3 }, 'Recitation 3.pdf')).toBe(
      '"Recitation 3.pdf" looks like Recitation 3, but it is attached to Lecture 3.',
    );
  });

  it('returns undefined when the name agrees or has no number', () => {
    expect(attachWarning({ kind: 'lecture', number: 3 }, 'Lecture 3.pdf')).toBeUndefined();
    expect(attachWarning({ kind: 'lecture', number: 3 }, 'sample.pdf')).toBeUndefined();
  });
});
