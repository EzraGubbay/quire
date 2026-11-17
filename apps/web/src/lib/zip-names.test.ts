import { makeDeduper, safeZipName } from './zip-names';

describe('safeZipName', () => {
  it('strips path separators and reserved characters', () => {
    expect(safeZipName('a/b:c*?"<>|d')).toBe('a b c d');
  });
  it('collapses whitespace and trims', () => {
    expect(safeZipName('  Lecture   5  ')).toBe('Lecture 5');
  });
  it('falls back to "document" for an empty result', () => {
    expect(safeZipName('///')).toBe('document');
  });
});

describe('makeDeduper', () => {
  it('passes the first name through and numbers later collisions', () => {
    const d = makeDeduper();
    expect(d('Lectures/Intro.pdf')).toBe('Lectures/Intro.pdf');
    expect(d('Lectures/Intro.pdf')).toBe('Lectures/Intro (2).pdf');
    expect(d('Lectures/Intro.pdf')).toBe('Lectures/Intro (3).pdf');
  });
  it('keeps distinct names untouched and handles no-extension names', () => {
    const d = makeDeduper();
    expect(d('a.pdf')).toBe('a.pdf');
    expect(d('b.pdf')).toBe('b.pdf');
    expect(d('README')).toBe('README');
    expect(d('README')).toBe('README (2)');
  });
});
