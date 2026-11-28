import { parseSessionFilename } from './sessions';

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
