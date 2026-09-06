import { extractWikiLinks, normalizeMathDelimiters, renderMarkdown, wikiSegments } from './markdown';

describe('renderMarkdown', () => {
  it('turns wiki links into anchors and keeps math for MathJax', async () => {
    const html = await renderMarkdown('See [[ELBO tightness|the lemma]] and $\\E[x]$.\n\n$$\n\\int f\n$$');
    expect(html).toContain('data-wikilink="ELBO tightness"');
    expect(html).toContain('>the lemma</a>');
    expect(html).toContain('class="math math-inline">\\(');
    expect(html).toContain('class="math math-display">\\[');
  });
  it('extracts unique link names', () => {
    expect(extractWikiLinks('[[a]] [[b|B]] [[a]]')).toEqual(['a', 'b']);
  });
  it('splits text into runs and links', () => {
    expect(wikiSegments('see [[A|the A]] and [[B]]')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', name: 'A', label: 'the A' },
      { kind: 'text', value: ' and ' },
      { kind: 'link', name: 'B', label: 'B' },
    ]);
    expect(wikiSegments('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
    expect(wikiSegments('')).toEqual([]);
  });
});

describe('normalizeMathDelimiters', () => {
  it('converts LaTeX delimiters outside code', () => {
    expect(normalizeMathDelimiters('a \\(x^2\\) b\n\\[\\int f\\]\n`\\(keep\\)`')).toBe(
      'a $x^2$ b\n$$\\int f$$\n`\\(keep\\)`',
    );
  });
  it('renders LaTeX-delimited math through MathJax spans', async () => {
    const html = await renderMarkdown('Energy \\(E = mc^2\\).');
    expect(html).toContain('class="math math-inline">\\(E = mc^2\\)');
  });
});
