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
