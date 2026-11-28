import { classifyLemidaFile } from './classify';

describe('classifyLemidaFile', () => {
  it('reads a lecture number and title from a deck file name alone', () => {
    const c = classifyLemidaFile({ fileName: 'Lecture 1 - Intro - A 2027.pptx' });
    expect(c.kind).toBe('lecture');
    expect(c.number).toBe(1);
    expect(c.title).toBe('Intro');
    expect(c.confidence).toBeCloseTo(0.7);
    expect(c.rule).toContain('file:');
  });

  it('uses the Moodle section heading when the file name is bare (the common real case)', () => {
    // ~/Desktop/current-uni/ai/lecs/intro-to-ai.pdf has no "lecture" in the name.
    const c = classifyLemidaFile({ fileName: 'intro-to-ai.pdf', sectionTitle: 'הרצאות' });
    expect(c.kind).toBe('lecture');
    expect(c.confidence).toBeCloseTo(0.85);
    expect(c.rule).toContain('section:');
  });

  it('agrees more strongly when section and file name both say lecture', () => {
    const c = classifyLemidaFile({ fileName: 'Lecture 3.pdf', sectionTitle: 'הרצאות' });
    expect(c.kind).toBe('lecture');
    expect(c.confidence).toBeCloseTo(0.95);
  });

  it('classifies recitations from a Hebrew section', () => {
    const c = classifyLemidaFile({ fileName: 'Informed Search.pdf', sectionTitle: 'תרגולים' });
    expect(c.kind).toBe('recitation');
  });

  it('treats a Moodle assignment activity as homework regardless of name', () => {
    const c = classifyLemidaFile({ fileName: 'file.pdf', moduleType: 'mod_assign' });
    expect(c.kind).toBe('homework');
    expect(c.confidence).toBeCloseTo(0.95);
    expect(c.rule).toContain('module:mod_assign');
  });

  it('classifies Hebrew homework and exam file names', () => {
    expect(classifyLemidaFile({ fileName: 'תרגיל בית 3.pdf' }).kind).toBe('homework');
    expect(classifyLemidaFile({ fileName: 'מבחן מועד א 2024.pdf' }).kind).toBe('exam');
    expect(classifyLemidaFile({ fileName: 'ex2.pdf', sectionTitle: 'שיעורי בית' }).kind).toBe('homework');
  });

  it('classifies a course book', () => {
    expect(classifyLemidaFile({ fileName: 'ספר הקורס.pdf' }).kind).toBe('book');
    expect(classifyLemidaFile({ fileName: 'textbook.pdf' }).kind).toBe('book');
  });

  it('leaves a nondescript file unknown for the review queue', () => {
    const c = classifyLemidaFile({ fileName: 'file_07.pdf' });
    expect(c.kind).toBe('unknown');
    expect(c.confidence).toBe(0);
    expect(c.rule).toBe('');
  });

  it('prefers homework over recitation when a name has both bait words', () => {
    // "תרגיל בית" (homework) must win over the bare "תרגיל"/"תרגול" family.
    expect(classifyLemidaFile({ fileName: 'תרגיל בית 2 - עצים.pdf' }).kind).toBe('homework');
  });

  it('classifies a Hebrew file name only once it is decoded (Lemida mojibake, bug 11)', () => {
    const name = 'תרגול 4.pdf';
    const c = classifyLemidaFile({ fileName: name });
    expect(c.kind).toBe('recitation');
    expect(c.number).toBe(4);
    // What the desktop engine used to send: the UTF-8 bytes read as Latin-1.
    const garbled = String.fromCharCode(...new TextEncoder().encode(name));
    expect(classifyLemidaFile({ fileName: garbled }).kind).toBe('unknown');
  });

  it('reads a number bound to the kind word, ignoring the week number', () => {
    const c = classifyLemidaFile({
      fileName: '\u05E9\u05D1\u05D5\u05E2 2 - \u05D4\u05E8\u05E6\u05D0\u05D4 3.pdf',
      sectionTitle: '\u05D4\u05E8\u05E6\u05D0\u05D5\u05EA',
    });
    expect(c.kind).toBe('lecture');
    expect(c.number).toBe(3);
    expect(c.title).toBe('\u05E9\u05D1\u05D5\u05E2 2');
  });

  it('gives no number to a lecture whose name has none', () => {
    const c = classifyLemidaFile({
      fileName: 'Course overview.pdf',
      sectionTitle: '\u05D4\u05E8\u05E6\u05D0\u05D5\u05EA',
    });
    expect(c.kind).toBe('lecture');
    expect(c.number).toBeUndefined();
  });

  it('keeps a leading index as the number when the name has no kind-bound number', () => {
    const c = classifyLemidaFile({
      fileName: '07 Memory models.pdf',
      sectionTitle: '\u05D4\u05E8\u05E6\u05D0\u05D5\u05EA',
    });
    expect(c.number).toBe(7);
    expect(c.title).toBe('Memory models');
  });

  it('reads a glued kind and number', () => {
    const c = classifyLemidaFile({
      fileName: 'ABC Lecture3.pptx',
      sectionTitle: '\u05D4\u05E8\u05E6\u05D0\u05D5\u05EA',
    });
    expect(c.number).toBe(3);
    expect(c.title).toBe('ABC');
  });
});
